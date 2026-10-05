import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, parseReviewOutput } from "./run";

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

test("parseReviewOutput reports non-JSON text", () => {
  const out = parseReviewOutput({ output: "I approve this PR." });
  assert.ok("error" in out);
  assert.match(out.error, /no JSON/);
});
