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
//   needed       what the incident is waiting on: `incident_wait`, an
//                unanswered agent question, a `monitor` wait on a person,
//                or "nobody". Derived in `slack/status.ts`, the same words
//                the `incident_status` card uses.
//
// Nothing in here resolves a link. Every line names its incident in prose and
// `slack/incidents.ts` links it on the way out, which is also what keeps a
// thread's own header from linking to itself.

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
 * The header that sits above an incident thread's original message.
 *
 * Above rather than instead of: the alert text that opened the thread is what
 * somebody scrolling back is looking for, and this is a header they re-read,
 * not a replacement for it. Two lines, so it stays a header.
 */
export const renderHeader = (row: BoardRow): string => renderStatusHeader(row);

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
