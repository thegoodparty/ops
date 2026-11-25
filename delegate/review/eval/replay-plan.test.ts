import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { planReplays, reusableResult } from "./replay-plan";
import type { Result } from "./replay";

const OUT = "/tmp/review-expect";

const complete = (caseId: string): Result => ({
  caseId,
  repo: "thegoodparty/ops",
  prNumber: 1,
  headSha: "h",
  variant: "v",
  output: { status: "complete", findings: [], summary: "done" },
  costUsd: 1,
  wallTimeMs: 1,
});

const errored = (caseId: string): Result => ({
  ...complete(caseId),
  output: null,
  error: "agent error: api_error",
});

const failed = (caseId: string): Result => ({
  ...complete(caseId),
  output: { status: "failed", reason: "gave up" },
});

// Only what the plan needs from a case: its id.
const cases = (...ids: string[]) => ids.map((id) => ({ id }));

test("planReplays schedules every pair when nothing is on disk", () => {
  const plan = planReplays(cases("a", "b"), {
    out: OUT,
    replays: 2,
    id: (c) => c.id,
    read: () => undefined,
  });
  assert.deepEqual(
    plan.pending.map((p) => [p.id, p.run]),
    [
      ["a", 1],
      ["a", 2],
      ["b", 1],
      ["b", 2],
    ],
  );
  assert.equal(plan.reused.length, 0);
  assert.equal(plan.pending[0].resultPath, join(OUT, "a", "run-1.json"));
});

test("planReplays reuses completed results and replays nothing when all are cached", () => {
  const disk = new Map([
    [join(OUT, "a", "run-1.json"), JSON.stringify(complete("a"))],
    [join(OUT, "a", "run-2.json"), JSON.stringify(complete("a"))],
  ]);
  const plan = planReplays(cases("a"), {
    out: OUT,
    replays: 2,
    id: (c) => c.id,
    read: (p) => disk.get(p),
  });
  assert.equal(plan.pending.length, 0);
  assert.deepEqual(plan.reused.map((r) => [r.item.id, r.run]), [
    ["a", 1],
    ["a", 2],
  ]);
});

test("planReplays retries the errored run of two and keeps the completed one", () => {
  const disk = new Map([
    [join(OUT, "a", "run-1.json"), JSON.stringify(complete("a"))],
    [join(OUT, "a", "run-2.json"), JSON.stringify(errored("a"))],
  ]);
  const plan = planReplays(cases("a"), {
    out: OUT,
    replays: 2,
    id: (c) => c.id,
    read: (p) => disk.get(p),
  });
  assert.deepEqual(plan.pending.map((p) => p.run), [2]);
  assert.deepEqual(plan.reused.map((r) => r.run), [1]);
});

test("planReplays retries a review that came back failed, and one it cannot parse", () => {
  const disk = new Map([
    [join(OUT, "a", "run-1.json"), JSON.stringify(failed("a"))],
    [join(OUT, "a", "run-2.json"), "{ not json"],
  ]);
  const plan = planReplays(cases("a"), {
    out: OUT,
    replays: 2,
    id: (c) => c.id,
    read: (p) => disk.get(p),
  });
  assert.deepEqual(plan.pending.map((p) => p.run), [1, 2]);
  assert.equal(plan.reused.length, 0);
});

test("planReplays replays everything with force, cached results included", () => {
  const disk = new Map([
    [join(OUT, "a", "run-1.json"), JSON.stringify(complete("a"))],
    [join(OUT, "a", "run-2.json"), JSON.stringify(complete("a"))],
  ]);
  const plan = planReplays(cases("a"), {
    out: OUT,
    replays: 2,
    force: true,
    id: (c) => c.id,
    read: (p) => disk.get(p),
  });
  assert.deepEqual(plan.pending.map((p) => p.run), [1, 2]);
  assert.equal(plan.reused.length, 0);
});

test("planReplays numbers runs from from-run, so a rerun adds runs instead of replacing them", () => {
  const disk = new Map([
    [join(OUT, "a", "run-1.json"), JSON.stringify(complete("a"))],
    [join(OUT, "a", "run-2.json"), JSON.stringify(complete("a"))],
    [join(OUT, "a", "run-3.json"), JSON.stringify(complete("a"))],
  ]);
  const plan = planReplays(cases("a"), {
    out: OUT,
    replays: 3,
    fromRun: 4,
    id: (c) => c.id,
    read: (p) => disk.get(p),
  });
  assert.deepEqual(plan.pending.map((p) => p.run), [4, 5, 6]);
  assert.deepEqual(
    plan.pending.map((p) => p.resultPath),
    [4, 5, 6].map((run) => join(OUT, "a", `run-${run}.json`)),
  );
  assert.equal(plan.reused.length, 0);
});

test("planReplays refuses a run range that would replay nothing", () => {
  const opts = { out: OUT, id: (c: { id: string }) => c.id, read: () => undefined };
  assert.throws(() => planReplays(cases("a"), { ...opts, replays: 0 }), /positive integer/);
  assert.throws(() => planReplays(cases("a"), { ...opts, replays: 1, fromRun: 0 }), /positive integer/);
});

test("reusableResult keeps only a completed review", () => {
  assert.ok(reusableResult(JSON.stringify(complete("a"))));
  assert.equal(reusableResult(JSON.stringify(errored("a"))), undefined);
  assert.equal(reusableResult(JSON.stringify(failed("a"))), undefined);
  assert.equal(reusableResult("nope"), undefined);
  assert.equal(reusableResult("null"), undefined);
});
