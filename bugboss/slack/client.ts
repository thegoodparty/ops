// Production implementations of the two interfaces relay.ts and agent.ts take
// injected. Nothing here is imported by the tests, which is the point of the
// split.

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { retryPolicies, WebClient } from "@slack/web-api";

import type { ObjectStore, SlackClient } from "./agent";

/**
 * `conversations.replies` is throttled to roughly one request a minute for
 * newer non-Marketplace apps. The Slack agent calls it once per resume and
 * agents never call it at all, which is what keeps us under that.
 */
const REPLIES_PAGE_LIMIT = 200;

export const createSlackClient = (
  token: string,
  defaultChannel: string,
): SlackClient => {
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
