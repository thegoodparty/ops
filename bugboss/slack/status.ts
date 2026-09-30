// What an incident's status looks like, at every scale BugBoss shows it.
//
// Asked "what is the status of this incident?", the Boss used to compose an
// answer from whatever it had read, and wrote a different shape every time.
// The lifecycle, what the incident is waiting on and what it has cost are
// facts in the database, so they are rendered here, in code, and the Boss
// pastes the result. Exactly one line of the card is written by a model --
// what the agent is doing right now -- because that one is a reading of a
// transcript rather than a field.
//
// Two scales, one set of facts:
//
//   the card          `incident_status`, one incident, several lines.
//   the status line   one incident on one line: the board on request, the
//                     morning board and each thread's header.
//
// They share `waitingOn` and `lifecycleWord`, so the card and the board
// cannot disagree about where an incident is or what it needs.

import type { IncidentStatus } from "../types";
import { link, mrkdwn, raw } from "./format";

/**
 * The statuses an incident is open in, which is the same list the dispatcher
 * keeps an agent on (`AGENT_STATUSES`) and the relay calls
 * `AGENT_RUNNING_STATUSES`. RESOLVED is open: the post-mortem is still owed
 * and the agent is still running.
 */
export const OPEN_STATUSES: readonly IncidentStatus[] = [
  "INVESTIGATING",
  "FIXING",
  "RESOLVED",
];

/** The lifecycle, in order. MERGED is not on it: it leaves the lifecycle. */
const LIFECYCLE: readonly IncidentStatus[] = [
  "INVESTIGATING",
  "FIXING",
  "RESOLVED",
  "CLOSED",
];

const TITLE_CASE: Record<IncidentStatus, string> = {
  INVESTIGATING: "Investigating",
  FIXING: "Fixing",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  MERGED: "Merged",
};

/**
 * Everything the status of one incident is made of, as the database has it.
 * None of it is new state. Read by `STATUS_FACTS_SQL`, one row per incident.
 */
export interface StatusFacts {
  incidentId: string;
  status: IncidentStatus;
  /** The agent's few-word title, or null if it has not written one yet. */
  summary: string | null;
  /** The first signal's title, which is the fallback for a missing summary. */
  firstSignalTitle: string | null;
  mergedInto: string | null;
  /** `incident_wait.waitingFor`, or null when nothing is being waited on. */
  waitingFor: string | null;
  /**
   * `incident_wait.liftsOnReply`. Zero is a park that a message does not end,
   * which is how a spent turn budget parks: the agent has nothing left to
   * spend on whatever it would be told.
   */
  liftsOnReply: number | null;
  waitStartedAt: number | null;
  /** `pending_question`: the agent is blocked on a question to the Boss. */
  questionAskedAt: number | null;
  questionText: string | null;
  /** `pending_wait`: the agent is inside `monitor`, waiting on a person. */
  monitorCommand: string | null;
  monitorStartedAt: number | null;
  /** Questions the agent sent up that no Boss run has read yet. */
  unreadQuestions: number;
}

/**
 * One row of `StatusFacts` per incident, from `incident i`. A fragment rather
 * than a query so the board, the header sweep and the card all read the same
 * columns the same way; each caller adds its own WHERE and ORDER BY.
 */
export const STATUS_FACTS_SQL = `SELECT i.id AS incidentId,
            i.status AS status,
            i.summary AS summary,
            i.mergedInto AS mergedInto,
            (SELECT title FROM signal WHERE incidentId = i.id
              ORDER BY openedAt, id LIMIT 1) AS firstSignalTitle,
            w.waitingFor AS waitingFor,
            w.liftsOnReply AS liftsOnReply,
            w.startedAt AS waitStartedAt,
            q.askedAt AS questionAskedAt,
            q.message AS questionText,
            p.command AS monitorCommand,
            p.startedAt AS monitorStartedAt,
            (SELECT COUNT(*) FROM boss_inbox b
              WHERE b.incidentId = i.id AND b.kind = 'question' AND b.seenAt IS NULL)
              AS unreadQuestions
       FROM incident i
       LEFT JOIN incident_wait w ON w.incidentId = i.id
       LEFT JOIN pending_question q ON q.incidentId = i.id
       LEFT JOIN pending_wait p ON p.incidentId = i.id`;

/**
 * Every field on a status line is one line. A signal title comes out of an
 * alert annotation and `waitingFor` out of a model, so a newline in either is
 * not a state that can be designed away upstream. Whitespace is collapsed,
 * nothing is cut.
 */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export const titleOf = (facts: StatusFacts): string =>
  oneLine(facts.summary ?? facts.firstSignalTitle ?? "no title recorded");

/**
 * A wait on a spent turn budget: parked, and a message will not wake it.
 * Only while the incident is open: a close does not delete the wait row, so a
 * closed or merged incident would otherwise keep claiming it can be woken.
 */
export const isParked = (facts: StatusFacts): boolean =>
  OPEN_STATUSES.includes(facts.status) &&
  facts.waitingFor !== null &&
  facts.liftsOnReply === 0;

/** "4 min ago", from two epoch-ms instants. Whole units only. */
export const ago = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/**
 * Where the incident is, as one word. The current status in caps, plus
 * PARKED when a spent budget has parked it -- the one state the status column
 * cannot show, and the one a reader most needs to see.
 */
export const lifecycleWord = (facts: StatusFacts): string =>
  isParked(facts) ? `${facts.status}, PARKED` : facts.status;

/**
 * Every state in order with the current one in bold caps, so where an
 * incident is and what is left are read off one line.
 */
