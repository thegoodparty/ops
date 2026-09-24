import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import type { Directive } from "../types";
import { applyAssign, assign, AssignError, logAssign } from "./assign";

const fakeS3 = () => {
  const objects = new Map<string, Buffer>();
  return {
    objects,
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

let dir: string;
let db: Db;
let s3: ReturnType<typeof fakeS3>;
let seq = 0;

const seed = async (id: string, opts: { closedAt?: number } = {}) => {
  await db.withWrite((w) => {
    w.prepare(
      `INSERT INTO signal (id, source, sourceId, kind, title, body, labels, reportedBy, openedAt, closedAt, incidentId, explained)
       VALUES (?, 'grafana', ?, 'alert', ?, '', '{}', NULL, ?, ?, NULL, 0)`,
    ).run(id, id, `signal ${id}`, 1000 + seq++, opts.closedAt ?? null);
  });
};

const directivesFor = (incidentId: string): Directive[] =>
  db
    .query<{ payload: string }>(
      "SELECT payload FROM pending_directive WHERE incidentId = ? ORDER BY id",
      [incidentId],
    )
    .map((r) => JSON.parse(r.payload) as Directive);

const incident = (id: string) =>
  db.get<{ id: string; status: string; mergedInto: string | null; recurrenceOf: string | null; owner: string; firstSignalAt: number }>(
    "SELECT id, status, mergedInto, recurrenceOf, owner, firstSignalAt FROM incident WHERE id = ?",
    [id],
  );

const signalsOn = (incidentId: string): string[] =>
  db
    .query<{ id: string }>(
      "SELECT id FROM signal WHERE incidentId = ? ORDER BY id",
      [incidentId],
    )
    .map((r) => r.id);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-assign-"));
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db?.close();
  seq = 0;
  s3 = fakeS3();
  db = await Db.open({
    path: join(dir, `assign-${Math.random().toString(36).slice(2)}.db`),
    bucket: "bugboss-test",
    key: "state/db",
    s3: s3 as unknown as S3Client,
  });
});

describe("assign: one primitive, four operations", () => {
  it("creates an incident from an unattached signal", async () => {
    await seed("sig-a");

    const result = await applyAssign(
      db,
      { signalIds: ["sig-a"], target: "NEW", reason: "no matching open incident" },
      { kind: "boss" },
    );

    assert.equal(result.created, true);
    assert.deepEqual(result.merged, []);
    const row = incident(result.target);
    assert.equal(row?.status, "INVESTIGATING");
    assert.equal(row?.owner, "agent");
    assert.equal(row?.firstSignalAt, 1000, "firstSignalAt comes from the signal");
    assert.deepEqual(signalsOn(result.target), ["sig-a"]);
  });

  it("attaches to an existing incident and tells its agent", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const { target } = await applyAssign(
      db,
      { signalIds: ["sig-a"], target: "NEW", reason: "first" },
      { kind: "boss" },
    );

    const result = await applyAssign(
      db,
      { signalIds: ["sig-b"], target, reason: "same shape" },
      { kind: "boss" },
    );

    assert.equal(result.created, false);
    assert.deepEqual(signalsOn(target), ["sig-a", "sig-b"]);
    assert.deepEqual(directivesFor(target), [
      { type: "new_signals", count: 1, summary: "same shape" },
    ]);
  });

  it("merges both incidents in one transaction", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    const b = (
      await applyAssign(db, { signalIds: ["sig-b"], target: "NEW", reason: "b" }, { kind: "boss" })
    ).target;

    const result = await applyAssign(
      db,
      { signalIds: ["sig-b"], target: a, reason: "one pool exhaustion" },
      { kind: "boss" },
    );

    assert.deepEqual(result.merged, [b]);
    assert.deepEqual(signalsOn(a), ["sig-a", "sig-b"]);
    assert.deepEqual(signalsOn(b), []);
    const losing = incident(b);
    assert.equal(losing?.status, "MERGED");
    assert.equal(losing?.mergedInto, a);
    assert.deepEqual(
      directivesFor(b),
      [{ type: "merged", into: a }],
      "the losing agent learns through a directive, not a push",
    );
  });

  it("splits a subset out without touching the rest", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = (
      await applyAssign(
        db,
        { signalIds: ["sig-a", "sig-b"], target: "NEW", reason: "both" },
        { kind: "boss" },
      )
    ).target;

    const result = await applyAssign(
      db,
      { signalIds: ["sig-b"], target: "NEW", reason: "unrelated to the cause" },
      { kind: "agent", incidentId: a },
    );

    assert.equal(result.created, true);
    assert.notEqual(result.target, a);
    assert.deepEqual(signalsOn(a), ["sig-a"]);
    assert.deepEqual(signalsOn(result.target), ["sig-b"]);
    assert.equal(incident(a)?.status, "INVESTIGATING");
  });

  it("does not call a full re-home into a new incident a merge", async () => {
    await seed("sig-a");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;

    const result = await applyAssign(
      db,
      { signalIds: ["sig-a"], target: "NEW", reason: "still firing" },
      { kind: "agent", incidentId: a },
      { recurrenceOf: a },
    );

    assert.deepEqual(result.merged, [], "an incident is not absorbed by its own offspring");
    assert.equal(incident(a)?.status, "INVESTIGATING");
    assert.equal(incident(a)?.mergedInto, null);
    assert.equal(incident(result.target)?.recurrenceOf, a);
  });

  it("resets explained when a signal changes incident", async () => {
    await seed("sig-a");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    await db.withWrite((w) => {
      w.prepare("UPDATE signal SET explained = 1 WHERE id = 'sig-a'").run();
    });

    await applyAssign(
      db,
      { signalIds: ["sig-a"], target: "NEW", reason: "moved" },
      { kind: "boss" },
    );

    const row = db.get<{ explained: number }>(
      "SELECT explained FROM signal WHERE id = 'sig-a'",
    );
    assert.equal(row?.explained, 0, "explained is relative to a root cause, so it cannot travel");
    assert.equal(incident(a)?.status, "INVESTIGATING");
  });
});

