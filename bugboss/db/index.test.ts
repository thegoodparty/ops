// Against a real snapshot, because the bug this covers is invisible to any
// test that opens a fresh file. `schema.sql` runs as CREATE TABLE IF NOT
// EXISTS, so a column added to a table that already exists arrives only on a
// database created from scratch -- which is every test, and not prod.

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";

import { Db, type LateColumn } from ".";

const SCHEMA = join(__dirname, "schema.sql");

/**
 * A snapshot from before the late columns existed, built by stripping them
 * out of the live schema rather than pinning a copy of the old one, so this
 * keeps describing the real upgrade as the schema moves on.
 */
const preColumnSnapshot = (dir: string): Buffer => {
  const ddl = readFileSync(SCHEMA, "utf8")
    .split("\n")
    .filter(
      (line) =>
        !/^\s*recurrenceAnalysis\s+TEXT,\s*$/.test(line) &&
        !/^\s*cacheWrite1h\s+INTEGER/.test(line),
    )
    .join("\n");
  assert.ok(
    !/recurrenceAnalysis/.test(ddl) && !/cacheWrite1h/.test(ddl),
    "a column has been renamed or moved; this fixture no longer builds an old snapshot",
  );
  const path = join(dir, "old.db");
  const old = new Database(path);
  old.exec(ddl);
  old.close();
  return readFileSync(path);
};

const s3Holding = (snapshot: Buffer) => {
  const objects = new Map<string, Buffer>([["k", snapshot]]);
  return {
    send: async (cmd: {
      constructor: { name: string };
      input: { Key: string; Body?: Buffer };
    }) => {
      if (cmd.constructor.name === "GetObjectCommand") {
        const body = objects.get(cmd.input.Key);
        if (!body) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          throw err;
        }
        return { Body: { transformToByteArray: async () => body } };
      }
      objects.set(cmd.input.Key, Buffer.from(cmd.input.Body!));
      return {};
    },
  };
};

describe("a column added after its table shipped", () => {
  let dir: string;
  let snapshot: Buffer;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bugboss-db-"));
    snapshot = preColumnSnapshot(dir);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const openOver = async (name: string) =>
    Db.open({
      path: join(dir, name),
      bucket: "b",
      key: "k",
      s3: s3Holding(snapshot) as unknown as S3Client,
    });

  it("is added to a restored snapshot that predates it", async () => {
    const db = await openOver("live.db");
    try {
      const columns = db
        .query<{ name: string }>("PRAGMA table_info(incident)")
        .map((c) => c.name);
      assert.ok(
        columns.includes("recurrenceAnalysis"),
        "without this every reportResolved and reportAnalysis rolls back on prod",
      );
      assert.ok(
        columns.includes("cacheWrite1h"),
        "without this every usage roll-up rolls back on prod and a run reads as free",
      );
    } finally {
      db.close();
    }
  });

  it("lets the close that writes it through", async () => {
    const db = await openOver("live2.db");
    try {
      await db.withWrite((w) => {
        w.prepare(
          `INSERT INTO incident
             (id, status, owner, prUrls, firstSignalAt, resolvedAt, attempts,
              tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h)
           VALUES ('inc-1', 'RESOLVED', 'agent', '[]', 1000, 2000, 0, 0, 0, 0, 0, 0)`,
        ).run();
        // The two statements the missing column broke: the close writes it and
        // the search index reads it back.
        w.prepare(
          "UPDATE incident SET recurrenceAnalysis = ? WHERE id = ?",
        ).run('{"category":"previous_fix_incomplete"}', "inc-1");
      });
      assert.equal(
        db.get<{ recurrenceAnalysis: string | null }>(
          "SELECT recurrenceAnalysis FROM incident WHERE id = ?",
          ["inc-1"],
        )?.recurrenceAnalysis,
        '{"category":"previous_fix_incomplete"}',
      );
    } finally {
      db.close();
    }
  });

  it("is a no-op the second time, so a restart is not a migration", async () => {
    const first = await openOver("live3.db");
    first.close();
    // Same file, opened again over its own snapshot: the ALTER must not run
    // twice, because SQLite refuses a duplicate column rather than ignoring it.
    const second = await openOver("live3.db");
    try {
      assert.equal(
        second
          .query<{ name: string }>("PRAGMA table_info(incident)")
          .filter((c) => c.name === "recurrenceAnalysis").length,
        1,
      );
    } finally {
      second.close();
    }
  });
});