export const lifecycleLine = (facts: StatusFacts): string => {
  if (facts.status === "MERGED") {
    return mrkdwn`*MERGED* into incident ${facts.mergedInto ?? "unknown"}, which carries on from here · ${raw(LIFECYCLE.map((s) => TITLE_CASE[s]).join(" → "))} ended with it`;
  }
  const steps = LIFECYCLE.map((s) => (s === facts.status ? `*${s}*` : TITLE_CASE[s])).join(" → ");
  return isParked(facts)
    ? `${steps} · *PARKED*: the agent's turn budget is spent, so a message will not wake it`
    : steps;
};

/**
 * What the incident needs from anyone, as the parts that apply.
 *
 * `now` turns on the ages -- the card says how long each thing has waited,
 * the one-line forms do not. A status line is also a thread header, which is
 * rewritten whenever its text changes, so a clock in it would rewrite every
 * header every minute.
 */
export const waitingOn = (facts: StatusFacts, now: number | null): string => {
  if (facts.status === "CLOSED") return "nobody; this incident is over";
  if (facts.status === "MERGED") {
    return mrkdwn`nobody; it was merged into incident ${facts.mergedInto ?? "unknown"}`;
  }
  const since = (at: number | null, verb: string): string =>
    now !== null && at !== null ? ` (${verb} ${ago(at, now)})` : "";

  const parts: string[] = [];
  if (facts.waitingFor !== null) {
    parts.push(mrkdwn`${oneLine(facts.waitingFor)}${raw(since(facts.waitStartedAt, "since"))}`);
  }
  if (facts.questionAskedAt !== null) {
    const question = oneLine(facts.questionText ?? "");
    parts.push(
      now !== null && question
        ? mrkdwn`an answer to the agent's question${raw(since(facts.questionAskedAt, "asked"))}: "${question}"`
        : mrkdwn`an answer to the agent's question${raw(since(facts.questionAskedAt, "asked"))}`,
    );
  } else if (facts.unreadQuestions > 0) {
    parts.push(
      `the Boss to read ${facts.unreadQuestions} question${facts.unreadQuestions === 1 ? "" : "s"} from the agent`,
    );
  }
  if (facts.monitorCommand !== null) {
    parts.push(
      mrkdwn`a person; the agent is checking \`${oneLine(facts.monitorCommand)}\` until it passes${raw(since(facts.monitorStartedAt, "since"))}`,
    );
  }
  if (parts.length > 0) return parts.join("; ");
  return facts.status === "RESOLVED" ? "nobody; the agent is writing the post-mortem" : "nobody";
};

/** One incident, on one line: the board's row. */
export const renderStatusLine = (facts: StatusFacts): string =>
  mrkdwn`• *Incident ${facts.incidentId}* · ${lifecycleWord(facts)} · ${titleOf(facts)} · waiting on ${raw(waitingOn(facts, null))}`;

/**
 * The header above an incident thread's opening message. Two lines, so it
 * stays a header, and the same words as the board line.
 */
export const renderStatusHeader = (facts: StatusFacts): string =>
  [
    mrkdwn`*Incident ${facts.incidentId} · ${lifecycleWord(facts)}* · ${titleOf(facts)}`,
    mrkdwn`_Waiting on ${raw(waitingOn(facts, null))}_`,
  ].join("\n");

/** A pull request as `<url|owner/repo#7>`, since the number is what a reader wants. */
const prLink = (url: string): string => {
  const parts = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url);
  try {
    return parts ? link(url, `${parts[1]}#${parts[2]}`) : link(url);
  } catch {
    return mrkdwn`${url}`;
  }
};

/** The card's fields that are not in `StatusFacts`. */
export interface StatusCardView {
  facts: StatusFacts;
  usersImpacted: number | null;
  prUrls: readonly string[];
  /** The one model-written line, or "summary unavailable". */
  now: string;
  /** When the session last recorded anything, or null for no session. */
  lastActivityAt: number | null;
  /** `describeSpend` over the session, or null for no session. */
  spend: string | null;
  at: number;
}

const impactOf = (users: number | null): string =>
  users === null
    ? "not measured yet"
    : users === 1
      ? "1 user affected"
      : `${users.toLocaleString("en-US")} users affected`;

/**
 * The card. Every labelled field is code; `now` is the one line a model
 * wrote, and it is still escaped here like any other value.
 */
export const renderStatusCard = (view: StatusCardView): string => {
  const { facts } = view;
  const prs = view.prUrls.length > 0 ? view.prUrls.map(prLink).join(", ") : "none opened";
  return [
    mrkdwn`*Incident ${facts.incidentId}* · ${titleOf(facts)}`,
    lifecycleLine(facts),
    mrkdwn`*Now:* ${oneLine(view.now)}`,
    mrkdwn`*Waiting on:* ${raw(waitingOn(facts, view.at))}`,
    mrkdwn`*Impact:* ${impactOf(view.usersImpacted)}`,
    mrkdwn`*PR:* ${raw(prs)}`,
    mrkdwn`*Last agent activity:* ${view.lastActivityAt === null ? "none recorded" : ago(view.lastActivityAt, view.at)} · *Spent so far:* ${view.spend ?? "nothing recorded"}`,
  ].join("\n");
};

/**
 * Rendered mrkdwn, handed to the model to paste rather than posted by code.
 *
 * What the Boss writes goes through `toMrkdwn` on the way out, which escapes,
 * and escaping is deliberately not idempotent -- so text that was already
 * escaped here would post as `&amp;lt;`. Undoing exactly what `escape` did
 * makes the round trip exact: the values come back to the raw characters and
 * are escaped once, at the boundary, like everything else the Boss says.
 */
export const forModelToPaste = (rendered: string): string =>
  rendered.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
