import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replayCase, replayAll } from "./replay";
import type { Result, RunAgentImpl, CheckoutFn } from "./replay";
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
  writeFileSync(join(out, `${record.runId}.json`), JSON.stringify(preExisting));

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
  writeFileSync(join(out, `${record.runId}.json`), JSON.stringify(preExisting));

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

  const resultPath = join(out, `${record.runId}.json`);
  assert.ok(existsSync(resultPath), "result file should be written");
  const written = JSON.parse(readFileSync(resultPath, "utf-8")) as Result;
  assert.equal(written.caseId, record.runId);
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
