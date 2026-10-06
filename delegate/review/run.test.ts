import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, latestCompletedRecord, parseReviewOutput, pathGuardHook } from "./run";
import type { ReviewRecord } from "./schema";

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
  assert.deepEqual(out, { status: "complete", findings: [], summary: "clean" });
});

test("parseReviewOutput falls back to the text result", () => {
  const out = parseReviewOutput({
    output: JSON.stringify({ status: "failed", reason: "scout failed" }),
  });
  assert.deepEqual(out, { status: "failed", reason: "scout failed" });
});

test("parseReviewOutput rejects a verdict the agent is not allowed to emit", () => {
  const out = parseReviewOutput({
    structuredOutput: { status: "complete", verdict: "approve", findings: [{ path: "a.ts" }] },
    output: "",
  });
  assert.ok("error" in out);
  assert.match(out.error, /failed schema/);
});

test("parseReviewOutput finds the JSON when the model wraps it in prose", () => {
  const out = parseReviewOutput({
    output: `All four deep-reviewers returned zero findings. Every lead was falsified:

1. **Thing**: not a bug {see line 3}

{"status":"complete","findings":[],"summary":"Reviewed the \\"diff\\"; clean."}

Done.`,
  });
  assert.deepEqual(out, {
    status: "complete",
    findings: [],
    summary: 'Reviewed the "diff"; clean.',
  });
});

test("parseReviewOutput ignores an unmatched quote in the prose", () => {
  const out = parseReviewOutput({
    output: `Here's the "result:\n{"status":"complete","findings":[],"summary":"clean"}`,
  });
  assert.deepEqual(out, { status: "complete", findings: [], summary: "clean" });
});

test("parseReviewOutput reports non-JSON text", () => {
  const out = parseReviewOutput({ output: "I approve this PR." });
  assert.ok("error" in out);
  assert.match(out.error, /no JSON/);
});

