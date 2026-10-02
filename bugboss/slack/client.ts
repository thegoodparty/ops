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
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ErrorCode, retryPolicies, WebClient } from "@slack/web-api";

import { makeAlarm } from "../logging";
import type { SlackClient, SlackMessage } from "./agent";
import { UploadOutcomeUnknownError, type FileUploader } from "../report";

/**
 * Error level, because the thing it reports is a tenfold rise in Slack calls
 * that changes nothing a reader can see. An answer naming fifty incidents
 * still comes back correct and still carries every link -- it just pays fifty
 * round trips for them. There is no symptom to notice, so it has to be said.
 */
const alarm = makeAlarm("slack-client");

/**
 * `conversations.replies` is throttled to roughly one request a minute for
 * newer non-Marketplace apps. The Boss calls it once per page per run and
 * agents never call it at all, which is what keeps us under that. A thread
 * is read to the end, however many pages that takes: the newest messages are
 * the last page, and they are the ones a run is for.
 */
const REPLIES_PAGE_LIMIT = 200;

/**
 * The two Slack API calls in the upload flow, each.
 *
 * With retries off (below) this bound is the whole of what either call can
 * cost. Eight seconds is what a Loki read gets, and both calls carry a few
 * hundred bytes of JSON, so they do not need more.
 */
const UPLOAD_CALL_TIMEOUT_MS = 8_000;

/**
 * The bound on the POST of the file's bytes to the signed url, which is the
 * step incident 10 timed out on at eight seconds with a report of a few
 * kilobytes. So it is not bandwidth that runs a small upload long but the
 * fixed cost of Slack's file host accepting it, and the floor is set well
 * above the eight seconds that failed. On top of that, 10ms per KiB is room
 * for a link as slow as 100 KiB/s, and the ceiling stops one pathological
 * upload holding the report's claim for more than a minute: past it, a
 * later sweep's fresh attempt is worth more than more waiting.
 */
const BYTE_UPLOAD_FLOOR_MS = 20_000;
const BYTE_UPLOAD_MS_PER_KIB = 10;
const BYTE_UPLOAD_CEILING_MS = 60_000;

export const byteUploadTimeoutMs = (bytes: number): number =>
  Math.min(
    BYTE_UPLOAD_CEILING_MS,
    BYTE_UPLOAD_FLOOR_MS + Math.ceil(bytes / 1024) * BYTE_UPLOAD_MS_PER_KIB,
  );

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

/**
 * `SLACK_API_URL`: where the Web API is. Unset in production, where the SDK
 * keeps its own default; the eval harness points it at its Slack stand-in.
 */
export const slackApiUrl = (
  url = process.env.SLACK_API_URL,
): { slackApiUrl?: string } =>
  url ? { slackApiUrl: url.endsWith("/") ? url : `${url}/` } : {};

export const createSlackClient = (
  token: string,
  defaultChannel: string,
): SlackClient & SlackLinker & SlackUpdater => {
  // The SDK defaults to ten retries over about thirty minutes and does not
  // reject a rate-limited call, so a 429 parks the caller inside the SDK with
  // nothing thrown and nothing logged. Posts are off the ingest request now,
  // but a run waiting on a post still waits on one, so the ceiling has to be
  // minutes rather than half an hour.
  const web = new WebClient(token, {
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    ...slackApiUrl(),
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
      const byTs = new Map<string, SlackMessage>();
      let cursor: string | undefined;
      do {
        const res = await web.conversations.replies({
          channel,
          ts: threadTs,
          oldest,
          limit: REPLIES_PAGE_LIMIT,
          cursor,
        });
        // Every page leads with the thread's parent, so it is keyed out.
        for (const m of res.messages ?? []) {
          const ts = String(m.ts ?? "");
          // Sent on most messages, and absent from the SDK's type.
          const sent = m as {
            user_profile?: { display_name?: string; real_name?: string };
            username?: string;
          };
          byTs.set(ts, {
            user: m.user ?? null,
            botId: m.bot_id ?? null,
            text: m.text ?? "",
            ts,
            name:
              sent.user_profile?.display_name ||
              sent.user_profile?.real_name ||
              m.bot_profile?.name ||
              sent.username ||
              null,
          });
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return [...byTs.values()];
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
 * which is a throw here and a retried, then abandoned, report in `report/`.
 */
export const createSlackFileUploader = (token: string): FileUploader => {
  const web = new WebClient(token, {
    // No retries, deliberately, and this is the one WebClient here without
    // them. The SDK's default spreads five attempts over five minutes while
    // every individual request still looks bounded, and `report/` already
    // retries the whole upload on a later sweep, with a limit and an alarm.
    // Two retry loops stacked is how a bound stops meaning anything.
    retryConfig: { retries: 0 },
    timeout: UPLOAD_CALL_TIMEOUT_MS,
    ...slackApiUrl(),
  });
  return {
    upload: async (file) => {
      const ticket = await web.files.getUploadURLExternal({
        filename: file.filename,
        length: file.content.byteLength,
      });
      if (!ticket.upload_url || !ticket.file_id) {
        throw new Error("files.getUploadURLExternal returned no upload url");
      }
      const uploaded = await fetch(ticket.upload_url, {
        method: "POST",
        body: new Uint8Array(file.content),
        signal: AbortSignal.timeout(byteUploadTimeoutMs(file.content.byteLength)),
      });
      if (!uploaded.ok) {
        throw new Error(
          `file upload rejected: ${uploaded.status} ${uploaded.statusText}`,
        );
      }
      try {
        await web.files.completeUploadExternal({
          files: [{ id: ticket.file_id, title: file.title }],
          channel_id: file.channel,
          thread_ts: file.threadTs ?? undefined,
          initial_comment: file.comment ?? undefined,
        });
      } catch (err) {
        // Slack answering no is an answer: nothing was shared. Anything else
        // -- a timeout, a dropped socket, a 5xx -- can arrive after Slack has
        // already put the file in the thread, and retrying that posts it
        // twice. The caller has to be able to tell the two apart.
        const code = (err as { code?: string }).code;
        if (
          code === ErrorCode.PlatformError ||
          code === ErrorCode.RateLimitedError
        ) {
          throw err;
        }
        throw new UploadOutcomeUnknownError(String(err));
      }
    },
  };
};

/** Whole-object S3: the evidence store in the composition root. */
export interface ObjectStore {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
}

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
    ...slackApiUrl(),
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
