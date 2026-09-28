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

import { Db } from ".";

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
