// The database layer. Design spec: bugboss/docs/architecture.md, Layer 1.
//
// Two properties come from one place, the withWrite helper: writes are
// serialized so two concurrent handlers cannot clobber each other even though
// they share a process, and a write does not return until S3 has it. When an
// agent's reportRootCause returns, the transition is durable.

import { makeAlarm, makeLog } from "../logging";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const log = makeLog("db");

const alarm = makeAlarm("db");

export interface LateColumn {
  table: string;
  column: string;
  type: string;
}

/**
 * Columns that arrived after their table shipped, and the reason they need
 * naming twice. `schema.sql` runs as `CREATE TABLE IF NOT EXISTS` over a
 * restored snapshot, so a column added to an existing table is a no-op there
 * and the declaration only takes effect on a database created from scratch.
 * Every test opens a fresh file and passes; prod restores a snapshot and
 * every statement naming the column fails. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so the check is here rather than in the DDL.
 *
 * Keep the declaration in `schema.sql` too: that is what a fresh database
 * gets, and it is where the column is documented.
 */
export const LATE_COLUMNS: LateColumn[] = [
  { table: "incident", column: "recurrenceAnalysis", type: "TEXT" },
  // Whole declaration, default included, for the reason spelled out below.
  {
    table: "incident_wait",
    column: "liftsOnReply",
    type: "INTEGER NOT NULL DEFAULT 1",
  },
  // The 1h cache-write share, which prices at 2x base input where the
  // rest of the write is 1.25x. Same full declaration as the signal
  // columns below, for the reason given there.
  { table: "incident", column: "cacheWrite1h", type: "INTEGER NOT NULL DEFAULT 0" },
  // The few-word title the agent keeps current, which is the board's middle
  // column and the thread header's. Nullable: an incident that has not been
  // given one falls back to its first signal's title.
  { table: "incident", column: "summary", type: "TEXT" },
  // Triage's own spend, per signal. The full declaration including
  // `NOT NULL DEFAULT 0`, not a bare `INTEGER`, and the difference is not
  // cosmetic: `ALTER TABLE ADD COLUMN x INTEGER` leaves the column nullable
  // and every existing row NULL, while `schema.sql` declares it NOT NULL and
  // the TypeScript type says `number`. `schemaDrift` below cannot catch that
  // -- `PRAGMA table_info` reports the type as "INTEGER" either way, so the
  // check compares equal and the divergence is invisible. The default is also
  // what backfills the rows already in the snapshot.
  { table: "signal", column: "tokensIn", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "signal", column: "tokensOut", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "signal", column: "cacheRead", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "signal", column: "cacheWrite", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "signal", column: "modelCalls", type: "INTEGER NOT NULL DEFAULT 0" },
  { table: "signal", column: "modelId", type: "TEXT" },
  { table: "pending_wait", column: "waitingFor", type: "TEXT" },
  { table: "incident_thread", column: "originLabel", type: "TEXT" },
  { table: "incident_thread", column: "originUrl", type: "TEXT" },
];

const columnsOf = (db: Database.Database, table: string) =>
  db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
  }[];

/**
 * Every incident is agent-driven, said once in the data as well as the code.
 *
 * Nothing reads `owner`, so this changes no behaviour in this image. It is
 * here for the one reader that still exists: the previous image, if a deploy
 * is rolled back. That build filters the dispatcher on `owner = 'agent'`, so
 * rows left saying `'human'` would come back stranded exactly as they are
 * now. Writing the value the new model implies makes a rollback correct
 * rather than merely survivable.
 *
 * Idempotent, and cheap enough to run every boot: after the first one it
 * matches nothing.
 */
export const settleOwnerToAgent = (w: Database.Database): void => {
  const moved = w
    .prepare("UPDATE incident SET owner = 'agent' WHERE owner <> 'agent'")
    .run().changes;
  if (moved > 0) log("owner_settled", { rows: moved });
};

export const addLateColumns = (
  w: Database.Database,
  late: LateColumn[] = LATE_COLUMNS,
): void => {
  for (const { table, column, type } of late) {
    const existing = columnsOf(w, table);
    // `PRAGMA table_info` answers a missing table with an empty list, so
    // "this table has no such column" and "there is no such table" are the
    // same answer here. Left to fall through, the ALTER below fails with
    // SQLite's own "no such table", which names neither this list nor the
    // entry that is wrong -- and it only fails at all because schema.sql
    // happens to run first, which is an ordering nothing enforces.
    //
    // Throwing is deliberate. A wrong entry is a defect in this file, not a
    // state the world can reach: it is identical on every boot, so the suite
    // and the first dev run catch it and it never ships. Refusing to boot on
    // it therefore costs nothing, where booting past it leaves a column
    // missing that every statement naming it will roll back.
    if (existing.length === 0) {
      throw new Error(
        `LATE_COLUMNS names ${table}.${column}, but there is no table ` +
          `${table}; either the name is wrong or schema.sql never declared it`,
      );
    }
    if (existing.some((c) => c.name === column)) continue;
    w.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    log("late_column_added", { table, column });
  }
};

