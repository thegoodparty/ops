// Human reports. Design spec: bugboss/docs/architecture.md, Job 1 / Human reports.
//
// An employee reports the same way they do anything else: @bugboss in Slack.
// The Slack adapter classifies the mention and builds the signal here, so a
// report is its own kind of signal rather than a flag on the alert path. Four
// things differ from an alert, and all four are encoded below:
//
//   - No evidence to pre-fetch. The reporter's description IS the evidence.
//   - No auto-resolution. An alert resolves when it stops firing; a report
//     resolves when the behaviour is verified fixed.
//   - Never suppressed. KnownCause suppression is alert-specific, and if a
//     person took the trouble to report something it gets an agent at minimum.
//   - There is a stakeholder. Alerts have no reporter; reports do, and they
//     are added to the thread and told when it resolves.

import { createHash } from "node:crypto";

import type { Evidence, RawSignal, SignalAdapter } from "../types";

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

export const SLACK_CHANNEL_LABEL = "slack_channel";
export const SLACK_THREAD_TS_LABEL = "slack_thread_ts";
export const SLACK_MESSAGE_TS_LABEL = "slack_message_ts";

const TITLE_MAX = 120;

export interface HumanReport {
  /** What the reporter wrote. This is the evidence, so it is stored whole. */
  text: string;
  /**
   * Slack user id. MUST come from the caller's verified identity — the Slack
   * signature — never from a field the client filled in, or any caller can
   * attribute a report to anyone.
   */
  reportedBy: string;
  /** Overrides the derived dedup id. */
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
  if (report.channel && report.messageTs) {
    return `slack:${report.channel}:${report.messageTs}`;
  }
  // Otherwise a content hash, which means the same person submitting the same
  // text twice is treated as one report. That is the intended reading of a
  // double-submit; a genuinely new report of the same problem should carry an
  // explicit id.
  const digest = createHash("sha256")
    .update(`${report.reportedBy}\u0000${report.text}`, "utf8")
    .digest("hex");
  return `slack:${digest.slice(0, 16)}`;
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

/**
 * A report has no inbound channel of its own: it arrives as an @bugboss
 * mention and the Slack adapter builds the signal. This adapter exists
 * because `humanSignal` sets `source` to "human" whatever carried it, and the
 * orphan sweep looks an adapter up by a recorded signal's source before it
 * can re-place one.
 */
export const createHumanAdapter = (): SignalAdapter => ({
  source: HUMAN_SOURCE,

  parse: async (): Promise<RawSignal[]> => {
    throw new Error("human ingress: reports arrive through the slack adapter");
  },

  dedupKey: (signal) => `${signal.source}:${signal.sourceId}`,

  /** Nothing to pre-fetch: the description is the evidence. */
  prefetchEvidence: async (): Promise<Evidence[]> => [],
});
