import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBody, renderFailureBody } from "./body";
import type { Finding } from "./schema";
import type { Decision } from "./gates";

const approveDecision: Decision = { verdict: "approve", action: "approve", gates: [] };
const commentDecision: Decision = { verdict: "comment", action: "comment", gates: [] };
const gatedDecision: Decision = {
  verdict: "approve",
  action: "comment",
  gates: ["never-approve-author"],
};

const baseArgs = {
  decision: approveDecision,
  summary: "Looks good",
  runId: "00000000-0000-0000-0000-000000000001",
  headSha: "abc1234567890def",
  author: "swain",
  carriedForward: [] as Array<{ id: string; path: string; line: number; url?: string }>,
  demoted: [] as Finding[],
};

describe("renderBody", () => {
  it("first line is Recommendation: approve for approve verdict", () => {
    const body = renderBody(baseArgs);
    assert.ok(body.startsWith("**Recommendation: approve**"));
  });

  it("first line is Recommendation: comment for comment verdict", () => {
    const body = renderBody({ ...baseArgs, decision: commentDecision });
    assert.ok(body.startsWith("**Recommendation: comment**"));
  });

  it("includes the summary text", () => {
    const body = renderBody(baseArgs);
    assert.ok(body.includes("Looks good"));
  });

  it("includes the never-approve gate message with author name", () => {
    const body = renderBody({ ...baseArgs, decision: gatedDecision });
    assert.ok(body.includes("never-approve list"));
    assert.ok(body.includes("swain"));
    assert.ok(body.includes("human must approve"));
  });

  it("does not include gate message when no gates", () => {
    const body = renderBody(baseArgs);
    assert.ok(!body.includes("never-approve list"));
  });

  it("lists carried-forward findings with link when url is present", () => {
    const cf = [
      { id: "aaa", path: "foo.ts", line: 10, url: "https://github.com/org/repo/pull/1#comment-123" },
    ];
    const body = renderBody({ ...baseArgs, carriedForward: cf });
    assert.ok(body.includes("1 prior finding(s) still open:"));
    assert.ok(body.includes("[foo.ts:10](https://github.com/org/repo/pull/1#comment-123)"));
  });

  it("lists carried-forward findings as plain path:line when no url", () => {
    const cf = [{ id: "bbb", path: "bar.ts", line: 20 }];
    const body = renderBody({ ...baseArgs, carriedForward: cf });
    assert.ok(body.includes("1 prior finding(s) still open:"));
    assert.ok(body.includes("- bar.ts:20"));
    assert.ok(!body.includes("[bar.ts:20]("));
  });

  it("uses correct count for multiple carried-forward items", () => {
    const cf = [
      { id: "aaa", path: "a.ts", line: 1 },
      { id: "bbb", path: "b.ts", line: 2, url: "https://example.com" },
    ];
    const body = renderBody({ ...baseArgs, carriedForward: cf });
    assert.ok(body.includes("2 prior finding(s) still open:"));
  });

  it("omits carried-forward section when empty", () => {
    const body = renderBody(baseArgs);
    assert.ok(!body.includes("prior finding"));
  });

  it("renders demoted findings as ### sections", () => {
    const finding: Finding = {
      path: "src/service.ts",
      line: 42,
      body: "Missing null check here",
      category: "bugs",
      confidence: "high",
    };
    const body = renderBody({ ...baseArgs, demoted: [finding] });
    assert.ok(body.includes("### src/service.ts:42"));
    assert.ok(body.includes("Missing null check here"));
  });

  it("includes footer with sha7 (first 7 chars of headSha)", () => {
    const body = renderBody(baseArgs);
    assert.ok(body.includes("_run 00000000-0000-0000-0000-000000000001 · abc1234_"));
  });

  it("sections are separated by blank lines", () => {
    const body = renderBody(baseArgs);
    assert.ok(body.includes("\n\n"));
  });
});

describe("renderFailureBody", () => {
  it("includes failure reason and re-trigger instruction", () => {
    const body = renderFailureBody({
      runId: "00000000-0000-0000-0000-000000000002",
      headSha: "deadbeef1234",
      reason: "agent timed out",
    });
    assert.ok(body.includes("Review failed: agent timed out"));
    assert.ok(body.includes("`delegate review`"));
  });

  it("includes footer with sha7", () => {
    const body = renderFailureBody({
      runId: "00000000-0000-0000-0000-000000000002",
      headSha: "deadbeef1234",
      reason: "crash",
    });
    assert.ok(body.includes("_run 00000000-0000-0000-0000-000000000002 · deadbee_"));
  });
});
