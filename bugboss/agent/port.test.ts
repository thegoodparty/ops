// The agent's port onto everything that is not ToolApi: the Boss's inbox, the
// outstanding-question marker and the wait marker monitor keeps while it is
// blocked on a person.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";
import Database from "better-sqlite3";

import { unseenByBoss } from "../boss/inbox";
import { Db } from "../db";
import type { BossInboxItem } from "../types";
import { createAgentPort, type AgentPort } from "./port";
import type { SqlRequestPort } from "./sql";

const INCIDENT = "inc-7";
const OTHER = "inc-8";

const emptyS3 = (): S3Client =>
  ({
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
      }
      return {};
    },
  }) as unknown as S3Client;

let dir: string;
let dbPath: string;
let db: Db;
let clock = 1_000_000;
const wakes: { incidentId: string; unseen: BossInboxItem[] }[] = [];
const escalationsNoted: string[] = [];

const noSql: SqlRequestPort = {
  createSqlRequest: async () => ({ status: 500, text: "unused" }),
  getSqlRequest: async () => ({ status: 500, text: "unused" }),
};

const portFor = (incidentId: string): AgentPort =>
  createAgentPort({
    db,
    incidentId,
    wakeBoss: (woken) => {
      const reader = new Database(dbPath, { readonly: true });
      try {
        wakes.push({ incidentId: woken, unseen: unseenByBoss(reader, woken) });
      } finally {
        reader.close();
      }
    },
    noteEscalated: (noted) => {
      escalationsNoted.push(noted);
    },
    sql: noSql,
    now: () => clock,
  });

let port: AgentPort;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-port-"));
  dbPath = join(dir, "test.db");
  db = await Db.open({ path: dbPath, bucket: "bugboss-test", key: "db/test.db", s3: emptyS3() });
  await db.withWrite((w) => {
    const insert = w.prepare(
      "INSERT INTO incident (id, status, firstSignalAt) VALUES (?, 'INVESTIGATING', ?)",
    );
    insert.run(INCIDENT, clock);
    insert.run(OTHER, clock);
  });
  port = portFor(INCIDENT);
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const inboxOf = (incidentId: string) =>
  db.query<BossInboxItem>(
    "SELECT id, incidentId, kind, text, createdAt, seenAt FROM boss_inbox WHERE incidentId = ? ORDER BY id",
    [incidentId],
  );

const clearInbox = () =>
  db.withWrite((w) => {
    w.prepare("DELETE FROM boss_inbox").run();
  });

test("a replayed question keeps its watermark, a different one gets a new one", async () => {
  clock = 1_000_000;
  const first = await port.recordPending("Can someone merge the PR?");
  assert.equal(first.askedAt, 1_000_000);

  clock = 2_000_000;
  const replayed = await port.recordPending("Can someone merge the PR?");
  assert.equal(replayed.askedAt, 1_000_000, "a replay resumes the original wait");

  // A run killed mid-wait leaves the marker behind. The next, different
  // question has to replace it, or it is never posted and the agent waits out
  // its whole timeout on an answer to something nobody was asked.
  clock = 3_000_000;
  const different = await port.recordPending("Should I roll back the deploy?");
  assert.deepEqual(different, { message: "Should I roll back the deploy?", askedAt: 3_000_000 });
  assert.deepEqual(await port.getPending(), {
    message: "Should I roll back the deploy?",
    askedAt: 3_000_000,
  });

  await port.clearPending();
  assert.equal(await port.getPending(), null);
  await assert.rejects(port.recordPending("  "), /message is empty/);
});

test("the Boss is woken only once the row it is woken for is committed", async () => {
  await clearInbox();
  wakes.length = 0;

  await port.tellBoss("question", "Can someone merge the PR?");

  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].incidentId, INCIDENT);
  assert.deepEqual(
    wakes[0].unseen.map((row) => ({ kind: row.kind, text: row.text })),
    [{ kind: "question", text: "Can someone merge the PR?" }],
    "a separate connection already sees the row when the wake fires",
  );
  assert.equal(wakes[0].unseen[0].seenAt, null);
});

test("the agent's own escalation brief tells the dispatcher, and nothing else sent up does", async () => {
  await clearInbox();
  escalationsNoted.length = 0;

  await port.tellBoss("message", "a message", { ownBrief: true });
  await port.tellBoss("question", "a question", { ownBrief: true });
  await port.tellBoss("escalation", "still waiting on a person, 2h");
  assert.deepEqual(
    escalationsNoted,
    [],
    "the premise: a message, a question and a harness rung are not the agent's brief",
  );

  await port.tellBoss("escalation", "needs a person", { ownBrief: true });
  assert.deepEqual(escalationsNoted, [INCIDENT]);
});

test("text reaches the inbox whole, with no length limit", async () => {
  await clearInbox();
  const long = Array.from({ length: 400 }, (_, i) => `- ruled out ${i}`).join("\n");
  assert.ok(long.length > 4_000, "the premise: longer than any Slack budget");

  await port.tellBoss("message", long);
  assert.equal(inboxOf(INCIDENT)[0].text, long);
});

test("a rejected send writes nothing and wakes nobody", async () => {
  await clearInbox();
  wakes.length = 0;

  for (const [kind, text, why] of [
    ["shout", "hello", "a kind the Boss does not know"],
    ["message", "", "empty text"],
    ["message", "   \n ", "whitespace-only text"],
  ] as const) {
    await assert.rejects(port.tellBoss(kind as "message", text), Error, why);
  }

  assert.equal(inboxOf(INCIDENT).length, 0);
  assert.equal(wakes.length, 0);
});

test("an unknown incident is refused, not a row the Boss can never act on", async () => {
  wakes.length = 0;
  await assert.rejects(portFor("inc-missing").tellBoss("message", "hello"), /unknown incident/);
  assert.equal(inboxOf("inc-missing").length, 0);
  assert.equal(wakes.length, 0);
});

