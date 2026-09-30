// The assign primitive: re-partition signals across incidents.
//
// Design spec: bugboss/docs/architecture.md, "Merge and split are one primitive --
// one code path, one audit shape".
//
// Create, attach, merge and split are all the same move, distinguished only by
// what is moving and where it lands:
//
//   create  one unattached signal   -> NEW
//   attach  one unattached signal   -> an existing incident
//   merge   all of B's signals      -> A
//   split   a subset of A's signals -> NEW
//
// Merge is the one of the four with a direction, and the direction is not the
// caller's to pick: the more established of the two incidents stays as the
// record, and a request to merge the other way is refused. See establishedOf.
//
// Every function here is synchronous and takes a raw handle, because it runs
// inside Db.withWrite's transaction. A merge touches two incidents and the
// whole point of SQL here is that it either lands on both or on neither.

import { makeLog } from "../logging";
import type Database from "better-sqlite3";

import type {
  AssignRequest,
  Directive,
  Incident,
  IncidentStatus,
  Signal,
} from "../types";

/**
 * Who is asking. An agent is confined to its own incident; the Boss (triage,
 * correlation) and a human acting through Slack are not.
 */
export type AssignActor =
  | { kind: "agent"; incidentId: string }
  | { kind: "human"; slackUserId: string }
  | { kind: "boss" };

export interface AssignOptions {
  /** Stamped on the incident created when target is "NEW". */
  recurrenceOf?: string;
  /** Slack user ids on the rotation right now, snapshotted onto a new incident. */
  rotationAtOpen?: string[];
  /** Overrides id generation, for tests. */
  newId?: () => string;
}

export interface AssignResult {
  target: string;
  /** True when the target was created by this call. */
  created: boolean;
  /** Source incidents this call emptied and marked MERGED. */
  merged: string[];
  /** Signals that actually moved. Empty when every signal was already home. */
  moved: string[];
  actor: AssignActor;
  reason: string;
}

/** Thrown for a rejected assign. Callers turn it into a ToolResponse error. */
export class AssignError extends Error {}

const log = makeLog("toolapi");

/**
 * Statuses a signal may be attached to. Narrower than the set the dispatcher
 * and triage digest call open, which includes RESOLVED — an incident can
 * still have an agent on it writing a post-mortem while being closed to new
 * signals. Named for what it gates rather than "open" so the two cannot be
 * mistaken for each other, which is what `triage.ts` already calls ATTACHABLE.
 */
const ATTACHABLE_STATUSES: IncidentStatus[] = ["INVESTIGATING", "FIXING"];

const placeholders = (n: number) => new Array(n).fill("?").join(",");

export interface IncidentRow extends Omit<Incident, "prUrls" | "rotationAtOpen"> {
  prUrls: string;
  rotationAtOpen: string | null;
}

export interface SignalRow extends Omit<Signal, "labels" | "explained"> {
  labels: string;
  explained: number;
}

export const rowToIncident = (row: IncidentRow): Incident => ({
  ...row,
  prUrls: JSON.parse(row.prUrls) as string[],
  rotationAtOpen: row.rotationAtOpen
    ? (JSON.parse(row.rotationAtOpen) as string[])
    : null,
});

export const rowToSignal = (row: SignalRow): Signal => ({
  ...row,
  labels: JSON.parse(row.labels) as Record<string, string>,
  explained: row.explained === 1,
});

export const getIncidentRow = (
  db: Database.Database,
  id: string,
): Incident | undefined => {
  const row = db.prepare("SELECT * FROM incident WHERE id = ?").get(id) as
    | IncidentRow
    | undefined;
  return row ? rowToIncident(row) : undefined;
};

export const getSignalsFor = (
  db: Database.Database,
  incidentId: string,
): Signal[] => {
  const rows = db
    .prepare("SELECT * FROM signal WHERE incidentId = ? ORDER BY openedAt, id")
    .all(incidentId) as SignalRow[];
  return rows.map(rowToSignal);
};

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

export const pushDirective = (
  db: Database.Database,
  incidentId: string,
  directive: Directive,
): void => {
  db.prepare(
    "INSERT INTO pending_directive (incidentId, payload, createdAt) VALUES (?, ?, ?)",
  ).run(incidentId, JSON.stringify(directive), Date.now());
  // The Boss is the only thing a person's word reaches an agent through, so
  // its message is what wakes a parked incident. A reply in the thread no
  // longer can: it goes to the Boss, and relaunching an agent that has
  // nothing new to read costs a launch for chatter.
  if (directive.type === "boss_message") {
    db.prepare(
      "DELETE FROM incident_wait WHERE incidentId = ? AND liftsOnReply = 1",
    ).run(incidentId);
  }
};

/**
 * Read and delete in the same transaction, so a directive is delivered exactly
 * once even though two calls can race for the same incident.
 */