/**
 * Every column `schema.sql` declares that the live database does not have,
 * plus every one whose declared type disagrees. This is the hazard the
 * two-edits-not-one rule describes, caught rather than written down: a column
 * added to `schema.sql` and missed in `LATE_COLUMNS` is present in every test
 * -- which opens a fresh file -- and absent in prod, which restores a
 * snapshot, until the first statement naming it rolls its transaction back.
 *
 * The reference is a throwaway in-memory database built from the same DDL
 * that just ran, so SQLite parses the schema rather than a regex here. No
 * comment, table-level `CHECK` or virtual-table directive can be mistaken for
 * a column, which is what keeps a finding always real: the only way to
 * produce one is a table that predates the column in the restored snapshot.
 *
 * Only the declared type is compared. SQLite forbids `ADD COLUMN NOT NULL`
 * without a default, so nullability and defaults legitimately differ between
 * a fresh database and a migrated one and comparing them would alarm on a
 * correct database.
 */
const schemaDrift = (w: Database.Database, ddl: string): string[] => {
  const reference = new Database(":memory:");
  try {
    reference.exec(ddl);
    const tables = reference
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[];

    const drift: string[] = [];
    for (const { name: table } of tables) {
      const live = new Map(columnsOf(w, table).map((c) => [c.name, c.type]));
      for (const { name, type } of columnsOf(reference, table)) {
        const found = live.get(name);
        if (found === undefined) drift.push(`${table}.${name}`);
        else if (found.toUpperCase() !== type.toUpperCase())
          drift.push(`${table}.${name} (declared ${type}, live ${found})`);
      }
    }
    return drift;
  } finally {
    reference.close();
  }
};

export interface DbConfig {
  path: string;
  bucket: string;
  /** Key for the snapshot. Restored on boot, overwritten on every write. */
  key: string;
  s3?: S3Client;
  /**
   * Overrides `LATE_COLUMNS`. Here so a test can drive the real boot path:
   * the ordering between `schema.sql` and the late-column pass is the thing
   * worth covering, and it exists nowhere but inside `Db.open`.
   */
  lateColumns?: LateColumn[];
  /** Overrides the snapshot timing below, so a test does not wait it out. */
  snapshotTiming?: Partial<SnapshotTiming>;
  now?: () => number;
}

export interface SnapshotTiming {
  /** Per PUT. The SDK sets none by default, so a stalled socket waits forever. */
  putTimeoutMs: number;
  /** Pauses between the attempts one write makes before it halts. */
  retryDelaysMs: number[];
  /** First wait before a halted Db tries again; doubles up to the max. */
  haltRetryMs: number;
  haltRetryMaxMs: number;
  /** A halt older than this alarms a second time, once. */
  haltAlarmMs: number;
}

export const SNAPSHOT_TIMING: SnapshotTiming = {
  putTimeoutMs: 20_000,
  retryDelaysMs: [500, 2_000],
  haltRetryMs: 5_000,
  haltRetryMaxMs: 60_000,
  haltAlarmMs: 5 * 60_000,
};

interface Halt {
  error: string;
  since: number;
  nextRetryAt: number;
  retryMs: number;
  alarmedPersisting: boolean;
}

export class Db {
  private readonly write: Database.Database;
  /** Separate connection, opened read-only. Agents query through this one. */
  private readonly read: Database.Database;
  private readonly s3: S3Client;
  private readonly cfg: DbConfig;
  /** Serializes writes. One process, so a promise chain is the whole lock. */
  private queue: Promise<unknown> = Promise.resolve();
  private halted: Halt | null = null;
  private readonly timing: SnapshotTiming;
  private readonly now: () => number;

  private constructor(cfg: DbConfig, s3: S3Client) {
    this.cfg = cfg;
    this.s3 = s3;
    this.timing = { ...SNAPSHOT_TIMING, ...cfg.snapshotTiming };
    this.now = cfg.now ?? Date.now;
    this.write = new Database(cfg.path);
    this.write.pragma("journal_mode = WAL");
    this.write.pragma("foreign_keys = ON");
    this.read = new Database(cfg.path, { readonly: true });
  }

