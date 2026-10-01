// Rendering the closing report. Pure: data in, one Markdown string out, which
// `pdf.ts` lays out as the PDF attached to the close notice.
//
// Nothing is escaped, because nothing in Markdown is an entity that can
// swallow the rest of a document the way Slack's `<...>` swallows the rest of
// a message. A quoted log line containing `<`, `&` or `*` renders as itself
// or as emphasis; either way the reader still gets every byte after it. The
// one exception is a table cell, where an unescaped `|` silently starts a new
// column -- so `cell()` is the only escaping in this file, and it is applied
// nowhere else.

import type { Incident, RecurrenceAnalysis, RecurrenceCategory, TimelineEvent } from "../types";

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
 * incident row, which `rollUpUsage` keeps current from the session file; the
 * dollar figures are priced from them at read time. `turns` comes from that
 * same file read once more at publish time, so it is null when the file has
 * aged out from under the lifecycle rule while the row survives.
 */
export interface ReportRun {
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** The 1h share of `cacheWrite`, billed at 2x base input rather than 1.25x. */
  cacheWrite1h: number;
  attempts: number;
  turns: number | null;
  /**
   * Those tokens at the Bedrock catalog's rates, each class at its own rate,
   * computed when the report is built. An estimate, and named one: nothing
   * here ever sees an invoice.
   */
  estimatedCostUsd: number | null;
  /**
   * What the incidents merged into this one spent on their own agents before
   * they were merged, priced the same way from their rows' tokens. Added
   * here so a merge does not make that spend disappear.
   */
  mergedInCostUsd: number;
  /**
   * Merged-in incidents with no estimate: no model id, or no catalog rates
   * for it. Named so a partial sum is never presented as the whole.
   */
  mergedInUnpriced: string[];
  /** Merged-in incidents whose agents spent something, priced. A merged
   * incident that spent nothing is in neither list. */
  mergedInPriced: string[];
}

