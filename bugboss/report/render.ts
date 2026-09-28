// Rendering the closing report. Pure: data in, two strings out.
//
// Two texts leave here and they are prepared for different readers, which is
// the whole reason they are separate functions:
//
// - `renderReportDocument` is a Markdown file. Nothing is escaped, because
//   nothing in Markdown is an entity that can swallow the rest of a document
//   the way Slack's `<...>` swallows the rest of a message. A quoted log line
//   containing `<`, `&` or `*` renders as itself or as emphasis; either way
//   the reader still gets every byte after it. The one exception is a table
//   cell, where an unescaped `|` silently starts a new column -- so `cell()`
//   is the only escaping in this file, and it is applied nowhere else.
//
// - `renderThreadSummary` is mrkdwn, and goes out through `slack/format.ts`
//   under the rules that file documents. Model prose reaching it -- the root
//   cause line -- goes through `toMrkdwn`; every value is interpolated with
//   the `mrkdwn` tag, which escapes it.
//
// Putting the escaping decision in one comment at the top of one file is
// deliberate. The same root cause string goes down both paths, and a reader
// working out which rules apply where is a reader about to get it wrong.

import type { Incident } from "../types";
import { mrkdwn, raw, toMrkdwn } from "../slack/format";

// ---------------------------------------------------------------------------
// What a report is made of
// ---------------------------------------------------------------------------

/** A pull request the agent opened, and what became of it. */
export interface ReportPr {
  url: string;
  /**
   * `merged`, `open`, `closed`, or null for "not known". Null is the honest
   * answer when GitHub could not be asked, and it is rendered as such: a
   * report that guesses a PR merged is worse than one that says it cannot
   * tell.
   */
  state: "merged" | "open" | "closed" | null;
}

export interface ReportSignal {
  source: string;
  kind: string;
  title: string;
  reportedBy: string | null;
  openedAt: number;
  closedAt: number | null;
  explained: boolean;
}

/** A row of `incident_action`: what a person did to this incident. */
export interface ReportAction {
  actorKind: string;
  actorId: string | null;
  action: string;
  reason: string | null;
  at: number;
}

/**
 * What the agent spent. Tokens and `modelId` are the record and come off the
 * incident row, which `rollUpUsage` writes from the session file after the
 * child exits. `turns` and `costUsd` come from that same file read once more
 * at publish time, so they are null when it has aged out from under the
 * lifecycle rule while the row's tokens survive.
 */
export interface ReportRun {
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  attempts: number;
  turns: number | null;
  costUsd: number | null;
}

export interface ReportData {
  incident: Incident;
  signals: ReportSignal[];
  /** Ids of the incidents correlation folded into this one. */
  mergedIn: string[];
  prs: ReportPr[];
  actions: ReportAction[];
  run: ReportRun;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * UTC, always, and said so. An incident report is read by whoever picks it
 * up months later, and a bare local timestamp is unresolvable by then.
 */
export const timestamp = (at: number): string => {
  const d = new Date(at);
  return [
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    "UTC",
  ].join(" ");
};

/**
 * Two units at most: "1h 4m", "3d 2h", "47s". Past a day, minutes are noise.
 *
 * This takes a length, not a difference. Deciding what a backwards interval
 * means belongs to `interval` below, so nothing here turns a negative into a
 * word: a sign that reaches this far is printed. A call site nobody thought
 * about then shows a number that is visibly wrong, rather than no number at
 * all.
 */
export const duration = (ms: number): string => {
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 0) return `-${duration(-ms)}`;
  const seconds = Math.round(ms / 1000);
  const units: [number, string][] = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  let rest = seconds;
  for (const [size, suffix] of units) {
    const whole = Math.floor(rest / size);
    if (whole > 0 || parts.length > 0) {
      if (whole > 0) parts.push(`${whole}${suffix}`);
      if (parts.length === 2) break;
    }
    rest -= whole * size;
  }
  return parts.length > 0 ? parts.join(" ") : "0s";
};

/**
 * One of the report's measured intervals, or a sentence saying why there is
 * no number.
 *
 * Three answers, not two, because there are three states and they are not
 * the same news. `null` means one of the two moments was never recorded.
 * A negative means both were recorded and they disagree about which came
 * first -- the incident's own timeline contradicts itself. Printing one word
 * for both throws away the only clue that something upstream is wrong, and a
 * number that cannot be right is exactly as worth saying out loud as an
 * exception is.
 */
