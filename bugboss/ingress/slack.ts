// Slack ingress. Design spec: bugboss/docs/architecture.md, Job 1 and Job 5.
//
// This layer answers what a signature, an event envelope and a thread id can
// answer, and stops there:
//
//   incident_reply  the message is in a thread BugBoss owns, tagged or not.
//                   It goes to the Boss with the incident as context.
//   mention         the app was tagged anywhere else.
//   boss_thread_reply
//                   an untagged reply in a thread outside any incident where
//                   the Boss already has a conversation. It goes to the Boss
//                   exactly as a tagged mention in that thread would.
//   ignored         nothing will come of this: a bot echo, an edit, a message
//                   nobody addressed to us in a thread we do not own.
//
// `ignored` has to keep meaning exactly that, because the HTTP layer decides
// whether a delivery earns its :eyes: by excluding it. An untagged reply in an
// incident thread is how a person talks to the Boss about that incident, so
// calling it ignored is how somebody answers a question and sees nothing
// happen.
//
// What the message *means* is not here. Whether a mention is a report or a
// question is a model call made off the Slack ack in the composition root,
// and what a reply in an incident thread asks for is the Boss's to read. Nothing
// here reads the words a person chose, so there is no verb to learn and no
// phrasing that silently does nothing.
//
// Verification fails closed for the same reason it does on the Grafana side:
// this endpoint is public, and an unauthenticated one lets anyone open an
// incident or put words in an employee's mouth.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { IncomingRequest } from "../types";

export const SIGNATURE_HEADER = "X-Slack-Signature";
export const TIMESTAMP_HEADER = "X-Slack-Request-Timestamp";
export const RETRY_HEADER = "X-Slack-Retry-Num";

/** Slack's own recommended replay window. */
export const REPLAY_WINDOW_SECONDS = 300;

export interface SlackMessage {
  channel: string;
  user: string;
  /** This message's own ts. Unique, and what dedup keys off. */
  ts: string;
  /** The parent's ts when this is a threaded reply, else null. */
  threadTs: string | null;
  /** Mention markup stripped and trimmed. */
  text: string;
  rawText: string;
  /** Slack is retrying a delivery it thinks failed. */
  retry: boolean;
}

export type SlackClassification =
  | { kind: "url_verification"; challenge: string }
  | { kind: "incident_reply"; message: SlackMessage }
  | { kind: "mention"; message: SlackMessage }
  | { kind: "boss_thread_reply"; message: SlackMessage }
  | { kind: "ignored"; reason: string };

/** Throws when the request is not an authentic Slack delivery. */
export type SlackVerifier = (req: IncomingRequest) => void;

export interface SlackConfig {
  /** Slack signing secret. Absent means no delivery can be verified. */
  signingSecret?: string;
  /** Used to spot a mention when the event arrives as a plain message. */
  botUserId?: string;
  replayWindowSeconds?: number;
  /**
   * Whether this thread belongs to an incident. A structural fact about the
   * delivery, not a reading of it, which is why it survives in a layer that
   * no longer interprets anything. The Boss knows, from
   * incident.slackThreadTs; ingress does not, so it is injected.
   */
  isIncidentThread?: (
    channel: string,
    threadTs: string,
  ) => boolean | Promise<boolean>;
  /**
   * Whether the Boss already has a conversation in this thread: it was
   * mentioned there, or posted there. Like `isIncidentThread`, a fact about
   * the thread and never about the words in the message, injected because
   * the Boss's stored state knows and ingress does not.
   */
  isBossThread?: (
    channel: string,
    threadTs: string,
  ) => boolean | Promise<boolean>;
  now?: () => number;
  /**
   * Replaces the signature check. A TEST SEAM ONLY: passing one in production
   * is how this endpoint becomes an open one.
   */
  verifier?: SlackVerifier;
}

const headerValue = (
  req: IncomingRequest,
  name: string,
): string | undefined => {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
};

const equalSecrets = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, so length is compared first
  // and non-constant-time. The length of a v0 signature is public.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const MENTION = /<@[A-Z0-9]+>/g;

