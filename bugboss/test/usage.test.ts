// What an incident row says its agent spent, driven through the composition
// root: a real Db over the in-memory S3, a real harness over MemoryStorage,
// and the roll-up reached only through the sweeps and the closing report.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createBugBoss, createMemoryS3, type BugBoss } from "../index";
import { loadPi, type Api, type ConversationId, type Model, type Usage } from "../agent/harness";
import { emptyModelUsage } from "../model";
import type { ModelReply } from "../triage";
import type { BugBossConfig } from "../types";

const AGENT = "opus";
const GOAL = "haiku";

interface Turn {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

const FIRST: Turn = { input: 2, output: 150, cacheRead: 0, cacheWrite: 80_000, cacheWrite1h: 80_000 };
const SECOND: Turn = { input: 3, output: 400, cacheRead: 80_000, cacheWrite: 1_200, cacheWrite1h: 0 };
const LAST: Turn = { input: 2, output: 27, cacheRead: 0, cacheWrite: 367_433, cacheWrite1h: 367_433 };
/** The goal evaluator: a cheaper model, a lot of input, little output. */
const VERDICT: Turn = { input: 9_000, output: 60, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

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
  contextWindow: 1_000_000,
  complete: async (): Promise<ModelReply> => ({ text: "", toolCalls: [], usage: emptyModelUsage() }),
};

const idleSlack = {
  post: async () => ({ ts: "1.0" }),
  update: async () => {},
  react: async () => {},
  replies: async () => [],
  permalink: async () => "https://slack.example/p1",
};

let dir: string;
let boss: BugBoss;
let provider = "";
let uploads = 0;

const asUsage = (turn: Turn): Usage => ({
  ...turn,
  totalTokens: turn.input + turn.output + turn.cacheRead + turn.cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * Writes a conversation's usage document whole, the way the harness's own
 * commit leaves it after these responses. Exact numbers, which a faux
 * provider's estimate cannot give.
 */
const setUsage = async (
  conversationId: ConversationId,
  models: Record<string, Turn[]>,
  tools: Record<string, Turn[]> = {},
) => {
  const { durable } = await loadPi();
  const conversation = await boss.agents.conversation(conversationId);
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(durable.UsageDoc, conversationId);
    const sum = (turns: Turn[]) => asUsage(sumTurns(turns));
    for (const key of Object.keys(doc.models)) delete doc.models[key];
    for (const key of Object.keys(doc.tools)) delete doc.tools[key];
    for (const [model, turns] of Object.entries(models)) doc.models[`${provider}/${model}`] = sum(turns);
    for (const [tool, turns] of Object.entries(tools)) doc.tools[tool] = sum(turns);
  }, boss.agents.context);
};

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

const sumTurns = (turns: Turn[]): Turn => {
  const total = (pick: (t: Turn) => number) => turns.reduce((n, t) => n + pick(t), 0);
  return {
    input: total((t) => t.input),
    output: total((t) => t.output),
    cacheRead: total((t) => t.cacheRead),
    cacheWrite: total((t) => t.cacheWrite),
    cacheWrite1h: total((t) => t.cacheWrite1h),
  };
};

const summed = (turns: Turn[]): Omit<SpendRow, "modelId"> => {
  const turn = sumTurns(turns);
  return {
    tokensIn: turn.input,
    tokensOut: turn.output,
    cacheRead: turn.cacheRead,
    cacheWrite: turn.cacheWrite,
    cacheWrite1h: turn.cacheWrite1h,
  };
};

const assertSpend = (id: string, turns: Turn[], message: string, modelId = AGENT) => {
  const row = spendOf(id);
  assert.ok(row, `incident ${id} exists`);
  const { modelId: rowModel, ...tokens } = row;
  assert.deepEqual(tokens, summed(turns), message);
  assert.equal(rowModel, modelId);
};

/** An incident with a conversation of its own, as the dispatcher's first launch leaves it. */
const insertIncident = async (
  id: string,
  fields: { status?: string; mergedInto?: string } = {},
): Promise<ConversationId> => {
  const conversation = await boss.agents.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    boss.agents.context,
  );
  await boss.db.withWrite((w) => {
    w.prepare(
      `INSERT INTO incident (id, status, mergedInto, firstSignalAt, attempts, conversationId)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(id, fields.status ?? "FIXING", fields.mergedInto ?? null, Date.now(), conversation.id);
  });
  return conversation.id;
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-usage-"));
  const { durable } = await loadPi();
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { fauxAssistantMessage, fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  const faux = fauxProvider({ models: [{ id: AGENT }, { id: GOAL }] });
  faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("Looking at the pool.")));
  provider = faux.models[0].provider;
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = faux.getModel(AGENT) as Model<Api>;

  boss = await createBugBoss({
    config: config(join(dir, "usage.db")),
    model: idleModel as never,
    slack: idleSlack as never,
    models: { models, agent, boss: agent },
    harnessStorage: new durable.MemoryStorage(),
    gh: null,
    s3: createMemoryS3(),
    secrets: { slackBotUserId: "B0BOSS" },
    fileUploader: {
      upload: async () => {
        uploads += 1;
      },
    },
    insecureTestVerifiers: { grafana: () => {}, slack: () => {} },
  });
});

after(async () => {
  await boss?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a conversation's spend lands on its row, and grows with it", async () => {
  const conversation = await insertIncident("10");

  await setUsage(conversation, { [AGENT]: [FIRST] });
  assert.equal(await boss.reconcileUsage(), 1);
  assertSpend("10", [FIRST], "one response in, the open incident shows it");

  await setUsage(conversation, { [AGENT]: [FIRST, SECOND, LAST] });
  await boss.reconcileUsage();
  assertSpend("10", [FIRST, SECOND, LAST], "the next responses land on the next pass");
});

test("recomputing is idempotent and never goes backwards", async () => {
  const before = spendOf("10");
  assert.equal(await boss.reconcileUsage(), 0, "a second pass over the same usage writes nothing");
  assert.equal(await boss.sweepUsage(), 0, "and nothing is busy, so the tick has nothing to do");
  assert.deepEqual(spendOf("10"), before, "nothing was added twice");

  // An older read of the document, as one that lost a race would see it.
  const conversationId = boss.db.get<{ conversationId: ConversationId }>(
    "SELECT conversationId FROM incident WHERE id = '10'",
  )!.conversationId;
  await setUsage(conversationId, { [AGENT]: [FIRST] });
  await boss.reconcileUsage();
  assert.deepEqual(spendOf("10"), before, "a smaller total never replaces a larger one");
});

test("the evaluator's tokens count, and its cheaper model does not take the row", async () => {
  const conversation = await insertIncident("15");
  await setUsage(
    conversation,
    { [AGENT]: [FIRST, SECOND], [GOAL]: [VERDICT] },
    { report_root_cause: [VERDICT] },
  );

  await boss.reconcileUsage();

  assertSpend(
    "15",
    [FIRST, SECOND, VERDICT, VERDICT],
    "every model bucket and every tool bucket is in the total",
  );
});

test("a row from before the harness keeps the tokens its session file gave it", async () => {
  // The cutover's shape: a row rolled up from a JSONL session, then a fresh
  // conversation whose usage starts at zero.
  const conversation = await insertIncident("30");
  const { tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h } = summed([SECOND, LAST]);
  await boss.db.withWrite((w) => {
    w.prepare(
      `UPDATE incident SET tokensIn = ?, tokensOut = ?, cacheRead = ?, cacheWrite = ?,
         cacheWrite1h = ?, modelId = ? WHERE id = '30'`,
    ).run(tokensIn, tokensOut, cacheRead, cacheWrite, cacheWrite1h, AGENT);
  });
  await setUsage(conversation, { [AGENT]: [FIRST] });

  await boss.reconcileUsage();

  assertSpend("30", [SECOND, LAST], "the fresh conversation's smaller total is not written");
});

test("a row with no conversation is left alone", async () => {
  await boss.db.withWrite((w) => {
    w.prepare(
      `INSERT INTO incident (id, status, firstSignalAt, attempts, tokensIn, modelId)
       VALUES ('35', 'FIXING', ?, 0, 7, ?)`,
    ).run(Date.now(), AGENT);
  });
  await boss.reconcileUsage();
  assert.equal(spendOf("35")?.tokensIn, 7, "no conversation is not a zero");
});

test("a real response's usage is what the row records", async () => {
  // Through the provider and the harness's own commit, rather than a
  // hand-written document: the faux provider reports an estimate, so the
  // assertion is that the row equals the harness, not a number.
  await insertIncident("50");
  const agent = await boss.agents.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider, modelId: AGENT } },
    },
    boss.agents.context,
  );
  await boss.db.withWrite((w) => {
    w.prepare("UPDATE incident SET conversationId = ? WHERE id = '50'").run(agent.id);
  });
  const settled = await (
    await agent.submit({ type: "input", content: "the pool is exhausted" }, boss.agents.context)
  ).wait(boss.agents.context);
  assert.equal(settled.status, "done", "premise: the faux model answered");

  await boss.reconcileUsage();

  const usage = (await boss.agents.usage(agent.id)).models[`${provider}/${AGENT}`];
  assert.ok(usage && usage.input + usage.output > 0, "premise: the response spent something");
  const row = spendOf("50")!;
  assert.equal(row.tokensIn, usage.input);
  assert.equal(row.tokensOut, usage.output);
  assert.equal(row.cacheRead, usage.cacheRead);
  assert.equal(row.cacheWrite, usage.cacheWrite);
  assert.equal(row.modelId, AGENT);
});

test("a closing report rolls up the incidents merged into it before pricing them", async () => {
  const closedAt = Date.now() - 600_000;
  const own = await boss.agents.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    boss.agents.context,
  );
  await boss.db.withWrite((w) => {
    w.prepare(
      `INSERT INTO incident (id, status, slackThreadTs, firstSignalAt, resolvedAt, closedAt,
         postmortem, attempts, conversationId)
       VALUES ('40', 'CLOSED', 'thread-40', ?, ?, ?, 'The pool saturated.', 1, ?)`,
    ).run(closedAt - 3_600_000, closedAt - 60_000, closedAt, own.id);
  });
  const merged = await insertIncident("41", { status: "MERGED", mergedInto: "40" });
  await setUsage(own.id, { [AGENT]: [SECOND] });
  await setUsage(merged, { [AGENT]: [LAST] });
  assert.equal(spendOf("41")?.cacheWrite, 0, "premise: nothing has rolled 41 up yet");

  const before = uploads;
  await boss.sweepReports();
  assert.equal(uploads, before + 1, "premise: the report was published");

  assertSpend("41", [LAST], "the merged row was rolled up by the report that adds it");
  assertSpend("40", [SECOND], "and the absorbing one keeps only its own");
});