export const drainDirectives = (
  db: Database.Database,
  incidentId: string,
): Directive[] => {
  const rows = db
    .prepare(
      "SELECT id, payload FROM pending_directive WHERE incidentId = ? ORDER BY id",
    )
    .all(incidentId) as { id: number; payload: string }[];
  if (rows.length === 0) return [];

  db.prepare(
    `DELETE FROM pending_directive WHERE id IN (${placeholders(rows.length)})`,
  ).run(...rows.map((r) => r.id));

  return rows.map((r) => JSON.parse(r.payload) as Directive);
};

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * Which of two incidents stays the incident of record when they combine.
 *
 * The lower id, because ids are handed out MAX(id)+1 and are therefore the
 * only monotonic record of when the incident itself was opened -- and the one
 * fact about an incident a re-partition cannot move.
 *
 * `firstSignalAt` is the obvious answer and it is wrong twice over. It is a
 * property of the signals, so the challenger inherits the incumbent's age by
 * taking its oldest one: incident 82 was minutes old and read a day older
 * than the incident it absorbed. And it is never recomputed on absorb, so 79
 * held a signal from the 27th while its own column said the 28th. Movable and
 * stale, and a merge is exactly the moment both bite.
 *
 * What this protects is the thread people have been reading, but the number
 * of replies in it is not the test either: most incidents carry none, so it
 * ties constantly and falls back to age anyway, and it backs the newcomer the
 * moment somebody says "on it" in a fresh thread. Age of the record dominates
 * it and never ties.
 */
export const establishedOf = (a: string, b: string): string => {
  const na = Number(a);
  const nb = Number(b);
  // The string branch is for an id this system did not allocate, which is a
  // fixture rather than a state production can reach. It is here because the
  // numeric comparison answers NaN <= NaN with false, so without it the
  // "winner" of two unparseable ids would be whichever was passed second --
  // an answer that changes when the arguments swap is not an order at all,
  // and it fails in the direction of silently reversing a merge.
  if (Number.isFinite(na) && Number.isFinite(nb)) return na <= nb ? a : b;
  return a <= b ? a : b;
};

const nextIncidentId = (db: Database.Database): string => {
  const row = db
    .prepare("SELECT MAX(CAST(id AS INTEGER)) AS n FROM incident")
    .get() as { n: number | null };
  return String((row.n ?? 0) + 1);
};

