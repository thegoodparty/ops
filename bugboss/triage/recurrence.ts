// Recurrence: the closed-incident analogue of the open-incident digest.
//
// `correlate.ts` compares one incident against the OPEN ones and proposes
// merges. This compares one inbound signal against incidents that already
// claimed the problem was over. RESOLVED means no users are affected any more
// and no further alerts should occur, so a matching signal afterwards is not a
// duplicate: it is evidence the resolution was wrong, and the post-mortem
// written for it is the most valuable thing an agent can start from.
//
// Two indexed reads and no model call. Triage runs on every delivery, so the
// candidate set has to be cheap; the judgement stays where the judgement
// already is, in the one bounded call triage was already making.

import type { RawSignal } from "../types";
import { SLUG_LABEL } from "../ingress/grafana";
import type { IncidentReader } from "./sql";

const DAY_MS = 86_400_000;

/**
 * How long after a resolution an exact-key match is a recurrence rather than
 * history. A Grafana fingerprint is stable for the life of the alert rule, so
 * the same alert firing in January and again in June is the rule doing its
 * job, not a premature close. Two weeks covers the three cases the earlier
 * post-mortem is worth re-reading for: the fix was wrong, the fix was
 * reverted, the fix never reached production.
 */
export const RECURRENCE_WINDOW_MS = 14 * DAY_MS;

/** Bounds both queries and the prompt. Older than this is research, not triage. */
export const CANDIDATE_LOOKBACK_MS = 90 * DAY_MS;

const MAX_CANDIDATES = 3;
const MAX_CAUSE_CHARS = 400;
const MAX_EVIDENCE_CHARS = 300;

/**
 * How the candidate was found, strongest first.
 *
 * `exact_signal` is `(source, sourceId)`, the dedup key every adapter must
 * produce and the one the schema's partial unique index was built around: the
 * delivery proving a resolution was premature is the one most certain to
 * collide with the signal that resolution closed.
 *
 * `same_alert` is the same `alert_slug` on a different sourceId -- the same
 * rule firing on a different instance. Weaker, because one rule covers many
 * instances and two of them breaking is often two problems.
 */
export type RecurrenceMatch = "exact_signal" | "same_alert";

export interface RecurrenceCandidate {
  incidentId: string;
  status: string;
  match: RecurrenceMatch;
  rootCause: string | null;
  resolvedEvidence: string | null;
  resolvedAt: number;
  /** Signed: negative means the incident resolved after this signal started. */
  daysSince: number;
  /**
   * An exact-key match inside the window. Recurrence without a judgement, so
   * triage stamps it whether or not the model mentions it.
   */
  conclusive: boolean;
  signalTitle: string;
}

interface CandidateRow {
  incidentId: string | null;
  status: string | null;
  rootCause: string | null;
  resolvedEvidence: string | null;
  resolvedAt: number | null;
  signalTitle: string | null;
}

// MAX(s.openedAt) with bare columns is SQLite's documented "row that carries
// the max" behaviour, so the title and status come from the latest matching
// signal rather than an arbitrary one. GROUP BY collapses an incident that
// took several deliveries of the same key into one candidate.
const SELECT = `SELECT i.id AS incidentId, i.status AS status, i.rootCause AS rootCause,
         i.resolvedEvidence AS resolvedEvidence, i.resolvedAt AS resolvedAt,
         s.title AS signalTitle, MAX(s.openedAt) AS lastSignalAt
  FROM signal s JOIN incident i ON i.id = s.incidentId
  WHERE `;

