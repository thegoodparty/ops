// Production implementations of the two interfaces relay.ts and agent.ts take
// injected. The Slack and S3 clients are not reachable from the tests, which
// is the point of the split. `createCachingLinker` is the exception: what it
// decides -- how many API calls a message full of links costs -- is behaviour
// rather than wiring, so it is tested on its own.

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { retryPolicies, WebClient, type KnownBlock } from "@slack/web-api";

import { makeLog } from "../logging";
import type { ChoicePoster } from "./blocks";
import type { ObjectStore, SlackClient } from "./agent";

const log = makeLog("slack-client");

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

/**
 * The shape of an answer that can teach us the rest. Two messages in one
 * channel have permalinks that differ only in the timestamp, so the capture
 * is everything up to it.
 */
const ARCHIVE_PREFIX = /^(https:\/\/[^/?#]+\/archives\/[^/?#]+\/)p\d+$/;

/**
 * The workspace domain is the only part of a permalink the API knows and we
 * do not, and one real answer hands it over. After that every other link in
 * the same channel is string work, so an answer naming five incidents costs
 * one round trip rather than five -- which matters because the Slack agent
 * resolves these on the path to a reply somebody is waiting for.
 */
export const createCachingLinker = (inner: SlackLinker): SlackLinker => {
  // Bounded by the number of incident threads ever linked in one process,
  // and only grows at all while nothing has taught us the prefix.
  const pending = new Map<string, Promise<string>>();
  let prefix: string | null = null;

  return {
    permalink: (messageTs) => {
      if (prefix) {
        return Promise.resolve(`${prefix}p${messageTs.replaceAll(".", "")}`);
      }
      const held = pending.get(messageTs);
      if (held) return held;

      const call = inner.permalink(messageTs).then((url) => {
        const learned = ARCHIVE_PREFIX.exec(url)?.[1];
        if (learned) {
          prefix = learned;
          pending.clear();
        } else {
          // Still the right url for this message, so nothing is broken -- but
          // every later link now costs an API call, and a silent tenfold rise
          // in Slack calls is exactly the kind of thing nobody notices.
          log("permalink_shape_unknown", { url });
        }
        return url;
      });
      pending.set(messageTs, call);
      // A rejection is not an answer, so it must not be cached as one.
      call.catch(() => pending.delete(messageTs));
      return call;
    },
  };
};

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
  const linker = createCachingLinker({
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
