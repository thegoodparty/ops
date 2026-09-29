// Against a real snapshot, because the bug this covers is invisible to any
// test that opens a fresh file. `schema.sql` runs as CREATE TABLE IF NOT
// EXISTS, so a column added to a table that already exists arrives only on a
// database created from scratch -- which is every test, and not prod.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import Database from "better-sqlite3";
import type { S3Client } from "@aws-sdk/client-s3";

import { Db, type LateColumn } from ".";

const SCHEMA = join(__dirname, "schema.sql");

/**
 * A snapshot from before `recurrenceAnalysis` existed, built by stripping the
 * column out of the live schema rather than pinning a copy of the old one, so
 * this keeps describing the real upgrade as the schema moves on.
 */
const preColumnSnapshot = (dir: string): Buffer => {
  const ddl = readFileSync(SCHEMA, "utf8")
    .split("\n")
    .filter((line) => !/^\s*recurrenceAnalysis\s+TEXT,\s*$/.test(line))
    .join("\n");
  assert.ok(
    !/recurrenceAnalysis/.test(ddl),
    "the column has been renamed or moved; this fixture no longer builds an old snapshot",
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
              costUsd, tokensIn, tokensOut, cacheRead, cacheWrite)
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

      const columns = db
        .query<{ name: string; notnull: number }>("PRAGMA table_info(signal)")
        .filter((c) => c.name === "tokensIn");
      assert.equal(columns[0].notnull, 1, "the live column is nullable where schema.sql says it is not");
    } finally {
      db.close();
    }
  });
});
