import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBody, renderFailureBody, renderReconsiderBody } from "./body";
import type { Decision } from "./gates";

const approveDecision: Decision = { verdict: "approve", action: "approve", gates: [] };
const commentDecision: Decision = { verdict: "comment", action: "comment", gates: [] };

const baseArgs = {
  decision: approveDecision,
  summary: "Reviewed the lock path and the anchor fallbacks; both leads were falsified against the tests.",
  runId: "00000000-0000-0000-0000-000000000001",
  headSha: "abc1234567890def",
  inlineCount: 0,
  carriedForward: [] as Array<{ id: string; path: string; line: number; url?: string }>,
};

describe("renderBody", () => {
  it("leads with the recommendation", () => {
    assert.ok(renderBody(baseArgs).startsWith("**Recommendation: approve**"));
    assert.ok(
      renderBody({ ...baseArgs, decision: commentDecision }).startsWith(
        "**Recommendation: comment**",
      ),
    );
  });

  it("an approve is the recommendation, the reasoning, and the footer", () => {
    const body = renderBody(baseArgs);
    assert.deepEqual(body.split("\n\n"), [
      "**Recommendation: approve**",
      "Reviewed the lock path and the anchor fallbacks; both leads were falsified against the tests.",
      "_run 00000000-0000-0000-0000-000000000001 · abc1234_",
    ]);
  });

  it("counts new inline findings instead of repeating them", () => {
    const body = renderBody({ ...baseArgs, decision: commentDecision, inlineCount: 3 });
    assert.ok(body.includes("3 new finding(s) inline"));
  });

  it("counts findings that could not be anchored instead of printing them", () => {
    const body = renderBody({ ...baseArgs, decision: commentDecision, droppedCount: 2 });
    assert.ok(body.includes("2 finding(s) pointed at files outside the diff"));
  });

  it("surfaces findings that could not be parsed from the output", () => {
    const body = renderBody({ ...baseArgs, unparseableCount: 2 });
    assert.ok(body.includes("2 finding(s) in the reviewer's output did not match the review schema"));
  });

  it("lists prior findings still open with links when available", () => {
    const body = renderBody({
      ...baseArgs,
      decision: commentDecision,
      carriedForward: [
        { id: "a", path: "src/a.ts", line: 3, url: "https://x/1" },
        { id: "b", path: "src/b.ts", line: 9 },
      ],
    });
    assert.ok(body.includes("2 prior finding(s) still open:"));
    assert.ok(body.includes("- [src/a.ts:3](https://x/1)"));
    assert.ok(body.includes("- src/b.ts:9"));
  });

  it("ends with the run footer", () => {
    assert.ok(renderBody(baseArgs).endsWith("_run 00000000-0000-0000-0000-000000000001 · abc1234_"));
  });
});

describe("renderFailureBody", () => {
  it("names it as a reviewer failure and says how to retry", () => {
    const body = renderFailureBody({ runId: "r1", headSha: "abc1234567" });
    assert.ok(body.startsWith("**Review failed.**"));
    assert.ok(body.includes("reviewer failure"));
    assert.ok(body.includes("not an approval"));
    assert.ok(body.includes("Push a new commit, then comment `delegate review`"));
    assert.ok(body.endsWith("_run r1 · abc1234_"));
  });

  it("links the run logs when a url is given", () => {
    const body = renderFailureBody({ runId: "r1", headSha: "abc1234567", logsUrl: "https://logs" });
    assert.ok(body.includes("[run logs](https://logs)"));
  });

  it("never interpolates a raw validation error", () => {
    const body = renderFailureBody({ runId: "r1", headSha: "abc1234567" });
    assert.ok(!body.includes("invalid_format"));
    assert.ok(!body.includes("uuid"));
  });
});

describe("renderReconsiderBody", () => {
  const args = {
    verdict: "approve" as const,
    summary: "Both answers held up against the code.",
    runId: "00000000-0000-0000-0000-000000000002",
    reconsideredRunId: "00000000-0000-0000-0000-000000000001",
    headSha: "abc1234567890def",
    withdrawn: [{ path: "src/a.ts", line: 3, url: "https://x/1" }],
    stillOpen: [] as Array<{ path: string; line: number; url?: string }>,
    droppedCount: 0,
  };

  it("an approval lists what was withdrawn and names both runs", () => {
    assert.deepEqual(renderReconsiderBody(args).split("\n\n"), [
      "**Recommendation: approve**",
      "Both answers held up against the code.",
      "Withdrew 1 finding(s) after the replies in their threads:\n- [src/a.ts:3](https://x/1)",
      "_reconsidered run 00000000-0000-0000-0000-000000000001 · run 00000000-0000-0000-0000-000000000002 · abc1234_",
    ]);
  });

  it("says what is still open and how to move it", () => {
    const body = renderReconsiderBody({
      ...args,
      verdict: "comment",
      withdrawn: [],
      stillOpen: [{ path: "src/b.ts", line: 9 }],
      droppedCount: 1,
    });
    assert.ok(body.startsWith("**Recommendation: comment**"));
    assert.ok(body.includes("1 finding(s) still open:\n- src/b.ts:9"));
    assert.ok(body.includes("comment `delegate reconsider` again"));
    assert.ok(body.includes("1 finding(s) pointed at files outside the diff"));
  });
});