  /**
   * Fetch the snapshot from S3 if present, then open. A missing object is a
   * cold start, not an error.
   */
  static async open(cfg: DbConfig): Promise<Db> {
    const s3 = cfg.s3 ?? new S3Client({});
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.key }),
      );
      const bytes = await res.Body!.transformToByteArray();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(cfg.path, bytes);
      log("restored_snapshot", { bytes: bytes.length });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== "NoSuchKey" && name !== "NotFound") throw err;
      log("cold_start");
    }

    const db = new Db(cfg, s3);
    const ddl = readFileSync(join(__dirname, "schema.sql"), "utf8");
    db.write.exec(ddl);
    addLateColumns(db.write, cfg.lateColumns);
    settleOwnerToAgent(db.write);

    // Alarm rather than throw, unlike a bad LATE_COLUMNS entry above. This
    // one is reachable only in prod -- every test opens a fresh file, where
    // there is nothing to drift from -- so refusing to boot on it turns one
    // rolled-back statement into a Boss that cannot investigate why. It is
    // also the shape index.ts already uses for the search-index backfill:
    // loud, named, and not fatal. The columns are the whole fix.
    const drift = schemaDrift(db.write, ddl);
    if (drift.length > 0)
      alarm("schema_drift", {
        columns: drift,
        note: "declared in schema.sql, missing or differently typed in the live database; add each to LATE_COLUMNS",
      });

    return db;
  }

  /**
   * The only way to write. Runs fn in a transaction, uploads the database as
   * that transaction leaves it, and commits only once S3 has it. Local is
   * never ahead of S3: a write whose upload fails is rolled back, so a caller
   * told it failed is telling the truth, and a marker that throws is a
   * marker nobody will find on the next tick.
   *
   * An upload that keeps failing halts writes, which here is a circuit
   * breaker rather than a guard against divergence, since there is none to
   * guard against. While halted a write is refused without an upload until
   * the backoff allows one more try, and the first upload that lands lifts
   * the halt.
   */
  async withWrite<T>(fn: (db: Database.Database) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const halt = this.halted;
      if (halt) {
        const now = this.now();
        if (!halt.alarmedPersisting && now - halt.since >= this.timing.haltAlarmMs) {
          halt.alarmedPersisting = true;
          alarm("writes_still_halted", {
            haltedForMs: now - halt.since,
            error: halt.error,
            note: "every write in this process is refusing; S3 has not taken an upload since the halt",
          });
        }
        if (now < halt.nextRetryAt) throw new Error(`writes halted: ${halt.error}`);
      }

      this.write.exec("BEGIN IMMEDIATE");
      let result: T;
      try {
        result = fn(this.write);
      } catch (err) {
        if (this.write.inTransaction) this.write.exec("ROLLBACK");
        throw err;
      }
      // `serialize` reads through this connection, so it holds the
      // uncommitted transaction, and the read connection still sees the
      // state before it.
      const body = this.write.serialize();

      // One try while halted, so a refusing S3 does not hold the queue for
      // every write behind this one.
      const delays = halt ? [] : this.timing.retryDelaysMs;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
        try {
          await this.put(body);
          this.write.exec("COMMIT");
          if (attempt > 0) log("snapshot_retry_succeeded", { attempt: attempt + 1 });
          if (halt) {
            this.halted = null;
            log("writes_resumed", { haltedForMs: this.now() - halt.since });
          }
          return result;
        } catch (err) {
          lastErr = err;
          log("snapshot_attempt_failed", { attempt: attempt + 1, error: String(err) });
        }
      }
      this.write.exec("ROLLBACK");

      if (halt) {
        halt.error = String(lastErr);
        halt.retryMs = Math.min(halt.retryMs * 2, this.timing.haltRetryMaxMs);
        halt.nextRetryAt = this.now() + halt.retryMs;
        throw new Error(`writes halted: ${halt.error}`);
      }
      const now = this.now();
      this.halted = {
        error: String(lastErr),
        since: now,
        nextRetryAt: now + this.timing.haltRetryMs,
        retryMs: this.timing.haltRetryMs,
        alarmedPersisting: false,
      };
      alarm("snapshot_failed_halting_writes", {
        error: String(lastErr),
        attempts: delays.length + 1,
        note: "the write was rolled back; writes refuse until an upload lands, tried again on the next write after a backoff",
      });
      throw lastErr;
    });

    // Keep the chain alive even when a write throws, or one failure would
    // wedge every subsequent write behind a rejected promise.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One upload. A new command and a new SDK call every time, so every
   * attempt is signed when it is sent. The deadline is what stops a stalled
   * socket holding the write queue until its signature is too old for S3 to
   * accept.
   */
  private put = async (body: Buffer): Promise<void> => {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.cfg.key, Body: body }),
      { abortSignal: AbortSignal.timeout(this.timing.putTimeoutMs) },
    );
  };

  /** Read-only. This is what triage and the Slack agent query through. */
  query<T = unknown>(sql: string, params: unknown[] = []): T[] {
    return this.read.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
    return this.read.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  close(): void {
    this.read.close();
    this.write.close();
  }
}
