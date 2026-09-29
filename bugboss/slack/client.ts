// Production implementations of the two interfaces relay.ts and agent.ts take
// injected. The Slack and S3 clients are not reachable from the tests, which
// is the point of the split. Two things in here are the exception, both
// because what they decide is behaviour rather than wiring:
// `createCachingLinker`, where the decision is how many API calls a message
// full of links costs, and `createSlackFileUploader`, where it is the order of
// the three upload steps and the bound on each. Both are tested on their own,
// which for the uploader means stubbing axios as well as fetch -- the Slack
// SDK does not use fetch.

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { retryPolicies, WebClient, type KnownBlock } from "@slack/web-api";

import { makeAlarm } from "../logging";
import type { ChoicePoster } from "./blocks";
import type { ObjectStore, SlackClient } from "./agent";
import type { FileUploader } from "../report";

/**
 * Error level, because the thing it reports is a tenfold rise in Slack calls
 * that changes nothing a reader can see. An answer naming fifty incidents
 * still comes back correct and still carries every link -- it just pays fifty
 * round trips for them. There is no symptom to notice, so it has to be said.
 */
const alarm = makeAlarm("slack-client");

/**
 * `conversations.replies` is throttled to roughly one request a minute for
 * newer non-Marketplace apps. The Slack agent calls it once per resume and
 * agents never call it at all, which is what keeps us under that.
 */
const REPLIES_PAGE_LIMIT = 200;

/**
 * One call in the upload flow, and there are three of them.
 *
 * The guarantee this serves is about the whole flow, not one request: a
 * Slack that will not take the file degrades to thread text on the tick that
 * noticed the close, and the dispatcher tick is 30 seconds. A per-request
 * bound only delivers that if the requests cannot repeat, which is why the
 * retry policy below is what it is -- 8s x 3 steps is 24s of worst case,
 * inside the tick, and nothing about that arithmetic survives a retry.
 *
 * Eight seconds is what a Loki read gets. The body here is a post-mortem,
 * measured in kilobytes, so it does not need more.
 */
const UPLOAD_CALL_TIMEOUT_MS = 8_000;

/**
 * A link to one message. Slack builds a permalink out of the workspace
 * domain, which nothing in here knows, so it is an API call rather than
 * string concatenation. `chat.getPermalink` needs no scope of its own.
 *
 * `channel` defaults to the incident channel, which is where every incident
 * thread lives. It is passed only for a thread somewhere else -- the Slack
 * agent answers wherever it is mentioned, and the alert saying it could not
 * answer has to point back at that thread.
 */
export interface SlackLinker {
  permalink(messageTs: string, channel?: string): Promise<string>;
}

/**
 * Rewrite a message already posted. The only thing BugBoss edits is an
 * incident thread's top-level message, which carries the header saying where
 * that incident is and what it is.
 *
 * An edit is silent: Slack marks the message "(edited)" and notifies nobody,
 * including the people already in the thread. That is exactly right for a
 * header somebody re-reads and exactly wrong as a way to tell anyone
 * anything, so a change worth knowing about still posts in the thread as
 * well. Nothing here is the announcement.
 */
export interface SlackUpdater {
  update(channel: string, ts: string, text: string): Promise<void>;
}

/**
 * The shape of an answer that can teach us the rest: a workspace, a channel
 * and a timestamp. Only the first is unknowable from here.
 *
 * The trailing query string is optional and is deliberately not captured.
 * `chat.getPermalink` appends `?thread_ts=…&cid=…` to a link to a message
 * inside a thread -- which is what Slack's own "Copy link" produces -- and
 * anchoring this to the end of `p\d+` rejected every one of them. Nothing
 * here wants those parameters: the only two fields read are the workspace and
 * the channel, and every caller asks about a thread's parent message, whose
 * bare `/archives/<channel>/p<ts>` form is the whole link. So a reply-shaped
 * answer whose `thread_ts` names a different message than its own `p<ts>`
 * teaches the workspace and nothing else, and the links derived afterwards are
 * built from the timestamp the caller passed rather than from anything in here.
 */
