import assert from "node:assert/strict";
import { test } from "node:test";

import { fixture, postPrRun, RATES_PER_M } from "./fixtures";
import {
  billedTurns,
  coldCause,
  coldStarts,
  duplicateCalls,
  harness,
  isCold,
  measure,
  milestones,
  phaseOf,
  refusals,
} from "./metrics";
import { deriveRates, PRICE_TABLE, ratesFor } from "./price";
import type { Trace } from "./trace";
import { parsePiSession } from "./adapters/pi-session";

test("a result that starts error: is a refusal even though isError is false", () => {
  const run = postPrRun();
  const refused = run.turns[1].results[0];
  assert.equal(refused.isError, false);
  assert.equal(refused.refused, true);
  assert.equal(run.turns[2].results[0].refused, false);
});

test("the parser links results to calls and counts launches and exits", () => {
  const run = postPrRun();
  assert.equal(run.turns.length, 14);
  assert.equal(run.launches, 4);
  assert.equal(run.exits.length, 1);
  assert.equal(run.turns[10].launch, 1);
  assert.equal(run.turns[11].stopReason, "error");
});

test("rates come back out of the transcripts' own cost fields", () => {
  const { rates } = deriveRates([
    postPrRun(),
    parsePiSession(
      "b",
      fixture()
        .launch(0)
        .turn({ at: 0, read: 0, write: 50_000, api: "bedrock-converse-stream" })
        .jsonl(),
    ),
  ]);
  assert.ok(Math.abs(rates.cacheRead * 1e6 - RATES_PER_M.cacheRead) < 1e-9);
  assert.ok(Math.abs(rates.cacheWrite1h * 1e6 - RATES_PER_M.cacheWrite1h) < 1e-9);
  assert.ok(Math.abs(rates.cacheWrite5m * 1e6 - RATES_PER_M.cacheWrite5m) < 1e-9);
  assert.ok(Math.abs(rates.output * 1e6 - RATES_PER_M.output) < 1e-9);
});

test("a refused report_root_cause does not open the fix phase", () => {
  const run = postPrRun();
  assert.equal(run.turns[1].toolCalls[0].name, "report_root_cause");
  assert.equal(run.turns[1].results[0].refused, true);
  const marks = milestones(run);
  assert.deepEqual(marks, { rootCauseTurn: 3, prOpenTurn: 4 });
  assert.equal(phaseOf(3, marks), "investigate");
  assert.equal(phaseOf(4, marks), "fix");
  assert.equal(phaseOf(5, marks), "post_pr");
});

test("cold starts are attributed to what happened in the gap", () => {
  const run = postPrRun();
  const cold = billedTurns(run).filter((entry) => isCold(entry.turn));
  assert.deepEqual(
    cold.map((entry) => entry.turn.index),
    [1, 6, 11, 13, 14],
  );
  assert.deepEqual(cold.map(coldCause), [
    "session_start",
    "wait_over_ttl",
    "relaunch",
    "relaunch_after_crash_loop",
    "unexplained",
  ]);
});

test("the TTL follows the request path: 10 minutes is over TTL on Converse only", () => {
  const build = (api: "bedrock-invoke-model" | "bedrock-converse-stream") =>
    parsePiSession(
      api,
      fixture()
        .launch(0)
        .turn({ at: 0, read: 0, write: 70_000, api, calls: [{ name: "monitor" }] })
        .turn({ at: 10, read: 0, write: 75_000, api })
        .jsonl(),
    );
  const { rates } = deriveRates([build("bedrock-invoke-model")]);
  const converse = coldStarts(build("bedrock-converse-stream"), rates);
  const invoke = coldStarts(build("bedrock-invoke-model"), rates);
  assert.equal(converse[1].turn, 2);
  assert.equal(invoke[1].turn, 2);
  assert.equal(converse[1].cause, "wait_over_ttl");
  assert.equal(invoke[1].cause, "unexplained");
});

