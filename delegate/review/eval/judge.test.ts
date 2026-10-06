import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { judgePair, judgeAll } from "./judge";
import type { JudgeModel, PairVerdict } from "./judge";
import type { Result } from "./replay";
import type { ReviewRecord } from "../schema";

const makeRecord = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  runId: randomUUID(),
  repo: "thegoodparty/ops",
  prNumber: 42,
  baseSha: "aaaaaa",
  headSha: "bbbbbb",
  trigger: "webhook",
  agentVersion: "1.0.0",
  model: "claude-opus-4-6",
  startedAt: "2024-01-01T00:00:00.000Z",
  finishedAt: "2024-01-01T00:01:00.000Z",
  wallTimeMs: 60000,
  costUsd: 0.05,
  bundle: {
    repo: "thegoodparty/ops",
    prNumber: 42,
    baseRef: "develop",
    baseSha: "aaaaaa",
    headSha: "bbbbbb",
    author: "swain",
    title: "feat: add widget",
    body: "Adds a widget component",
    diff: "@@ -1,1 +1,2 @@\n+const x = 1;\n",
    changedFiles: ["src/widget.ts"],
    priorFindings: [],
  },
  output: { status: "complete", findings: [], summary: "LGTM" },
  verdict: "approve",
  action: "approved",
  gates: [],
  findings: [],
  droppedFindings: [],
  ...overrides,
});

const makeResult = (overrides: Partial<Result> = {}): Result => ({
  caseId: randomUUID(),
  repo: "thegoodparty/ops",
  prNumber: 42,
  headSha: "bbbbbb",
  variant: "v1",
  output: { status: "complete", findings: [], summary: "Looks good" },
  costUsd: 0.01,
  wallTimeMs: 100,
  ...overrides,
});

const fakeModel = (
  verdicts: { winner: string; margin: string }[],
): JudgeModel => {
  let call = 0;
  return async () => {
    const verdict = verdicts[Math.min(call++, verdicts.length - 1)];
    return {
      toolInput: {
        winner: verdict.winner,
        margin: verdict.margin,
        deciding_criterion: "false approve",
        rationale: "because reasons",
      },
      stopReason: "tool_use",
      usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
    };
  };
};

const noToolModel: JudgeModel = async () => ({
  toolInput: null,
  stopReason: "end_turn",
  usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
});

test("judgePair picks a when a consistently beats b across order-swapped passes", async () => {
  const record = makeRecord();
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  // Pass 0 (a=1,b=2): output_1 → a. Pass 1 (a=2,b=1): output_2 → a. Alternating.
  const model = fakeModel([
    { winner: "output_1", margin: "better" },
    { winner: "output_2", margin: "better" },
    { winner: "output_1", margin: "better" },
    { winner: "output_2", margin: "better" },
  ]);

  const verdict = await judgePair({ record, a, b, model, passes: 4 });
  assert.equal(verdict.caseId, record.runId);
  assert.equal(verdict.winner, "a");
  assert.equal(verdict.passes.length, 4);
});

test("judgePair maps output_1 to b when b is first (odd passes)", async () => {
  const record = makeRecord();
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  const model = fakeModel([
    { winner: "output_2", margin: "better" },
    { winner: "output_1", margin: "better" },
    { winner: "output_2", margin: "better" },
    { winner: "output_1", margin: "better" },
  ]);

  const verdict = await judgePair({ record, a, b, model, passes: 4 });
  assert.equal(verdict.winner, "b");
});

test("judgePair resolves tie when judge votes tie every pass", async () => {
  const record = makeRecord();
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  const model = fakeModel([{ winner: "tie", margin: "tie" }]);
  const verdict = await judgePair({ record, a, b, model, passes: 4 });
  assert.equal(verdict.winner, "tie");
});

test("judgePair resolves unstable when a and b wins are evenly split", async () => {
  const record = makeRecord();
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  const model = fakeModel([
    { winner: "output_1", margin: "better" },
    { winner: "output_1", margin: "better" },
    { winner: "output_2", margin: "better" },
    { winner: "output_2", margin: "better" },
  ]);

  const verdict = await judgePair({ record, a, b, model, passes: 4 });
  assert.equal(verdict.winner, "unstable");
});

test("judgePair resolves unstable when a side only ties the tie count", async () => {
  const record = makeRecord();
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  // passes alternate order: a is output_1 on even passes, output_2 on odd
  const model = fakeModel([
    { winner: "output_1", margin: "better" },
    { winner: "tie", margin: "tie" },
    { winner: "output_1", margin: "better" },
    { winner: "tie", margin: "tie" },
  ]);

  const verdict = await judgePair({ record, a, b, model, passes: 4 });
  assert.equal(verdict.winner, "unstable");
});

test("judgePair handles model returning no tool call", async () => {
  const record = makeRecord();
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  const verdict = await judgePair({ record, a, b, model: noToolModel, passes: 2 });
  assert.equal(verdict.winner, "tie");
  assert.equal(verdict.passes.length, 2);
  assert.ok(verdict.passes[0].rationale.includes("no tool call"));
});

test("judgePair stores pass-level details including order and margin", async () => {
  const record = makeRecord();
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  const model = fakeModel([{ winner: "output_1", margin: "much_better" }]);
  const verdict = await judgePair({ record, a, b, model, passes: 2 });
  assert.equal(verdict.passes[0].order, "a=1,b=2");
  assert.equal(verdict.passes[1].order, "a=2,b=1");
});

test("judgePair renders failed result as FAILED text", async () => {
  const record = makeRecord();
  const a = makeResult({
    caseId: record.runId,
    output: null,
    error: "checkout failed: repo not found",
  });
  const b = makeResult({ caseId: record.runId });

  const calls: string[] = [];
  const model: JudgeModel = async (req) => {
    calls.push(req.prompt);
    return {
      toolInput: { winner: "output_2", margin: "better", deciding_criterion: "c1", rationale: "r" },
      stopReason: "tool_use",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    };
  };

  const verdict = await judgePair({ record, a, b, model, passes: 1 });
  assert.ok(calls[0].includes("FAILED: checkout failed"), "prompt should contain FAILED marker");
  assert.equal(verdict.winner, "b");
});

test("judgeAll skips records missing from either side", async () => {
  const record1 = makeRecord();
  const record2 = makeRecord();
  const aResults = [makeResult({ caseId: record1.runId })];
  const bResults = [makeResult({ caseId: record1.runId }), makeResult({ caseId: record2.runId })];

  const model = fakeModel([{ winner: "tie", margin: "tie" }]);
  const verdicts = await judgeAll([record1, record2], aResults, bResults, model);

  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].caseId, record1.runId);
});

test("judgeAll includes repo and prNumber in each verdict", async () => {
  const record = makeRecord({ repo: "thegoodparty/gp-webapp", prNumber: 99 });
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  const model = fakeModel([{ winner: "tie", margin: "tie" }]);
  const verdicts = await judgeAll([record], [a], [b], model);

  assert.equal(verdicts[0].repo, "thegoodparty/gp-webapp");
  assert.equal(verdicts[0].prNumber, 99);
});

test("judgePair defaults to 4 passes", async () => {
  const record = makeRecord();
  const a = makeResult({ caseId: record.runId });
  const b = makeResult({ caseId: record.runId });

  const model = fakeModel([{ winner: "tie", margin: "tie" }]);
  const verdict = await judgePair({ record, a, b, model });

  assert.equal(verdict.passes.length, 4);
});
