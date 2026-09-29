import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import { BOARD_TIME_ZONE, dateIn, hourIn, openBoard, sweepBoard } from ".";
import { DEFAULT_WORKING_HOURS } from "../agent/tools";

const CHANNEL = "C0DEVALERTS";

const noS3 = (): S3Client =>
  ({
    send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) {
        const err = new Error("cold start");
        err.name = "NoSuchKey";
        throw err;
      }
      return {};
    },
  }) as unknown as S3Client;

let dir: string;
let db: Db;

/** 2026-03-02, a Monday, at the given Eastern hour. */
const easternAt = (hour: number, day = 2): number =>
  Date.parse(`2026-03-0${day}T${String(hour + 5).padStart(2, "0")}:00:00Z`);

const seed = (id: string, over: Record<string, unknown> = {}) =>
  db.withWrite((d) => {
    const status = (over.status as string) ?? "INVESTIGATING";
    d.prepare(
      `INSERT INTO incident (id, status, summary, firstSignalAt, resolvedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      id,
      status,
      over.summary === undefined ? `what ${id} is` : over.summary,
      1,
      status === "RESOLVED" ? 1 : null,
    );
  });

const close = (id: string) =>
  db.withWrite((d) => {
    d.prepare(
      `UPDATE incident SET status = 'CLOSED', resolvedAt = 1, closedAt = 2,
         postmortem = 'written up' WHERE id = ?`,
    ).run(id);
  });

const openThread = (id: string, ts: string, opening = `*Incident ${id} opened*`) =>
  db.withWrite((d) => {
    d.prepare("UPDATE incident SET slackThreadTs = ? WHERE id = ?").run(ts, id);
    d.prepare(
      "INSERT INTO incident_thread (incidentId, opening) VALUES (?, ?)",
    ).run(id, opening);
  });

const harness = (at: number) => {
  const posts: string[] = [];
  const edits: { ts: string; text: string }[] = [];
  return {
    posts,
    edits,
    sweep: () =>
      sweepBoard({
        db,
        post: (text) => {
          posts.push(text);
          return Promise.resolve({ ts: "x" });
        },
        update: (_channel, ts, text) => {
          edits.push({ ts, text });
          return Promise.resolve();
        },
        channel: CHANNEL,
        now: () => at,
      }),
  };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-board-"));
  db = await Db.open({
    path: join(dir, "board.db"),
    bucket: "bugboss-test",
    key: "state/db",
    s3: noS3(),
  });
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.withWrite((d) => {
    d.prepare("DELETE FROM board_state").run();
    d.prepare("DELETE FROM incident_thread").run();
    d.prepare("DELETE FROM incident_wait").run();
    d.prepare("DELETE FROM signal").run();
    d.prepare("DELETE FROM incident").run();
  });
});

// ---------------------------------------------------------------------------

describe("the zone", () => {
  /**
   * Two timezone constants that drift apart is a bug nobody finds until
   * somebody is paged at 3am. PR #120's nudge ladder picked one; the board
   * imports it rather than restating it.
   */
  test("is the one the nudge ladder already uses", () => {
    assert.equal(BOARD_TIME_ZONE, DEFAULT_WORKING_HOURS.timeZone);
  });

  test("a date is the date where the board is, not where the container is", () => {
    // 03:00 UTC on the 3rd is still the evening of the 2nd in New York.
    assert.equal(dateIn("America/New_York", Date.parse("2026-03-03T03:00:00Z")), "2026-03-02");
  });

  test("an hour is the hour where the board is", () => {
    assert.equal(hourIn("America/New_York", easternAt(7)), 7);
  });

  /**
   * A runtime that cannot resolve the zone should post the board at a
   * defensible-but-possibly-wrong hour, which somebody can see and correct,
   * rather than never posting it. Same direction `insideWorkingHours` fails.
   */
  test("an unusable zone falls back rather than throwing", () => {
    assert.equal(dateIn("Mars/Olympus", Date.parse("2026-03-02T12:00:00Z")), "2026-03-02");
    assert.equal(hourIn("Mars/Olympus", Date.parse("2026-03-02T12:00:00Z")), 12);
  });
});

describe("what is open", () => {
  test("is the three driven statuses, and carries the three fields", async () => {
    await seed("1");
    await seed("2", { status: "RESOLVED" });
    await seed("3");
    await close("3");
    await db.withWrite((d) => {
      d.prepare(
        "INSERT INTO incident_wait (incidentId, waitingFor, startedAt) VALUES ('1','a merge',1)",
      ).run();
    });

    const rows = openBoard(db);

    assert.deepEqual(
      rows.map((r) => r.incidentId),
      ["1", "2"],
    );
    assert.equal(rows[0].waitingFor, "a merge");
    assert.equal(rows[1].waitingFor, null);
    assert.equal(rows[0].summary, "what 1 is");
  });

  test("the fallback title is the incident's first signal", async () => {
    await seed("1", { summary: null });
    await db.withWrite((d) => {
      d.prepare(
        `INSERT INTO signal (id, source, sourceId, kind, title, body, openedAt, incidentId)
         VALUES ('s-2','grafana','b','alert','second',' ',2,'1'),
                ('s-1','grafana','a','alert','first',' ',1,'1')`,
      ).run();
    });

    assert.equal(openBoard(db)[0].firstSignalTitle, "first");
  });
});

// ---------------------------------------------------------------------------

describe("the first sight of a board", () => {
  /**
   * A container started at nine in the morning has not missed the seven
   * o'clock board, and a board that was already empty before we looked never
   * became clear. Firing either on the first tick is how an in-memory
   * schedule behaves, and every merge to ops main restarts this container.
   */
  test("posts nothing, whatever it finds", async () => {
    await seed("1");
    const morning = harness(easternAt(9));

    await morning.sweep();

    assert.deepEqual(morning.posts, []);
  });

  test("uses up the day when it starts after the hour", async () => {
    await seed("1");
    await harness(easternAt(9)).sweep();

    const later = harness(easternAt(17));
    await later.sweep();

    assert.deepEqual(later.posts, [], "the board is tomorrow's, not this afternoon's");
  });

  test("leaves the day open when it starts before the hour", async () => {
    await seed("1");
    await harness(easternAt(6)).sweep();

    const morning = harness(easternAt(7));
    await morning.sweep();

    assert.equal(morning.posts.length, 1);
    assert.match(morning.posts[0], /1 open/);
  });

  test("an already-empty board is not announced as having become clear", async () => {
    const boot = harness(easternAt(9));
    await boot.sweep();

    const later = harness(easternAt(9) + 60 * 60 * 1000);
    await later.sweep();

    assert.deepEqual(later.posts, []);
  });
});

describe("the daily post", () => {
  const settle = async (at: number) => {
    await harness(at).sweep();
  };

  test("goes out once, at the first tick past the hour", async () => {
    await seed("1");
    await settle(easternAt(6));

    const first = harness(easternAt(7));
    await first.sweep();
    const second = harness(easternAt(7) + 30_000);
    await second.sweep();

    assert.equal(first.posts.length, 1);
    assert.deepEqual(second.posts, [], "a tick is not a second board");
  });

  test("does not go out before the hour", async () => {
    await seed("1");
    await settle(easternAt(3));

    const early = harness(easternAt(6, 3));
    await early.sweep();

    assert.deepEqual(early.posts, []);
  });

  /**
   * A daily all-clear is a message people learn to skim, and a message
   * people skim is one they skim on the morning it matters.
   */
  test("a quiet morning says nothing at all", async () => {
    await settle(easternAt(6));

    const morning = harness(easternAt(7));
    await morning.sweep();

    assert.deepEqual(morning.posts, []);
  });

  test("but the quiet morning still uses up the day", async () => {
    await settle(easternAt(6));
    await harness(easternAt(7)).sweep();
    await seed("1");

    const afternoon = harness(easternAt(15));
    await afternoon.sweep();

    assert.deepEqual(
      afternoon.posts,
      [],
      "an incident opening at three gets a thread, not a board",
    );
  });

  test("the next day gets its own", async () => {
    await seed("1");
    await settle(easternAt(6));
    await harness(easternAt(7)).sweep();

    const tomorrow = harness(easternAt(7, 3));
    await tomorrow.sweep();

    assert.equal(tomorrow.posts.length, 1);
  });

  /**
   * The marker is a date in the board's zone, not a timestamp, and this is
   * the reason. Every merge to ops main restarts this container, so the
   * process that posted the board is routinely not the one that has to
   * remember it did.
   */
  test("a restart in the same day does not post it twice", async () => {
    await seed("1");
    await settle(easternAt(6));
    await harness(easternAt(7)).sweep();

    // A restart loses every in-memory schedule. The row is all that is left.
    const afterRestart = harness(easternAt(7) + 45 * 60 * 1000);
    await afterRestart.sweep();

    assert.deepEqual(afterRestart.posts, []);
  });
});

describe("the all-clear", () => {
  const SETTLE = 10 * 60 * 1000;

  /** Boots with something open, so the transition to empty is witnessed. */
  const watching = async (at: number) => {
    await seed("1");
    await harness(at).sweep();
  };

  test("waits for the board to stay empty", async () => {
    const opened = easternAt(9);
    await watching(opened);
    await close("1");

    const closing = harness(opened + 60_000);
    await closing.sweep();
    assert.deepEqual(closing.posts, [], "not on the close itself");

    // The tick that noticed the board was empty cannot announce it whatever
    // the settle period says, so the period only starts doing work here: a
    // second empty tick, still inside it.
    const waiting = harness(opened + 60_000 + SETTLE / 2);
    await waiting.sweep();
    assert.deepEqual(waiting.posts, [], "nor on the next tick, still inside the period");

    const settled = harness(opened + 60_000 + SETTLE);
    await settled.sweep();
    assert.equal(settled.posts.length, 1);
    assert.match(settled.posts[0], /board is clear/);
  });

  /**
   * The board empties, an alert lands ninety seconds later, it empties
   * again. Fired on the close event, the message goes out every time and
   * stops meaning anything.
   */
  test("does not fire when the board refills inside the settle period", async () => {
    const opened = easternAt(9);
    await watching(opened);
    await close("1");
    await harness(opened + 60_000).sweep();

    await seed("2");
    const refilled = harness(opened + 120_000);
    await refilled.sweep();

    await close("2");
    const again = harness(opened + 180_000);
    await again.sweep();
    assert.deepEqual(again.posts, [], "the clock restarted with the refill");

    const settled = harness(opened + 180_000 + SETTLE);
    await settled.sweep();
    assert.equal(settled.posts.length, 1, "and runs out once it stays empty");
  });

  test("is said once, not on every tick of a quiet week", async () => {
    const opened = easternAt(9);
    await watching(opened);
    await close("1");
    await harness(opened + 1000).sweep();
    await harness(opened + 1000 + SETTLE).sweep();

    const later = harness(opened + 1000 + SETTLE + 30_000);
    await later.sweep();

    assert.deepEqual(later.posts, []);
  });

  test("a new incident arms it again", async () => {
    const opened = easternAt(9);
    await watching(opened);
    await close("1");
    await harness(opened + 1000).sweep();
    await harness(opened + 1000 + SETTLE).sweep();

    await seed("2");
    await harness(opened + 2 * SETTLE).sweep();
    await close("2");
    await harness(opened + 3 * SETTLE).sweep();

    const settled = harness(opened + 4 * SETTLE);
    await settled.sweep();
    assert.equal(settled.posts.length, 1);
  });

  /**
   * "Clear" is zero open incidents, full stop. An incident parked on a
   * person for a week keeps the board non-empty, which is the point of a
   * board.
   */
  test("an incident waiting on a person is still open", async () => {
    const opened = easternAt(9);
    await watching(opened);
    await db.withWrite((d) => {
      d.prepare(
        "INSERT INTO incident_wait (incidentId, waitingFor, startedAt) VALUES ('1','somebody to merge it',1)",
      ).run();
    });

    const later = harness(opened + 4 * SETTLE);
    await later.sweep();

    assert.deepEqual(later.posts, []);
  });
});

describe("thread headers", () => {
  test("go above the original message, never instead of it", async () => {
    await seed("1", { summary: "Loki reads rejected" });
    await openThread("1", "400.0", "*Incident 1 opened*\nmemory above 90%");

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.equal(sweep.edits.length, 1);
    assert.equal(sweep.edits[0].ts, "400.0");
    assert.match(sweep.edits[0].text, /^\*Incident 1 · Investigating\*/);
    assert.ok(
      sweep.edits[0].text.endsWith("*Incident 1 opened*\nmemory above 90%"),
      sweep.edits[0].text,
    );
  });

  /**
   * chat.update replaces the whole message. An incident whose opening was
   * never recorded -- every incident opened before this shipped -- would
   * have its alert text deleted by a header written without it, and that is
   * not recoverable where a missing header merely looks unfinished.
   */
  test("an incident with no recorded opening is left alone", async () => {
    await seed("1");
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET slackThreadTs = '400.0' WHERE id = '1'").run();
    });

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.deepEqual(sweep.edits, []);
  });

  test("are not rewritten when nothing about them changed", async () => {
    await seed("1");
    await openThread("1", "400.0");
    await harness(easternAt(9)).sweep();

    const again = harness(easternAt(9) + 30_000);
    await again.sweep();

    assert.deepEqual(again.edits, []);
  });

  test("follow the status", async () => {
    await seed("1");
    await openThread("1", "400.0");
    await harness(easternAt(9)).sweep();
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET status = 'FIXING' WHERE id = '1'").run();
    });

    const after = harness(easternAt(9) + 30_000);
    await after.sweep();

    assert.equal(after.edits.length, 1);
    assert.match(after.edits[0].text, /Fixing/);
  });

  test("follow the summary", async () => {
    await seed("1", { summary: "memory alert" });
    await openThread("1", "400.0");
    await harness(easternAt(9)).sweep();
    await db.withWrite((d) => {
      d.prepare(
        "UPDATE incident SET summary = 'Loki reads rejected' WHERE id = '1'",
      ).run();
    });

    const after = harness(easternAt(9) + 30_000);
    await after.sweep();

    assert.match(after.edits[0].text, /Loki reads rejected/);
  });

  /**
   * One failed edit is one thread with a stale header. Letting it stop the
   * sweep would make it every thread, plus the morning board and the
   * all-clear.
   */
  test("one thread that will not take an edit does not stop the others", async () => {
    await seed("1");
    await openThread("1", "400.0");
    await seed("2");
    await openThread("2", "500.0");

    const edited: string[] = [];
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      await sweepBoard({
        db,
        post: () => Promise.resolve({ ts: "x" }),
        update: (_channel, ts, _text) => {
          if (ts === "400.0") return Promise.reject(new Error("slack: ratelimited"));
          edited.push(ts);
          return Promise.resolve();
        },
        channel: CHANNEL,
        now: () => easternAt(9),
      });
    } finally {
      console.error = original;
    }

    assert.deepEqual(edited, ["500.0"]);
    assert.ok(errors.some((line) => line.includes("header_update_failed")), errors.join("\n"));
  });

  test("a failed edit is retried, because it was never recorded as written", async () => {
    await seed("1");
    await openThread("1", "400.0");

    let attempts = 0;
    const update = (_channel: string, _ts: string, _text: string) => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("slack: ratelimited"))
        : Promise.resolve();
    };
    const run = (at: number) =>
      sweepBoard({
        db,
        post: () => Promise.resolve({ ts: "x" }),
        update,
        channel: CHANNEL,
        now: () => at,
      });

    const original = console.error;
    console.error = () => undefined;
    try {
      await run(easternAt(9));
    } finally {
      console.error = original;
    }
    await run(easternAt(9) + 30_000);

    assert.equal(attempts, 2);
  });

  test("a closed incident's header stops being maintained", async () => {
    await seed("1");
    await openThread("1", "400.0");
    await harness(easternAt(9)).sweep();
    await close("1");

    const after = harness(easternAt(9) + 30_000);
    await after.sweep();

    assert.deepEqual(after.edits, []);
  });
});
