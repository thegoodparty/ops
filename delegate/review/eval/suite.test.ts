import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isCacheable } from "./cache";
import { defineReplaySuite } from "./suite";
import type { Result } from "./replay";

const complete: Result = {
  caseId: "a", repo: "test/repo", prNumber: 1, headSha: "h", variant: "v",
  output: { status: "complete", findings: [], summary: "done" }, costUsd: 1, wallTimeMs: 1,
};

test("the suites resume independently and replays write only their numbered slot", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "replay-suite-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  mkdirSync(join(out, "a"));
  const failed = { ...complete, output: { status: "failed", reason: "gave up" } };
  writeFileSync(join(out, "a", "run-4.json"), JSON.stringify(complete));
  writeFileSync(join(out, "a", "run-5.json"), JSON.stringify(failed));
  writeFileSync(join(out, "a", "run-6.json"), "{");

  const collect = (canReuse: (result: Result) => boolean, force = false) => {
    const registered = new Map<string, () => unknown>();
    const register = (name: string, run: () => unknown) => registered.set(name, run);
    defineReplaySuite({
      name: "probe", cases: ["a"], id: (c) => c, out, replays: 3, fromRun: 4,
      canReuse, force, replay: async () => complete,
    }, { describe: (_name, run) => run(), it: Object.assign(register, { concurrent: register }) });
    return registered;
  };

  const expected = collect(isCacheable);
  assert.deepEqual([...expected.keys()], ["a run 5", "a run 6"]);
  assert.deepEqual([...collect(() => true).keys()], ["a run 6"]);
  assert.deepEqual([...collect(() => true, true).keys()], ["a run 4", "a run 5", "a run 6"]);
  await expected.get("a run 5")!();
  assert.deepEqual(JSON.parse(readFileSync(join(out, "a", "run-5.json"), "utf-8")), complete);
  assert.equal(readFileSync(join(out, "a", "run-6.json"), "utf-8"), "{");
});
