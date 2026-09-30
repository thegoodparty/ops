import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import {
  BOARD_TIME_ZONE,
  MAX_HEADER_UPDATES_PER_TICK,
  boardOnRequest,
  dateIn,
  hourIn,
  openBoard,
  sweepBoard,
} from ".";
import { DEFAULT_WORKING_HOURS } from "../agent/tools";
import { GRAFANA_SOURCE, META_PREFIX } from "../ingress/grafana";
import { HUMAN_SOURCE, SLACK_CHANNEL_LABEL, SLACK_MESSAGE_TS_LABEL } from "../ingress/human";
import { signalOrigin, type SignalOriginRef } from "../ingress/link";
import { STATUS_FACTS_SQL, renderStatusCard, type StatusFacts } from "../slack/status";

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

/** The workspace permalink shape, without Slack. */
const linker = {
  permalink: async (ts: string, channel?: string) =>
    `https://goodparty.slack.com/archives/${channel}/p${ts.replace(".", "")}`,
};

/** What the composition root hands the sweep: the first signal's origin. */
const origin = async (incidentId: string): Promise<SignalOriginRef | null> => {
  const first = db.get<{ source: string; labels: string }>(
    "SELECT source, labels FROM signal WHERE incidentId = ? ORDER BY openedAt, id LIMIT 1",
    [incidentId],
  );
  return first
    ? signalOrigin({ source: first.source, labels: JSON.parse(first.labels) }, linker)
    : null;
};

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
        origin,
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
    d.prepare("DELETE FROM pending_wait").run();
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

// The top-level message of incident 92 as it was, verbatim from prod: the
// header, then the whole Grafana alert, then the footer.
const OLD_TOP_LEVEL = [
  "*Incident 92 · FIXING* · Loki query rejections on gp-api",
  "_Waiting on nobody_",
  "",
  "*Incident 92 opened*",
  "[PROD] Loki query rejections",
  "&lt;https://goodparty.grafana.net/d/abc|dashboard&gt; is **null**",
  "<!subteam^S0ROTATION> please look",
  "values: B=1, C=1",
  "started: 2026-09-29T14:02:00Z",
  "ended: 0001-01-01T00:00:00Z",
  "alert: https://goodparty.grafana.net/alerting/grafana/abc/view",
  "silence: https://goodparty.grafana.net/alerting/silence/new?matcher=alertname%3Dx",
  "grafana: https://goodparty.grafana.net",
  "_1 signal · <https://goodparty.grafana.net/alerting/grafana/abc/view|a Grafana alert> · an agent is investigating · nobody is being paged_",
].join("\n");

/** What the old message pasted and the new one must never carry. */
const PASTED = [/\*\*null\*\*/, /subteam/, /values:/, /started:/, /ended:/, /silence/, /grafana:/, /signal ·/, /paged/, /an agent is investigating/, /Waiting on/];

const GENERATOR = "https://goodparty.grafana.net/alerting/grafana/abc/view";
const SILENCE = "https://goodparty.grafana.net/alerting/silence/new?matcher=alertname%3Dx";

const grafanaSignal = (incidentId: string, title = "[PROD] Loki query rejections") =>
  db.withWrite((d) => {
    d.prepare(
      `INSERT INTO signal (id, source, sourceId, kind, title, body, labels, openedAt, incidentId)
       VALUES (?, ?, ?, 'alert', ?, ?, ?, 1, ?)`,
    ).run(
      `s-${incidentId}`,
      GRAFANA_SOURCE,
      `fp-${incidentId}`,
      title,
      OLD_TOP_LEVEL.split("\n").slice(4, 13).join("\n"),
      // As ingress stored labels before silence links were dropped.
      JSON.stringify({
        alertname: "GpApiLokiRejections",
        alert_slug: "loki-query-rejections",
        endpoint: "/v1/campaigns/mine",
        status_code: "502",
        [`${META_PREFIX}generator_url`]: GENERATOR,
        [`${META_PREFIX}silence_url`]: SILENCE,
        [`${META_PREFIX}external_url`]: "https://goodparty.grafana.net",
      }),
      incidentId,
    );
  });

