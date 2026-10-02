import assert from "node:assert/strict";
import { test } from "node:test";

import { isStalled } from "./stall";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test("a run with no event and no model call for the idle window is stalled; either one resets it", () => {
  const idle = 15 * MIN;
  const run = { startedAt: NOW - 20 * MIN, lastEventAt: NOW - 16 * MIN, lastRequestAt: NOW - 17 * MIN };
  assert.equal(isStalled(run, NOW, idle), true);
  assert.equal(isStalled({ ...run, lastEventAt: NOW - MIN }, NOW, idle), false);
  assert.equal(isStalled({ ...run, lastRequestAt: NOW - MIN }, NOW, idle), false);
});

test("a run that never called the model counts idle from its start", () => {
  const idle = 15 * MIN;
  assert.equal(isStalled({ startedAt: NOW - 10 * MIN, lastEventAt: NOW - 16 * MIN, lastRequestAt: null }, NOW, idle), false);
  assert.equal(isStalled({ startedAt: NOW - 16 * MIN, lastEventAt: NOW - 16 * MIN, lastRequestAt: null }, NOW, idle), true);
});
