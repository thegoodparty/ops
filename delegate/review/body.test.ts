import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBody, renderFailureBody } from "./body";
import type { Decision } from "./gates";

const approveDecision: Decision = { verdict: "approve", action: "approve", gates: [] };
const commentDecision: Decision = { verdict: "comment", action: "comment", gates: [] };

const baseArgs = {
  decision: approveDecision,
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

  it("contains no model text: an approve is the recommendation and the footer only", () => {
    const body = renderBody(baseArgs);
    assert.deepEqual(body.split("\n\n"), [
      "**Recommendation: approve**",
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
  it("names the reason and the run", () => {
    const body = renderFailureBody({ runId: "r1", headSha: "abc1234567", reason: "agent crashed" });
    assert.ok(body.startsWith("Review failed: agent crashed."));
    assert.ok(body.includes("Push a new commit, then comment `delegate review`"));
    assert.ok(body.endsWith("_run r1 · abc1234_"));
  });
});