export const interval = (
  ms: number | null,
  say: {
    /** When neither timestamp is there. A sentence, not a word. */
    absent: string;
    /** When they are both there and in the wrong order. `gap` is the size. */
    backwards: (gap: string) => string;
    /**
     * When there is a number. Defaults to the number on its own, which is
     * what a labelled table cell wants; a sentence in a thread wants "detected
     * in 6h 15m" and passes that.
     */
    measured?: (length: string) => string;
  },
): string => {
  if (ms === null) return say.absent;
  if (ms < 0) return say.backwards(duration(-ms));
  const length = duration(ms);
  return say.measured ? say.measured(length) : length;
};

export const count = (value: number): string => value.toLocaleString("en-US");

/** 5,940,000 tokens is a number nobody reads. 5.94M is. */
export const compact = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

export const dollars = (value: number): string =>
  value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;

/**
 * A table cell. `|` ends a column in Markdown and a newline ends the row, so
 * a signal title out of an alert payload has to lose both or it silently
 * rewrites the table around it. Everything outside a table is left alone.
 */
export const cell = (value: string): string =>
  value.replace(/\s+/g, " ").replaceAll("|", "\\|").trim();

const clamp = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/** The first line of prose, for a one-line summary of something longer. */
const firstLine = (value: string): string =>
  value.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";

/**
 * Push a block of the agent's own Markdown one heading level down, so its
 * `## Timeline` nests under this file's `## Post-mortem` instead of standing
 * beside it. Without this a reader cannot tell the report's structure from
 * the post-mortem's, and every post-mortem writes its own headings.
 *
 * Fenced code is left alone: a `# comment` line in a shell block is not a
 * heading, and demoting it would change what the agent quoted.
 */
const nest = (body: string): string => {
  let fenced = false;
  return body
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(/^([ \t]*)(#{1,5})([ \t]+\S)/, "$1#$2$3");
    })
    .join("\n");
};

const section = (heading: string, body: string): string[] =>
  body.trim() ? [`## ${heading}`, "", nest(body.trim()), ""] : [];

const prLabel = (pr: ReportPr): string => pr.state ?? "state not known";

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

export interface ReportMetrics {
  /** firstSignalAt - impactStartedAt. Null when the agent could not pin it. */
  timeToDetectMs: number | null;
  /** resolvedAt - firstSignalAt: how long it took once we knew. */
  timeToResolveMs: number | null;
  /** closedAt - firstSignalAt, the whole life of the incident. */
  lifetimeMs: number | null;
  totalTokens: number;
  prsMerged: number;
}

