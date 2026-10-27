import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replayCase, replayAll, resultFromRecord, loadRunResults } from "./replay";
import type { Result, RunAgentImpl, CheckoutFn } from "./replay";
import type { Bundle, ReviewRecord } from "../schema";

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
    title: "Test PR",
    body: "A test PR",
    diff: "diff --git a/foo.ts b/foo.ts\n",
    changedFiles: ["foo.ts"],
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

const tmpDir = () => {
  const dir = join(tmpdir(), `replay-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const fakeCheckout: CheckoutFn = async (_bundle, repoDir) => {
  mkdirSync(repoDir, { recursive: true });
};

const fakeRunAgent: RunAgentImpl = async (_config, _prompt, _overrides) => ({
  agent: "pr-reviewer",
  output: JSON.stringify({ status: "complete", findings: [], summary: "ok from fake" }),
  durationMs: 100,
  costUsd: 0.01,
  structuredOutput: { status: "complete", findings: [], summary: "ok from fake" },
});

// A simulated PR in a gated repo, carrying the plan the model is judged
// against. The bundle shape is what step 1 put on the two plan cases.
const gatedBundle = (overrides: Partial<Bundle> = {}): Bundle => ({
  repo: "thegoodparty/ops",
  prNumber: 99001,
  baseRef: "main",
  baseSha: "aaaaaa",
  headSha: "bbbbbb",
  author: "delegate-eval",
  title: "Raise the delegate webhook timeout",
  body: "Plan: docs/example-webhook-timeout.md",
  diff: "diff --git a/deploy/components/webhooks.ts b/deploy/components/webhooks.ts\n",
  changedFiles: ["deploy/components/webhooks.ts"],
  priorFindings: [],
  plan: {
    path: "docs/example-webhook-timeout.md",
    blobSha: "1c7ac96f062c9263697f7208056f9941e4dc499a",
    text: "# Delegate webhook timeout\n",
  },
  ...overrides,
});

const answeringAgent =
  (verdict: "consistent" | "inconsistent" | "unclear"): RunAgentImpl =>
  async () => {
    const structuredOutput = {
      status: "complete" as const,
      findings: [],
      summary: "ok from fake",
      planConsistency: { verdict, reasoning: "because" },
    };
    return {
      agent: "pr-reviewer",
      output: JSON.stringify(structuredOutput),
      durationMs: 100,
      costUsd: 0.01,
      structuredOutput,
    };
  };

test("replayCase returns a result with the correct caseId", async () => {
  const record = makeRecord();
  const workDir = tmpDir();

  const result = await replayCase(
    record,
    { workDir, variant: "test-variant" },
    fakeRunAgent,
    fakeCheckout,
  );

  assert.equal(result.caseId, record.runId);
  assert.equal(result.repo, record.bundle.repo);
  assert.equal(result.prNumber, record.bundle.prNumber);
  assert.equal(result.headSha, record.bundle.headSha);
  assert.equal(result.variant, "test-variant");
});

test("replayCase returns a successful output from the fake agent", async () => {
  const record = makeRecord();
  const workDir = tmpDir();

  const result = await replayCase(
    record,
    { workDir, variant: "v1" },
    fakeRunAgent,
    fakeCheckout,
  );

  assert.ok(!result.error, `unexpected error: ${result.error}`);
  assert.ok(result.output !== null);
  assert.equal(result.output?.status, "complete");
});

test("replayCase records the gate's approval for a gated repo", async () => {
  const record = makeRecord({ bundle: gatedBundle() });

  const result = await replayCase(
    record,
    { workDir: tmpDir(), variant: "v1" },
    answeringAgent("consistent"),
    fakeCheckout,
  );

  assert.deepEqual(result.gating, {
    mode: "enforce",
    verdict: "approve",
    gates: [],
    wouldApprove: true,
  });
});

test("replayCase records the flag the agent's output cannot distinguish from a comment", async () => {
  const record = makeRecord({ bundle: gatedBundle() });

  const result = await replayCase(
    record,
    { workDir: tmpDir(), variant: "v1" },
    answeringAgent("inconsistent"),
    fakeCheckout,
  );

  // Same shape as a clean review: a complete output with no findings. Only the
  // gating verdict says the review event was a comment, and why.
  assert.equal(result.output?.status, "complete");
  assert.deepEqual(result.output?.findings, []);
  assert.deepEqual(result.gating, {
    mode: "enforce",
    verdict: "comment",
    gates: ["inconsistent"],
    wouldApprove: false,
  });
});

test("replayCase records no gating verdict for a repo that has not adopted gating", async () => {
  const record = makeRecord({ bundle: gatedBundle({ repo: "thegoodparty/omni" }) });

  const result = await replayCase(
    record,
    { workDir: tmpDir(), variant: "v1" },
    answeringAgent("consistent"),
    fakeCheckout,
  );

  assert.equal(result.gating, undefined);
});

test("replayCase keeps a finding that cannot be anchored a blocker in the gate", async () => {
  const record = makeRecord({ bundle: gatedBundle() });
  const output = {
    status: "complete" as const,
    findings: [
      {
        path: "deploy/components/webhooks.ts",
        line: 1,
        body: "bug",
        category: "bugs" as const,
        confidence: "high" as const,
      },
    ],
    summary: "one finding",
    planConsistency: { verdict: "consistent" as const, reasoning: "because" },
  };
  const findingAgent: RunAgentImpl = async () => ({
    agent: "pr-reviewer",
    output: JSON.stringify(output),
    durationMs: 10,
    costUsd: 0.01,
    structuredOutput: output,
  });

  const result = await replayCase(
    record,
    { workDir: tmpDir(), variant: "v1" },
    findingAgent,
    fakeCheckout,
  );

  assert.equal(result.gating?.verdict, "comment");
  assert.equal(result.gating?.wouldApprove, false);
  assert.deepEqual(result.gating?.gates, ["unplaceable_findings"]);
});

test("replayCase returns an error result when checkout throws", async () => {
  const record = makeRecord();
  const workDir = tmpDir();

  const failingCheckout: CheckoutFn = async () => {
    throw new Error("clone failed: repository not found");
  };

  const result = await replayCase(
    record,
    { workDir, variant: "v1" },
    fakeRunAgent,
    failingCheckout,
  );

  assert.ok(result.error, "expected an error");
  assert.match(result.error!, /checkout failed/);
  assert.equal(result.output, null);
  assert.equal(result.costUsd, null);
});

test("replayCase returns an error result when the agent throws", async () => {
  const record = makeRecord();
  const workDir = tmpDir();

  const throwingAgent: RunAgentImpl = async () => {
    throw new Error("agent SDK connection failed");
  };

  const result = await replayCase(
    record,
    { workDir, variant: "v1" },
    throwingAgent,
    fakeCheckout,
  );

  assert.ok(result.error, "expected an error");
  assert.match(result.error!, /agent threw/);
  assert.equal(result.output, null);
});

test("replayCase propagates agent errorSubtype as error", async () => {
  const record = makeRecord();
  const workDir = tmpDir();

  const errAgent: RunAgentImpl = async () => ({
    agent: "pr-reviewer",
    output: "permission denied",
    durationMs: 50,
    costUsd: 0.001,
    errorSubtype: "api_error",
  });

  const result = await replayCase(
    record,
    { workDir, variant: "v1" },
    errAgent,
    fakeCheckout,
  );

  assert.ok(result.error, "expected an error");
  assert.match(result.error!, /agent error.*api_error/);
});

test("replayAll skips cases that already have a result file", async () => {
  const out = tmpDir();
  const workDir = tmpDir();
  const record = makeRecord();

  const preExisting: Result = {
    caseId: record.runId,
    repo: record.repo,
    prNumber: record.prNumber,
    headSha: record.headSha,
    variant: "existing",
    output: { status: "complete", findings: [], summary: "pre-existing" },
    costUsd: 0.01,
    wallTimeMs: 100,
  };
  mkdirSync(join(out, record.runId));
  writeFileSync(join(out, record.runId, "run-1.json"), JSON.stringify(preExisting));

  let agentCalled = false;
  const guardAgent: RunAgentImpl = async () => {
    agentCalled = true;
    return { agent: "pr-reviewer", output: "", durationMs: 0 };
  };

  const results = await replayAll(
    [record],
    { out, workDir, force: false },
    { concurrency: 1 },
    guardAgent,
    fakeCheckout,
  );

  assert.equal(agentCalled, false, "agent should not be called for a pre-existing result");
  assert.equal(results.length, 1);
  assert.equal(results[0].variant, "existing");
});

test("replayAll replays cases when force is true even if result exists", async () => {
  const out = tmpDir();
  const workDir = tmpDir();
  const record = makeRecord();

  const preExisting: Result = {
    caseId: record.runId,
    repo: record.repo,
    prNumber: record.prNumber,
    headSha: record.headSha,
    variant: "old",
    output: null,
    costUsd: null,
    wallTimeMs: 0,
  };
  mkdirSync(join(out, record.runId));
  writeFileSync(join(out, record.runId, "run-1.json"), JSON.stringify(preExisting));

  const results = await replayAll(
    [record],
    { out, workDir, force: true, variant: "new" },
    { concurrency: 1 },
    fakeRunAgent,
    fakeCheckout,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].variant, "new");
});

test("replayAll writes result JSON files for each replayed case", async () => {
  const out = tmpDir();
  const workDir = tmpDir();
  const record = makeRecord();

  await replayAll(
    [record],
    { out, workDir, variant: "v1" },
    { concurrency: 1 },
    fakeRunAgent,
    fakeCheckout,
  );

  const resultPath = join(out, record.runId, "run-1.json");
  assert.ok(existsSync(resultPath), "result file should be written");
  const written = JSON.parse(readFileSync(resultPath, "utf-8")) as Result;
  assert.equal(written.caseId, record.runId);
});

test("replayAll writes one result file per replay and skips the ones that exist", async () => {
  const out = tmpDir();
  const workDir = tmpDir();
  const record = makeRecord();
  const calls: string[] = [];
  const agent: RunAgentImpl = async (_config, _prompt, overrides) => {
    calls.push(overrides.cwd);
    return fakeRunAgent(_config, _prompt, overrides);
  };

  await replayAll([record], { out, workDir, variant: "v1", replays: 2 }, { concurrency: 2 }, agent, fakeCheckout);
  assert.ok(existsSync(join(out, record.runId, "run-1.json")));
  assert.ok(existsSync(join(out, record.runId, "run-2.json")));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1], "side-by-side replays of one case need separate checkouts");

  await replayAll([record], { out, workDir, variant: "v1", replays: 2 }, { concurrency: 2 }, agent, fakeCheckout);
  assert.equal(calls.length, 2, "both replays already had results");
});

test("replayAll replays only the missing run of a partly cached case", async () => {
  const out = tmpDir();
  const record = makeRecord();
  const cached: Result = {
    caseId: record.runId,
    repo: record.repo,
    prNumber: record.prNumber,
    headSha: record.headSha,
    variant: "cached",
    output: { status: "complete", findings: [], summary: "cached" },
    costUsd: 0.01,
    wallTimeMs: 1,
  };
  mkdirSync(join(out, record.runId));
  writeFileSync(join(out, record.runId, "run-1.json"), JSON.stringify(cached));

  let calls = 0;
  const agent: RunAgentImpl = async (c, p, o) => {
    calls++;
    return fakeRunAgent(c, p, o);
  };
  const results = await replayAll([record], { out, workDir: tmpDir(), variant: "new", replays: 2 }, { concurrency: 1 }, agent, fakeCheckout);

  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.variant).sort(), ["cached", "new"]);
  const runs = loadRunResults(out).get(record.runId)!;
  assert.equal(runs.get(1)?.variant, "cached");
  assert.equal(runs.get(2)?.variant, "new");
});

test("loadRunResults reads run dirs and treats a loose result file as run 1", () => {
  const dir = tmpDir();
  const record = makeRecord();
  const loose = makeRecord();
  mkdirSync(join(dir, record.runId));
  writeFileSync(join(dir, record.runId, "run-2.json"), JSON.stringify(resultFromRecord(record)));
  writeFileSync(join(dir, loose.runId + ".json"), JSON.stringify(resultFromRecord(loose)));
  writeFileSync(join(dir, ".cache-pulled"), "x\n");

  const runs = loadRunResults(dir);
  assert.deepEqual([...runs.get(record.runId)!.keys()], [2]);
  assert.deepEqual([...runs.get(loose.runId)!.keys()], [1]);
});

test("replayAll runs multiple cases with the worker pool", async () => {
  const out = tmpDir();
  const workDir = tmpDir();
  const records = [makeRecord(), makeRecord(), makeRecord()];

  let callCount = 0;
  const countingAgent: RunAgentImpl = async () => {
    callCount++;
    return {
      agent: "pr-reviewer",
      output: "",
      durationMs: 10,
      structuredOutput: { status: "complete", findings: [], summary: "ok" },
    };
  };

  const results = await replayAll(
    records,
    { out, workDir, variant: "v1" },
    { concurrency: 2 },
    countingAgent,
    fakeCheckout,
  );

  assert.equal(results.length, 3);
  assert.equal(callCount, 3);
});

test("resultFromRecord turns what production posted into a judgeable side", () => {
  const record = makeRecord({ action: "commented", agentVersion: "abcdef1234567" });
  const result = resultFromRecord(record);
  assert.equal(result.caseId, record.runId);
  assert.equal(result.variant, "prod-abcdef1");
  assert.deepEqual(result.output, record.output);
  assert.equal(result.costUsd, record.costUsd);
});
