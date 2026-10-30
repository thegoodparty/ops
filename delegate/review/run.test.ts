import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, gatingFor, latestCompletedRecord, parseReviewOutput, pathGuardHook, statusForRecord } from "./run";
import { decide } from "./gates";
import { priorFindingsFrom } from "./bundle";
import { ReviewOutputSchema, ReviewRecordSchema, StoredReviewOutputSchema, lockKey, recordKey } from "./schema";
import type { ReviewRecord } from "./schema";

test("gatingFor defaults to off and cannot be loosened by a bad value", () => {
  // `off` is the default in code (decision 13), so a missing or misspelled
  // variable cannot make the bot more able to merge.
  for (const env of [{}, { DELEGATE_GATING_MODE: "" }, { DELEGATE_GATING_MODE: "on" }]) {
    assert.deepEqual(gatingFor("thegoodparty/ops", env), { active: false, mode: "off" });
  }
});

test("gatingFor reads the mode and the repo's adoption together", () => {
  assert.deepEqual(gatingFor("thegoodparty/ops", { DELEGATE_GATING_MODE: "shadow" }), {
    active: true,
    mode: "shadow",
  });
  assert.deepEqual(gatingFor("thegoodparty/ops", { DELEGATE_GATING_MODE: "enforce" }), {
    active: true,
    mode: "enforce",
  });
  // A repo that has not adopted gating keeps today's behaviour even under
  // `enforce`: no plan fetch, no CODEOWNERS read, no verdict change.
  assert.deepEqual(gatingFor("thegoodparty/omni", { DELEGATE_GATING_MODE: "enforce" }), {
    active: false,
    mode: "enforce",
  });
});

test("statusForRecord is unchanged for an ungated comment", () => {
  const record = { action: "commented", gates: [], findings: [{}, {}] } as unknown as ReviewRecord;
  assert.deepEqual(statusForRecord(record), {
    state: "success",
    description: "Commented: 2 finding(s)",
    targetUrl: undefined,
  });
});

test("statusForRecord says what a gated comment was gated on", () => {
  const record = {
    action: "commented",
    gates: ["touches_docs"],
    findings: [],
    gating: { mode: "enforce", flags: ["touches_docs"], baseRef: "main", binding: {}, authority: { checked: true, ownedPaths: [], reason: "" } },
  } as unknown as ReviewRecord;
  assert.equal(statusForRecord(record).description, "Commented: touches_docs");
});

test("statusForRecord reports a shadow run as what it would have done", () => {
  const base = {
    action: "commented",
    gates: [],
    findings: [],
    gating: { mode: "shadow", flags: [], baseRef: "main", binding: {}, authority: { checked: true, ownedPaths: [], reason: "" } },
  } as unknown as ReviewRecord;
  assert.equal(statusForRecord(base).description, "Shadow: would approve");
  const flagged = {
    ...base,
    gates: ["inconsistent"],
    gating: { ...base.gating!, flags: ["inconsistent"] },
  } as unknown as ReviewRecord;
  assert.equal(statusForRecord(flagged).description, "Shadow: would comment (inconsistent)");
});

test("statusForRecord never claims a shadow would approve around unparseable findings", () => {
  // Unparseable findings are a blocker but not a gating flag: they live on
  // `gates`, and `wouldApprove` is false for them. A record with no findings
  // and no `gating.flags` is not therefore a would-approve.
  const base = {
    action: "commented",
    gates: ["unparseable_findings"],
    findings: [],
    gating: { mode: "shadow", flags: [], baseRef: "main", binding: {}, authority: { checked: true, ownedPaths: [], reason: "" } },
  } as unknown as ReviewRecord;
  assert.equal(
    statusForRecord(base).description,
    "Shadow: would comment (unparseable_findings)",
  );
  assert.equal(
    statusForRecord({ ...base, gating: { ...base.gating!, mode: "enforce" } } as unknown as ReviewRecord)
      .description,
    "Commented: unparseable_findings",
  );
});

test("statusForRecord says why when every finding could not be posted", () => {
  // A finding on a path outside the diff blocks the verdict but is never in
  // `record.findings`; a gated record names it on `gates` instead, so the
  // status cannot read as an approval the gate did not make.
  const base = {
    action: "commented",
    gates: ["unplaceable_findings"],
    findings: [],
    gating: { mode: "shadow", flags: [], baseRef: "main", binding: {}, authority: { checked: true, ownedPaths: [], reason: "" } },
  } as unknown as ReviewRecord;
  assert.equal(
    statusForRecord(base).description,
    "Shadow: would comment (unplaceable_findings)",
  );
});