export interface ReportData {
  incident: Incident;
  signals: ReportSignal[];
  /** Ids of the incidents correlation folded into this one. */
  mergedIn: string[];
  prs: ReportPr[];
  actions: ReportAction[];
  /** What the agent recorded as it went, oldest first. */
  timeline: TimelineEvent[];
  run: ReportRun;
  /**
   * Why an earlier resolution did not hold, for an incident that came back.
   * Null for the ordinary case, and also when the stored answer could not be
   * read -- which is a worse report and is alarmed at the point it happens,
   * rather than a reason not to publish one.
   */
  recurrence: RecurrenceAnalysis | null;
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
 * Two units at most: "1h 4m", "3d 2h", "47s"; under a second, "<1s". Past a
 * day, minutes are noise.
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
  // Whole seconds round a real gap down to "0s", which reads as no gap at
  // all. The caller that cannot afford that is `interval`'s backwards branch:
  // it calls a timeline self-contradictory and then prints zero as the
  // contradiction, which is an argument against itself.
  if (ms > 0 && ms < 1000) return "<1s";
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
 * Past this, a difference between two of one incident's own timestamps is not
 * a measurement. Nothing BugBoss handles runs for months: triage stops even
 * looking for a related incident at ninety days, so anything wider than the
 * window in which two incidents can still be the same incident is not a slow
 * incident, it is two numbers that were not written on the same scale. The
 * ceiling is deliberately set where a real incident stops being conceivable
 * rather than near the mistake it catches -- a seconds-for-millis mix-up
 * lands about fifty years wide, so every value in between is caught too, and
 * the constant does not have to be re-tuned each time a new way of getting
 * the unit wrong turns up.
 */
const IMPLAUSIBLE_MS = 90 * 86_400_000;

/**
 * One of the report's measured intervals, or a sentence saying why there is
 * no number.
 *
 * Four answers, not two, because there are four states and they are not the
 * same news. `null`, or a number that is not one, means one of the two
 * moments was never recorded. A negative means both were recorded and they
 * disagree about which came first -- the incident's own timeline contradicts
 * itself. A magnitude past `IMPLAUSIBLE_MS` means both were recorded and
 * they are not on the same scale, which is the state that renders a
 * plausibly-shaped number and so the one a reader cannot catch unaided.
 * Printing one word for all of them throws away the only clue that something
 * upstream is wrong, and a number that cannot be right is exactly as worth
 * saying out loud as an exception is.
 *
 * The magnitude is read before the sign, deliberately: at fifty years apart,
 * which of the two came first is not information either.
 */
export const interval = (
  ms: number | null,
  say: {
    /** When neither timestamp is there. A sentence, not a word. */
    absent: string;
    /** When they are both there and in the wrong order. `gap` is the size. */
    backwards: (gap: string) => string;
    /**
     * When they are both there and too far apart to be one incident. Falls
     * back to `backwards`, so a caller that has not distinguished the two
     * still refuses the number rather than printing it -- which is why `gap`
     * is here, unsigned, despite no caller wanting it: a length nothing can
     * have measured is not a fact about the incident, and putting it on the
     * page invites the same misreading the branch exists to stop.
     */
    implausible?: (gap: string) => string;
    /**
     * When there is a number. Defaults to the number on its own, which is
     * what a labelled table cell wants; a sentence in a thread wants "detected
     * in 6h 15m" and passes that.
     */
    measured?: (length: string) => string;
  },
): string => {
  if (ms === null || !Number.isFinite(ms)) return say.absent;
  if (Math.abs(ms) > IMPLAUSIBLE_MS) {
    return (say.implausible ?? say.backwards)(duration(Math.abs(ms)));
  }
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

/**
 * The category as a sentence. The stored value is a slug because the set is
 * closed on purpose, but a reader should not have to know the set -- and one
 * of the six says the defect is in BugBoss, which is the one nobody would
 * guess from `bugboss_defect` sitting alone on a line.
 */
const RECURRENCE_REASON: Record<RecurrenceCategory, string> = {
  previous_fix_wrong: "the cause recorded last time was not the cause",
  previous_fix_incomplete:
    "the cause was right but only one way into the failure was closed",
  alert_is_wrong: "the fix held, and the alert should not have fired either time",
  fix_never_reached_production: "the fix held but never reached production",
  resolution_evidence_too_weak:
    "it was called resolved on evidence too weak to carry it",
  bugboss_defect: "BugBoss let a premature close happen; the fix belongs in ops",
};

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
        implausible: () =>
          "not usable — impact and the first signal are recorded further apart than any incident lasts, so one of the two times was written in the wrong unit",
      }),
    ],
    [
      "Time to resolve",
      interval(metrics.timeToResolveMs, {
        absent: "not known — no resolved time was recorded",
        backwards: (gap) =>
          `not usable — the incident is recorded as resolved ${gap} before its first signal arrived, so one of the two times is wrong`,
        implausible: () =>
          "not usable — the first signal and the resolution are recorded further apart than any incident lasts, so one of the two times was written in the wrong unit",
      }),
    ],
    [
      "Open to closed",
      interval(metrics.lifetimeMs, {
        absent: "not known — no close time was recorded",
        backwards: (gap) =>
          `not usable — the incident is recorded as closed ${gap} before its first signal arrived, so one of the two times is wrong`,
        implausible: () =>
          "not usable — the first signal and the close are recorded further apart than any incident lasts, so one of the two times was written in the wrong unit",
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

/**
 * The agent's own record of when things happened, as it recorded them. Kept
 * beside the post-mortem rather than merged into it: the post-mortem is the
 * closer's account, and this is the evidence it was written from.
 */
const timelineTable = (data: ReportData): string[] => {
  if (data.timeline.length === 0) return [];
  return [
    "## Recorded timeline",
    "",
    "| When | What | Evidence |",
    "| --- | --- | --- |",
    ...data.timeline.map((event) =>
      [
        "",
        timestamp(event.occurredAt),
        cell(`${event.kind}: ${event.summary}`),
        cell(event.evidenceUrl ?? "—"),
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

const mergedSpend = (data: ReportData): string[] => {
  const { run } = data;
  const priced = run.mergedInPriced;
  if (priced.length === 0 && run.mergedInUnpriced.length === 0) return [];
  const parts: string[] = [];
  if (priced.length > 0) {
    parts.push(
      `The incidents merged into this one (${priced.join(", ")}) spent an estimated further ${dollars(run.mergedInCostUsd)} on their own agents.`,
    );
  }
  if (run.mergedInUnpriced.length > 0) {
    parts.push(
      `Merged-in ${run.mergedInUnpriced.length === 1 ? "incident" : "incidents"} ${run.mergedInUnpriced.join(", ")} ${run.mergedInUnpriced.length === 1 ? "has" : "have"} no estimate, because the model has no rates in the catalog.`,
    );
  }
  parts.push(
    run.estimatedCostUsd === null || run.mergedInUnpriced.length > 0
      ? "Part of this spend has no estimate, so there is no total."
      : `**${dollars(run.estimatedCostUsd + run.mergedInCostUsd)} in all.**`,
  );
  return [parts.join(" "), ""];
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
    ["Cache write (1h)", count(run.cacheWrite1h)],
    ["Total tokens", `${count(metrics.totalTokens)} (${compact(metrics.totalTokens)})`],
  ];
  return [
    "## Agent run",
    "",
    "| | |",
    "| --- | --- |",
    ...rows.map(([label, value]) => `| ${cell(label)} | ${cell(value)} |`),
    "",
    run.estimatedCostUsd === null || run.estimatedCostUsd === 0
      ? "Tokens and the model id are the record here. No estimate is shown: the model has no rates in the catalog, or nothing was spent."
      : `**Estimated cost: ${dollars(run.estimatedCostUsd)}.** An estimate, not a bill — it is the tokens above at the Bedrock catalog's current rates, and nothing here ever sees an invoice. Tokens and the model id are the record, because they re-price correctly after a rate change and a stored dollar figure would not.`,
    "",
    ...mergedSpend(data),
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
 * Why an incident came back, which is the one question its first report could
 * not have answered. It is a section rather than a glance row because the
 * answer is three things -- which kind of failure, why the last fix did not
 * hold, and what was done about that -- and because a recurrence is the most
 * important fact about an incident that has one.
 */
const recurrence = (data: ReportData): string[] => {
  const { incident } = data;
  if (!incident.recurrenceOf) return [];
  if (!data.recurrence) {
    return [
      "## Why it came back",
      "",
      `A recurrence of ${incident.id === incident.recurrenceOf ? "itself" : incident.recurrenceOf}. The answer recorded at close could not be read back, so it is missing here rather than wrong.`,
      "",
    ];
  }
  const { category, why, remedy } = data.recurrence;
  return [
    "## Why it came back",
    "",
    `A recurrence of ${incident.recurrenceOf}: ${RECURRENCE_REASON[category] ?? category}.`,
    "",
    "**Why the earlier resolution did not hold**",
    "",
    why.trim(),
    "",
    "**What was done about that, rather than about the symptom**",
    "",
    remedy.trim(),
    "",
  ];
};

/**
 * The whole report, as Markdown.
 *
 * Ordered for someone who opens it once: the numbers first, then the cause,
 * then the write-up, then the evidence trail underneath. Nobody scrolls to a
 * summary at the bottom.
 */
export const renderReportDocument = (data: ReportData): string => {
  const { incident } = data;
  const metrics = reportMetrics(data);
  // Whole. It used to be the headline's first line, which is a cut by a
  // different unit and not an exception to the rule: a reader has no way to
  // know there were three more, and "it is in the file" does not help them
  // when this *is* the file.
  const headline = data.signals[0]?.title ?? "No signal recorded";

  return [
    `# Incident ${incident.id}`,
    "",
    headline.trim(),
    "",
    `Closed ${incident.closedAt === null ? "at an unrecorded time" : timestamp(incident.closedAt)} · written by BugBoss.`,
    "",
    ...glance(data, metrics),
    ...section("Root cause", incident.rootCause ?? ""),
    ...recurrence(data),
    ...section("Post-mortem", incident.postmortem ?? ""),
    ...timelineTable(data),
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
