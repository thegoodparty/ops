// The status board: who keeps it current, and when it says anything.
//
// Three surfaces, one renderer (`slack/board.ts`), and everything here is
// about *when*:
//
//   - every incident thread's top-level message carries a header, kept
//     current in place;
//   - the board is posted once a morning, and only when something is open;
//   - the board emptying is announced once, when it stays empty.
//
// ## There is no scheduler here, deliberately
//
// Every merge to ops `main` restarts this container. An in-process cron
// holding "next fire at 07:00" in memory therefore fires twice or not at all
// depending on when a deploy lands, which is the exact class of bug this
// codebase keeps producing. So none of this schedules anything. It is a
// sweep, run from the loop that already runs every tick, and its whole
// memory is one row in SQLite.
//
// The daily marker is a **date in the board's timezone**, not a timestamp.
// "Has it been 24 hours" double-posts on the day the clocks go back and skips
// a day when they go forward; "is it still the same day there" does neither.
//
// The all-clear waits for the board to have been empty for a settle period
// and not to have been empty before. Firing on the close itself flaps: the
// board empties, an alert lands ninety seconds later, it empties again, and
// the message stops meaning anything.

import type Database from "better-sqlite3";

import type { Db } from "../db";
import type { IncidentStatus } from "../types";
import { makeAlarm, makeLog } from "../logging";
import { DEFAULT_WORKING_HOURS } from "../agent/tools";
import {
  ALL_CLEAR,
  OPEN_STATUSES,
  renderBoard,
  renderHeader,
  type BoardRow,
} from "../slack/board";

const log = makeLog("board");

const alarm = makeAlarm("board");

/**
 * The zone the board thinks in, which is the zone the nudge ladder already
 * thinks in. Imported rather than restated: two timezone constants that
 * drift apart is a bug nobody finds until somebody is paged at 3am.
 */
export const BOARD_TIME_ZONE = DEFAULT_WORKING_HOURS.timeZone;

/** Local hour the daily board goes out, on or after. */
export const DAILY_POST_HOUR = 7;

/**
 * How long the board has to stay empty before the all-clear is believed.
 *
 * Ten minutes is longer than the gap between a close and the retry of
 * whatever was failing, and shorter than anybody's coffee. It is the
 * difference between "it is over" and "the last alert stopped firing".
 */
export const ALL_CLEAR_SETTLE_MS = 10 * 60 * 1000;

const OPEN_LIST = OPEN_STATUSES.map((s) => `'${s}'`).join(",");

/**
 * Every open incident, with the three fields a row is made of. One query:
 * the board is read on every tick, and a read per incident is how a query
 * that runs twice a minute grows with the size of the corpus.
 */
export const openBoard = (db: {
  query<T>(sql: string, params?: unknown[]): T[];
}): BoardRow[] =>
  db.query<BoardRow>(
    `SELECT i.id AS incidentId,
            i.status AS status,
            i.summary AS summary,
            (SELECT title FROM signal WHERE incidentId = i.id
              ORDER BY openedAt, id LIMIT 1) AS firstSignalTitle,
            (SELECT waitingFor FROM incident_wait WHERE incidentId = i.id)
              AS waitingFor
       FROM incident i
      WHERE i.status IN (${OPEN_LIST})
      ORDER BY CAST(i.id AS INTEGER)`,
  );

interface BoardState {
  dailyOn: string | null;
  emptySince: number | null;
  clearAnnounced: number;
}

/**
 * The date in the board's zone, as `YYYY-MM-DD`.
 *
 * Fails to UTC rather than throwing, on the same reasoning as
 * `insideWorkingHours`: a runtime that cannot resolve the zone should post
 * the board at a defensible-but-possibly-wrong hour, which somebody can see
 * and correct, rather than never posting it at all.
 */
export const dateIn = (timeZone: string, at: number): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
};

export const hourIn = (timeZone: string, at: number): number => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    return Number.isFinite(hour) ? hour : new Date(at).getUTCHours();
  } catch {
    return new Date(at).getUTCHours();
  }
};

export interface BoardDeps {
  db: Db;
  /** Posts at the top of the incident channel, never in a thread. */
  post(text: string): Promise<unknown>;
  /** Rewrites one incident thread's top-level message. */
  update(channel: string, ts: string, text: string): Promise<void>;
  channel: string;
  timeZone?: string;
  postHour?: number;
  settleMs?: number;
  now?: () => number;
}

/** What one sweep did, for the tests and for the log line. */
export interface BoardSweep {
  open: number;
  /** Headers rewritten because their rendered text had changed. */
  headers: number;
  postedDaily: boolean;
  postedAllClear: boolean;
}

/**
 * Bring every incident thread's header up to date.
 *
 * Driven off a comparison rather than off a hook at each transition, which
 * is what makes it one place instead of six and what makes it self-healing:
 * a header lost to a Slack error, a restart mid-transition or a status
 * changed by a path nobody thought about is corrected on the next tick. The
 * cost of that is a header being at most one tick stale, which for a line
 * people re-read rather than get notified about is the right trade.
 *
 * An incident with no recorded opening gets nothing. `chat.update` replaces
 * the whole message, so writing a header without knowing what is underneath
 * it would delete somebody's alert text -- and that is unrecoverable where a
 * missing header is merely missing.
 */