export const reportMetrics = (data: ReportData): ReportMetrics => {
  const { incident, run } = data;
  return {
    timeToDetectMs:
      incident.impactStartedAt === null
        ? null
        : incident.firstSignalAt - incident.impactStartedAt,
    timeToResolveMs:
      incident.resolvedAt === null
        ? null
        : incident.resolvedAt - incident.firstSignalAt,
    lifetimeMs:
      incident.closedAt === null ? null : incident.closedAt - incident.firstSignalAt,
    totalTokens: run.tokensIn + run.tokensOut + run.cacheRead + run.cacheWrite,
    prsMerged: data.prs.filter((pr) => pr.state === "merged").length,
  };
};

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const glance = (data: ReportData, metrics: ReportMetrics): string[] => {
  const { incident } = data;
  const sources = [...new Set(data.signals.map((signal) => signal.source))];
  const rows: [string, string][] = [
    ["Status", incident.status],
    ["Owner at close", incident.owner],
    [
      "Users impacted",
      incident.usersImpacted === null ? "not measured" : count(incident.usersImpacted),
    ],
    [
      "Time to detect",
      interval(metrics.timeToDetectMs, {
        absent: "not known — when impact began was never recorded",
        backwards: (gap) =>
          `not usable — impact is recorded as beginning ${gap} after the first signal arrived, so one of the two times is wrong`,
      }),
    ],
    [
      "Time to resolve",
      interval(metrics.timeToResolveMs, {
        absent: "not known — no resolved time was recorded",
        backwards: (gap) =>
          `not usable — the incident is recorded as resolved ${gap} before its first signal arrived, so one of the two times is wrong`,
      }),
    ],
    [
      "Open to closed",
      interval(metrics.lifetimeMs, {
        absent: "not known — no close time was recorded",
        backwards: (gap) =>
          `not usable — the incident is recorded as closed ${gap} before its first signal arrived, so one of the two times is wrong`,
      }),
    ],
    ["First signal", timestamp(incident.firstSignalAt)],
    ["Resolved", incident.resolvedAt === null ? "—" : timestamp(incident.resolvedAt)],
    ["Closed", incident.closedAt === null ? "—" : timestamp(incident.closedAt)],
    [
      "Signals attached",
      data.signals.length === 0
        ? "0"
        : `${count(data.signals.length)} (${sources.join(", ")})`,
    ],
    ["Incidents merged in", data.mergedIn.length === 0 ? "0" : data.mergedIn.join(", ")],
    [
      "Pull requests",
      data.prs.length === 0
        ? "none"
        : `${count(data.prs.length)} (${metrics.prsMerged} merged)`,
    ],
    ["Agent launches", count(data.run.attempts)],
    [
      "On call at open",
      incident.rotationAtOpen === null
        ? "no rotation recorded"
        : incident.rotationAtOpen.join(", "),
    ],
    ["Recurrence of", incident.recurrenceOf ?? "—"],
  ];
  return [
    "## At a glance",
    "",
    "| | |",
    "| --- | --- |",
    ...rows.map(([label, value]) => `| ${cell(label)} | ${cell(value)} |`),
    "",
  ];
};

const signalTable = (data: ReportData): string[] => {
  if (data.signals.length === 0) return [];
  return [
    "## Signals",
    "",
    "| Source | Kind | Title | Opened | Closed | Explained |",
    "| --- | --- | --- | --- | --- | --- |",
    ...data.signals.map((signal) =>
      [
        "",
        cell(signal.source),
        cell(signal.kind),
        cell(signal.title),
        timestamp(signal.openedAt),
        signal.closedAt === null ? "still open" : timestamp(signal.closedAt),
        signal.explained ? "yes" : "no",
        "",
      ].join(" | ").trim(),
    ),
    "",
  ];
};

const actionTable = (data: ReportData): string[] => {
  if (data.actions.length === 0) return [];
  return [
    "## What people did",
    "",
    "| When | Who | What | Why |",
    "| --- | --- | --- | --- |",
    ...data.actions.map((action) =>
      [
        "",
        timestamp(action.at),
        cell(action.actorId ?? action.actorKind),
        cell(action.action),
        cell(action.reason ?? "—"),
        "",
      ].join(" | ").trim(),
    ),
    "",
  ];
};

const runTable = (data: ReportData, metrics: ReportMetrics): string[] => {
  const { run } = data;
  const rows: [string, string][] = [
    ["Model", run.modelId ?? "not recorded"],
    ["Launches", count(run.attempts)],
    ["Turns", run.turns === null ? "not recorded" : count(run.turns)],
    ["Input tokens", count(run.tokensIn)],
    ["Output tokens", count(run.tokensOut)],
    ["Cache read", count(run.cacheRead)],
    ["Cache write", count(run.cacheWrite)],
    ["Total tokens", `${count(metrics.totalTokens)} (${compact(metrics.totalTokens)})`],
  ];
  return [
    "## Agent run",
    "",
    "| | |",
    "| --- | --- |",
    ...rows.map(([label, value]) => `| ${cell(label)} | ${cell(value)} |`),
    "",
    run.costUsd === null || run.costUsd === 0
      ? "Tokens and the model id are the record here. Pricing moves, so a stored dollar figure would be a guess frozen at write time, while these two multiply out correctly whenever someone asks."
      : `Priced at the time this ran, that came to **${dollars(run.costUsd)}**. That figure is derived and is not the record: tokens and the model id are, because pricing moves and they multiply out correctly whenever someone asks.`,
    "",
  ];
};

const resolution = (data: ReportData): string[] => {
  const { incident } = data;
  const body: string[] = [];
  if (incident.resolvedEvidence) body.push(incident.resolvedEvidence.trim(), "");
  if (data.prs.length > 0) {
    body.push(
      ...data.prs.map((pr) => `- ${pr.url} — ${prLabel(pr)}`),
      "",
    );
  }
  if (body.length === 0) return [];
  return ["## Resolution", "", ...body];
};

