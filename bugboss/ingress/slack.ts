// Slack ingress. Design spec: bugboss/docs/architecture.md, Job 1 and Job 5.
//
// This layer answers what a signature, an event envelope and a thread id can
// answer, and stops there:
//
//   incident_reply  the message is in a thread BugBoss owns. Whoever it was
//                   for, the Boss does something with it.
//   mention         the app was tagged anywhere else.
//   ignored         nothing will come of this: a bot echo, an edit, a message
//                   nobody addressed to us in a thread we do not own.
//
// `ignored` has to keep meaning exactly that, because the HTTP layer decides
// whether a delivery earns its :eyes: by excluding it. An untagged reply in an
// incident thread is the documented way to answer a waiting agent, so calling
// it ignored is how somebody answers an agent and sees nothing happen.
//
// What the message *means* is not here. Whether it hands the incident over,
// whether it was for the agent, whether a mention is a report or a question
// -- all model calls, made off the Slack ack in the composition root. Nothing
// here reads the words a person chose, so there is no verb to learn and no
// phrasing that silently does nothing.
//
// Verification fails closed for the same reason it does on the Grafana side:
// this endpoint is public, and an unauthenticated one lets anyone open an
// incident or put words in an employee's mouth.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { IncomingRequest } from "../types";
import { CHOICE_ACTION_PREFIX, type SlackChoiceClick } from "../slack/blocks";

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
  if (!mentioned) {
    return { kind: "ignored", reason: "not addressed to bugboss" };
  }

  return { kind: "mention", message };
};

// ---------------------------------------------------------------------------
// Interactivity
// ---------------------------------------------------------------------------

/**
 * Slack posts a button press to the same request URL as an event, signed the
 * same `v0=` way over the same raw body, and answers on the same three-second
 * budget. Only the encoding differs: a form body with one `payload` field
 * holding the JSON. Nothing else BugBoss receives is form-encoded, so the
 * content type is the whole discriminator.
 */
export const INTERACTION_CONTENT_TYPE = "application/x-www-form-urlencoded";

export const isInteractionDelivery = (req: IncomingRequest): boolean =>
  (headerValue(req, "Content-Type") ?? "")
    .toLowerCase()
    .includes(INTERACTION_CONTENT_TYPE);

export type SlackInteraction =
  | { kind: "choice"; click: SlackChoiceClick }
  | { kind: "ignored"; reason: string };

const field = (source: unknown, key: string): string => {
  if (typeof source !== "object" || source === null) return "";
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

/**
 * Verify and classify one button press. Throws on an inauthentic delivery for
 * the same reason the event path does: this endpoint is public, and an
 * unverified one lets anyone answer an agent's question in somebody's name.
 */
export const classifySlackInteraction = (
  req: IncomingRequest,
  config: SlackConfig = {},
): SlackInteraction => {
  createSlackVerifier(config)(req);

  const encoded = new URLSearchParams(req.rawBody).get("payload");
  if (!encoded) throw new Error("slack ingress: interaction had no payload field");

  let payload: unknown;
  try {
    payload = JSON.parse(encoded);
  } catch {
    throw new Error("slack ingress: interaction payload was not JSON");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("slack ingress: interaction payload was not an object");
  }

  const body = payload as Record<string, unknown>;
  if (body.type !== "block_actions") {
    return { kind: "ignored", reason: `interaction type ${String(body.type)}` };
  }

  const actions = Array.isArray(body.actions) ? body.actions : [];
  const action = actions.find((entry) =>
    field(entry, "action_id").startsWith(CHOICE_ACTION_PREFIX),
  );
  if (!action) return { kind: "ignored", reason: "not a bugboss choice button" };

  const channel = field(body.channel, "id");
  const user = field(body.user, "id");
  const messageTs = field(body.message, "ts");
  // A question is always posted into the incident thread, so thread_ts is
  // there. Falling back to the message's own ts keeps a top-level question —
  // which only exists if the thread link broke — answerable rather than
  // silently dropped.
  const threadTs = field(body.message, "thread_ts") || messageTs;
  const choice = field(action, "value");
  const actionTs = field(action, "action_ts");

  if (!channel || !user || !messageTs || !choice || !actionTs) {
    return { kind: "ignored", reason: "incomplete interaction" };
  }

  return {
    kind: "choice",
    click: { channel, user, messageTs, threadTs, choice, actionTs },
  };
};
