// What an open incident looks like when it is one line rather than a thread.
//
// A status board row and an incident thread's top-level message are the same
// three fields at different scales: where the work is, what the incident is,
// and what is needed from a person. So they are one renderer. Two renderers
// is how a board and a thread come to disagree about the same incident, and
// the reader has no way to tell which one is stale.
//
// None of the three fields is new state:
//
//   status       the incident row's own.
//   summary      the few-word title the agent keeps current. Falls back to
//                the first signal's title, which is what the thread's
//                top-level message has always said.
//   needed       `incident_wait.waitingFor`, which is already documented as
//                "what is being waited on, in one line, for the thread and
//                the digest". An incident with no wait needs nothing, and
//                saying that out loud is what makes the ones that do worth
//                trusting.
//
// Nothing in here resolves a link. Every line names its incident in prose and
// `slack/incidents.ts` links it on the way out, which is also what keeps a
// thread's own header from linking to itself.

import type { IncidentStatus } from "../types";
import { mrkdwn } from "./format";

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

/**
 * How a status reads to somebody who does not work on this system. RESOLVED
 * says what is left rather than the word on the row, because "resolved" next
 * to an incident still on the board is a contradiction a reader has to stop
 * and resolve for themselves.
 */
const STATUS_LABEL: Record<IncidentStatus, string> = {
  INVESTIGATING: "Investigating",
  FIXING: "Fixing",
  RESOLVED: "Fixed, writing the post-mortem",
  CLOSED: "Closed",
  MERGED: "Merged",
};

export interface BoardRow {
  incidentId: string;
  status: IncidentStatus;
  /** The agent's few-word title, or null if it has not written one yet. */
  summary: string | null;
  /** The first signal's title, which is the fallback for a missing summary. */
  firstSignalTitle: string | null;
  /** `incident_wait.waitingFor`, or null when nothing is being waited on. */
  waitingFor: string | null;
}

/**
 * Every field here is one line, because a board row is one line.
 *
 * Enforced where it is needed rather than at each writer. A signal title
 * comes out of an alert annotation and `waitingFor` out of a model, so
 * "somebody wrote a newline into it" is not a state that can be designed
 * away upstream -- and a single row that wraps into three is the difference
 * between a board somebody scans and one they stop reading.
 */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The one sentence for the incident itself. An incident that has neither a
 * summary nor a signal title has had something go wrong upstream of here, and
 * saying so beats an empty space nobody can interpret.
 */
const titleOf = (row: BoardRow): string =>
  oneLine(row.summary ?? row.firstSignalTitle ?? "no title recorded");

/**
 * What a person has to do, or that they have to do nothing.
 *
 * A terminal incident says so rather than reading "nothing needed from
 * anyone", which on a closed thread sounds like an incident nobody is
 * getting to. It is the last thing this header will ever say: see the
 * finalising pass in `board/index.ts`.
 */
const neededOf = (row: BoardRow): string =>
  oneLine(
    row.waitingFor ??
      (OPEN_STATUSES.includes(row.status)
        ? "nothing needed from anyone"
        : "nothing further — this incident is over"),
  );

/**
 * The header that sits above an incident thread's original message.
 *
 * Above rather than instead of: the alert text that opened the thread is what
 * somebody scrolling back is looking for, and this is a header they re-read,
 * not a replacement for it. Two lines, so it stays a header.
 */
export const renderHeader = (row: BoardRow): string =>
  [
    mrkdwn`*Incident ${row.incidentId} · ${STATUS_LABEL[row.status]}* · ${titleOf(row)}`,
    mrkdwn`_${neededOf(row)}_`,
  ].join("\n");

/** One incident, on one line. */
export const renderBoardLine = (row: BoardRow): string =>
  mrkdwn`• *Incident ${row.incidentId}* · ${STATUS_LABEL[row.status]} · ${titleOf(row)} · _${neededOf(row)}_`;

/**
 * Every open incident, as one message.
 *
 * The count leads, because the first thing somebody on the rotation wants to
 * know is the size of it. `heading` varies with why the board is being shown
 * -- somebody asked, or it is the morning -- and nothing else does.
 */
export const renderBoard = (heading: string, rows: readonly BoardRow[]): string =>
  [
    mrkdwn`*${heading} · ${rows.length} open*`,
    ...rows.map(renderBoardLine),
  ].join("\n");

/**
 * The board emptying, which is the one thing here that is an event rather
 * than a state. Posted once, when the last open incident closes and stays
 * closed -- see the settle period in the composition root.
 */
export const ALL_CLEAR = [
  "*The board is clear*",
  "_Nothing is open. Every incident has a post-mortem and is closed._",
].join("\n");