/**
 * A snapshot built from the live DDL with some declaration rewritten, which
 * is how a database that predates a schema change is reproduced without
 * pinning a copy of the old schema that would stop tracking this one.
 */
const snapshotWith = (
  dir: string,
  name: string,
  rewrite: (ddl: string) => string,
): Buffer => {
  const ddl = rewrite(readFileSync(SCHEMA, "utf8"));
  assert.notEqual(
    ddl,
    readFileSync(SCHEMA, "utf8"),
    "the declaration this fixture rewrites has moved; it no longer builds an old snapshot",
  );
  const path = join(dir, name);
  const old = new Database(path);
  old.exec(ddl);
  old.close();
  return readFileSync(path);
};

/** `alarm` is console.error, so this is how a boot-time alarm is observed. */
const alarmsDuring = async (fn: () => Promise<Db>) => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => void lines.push(line);
  try {
    const db = await fn();
    return {
      db,
      alarms: lines.map(
        (l) => JSON.parse(l) as { event: string; columns?: string[] },
      ),
    };
  } finally {
    console.error = original;
  }
};

/**
 * `costUsd` was dropped from `schema.sql` when the system stopped pretending
 * a locally computed dollar figure was a fact. There is no migration runner,
 * so prod's `incident` table still has the column and always will: the DDL
 * runs as CREATE TABLE IF NOT EXISTS over a restored snapshot, and
 * `LATE_COLUMNS` only adds.
 *
 * That divergence is deliberate and it is only safe while nothing writes the
 * column. It is `NOT NULL DEFAULT 0`, so an INSERT that omits it takes the
 * default; an INSERT that names it would fail on every fresh database, which
 * is every test, while passing in prod -- the inverse of the usual trap and
 * just as quiet. This pins the safe half.
 */