test("refusals of one tool in a row form a loop even with other tools between", () => {
  const run = postPrRun();
  const { rates } = deriveRates([run]);
  const result = refusals(run, rates);
  assert.equal(result.total, 4);
  assert.deepEqual(result.byTool, { report_root_cause: 1, contact_human: 3 });
  assert.equal(result.loops.length, 1);
  assert.deepEqual(result.loops[0].turns, [6, 7, 9]);
});

test("duplicates ignore key order and leave polling tools out", () => {
  const run = parsePiSession(
    "d",
    fixture()
      .launch(0)
      .turn({
        at: 0,
        read: 0,
        write: 1_000,
        calls: [
          { name: "grafana_query_loki_logs", args: { a: 1, b: 2 } },
          { name: "monitor", args: { command: "gh pr checks" } },
        ],
      })
      .turn({
        at: 1,
        read: 1_000,
        write: 100,
        calls: [
          { name: "grafana_query_loki_logs", args: { b: 2, a: 1 } },
          { name: "monitor", args: { command: "gh pr checks" } },
        ],
      })
      .jsonl(),
  );
  assert.deepEqual(duplicateCalls(run), [
    { tool: "grafana_query_loki_logs", turns: [1, 2] },
  ]);
});

test("crash-loop turns are counted as harness, not as agent cost", () => {
  const run = postPrRun();
  const { rates } = deriveRates([run]);
  const result = harness(run, rates);
  assert.equal(result.blockBindingTurns, 1);
  assert.deepEqual(result.crashLoopRelaunchTurns, [13]);
  const card = measure(run, rates);
  assert.equal(card.exits["turn_error (block_binding)"], 1);
  assert.ok(Math.abs(card.recordedUsd - card.repricedUsd) < 1e-9);
});

test("the eval's price table matches the rates the transcripts' cost fields imply", () => {
  const { rates } = deriveRates([postPrRun()]);
  const table = ratesFor("us.anthropic.claude-opus-5");
  assert.ok(Math.abs(rates.cacheRead - table.cacheRead) < 1e-15);
  assert.ok(Math.abs(rates.cacheWrite1h - table.cacheWrite1h) < 1e-15);
  assert.ok(Math.abs(rates.output - table.output) < 1e-15);
  assert.deepEqual(Object.keys(PRICE_TABLE).sort(), ["us.anthropic.claude-opus-5", "us.anthropic.claude-sonnet-5"]);
  assert.throws(() => ratesFor("some-other-model"), /no price/);
});

test("measure runs on a trace built without the Pi adapter", () => {
  const usage = (read: number, write: number) => ({
    input: 2,
    output: 100,
    cacheRead: read,
    cacheWrite: write,
    cacheWrite1h: write,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const trace: Trace = {
    id: "proxy",
    startedAt: 0,
    model: "us.anthropic.claude-opus-5",
    systemPrompt: "",
    toolNames: [],
    exits: [],
    launches: 1,
    turns: [
      { index: 1, id: "r1", startedAt: 0, model: "us.anthropic.claude-opus-5", cacheTtl: "1h", stopReason: "toolUse", error: null, usage: usage(0, 70_000), toolCalls: [{ id: "c1", name: "monitor", args: {} }], results: [{ toolCallId: "c1", toolName: "monitor", text: "ok", isError: false, refused: false }], launch: 0 },
      { index: 2, id: "r2", startedAt: 2 * 3_600_000, model: "us.anthropic.claude-opus-5", cacheTtl: "1h", stopReason: "toolUse", error: null, usage: usage(0, 71_000), toolCalls: [], results: [], launch: 0 },
    ],
  };
  const card = measure(trace, ratesFor(trace.model));
  assert.deepEqual(
    card.cold.map((cold) => cold.cause),
    ["session_start", "wait_over_ttl"],
  );
  assert.ok(card.repricedUsd > 0);
});
