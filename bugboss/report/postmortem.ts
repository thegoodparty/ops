// The structured post-mortem: what `report_analysis` takes, how it is
// checked, and how its timeline meets the one the agent recorded as it went.
// Rendering lives in `render.ts`; this file decides what is acceptable.
//
// Every refusal is a sentence the agent can act on, because the agent is the
// only reader of it and it has one turn to fix what it sent. Nothing here
// shortens text: a section that is too long is refused, never cut.

import type { PostmortemSections, PostmortemTimelineRow, TimelineEvent } from "../types";

/** "About 200 words", with room either side so the bound is not the target. */
export const PRACTICE_WORDS = { min: 100, max: 300 } as const;

export const FIVE_WHYS = 5;

/**
 * How far apart an agent's row and a recorded event can be and still be one
 * moment, when they also cite the same evidence. Only used when the row does
 * not name the event outright.
 */
const SAME_MOMENT_MS = 5 * 60_000;

export const words = (text: string): number =>
  text.trim().split(/\s+/).filter(Boolean).length;

const blank = (value: unknown): boolean =>
  typeof value !== "string" || value.trim().length === 0;

/** ISO 8601 with an explicit zone, so a time is never read as local. */
const parseUtc = (at: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(at)) {
    return null;
  }
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Why these sections cannot close the incident, or null when they can.
 * Checked in post-mortem order, so the first problem named is the first one
 * a reader would hit.
 */
export const postmortemProblem = (
  sections: PostmortemSections,
  recorded: readonly TimelineEvent[],
): string | null => {
  if (blank(sections.atAGlance)) {
    return "atAGlance is empty: write two or three sentences a person on call can read on a phone -- what broke, who it hurt, and that it is fixed.";
  }

  if (sections.timeline.length === 0) {
    return `timeline is empty: add a row for each moment -- impact began, first alert, cause found, fix merged and deployed, verified. Rows can name a recorded event by recordedEventId (${
      recorded.length === 0 ? "none recorded yet" : `ids ${recorded.map((e) => e.id).join(", ")}`
    }) or carry an \`at\` in UTC.`;
  }
  const ids = new Set(recorded.map((e) => e.id));
  const named = new Set<number>();
  for (const [i, row] of sections.timeline.entries()) {
    if (blank(row.event)) return `timeline[${i}].event is empty: say what happened at that moment.`;
    if (row.recordedEventId !== undefined) {
      if (!ids.has(row.recordedEventId)) {
        return `timeline[${i}].recordedEventId ${row.recordedEventId} is not one of this incident's recorded events (${
          recorded.length === 0 ? "it has none" : `ids ${[...ids].join(", ")}`
        }); drop it and give the row an \`at\`.`;
      }
      if (named.has(row.recordedEventId)) {
        return `timeline[${i}] names recorded event ${row.recordedEventId} again; describe each recorded event in one row.`;
      }
      named.add(row.recordedEventId);
    }
    if (row.at === undefined) {
      if (row.recordedEventId === undefined) {
        return `timeline[${i}] has no time: give it an \`at\` in UTC, like 2026-10-01T02:14:30Z, or the recordedEventId of the event it describes.`;
      }
    } else if (parseUtc(row.at) === null) {
      return `timeline[${i}].at "${row.at}" is not a UTC time: write it as ISO 8601 ending in Z, like 2026-10-01T02:14:30Z.`;
    }
  }

  if (blank(sections.userImpact)) {
    return "userImpact is empty: say what users experienced and how many, in their terms. If no user was affected, say so and how you know.";
  }
  if (blank(sections.rootCause)) {
    return "rootCause is empty: name the mechanism that produced every signal on this incident.";
  }

  if (sections.fiveWhys.length !== FIVE_WHYS) {
    return `fiveWhys has ${sections.fiveWhys.length} entries; it takes exactly ${FIVE_WHYS}, each asking why the answer before it was true, down to the cause in how we build.`;
  }
  for (const [i, step] of sections.fiveWhys.entries()) {
    if (blank(step.why) || blank(step.because)) {
      return `fiveWhys[${i}] needs both a why and a because.`;
    }
  }

  if (sections.resolutionActions.length === 0 || sections.resolutionActions.some(blank)) {
    return "resolutionActions needs at least one entry and no empty ones: what was done to stop the harm and fix the cause -- each PR merged and deployed, each user repaired.";
  }

  if (blank(sections.practiceChanges)) {
    return "practiceChanges is empty: write about 200 words on how we might prevent issues like this one, not this one, by changing how we build -- test patterns, review gates, alert design, architecture.";
  }
  const count = words(sections.practiceChanges);
  if (count < PRACTICE_WORDS.min) {
    return `practiceChanges is ${count} words; think bigger and keep it to about 200 words on how a change to our development practice would stop similar issues.`;
  }
  if (count > PRACTICE_WORDS.max) {
    return `practiceChanges is ${count} words; keep it to about 200 words.`;
  }
  return null;
};

