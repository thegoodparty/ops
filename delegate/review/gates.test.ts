import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./gates";
import type { GatingResult } from "./gating";
import type { Finding } from "./schema";

const finding: Finding = {
  path: "src/a.ts",
  line: 3,
  body: "bug",
  category: "bugs",
  confidence: "high",
};

// The gate ran and found everything in order: a merged plan, unowned paths, a
// base ref of main. Each test below breaks exactly one of those, or the mode.
const clearGating: GatingResult = {
  mode: "enforce",
  binding: { path: "docs/plan-gated-merges.md", step: 4 },
  baseRef: "main",
  plan: { path: "docs/plan-gated-merges.md", blobSha: "1c7ac96f062c9263697f7208056f9941e4dc499a" },
  authority: { checked: true, ownedPaths: [], reason: "every changed path is unowned in CODEOWNERS on main" },
  flags: [],
};

const consistent = { verdict: "consistent" as const, reasoning: "step 4 of the plan" };

describe("decide", () => {
  it("approves when there are no findings", () => {
    const d = decide({ status: "complete", findings: [], summary: "clean" });
    assert.deepEqual(d, { verdict: "approve", action: "approve", gates: [] });
  });

  it("comments when any finding exists", () => {
    const d = decide({ status: "complete", findings: [finding], summary: "one bug" });
    assert.deepEqual(d, { verdict: "comment", action: "comment", gates: [] });
  });

  it("does not approve when findings were dropped as unparseable", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "one finding was dropped" },
      { unparseableCount: 1 },
    );
    assert.deepEqual(d, {
      verdict: "comment",
      action: "comment",
      gates: ["unparseable_findings"],
    });
  });

  it("is unchanged when the gate did not run", () => {
    // `DELEGATE_GATING_MODE=off`, the default, and every repo that has not
    // adopted gating. No `gating` key is added, so the body and the record are
    // what they were before the gate existed.
    const d = decide({ status: "complete", findings: [], summary: "clean" }, { gating: undefined });
    assert.deepEqual(d, { verdict: "approve", action: "approve", gates: [] });
    assert.equal("gating" in d, false);
  });
});

describe("decide with the gate on", () => {
  it("approves under enforce when clean, unowned and consistent", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean", planConsistency: consistent },
      { gating: clearGating },
    );
    assert.deepEqual(d, {
      verdict: "approve",
      action: "approve",
      gates: [],
      gating: {
        mode: "enforce",
        wouldApprove: true,
        binding: { path: "docs/plan-gated-merges.md", step: 4 },
        baseRef: "main",
        plan: clearGating.plan,
        flags: [],
        ownedPaths: [],
      },
    });
  });

  it("never approves under shadow, even when everything is in order", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean", planConsistency: consistent },
      { gating: { ...clearGating, mode: "shadow" } },
    );
    assert.equal(d.verdict, "comment");
    assert.equal(d.action, "comment");
    assert.deepEqual(d.gates, []);
    assert.equal(d.gating?.wouldApprove, true);
    assert.equal(d.gating?.mode, "shadow");
  });

  it("flags case 1: no Plan: binding", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean" },
      { gating: { ...clearGating, binding: {}, plan: undefined, flags: ["no_binding"] } },
    );
    assert.equal(d.verdict, "comment");
    assert.deepEqual(d.gates, ["no_binding"]);
  });

  it("flags case 2: an ambiguous binding", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean" },
      { gating: { ...clearGating, plan: undefined, flags: ["ambiguous_binding"] } },
    );
    assert.deepEqual(d.gates, ["ambiguous_binding"]);
  });

  it("flags case 3: the plan is not on main", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean" },
      { gating: { ...clearGating, plan: undefined, flags: ["plan_not_on_main"] } },
    );
    assert.deepEqual(d.gates, ["plan_not_on_main"]);
  });

  it("flags case 4: the PR touches docs/", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean", planConsistency: consistent },
      { gating: { ...clearGating, flags: ["touches_docs"] } },
    );
    assert.deepEqual(d.gates, ["touches_docs"]);
  });

  it("flags a changed path CODEOWNERS owns", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean", planConsistency: consistent },
      {
        gating: {
          ...clearGating,
          authority: { checked: true, ownedPaths: ["delegate/review/gating.ts"], reason: "1 owned" },
          flags: ["owned_paths"],
        },
      },
    );
    assert.equal(d.verdict, "comment");
    assert.deepEqual(d.gates, ["owned_paths"]);
    assert.deepEqual(d.gating?.ownedPaths, ["delegate/review/gating.ts"]);
  });

  it("flags case 5: the model says inconsistent", () => {
    const d = decide(
      {
        status: "complete",
        findings: [],
        summary: "clean",
        planConsistency: { verdict: "inconsistent", reasoning: "the plan names another component" },
      },
      { gating: clearGating },
    );
    assert.equal(d.verdict, "comment");
    assert.deepEqual(d.gates, ["inconsistent"]);
  });

  it("flags case 5: the model says unclear", () => {
    const d = decide(
      {
        status: "complete",
        findings: [],
        summary: "clean",
        planConsistency: { verdict: "unclear", reasoning: "not enough detail" },
      },
      { gating: clearGating },
    );
    assert.deepEqual(d.gates, ["unclear_consistency"]);
  });

  it("flags case 5: the model gave no answer at all", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean" },
      { gating: clearGating },
    );
    assert.deepEqual(d.gates, ["no_consistency_answer"]);
  });

  it("does not score case 5 when no plan reached the model", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "clean" },
      { gating: { ...clearGating, plan: undefined, flags: ["no_binding"] } },
    );
    assert.deepEqual(d.gates, ["no_binding"]);
  });

  it("keeps a finding a blocker whatever the gate says", () => {
    const d = decide(
      { status: "complete", findings: [finding], summary: "one bug", planConsistency: consistent },
      { gating: clearGating },
    );
    assert.equal(d.verdict, "comment");
    assert.deepEqual(d.gates, []);
    assert.equal(d.gating?.wouldApprove, false);
  });

  it("keeps unparseable findings a blocker alongside the gating flags", () => {
    const d = decide(
      { status: "complete", findings: [], summary: "lossy", planConsistency: consistent },
      { gating: { ...clearGating, flags: ["touches_docs"] }, unparseableCount: 1 },
    );
    assert.deepEqual(d.gates, ["unparseable_findings", "touches_docs"]);
  });
});
