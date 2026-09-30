import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePiSession } from "./adapters/pi-session";
import { addSpend, spendOf, ZERO_SPEND } from "./metrics";

const line = (value: unknown) => JSON.stringify(value);

const session = [
  line({ type: "session", timestamp: "2026-09-29T10:00:00Z" }),
  line({ type: "message", id: "u1", timestamp: "2026-09-29T10:00:00Z", message: { role: "user", content: "go" } }),
  line({
    type: "message",
    id: "a1",
    timestamp: "2026-09-29T10:00:01Z",
    message: {
      role: "assistant",
      model: "us.anthropic.claude-opus-5",
      api: "bedrock-invoke-model",
      content: [],
      usage: { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 },
    },
  }),
  line({
    type: "message",
    id: "a2",
    timestamp: "2026-09-29T10:00:02Z",
    message: { role: "assistant", model: "some-new-model", content: [], usage: { input: 10 } },
  }),
].join("\n");

test("spend is tokens by class, priced from the eval's own table", () => {
  const spend = spendOf([parsePiSession("s", session)]);
  assert.equal(spend.turns, 2);
  assert.equal(spend.input, 1_000_010);
  assert.equal(spend.cacheWrite1h, 1_000_000);
  // 5.50 input + 2.75 output + 1.10 cache read + 11.00 1h write
  assert.equal(spend.usd.toFixed(2), "20.35");
  assert.deepEqual(spend.unpriced, ["some-new-model"]);
});

test("spends add", () => {
  const spend = spendOf([parsePiSession("s", session)]);
  assert.equal(addSpend(ZERO_SPEND, spend).usd, spend.usd);
  assert.equal(addSpend(spend, spend).turns, 4);
});
