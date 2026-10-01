// What an incident row says its agent spent, driven through the composition
// root: a real Db over the in-memory S3, session files written where the
// child would sync them, and the rollup reached only through the sweeps and
// the child's exit.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { createBugBoss, createMemoryS3, type BugBoss } from "../index";
import { emptyModelUsage } from "../model";
import type { ModelReply } from "../triage";
import type { BugBossConfig } from "../types";

const MODEL = "us.anthropic.claude-opus-5";

interface Turn {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

/** A session file as Pi writes one: a header, then one line per turn. */
const sessionOf = (turns: Turn[]): string =>
  [
    JSON.stringify({ type: "session", version: 3 }),
    ...turns.map((usage) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", model: MODEL, usage: { ...usage, cost: { total: 0 } } },
      }),
    ),
    "",
  ].join("\n");

const FIRST: Turn = { input: 2, output: 150, cacheRead: 0, cacheWrite: 80_000, cacheWrite1h: 80_000 };
const SECOND: Turn = { input: 3, output: 400, cacheRead: 80_000, cacheWrite: 1_200, cacheWrite1h: 0 };
const LAST: Turn = { input: 2, output: 27, cacheRead: 0, cacheWrite: 367_433, cacheWrite1h: 367_433 };

const config = (path: string): BugBossConfig => ({
  env: "prod",
  s3Bucket: "bugboss-test",
  dbPath: path,
  slackChannelId: "C0TEST",
  testDatabase: { state: "absent" },
  dispatcher: {
    maxConcurrentAgents: 15,
    tickSeconds: 30,
    agentTimeoutSeconds: 1800,
    agentMaxTurns: 200,
    maxAttempts: 3,
    staleAfterSeconds: 86_400,
  },
  prodCriticalSlugs: [],
});

const idleModel = {
  complete: async (): Promise<ModelReply> => ({ text: "", toolCalls: [], usage: emptyModelUsage() }),
};

const idleSlack = {
  post: async () => ({ ts: "1.0" }),
  update: async () => {},
  react: async () => {},
  replies: async () => [],
};

let dir: string;
let s3: S3Client;
let boss: BugBoss;
/** Resolves the running fake agent, which is what makes its child exit. */
let finish: () => void = () => {};
let uploads = 0;

const putSession = (incidentId: string, turns: Turn[]) =>
  s3.send(
    new PutObjectCommand({
      Bucket: "bugboss-test",
      Key: `sessions/incident/${incidentId}/session.jsonl`,
      Body: sessionOf(turns),
    }),
  );

interface SpendRow {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  modelId: string | null;
}

const spendOf = (id: string): SpendRow | undefined =>
  boss.db.get<SpendRow>(
    `SELECT tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h, modelId
       FROM incident WHERE id = ?`,
    [id],
  );

const summed = (turns: Turn[]) => ({
  tokensIn: turns.reduce((n, t) => n + t.input, 0),
  tokensOut: turns.reduce((n, t) => n + t.output, 0),
  cacheRead: turns.reduce((n, t) => n + t.cacheRead, 0),
  cacheWrite: turns.reduce((n, t) => n + t.cacheWrite, 0),
  cacheWrite1h: turns.reduce((n, t) => n + t.cacheWrite1h, 0),
});

const assertSpend = (id: string, turns: Turn[], message: string) => {
  const row = spendOf(id);
  assert.ok(row, `incident ${id} exists`);
  const { modelId, ...tokens } = row;
  assert.deepEqual(tokens, summed(turns), message);
  assert.equal(modelId, MODEL);
};

const insertIncident = (id: string, fields: { status?: string; mergedInto?: string } = {}) =>
  boss.db.withWrite((w) => {
    w.prepare(
      `INSERT INTO incident (id, status, mergedInto, firstSignalAt, attempts)
       VALUES (?, ?, ?, ?, 0)`,
    ).run(id, fields.status ?? "FIXING", fields.mergedInto ?? null, Date.now());
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-usage-"));
  s3 = createMemoryS3();
  boss = await createBugBoss({
    config: config(join(dir, "usage.db")),
    model: idleModel as never,
    slack: idleSlack as never,
    // Stays running until the test lets it go, which is the state an
    // incident spends almost all its life in and the one the old rollup
    // never looked at.
    gh: null,
    spawnAgent: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    s3,
    secrets: { slackBotUserId: "B0BOSS" },
    fileUploader: {
      upload: async () => {
        uploads += 1;
      },
    },
    insecureTestVerifiers: { grafana: () => {}, slack: () => {} },
  });
});

