import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import {
  backfillSpentBudgets,
  escalatedWithin,
  graceTurnsFor,
  INCIDENT_AGENT_MAX_TURNS,
  reconcileTurns,
  shouldAnnounceExhaustion,
  spendOf,
  TURN_BUDGET_GRACE_TURNS,
  turnBudgetBrief,
  turnBudgetMessage,
  turnBudgetPark,
  type TurnBudgetState,
  type TurnSpend,
} from "./budget";
import type { BugbossHarness, ConversationId, EntryRecord } from "./harness";

const noSpend: TurnSpend = {
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  costUsd: 0,
  modelId: null,
};

const state = (over: Partial<TurnBudgetState> = {}): TurnBudgetState => ({
  used: 200,
  max: 200,
  graceTurns: 10,
  escalated: false,
  spentAtLaunch: false,
  usage: noSpend,
  ...over,
});

test("the incident agent's turn budget is 300", () => {
  assert.equal(INCIDENT_AGENT_MAX_TURNS, 300);
});

test("a budget smaller than the grace window still gets turns to work in", () => {
  // `TURN_BUDGET_GRACE_TURNS` is a constant and the budget is settable, so
  // the two can be configured into nonsense. Unclamped, BUGBOSS_MAX_TURNS=10
  // puts the soft edge at turn 0 and the agent is told to wrap up before it
  // has done anything, with nine turns left unused.
  assert.equal(graceTurnsFor(10), 5, "half the budget, not all of it");
  assert.equal(graceTurnsFor(2), 1, "one turn of work and one of grace");
  assert.equal(graceTurnsFor(1), 1, "never zero");
  assert.equal(graceTurnsFor(300), TURN_BUDGET_GRACE_TURNS);
});

test("the brief quotes the grace that was given, not the constant", () => {
  assert.match(turnBudgetBrief(state({ max: 10, used: 10, graceTurns: 5 })), /did not escalate in the 5 I was asked to/);
});

test("the announcement is suppressed only when the agent already made it", () => {
  assert.equal(shouldAnnounceExhaustion(state()), true);
  assert.equal(shouldAnnounceExhaustion(state({ escalated: true })), false);
  // Deliberately still announced: a launch that begins over budget is stopped
  // before its first request elsewhere, not muffled here.
  assert.equal(shouldAnnounceExhaustion(state({ used: 201 })), true);
});

test("an exhausted run parks on a wait a reply cannot lift", () => {
  // `liftsOnReply` defaults to true, which is right for a wait on a person
  // and wrong for this one. Without the argument a reply wakes the incident,
  // the relaunched agent is over budget before it starts, and every comment
  // on the thread becomes a page.
  const park = turnBudgetPark(state());
  assert.equal(park.liftsOnReply, false);
  assert.equal(park.waitingFor, "a person to decide what happens next; the 200-turn budget is spent");
});

test("the brief does not promise that replying will continue the work", () => {
  const brief = turnBudgetBrief(state());
  assert.match(brief, /raise the turn budget, which resumes it on the next deploy, or pick it up themselves/);
  assert.match(brief, /neither a reply in the thread nor a message to me will restart it/);
  assert.doesNotMatch(brief, /nothing will relaunch into the same exhausted budget/);
  assert.doesNotMatch(brief, /wakes it/);
});

test("the escalation brief names the spend and never states the price as a fact", () => {
  const brief = turnBudgetBrief(
    state({
      usage: {
        tokensIn: 1_000_000,
        tokensOut: 200_000,
        cacheRead: 3_000_000,
        cacheWrite: 400_000,
        cacheWrite1h: 0,
        costUsd: 42.71,
        modelId: "us.anthropic.claude-opus-5",
      },
    }),
  );
  assert.match(brief, /200 turns on us\.anthropic\.claude-opus-5 · 4\.6M tokens/);
  assert.match(brief, /Estimated cost \$42\.71/);
  assert.match(brief, /An estimate, not an invoiced figure/);
});

test("a brief for an already-spent budget does not contradict its own numbers", () => {
  const brief = turnBudgetBrief(state({ used: 266, max: 200, spentAtLaunch: true }));
  assert.match(brief, /already spent when this launch started/);
  assert.match(brief, /266 turns have gone into it across every launch/);
  assert.doesNotMatch(brief, /I used all 200 turns/);
});

test("a run the provider priced at nothing says so rather than reporting it free", () => {
  const brief = turnBudgetBrief(state({ used: 5, max: 5, graceTurns: 1 }));
  assert.match(brief, /No cost estimate: the provider reported no prices/);
  assert.doesNotMatch(brief, /\$0\.00/);
});

test("the steer says the budget does not come back, because a restart looks like one that would", () => {
  const message = turnBudgetMessage(state({ used: 190 }));
  assert.match(message, /190 of the 200 turns/);
  assert.match(message, /across every launch/);
  assert.match(message, /calling escalate/);
  assert.match(message, /A restart does not give the turns back/);
});