const ARCHIVE = /^(https:\/\/[^/?#]+)\/archives\/([^/?#]+)\/p\d+(?:[?#].*)?$/;

/**
 * The workspace domain is the only part of a permalink the API knows and we
 * do not, and one real answer hands it over. After that every other link is
 * string work, so an answer naming five incidents costs one round trip
 * rather than five -- which matters because the Slack agent resolves these
 * on the path to a reply somebody is waiting for.
 */
export const createCachingLinker = (
  inner: SlackLinker,
  defaultChannel: string,
): SlackLinker => {
  // Bounded by the messages linked before the workspace is known, which in
  // practice is one. Cleared the moment it is.
  const pending = new Map<string, Promise<string>>();
  let origin: string | null = null;
  // One build that cannot read its answers will fail on every one of them, and
  // fifty identical alarms about the same defect is how an alarm stops meaning
  // anything. The condition is per-linker, so say it once per linker.
  let shapeReported = false;

  return {
    permalink: (messageTs, channel) => {
      const where = channel ?? defaultChannel;
      const digits = messageTs.replaceAll(".", "");
      if (origin) return Promise.resolve(`${origin}/archives/${where}/p${digits}`);

      const key = `${where}/${messageTs}`;
      const held = pending.get(key);
      if (held) return held;

      const call = inner.permalink(messageTs, channel).then((url) => {
        const parsed = ARCHIVE.exec(url);
        // The channel has to come back as the one that was asked about. If
        // it does not, this url is not the shape the rest are derived from,
        // and deriving anyway would send readers to a link to nowhere.
        if (parsed && parsed[2] === where) {
          origin = parsed[1];
          pending.clear();
        } else if (!shapeReported) {
          shapeReported = true;
          // Still the right url for this message, so nothing is broken -- but
          // every later link now costs an API call, and a silent tenfold rise
          // in Slack calls is exactly the kind of thing nobody notices.
          alarm("permalink_shape_unknown", { url });
        }
        return url;
      });
      pending.set(key, call);
      // A rejection is not an answer, so it must not be cached as one.
      call.catch(() => pending.delete(key));
      return call;
    },
  };
};

export const createSlackClient = (
  token: string,
  defaultChannel: string,
): SlackClient & ChoicePoster & SlackLinker & SlackUpdater => {
  // The SDK defaults to ten retries over about thirty minutes and does not
  // reject a rate-limited call, so a 429 parks the caller inside the SDK with
  // nothing thrown and nothing logged. Posts are off the ingest request now,
  // but an agent blocked in contact_human still waits on one, so the ceiling
  // has to be minutes rather than half an hour.
  const web = new WebClient(token, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
  });
  const linker = createCachingLinker(
    {
      permalink: async (messageTs, channel) => {
        const res = await web.chat.getPermalink({
          channel: channel ?? defaultChannel,
          message_ts: messageTs,
        });
        if (!res.permalink) {
          throw new Error("chat.getPermalink returned no permalink");
        }
        return res.permalink;
      },
    },
    defaultChannel,
  );
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
    // `text` replaces the whole message, so the caller passes the header and
    // the original body together. There is no partial edit and no append.
    update: async (channel, ts, text) => {
      await web.chat.update({
        channel,
        ts,
        text,
      });
    },
    permalink: linker.permalink,
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
 * call, no token on it -- so it is `fetch` rather than the WebClient, and
 * the bound it would otherwise inherit from the SDK has to be passed by
 * hand.
 *
 * `files:write` is the scope, and it does nothing until somebody reinstalls
 * the app. Until then `files.completeUploadExternal` answers `missing_scope`,
 * which is a throw here and an alarm plus an inline post in `report/`.
 */
export const createSlackFileUploader = (token: string): FileUploader => {
  const web = new WebClient(token, {
    // No retries, deliberately, and this is the one WebClient here without
    // them. The SDK's default spreads five attempts over five minutes, which
    // is ten dispatcher ticks spent holding the report sweep open while every
    // individual request still looks bounded -- and it buys nothing, because
    // the thing on the other side of a failure here is not a lost report. It
    // is the same report, in the thread, as text. Waiting minutes to avoid
    // that is the wrong way round.
    retryConfig: { retries: 0 },
    timeout: UPLOAD_CALL_TIMEOUT_MS,
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
        signal: AbortSignal.timeout(UPLOAD_CALL_TIMEOUT_MS),
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