describe("a live database that still carries the retired costUsd column", () => {
  let dir: string;
  let snapshot: Buffer;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bugboss-db-cost-"));
    snapshot = snapshotWith(dir, "withcost.db", (ddl) =>
      ddl.replace(
        "  modelId           TEXT,\n",
        "  modelId           TEXT,\n  costUsd           REAL NOT NULL DEFAULT 0,\n",
      ),
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("takes the insert assign.ts writes, which no longer names it", async () => {
    const { db, alarms } = await alarmsDuring(() =>
      Db.open({
        path: join(dir, "live.db"),
        bucket: "b",
        key: "k",
        s3: s3Holding(snapshot) as unknown as S3Client,
      }),
    );
    try {
      assert.ok(
        db
          .query<{ name: string }>("PRAGMA table_info(incident)")
          .some((c) => c.name === "costUsd"),
        "the fixture is meant to reproduce prod, where the column outlives its declaration",
      );
      // A column the live database has and schema.sql does not is not drift
      // this can act on: there is no DROP COLUMN pass, and alarming on it
      // every boot would be an alarm nobody can clear.
      assert.deepEqual(
        alarms.filter((a) => a.event === "schema_drift"),
        [],
      );

      await db.withWrite((w) => {
        w.prepare(
          `INSERT INTO incident
             (id, status, owner, prUrls, firstSignalAt, recurrenceOf, rotationAtOpen,
              attempts, tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h)
           VALUES (?, 'INVESTIGATING', 'agent', '[]', ?, NULL, NULL, 0, 0, 0, 0, 0, 0)`,
        ).run("inc-1", 1000);
      });

      assert.equal(
        db.get<{ costUsd: number }>("SELECT costUsd FROM incident WHERE id = ?", [
          "inc-1",
        ])?.costUsd,
        0,
        "the leftover column takes its default; nothing writes it and nothing reads it",
      );
    } finally {
      db.close();
    }
  });
});

describe("a LATE_COLUMNS entry that cannot be applied", () => {
  let dir: string;
  let snapshot: Buffer;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bugboss-db-late-"));
    snapshot = preColumnSnapshot(dir);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const openWith = async (name: string, lateColumns: LateColumn[]) =>
    Db.open({
      path: join(dir, name),
      bucket: "b",
      key: "k",
      s3: s3Holding(snapshot) as unknown as S3Client,
      lateColumns,
    });

  it("names itself rather than leaving SQLite to say 'no such table'", async () => {
    // PRAGMA table_info answers a missing table with an empty list, so the
    // entry looks exactly like a column waiting to be added. Today the ALTER
    // is what fails, and only because schema.sql happens to run first.
    await assert.rejects(
      openWith("ghost.db", [
        { table: "ghost_table", column: "whatever", type: "TEXT" },
      ]),
      (err: Error) =>
        /LATE_COLUMNS names ghost_table\.whatever/.test(err.message) &&
        /no table ghost_table/.test(err.message),
    );
  });

  it("still adds a column to a table that does exist", async () => {
    const { db } = await alarmsDuring(() =>
      openWith("added.db", [
        { table: "signal", column: "lateArrival", type: "TEXT" },
      ]),
    );
    try {
      assert.ok(
        db
          .query<{ name: string }>("PRAGMA table_info(signal)")
          .some((c) => c.name === "lateArrival"),
      );
    } finally {
      db.close();
    }
  });

  it("still leaves a column that is already there alone", async () => {
    const entry: LateColumn[] = [
      { table: "signal", column: "twice", type: "TEXT" },
    ];
    const first = await alarmsDuring(() => openWith("twice.db", entry));
    first.db.close();
    // SQLite refuses a duplicate ADD COLUMN rather than ignoring it, so a
    // second boot over the same file proves the presence check still guards.
    const second = await alarmsDuring(() => openWith("twice.db", entry));
    try {
      assert.equal(
        second.db
          .query<{ name: string }>("PRAGMA table_info(signal)")
          .filter((c) => c.name === "twice").length,
        1,
      );
    } finally {
      second.db.close();
    }
  });
});

describe("a column schema.sql declares that the live database lacks", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bugboss-db-drift-"));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  const openOver = (name: string, snapshot: Buffer) =>
    alarmsDuring(() =>
      Db.open({
        path: join(dir, name),
        bucket: "b",
        key: "k",
        s3: s3Holding(snapshot) as unknown as S3Client,
      }),
    );

  it("is named at boot when nobody added it to LATE_COLUMNS", async () => {
    // The documented two-edits-not-one hazard, reproduced: resolvedEvidence
    // is declared in schema.sql and is not in LATE_COLUMNS, so a snapshot
    // taken before it existed never gets it and every close that writes it
    // rolls back -- invisibly, because every test opens a fresh file.
    const snapshot = snapshotWith(dir, "no-evidence.db", (ddl) =>
      ddl.replace(/^\s*resolvedEvidence\s+TEXT,\s*$/m, ""),
    );
    const { db, alarms } = await openOver("drift.db", snapshot);
    try {
      const drift = alarms.find((a) => a.event === "schema_drift");
      assert.ok(drift, "a column missing in prod and present in every test");
      assert.deepEqual(drift.columns, ["incident.resolvedEvidence"]);
    } finally {
      db.close();
    }
  });

  it("is named when it exists with a different declared type", async () => {
    const snapshot = snapshotWith(dir, "retyped.db", (ddl) =>
      ddl.replace(/^(\s*usersImpacted\s+)INTEGER,(\s*)$/m, "$1TEXT,$2"),
    );
    const { db, alarms } = await openOver("retyped-live.db", snapshot);
    try {
      const drift = alarms.find((a) => a.event === "schema_drift");
      assert.ok(drift);
      assert.deepEqual(drift.columns, [
        "incident.usersImpacted (declared INTEGER, live TEXT)",
      ]);
    } finally {
      db.close();
    }
  });

  it("does not fire on a database the late-column pass has just repaired", async () => {
    // The false-alarm case, and the reason this check is worth having: an
    // alarm that fires during normal operation teaches people to ignore
    // alarms. recurrenceAnalysis is missing from this snapshot and is in
    // LATE_COLUMNS, so by the time the check runs there is nothing to say.
    const { db, alarms } = await openOver(
      "clean.db",
      preColumnSnapshot(dir),
    );
    try {
      assert.deepEqual(
        alarms.filter((a) => a.event === "schema_drift"),
        [],
      );
    } finally {
      db.close();
    }
  });
});