test("the spend is every bucket, named for the model that wrote the most", () => {
  const bucket = (input: number, output: number, total: number) => ({
    input,
    output,
    cacheRead: 300,
    cacheWrite: 40,
    cacheWrite1h: 40,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  });
  const spend = spendOf({
    models: {
      "amazon-bedrock/us.anthropic.claude-opus-5": bucket(100, 900, 2),
      "amazon-bedrock/us.anthropic.claude-haiku-4-5": bucket(50, 100, 0.25),
    },
    // The goal evaluator's spend, reported by the gate tools.
    tools: { report_root_cause: bucket(10, 5, 0.25) },
  });
  assert.equal(spend.tokensIn, 160);
  assert.equal(spend.tokensOut, 1005);
  assert.equal(spend.cacheRead, 900);
  assert.equal(spend.cacheWrite1h, 120);
  assert.equal(spend.costUsd, 2.5);
  assert.equal(spend.modelId, "us.anthropic.claude-opus-5", "the cheaper evaluator never names the row");
});

const assistant = (id: number): EntryRecord =>
  ({ id, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [] }] }) as unknown as EntryRecord;
const escalation = (id: number, isError = false): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolName: "escalate", isError, content: [] }],
  }) as unknown as EntryRecord;

test("an escalation inside the grace counts, and a refused or an old one does not", () => {
  assert.equal(escalatedWithin([assistant(1), escalation(2), assistant(3)], 2), true);
  // `isError` is the whole difference: a refused escalation told nobody.
  assert.equal(escalatedWithin([assistant(1), escalation(2, true), assistant(3)], 2), false);
  assert.equal(
    escalatedWithin([assistant(1), escalation(2), assistant(3), assistant(4), assistant(5)], 2),
    false,
    "one from before the grace began was not an answer to the steer",
  );
});

test("the boot reconcile rewrites turnsUsed from the transcript, and only for open incidents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bugboss-budget-"));
  const s3 = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
      }
      return {};
    },
  } as unknown as S3Client;
  const db = await Db.open({ path: join(dir, "db.sqlite"), bucket: "t", key: "k", s3 });
  try {
    await db.withWrite((w) => {
      const insert = w.prepare(
        "INSERT INTO incident (id, status, firstSignalAt, conversationId, turnsUsed, mergedInto) VALUES (?, ?, 0, ?, ?, ?)",
      );
      insert.run("1", "FIXING", 11, 40, null);
      insert.run("2", "INVESTIGATING", 12, 3, null);
      insert.run("3", "MERGED", 13, 0, "1");
      insert.run("4", "INVESTIGATING", null, 9, null);
    });
    const counts: Record<number, number> = { 11: 41, 12: 3, 13: 99 };
    const harness = {
      countTurns: async (id: ConversationId) => counts[id as number],
    } as unknown as BugbossHarness;

    assert.equal(await reconcileTurns({ db, harness }), 1);
    assert.equal(await reconcileTurns({ db, harness }), 0, "absolute, so a second pass changes nothing");
    const turns = Object.fromEntries(
      db.query<{ id: string; turnsUsed: number }>("SELECT id, turnsUsed FROM incident ORDER BY id").map((r) => [r.id, r.turnsUsed]),
    );
    assert.deepEqual(turns, { 1: 41, 2: 3, 3: 0, 4: 9 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cutover backfill keeps an incident parked on a spent budget parked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bugboss-budget-"));
  const s3 = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        throw Object.assign(new Error("no such key"), { name: "NoSuchKey" });
      }
      return {};
    },
  } as unknown as S3Client;
  const db = await Db.open({ path: join(dir, "db.sqlite"), bucket: "t", key: "k", s3 });
  try {
    await db.withWrite((w) => {
      const incident = w.prepare(
        "INSERT INTO incident (id, status, firstSignalAt, conversationId, turnsUsed) VALUES (?, 'FIXING', 0, ?, ?)",
      );
      const wait = w.prepare(
        "INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt) VALUES (?, ?, NULL, ?, 1)",
      );
      incident.run("old-spent", null, 0);
      wait.run("old-spent", turnBudgetPark(state({ max: 200 })).waitingFor, 0);
      incident.run("old-person", null, 0);
      wait.run("old-person", "someone to confirm the rollback", 1);
      incident.run("new-spent", 21, 7);
      wait.run("new-spent", turnBudgetPark(state({ max: 300 })).waitingFor, 0);
    });

    assert.equal(await backfillSpentBudgets(db), 1);
    assert.equal(await backfillSpentBudgets(db), 0, "once: the row no longer reads as uncounted");
    const turns = Object.fromEntries(
      db.query<{ id: string; turnsUsed: number }>("SELECT id, turnsUsed FROM incident").map((r) => [r.id, r.turnsUsed]),
    );
    assert.deepEqual(turns, { "old-spent": 200, "old-person": 0, "new-spent": 7 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