const humanSignal = (incidentId: string) =>
  db.withWrite((d) => {
    d.prepare(
      `INSERT INTO signal (id, source, sourceId, kind, title, body, labels, openedAt, incidentId)
       VALUES (?, ?, ?, 'bug_report', ?, ?, ?, 1, ?)`,
    ).run(
      `s-${incidentId}`,
      HUMAN_SOURCE,
      "C0DEVALERTS:1727700000.123456",
      "voter density queries are failing",
      "voter density queries are failing in prod. Can you open an incident?",
      JSON.stringify({
        [SLACK_CHANNEL_LABEL]: "C0DEVALERTS",
        [SLACK_MESSAGE_TS_LABEL]: "1727700000.123456",
      }),
      incidentId,
    );
  });

const pendingWait = (incidentId: string, waitingFor: string | null) =>
  db.withWrite((d) => {
    d.prepare(
      "INSERT INTO pending_wait (incidentId, command, waitingFor, startedAt) VALUES (?, 'gh pr view 2240 --json state', ?, 1)",
    ).run(incidentId, waitingFor);
  });

const lastHeader = (incidentId: string) =>
  db.get<{ header: string | null }>(
    "SELECT header FROM incident_thread WHERE incidentId = ?",
    [incidentId],
  )?.header;

describe("thread headers", () => {
  test("an old thread is rewritten once to the number, the title and the alert's link", async () => {
    await seed("92", { status: "FIXING", summary: "Loki query rejections on gp-api" });
    await grafanaSignal("92");
    await openThread("92", "400.0", OLD_TOP_LEVEL);
    // The premise: what is up there now is the whole pasted alert.
    for (const pasted of PASTED) assert.match(OLD_TOP_LEVEL, pasted);

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.deepEqual(sweep.posts, [], "an edit, never a second post");
    assert.equal(sweep.edits.length, 1);
    assert.equal(sweep.edits[0].ts, "400.0");
    assert.equal(
      sweep.edits[0].text,
      [
        "*Incident 92* · Loki query rejections on gp-api",
        "*Status*: Investigating → *Fixing* → Resolved → Closed",
        `<${GENERATOR}|original alert>`,
      ].join("\n"),
    );

    const again = harness(easternAt(9) + 30_000);
    await again.sweep();
    assert.deepEqual(again.edits, [], "once, not every tick");
  });

  test("not blocked: the title, the status and the link, and nothing else", async () => {
    await seed("1", { summary: "Loki reads rejected" });
    await grafanaSignal("1");
    await openThread("1", "400.0");

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.deepEqual(sweep.edits[0].text.split("\n"), [
      "*Incident 1* · Loki reads rejected",
      "*Status*: *Investigating* → Fixing → Resolved → Closed",
      `<${GENERATOR}|original alert>`,
    ]);
    assert.doesNotMatch(sweep.edits[0].text, /Needs a human|nobody/);
  });

  test("nothing in the header comes from the pasted alert text", async () => {
    await seed("1", { summary: null });
    await grafanaSignal("1");
    await openThread("1", "400.0");
    const body = db.get<{ body: string }>("SELECT body FROM signal WHERE incidentId = '1'")?.body ?? "";
    // The premise: the signal the agent reads still carries all of it.
    for (const pasted of [/\*\*null\*\*/, /subteam/, /values:/, /ended:/]) assert.match(body, pasted);

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    const header = sweep.edits[0].text;
    for (const pasted of PASTED) assert.doesNotMatch(header, pasted);
    for (const line of body.split("\n").slice(1)) {
      assert.ok(!header.includes(line), `pasted: ${line}`);
    }
    // The title is the signal's own, which is not the body.
    assert.match(header, /^\*Incident 1\* · \[PROD\] Loki query rejections$/m);
  });

  test("no alert text or label reaches the header: only the title, the link label and the blocked line", async () => {
    await seed("1", { status: "FIXING", summary: "gp-api pool saturated" });
    await grafanaSignal("1");
    await openThread("1", "400.0", OLD_TOP_LEVEL);
    await pendingWait("1", "someone to merge omni#2240");
    const signal = db.get<{ title: string; body: string; labels: string }>(
      "SELECT title, body, labels FROM signal WHERE incidentId = '1'",
    );
    assert.ok(signal);
    const labels = JSON.parse(signal.labels) as Record<string, string>;
    // The premise: the signal has plenty that could have leaked.
    assert.ok(Object.keys(labels).length >= 6);
    assert.match(signal.body, /values: B=1, C=1/);

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    const header = sweep.edits[0].text;
    assert.deepEqual(header.split("\n"), [
      "*Incident 1* · gp-api pool saturated",
      "*Status*: Investigating → *Fixing* → Resolved → Closed",
      `<${GENERATOR}|original alert>`,
      "*Needs a human to merge omni#2240*",
    ]);
    // With the one link taken out, nothing of the signal is left in it.
    const rest = header.replace(`<${GENERATOR}|original alert>`, "");
    assert.ok(!rest.includes(signal.title), "not the alert's title");
    for (const line of signal.body.split("\n")) {
      assert.ok(!rest.includes(line.trim()), `pasted: ${line}`);
    }
    for (const [key, value] of Object.entries(labels)) {
      assert.ok(!rest.includes(value), `label ${key}: ${value}`);
    }
  });

  test("a Grafana incident links to the alert and never to a silence", async () => {
    await seed("1");
    await grafanaSignal("1");
    await openThread("1", "400.0");
    const labels = db.get<{ labels: string }>("SELECT labels FROM signal WHERE incidentId = '1'")?.labels ?? "";
    assert.ok(labels.includes(SILENCE), "premise: the signal still carries a silence link");

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.ok(sweep.edits[0].text.includes(`<${GENERATOR}|`), sweep.edits[0].text);
    assert.doesNotMatch(sweep.edits[0].text, /silence/);
    assert.equal(sweep.edits[0].text.match(/<https?:/g)?.length, 1, "one link");
  });

  test("a human report links to the Slack message it came from", async () => {
    await seed("1");
    await humanSignal("1");
    await openThread("1", "400.0");

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.equal(
      sweep.edits[0].text.split("\n")[2],
      "<https://goodparty.slack.com/archives/C0DEVALERTS/p1727700000123456|original report>",
    );
  });

  test("blocked on a merge shows the line, and it goes when the wait clears", async () => {
    await seed("1", { status: "FIXING", summary: "gp-api pool saturated" });
    await grafanaSignal("1");
    await openThread("1", "400.0");
    await harness(easternAt(9)).sweep();
    assert.equal(lastHeader("1")?.split("\n").length, 3, "premise: three lines before the wait");

    await pendingWait("1", "someone to merge omni#2240");
    const blocked = harness(easternAt(9) + 30_000);
    await blocked.sweep();
    assert.equal(blocked.edits.length, 1);
    const lines = blocked.edits[0].text.split("\n");
    assert.equal(lines.length, 4);
    assert.equal(lines[3], "*Needs a human to merge omni#2240*");

    await db.withWrite((d) => {
      d.prepare("DELETE FROM pending_wait WHERE incidentId = '1'").run();
    });
    const cleared = harness(easternAt(9) + 60_000);
    await cleared.sweep();
    assert.equal(cleared.edits.length, 1);
    assert.equal(cleared.edits[0].text.split("\n").length, 3);
    assert.doesNotMatch(cleared.edits[0].text, /Needs a human/);
  });

  test("parked on a spent budget asks a human to decide", async () => {
    await seed("1");
    await grafanaSignal("1");
    await openThread("1", "400.0");
    await db.withWrite((d) => {
      d.prepare(
        `INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES ('1', 'a person to decide what happens next; the 200-turn budget is spent', NULL, 0, 1)`,
      ).run();
    });

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.equal(sweep.edits[0].text.split("\n")[3], "*Needs a human to decide what happens next*");
  });

  test("the title follows the agent's summary", async () => {
    await seed("1", { summary: null });
    await grafanaSignal("1");
    await openThread("1", "400.0");
    await harness(easternAt(9)).sweep();
    assert.match(lastHeader("1") ?? "", /\[PROD\] Loki query rejections/, "premise: the signal's title first");

    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET summary = 'Loki reads rejected by the ruler' WHERE id = '1'").run();
    });
    const after = harness(easternAt(9) + 30_000);
    await after.sweep();

    assert.equal(after.edits.length, 1);
    assert.match(after.edits[0].text, /^\*Incident 1\* · Loki reads rejected by the ruler\n/);
  });

  test("the status line follows the state, in place", async () => {
    await seed("1");
    await grafanaSignal("1");
    await openThread("1", "400.0");
    await harness(easternAt(9)).sweep();
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET status = 'FIXING' WHERE id = '1'").run();
    });

    const after = harness(easternAt(9) + 30_000);
    await after.sweep();

    assert.equal(after.edits.length, 1);
    assert.equal(after.edits[0].ts, "400.0");
    assert.deepEqual(after.posts, []);
    assert.equal(after.edits[0].text.split("\n")[1], "*Status*: Investigating → *Fixing* → Resolved → Closed");
  });

  test("a merged incident names the incident it went into", async () => {
    await seed("7");
    await seed("1");
    await openThread("1", "400.0");
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET status = 'MERGED', mergedInto = '7' WHERE id = '1'").run();
    });

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.equal(sweep.edits[0].text.split("\n")[1], "*Status*: *Merged* into incident 7");
  });

  test("an open incident whose thread predates the record still gets a header", async () => {
    await seed("1");
    await grafanaSignal("1");
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET slackThreadTs = '400.0' WHERE id = '1'").run();
    });

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.equal(sweep.edits.length, 1);
    assert.match(sweep.edits[0].text, /^\*Incident 1\*/);
  });

  test("a closed incident whose thread predates the record is left alone", async () => {
    await seed("1");
    await grafanaSignal("1");
    await close("1");
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
        origin,
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
        origin,
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

  test("the origin is asked for once, not every tick", async () => {
    await seed("1");
    await humanSignal("1");
    await openThread("1", "400.0");
    let asked = 0;
    const run = (at: number) =>
      sweepBoard({
        db,
        post: () => Promise.resolve({ ts: "x" }),
        update: () => Promise.resolve(),
        origin: (id) => {
          asked += 1;
          return origin(id);
        },
        channel: CHANNEL,
        now: () => at,
      });

    await run(easternAt(9));
    await run(easternAt(9) + 30_000);
    assert.equal(asked, 1);
  });

  test("a permalink lookup that fails is retried on the next tick, not kept as no link", async () => {
    await seed("1");
    await humanSignal("1");
    await openThread("1", "400.0");
    let calls = 0;
    const run = (at: number) =>
      sweepBoard({
        db,
        post: () => Promise.resolve({ ts: "x" }),
        update: (_c, _ts, text) => {
          edits.push(text);
          return Promise.resolve();
        },
        origin: (id) => {
          calls += 1;
          return calls === 1 ? Promise.reject(new Error("slack: ratelimited")) : origin(id);
        },
        channel: CHANNEL,
        now: () => at,
      });
    const edits: string[] = [];

    const original = console.error;
    const errors: string[] = [];
    console.error = (line: unknown) => errors.push(String(line));
    try {
      await run(easternAt(9));
    } finally {
      console.error = original;
    }
    assert.ok(errors.some((line) => line.includes("header_origin_failed")), "premise: the first lookup failed");
    const kept = db.get<{ originLabel: string | null }>("SELECT originLabel FROM incident_thread WHERE incidentId = '1'");
    assert.equal(kept?.originLabel, null, "nothing was kept from the failure");

    await run(easternAt(9) + 30_000);
    assert.equal(calls, 2);
    assert.match(edits.at(-1) ?? "", /\|original report>$/);
  });

  test("an incident with no signal yet gets its link once one is attached", async () => {
    await seed("1");
    await openThread("1", "400.0");
    const first = harness(easternAt(9));
    await first.sweep();
    assert.equal(first.edits[0].text.split("\n").length, 2, "premise: no signal, so no link line");

    await grafanaSignal("1");
    const later = harness(easternAt(9) + 30_000);
    await later.sweep();
    assert.equal(later.edits.length, 1);
    assert.equal(later.edits[0].text.split("\n")[2], `<${GENERATOR}|original alert>`);
  });

  test("a tick that has used up its edits still resolves origins for the rows after them", async () => {
    for (let i = 1; i <= MAX_HEADER_UPDATES_PER_TICK; i++) {
      await seed(String(i));
      await openThread(String(i), `${i}00.0`);
      await db.withWrite((d) => {
        d.prepare("UPDATE incident_thread SET originLabel = 'original alert' WHERE incidentId = ?").run(String(i));
      });
    }
    const late = String(MAX_HEADER_UPDATES_PER_TICK + 1);
    await seed(late);
    await grafanaSignal(late);
    await openThread(late, "900.0");

    const sweep = harness(easternAt(9));
    await sweep.sweep();

    assert.equal(sweep.edits.length, MAX_HEADER_UPDATES_PER_TICK, "premise: the edits ran out first");
    assert.ok(!sweep.edits.some((e) => e.ts === "900.0"));
    const kept = db.get<{ originUrl: string | null }>("SELECT originUrl FROM incident_thread WHERE incidentId = ?", [late]);
    assert.equal(kept?.originUrl, GENERATOR);
  });

  /**
   * A closed incident loses the line asking for a person, since nobody is
   * needed any more, and is then never touched again.
   */
  test("a closed incident is finalised once, then left alone", async () => {
    await seed("1");
    await openThread("1", "400.0");
    await pendingWait("1", "someone to merge omni#2240");
    await harness(easternAt(9)).sweep();
    assert.match(lastHeader("1") ?? "", /Needs a human/, "premise: it was blocked");
    await close("1");

    const closing = harness(easternAt(9) + 30_000);
    await closing.sweep();
    assert.equal(closing.edits.length, 1);
    assert.doesNotMatch(closing.edits[0].text, /Needs a human/);
    assert.match(closing.edits[0].text, /→ \*Closed\*$/m);

    const after = harness(easternAt(9) + 60_000);
    await after.sweep();
    assert.deepEqual(after.edits, [], "nothing changes again, so nothing is written");
  });

  /**
   * `chat.update` is Tier 3 and shares the workspace budget with every post.
   * The first sweep after this ships finds every open thread stale at once,
   * which is the burst the cap exists for; a header is a reference rather
   * than a notification, so the rest waiting a tick costs nobody anything.
   */
  test("a burst of stale headers is spread across ticks", async () => {
    for (let i = 1; i <= MAX_HEADER_UPDATES_PER_TICK + 3; i++) {
      await seed(String(i));
      await openThread(String(i), `${i}00.0`);
    }

    const first = harness(easternAt(9));
    await first.sweep();
    assert.equal(first.edits.length, MAX_HEADER_UPDATES_PER_TICK);

    const second = harness(easternAt(9) + 30_000);
    await second.sweep();
    assert.equal(second.edits.length, 3, "the rest arrive on the next tick");

    const third = harness(easternAt(9) + 60_000);
    await third.sweep();
    assert.deepEqual(third.edits, [], "and then it is quiet again");
  });

  /**
   * The per-thread failure path is covered above. This is the one outside
   * it: the write that records a successful edit. A header sweep that
   * throws must not cost the morning board or the all-clear, which are the
   * two things here that are notifications rather than references.
   */
  test("a header sweep that throws outright does not cost the daily board", async () => {
    await seed("1");
    await openThread("1", "400.0");
    await harness(easternAt(6)).sweep();
    // Something for the sweep to have to write, so it reaches the record.
    await db.withWrite((d) => {
      d.prepare("UPDATE incident SET summary = 'moved on' WHERE id = '1'").run();
    });

    // Reads work; every write is refused, the way a halted Db behaves.
    const halted = {
      query: (sql: string, params?: unknown[]) => db.query(sql, params),
      get: (sql: string, params?: unknown[]) => db.get(sql, params),
      withWrite: () => Promise.reject(new Error("writes halted: snapshot PUT failed")),
    } as unknown as Db;

    const posts: string[] = [];
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      await sweepBoard({
        db: halted,
        post: (text) => {
          posts.push(text);
          return Promise.resolve({ ts: "x" });
        },
        update: () => Promise.resolve(),
        origin,
        channel: CHANNEL,
        now: () => easternAt(7),
      }).catch(() => undefined);
    } finally {
      console.error = original;
    }

    assert.equal(posts.length, 1, "the morning board still went out");
    assert.match(posts[0], /1 open/);
    assert.ok(
      errors.some((line) => line.includes("header_sweep_failed")),
      errors.join("\n"),
    );
  });
});

