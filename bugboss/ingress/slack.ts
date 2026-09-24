// Slack ingress. Design spec: docs/bugboss/design.md, Job 1 and Job 5.
//
// Inbound Slack is three different things arriving down one webhook, and only
// one of them is a signal:
//
//   incident_reply  a human talking to the agent that owns a thread. Job 5
//                   writes it where the agent's get_incident poll finds it.
//   mention         @bugboss somewhere else. Job 6 spawns the Slack agent.
//   bug_report      a human reporting something broken. This one, and only
//                   this one, becomes a RawSignal.
//
// So classifySlackEvent is exported on its own rather than hidden behind
// parse(). Forcing a thread reply through parse() would mean returning an
// empty array for the two cases that actually have work to do, and the relay
// would have to re-derive what this already decided.
//
// Verification fails closed for the same reason it does on the Grafana side:
// this endpoint is public, and an unauthenticated one lets anyone open an
// incident or put words in an employee's mouth.

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  Evidence,
  IncomingRequest,
  RawSignal,
  Signal,
  SignalAdapter,
} from "../types";
import { humanSignal } from "./human";

export const SLACK_SOURCE = "slack";

export const SIGNATURE_HEADER = "X-Slack-Signature";
export const TIMESTAMP_HEADER = "X-Slack-Request-Timestamp";
export const RETRY_HEADER = "X-Slack-Retry-Num";

/** Slack's own recommended replay window. */
export const REPLAY_WINDOW_SECONDS = 300;

/**
 * What turns a mention into a report rather than a question. A deterministic
 * verb, because telling "@bugboss Pro upgrades look broken" from "@bugboss
 * what is open right now" otherwise needs a model call, and ingress is the
 * one part of this system that stays deterministic.
 */
export const REPORT_VERBS = new Set(["report", "bug", "broken"]);

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
  | { kind: "bug_report"; message: SlackMessage; report: string }
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
   * Whether this thread belongs to an open incident. The Boss knows, from
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

/**
 * Verify and classify one inbound Slack delivery. The relay (Job 5) and the
 * Slack agent (Job 6) call this directly; the adapter's parse() is only the
 * signal-shaped slice of the same answer.
 */
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

  // Checked BEFORE the mention, deliberately. Inside a live incident thread
  // people talk to the incident agent directly, so an @bugboss there is still
  // a reply to that agent rather than a new Slack-agent run.
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

  const [verb, ...rest] = message.text.split(/\s+/);
  if (verb && REPORT_VERBS.has(verb.toLowerCase())) {
    const report = rest.join(" ").trim();
    // "@bugboss report" with nothing after it is somebody about to type.
    // Treating it as a report would open an incident with an empty body.
    if (!report) {
      return { kind: "ignored", reason: "report verb with no description" };
    }
    return { kind: "bug_report", message, report };
  }

  return { kind: "mention", message };
};

export const createSlackAdapter = (config: SlackConfig = {}): SignalAdapter => {
  const now = config.now ?? Date.now;

  return {
    source: SLACK_SOURCE,

    /**
     * Only a bug report is a signal. An incident reply and a mention are
     * consumed by the relay through classifySlackEvent, which is why both
     * come back as an empty array here rather than as an error.
     */
    parse: async (req: IncomingRequest): Promise<RawSignal[]> => {
      const classification = await classifySlackEvent(req, config);
      if (classification.kind !== "bug_report") return [];
      const { message, report } = classification;
      return [
        humanSignal({
          text: report,
          reportedBy: message.user,
          via: "slack",
          channel: message.channel,
          threadTs: message.threadTs,
          messageTs: message.ts,
          reportedAt: now(),
        }),
      ];
    },

    // Keys off signal.source, which humanSignal sets to "human" — so the same
    // report arriving over Slack and over MCP cannot open two incidents.
    dedupKey: (signal) => `${signal.source}:${signal.sourceId}`,

    prefetchEvidence: async (): Promise<Evidence[]> => [],

    isResolved: async (_signal: Signal) => false,
  };
};