const sweepHeaders = async (
  deps: BoardDeps,
  rows: readonly BoardRow[],
): Promise<number> => {
  const threads = new Map(
    deps.db
      .query<{ incidentId: string; slackThreadTs: string | null; opening: string; header: string | null }>(
        `SELECT t.incidentId AS incidentId, i.slackThreadTs AS slackThreadTs,
                t.opening AS opening, t.header AS header
           FROM incident_thread t JOIN incident i ON i.id = t.incidentId`,
      )
      .map((row) => [row.incidentId, row]),
  );

  let written = 0;
  for (const row of rows) {
    const thread = threads.get(row.incidentId);
    if (!thread?.slackThreadTs) continue;
    const header = renderHeader(row);
    if (header === thread.header) continue;
    try {
      await deps.update(
        deps.channel,
        thread.slackThreadTs,
        `${header}\n\n${thread.opening}`,
      );
    } catch (err) {
      // One thread's failed edit must not stop the others, and it must not
      // be recorded as written -- the next tick tries again.
      alarm("header_update_failed", {
        incidentId: row.incidentId,
        error: String(err),
      });
      continue;
    }
    await deps.db.withWrite((w: Database.Database) => {
      w.prepare("UPDATE incident_thread SET header = ? WHERE incidentId = ?").run(
        header,
        row.incidentId,
      );
    });
    written += 1;
  }
  return written;
};

/**
 * One tick's worth of board.
 *
 * Posts before it records, everywhere. A post that lands and a write that
 * fails re-posts on the next tick, which is noise; a write that lands and a
 * post that fails is a morning with no board and nothing saying so. The
 * first failure mode also only happens when `withWrite` has halted, at
 * which point nothing in this process is working anyway.
 */
export const sweepBoard = async (deps: BoardDeps): Promise<BoardSweep> => {
  const now = (deps.now ?? Date.now)();
  const timeZone = deps.timeZone ?? BOARD_TIME_ZONE;
  const postHour = deps.postHour ?? DAILY_POST_HOUR;
  const settleMs = deps.settleMs ?? ALL_CLEAR_SETTLE_MS;

  const rows = openBoard(deps.db);
  const headers = await sweepHeaders(deps, rows);
  const today = dateIn(timeZone, now);

  const state = deps.db.get<BoardState>(
    "SELECT dailyOn, emptySince, clearAnnounced FROM board_state WHERE id = 1",
  );

  // First sight of the board in this database. Written to match what is
  // there now and nothing is posted, because a schedule this process never
  // watched come due is not one it can honestly fire: a container started at
  // nine in the morning has not missed the seven o'clock board, and a board
  // that was already empty before we looked never became clear.
  if (!state) {
    const empty = rows.length === 0;
    await deps.db.withWrite((w: Database.Database) => {
      w.prepare(
        `INSERT INTO board_state (id, dailyOn, emptySince, clearAnnounced)
         VALUES (1, ?, ?, ?)`,
      ).run(
        hourIn(timeZone, now) >= postHour ? today : null,
        empty ? now : null,
        empty ? 1 : 0,
      );
    });
    log("board_state_initialised", { open: rows.length, today });
    return { open: rows.length, headers, postedDaily: false, postedAllClear: false };
  }

  let postedDaily = false;
  if (state.dailyOn !== today && hourIn(timeZone, now) >= postHour) {
    // A quiet morning gets no message. Swain's call, and the reason is that
    // a daily all-clear is a post people learn to skim, which is how the one
    // that matters gets skimmed too.
    if (rows.length > 0) {
      await deps.post(renderBoard("Open incidents", rows));
      postedDaily = true;
    }
    // Marked either way. The day's slot is used up at the first tick past
    // the hour, so an incident opening at two in the afternoon starts a
    // thread rather than a board nobody asked for.
    await deps.db.withWrite((w: Database.Database) => {
      w.prepare("UPDATE board_state SET dailyOn = ? WHERE id = 1").run(today);
    });
  }

  let postedAllClear = false;
  if (rows.length > 0) {
    if (state.emptySince !== null || state.clearAnnounced === 1) {
      await deps.db.withWrite((w: Database.Database) => {
        w.prepare(
          "UPDATE board_state SET emptySince = NULL, clearAnnounced = 0 WHERE id = 1",
        ).run();
      });
    }
  } else if (state.emptySince === null) {
    await deps.db.withWrite((w: Database.Database) => {
      w.prepare("UPDATE board_state SET emptySince = ? WHERE id = 1").run(now);
    });
  } else if (state.clearAnnounced === 0 && now - state.emptySince >= settleMs) {
    await deps.post(ALL_CLEAR);
    postedAllClear = true;
    await deps.db.withWrite((w: Database.Database) => {
      w.prepare("UPDATE board_state SET clearAnnounced = 1 WHERE id = 1").run();
    });
  }

  if (postedDaily || postedAllClear || headers > 0) {
    log("board_swept", { open: rows.length, headers, postedDaily, postedAllClear });
  }
  return { open: rows.length, headers, postedDaily, postedAllClear };
};

/**
 * The board on request, as text. The Slack agent hands this to whoever
 * asked, verbatim, rather than composing its own -- which is the whole
 * reason there is one renderer.
 */
export const boardOnRequest = (db: {
  query<T>(sql: string, params?: unknown[]): T[];
}): string => {
  const rows = openBoard(db);
  return rows.length === 0 ? ALL_CLEAR : renderBoard("Open incidents", rows);
};

export type { BoardRow, IncidentStatus };
