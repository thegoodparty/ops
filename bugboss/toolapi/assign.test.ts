import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import type { Directive } from "../types";
import {
  applyAssign,
  assign,
  AssignError,
  establishedOf,
  logAssign,
} from "./assign";

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
  db.get<{ id: string; status: string; mergedInto: string | null; recurrenceOf: string | null; firstSignalAt: number }>(
    "SELECT id, status, mergedInto, recurrenceOf, firstSignalAt FROM incident WHERE id = ?",
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
      (err: Error) => {
        // It still refuses -- writes stay contained however reads opened up.
        assert.match(err.message, /not something this call does/);
        // And it says what to call instead. An agent repeats a tool error
        // into a Slack thread, and "an agent may only re-partition its own
        // incident" is a boundary the person reading it cannot see, did not
        // ask about, and can do nothing with.
        assert.match(err.message, /propose_merge/);
        assert.doesNotMatch(err.message, /\bagent\b|\bboss\b|\bhuman\b/i);
        return true;
      },
    );
    assert.deepEqual(
      signalsOn(b),
      ["sig-b"],
      "and nothing moved, which is the half that matters",
    );
  });

  it("refuses a terminal incident as a target", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const a = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    await db.withWrite((w) => {
      w.prepare(
        `UPDATE incident SET status = 'CLOSED', resolvedAt = 1, closedAt = 2,
           postmortem = 'closed by the test' WHERE id = ?`,
      ).run(a);
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
  it("refuses a merge that would absorb the more established incident", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const older = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    const newer = (
      await applyAssign(db, { signalIds: ["sig-b"], target: "NEW", reason: "b" }, { kind: "boss" })
    ).target;

    await assert.rejects(
      applyAssign(
        db,
        { signalIds: ["sig-a"], target: newer, reason: "one bug" },
        { kind: "human", slackUserId: "U123" },
      ),
      new RegExp(
        `incident ${older} is more established than ${newer}.*merge ${newer} into ${older} instead`,
      ),
      "the refusal names the direction that would have worked",
    );

    assert.deepEqual(
      signalsOn(older),
      ["sig-a"],
      "a refused merge moves nothing, including the signals it was given",
    );
    assert.equal(incident(older)?.status, "INVESTIGATING");
    assert.deepEqual(directivesFor(older), [], "and tells nobody it happened");
  });

  it("leaves a partial re-partition alone, however old the source", async () => {
    await seed("sig-a");
    await seed("sig-b");
    await seed("sig-c");
    const older = (
      await applyAssign(
        db,
        { signalIds: ["sig-a", "sig-b"], target: "NEW", reason: "a" },
        { kind: "boss" },
      )
    ).target;
    const newer = (
      await applyAssign(db, { signalIds: ["sig-c"], target: "NEW", reason: "c" }, { kind: "boss" })
    ).target;

    // The establishment rule is about two incidents becoming one. Moving some
    // of the older incident's signals into the newer one leaves both open, so
    // nothing has to win and nothing is refused.
    const result = await applyAssign(
      db,
      { signalIds: ["sig-b"], target: newer, reason: "this one belongs there" },
      { kind: "human", slackUserId: "U123" },
    );

    assert.deepEqual(result.merged, [], "neither incident was absorbed");
    assert.deepEqual(signalsOn(older), ["sig-a"]);
    assert.deepEqual(signalsOn(newer), ["sig-b", "sig-c"]);
  });

  it("merges into the more established incident when that is the direction asked for", async () => {
    await seed("sig-a");
    await seed("sig-b");
    const older = (
      await applyAssign(db, { signalIds: ["sig-a"], target: "NEW", reason: "a" }, { kind: "boss" })
    ).target;
    const newer = (
      await applyAssign(db, { signalIds: ["sig-b"], target: "NEW", reason: "b" }, { kind: "boss" })
    ).target;

    const result = await applyAssign(
      db,
      { signalIds: ["sig-b"], target: older, reason: "one bug" },
      { kind: "human", slackUserId: "U123" },
    );

    assert.deepEqual(result.merged, [newer]);
    assert.equal(incident(newer)?.mergedInto, older);
  });
});

describe("firstSignalAt follows the signals", () => {
  it("falls to the earliest signal the incident now holds", async () => {
    await seed("sig-late");
    await seed("sig-early");
    // seed() stamps openedAt in call order, so the second is the later one.
    // Swap them, because the case is an incident absorbing signals that
    // started before it did -- which is exactly how incident 79 came to
    // report the 28th while holding a signal from the 27th.
    await db.withWrite((w) => {
      w.prepare("UPDATE signal SET openedAt = ? WHERE id = ?").run(500, "sig-early");
    });

    const holder = (
      await applyAssign(
        db,
        { signalIds: ["sig-late"], target: "NEW", reason: "late" },
        { kind: "boss" },
      )
    ).target;
    assert.equal(incident(holder)?.firstSignalAt, 1000);

    await applyAssign(
      db,
      { signalIds: ["sig-early"], target: holder, reason: "older than this" },
      { kind: "boss" },
    );

    // Not cosmetic: this is the input to time to detect, and an incident
    // that absorbed an older signal really did start earlier than its own
    // column said.
    assert.equal(incident(holder)?.firstSignalAt, 500);
  });

  it("is left alone when nothing moved in", async () => {
    await seed("sig-a");
    const incidentId = (
      await applyAssign(
        db,
        { signalIds: ["sig-a"], target: "NEW", reason: "a" },
        { kind: "boss" },
      )
    ).target;

    await applyAssign(
      db,
      { signalIds: ["sig-a"], target: incidentId, reason: "already home" },
      { kind: "boss" },
    );

    assert.equal(incident(incidentId)?.firstSignalAt, 1000);
  });
});

describe("establishedOf: which record stays", () => {
  it("reads ids as numbers, which is where string order goes wrong", () => {
    // "10" sorts before "9" as text, and the tenth incident opened is the
    // younger of the two. This is the whole reason the comparison is numeric.
    assert.equal(establishedOf("9", "10"), "9");
    assert.equal(establishedOf("10", "9"), "9");
  });

  it("answers the same whichever way round it is asked", () => {
    // A rule whose answer depends on argument order is not an order, and the
    // way it fails is by reversing a merge depending on who called it.
    for (const [a, b] of [
      ["1", "2"],
      ["82", "79"],
      ["7", "7"],
    ]) {
      assert.equal(establishedOf(a, b), establishedOf(b, a), `${a} vs ${b}`);
    }
  });
});
