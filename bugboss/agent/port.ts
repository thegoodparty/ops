// What an incident agent reaches that is not ToolApi, in-process: the Boss's
// inbox, the outstanding-question marker, the wait marker monitor keeps while
// it is blocked on a person, the non-draining timeline read and the SQL
// sidecar.
//
// One port per incident, built for the incident its conversation's
// IncidentDoc names, so every method here is scoped by construction: nothing
// the agent passes picks the incident. Everything an agent says to a person
// arrives at the Boss's inbox through here, and nothing here posts to Slack.

import type Database from "better-sqlite3";

import { recordForBoss } from "../boss/inbox";
import type { Db } from "../db";
import { makeLog } from "../logging";
import { readTimelineEvents } from "../toolapi";
import type { BossInboxKind, TimelineEvent, WakeBoss } from "../types";
import type { SqlRequestPort } from "./sql";
import type {
  BossInboxPort,
  PendingQuestion,
  PendingWait,
  QuestionMarkerPort,
  WaitMarkerPort,
} from "./tools";

const log = makeLog("agent-port");

export interface AgentPort extends BossInboxPort, WaitMarkerPort, QuestionMarkerPort, SqlRequestPort {
  /**
   * The timeline without the drain. The stage compaction and the goal
   * evaluator read it, and neither puts what it reads in front of the model
   * as a tool result.
   */
  timelineEvents(): Promise<TimelineEvent[]>;
}

const BOSS_INBOX_KINDS: readonly BossInboxKind[] = ["message", "question", "escalation"];