export const createSlackVerifier = (config: SlackConfig): SlackVerifier => {
  if (config.verifier) return config.verifier;
  const now = config.now ?? Date.now;
  const replayWindow = config.replayWindowSeconds ?? REPLAY_WINDOW_SECONDS;

  return (req) => {
    const secret = config.signingSecret;
    if (!secret) {
      throw new Error(
        "slack ingress: no signing secret is configured, so no delivery can be verified",
      );
    }

    const signature = headerValue(req, SIGNATURE_HEADER);
    if (!signature) throw new Error("slack ingress: missing signature header");

    const stamp = headerValue(req, TIMESTAMP_HEADER);
    if (!stamp) throw new Error("slack ingress: missing timestamp header");
    const seconds = Number(stamp);
    if (!Number.isFinite(seconds)) {
      throw new Error("slack ingress: timestamp header is not a number");
    }
    if (Math.abs(now() / 1000 - seconds) > replayWindow) {
      throw new Error("slack ingress: timestamp outside the replay window");
    }

    const expected = `v0=${createHmac("sha256", secret)
      .update(`v0:${stamp}:${req.rawBody}`, "utf8")
      .digest("hex")}`;
    if (!equalSecrets(signature.trim(), expected)) {
      throw new Error("slack ingress: signature mismatch");
    }
  };
};

/** Verify one inbound Slack delivery and say what shape it is. */
export const classifySlackEvent = async (
  req: IncomingRequest,
  config: SlackConfig = {},
): Promise<SlackClassification> => {
  createSlackVerifier(config)(req);

  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    throw new Error("slack ingress: body was not JSON");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("slack ingress: body was not an object");
  }

  const body = payload as Record<string, unknown>;

  if (body.type === "url_verification") {
    return {
      kind: "url_verification",
      challenge: typeof body.challenge === "string" ? body.challenge : "",
    };
  }
  if (body.type !== "event_callback") {
    return { kind: "ignored", reason: `payload type ${String(body.type)}` };
  }

  const event = body.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== "object") {
    return { kind: "ignored", reason: "no event" };
  }

  // Our own posts come back down this webhook. Without this the Boss ingests
  // its own status transitions and the agent's own questions.
  if (event.bot_id || event.subtype === "bot_message") {
    return { kind: "ignored", reason: "bot message" };
  }
  if (event.type !== "message" && event.type !== "app_mention") {
    return { kind: "ignored", reason: `event type ${String(event.type)}` };
  }
  // A message_changed or message_deleted carries no new report.
  if (typeof event.subtype === "string") {
    return { kind: "ignored", reason: `subtype ${event.subtype}` };
  }

  const user = typeof event.user === "string" ? event.user : "";
  const channel = typeof event.channel === "string" ? event.channel : "";
  const ts = typeof event.ts === "string" ? event.ts : "";
  const rawText = typeof event.text === "string" ? event.text : "";
  if (!user || !channel || !ts) {
    return { kind: "ignored", reason: "incomplete event" };
  }
  if (config.botUserId && user === config.botUserId) {
    return { kind: "ignored", reason: "self" };
  }

  const threadTs =
    typeof event.thread_ts === "string" && event.thread_ts !== ts
      ? event.thread_ts
      : null;

  const message: SlackMessage = {
    channel,
    user,
    ts,
    threadTs,
    text: rawText.replace(MENTION, "").trim(),
    rawText,
    retry: Boolean(headerValue(req, RETRY_HEADER)),
  };

  // Checked BEFORE the mention, deliberately, and it is the same order the
  // relay routes in: a message in an incident's thread belongs to that
  // incident whether or not it tagged us.
  const inIncidentThread = config.isIncidentThread ?? (() => false);
  if (threadTs && (await inIncidentThread(channel, threadTs))) {
    return { kind: "incident_reply", message };
  }

  const mentioned =
    event.type === "app_mention" ||
    (config.botUserId ? rawText.includes(`<@${config.botUserId}>`) : false);
  // An untagged follow-up under a Boss answer is still addressed to the Boss.
  // Checked after the mention so a tagged message keeps its own kind, and
  // decided by the thread alone -- the relay routes the same way, off the
  // same predicate, which is what keeps this from being `ignored` while the
  // relay works it.
  if (!mentioned && threadTs) {
    const inBossThread = config.isBossThread ?? (() => false);
    if (await inBossThread(channel, threadTs)) {
      return { kind: "boss_thread_reply", message };
    }
  }
  if (!mentioned) {
    return { kind: "ignored", reason: "not addressed to bugboss" };
  }

  return { kind: "mention", message };
};