describe("triage's spend columns reach a database that already exists", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bugboss-db-signal-usage-"));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  /** A snapshot from before the spend columns, with a signal already in it. */
  const olderSnapshot = (name: string): Buffer => {
    const ddl = readFileSync(SCHEMA, "utf8").replace(
      /^\s*tokensIn\s+INTEGER NOT NULL DEFAULT 0,\s*$\n\s*tokensOut\s+INTEGER NOT NULL DEFAULT 0,\s*$\n\s*cacheRead\s+INTEGER NOT NULL DEFAULT 0,\s*$\n\s*cacheWrite\s+INTEGER NOT NULL DEFAULT 0,\s*$\n\s*modelCalls\s+INTEGER NOT NULL DEFAULT 0,\s*$\n\s*modelId\s+TEXT,\s*$\n/m,
      "",
    );
    assert.notEqual(
      ddl,
      readFileSync(SCHEMA, "utf8"),
      "the signal spend declarations have moved; this fixture no longer builds an older snapshot",
    );
    const path = join(dir, name);
    const old = new Database(path);
    old.exec(ddl);
    // Production restores a snapshot with real rows in it. A defaulted
    // backfill is only correct if it reaches them.
    old
      .prepare(
        `INSERT INTO signal
           (id, source, sourceId, kind, title, body, labels, reportedBy, openedAt)
         VALUES ('sig-1', 'grafana', 'fp-1', 'alert', 't', 'b', '{}', NULL, 1)`,
      )
      .run();
    old.close();
    return readFileSync(path);
  };

  it("is added to the live database, and backfilled on the rows already there", async () => {
    // The two-edits-not-one hazard, on the columns this change adds. Every
    // test opens a fresh file where schema.sql is enough; prod restores a
    // snapshot where only LATE_COLUMNS is.
    const { db, alarms } = await alarmsDuring(() =>
      Db.open({
        path: join(dir, "live.db"),
        bucket: "b",
        key: "k",
        s3: s3Holding(olderSnapshot("old.db")) as unknown as S3Client,
      }),
    );
    try {
      assert.deepEqual(
        alarms.filter((a) => a.event === "schema_drift"),
        [],
        "the late-column pass did not repair every spend column",
      );

      const row = db
        .query<{
          tokensIn: number;
          tokensOut: number;
          cacheRead: number;
          cacheWrite: number;
          modelCalls: number;
          modelId: string | null;
        }>("SELECT tokensIn, tokensOut, cacheRead, cacheWrite, modelCalls, modelId FROM signal WHERE id = 'sig-1'")[0];

      // Zero rather than null is the whole reason the entries carry
      // `NOT NULL DEFAULT 0` instead of a bare `INTEGER`: a bare add leaves
      // these null on every pre-existing row while the type says `number`,
      // and `schemaDrift` cannot see the difference because PRAGMA reports
      // the declared type as INTEGER either way.
      assert.deepEqual(row, {
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheWrite: 0,
        modelCalls: 0,
        modelId: null,
      });

      // Every NOT NULL column, not just the first. The zero check above
      // catches a bare `INTEGER` -- it leaves existing rows null -- but it
      // does not catch `INTEGER DEFAULT 0`, which backfills the rows and
      // still leaves the column nullable, diverging from `schema.sql` and
      // from the TypeScript type in a way `schema_drift` cannot see. That
      // is the trap, so it is asserted per column rather than sampled.
      const live = new Map(
        db
          .query<{ name: string; notnull: number }>("PRAGMA table_info(signal)")
          .map((c) => [c.name, c.notnull]),
      );
      for (const column of [
        "tokensIn",
        "tokensOut",
        "cacheRead",
        "cacheWrite",
        "modelCalls",
      ]) {
        assert.equal(
          live.get(column),
          1,
          `signal.${column} is nullable in the live database where schema.sql says NOT NULL`,
        );
      }
      // modelId is the one that is meant to be nullable: there is no
      // sensible default model id, and null is what "nothing reached a
      // model" looks like.
      assert.equal(live.get("modelId"), 0);
    } finally {
      db.close();
    }
  });
});