export const assign = (
  db: Database.Database,
  req: AssignRequest,
  actor: AssignActor,
  opts: AssignOptions = {},
): AssignResult => {
  const ids = [...new Set(req.signalIds)];
  if (ids.length === 0) throw new AssignError("assign needs at least one signal");

  const rows = db
    .prepare(`SELECT * FROM signal WHERE id IN (${placeholders(ids.length)})`)
    .all(...ids) as SignalRow[];
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new AssignError(`unknown signal: ${missing.join(", ")}`);
  }

  // Containment. A compromised agent can re-partition its own incident and
  // nothing else, so the blast radius stays one record.
  if (actor.kind === "agent") {
    const foreign = rows.find((r) => r.incidentId !== actor.incidentId);
    if (foreign) {
      throw new AssignError(
        `signal ${foreign.id} is not attached to incident ${actor.incidentId}`,
      );
    }
    // Off the normal path now: proposeMerge is how signals reach another
    // incident, and it goes through a judgement and lands here as the Boss.
    // So this is a guard rather than an answer, and it says what to call
    // instead -- not which kinds of caller exist, which is a shape of this
    // system nobody outside it should have to learn from an error.
    if (req.target !== "NEW" && req.target !== actor.incidentId) {
      throw new AssignError(
        `moving signals into incident ${req.target} is not something this call does; propose_merge asks for the two incidents to be combined`,
      );
    }
  }

  let target: string;
  let created = false;

  if (req.target === "NEW") {
    target = opts.newId ? opts.newId() : nextIncidentId(db);
    created = true;
    db.prepare(
      // `owner` is write-only and always 'agent'. It is named here rather than
      // left to its default because the restored snapshot's copy of the column
      // has no default -- see the comment on it in schema.sql.
      `INSERT INTO incident
         (id, status, owner, prUrls, firstSignalAt, recurrenceOf, rotationAtOpen,
          attempts, tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h)
       VALUES (?, 'INVESTIGATING', 'agent', '[]', ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
    ).run(
      target,
      Math.min(...rows.map((r) => r.openedAt)),
      opts.recurrenceOf ?? null,
      // Captured here rather than read back later: a Slack user group is
      // mutable and keeps no history, so this is the only moment the answer
      // exists.
      opts.rotationAtOpen ? JSON.stringify(opts.rotationAtOpen) : null,
    );
  } else {
    const existing = getIncidentRow(db, req.target);
    if (!existing) throw new AssignError(`unknown incident: ${req.target}`);
    // Never across RESOLVED either. A signal arriving after a resolution is
    // evidence the resolution was wrong, so it belongs to a recurrence and
    // not to the incident that claimed the ground. Triage judges that; this
    // is the single writer that holds it.
    if (!ATTACHABLE_STATUSES.includes(existing.status)) {
      throw new AssignError(
        `incident ${req.target} is ${existing.status} and cannot take signals`,
      );
    }
    target = req.target;
  }

  const moved = rows.filter((r) => r.incidentId !== target).map((r) => r.id);
  const sources = [
    ...new Set(
      rows
        .map((r) => r.incidentId)
        .filter((id): id is string => id !== null && id !== target),
    ),
  ];

  // Establishment. A move that empties one incident into another is the two
  // becoming one, and something has to stay the incident of record. Left to
  // the caller it was an accident of which agent happened to be acting:
  // correlation absorbed whichever incident had not just reported a root
  // cause, which sent a thread with four days of conversation into one opened
  // minutes earlier. Held here because this is the single writer, so no
  // caller can arrive at a backwards merge by another route.
  //
  // A partial move is not this. Re-partitioning stays free; only the last
  // signal leaving is a merge.
  if (!created) {
    for (const source of sources) {
      const staying = db
        .prepare(
          `SELECT COUNT(*) AS n FROM signal
            WHERE incidentId = ? AND id NOT IN (${placeholders(ids.length)})`,
        )
        .get(source, ...ids) as { n: number };
      if (staying.n > 0) continue;
      if (establishedOf(source, target) !== source) continue;
      throw new AssignError(
        `incident ${source} is more established than ${target}, so it stays the incident of record; merge ${target} into ${source} instead`,
      );
    }
  }

  if (moved.length > 0) {
    // explained resets: it means "accounted for by this incident's root
    // cause", which a signal arriving in a new home has not been.
    db.prepare(
      `UPDATE signal SET incidentId = ?, explained = 0 WHERE id IN (${placeholders(moved.length)})`,
    ).run(target, ...moved);
  }

  // firstSignalAt follows the signals, because it is the input to time to
  // detect and an incident that has absorbed older signals really did start
  // earlier than its own column said. Left alone, incident 79 held a signal
  // from the 27th and reported the 28th.
  //
  // It cannot go up here: only a move *in* runs this, so the minimum over
  // what the target holds can only fall. The EXISTS guard is for the column
  // being NOT NULL -- an empty target would write a null and throw, which a
  // move into it cannot produce, but the guard costs nothing and the throw
  // would roll back a legitimate re-partition.
  if (!created && moved.length > 0) {
    db.prepare(
      `UPDATE incident
          SET firstSignalAt = (SELECT MIN(openedAt) FROM signal WHERE incidentId = ?)
        WHERE id = ? AND EXISTS (SELECT 1 FROM signal WHERE incidentId = ?)`,
    ).run(target, target, target);
  }

  // An emptied source is a merge only when the signals landed somewhere that
  // already existed. Emptying an incident into a freshly created one is a
  // split that happened to take everything, and calling that a merge would
  // record the incident as absorbed by its own offspring.
  const merged: string[] = [];
  if (!created) {
    for (const source of sources) {
      const left = db
        .prepare("SELECT COUNT(*) AS n FROM signal WHERE incidentId = ?")
        .get(source) as { n: number };
      if (left.n > 0) continue;

      const row = getIncidentRow(db, source);
      if (!row || !ATTACHABLE_STATUSES.includes(row.status)) continue;

      db.prepare(
        "UPDATE incident SET status = 'MERGED', mergedInto = ? WHERE id = ?",
      ).run(target, source);
      pushDirective(db, source, { type: "merged", into: target });
      merged.push(source);
    }
  }

  const movedIntoRunningAgent =
    !created &&
    moved.length > 0 &&
    !(actor.kind === "agent" && actor.incidentId === target);
  if (movedIntoRunningAgent) {
    const row = getIncidentRow(db, target);
    if (row && ATTACHABLE_STATUSES.includes(row.status)) {
      pushDirective(db, target, {
        type: "new_signals",
        count: moved.length,
        summary: req.reason,
        // Named, not implied. Signals arriving because another incident was
        // emptied into this one is a different event from signals arriving
        // because a new alert fired, and the surviving agent is the one that
        // has to write a title covering both -- which it cannot do honestly
        // for an incident it was never told about. The details follow on its
        // next get_incident, as `absorbed`.
        ...(merged.length > 0 ? { absorbed: merged } : {}),
      });
    }
  }

  return { target, created, merged, moved, actor, reason: req.reason };
};

/**
 * The one audit shape. Emitted after the transaction commits, never inside it,
 * so a rolled-back assign leaves no record claiming it happened.
 */
export const logAssign = (result: AssignResult): void =>
  log("assign", {
    actor:
      result.actor.kind === "agent"
        ? `agent:${result.actor.incidentId}`
        : result.actor.kind === "human"
          ? `human:${result.actor.slackUserId}`
          : "boss",
    target: result.target,
    created: result.created,
    merged: result.merged,
    moved: result.moved,
    reason: result.reason,
  });

/**
 * The async entry point, for callers outside a transaction: triage applying a
 * decision, the Slack agent merging or splitting on a person's say-so. A merge
 * touches two incidents and lands inside one transaction, so a crash between
 * the two sides is not a case that exists.
 */
export const applyAssign = async (
  db: { withWrite<T>(fn: (h: Database.Database) => T): Promise<T> },
  req: AssignRequest,
  actor: AssignActor,
  opts: AssignOptions = {},
): Promise<AssignResult> => {
  const result = await db.withWrite((h) => assign(h, req, actor, opts));
  logAssign(result);
  return result;
};