// The record is the machine-readable half of the comment: the findings verdict
// and the gate's verdict are separate fields, so "clean, blocked by the gate"
// is countable without reading English. The field is optional, because "no
// field" (a record written before it existed) is not "no findings".
test("a gated record carries the findings verdict beside the gating result", () => {
  const record = {
    runId: "a0000000-0000-4000-8000-000000000001",
    repo: "thegoodparty/ops",
    prNumber: 42,
    baseSha: "aaaaaa",
    headSha: "bbbbbb",
    trigger: "webhook",
    agentVersion: "1.0.0",
    model: "claude-opus-4-5",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:01:00.000Z",
    wallTimeMs: 60000,
    costUsd: null,
    bundle: {
      repo: "thegoodparty/ops",
      prNumber: 42,
      baseRef: "main",
      baseSha: "aaaaaa",
      headSha: "bbbbbb",
      author: "swain",
      title: "A PR with no plan line",
      body: "No plan here.",
      diff: "diff --git a/foo.ts b/foo.ts\n",
      changedFiles: ["foo.ts"],
      priorFindings: [],
    },
    output: { status: "complete", findings: [], summary: "clean" },
    verdict: "comment",
    action: "commented",
    gates: ["no_binding"],
    findingsVerdict: "none",
    gating: {
      mode: "enforce",
      binding: {},
      baseRef: "main",
      authority: { checked: true, ownedPaths: [], reason: "" },
      flags: ["no_binding"],
    },
    findings: [],
    droppedFindings: [],
  };
  const parsed = ReviewRecordSchema.parse(record);
  assert.equal(parsed.findingsVerdict, "none");
  assert.deepEqual(parsed.gating?.flags, ["no_binding"]);

  const { findingsVerdict: _omitted, ...older } = record;
  assert.equal(ReviewRecordSchema.parse(older).findingsVerdict, undefined);
});