/**
 * The whole report, as a Markdown file.
 *
 * Ordered for someone who opens it once: the numbers first, then the cause,
 * then the write-up, then the evidence trail underneath. Nobody scrolls to a
 * summary at the bottom.
 */
export const renderReportDocument = (data: ReportData): string => {
  const { incident } = data;
  const metrics = reportMetrics(data);
  const headline = data.signals[0]?.title ?? "No signal recorded";

  return [
    `# Incident ${incident.id}`,
    "",
    firstLine(headline),
    "",
    `Closed ${incident.closedAt === null ? "at an unrecorded time" : timestamp(incident.closedAt)} · written by BugBoss.`,
    "",
    ...glance(data, metrics),
    ...section("Root cause", incident.rootCause ?? ""),
    ...section("Post-mortem", incident.postmortem ?? ""),
    ...section(
      "Impact",
      incident.usersImpacted === null
        ? ""
        : [
            `**${count(incident.usersImpacted)} users impacted.**`,
            "",
            incident.impactQuery
              ? ["Measured by:", "", "```", incident.impactQuery.trim(), "```"].join("\n")
              : "No query was recorded for this number.",
          ].join("\n"),
    ),
    ...resolution(data),
    ...signalTable(data),
    ...actionTable(data),
    ...runTable(data, metrics),
  ].join("\n");
};

// ---------------------------------------------------------------------------
// The thread summary
// ---------------------------------------------------------------------------

/** Room for the root cause without pushing the summary past one message. */
const SUMMARY_CAUSE_CHARS = 300;

/**
 * What goes in the thread beside the file.
 *
 * The thread has to read on a phone without opening anything, which is the
 * standard the rest of the incident thread already holds itself to. So this
 * is the numbers a person scanning the channel wants and one line of cause,
 * and everything else is in the file.
 */
export const renderThreadSummary = (
  data: ReportData,
  note: string | null = null,
): string => {
  const { incident, run } = data;
  const metrics = reportMetrics(data);

  const facts = [
    incident.usersImpacted === null
      ? "impact not measured"
      : `${count(incident.usersImpacted)} users impacted`,
    interval(metrics.timeToDetectMs, {
      measured: (length) => `detected in ${length}`,
      absent: "time to detect not recorded",
      backwards: () =>
        "detection time inconsistent (impact recorded as starting after the signal)",
    }),
    interval(metrics.timeToResolveMs, {
      measured: (length) => `resolved in ${length}`,
      absent: "time to resolve not recorded",
      backwards: () => "resolve time inconsistent (resolved before the signal)",
    }),
  ].join(" · ");

  const work = [
    `${count(data.signals.length)} signal${data.signals.length === 1 ? "" : "s"}`,
    ...(data.mergedIn.length > 0 ? [`${count(data.mergedIn.length)} merged in`] : []),
    `${count(data.prs.length)} PR${data.prs.length === 1 ? "" : "s"}${
      metrics.prsMerged > 0 ? ` (${metrics.prsMerged} merged)` : ""
    }`,
    `${count(run.attempts)} agent launch${run.attempts === 1 ? "" : "es"}`,
  ].join(" · ");

  const priced =
    run.costUsd === null || run.costUsd === 0
      ? ""
      : ` (~${dollars(run.costUsd)} as priced at run time)`;
  const spend = [
    `${compact(metrics.totalTokens)} tokens`,
    ...(run.turns === null ? [] : [`${count(run.turns)} turns`]),
    `on ${run.modelId ?? "an unrecorded model"}${priced}`,
  ].join(" · ");

  const cause = incident.rootCause
    ? toMrkdwn(clamp(firstLine(incident.rootCause), SUMMARY_CAUSE_CHARS))
    : "No root cause was recorded.";

  return [
    mrkdwn`*Incident ${incident.id} — closing report*`,
    mrkdwn`${raw(cause)}`,
    mrkdwn`• ${facts}`,
    mrkdwn`• ${work}`,
    mrkdwn`• ${spend}`,
    ...(note ? [mrkdwn`_${note}_`] : []),
  ].join("\n");
};
