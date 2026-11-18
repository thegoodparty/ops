import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replayCase, replayAll, replayToolGuard, resultFromRecord, loadRunResults } from "./replay";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Result, RunAgentImpl, CheckoutFn } from "./replay";
import type { Bundle, ReviewRecord } from "../schema";
import { toolSet } from "../../framework";
import type { SubagentCall } from "../../framework/types";
import { loadPostmortems } from "../postmortems";

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

// A fake whose spend is knowable, so the usage assertions below can tell the
// two calls apart from a constant.
const spendingAgent =
  (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): RunAgentImpl =>
  async (config, prompt) => ({
    agent: config.name,
    output: config.name === "postmortem-selector" ? '{"ids":[]}' : JSON.stringify({ status: "complete", findings: [], summary: "s" }),
    durationMs: 1,
    costUsd: 0.01,
    usage,
    ...(config.name === "postmortem-selector"
      ? {}
      : { structuredOutput: { status: "complete", findings: [], summary: "s" } }),
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
      planConsistency:
        verdict === "consistent"
          ? { verdict, reasoning: "because" }
          : verdict === "inconsistent"
            ? { verdict, reasoning: "because", departure: { plan: "p", diff: "d" } }
            : { verdict, reasoning: "because", uncertainty: { unknown: "u", settle: "s" } },
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

// The plan's gate for S2 is a replay result file carrying non-null `usage`
// beside `costUsd`. This is that assertion, over the file rather than the
// value in memory, because the file is what a baseline side is assembled from.
test("a written result file carries usage beside costUsd", async () => {
  const out = tmpDir();
  const record = makeRecord();
  await replayAll(
    [record],
    { out, workDir: tmpDir(), variant: "v1" },
    { concurrency: 1 },
    spendingAgent({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 }),
    fakeCheckout,
  );

  const written = JSON.parse(
    readFileSync(join(out, record.runId, "run-1.json"), "utf-8"),
  ) as Result;
  assert.notEqual(written.costUsd, null, "costUsd must be recorded");
  assert.notEqual(written.usage, null, "usage must be recorded");
  // The post-mortem selection call spends too, and it is part of what this case
  // cost. Two calls at the same counts is the whole spend.
  assert.deepEqual(written.usage, {
    inputTokens: 22,
    outputTokens: 44,
    cacheReadTokens: 66,
    cacheWriteTokens: 88,
  });
});

test("a fake that reports no usage writes null rather than omitting the field", async () => {
  // `undefined` in a result file means "written before S2", so a run this code
  // made has to say `null`: otherwise a reader cannot tell an old file from a
  // run the harness told nothing.
  const out = tmpDir();
  const record = makeRecord();
  await replayAll([record], { out, workDir: tmpDir(), variant: "v1" }, { concurrency: 1 }, fakeRunAgent, fakeCheckout);
  const written = JSON.parse(readFileSync(join(out, record.runId, "run-1.json"), "utf-8")) as Result;
  assert.equal(written.usage, null);
  assert.ok("usage" in written, "the key is present, so the file answers the question");
});

test("replayAll writes one result file per replay and skips the ones that exist", async () => {
  const out = tmpDir();
  const workDir = tmpDir();
  const record = makeRecord();
  const calls: string[] = [];
  const agent: RunAgentImpl = async (_config, _prompt, overrides) => {
    if (_config.name === "pr-reviewer") calls.push(overrides.cwd);
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
    if (c.name === "pr-reviewer") calls++;
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
  const countingAgent: RunAgentImpl = async (config) => {
    if (config.name === "pr-reviewer") callCount++;
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

test("resultFromRecord carries a record's usage through, and omits it when the record predates it", () => {
  // A synthesized side is built from a stored production record, so the usage a
  // record carries has to survive into the eval or a prod-vs-candidate
  // comparison sees tokens on one side only.
  const withUsage = resultFromRecord(
    makeRecord({ usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 } }),
  );
  assert.deepEqual(withUsage.usage, { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 });

  const { usage: _absent, ...older } = makeRecord();
  assert.equal(resultFromRecord(older as ReviewRecord).usage, undefined);
});

test("resultFromRecord turns what production posted into a judgeable side", () => {
  const record = makeRecord({ action: "commented", agentVersion: "abcdef1234567" });
  const result = resultFromRecord(record);
  assert.equal(result.caseId, record.runId);
  assert.equal(result.variant, "prod-abcdef1");
  assert.deepEqual(result.output, record.output);
  assert.equal(result.costUsd, record.costUsd);
});

const finding = (path: string, line: number) => ({
  path,
  line,
  body: "b",
  category: "bugs" as const,
  confidence: "high" as const,
});

const leadOf = (area: string, hypothesis: string) => ({
  area,
  paths: ["src/a.ts"],
  category: "correctness",
  hypothesis,
});

const withSubagents = (subagentCalls: SubagentCall[], findings = [finding("src/a.ts", 5)]): RunAgentImpl =>
  async () => {
    const output = { status: "complete", findings, summary: "s" };
    return {
      agent: "pr-reviewer",
      output: JSON.stringify(output),
      durationMs: 1,
      costUsd: 0.01,
      structuredOutput: output,
      subagentCalls,
    };
  };

test("replayCase records each lead and what the deep-reviewer did with it", async () => {
  const calls: SubagentCall[] = [
    {
      subagent: "scout",
      prompt: "diff",
      result: `thinking\n${JSON.stringify({
        leads: [
          leadOf("Timezone", "formatInTimeZone ignores the schedule"),
          leadOf("Retry", "the retry swallows errors"),
          leadOf("Cache", "the cache never expires"),
          leadOf("Docs", "the docs lie"),
        ],
        summary: "4 leads",
      })}`,
    },
    {
      subagent: "deep-reviewer",
      prompt: "<lead>area: Timezone hypothesis: formatInTimeZone ignores the schedule</lead>",
      result: JSON.stringify({ findings: [finding("src/a.ts", 5)] }),
    },
    {
      subagent: "deep-reviewer",
      prompt: "<lead>hypothesis: the retry swallows errors</lead>",
      result: JSON.stringify({ findings: [] }),
    },
    {
      subagent: "deep-reviewer",
      prompt: "<lead>hypothesis: the cache never expires</lead>",
      result: JSON.stringify({ findings: [finding("src/c.ts", 9)] }),
    },
  ];

  const result = await replayCase(
    makeRecord(),
    { workDir: tmpDir(), variant: "v" },
    withSubagents(calls),
    fakeCheckout,
  );

  assert.deepEqual(
    result.leads?.map((l) => [l.area, l.outcome, l.findings]),
    [
      ["Timezone", "reported", 1],
      ["Retry", "dropped", 0],
      ["Cache", "raised", 1],
      ["Docs", "not-investigated", 0],
    ],
  );
  assert.equal(result.leads?.[0].hypothesis, "formatInTimeZone ignores the schedule");
});

test("replayCase keeps the subagent calls so leads can be re-traced offline", async () => {
  const calls: SubagentCall[] = [
    { subagent: "scout", prompt: "diff", result: JSON.stringify({ leads: [], summary: "none" }) },
    { subagent: "deep-reviewer", prompt: "check the retry", result: JSON.stringify({ findings: [] }) },
  ];
  const result = await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v" }, withSubagents(calls), fakeCheckout);
  assert.deepEqual(result.subagentCalls, calls);
});

test("replayCase records an empty lead list when the scout raised none", async () => {
  const calls: SubagentCall[] = [
    { subagent: "scout", prompt: "diff", result: '{"leads":[],"summary":"low risk"}' },
  ];
  const result = await replayCase(
    makeRecord(),
    { workDir: tmpDir(), variant: "v" },
    withSubagents(calls, []),
    fakeCheckout,
  );
  assert.deepEqual(result.leads, []);
});

test("replayCase leaves leads off when the scout's answer is unreadable or absent", async () => {
  const garbled = await replayCase(
    makeRecord(),
    { workDir: tmpDir(), variant: "v" },
    withSubagents([{ subagent: "scout", prompt: "d", result: "no json here" }]),
    fakeCheckout,
  );
  assert.equal("leads" in garbled, false);
  const none = await replayCase(
    makeRecord(),
    { workDir: tmpDir(), variant: "v" },
    fakeRunAgent,
    fakeCheckout,
  );
  assert.equal("leads" in none, false);
});

test("a lead restated in the orchestrator's own words still finds its deep-reviewer", async () => {
  const calls: SubagentCall[] = [
    {
      subagent: "scout",
      prompt: "d",
      result: JSON.stringify({
        leads: [
          leadOf("Alerts", "The `keepFiringFor` hold ends when count_over_time returns no series and noDataState is OK."),
          leadOf("Docs", "observability.md still describes range queries"),
        ],
        summary: "s",
      }),
    },
    {
      subagent: "deep-reviewer",
      prompt:
        "Investigate this lead.\nArea: Alerts\nHypothesis: keepFiringFor hold ends when\n  count_over_time returns no series, and noDataState is OK\nDiff: /tmp/diff.txt",
      result: JSON.stringify({ findings: [] }),
    },
  ];
  const result = await replayCase(
    makeRecord(),
    { workDir: tmpDir(), variant: "v" },
    withSubagents(calls),
    fakeCheckout,
  );
  assert.deepEqual(
    result.leads?.map((l) => [l.area, l.outcome]),
    [
      ["Alerts", "dropped"],
      ["Docs", "not-investigated"],
    ],
  );
});

test("a deep-reviewer answer that is not findings JSON is unknown, not dropped", async () => {
  const calls: SubagentCall[] = [
    { subagent: "scout", prompt: "d", result: JSON.stringify({ leads: [leadOf("A", "hyp a")], summary: "s" }) },
    { subagent: "deep-reviewer", prompt: "hyp a", result: "ran out of turns" },
  ];
  const result = await replayCase(
    makeRecord(),
    { workDir: tmpDir(), variant: "v" },
    withSubagents(calls),
    fakeCheckout,
  );
  assert.equal(result.leads?.[0].outcome, "unknown");
});

test("a deep-reviewer whose findings all fail the schema is unknown, not dropped", async () => {
  const calls: SubagentCall[] = [
    { subagent: "scout", prompt: "d", result: JSON.stringify({ leads: [leadOf("A", "hyp a")], summary: "s" }) },
    {
      subagent: "deep-reviewer",
      prompt: "hyp a",
      result: JSON.stringify({ findings: [{ path: "src/a.ts", line: "5", category: "correctness" }] }),
    },
  ];
  const result = await replayCase(
    makeRecord(),
    { workDir: tmpDir(), variant: "v" },
    withSubagents(calls),
    fakeCheckout,
  );
  assert.equal(result.leads?.[0].outcome, "unknown");
});

test("loadRunResults still parses a result file written without leads", () => {
  const dir = tmpDir();
  mkdirSync(join(dir, "c1"), { recursive: true });
  const old: Result = {
    caseId: "c1",
    repo: "r",
    prNumber: 1,
    headSha: "s",
    variant: "v",
    output: null,
    costUsd: null,
    wallTimeMs: 1,
  };
  writeFileSync(join(dir, "c1", "run-1.json"), JSON.stringify(old));
  const loaded = loadRunResults(dir).get("c1")?.get(1);
  assert.equal(loaded?.leads, undefined);
  // A file written before S2 has no `usage` key at all, and must keep loading.
  assert.equal(loaded?.usage, undefined);
});

const toolCall = (tool: string) =>
  ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} }) as never;
const hookOpts = { signal: new AbortController().signal };
const isDenied = (out: unknown) =>
  (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision === "deny";

test("replayToolGuard allows only the reviewer's read-only tools", async () => {
  for (const tool of ["Read", "Grep", "Glob", "Task", "Agent", "StructuredOutput", "mcp__git__git_show"]) {
    assert.equal(isDenied(await replayToolGuard(toolCall(tool), undefined, hookOpts)), false, tool);
  }
  for (const tool of ["Bash", "Write", "Edit", "WebFetch", "mcp__other__x"]) {
    assert.equal(isDenied(await replayToolGuard(toolCall(tool), undefined, hookOpts)), true, tool);
  }
});

test("replayCase denies Bash even when the reviewer config allows it", async () => {
  let guards: HookCallback[] = [];
  const capture: RunAgentImpl = async (config, prompt, overrides) => {
    guards = [...(overrides.toolCallGuards ?? [])];
    // A config that names Bash is the case the guard has to survive: the tool
    // list a candidate branch may edit must not be able to widen the replay.
    return fakeRunAgent(
      { ...config, tools: toolSet("Bash"), allowedTools: ["Bash"] },
      prompt,
      overrides,
    );
  };
  await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v" }, capture, fakeCheckout);
  const outs = await Promise.all(guards.map((g) => g(toolCall("Bash"), undefined, hookOpts)));
  assert.ok(outs.some(isDenied));
});

// Shaped on eval run 40882274151: the orchestrator copied each area into its
// deep-reviewer prompt but rewrote the hypothesis well below the word cutoff.
test("replayCase finds a lead's deep-reviewer by its area when the hypothesis was rewritten", async () => {
  const calls: SubagentCall[] = [
    {
      subagent: "scout",
      prompt: "diff",
      result: JSON.stringify({
        leads: [
          leadOf("keepFiringFor with NoData mapped to OK", "Event rules return no data when idle, so the incident closes early"),
          leadOf("Dev early return in createGrafanaResources", "Dev skips the folder and every rule group now"),
        ],
        summary: "2 leads",
      }),
    },
    {
      subagent: "deep-reviewer",
      prompt: 'Lead: area "Dev early return in createGrafanaResources"; Hypothesis: verify nothing after the return matters outside prod.',
      result: JSON.stringify({ findings: [] }),
    },
    {
      subagent: "deep-reviewer",
      prompt: 'Lead: area "keepFiringFor with NoData mapped to OK"; Hypothesis: a sum over an empty window yields no series, so state resets.',
      result: JSON.stringify({ findings: [finding("src/a.ts", 5)] }),
    },
  ];
  const result = await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v" }, withSubagents(calls), fakeCheckout);
  assert.deepEqual(
    result.leads?.map((l) => [l.area, l.outcome]),
    [
      ["keepFiringFor with NoData mapped to OK", "reported"],
      ["Dev early return in createGrafanaResources", "dropped"],
    ],
  );
});

test("replayCase does not match on an area that appears in several prompts", async () => {
  const calls: SubagentCall[] = [
    {
      subagent: "scout",
      prompt: "diff",
      result: JSON.stringify({ leads: [leadOf("Tests", "zzz qqq")], summary: "1 lead" }),
    },
    { subagent: "deep-reviewer", prompt: "Tests for the retry path", result: JSON.stringify({ findings: [] }) },
    { subagent: "deep-reviewer", prompt: "Tests for the cache path", result: JSON.stringify({ findings: [] }) },
  ];
  const result = await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v" }, withSubagents(calls), fakeCheckout);
  assert.equal(result.leads?.[0].outcome, "not-investigated");
});

test("replayCase does not treat an area as unique once earlier leads claimed its other prompts", async () => {
  const calls: SubagentCall[] = [
    {
      subagent: "scout",
      prompt: "diff",
      result: JSON.stringify({
        leads: [leadOf("Retry", "the retry swallows errors"), leadOf("Tests", "zzz qqq")],
        summary: "2 leads",
      }),
    },
    { subagent: "deep-reviewer", prompt: "Tests: the retry swallows errors", result: JSON.stringify({ findings: [] }) },
    { subagent: "deep-reviewer", prompt: "Tests for the cache path", result: JSON.stringify({ findings: [] }) },
  ];
  const result = await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v" }, withSubagents(calls), fakeCheckout);
  assert.deepEqual(
    result.leads?.map((l) => [l.area, l.outcome]),
    [
      ["Retry", "dropped"],
      ["Tests", "not-investigated"],
    ],
  );
});

const traced = async (leads: object[], prompts: string[]) => {
  const calls: SubagentCall[] = [
    { subagent: "scout", prompt: "diff", result: JSON.stringify({ leads, summary: "s" }) },
    ...prompts.map((prompt, i) => ({
      subagent: "deep-reviewer",
      prompt,
      result: JSON.stringify({ findings: i === 0 ? [finding("src/a.ts", 5)] : [] }),
    })),
  ];
  const result = await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v" }, withSubagents(calls), fakeCheckout);
  return result.leads?.map((l) => [l.area, l.outcome]);
};

test("a reworded lead is traced by the file and category its deep-reviewer prompt cites", async () => {
  assert.deepEqual(
    await traced(
      [{ area: "Unbounded IN list", paths: ["packages/api/src/text.service.ts"], category: "scale", hypothesis: "findTextedSince binds one parameter per person in the resolved audience" }],
      ["Verify a scout lead. File: packages/api/src/text.service.ts lines 66-85. Category: scale. Check whether the personId list can exceed the bind limit."],
    ),
    [["Unbounded IN list", "reported"]],
  );
});

test("a lead whose words fit another call better still gets its own call", async () => {
  assert.deepEqual(
    await traced(
      [
        { area: "Retry loop", paths: ["src/retry.ts"], category: "bugs", hypothesis: "the retry swallows errors from the cache client" },
        { area: "Cache expiry", paths: ["src/cache.ts"], category: "bugs", hypothesis: "entries never expire" },
      ],
      [
        "Lead in src/retry.ts, category bugs: errors thrown inside the loop are caught and ignored.",
        'Lead: area "Cache expiry"; the cache client keeps entries forever, and the retry reads errors from it.',
      ],
    ),
    [
      ["Retry loop", "reported"],
      ["Cache expiry", "dropped"],
    ],
  );
});

test("two leads on one file with different categories map to different calls", async () => {
  assert.deepEqual(
    await traced(
      [
        { area: "Missing await", paths: ["src/job.ts"], category: "bugs", hypothesis: "the handler returns before the write finishes" },
        { area: "No test for the job", paths: ["src/job.ts"], category: "tests", hypothesis: "nothing covers the failure branch" },
      ],
      [
        "Paths: src/job.ts. Category: tests. Hypothesis: no test covers the failure branch of the job.",
        "Paths: src/job.ts. Category: bugs. Hypothesis: the handler returns before the write to the table finishes.",
      ],
    ),
    [
      ["Missing await", "dropped"],
      ["No test for the job", "reported"],
    ],
  );
});

test("a file name inside a longer one is not a citation", async () => {
  assert.deepEqual(
    await traced(
      [{ area: "Retry", paths: ["src/service.ts"], category: "bugs", hypothesis: "zzz qqq" }],
      ["Paths: src/text.service.ts, lib/my-service.ts. Category: bugs. Check the cache keys."],
    ),
    [["Retry", "not-investigated"]],
  );
});

const postmortemAgent = (selectorReplies: { output: string; errorSubtype?: string }[]) => {
  const selectorPrompts: string[] = [];
  const reviewPrompts: string[] = [];
  const agent: RunAgentImpl = async (config, prompt, overrides) => {
    if (config.name === "postmortem-selector") {
      assert.deepEqual(config.tools, {});
      assert.equal(config.model, "claude-sonnet-5-5");
      selectorPrompts.push(prompt);
      return { agent: config.name, durationMs: 1, ...selectorReplies[selectorPrompts.length - 1] };
    }
    reviewPrompts.push(prompt);
    return fakeRunAgent(config, prompt, overrides);
  };
  return { agent, selectorPrompts, reviewPrompts };
};

test("replayCase shows the review the post-mortems selection kept, and records them", async () => {
  const [first] = loadPostmortems();
  const { agent, selectorPrompts, reviewPrompts } = postmortemAgent([
    { output: `{"ids": ["${first.file}#1"]}` },
    { output: `{"ids": ["${first.file}"]}` },
  ]);
  const result = await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v1" }, agent, fakeCheckout);
  assert.equal(selectorPrompts.length, 2);
  assert.ok(reviewPrompts[0].includes(`<postmortem file="${first.file}">`));
  assert.deepEqual(result.postmortems, [{ file: first.file, lessons: [`${first.file}#1`] }]);
});

test("replayCase shows every post-mortem, whatever the recorded review's date, and a simulated case too", async () => {
  const [first] = loadPostmortems();
  const record = makeRecord();
  assert.ok(record.startedAt < first.date);
  for (const r of [record, { runId: record.runId, bundle: record.bundle } as ReviewRecord]) {
    const { agent, selectorPrompts } = postmortemAgent([{ output: '{"ids": []}' }]);
    await replayCase(r, { workDir: tmpDir(), variant: "v1" }, agent, fakeCheckout);
    assert.equal(selectorPrompts.length, 1);
    assert.ok(selectorPrompts[0].includes(`<lesson id="${first.file}#1">`));
  }
});

test("replayCase strips PR numbers, GitHub links and commits from the post-mortems it shows", async () => {
  // Pick the post-mortem that carries the identifiers rather than the first in
  // the folder. The assertion needs a file whose text actually has a PR number
  // and a GitHub link to strip, and which file that is depends on what the
  // folder holds: #549 added two earlier-dated post-mortems, so the first file
  // is no longer the read freeze and this failed on `main` without this test's
  // subject changing at all.
  const first = loadPostmortems().find((p) => /#2977/.test(p.text));
  assert.ok(first, "no post-mortem carries a PR number, so there is nothing to strip");
  const { agent, selectorPrompts, reviewPrompts } = postmortemAgent([
    { output: `{"ids": ["${first.file}#1"]}` },
    { output: `{"ids": ["${first.file}"]}` },
  ]);
  await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v1" }, agent, fakeCheckout);
  for (const prompt of [...selectorPrompts, reviewPrompts[0]]) {
    assert.doesNotMatch(prompt, /#2977|#3023|#2852|github\.com\/thegoodparty\/omni\/pull/);
  }
  assert.ok(reviewPrompts[0].includes(`<postmortem file="${first.file}">`));
});

test("replayCase reviews without post-mortems when the selection call errors", async () => {
  const { agent, selectorPrompts, reviewPrompts } = postmortemAgent([{ output: "Agent error: overloaded", errorSubtype: "error_during_execution" }]);
  const result = await replayCase(makeRecord(), { workDir: tmpDir(), variant: "v1" }, agent, fakeCheckout);
  assert.equal(selectorPrompts.length, 1);
  assert.ok(!reviewPrompts[0].includes("<postmortems>"));
  assert.ok(!result.error);
  assert.equal(result.output?.status, "complete");
});
