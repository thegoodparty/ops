// Human reports. Design spec: docs/bugboss/design.md, Job 1 / Human reports.
//
// An employee reports the same way they do anything else: @bugboss in Slack,
// or a report_signal tool over MCP. Both arrive here, which is why this is an
// adapter rather than a flag on the alert path. Four things differ from an
// alert, and all four are encoded below:
//
//   - No evidence to pre-fetch. The reporter's description IS the evidence.
//   - No auto-resolution. An alert resolves when it stops firing; a report
//     resolves when the behaviour is verified fixed.
//   - Never suppressed. KnownCause suppression is alert-specific, and if a
//     person took the trouble to report something it gets an agent at minimum.
//   - There is a stakeholder. Alerts have no reporter; reports do, and they
//     are added to the thread and told when it resolves.

import { createHash } from "node:crypto";

import type {
  Evidence,
  IncomingRequest,
  RawSignal,
  Signal,
  SignalAdapter,
} from "../types";

export const HUMAN_SOURCE = "human";

/**
 * Read by triage. A KnownCause match may annotate a human report but must
 * never suppress it, so the rule travels on the signal rather than living as
 * a special case inside triage.
 */
export const NEVER_SUPPRESS_LABEL = "never_suppress";

/**
 * "verification" vs the alert path's "auto". This is the distinction the spec
 * calls resolutionPolicy: the Boss must not read a quiet report as a fixed
 * one, because nothing about a report goes quiet on its own.
 */
export const RESOLUTION_POLICY_LABEL = "resolution_policy";

export const REPORTED_VIA_LABEL = "reported_via";
export const SLACK_CHANNEL_LABEL = "slack_channel";
export const SLACK_THREAD_TS_LABEL = "slack_thread_ts";
export const SLACK_MESSAGE_TS_LABEL = "slack_message_ts";

const TITLE_MAX = 120;

export type ReportedVia = "slack" | "mcp";

export interface HumanReport {
  /** What the reporter wrote. This is the evidence, so it is stored whole. */
  text: string;
  /**
   * Slack user id. MUST come from the caller's verified identity — the Slack
   * signature or the MCP bearer subject — never from a field the client filled
   * in, or any caller can attribute a report to anyone.
   */
  reportedBy: string;
  via: ReportedVia;
  /** Overrides the derived dedup id. The MCP tool call id is a good one. */
  id?: string | null;
  channel?: string | null;
  threadTs?: string | null;
  messageTs?: string | null;
  reportedAt?: number;
}

const firstLine = (text: string): string => {
  const line = text.trim().split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > TITLE_MAX
    ? `${trimmed.slice(0, TITLE_MAX - 1)}…`
    : trimmed;
};

const derivedId = (report: HumanReport): string => {
  if (report.id) return report.id;
  // A Slack message ts is unique and stable, so a Slack retry of the same
  // delivery dedups against the first.
  if (report.via === "slack" && report.channel && report.messageTs) {
    return `slack:${report.channel}:${report.messageTs}`;
  }
  // Otherwise a content hash, which means the same person submitting the same
  // text twice is treated as one report. That is the intended reading of a
  // double-submit; a genuinely new report of the same problem should carry an
  // explicit id.
  const digest = createHash("sha256")
    .update(`${report.reportedBy}\u0000${report.text}`, "utf8")
    .digest("hex");
  return `${report.via}:${digest.slice(0, 16)}`;
};

export const humanSignal = (report: HumanReport): RawSignal => {
  const text = report.text.trim();
  if (!text) throw new Error("human ingress: report text is empty");
  if (!report.reportedBy) {
    throw new Error("human ingress: report has no reporter");
  }

  const labels: Record<string, string> = {
    [NEVER_SUPPRESS_LABEL]: "true",
    [RESOLUTION_POLICY_LABEL]: "verification",
    [REPORTED_VIA_LABEL]: report.via,
  };
  if (report.channel) labels[SLACK_CHANNEL_LABEL] = report.channel;
  if (report.threadTs) labels[SLACK_THREAD_TS_LABEL] = report.threadTs;
  if (report.messageTs) labels[SLACK_MESSAGE_TS_LABEL] = report.messageTs;

  return {
    source: HUMAN_SOURCE,
    sourceId: derivedId(report),
    kind: "bug_report",
    title: firstLine(text),
    body: text,
    labels,
    reportedBy: report.reportedBy,
    openedAt: report.reportedAt ?? Date.now(),
  };
};

export const isNeverSuppressed = (signal: { labels: Record<string, string> }) =>
  signal.labels[NEVER_SUPPRESS_LABEL] === "true";

export interface HumanConfig {
  now?: () => number;
}

/**
 * The MCP entry point. Unlike the webhook adapters there is no signature to
 * check here: the MCP server has already verified the bearer token, and it is
 * the server's job to fill `reportedBy` from that token's subject rather than
 * from the tool arguments. This adapter validates the payload instead, and
 * rejects anything it cannot attribute.
 */
export const createHumanAdapter = (
  config: HumanConfig = {},
): SignalAdapter => {
  const now = config.now ?? Date.now;

  return {
    source: HUMAN_SOURCE,

    parse: async (req: IncomingRequest): Promise<RawSignal[]> => {
      let payload: unknown;
      try {
        payload = JSON.parse(req.rawBody);
      } catch {
        throw new Error("human ingress: body was not JSON");
      }
      if (typeof payload !== "object" || payload === null) {
        throw new Error("human ingress: body was not an object");
      }

      const body = payload as Record<string, unknown>;
      const text = typeof body.text === "string" ? body.text : "";
      const reportedBy =
        typeof body.reportedBy === "string" ? body.reportedBy : "";
      if (!text.trim()) throw new Error("human ingress: report text is empty");
      if (!reportedBy) throw new Error("human ingress: report has no reporter");

      const via: ReportedVia = body.via === "slack" ? "slack" : "mcp";

      return [
        humanSignal({
          text,
          reportedBy,
          via,
          id: typeof body.id === "string" ? body.id : null,
          channel: typeof body.channel === "string" ? body.channel : null,
          threadTs: typeof body.threadTs === "string" ? body.threadTs : null,
          messageTs: typeof body.messageTs === "string" ? body.messageTs : null,
          reportedAt:
            typeof body.reportedAt === "number" ? body.reportedAt : now(),
        }),
      ];
    },

    dedupKey: (signal) => `${signal.source}:${signal.sourceId}`,

    /** Nothing to pre-fetch: the description is the evidence. */
    prefetchEvidence: async (): Promise<Evidence[]> => [],

    /**
     * Always false. A report resolves when an agent verifies the reported
     * behaviour is fixed or the reporter confirms it, and neither is something
     * this adapter can observe.
     */
    isResolved: async (_signal: Signal) => false,
  };
};