after(() => {
  finish();
  boss?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a running agent's spend is on its row after a turn, before it exits", async () => {
  await insertIncident("10");
  const tick = await boss.dispatcher.tick();
  assert.deepEqual(
    tick.started.map((a) => a.incidentId),
    ["10"],
    "premise: the agent is running",
  );

  await putSession("10", [FIRST]);
  await boss.sweepUsage();
  assertSpend("10", [FIRST], "one turn in, the open incident shows it");

  await putSession("10", [FIRST, SECOND]);
  await boss.sweepUsage();
  assertSpend("10", [FIRST, SECOND], "the next turn lands on the next tick");

  // The last turn syncs and the child exits. Nothing ticks after it: the exit
  // rollup alone has to carry the turn the old code lost.
  await putSession("10", [FIRST, SECOND, LAST]);
  finish();
  await tick.settled;
  // The exit rollup is fire-and-forget from the spawn's `.finally`, so wait
  // for its write rather than guessing how long it takes.
  const deadline = Date.now() + 5_000;
  while (spendOf("10")?.cacheWrite !== summed([FIRST, SECOND, LAST]).cacheWrite && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertSpend("10", [FIRST, SECOND, LAST], "the run's last turn is counted");
});

test("recomputing is idempotent and never goes backwards", async () => {
  const before = spendOf("10");
  assert.equal(await boss.reconcileUsage(), 0, "a second pass over the same files writes nothing");
  assert.equal(await boss.sweepUsage(), 0);
  assert.deepEqual(spendOf("10"), before, "nothing was added twice");

  // An older copy of the file, as a read that lost a race would see it.
  await putSession("10", [FIRST]);
  await boss.reconcileUsage();
  assert.deepEqual(spendOf("10"), before, "a smaller total never replaces a larger one");
  await putSession("10", [FIRST, SECOND, LAST]);
});

test("boot backfills a row the old rollup left at zero, merged or not", async () => {
  // Incident 95's shape: merged away after its own agent ran, row at zero.
  await insertIncident("20");
  await insertIncident("21", { status: "MERGED", mergedInto: "20" });
  await putSession("20", [FIRST, SECOND]);
  await putSession("21", [LAST]);
  assert.equal(spendOf("21")?.tokensIn, 0, "premise: the merged row shows nothing");

  await boss.reconcileUsage();

  assertSpend("21", [LAST], "the merged incident keeps its own spend on its own row");
  assertSpend("20", [FIRST, SECOND], "and the absorbing one keeps only its own");
});

test("a row whose session is gone keeps the tokens it has", async () => {
  await insertIncident("30");
  const { tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h } = summed([SECOND]);
  await boss.db.withWrite((w) => {
    w.prepare(
      `UPDATE incident SET tokensIn = ?, tokensOut = ?, cacheRead = ?, cacheWrite = ?,
         cacheWrite1h = ?, modelId = ? WHERE id = '30'`,
    ).run(tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h, MODEL);
  });

  await boss.reconcileUsage();

  assertSpend("30", [SECOND], "no file is not a zero");
});

test("a closing report rolls up the incidents merged into it before pricing them", async () => {
  const closedAt = Date.now() - 600_000;
  await boss.db.withWrite((w) => {
    w.prepare(
      `INSERT INTO incident (id, status, slackThreadTs, firstSignalAt, resolvedAt, closedAt,
         postmortem, attempts)
       VALUES ('40', 'CLOSED', 'thread-40', ?, ?, ?, 'The pool saturated.', 1)`,
    ).run(closedAt - 3_600_000, closedAt - 60_000, closedAt);
  });
  await insertIncident("41", { status: "MERGED", mergedInto: "40" });
  await putSession("40", [SECOND]);
  await putSession("41", [LAST]);
  assert.equal(spendOf("41")?.cacheWrite, 0, "premise: a deploy killed 41's agent before any rollup");

  const before = uploads;
  await boss.sweepReports();
  assert.equal(uploads, before + 1, "premise: the report was published");

  assertSpend("41", [LAST], "the merged row was rolled up by the report that adds it");
});
