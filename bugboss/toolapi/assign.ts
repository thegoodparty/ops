// The assign primitive: re-partition signals across incidents.
//
// Design spec: docs/bugboss/design.md, "Merge and split are one primitive --
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
// Every function here is synchronous and takes a raw handle, because it runs
// inside Db.withWrite's transaction. A merge touches two incidents and the
// whole point of SQL here is that it either lands on both or on neither.

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
 * correlation) and a human acting through Slack or MCP are not.
 */
export type AssignActor =
  | { kind: "agent"; incidentId: string }
  | { kind: "human"; slackUserId: string }
  | { kind: "boss" };

export interface AssignOptions {
  /** Stamped on the incident created when target is "NEW". */
  recurrenceOf?: string;
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

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "toolapi", event, ...data }));

const OPEN_STATUSES: IncidentStatus[] = ["INVESTIGATING", "FIXING"];

const placeholders = (n: number) => new Array(n).fill("?").join(",");

export interface IncidentRow extends Omit<Incident, "prUrls"> {
  prUrls: string;
}

export interface SignalRow extends Omit<Signal, "labels" | "explained"> {
  labels: string;
  explained: number;
}

export const rowToIncident = (row: IncidentRow): Incident => ({
  ...row,
  prUrls: JSON.parse(row.prUrls) as string[],
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
    if (req.target !== "NEW" && req.target !== actor.incidentId) {
      throw new AssignError(
        `incident ${actor.incidentId} cannot assign into incident ${req.target}`,
      );
    }
  }

  let target: string;
  let created = false;

  if (req.target === "NEW") {
    target = opts.newId ? opts.newId() : nextIncidentId(db);
    created = true;
    db.prepare(
      `INSERT INTO incident (id, status, owner, prUrls, firstSignalAt, recurrenceOf, attempts, costUsd, tokensIn, tokensOut, cacheRead, cacheWrite)
       VALUES (?, 'INVESTIGATING', 'agent', '[]', ?, ?, 0, 0, 0, 0, 0, 0)`,
    ).run(
      target,
      Math.min(...rows.map((r) => r.openedAt)),
      opts.recurrenceOf ?? null,
    );
  } else {
    const existing = getIncidentRow(db, req.target);
    if (!existing) throw new AssignError(`unknown incident: ${req.target}`);
    // Never across RESOLVED either. A signal arriving after a resolution is
    // evidence the resolution was wrong, so it belongs to a recurrence and
    // not to the incident that claimed the ground. Triage judges that; this
    // is the single writer that holds it.
    if (!OPEN_STATUSES.includes(existing.status)) {
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

  if (moved.length > 0) {
    // explained resets: it means "accounted for by this incident's root
    // cause", which a signal arriving in a new home has not been.
    db.prepare(
      `UPDATE signal SET incidentId = ?, explained = 0 WHERE id IN (${placeholders(moved.length)})`,
    ).run(target, ...moved);
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
      if (!row || !OPEN_STATUSES.includes(row.status)) continue;

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
    if (row && row.owner === "agent" && OPEN_STATUSES.includes(row.status)) {
      pushDirective(db, target, {
        type: "new_signals",
        count: moved.length,
        summary: req.reason,
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