/**
 * `incident.owner` is write-only, and this is the suite that keeps it that
 * way. Nothing reads it -- an open incident is always driven by an agent --
 * but it is still declared and still written, because neither way of removing
 * it is safe.
 *
 * The retirement rule says to drop a column from `schema.sql` and stop naming
 * it anywhere. That works for a column with a default, as the retired
 * `costUsd` was (`REAL NOT NULL DEFAULT 0`):
 * a database that keeps the column accepts an `INSERT` that has stopped
 * naming it. `owner` is `NOT NULL` with **no default**, so the same treatment
 * makes every write fail against the restored snapshot, which is every write
 * in production and none in the suite. SQLite has no `ALTER COLUMN`, so the
 * default cannot be added after the fact either.
 *
 * So it stays named. These tests are what stop somebody applying the other
 * rule to it, and the first one is the one that would have caught it.
 */
describe("the write-only owner column", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "bugboss-db-owner-"));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Production's copy of the column, which is the shape that matters: no
   * default, so an `INSERT` that omits it is rejected. A fresh database built
   * from the current `schema.sql` has a default and would accept one, which
   * is exactly why a test on a fresh file cannot see this.
   */
  const snapshotWithoutDefault = (name: string) => {
    const path = join(dir, name);
    const ddl = readFileSync(
      join(__dirname, "..", "db", "schema.sql"),
      "utf8",
    ).replace(
      /owner\s+TEXT NOT NULL DEFAULT 'agent'/,
      "owner             TEXT NOT NULL",
    );
    const seed = new Database(path);
    seed.exec(ddl);
    const declared = (
      seed.prepare("PRAGMA table_info(incident)").all() as {
        name: string
        dflt_value: string | null
      }[]
    ).find((c) => c.name === "owner");
    assert.ok(declared, "the fixture lost the column it exists to model");
    assert.equal(
      declared?.dflt_value,
      null,
      "the fixture is meant to have no default; if schema.sql moved, this suite is testing nothing",
    );
    seed.close();
    const bytes = readFileSync(path);
    rmSync(path);
    return bytes;
  };

  const openOver = async (name: string, bytes: Buffer) =>
    Db.open({
      path: join(dir, name),
      bucket: "b",
      key: "k",
      s3: s3Holding(bytes) as unknown as S3Client,
    });

  it("takes a write against a snapshot whose column has no default", async () => {
    const db = await openOver("prod-shape.db", snapshotWithoutDefault("seed1.db"));
    try {
      // The whole point. Drop `owner` from the INSERT and this is the line
      // that fails in production and nowhere else.
      await db.withWrite((w) => {
        w.prepare(
          `INSERT INTO incident
             (id, status, owner, prUrls, firstSignalAt, attempts,
              tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h)
           VALUES ('i1', 'INVESTIGATING', 'agent', '[]', 1, 0, 0, 0, 0, 0, 0)`,
        ).run();
      });
      assert.equal(
        db.get<{ owner: string }>("SELECT owner FROM incident WHERE id = 'i1'")
          ?.owner,
        "agent",
      );
    } finally {
      db.close();
    }
  });

  it("boots over that snapshot without reporting drift", async () => {
    // `schemaDrift` reports columns the DDL declares and the database lacks.
    // Both have this one, so a differing default must not read as drift --
    // only the declared type is compared, and that is what makes keeping the
    // column survivable at all.
    const events: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => {
      try {
        events.push(JSON.parse(String(line)).event);
      } catch {
        original(line);
      }
    };
    try {
      const db = await openOver("nodrift.db", snapshotWithoutDefault("seed2.db"));
      db.close();
    } finally {
      console.error = original;
    }
    assert.equal(events.includes("schema_drift"), false, `${events}`);
  });

  it("is written as 'agent' by the only statement that creates an incident", () => {
    // Read off the source rather than through assign(), because what this
    // guards is the literal: a future edit that drops `owner` from the column
    // list passes every test in this repo and fails every write in prod.
    const assignSrc = readFileSync(
      join(__dirname, "..", "toolapi", "assign.ts"),
      "utf8",
    );
    const inserts = assignSrc.match(/INSERT INTO incident[\s\S]*?VALUES[^`]*/g) ?? [];
    assert.equal(inserts.length, 1, "a second incident INSERT needs the same treatment");
    assert.match(inserts[0], /\bowner\b/, "the INSERT must still name owner");
    assert.match(inserts[0], /'agent'/, "and must write it as agent");
  });

  it("settles every row to agent, so a rollback is correct and not just safe", async () => {
    const bytes = snapshotWithoutDefault("seed3.db");
    // Seed the shape production actually had: rows a previous build would
    // read as human-owned and therefore never dispatch.
    const path = join(dir, "stranded.db");
    writeFileSync(path, bytes);
    const seeded = new Database(path);
    seeded
      .prepare(
        `INSERT INTO incident (id, status, owner, prUrls, firstSignalAt, attempts,
            tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h)
         VALUES ('stranded', 'FIXING', 'human', '[]', 1, 4, 0, 0, 0, 0, 0)`,
      )
      .run();
    // Closed before it is read: schema.sql sets WAL, so an open handle leaves
    // the tables in the -wal file and the bytes come back empty.
    seeded.close();
    const withRow = readFileSync(path);
    rmSync(path);

    const db = await openOver("settled.db", withRow);
    try {
      assert.equal(
        db.get<{ owner: string }>(
          "SELECT owner FROM incident WHERE id = 'stranded'",
        )?.owner,
        "agent",
        "the previous image filters on this column; a rolled-back deploy must not find the old answer",
      );
    } finally {
      db.close();
    }
  });

  it("is read by no SQL in the package", () => {
    // The claim the whole design rests on. A SELECT, a WHERE or an UPDATE
    // naming this column is a behaviour change, not a refactor, so it fails
    // here rather than in review.
    //
    // Scanned as SQL rather than as text: `owner` is also how GitHub spells
    // half of `owner/repo`, and the comments explaining why this column is
    // still here obviously name it too. So comments come out first, and what
    // is left has to look like a statement before it counts.
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (at: string) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "docs") continue;
        const full = join(at, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const src = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        // Every string form, not just backticks. The first version of this
        // scanned template literals only, which made it green for the wrong
        // reason: `settleOwnerToAgent` names the column in a double-quoted
        // UPDATE and went straight past.
        const strings = src.match(/`[^`]*`|"[^"\n]*"|'[^'\n]*'/g) ?? [];
        for (const sql of strings) {
          if (!/\b(SELECT|UPDATE|INSERT|DELETE)\b/i.test(sql)) continue;
          if (!/\bowner\b/.test(sql)) continue;
          // The two statements that legitimately name it, both writes.
          if (
            full.endsWith(join("toolapi", "assign.ts")) &&
            /INSERT INTO incident/.test(sql)
          ) {
            continue;
          }
          if (
            full.endsWith(join("db", "index.ts")) &&
            /UPDATE incident SET owner/.test(sql)
          ) {
            continue;
          }
          offenders.push(`${full.slice(root.length + 1)}: ${sql.slice(0, 60)}`);
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, [], "owner is write-only; this SQL reads it");
  });
});