export interface MergedTimelineRow {
  at: number;
  event: string;
  evidenceUrl: string | null;
}

/**
 * The agent's rows and the recorded events, as one timeline. A row that
 * names a recorded event, carries its time to the second, or cites the same
 * evidence within a few minutes of it, is that event: it takes the recorded time, because that was written
 * when it happened, and the agent's wording, because that was written for a
 * reader. Recorded events no row describes are kept in their own words, so
 * nothing recorded drops out of the document.
 */
export const mergeTimeline = (
  rows: readonly PostmortemTimelineRow[],
  recorded: readonly TimelineEvent[],
): MergedTimelineRow[] => {
  const byId = new Map(recorded.map((e) => [e.id, e]));
  const used = new Set<number>(
    rows.flatMap((row) => (row.recordedEventId === undefined ? [] : [row.recordedEventId])),
  );
  const fromRows = rows.map((row) => {
    let match = row.recordedEventId === undefined ? undefined : byId.get(row.recordedEventId);
    const at = row.at === undefined ? null : parseUtc(row.at);
    if (!match && at !== null) {
      match = recorded.find(
        (e) =>
          !used.has(e.id) &&
          (Math.floor(e.occurredAt / 1000) === Math.floor(at / 1000) ||
            (row.evidenceUrl !== undefined &&
              e.evidenceUrl === row.evidenceUrl &&
              Math.abs(e.occurredAt - at) <= SAME_MOMENT_MS)),
      );
      if (match) used.add(match.id);
    }
    return {
      at: match?.occurredAt ?? at ?? Number.NaN,
      event: row.event.trim(),
      evidenceUrl: row.evidenceUrl ?? match?.evidenceUrl ?? null,
    };
  });
  const unclaimed = recorded
    .filter((e) => !used.has(e.id))
    .map((e) => ({ at: e.occurredAt, event: e.summary.trim(), evidenceUrl: e.evidenceUrl }));
  return [...fromRows, ...unclaimed]
    .map((row, order) => ({ row, order }))
    .sort((a, b) => a.row.at - b.row.at || a.order - b.order)
    .map(({ row }) => row);
};

/**
 * The stored sections, or null when they will not load as sections. Every
 * field is checked rather than cast: a cast that let a missing array through
 * would throw in rendering on every attempt and the report would never go
 * out.
 */
export const parsePostmortemSections = (json: string): PostmortemSections | null => {
  let parsed: Partial<PostmortemSections> | null;
  try {
    parsed = JSON.parse(json) as Partial<PostmortemSections> | null;
  } catch {
    return null;
  }
  if (!parsed) return null;
  const strings = [
    parsed.atAGlance,
    parsed.userImpact,
    parsed.rootCause,
    parsed.practiceChanges,
  ];
  if (strings.some((value) => typeof value !== "string")) return null;
  if (
    !Array.isArray(parsed.timeline) ||
    !parsed.timeline.every(
      (row) =>
        typeof row?.event === "string" &&
        (row.at === undefined || typeof row.at === "string") &&
        (row.evidenceUrl === undefined || typeof row.evidenceUrl === "string") &&
        (row.recordedEventId === undefined || typeof row.recordedEventId === "number"),
    )
  ) {
    return null;
  }
  if (
    !Array.isArray(parsed.fiveWhys) ||
    !parsed.fiveWhys.every((s) => typeof s?.why === "string" && typeof s?.because === "string")
  ) {
    return null;
  }
  if (
    !Array.isArray(parsed.resolutionActions) ||
    !parsed.resolutionActions.every((a) => typeof a === "string")
  ) {
    return null;
  }
  return {
    atAGlance: parsed.atAGlance!,
    timeline: parsed.timeline,
    userImpact: parsed.userImpact!,
    rootCause: parsed.rootCause!,
    fiveWhys: parsed.fiveWhys,
    resolutionActions: parsed.resolutionActions,
    practiceChanges: parsed.practiceChanges!,
  };
};

/** Only the sections, so arguments like usersImpacted are not stored twice. */
export const pickSections = (args: PostmortemSections): PostmortemSections => ({
  atAGlance: args.atAGlance,
  timeline: args.timeline,
  userImpact: args.userImpact,
  rootCause: args.rootCause,
  fiveWhys: args.fiveWhys,
  resolutionActions: args.resolutionActions,
  practiceChanges: args.practiceChanges,
});
