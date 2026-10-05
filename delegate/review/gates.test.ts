import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NEVER_APPROVE_AUTHORS, decide } from "./gates";
import type { Finding } from "./schema";

const baseFinding: Finding = {
  path: "foo.ts",
  line: 1,
  body: "a real issue",
  category: "bugs",
  confidence: "high",
};

describe("NEVER_APPROVE_AUTHORS", () => {
  it("contains bugboss-gp[bot] as the first entry", () => {
    assert.ok(NEVER_APPROVE_AUTHORS.has("bugboss-gp[bot]"));
  });

  it("does not contain ordinary human logins", () => {
    assert.ok(!NEVER_APPROVE_AUTHORS.has("swain"));
    assert.ok(!NEVER_APPROVE_AUTHORS.has(""));
  });
});

describe("decide", () => {
  it("returns verdict approve and action approve when no findings and author not gated", () => {
    const output = { status: "complete" as const, findings: [], summary: "LGTM" };
    const decision = decide(output, { author: "swain" });
    assert.equal(decision.verdict, "approve");
    assert.equal(decision.action, "approve");
    assert.deepEqual(decision.gates, []);
  });

  it("returns verdict comment and action comment when findings are present", () => {
    const output = {
      status: "complete" as const,
      findings: [baseFinding],
      summary: "has issues",
    };
    const decision = decide(output, { author: "swain" });
    assert.equal(decision.verdict, "comment");
    assert.equal(decision.action, "comment");
    assert.deepEqual(decision.gates, []);
  });

  it("gates never-approve-author: verdict approve but action comment", () => {
    const output = { status: "complete" as const, findings: [], summary: "LGTM" };
    const decision = decide(output, { author: "bugboss-gp[bot]" });
    assert.equal(decision.verdict, "approve");
    assert.equal(decision.action, "comment");
    assert.ok(decision.gates.includes("never-approve-author"));
  });

  it("gates never-approve-author even when findings also present", () => {
    const output = {
      status: "complete" as const,
      findings: [baseFinding],
      summary: "has issues",
    };
    const decision = decide(output, { author: "bugboss-gp[bot]" });
    assert.equal(decision.verdict, "comment");
    assert.equal(decision.action, "comment");
    assert.ok(decision.gates.includes("never-approve-author"));
  });
});
