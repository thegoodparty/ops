import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costUsdFor, priceTable, pricedModels } from "./index";
import type { PriceTable } from "./index";

// The price table, which S5 creates because the spend cap cannot fire against an
// empty one.
//
// The property this file exists for is the one the plan states twice: **a missing
// row is a bug in a file this repo tests, not a zero-cost call.** `costUsdFor`
// returns `undefined` rather than `0` for a model it cannot price, and `agent.ts`
// leaves the run's `costUsd` undefined rather than accumulating nothing, so an
// unpriced model shows up as unpriced instead of as free.

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

test("S5 ships the Anthropic rows, and only them", () => {
  // S8 adds Bedrock's and S9 Fireworks'. Every row stays live once added — none
  // supersedes another, because S10 moves only the subagents — so the assertion
  // is about which providers have landed, not about a maximum.
  assert.deepEqual(pricedModels(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("every row is four non-negative numbers, so a rate edit cannot be half-done", () => {
  for (const [id, rates] of Object.entries(priceTable.models)) {
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      assert.equal(typeof rates[field], "number", `${id}.${field}`);
      assert.ok(Number.isFinite(rates[field]), `${id}.${field} is not finite`);
      assert.ok(rates[field] >= 0, `${id}.${field} is negative`);
    }
    // A cache read is never dearer than an uncached read; a cache write can be,
    // which is why only this direction is asserted.
    assert.ok(rates.cacheRead <= rates.input, `${id}: cacheRead above input`);
  }
});

test("a row prices to the dollar, so a factor-of-ten slip fails here", () => {
  assert.equal(costUsdFor("claude-opus-5-5", usage(1_000_000, 0)), priceTable.models["claude-opus-5-5"].input);
  assert.equal(costUsdFor("claude-sonnet-5-5", usage(0, 1_000_000)), priceTable.models["claude-sonnet-5-5"].output);
  // Sonnet is cheaper than Opus on both axes, which is why the two-tier split
  // saves anything: if a row edit reversed that, this fails.
  const opus = priceTable.models["claude-opus-5-5"];
  const sonnet = priceTable.models["claude-sonnet-5-5"];
  assert.ok(sonnet.input < opus.input);
  assert.ok(sonnet.output < opus.output);
});

test("a model with no row is undefined, never zero", () => {
  // The whole point. A cap that reads `$0` can never fire, and a replay whose
  // `costUsd` is 0 while it reported tokens is a failure rather than a win.
  assert.equal(costUsdFor("claude-haiku-9-9", usage(1_000_000, 1_000_000)), undefined);
  assert.equal(costUsdFor("global.anthropic.claude-opus-5-5", usage(1_000_000, 0)), undefined);
});

test("no usage is undefined, which is not the same as no tokens", () => {
  // A run that answered nothing is a gap in the record. Pricing it as $0 would
  // make the gap read as a free run.
  assert.equal(costUsdFor("claude-opus-5-5", undefined), undefined);
  assert.equal(costUsdFor("claude-opus-5-5", usage(0, 0)), 0);
});

test("cache reads and writes are priced at their own rates", () => {
  const rates = priceTable.models["claude-opus-5-5"];
  assert.equal(
    costUsdFor("claude-opus-5-5", usage(0, 0, 1_000_000, 1_000_000)),
    rates.cacheRead + rates.cacheWrite,
  );
});

test("a table passed in is the one used, so a test can pin a rate", () => {
  // The seam `costUsdFor` takes a table for: a test that needs a known rate does
  // not have to write to the shipped file to get one.
  const table: PriceTable = {
    unit: "test",
    models: { m: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 } },
  };
  assert.equal(costUsdFor("m", usage(1_000_000, 0), table), 1);
  assert.equal(costUsdFor("claude-opus-5-5", usage(1_000_000, 0), table), undefined);
});

test("the shipped file says what it is for, so the next provider knows the rule", () => {
  // The rule is the one the credentials follow: the rate lands in repo in the step
  // whose code spends it, before that code spends it. A row added without reading
  // this is how the wrong rate gets in.
  const raw = JSON.parse(readFileSync(join(__dirname, "models.json"), "utf-8")) as PriceTable;
  assert.match(raw.unit, /per 1M tokens/);
  assert.match(String(raw.note), /S8/);
  assert.match(String(raw.note), /S9/);
  // And every row records where its number came from: a rate with no source is a
  // number nobody can check.
  for (const [id, rates] of Object.entries(raw.models)) {
    assert.equal(typeof (rates as { source?: unknown }).source, "string", `${id} has no source`);
  }
});