// The bug this pins: `statusForRecord` knew what a gated comment was gated on,
// but the terminal status re-derived its own "Commented: N finding(s)" string,
// so the description a reader actually sees never mentioned the gate. One
// source, asked by every path that reports the outcome.
test("the terminal status is rendered by statusForRecord", () => {
  const source = readFileSync(join(__dirname, "run.ts"), "utf-8");
  const marker = source.indexOf("terminal status failed");
  assert.ok(marker > 0, "expected the terminal status call");
  const call = source.slice(source.lastIndexOf("postStatus", marker), marker);
  assert.match(call, /statusForRecord\(record/);
  assert.equal(source.includes("Commented: ${findingCount}"), false);
});

test("agentEnv strips every credential the worker holds", () => {
  const env = agentEnv({
    PATH: "/usr/bin",
    HOME: "/home/agent",
    ANTHROPIC_API_KEY: "sk-ant",
    GITHUB_TOKEN: "ghs_1",
    GITHUB_APP_PRIVATE_KEY: "pem",
    REVIEWER_GITHUB_TOKEN: "ghs_2",
    REVIEWER_APP_PRIVATE_KEY: "pem",
    SLACK_BOT_TOKEN: "xoxb",
    CLICKUP_API_TOKEN: "pk",
    GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa",
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x",
    AWS_DEFAULT_REGION: "us-west-2",
    AGENT_JOB: "{}",
    GH_TOKEN: "ghs_3",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "ANTHROPIC_API_KEY",
    "AWS_DEFAULT_REGION",
    "HOME",
    "PATH",
  ]);
});

test("agentEnv drops anything it was not told about", () => {
  const env = agentEnv({
    DATABRICKS_TOKEN: "dapi",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials",
    SOME_NEW_SECRET: "x",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000",
  });
  assert.deepEqual(Object.keys(env), ["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]);
});

const hookCall = async (hook: ReturnType<typeof pathGuardHook>, tool: string, input: unknown) =>
  hook(
    { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input } as never,
    undefined,
    { signal: new AbortController().signal },
  );

const denied = (out: unknown) =>
  (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision === "deny";

test("pathGuardHook confines Read/Grep/Glob to the review checkout", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-guard-")));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "x");
  const hook = pathGuardHook(root);

  assert.equal(denied(await hookCall(hook, "Read", { file_path: join(root, "src/a.ts") })), false);
  assert.equal(denied(await hookCall(hook, "Read", { file_path: "src/a.ts" })), false);
  assert.equal(denied(await hookCall(hook, "Grep", { pattern: "x", path: root })), false);
  assert.equal(denied(await hookCall(hook, "Glob", { pattern: "**/*.ts" })), false);

  assert.equal(denied(await hookCall(hook, "Read", { file_path: "/proc/1/environ" })), true);
  assert.equal(denied(await hookCall(hook, "Read", { file_path: "../../etc/passwd" })), true);
  assert.equal(denied(await hookCall(hook, "Grep", { pattern: "x", path: "/" })), true);
  assert.equal(denied(await hookCall(hook, "Glob", { pattern: "*", path: "/proc" })), true);
  assert.equal(denied(await hookCall(hook, "Task", { prompt: "/proc/1/environ" })), false);
});

const recordStub = (action: ReviewRecord["action"], finishedAt: string): ReviewRecord =>
  ({ action, finishedAt, findings: [] }) as unknown as ReviewRecord;

test("latestCompletedRecord skips failed runs", () => {
  const records = [
    recordStub("commented", "2026-01-01T00:00:00Z"),
    recordStub("failed", "2026-01-02T00:00:00Z"),
  ];
  assert.equal(latestCompletedRecord(records)?.action, "commented");
  assert.equal(latestCompletedRecord([recordStub("failed", "2026-01-02T00:00:00Z")]), undefined);
});

test("parseReviewOutput prefers structured output", () => {
  const out = parseReviewOutput({
    structuredOutput: { status: "complete", findings: [], summary: "clean" },
    output: "not json",
  });
  assert.deepEqual(out, {
    output: { status: "complete", findings: [], summary: "clean" },
    droppedFindingCount: 0,
  });
});

test("parseReviewOutput falls back to the text result", () => {
  const out = parseReviewOutput({
    output: JSON.stringify({ status: "failed", reason: "scout failed" }),
  });
  assert.deepEqual(out, {
    output: { status: "failed", reason: "scout failed" },
    droppedFindingCount: 0,
  });
});

test("parseReviewOutput rejects a verdict the agent is not allowed to emit", () => {
  const out = parseReviewOutput({
    structuredOutput: { status: "complete", verdict: "approve", findings: [{ path: "a.ts" }] },
    output: "",
  });
  assert.ok("error" in out);
  assert.match(out.error, /failed schema/);
});

test("parseReviewOutput keeps a valid planConsistency on the tolerant path", () => {
  const answer = {
    verdict: "inconsistent",
    reasoning: "the plan names worker.ts",
    departure: { plan: "raise the worker log group's retention", diff: "rewrites the playwright bucket" },
  };
  const kept = parseReviewOutput({
    output: JSON.stringify({ status: "complete", findings: [], summary: "clean", planConsistency: answer }),
  });
  assert.ok(!("error" in kept));
  assert.deepEqual(kept.output, {
    status: "complete",
    findings: [],
    summary: "clean",
    planConsistency: answer,
  });

  const unclear = {
    verdict: "unclear",
    reasoning: "the plan names no address",
    uncertainty: { unknown: "whether the task has a stable address", settle: "the task's service registration" },
  };
  const keptUnclear = parseReviewOutput({
    output: JSON.stringify({ status: "complete", findings: [], summary: "clean", planConsistency: unclear }),
  });
  assert.ok(!("error" in keptUnclear));
  assert.ok(keptUnclear.output?.status === "complete");
  assert.deepEqual(keptUnclear.output.planConsistency, unclear);

  // An absent answer is still a complete review: an ungated run never asks the
  // question, and a gated one treats no answer as its own flag.
  const absent = parseReviewOutput({
    output: JSON.stringify({ status: "complete", findings: [], summary: "clean" }),
  });
  assert.ok(!("error" in absent));
  assert.deepEqual(absent.output, { status: "complete", findings: [], summary: "clean" });
});

// ops#414's review 5701013152 is the case this exists for: an `inconsistent`
// with no plan sentence and no hunk cannot be checked or rebutted. The schema
// requires the justification, so the answer is rejected and the run retries
// instead of posting the bare verdict.
test("parseReviewOutput rejects a verdict without its justification", () => {
  const withoutDeparture = parseReviewOutput({
    output: JSON.stringify({
      status: "complete",
      findings: [],
      summary: "clean",
      planConsistency: { verdict: "inconsistent", reasoning: "the plan names worker.ts" },
    }),
  });
  assert.ok("error" in withoutDeparture);
  assert.match(withoutDeparture.error, /planConsistency failed schema/);
  assert.match(withoutDeparture.error, /departure/);

  const withoutUncertainty = parseReviewOutput({
    output: JSON.stringify({
      status: "complete",
      findings: [],
      summary: "clean",
      planConsistency: { verdict: "unclear", reasoning: "not enough detail" },
    }),
  });
  assert.ok("error" in withoutUncertainty);
  assert.match(withoutUncertainty.error, /uncertainty/);

  // The same through the structured-output path the SDK supplies, so the rule
  // does not depend on which parse path the run happens to take.
  const structured = parseReviewOutput({
    structuredOutput: {
      status: "complete",
      findings: [],
      summary: "clean",
      planConsistency: { verdict: "inconsistent", reasoning: "the plan names worker.ts" },
    },
    output: "",
  });
  assert.ok("error" in structured);
  assert.match(structured.error, /departure/);

  // Half a justification is not one: an empty string fails the same way.
  const emptyHalf = parseReviewOutput({
    output: JSON.stringify({
      status: "complete",
      findings: [],
      summary: "clean",
      planConsistency: { verdict: "inconsistent", reasoning: "r", departure: { plan: "p", diff: "" } },
    }),
  });
  assert.ok("error" in emptyHalf);
});
// The model-output schema is strict and the record schema is not, and the pair
// is what makes this a rule rather than a migration: a run cannot post a bare
// verdict, and a record written before the requirement still parses and
// replays.
test("a stored answer written before the requirement still parses; new output does not", () => {
  const legacy = {
    status: "complete",
    findings: [],
    summary: "s",
    planConsistency: { verdict: "inconsistent", reasoning: "the plan names worker.ts" },
  };
  assert.equal(StoredReviewOutputSchema.safeParse(legacy).success, true);
  assert.equal(ReviewOutputSchema.safeParse(legacy).success, false);

  const justified = {
    ...legacy,
    planConsistency: {
      verdict: "inconsistent",
      reasoning: "the plan names worker.ts",
      departure: { plan: "keep worker.ts", diff: "rewrites the playwright bucket" },
    },
  };
  assert.equal(StoredReviewOutputSchema.safeParse(justified).success, true);
  assert.equal(ReviewOutputSchema.safeParse(justified).success, true);
});

test("parseReviewOutput finds the JSON when the model wraps it in prose", () => {
  const out = parseReviewOutput({
    output: `All four deep-reviewers returned zero findings. Every lead was falsified:

1. **Thing**: not a bug {see line 3}

{"status":"complete","findings":[],"summary":"Reviewed the \\"diff\\"; clean."}

Done.`,
  });
  assert.deepEqual(out, {
    output: {
      status: "complete",
      findings: [],
      summary: 'Reviewed the "diff"; clean.',
    },
    droppedFindingCount: 0,
  });
});

test("parseReviewOutput ignores an unmatched quote in the prose", () => {
  const out = parseReviewOutput({
    output: `Here's the "result:\n{"status":"complete","findings":[],"summary":"clean"}`,
  });
  assert.deepEqual(out, {
    output: { status: "complete", findings: [], summary: "clean" },
    droppedFindingCount: 0,
  });
});

test("parseReviewOutput survives an unmatched brace in the prose", () => {
  const out = parseReviewOutput({
    output: "the handler `function f() {` returns early, so no finding.\n\n" +
      '{"status":"complete","findings":[],"summary":"clean"}',
  });
  assert.deepEqual(out, {
    output: { status: "complete", findings: [], summary: "clean" },
    droppedFindingCount: 0,
  });
});

test("parseReviewOutput reports non-JSON text", () => {
  const out = parseReviewOutput({ output: "I approve this PR." });
  assert.ok("error" in out);
  assert.match(out.error, /no JSON/);
});

const goodFinding = {
  path: "src/a.ts",
  line: 3,
  body: "A real bug.",
  category: "bugs",
  confidence: "high",
};

test("parseReviewOutput drops one bad finding instead of the whole review", () => {
  const out = parseReviewOutput({
    structuredOutput: {
      status: "complete",
      findings: [goodFinding, { path: "src/b.ts", line: -1, category: "nope" }],
      summary: "One real issue.",
    },
    output: "",
  });
  assert.ok(!("error" in out));
  assert.equal(out.droppedFindingCount, 1);
  assert.equal(out.output.status, "complete");
  if (out.output.status === "complete") {
    assert.equal(out.output.findings.length, 1);
    assert.equal(out.output.findings[0].path, "src/a.ts");
  }
});

test("parseReviewOutput keeps a summary with no valid findings", () => {
  const out = parseReviewOutput({
    structuredOutput: {
      status: "complete",
      findings: [{ path: "src/b.ts", line: -1 }],
      summary: "Reviewed and found nothing to post.",
    },
    output: "",
  });
  assert.ok(!("error" in out));
  assert.equal(out.droppedFindingCount, 1);
  assert.deepEqual(out.output, {
    status: "complete",
    findings: [],
    summary: "Reviewed and found nothing to post.",
  });
});

test("parseReviewOutput fails only when there is no finding and no summary", () => {
  const out = parseReviewOutput({
    structuredOutput: { status: "complete", findings: [{ path: "a.ts" }] },
    output: "",
  });
  assert.ok("error" in out);
});

test("parseReviewOutput accepts valid findings without a summary", () => {
  const out = parseReviewOutput({
    structuredOutput: { status: "complete", findings: [goodFinding] },
    output: "",
  });
  assert.ok(!("error" in out));
  assert.equal(out.output.status, "complete");
  if (out.output.status === "complete") assert.equal(out.output.findings.length, 1);
});

test("parseReviewOutput counts a non-array findings value as one bad finding", () => {
  const out = parseReviewOutput({
    structuredOutput: { status: "complete", findings: "oops", summary: "clean" },
    output: "",
  });
  assert.ok(!("error" in out));
  assert.equal(out.droppedFindingCount, 1);
  assert.deepEqual(out.output, { status: "complete", findings: [], summary: "clean" });
});

test("parseReviewOutput does not approve when findings is missing", () => {
  const out = parseReviewOutput({
    structuredOutput: { status: "complete", summary: "looks clean to me" },
    output: "",
  });
  assert.ok(!("error" in out));
  assert.equal(out.droppedFindingCount, 1);
  assert.deepEqual(out.output, {
    status: "complete",
    findings: [],
    summary: "looks clean to me",
  });
});

test("parseReviewOutput prefers an earlier strict object over a trailing summary-only one", () => {
  const out = parseReviewOutput({
    output: `{"status":"complete","findings":[${JSON.stringify(goodFinding)}],"summary":"one bug"}\n{"status":"complete","summary":"clean"}`,
  });
  assert.ok(!("error" in out));
  assert.equal(out.droppedFindingCount, 0);
  assert.equal(out.output.status, "complete");
  if (out.output.status === "complete") {
    assert.equal(out.output.findings.length, 1);
    assert.equal(out.output.findings[0].path, "src/a.ts");
    assert.equal(out.output.summary, "one bug");
  }
});

test("parseReviewOutput prefers a findings array over a trailing bare summary", () => {
  const malformed = { ...goodFinding, line: -1 };
  const out = parseReviewOutput({
    output: `{"status":"complete","findings":[${JSON.stringify(malformed)}],"summary":"lossy"}\n{"status":"complete","summary":"clean"}`,
  });
  assert.ok(!("error" in out));
  assert.equal(out.droppedFindingCount, 1);
  assert.equal(out.output.status, "complete");
  if (out.output.status === "complete") assert.equal(out.output.summary, "lossy");
});

// The repair turn adds its spend to the local `costUsd`. Every path after the
// repair block must use that accumulated value, not the first session's cost,
// or a repaired run records an understated cost. Guard the source directly.
test("no callsite after the repair pass reads result.costUsd", () => {
  const source = readFileSync(join(__dirname, "run.ts"), "utf-8");
  const marker = "let costUsd = result.costUsd;";
  const start = source.indexOf(marker);
  assert.ok(start !== -1, "expected the repair cost accumulator");
  const after = source.slice(start + marker.length);
  assert.equal(after.includes("result.costUsd"), false);
});


// Case 11 of `docs/plan-gated-merges.md`'s corpus, "a commit pushed after
// approval", is the one corpus row main never implemented. It cannot be an
// eval replay: `replay.ts` scores one bundle at one sha through `decide()`, and
// `decide` is handed the findings, the two blocker counts and the gating result
// -- never an approval. A bundle for sha B has no sha-A approval to inherit, so
// a replay case would pass whatever the harness did, which tests nothing. The
// property is deterministic, so it is pinned here: on the two places that key
// state by sha, and on the one function that could carry a verdict forward.
const approvedAtA = {
  action: "approved" as const,
  runId: "a0000000-0000-4000-8000-00000000000a",
  repo: "thegoodparty/ops",
  prNumber: 42,
  baseSha: "aaaaaa",
  headSha: "a".repeat(40),
  trigger: "webhook" as const,
  agentVersion: "1.0.0",
  model: "claude-opus-4-5",
  startedAt: "2024-01-01T00:00:00.000Z",
  finishedAt: "2024-01-01T00:01:00.000Z",
  wallTimeMs: 60000,
  costUsd: null,
  bundle: {
    repo: "thegoodparty/ops",
    prNumber: 42,
    baseRef: "main",
    baseSha: "aaaaaa",
    headSha: "a".repeat(40),
    author: "swain",
    title: "t",
    body: "Plan: docs/x.md",
    diff: "",
    changedFiles: [],
    priorFindings: [],
  },
  output: { status: "complete" as const, findings: [], summary: "clean" },
  verdict: "approve" as const,
  gates: [],
  findings: [],
  droppedFindings: [],
  reviewId: 7,
};

// The per-sha S3 lock is "the whole gate": a second review of the same tree
// would land a second, possibly different verdict on it. That is also what
// stops a push from inheriting an approval -- B's lock and B's record key are
// different objects from A's. Keyed on (repo, pr) alone, a push would silently
// carry the approval over.
test("a record and its lock are keyed by sha, so a push cannot inherit an approval", () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  assert.equal(
    recordKey("thegoodparty/ops", 42, shaA, approvedAtA.runId),
    `reviews/thegoodparty/ops/42/${shaA}/${approvedAtA.runId}.json`,
  );
  assert.notEqual(
    recordKey("thegoodparty/ops", 42, shaB, approvedAtA.runId),
    recordKey("thegoodparty/ops", 42, shaA, approvedAtA.runId),
  );
  assert.notEqual(
    lockKey("thegoodparty/ops", 42, shaB),
    lockKey("thegoodparty/ops", 42, shaA),
  );
});

// The bot's answer at B is computed from B's own inputs. There is no parameter
// through which A's approval could arrive, which is *why* this is a unit test
// and not a replay: a clean, consistent PR at B approves on its own judgement,
// and a flagged one comments even though A was approved.
test("the verdict at B comes from B's inputs, never from A's approval", () => {
  const gatingAtB = {
    mode: "enforce" as const,
    binding: { path: "docs/x.md" },
    baseRef: "main",
    plan: { path: "docs/x.md", blobSha: "c".repeat(40) },
    authority: { checked: true, ownedPaths: [], reason: "" },
    flags: [],
  };
  const cleanAtB = decide(
    {
      status: "complete",
      findings: [],
      summary: "clean",
      planConsistency: { verdict: "consistent", reasoning: "step 1's own words" },
    },
    { gating: gatingAtB },
  );
  assert.equal(cleanAtB.action, "approve");

  const flaggedAtB = decide(
    {
      status: "complete",
      findings: [],
      summary: "clean",
      planConsistency: {
        verdict: "inconsistent",
        reasoning: "the step names the log group",
        departure: { plan: "the delegate log group", diff: "the playright bucket" },
      },
    },
    { gating: gatingAtB },
  );
  assert.equal(flaggedAtB.action, "comment");
  assert.deepEqual(flaggedAtB.gates, ["inconsistent"]);
});

// What a later run inherits from an earlier one is a prior *finding*, never a
// prior verdict: the agent re-decides every pass. An approval records no
// findings, so the one thing it could hand forward is nothing. That is the
// third way A's approval could have leaked into B, and it does not.
// (`priorFindingsFrom`'s finding-mapping is covered in `bundle.test.ts`.)
test("an approval carries no verdict and nothing else forward to the next sha", () => {
  const carried = priorFindingsFrom(approvedAtA as unknown as ReviewRecord);
  assert.deepEqual(carried, []);
});
