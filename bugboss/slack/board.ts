// What an open incident looks like when it is one line rather than a thread,
// and the top-level message each thread hangs off.
//
// A board row carries three fields: where the work is, what the incident is,
// and what is needed from a person. The thread header carries the title and
// what is needed from a person, from the same facts through `slack/status.ts`,
// so a board and a thread cannot disagree about the same incident.
//
// None of the fields is new state:
//
//   status       the incident row's own.
//   summary      the few-word title the agent keeps current. Falls back to
//                the first signal's title.
//   needed       what the incident is waiting on: `incident_wait`, an
//                unanswered agent question, a `monitor` wait on a person,
//                or "nobody". Derived in `slack/status.ts`, the same words
//                the `incident_status` card uses.
//
// Nothing in here resolves a link. Every line names its incident in prose and
// `slack/incidents.ts` links it on the way out, which is also what keeps a
// thread's own header from linking to itself.

import type { SignalOriginRef } from "../ingress/link";
import {
  OPEN_STATUSES,
  renderStatusHeader,
  renderStatusLine,
  type StatusFacts,
} from "./status";
import { mrkdwn } from "./format";

export { OPEN_STATUSES };

/**
 * A board row is the status of one incident, and it is read from the same
 * facts, rendered by the same code, as the card `incident_status` hands the
 * Boss (`slack/status.ts`). Three renderings of the same lifecycle word and
 * the same "waiting on" is how a board and a card come to disagree.
 */
export type BoardRow = StatusFacts;

/**
 * The whole top-level message of an incident thread: the number and title,
 * the signal that opened it, and what a person has to do, if anything.
 */
export const renderHeader = (row: BoardRow, origin: SignalOriginRef | null): string =>
  renderStatusHeader(row, origin);

/** One incident, on one line. */
export const renderBoardLine = (row: BoardRow): string => renderStatusLine(row);

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