test("a port writes only to its own incident's inbox", async () => {
  await clearInbox();
  await portFor(OTHER).tellBoss("escalation", "the other one");
  assert.equal(inboxOf(INCIDENT).length, 0);
  assert.equal(inboxOf(OTHER).length, 1);
});

test("escalations are counted for this incident only, and only since the moment asked", async () => {
  await clearInbox();
  await db.withWrite((w) => {
    const insert = w.prepare(
      "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES (?, ?, ?, ?)",
    );
    insert.run(INCIDENT, "escalation", "first", 1_000);
    insert.run(INCIDENT, "escalation", "second", 2_000);
    insert.run(INCIDENT, "escalation", "third", 3_000);
    insert.run(INCIDENT, "question", "not an escalation", 5_000);
    insert.run(INCIDENT, "message", "not an escalation", 6_000);
    insert.run(OTHER, "escalation", "someone else's", 7_000);
  });

  assert.deepEqual(await port.escalationsSince(0), { count: 3, lastAt: 3_000 });
  assert.deepEqual(await port.escalationsSince(2_000), { count: 2, lastAt: 3_000 }, "since is inclusive");
  assert.deepEqual(await port.escalationsSince(3_001), { count: 0, lastAt: null });
  await assert.rejects(port.escalationsSince(Number.NaN), /epoch millis/);
});

test("an escalation sent through the port is one the count sees", async () => {
  await clearInbox();
  clock = 9_000_000;
  const since = Date.now();
  await port.tellBoss("escalation", "still no answer");
  await port.tellBoss("question", "is anyone there?");

  const counted = await port.escalationsSince(since);
  assert.equal(counted.count, 1);
  assert.ok(counted.lastAt !== null && counted.lastAt >= since);
});

test("a replayed wait keeps its clock and its nudge count", async () => {
  clock = 1_000_000;
  const first = await port.recordWait("gh pr view 2150", "someone to merge omni#2150");
  assert.deepEqual(first, {
    command: "gh pr view 2150",
    startedAt: 1_000_000,
    pings: 0,
    lastPingAt: null,
  });

  clock = 4_600_000;
  const pinged = await port.recordPing();
  assert.equal(pinged.pings, 1);
  assert.equal(pinged.lastPingAt, 4_600_000);

  // The restart. Without this the elapsed clock would start over and the
  // nudge count would be lost, so the resumed agent would nudge again.
  clock = 5_000_000;
  const replayed = await port.recordWait("gh pr view 2150", "someone to merge omni#2150");
  assert.equal(replayed.startedAt, 1_000_000);
  assert.equal(replayed.pings, 1);
  assert.equal(replayed.lastPingAt, 4_600_000);

  // clearWait does not run when a run dies mid-wait, so a marker outlives its
  // wait. A different command is a different wait and inherits neither the
  // clock nor the count.
  clock = 6_000_000;
  const next = await port.recordWait("gh run list --commit abc", "the deploy");
  assert.deepEqual(next, {
    command: "gh run list --commit abc",
    startedAt: 6_000_000,
    pings: 0,
    lastPingAt: null,
  });

  await port.clearWait();
  assert.equal(db.get("SELECT command FROM pending_wait WHERE incidentId = ?", [INCIDENT]), undefined);
});

test("a wait keeps the agent's label, and a replay can reword it without restarting the clock", async () => {
  clock = 1_000_000;
  await port.recordWait("gh pr view 2189", "someone to merge omni#2189");
  clock = 2_000_000;
  await port.recordWait("gh pr view 2189", "someone to merge omni#2189 or #2195");
  assert.deepEqual(
    db.get("SELECT waitingFor, startedAt FROM pending_wait WHERE incidentId = ?", [INCIDENT]),
    { waitingFor: "someone to merge omni#2189 or #2195", startedAt: 1_000_000 },
  );
  await port.clearWait();
});

test("a wait replayed from before the label existed is kept, and keeps any label it had", async () => {
  await port.recordWait("gh pr view 2189", "  ");
  assert.deepEqual(
    db.get("SELECT waitingFor FROM pending_wait WHERE incidentId = ?", [INCIDENT]),
    { waitingFor: null },
    "no label, which the board renders as the fallback",
  );
  await port.recordWait("gh pr view 2189", "someone to merge omni#2189");
  await port.recordWait("gh pr view 2189", null);
  assert.deepEqual(
    db.get("SELECT waitingFor FROM pending_wait WHERE incidentId = ?", [INCIDENT]),
    { waitingFor: "someone to merge omni#2189" },
    "a later unlabelled replay does not erase a label",
  );
  await port.clearWait();
  await assert.rejects(port.recordWait(" ", "x"), /command is empty/);
});

test("counting a nudge against no wait is an error, not a new wait", async () => {
  await assert.rejects(port.recordPing(), /no wait is recorded/);
  assert.equal(
    db.get("SELECT command FROM pending_wait WHERE incidentId = ?", [INCIDENT]),
    undefined,
    "a missing marker is not invented at the moment of the fault",
  );
});

test("the timeline reads back for this incident only, oldest first", async () => {
  await db.withWrite((w) => {
    const insert = w.prepare(
      `INSERT INTO incident_timeline_event (incidentId, kind, occurredAt, recordedAt, summary)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(INCIDENT, "fix_merged", 2_000, 2_500, "merged");
    insert.run(INCIDENT, "first_error", 1_000, 2_600, "first error");
    insert.run(OTHER, "first_error", 500, 600, "someone else's");
  });
  const events = await port.timelineEvents();
  assert.deepEqual(
    events.map((event) => event.summary),
    ["first error", "merged"],
  );
});