const TAIL = `AND i.status IN ('RESOLVED','CLOSED')
    AND i.resolvedAt IS NOT NULL AND i.resolvedAt >= ?
  GROUP BY i.id
  ORDER BY i.resolvedAt DESC
  LIMIT ?`;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}...[truncated]` : text;

const toCandidate = (
  row: CandidateRow,
  match: RecurrenceMatch,
  openedAt: number,
): RecurrenceCandidate | null => {
  if (!row.incidentId || !row.status || row.resolvedAt === null) return null;
  const sinceMs = openedAt - row.resolvedAt;
  return {
    incidentId: row.incidentId,
    status: row.status,
    match,
    rootCause: row.rootCause ? clip(row.rootCause, MAX_CAUSE_CHARS) : null,
    resolvedEvidence: row.resolvedEvidence
      ? clip(row.resolvedEvidence, MAX_EVIDENCE_CHARS)
      : null,
    resolvedAt: row.resolvedAt,
    daysSince: Math.round((sinceMs / DAY_MS) * 10) / 10,
    // A negative interval is not an error and is not excluded: an alert that
    // was still firing when the incident was marked RESOLVED is the premature
    // close in its purest form.
    conclusive: match === "exact_signal" && sinceMs <= RECURRENCE_WINDOW_MS,
    signalTitle: row.signalTitle ?? "(no title)",
  };
};

/**
 * Throws on a failed read, like every other helper in `sql.ts` and for the
 * same reason: an empty array here means "nothing ever claimed this was
 * fixed", which is the single answer a broken lookup must never be able to
 * produce. The caller guards it and says so.
 */
export const findRecurrenceCandidates = (
  db: IncidentReader,
  signal: RawSignal,
): RecurrenceCandidate[] => {
  const floor = signal.openedAt - CANDIDATE_LOOKBACK_MS;

  const exact = db
    .query<CandidateRow>(
      `${SELECT}s.source = ? AND s.sourceId = ? ${TAIL}`,
      [signal.source, signal.sourceId, floor, MAX_CANDIDATES],
    )
    .map((row) => toCandidate(row, "exact_signal", signal.openedAt))
    .filter((c): c is RecurrenceCandidate => c !== null);

  const slug = signal.labels[SLUG_LABEL];
  if (!slug) return exact;

  const seen = new Set(exact.map((c) => c.incidentId));
  const wider = db
    .query<CandidateRow>(
      `${SELECT}json_extract(s.labels, '$.${SLUG_LABEL}') = ? AND s.sourceId <> ? ${TAIL}`,
      [slug, signal.sourceId, floor, MAX_CANDIDATES],
    )
    .map((row) => toCandidate(row, "same_alert", signal.openedAt))
    .filter((c): c is RecurrenceCandidate => c !== null && !seen.has(c.incidentId));

  return [...exact, ...wider].slice(0, MAX_CANDIDATES);
};

/**
 * The one candidate triage does not need the model's opinion about. Newest
 * first, because the resolution a signal contradicts is the last one made.
 */
export const conclusiveRecurrence = (
  candidates: RecurrenceCandidate[],
): RecurrenceCandidate | null =>
  candidates.filter((c) => c.conclusive).sort((a, b) => b.resolvedAt - a.resolvedAt)[0] ??
  null;

const describe = (c: RecurrenceCandidate): string => {
  const when =
    c.daysSince < 0
      ? `resolved ${Math.abs(c.daysSince)}d after this signal started`
      : `resolved ${c.daysSince}d before this signal started`;
  const how =
    c.match === "exact_signal"
      ? "same source and sourceId as this signal"
      : `same ${SLUG_LABEL}, different sourceId`;
  return [
    `- ${c.incidentId} | ${c.status} | ${when} | ${how}${c.conclusive ? " | CONCLUSIVE" : ""}`,
    `  its signal: ${clip(c.signalTitle, 200)}`,
    `  rootCause: ${c.rootCause ?? "never established"}`,
    `  resolved because: ${c.resolvedEvidence ?? "no evidence recorded"}`,
  ].join("\n");
};

/**
 * `null` means the lookup failed, and it renders as an explicit unavailable
 * rather than an empty list -- the same rule prefetched evidence follows, so
 * "we did not check" never reads to the model as "we checked and found
 * nothing".
 */
export const renderRecurrence = (
  candidates: RecurrenceCandidate[] | null,
): string => {
  if (candidates === null) {
    return `RECURRENCE CANDIDATES UNAVAILABLE
The lookup failed, so whether an earlier incident already claimed this was
fixed is not known here. Do not read this as "none".`;
  }
  if (candidates.length === 0) {
    return "RECURRENCE CANDIDATES\n(no incident in the last 90 days claimed this problem was over)";
  }
  return `RECURRENCE CANDIDATES\n${candidates.map(describe).join("\n")}`;
};
