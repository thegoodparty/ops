import assert from "node:assert/strict";
import { test } from "node:test";

import { addSpend, spendOf, ZERO_SPEND } from "./metrics";
import type { Trace, Turn, Usage } from "./trace";

const usage = (over: Partial<Usage>): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ...over,
});

const turn = (index: number, model: string, over: Partial<Usage>, cacheTtl: Turn["cacheTtl"] = "5m"): Turn => ({
  index,
  id: `t${index}`,
  startedAt: Date.UTC(2026, 8, 29, 10, 0, index),
  model,
  cacheTtl,
  stopReason: "end_turn",
  error: null,
  usage: usage(over),
  toolCalls: [],
  results: [],
  launch: 0,
});

const trace: Trace = {
  id: "proxy",
  startedAt: Date.UTC(2026, 8, 29, 10),
  model: "us.anthropic.claude-opus-5",
  systemPrompt: "",
  toolNames: [],
  turns: [
    turn(1, "us.anthropic.claude-opus-5", { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }),
    turn(2, "some-new-model", { input: 10 }),
  ],
  exits: [],
  launches: 1,
};

test("spend is tokens by class, priced from the eval's own table", () => {
  const spend = spendOf([trace]);
  assert.equal(spend.turns, 2);
  assert.equal(spend.input, 1_000_010);
  assert.equal(spend.cacheWrite1h, 1_000_000);
  // 5.50 input + 2.75 output + 1.10 cache read + 11.00 1h write
  assert.equal(spend.usd.toFixed(2), "20.35");
  assert.deepEqual(spend.unpriced, ["some-new-model"]);
});

test("a 1h turn whose write is not split out is priced as a 1h write", () => {
  const spend = spendOf([{ ...trace, turns: [turn(1, "us.anthropic.claude-opus-5", { cacheWrite: 1_000_000 }, "1h")] }]);
  assert.equal(spend.cacheWrite1h, 1_000_000);
  assert.equal(spend.usd.toFixed(2), "11.00");
});

test("spends add", () => {
  const spend = spendOf([trace]);
  assert.equal(addSpend(ZERO_SPEND, spend).usd, spend.usd);
  assert.equal(addSpend(spend, spend).turns, 4);
});