describe("a monitor wait on the board and the card", () => {
  // Verbatim from the prod board on 2026-09-30, where it was printed as the
  // thing incident 82 was waiting on.
  const PROD_COMMAND =
    "cd /work/82/omni && S1=$(gh pr view 2189 --json state -q .state); S2=$(gh pr view 2195 --json state -q .state); echo \"$S1 $S2\" | grep -qE 'MERGED|CLOSED'";

  const wait = (id: string, waitingFor: string | null) =>
    db.withWrite((d) => {
      d.prepare(
        "INSERT INTO pending_wait (incidentId, command, waitingFor, startedAt) VALUES (?, ?, ?, ?)",
      ).run(id, PROD_COMMAND, waitingFor, 1);
    });

  const card = (id: string): string => {
    const facts = db.get<StatusFacts>(`${STATUS_FACTS_SQL} WHERE i.id = ?`, [id]);
    assert.ok(facts);
    return renderStatusCard({
      facts,
      usersImpacted: null,
      prUrls: [],
      now: "summary unavailable",
      lastActivityAt: null,
      spend: null,
      at: 2,
    });
  };

  test("shows what the agent said it waits for, never the command", async () => {
    await seed("82");
    await wait("82", "someone to merge omni#2189 or #2195");
    const stored = db.get<{ command: string }>("SELECT command FROM pending_wait WHERE incidentId = '82'");
    assert.equal(stored?.command, PROD_COMMAND, "premise: the command is on the row the board reads");

    const board = boardOnRequest(db);
    assert.match(board, /waiting on someone to merge omni#2189 or #2195/);
    assert.match(card("82"), /\*Waiting on:\* someone to merge omni#2189 or #2195/);
    for (const text of [board, card("82")]) {
      assert.ok(!text.includes("gh pr view"), text);
      assert.ok(!text.includes("/work/82"), text);
    }
  });

  test("a wait recorded before it had a label shows the fallback", async () => {
    await seed("82");
    await wait("82", null);
    assert.match(boardOnRequest(db), /waiting on a check the agent is running/);
    assert.match(card("82"), /\*Waiting on:\* a check the agent is running/);
    assert.ok(!boardOnRequest(db).includes("gh pr view"));
  });
});