describe("assign: atomicity", () => {
  it("rolls both incidents back when anything after the merge throws", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    const b = (
      await applyAssign(db, { signalIds: ["sig-b"], target: "NEW", reason: "b" }, { kind: "boss" })
    ).target;

    await assert.rejects(
      db.withWrite((w) => {
        assign(w, { signalIds: ["sig-b"], target: a, reason: "merge" }, { kind: "boss" });
        throw new Error("boom after the merge landed");
      }),
      /boom after the merge landed/,
    );

    assert.deepEqual(signalsOn(a), ["sig-a"], "the winning side rolled back");
    assert.deepEqual(signalsOn(b), ["sig-b"], "the losing side rolled back");
    assert.equal(incident(b)?.status, "INVESTIGATING");
    assert.equal(incident(b)?.mergedInto, null);
    assert.deepEqual(directivesFor(b), [], "no directive survives a rolled-back merge");
  });

  it("writes nothing when one signal in the batch is unknown", async () => {
    await seed("sig-a");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;

    await assert.rejects(
      applyAssign(
        db,
        { signalIds: ["sig-a", "sig-nope"], target: "NEW", reason: "partial" },
        { kind: "boss" },
      ),
      /unknown signal: sig-nope/,
    );

    assert.deepEqual(signalsOn(a), ["sig-a"]);
  });
});

describe("assign: containment", () => {
  it("refuses an agent reaching a signal outside its incident", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    const b = (
      await applyAssign(db, { signalIds: ["sig-b"], target: "NEW", reason: "b" }, { kind: "boss" })
    ).target;

    await assert.rejects(
      applyAssign(
        db,
        { signalIds: ["sig-b"], target: "NEW", reason: "not mine" },
        { kind: "agent", incidentId: a },
      ),
      (err: Error) =>
        err instanceof AssignError && /sig-b is not attached to incident/.test(err.message),
    );

    assert.deepEqual(signalsOn(b), ["sig-b"]);
  });

  it("refuses an agent assigning into another incident", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    const b = (
      await applyAssign(db, { signalIds: ["sig-b"], target: "NEW", reason: "b" }, { kind: "boss" })
    ).target;

    await assert.rejects(
      applyAssign(
        db,
        { signalIds: ["sig-a"], target: b, reason: "steal" },
        { kind: "agent", incidentId: a },
      ),
      /cannot assign into incident/,
    );
  });

  it("refuses a terminal incident as a target", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    await db.withWrite((w) => {
      w.prepare("UPDATE incident SET status = 'CLOSED' WHERE id = ?").run(a);
    });

    await assert.rejects(
      applyAssign(db, { signalIds: ["sig-b"], target: a, reason: "late" }, { kind: "boss" }),
      /is CLOSED and cannot take signals/,
    );
  });

  it("lets a human merge across incidents", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    const b = (
      await applyAssign(db, { signalIds: ["sig-b"], target: "NEW", reason: "b" }, { kind: "boss" })
    ).target;

    const result = await applyAssign(
      db,
      { signalIds: ["sig-b"], target: a, reason: "these are one thing" },
      { kind: "human", slackUserId: "U123" },
    );

    assert.deepEqual(result.merged, [b]);
    assert.doesNotThrow(() => logAssign(result));
  });
});
