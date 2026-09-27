// Production implementations of the two interfaces relay.ts and agent.ts take
// injected. Nothing here is imported by the tests, which is the point of the
// split.

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { retryPolicies, WebClient, type KnownBlock } from "@slack/web-api";

import type { ChoicePoster } from "./blocks";
import type { ObjectStore, SlackClient } from "./agent";
import type { FileUploader } from "../report";

/**
 * `conversations.replies` is throttled to roughly one request a minute for
 * newer non-Marketplace apps. The Slack agent calls it once per resume and
 * agents never call it at all, which is what keeps us under that.
 */
const REPLIES_PAGE_LIMIT = 200;

/**
 * A link to one message. Slack builds a permalink out of the workspace
 * domain, which nothing in here knows, so it is an API call rather than
 * string concatenation. `chat.getPermalink` needs no scope of its own.
 */
export interface SlackLinker {
  permalink(messageTs: string): Promise<string>;
}

export const createSlackClient = (
  token: string,
  defaultChannel: string,
): SlackClient & ChoicePoster & SlackLinker => {
  // The SDK defaults to ten retries over about thirty minutes and does not
  // reject a rate-limited call, so a 429 parks the caller inside the SDK with
  // nothing thrown and nothing logged. Posts are off the ingest request now,
  // but an agent blocked in contact_human still waits on one, so the ceiling
  // has to be minutes rather than half an hour.
  const web = new WebClient(token, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
  });
  return {
    post: async (threadTs, text, channel) => {
      const res = await web.chat.postMessage({
        channel: channel ?? defaultChannel,
        thread_ts: threadTs ?? undefined,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return { ts: res.ts };
    },
    react: async (channel, ts, name) => {
      await web.reactions.add({ channel, timestamp: ts, name });
    },
    // `text` goes alongside the blocks rather than being replaced by them:
    // without it every notification for this message reads "This content
    // can't be displayed", which is the whole question on a phone.
    postChoice: async (threadTs, text, blocks) => {
      const res = await web.chat.postMessage({
        channel: defaultChannel,
        thread_ts: threadTs ?? undefined,
        text,
        blocks: blocks as KnownBlock[],
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!res.ts) throw new Error("chat.postMessage returned no ts");
      return { ts: res.ts };
    },
    permalink: async (messageTs) => {
      const res = await web.chat.getPermalink({
        channel: defaultChannel,
        message_ts: messageTs,
      });
      if (!res.permalink) {
        throw new Error("chat.getPermalink returned no permalink");
      }
      return res.permalink;
    },
    replies: async ({ channel, threadTs, oldest }) => {
      const res = await web.conversations.replies({
        channel,
        ts: threadTs,
        oldest,
        limit: REPLIES_PAGE_LIMIT,
      });
      return (res.messages ?? []).map((m) => ({
        user: m.user ?? null,
        botId: m.bot_id ?? null,
        text: m.text ?? "",
        ts: String(m.ts ?? ""),
      }));
    },
  };
};

/**
 * Upload one file into a thread, as Slack's external upload flow.
 *
 * Three steps and no SDK shortcut: `files.upload` is deprecated, and
 * `filesUploadV2` wraps this same sequence while hiding which of the three
 * failed. The middle step is a plain POST to a signed URL -- not a Slack API
 * call, no token on it -- so it is `fetch` rather than the WebClient.
 *
 * `files:write` is the scope, and it does nothing until somebody reinstalls
 * the app. Until then `files.completeUploadExternal` answers `missing_scope`,
 * which is a throw here and an alarm plus an inline post in `report/`.
 */
export const createSlackFileUploader = (token: string): FileUploader => {
  const web = new WebClient(token, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
  });
  return {
    upload: async (file) => {
      // Byte length, not character count: Slack rejects the completion when
      // the length it was promised does not match what arrived, and a
      // post-mortem quoting a log line is rarely pure ASCII.
      const body = Buffer.from(file.content, "utf8");
      const ticket = await web.files.getUploadURLExternal({
        filename: file.filename,
        length: body.byteLength,
      });
      if (!ticket.upload_url || !ticket.file_id) {
        throw new Error("files.getUploadURLExternal returned no upload url");
      }
      const uploaded = await fetch(ticket.upload_url, {
        method: "POST",
        body,
      });
      if (!uploaded.ok) {
        throw new Error(
          `file upload rejected: ${uploaded.status} ${uploaded.statusText}`,
        );
      }
      await web.files.completeUploadExternal({
        files: [{ id: ticket.file_id, title: file.title }],
        channel_id: file.channel,
        thread_ts: file.threadTs ?? undefined,
        initial_comment: file.comment,
      });
    },
  };
};

export const createS3ObjectStore = (
  bucket: string,
  client?: S3Client,
): ObjectStore => {
  const s3 = client ?? new S3Client({});
  const missing = (err: unknown): boolean => {
    const name = (err as { name?: string }).name;
    return name === "NoSuchKey" || name === "NotFound";
  };

  return {
    get: async (key) => {
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        return (await res.Body?.transformToString()) ?? null;
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    put: async (key, body) => {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
      );
    },
    list: async (prefix) => {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const obj of res.Contents ?? []) {
          if (obj.Key) keys.push(obj.Key);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
};

/**
 * Who is on the rotation right now, as Slack user ids.
 *
 * Cached, because this is read once per opened incident and a burst opens
 * several at once, while the answer changes on the timescale of someone
 * editing a user group. A stale read costs a slightly wrong snapshot; a
 * fresh read per signal costs a Slack API call inside the placement loop.
 *
 * Never throws. A rotation we could not read is recorded as "not known",
 * which is the same shape as "no rotation configured" and is the honest
 * answer: guessing would put the wrong names in a post-mortem.
 */
export const createRotationReader = (
  token: string,
  usergroupId: string,
  ttlMs = 5 * 60 * 1000,
  now: () => number = Date.now,
): (() => Promise<string[] | null>) => {
  const web = new WebClient(token, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
  });
  let cached: { at: number; members: string[] } | null = null;

  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.members;
    try {
      const res = await web.usergroups.users.list({ usergroup: usergroupId });
      const members = (res.users ?? []).filter(
        (u): u is string => typeof u === "string",
      );
      cached = { at: now(), members };
      return members;
    } catch (err) {
      console.error(
        JSON.stringify({
          component: "slack-client",
          level: "error",
          event: "rotation_read_failed",
          usergroupId,
          error: String(err),
        }),
      );
      return cached?.members ?? null;
    }
  };
};