export const createAgentPort = (deps: {
  db: Db;
  incidentId: string;
  /** Runs the Boss for an incident whose inbox just gained a row. */
  wakeBoss: WakeBoss;
  sql: SqlRequestPort;
  /**
   * Tells the dispatcher the agent sent up its own escalation brief, so its
   * deadline does not post a placeholder over it. A harness rung while the
   * agent waits is not a brief and does not count.
   */
  noteEscalated?: (incidentId: string) => void;
  now?: () => number;
}): AgentPort => {
  const { db, incidentId } = deps;
  const now = deps.now ?? Date.now;

  const readWait = (w: Database.Database) =>
    w
      .prepare(
        "SELECT command, startedAt, pings, lastPingAt FROM pending_wait WHERE incidentId = ?",
      )
      .get(incidentId) as PendingWait | undefined;

  return {
    /**
     * The only way anything an agent writes leaves it for a person. The row is
     * committed before the Boss is woken, so a Boss run that starts on the wake
     * always finds it, and a wake that lands while the Boss is already running
     * is picked up by that run rather than lost.
     *
     * No length limit. The Boss is the reader, not a phone, and what reaches a
     * person is the Boss's own words.
     */
    tellBoss: async (kind, text, options) => {
      if (!BOSS_INBOX_KINDS.includes(kind)) {
        throw new Error(`kind must be one of ${BOSS_INBOX_KINDS.join(", ")}, got ${String(kind)}`);
      }
      if (typeof text !== "string" || !text.trim()) throw new Error("text is empty");

      const exists = db.get<{ id: string }>("SELECT id FROM incident WHERE id = ?", [incidentId]);
      if (!exists) throw new Error(`unknown incident ${incidentId}`);

      const id = await db.withWrite((w) =>
        recordForBoss(w, { incidentId, kind, text: text.trim() }),
      );
      log("boss_inbox_recorded", { incidentId, kind, id });
      if (kind === "escalation" && options?.ownBrief) deps.noteEscalated?.(incidentId);
      deps.wakeBoss(incidentId);
    },

    /**
     * How many escalations have gone up since a moment, and when the last one
     * did. An unanswered question re-escalates on a doubling gap, and reading
     * the gap off the inbox rather than off a counter is what lets it survive
     * a restart: the rows are the record of what the Boss has been told.
     */
    escalationsSince: async (since) => {
      if (!Number.isFinite(since)) throw new Error("since must be epoch millis");
      const row = db.get<{ count: number; lastAt: number | null }>(
        `SELECT COUNT(*) AS count, MAX(createdAt) AS lastAt FROM boss_inbox
          WHERE incidentId = ? AND kind = 'escalation' AND createdAt >= ?`,
        [incidentId, since],
      );
      return row ?? { count: 0, lastAt: null };
    },

    getPending: async () =>
      db.get<PendingQuestion>(
        "SELECT message, askedAt FROM pending_question WHERE incidentId = ?",
        [incidentId],
      ) ?? null,

    /**
     * Idempotent for the same question, and only for the same question. A
     * restarted agent replays the tool call that has no result yet, and the
     * second attempt has to find the first question rather than overwrite its
     * askedAt, which is what the unanswered-question clock runs from.
     *
     * A *different* question is the opposite case. clearPending does not run
     * when a run dies mid-wait, so the marker outlives the question it was
     * written for; leaving it in place would give the next question the old
     * one's askedAt, and it would escalate as unanswered the moment it was
     * asked.
     */
    recordPending: async (message) => {
      if (!String(message ?? "").trim()) throw new Error("message is empty");
      const row = await db.withWrite((w) => {
        // messageTs is written and read by nothing; it is NOT NULL with no
        // default, so an insert still has to name it.
        w.prepare(
          `INSERT INTO pending_question (incidentId, messageTs, askedAt, message)
           VALUES (?, '', ?, ?)
           ON CONFLICT(incidentId) DO UPDATE SET
             askedAt = excluded.askedAt,
             message = excluded.message
           WHERE pending_question.message <> excluded.message`,
        ).run(incidentId, now(), message);
        return w
          .prepare("SELECT message, askedAt FROM pending_question WHERE incidentId = ?")
          .get(incidentId) as PendingQuestion;
      });
      log("question_recorded", { incidentId, askedAt: row.askedAt });
      return row;
    },

    clearPending: async () => {
      await db.withWrite((w) => {
        w.prepare("DELETE FROM pending_question WHERE incidentId = ?").run(incidentId);
      });
    },

    /**
     * The wait marker monitor keeps while it is blocked on a person. Idempotent
     * for the same command, and only for the same command: a restart replays
     * the tool call and has to find the wait it was already in -- overwriting
     * startedAt there would restart the elapsed clock and defer every reminder
     * for as long as the restarts last. A different command is a different
     * wait, and inherits neither the clock nor the reminder count.
     *
     * `waitingFor` is taken on every call, the same command included: it is
     * the label people read, and a replay that words it better should show.
     */
    recordWait: async (command, waitingFor) => {
      if (!String(command ?? "").trim()) throw new Error("command is empty");
      const label = String(waitingFor ?? "").trim();
      return db.withWrite((w) => {
        w.prepare(
          `INSERT INTO pending_wait (incidentId, command, waitingFor, startedAt, pings, lastPingAt)
           VALUES (?, ?, ?, ?, 0, NULL)
           ON CONFLICT(incidentId) DO UPDATE SET
             waitingFor = COALESCE(excluded.waitingFor, pending_wait.waitingFor),
             startedAt = CASE WHEN pending_wait.command = excluded.command
               THEN pending_wait.startedAt ELSE excluded.startedAt END,
             pings = CASE WHEN pending_wait.command = excluded.command
               THEN pending_wait.pings ELSE 0 END,
             lastPingAt = CASE WHEN pending_wait.command = excluded.command
               THEN pending_wait.lastPingAt ELSE NULL END,
             command = excluded.command`,
        ).run(incidentId, command, label || null, now());
        return readWait(w) as PendingWait;
      });
    },

    /**
     * Counted before the reminder is sent, so a crash between the two costs one
     * reminder rather than repeating it on every resume. A missing marker is an
     * error rather than an upsert: there is no wait to count against, and
     * inventing one would start the clock at the moment of the fault.
     */
    recordPing: async () => {
      const row = await db.withWrite((w) => {
        w.prepare(
          "UPDATE pending_wait SET pings = pings + 1, lastPingAt = ? WHERE incidentId = ?",
        ).run(now(), incidentId);
        return readWait(w);
      });
      if (!row) throw new Error("no wait is recorded");
      log("wait_ping_recorded", { incidentId, pings: row.pings });
      return row;
    },

    clearWait: async () => {
      await db.withWrite((w) => {
        w.prepare("DELETE FROM pending_wait WHERE incidentId = ?").run(incidentId);
      });
    },

    timelineEvents: async () => readTimelineEvents(db, incidentId),

    createSqlRequest: (args) => deps.sql.createSqlRequest(args),
    getSqlRequest: (requestId) => deps.sql.getSqlRequest(requestId),
  };
};
