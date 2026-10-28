import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBody, renderFailureBody } from "./body";
import type { Decision, DecisionGating, FindingsVerdict } from "./gates";

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

describe("renderBody with the gate on", () => {
  const plan = { path: "docs/plan-gated-merges.md", blobSha: "1c7ac96f062c9263697f7208056f9941e4dc499a" };
  const gating = (over: Partial<DecisionGating>): DecisionGating => ({
    mode: "enforce",
    wouldApprove: false,
    binding: { path: plan.path, step: 4 },
    baseRef: "main",
    plan,
    flags: [],
    ownedPaths: [],
    ...over,
  });
  const gated = (
    g: DecisionGating,
    findings: FindingsVerdict = { verdict: "none", count: 0 },
  ): Decision => ({
    verdict: g.mode === "enforce" && g.wouldApprove ? "approve" : "comment",
    action: g.mode === "enforce" && g.wouldApprove ? "approve" : "comment",
    gates: g.flags,
    findingsVerdict: findings,
    gating: g,
  });
  const withFindings: FindingsVerdict = { verdict: "findings", count: 2 };

  it("says nothing when the gate did not run", () => {
    const body = renderBody(baseArgs);
    assert.ok(!body.includes("Gate:"));
    assert.ok(!body.includes("Shadow"));
  });

  it("an approval names the plan and the blob sha it was checked against", () => {
    const body = renderBody({
      ...baseArgs,
      decision: gated(gating({ wouldApprove: true })),
    });
    assert.deepEqual(body.split("\n\n"), [
      "**Recommendation: approve**",
      "**Gate: approve** against `docs/plan-gated-merges.md` at `1c7ac96`." +
        " Every changed path is unowned in `CODEOWNERS` on `main`, and the change is consistent with the plan.",
      baseArgs.summary,
      "_run 00000000-0000-0000-0000-000000000001 · abc1234_",
    ]);
  });

  it("a flag says which case fired and why", () => {
    const body = renderBody({
      ...baseArgs,
      decision: gated(gating({ flags: ["touches_docs"] })),
    });
    assert.ok(body.includes("**Gate: comment** against `docs/plan-gated-merges.md` at `1c7ac96`."));
    assert.ok(
      body.includes(
        "Flags: `touches_docs`: the PR adds or changes something under `docs/`, so the spec and the work would move together.",
      ),
    );
  });

  it("names the owned paths when that is the flag", () => {
    const body = renderBody({
      ...baseArgs,
      decision: gated(
        gating({ flags: ["owned_paths"], ownedPaths: ["delegate/review/gating.ts", "deploy/index.ts"] }),
      ),
    });
    assert.ok(body.includes("(delegate/review/gating.ts, deploy/index.ts)"));
  });

  it("says when a plan was never read", () => {
    const body = renderBody({
      ...baseArgs,
      decision: gated(gating({ plan: undefined, binding: {}, flags: ["no_binding"] })),
    });
    assert.ok(body.includes("**Gate: comment** with no plan read."));
    assert.ok(body.includes("`no_binding`"));
  });

  it("a shadow run says it would have approved, and that it cannot", () => {
    const body = renderBody({
      ...baseArgs,
      decision: gated(gating({ mode: "shadow", wouldApprove: true })),
    });
    assert.ok(
      body.includes("**Gate: shadow, would have approved** against `docs/plan-gated-merges.md` at `1c7ac96`."),
    );
    assert.ok(body.includes("Shadow mode records the decision and posts a comment, never an approval."));
    assert.ok(body.startsWith("**Recommendation: comment**"));
  });

  it("a shadow run that would have flagged carries the reason too", () => {
    const body = renderBody({
      ...baseArgs,
      decision: gated(gating({ mode: "shadow", flags: ["inconsistent"] })),
    });
    assert.ok(body.includes("**Gate: shadow, would have commented**"));
    assert.ok(body.includes("Flags: `inconsistent`: the change is not consistent with the plan."));
  });

  // The reason this exists: a reader could not tell "the reviewer found nothing
  // wrong, the gate blocked it" from "the reviewer found problems", and those
  // need opposite human replies. Each of the five gate cases is rendered twice,
  // once with no findings and once with two.
  const gateCases: Array<{ flag: DecisionGating["flags"][number]; detail: string }> = [
    { flag: "no_binding", detail: "the PR body has no `Plan:` line" },
    { flag: "invalid_binding", detail: "is not a repo-relative `docs/**.md` document" },
    { flag: "ambiguous_binding", detail: "names more than one plan" },
    { flag: "unverifiable_authority", detail: "has no `*` default" },
    { flag: "owned_paths", detail: "deploy/index.ts" },
  ];

  for (const { flag, detail } of gateCases) {
    const gate = (): DecisionGating =>
      gating({
        flags: [flag],
        ownedPaths: flag === "owned_paths" ? ["deploy/index.ts"] : [],
      });

    it(`${flag} with no findings says the gate alone blocked it`, () => {
      const body = renderBody({ ...baseArgs, decision: gated(gate()) });
      assert.ok(body.includes("**Recommendation: comment**"));
      assert.ok(body.includes("**Findings: none.**"));
      assert.ok(body.includes(`**Gate: comment** against \`docs/plan-gated-merges.md\``));
      assert.ok(body.includes(detail));
      assert.ok(
        body.includes(
          "No findings: the changes look approvable, and the gate alone is why this is a comment rather than an approval.",
        ),
      );
      assert.ok(body.includes("A human still has to approve this PR"));
      assert.equal(body.includes("The findings are why"), false);
    });

    it(`${flag} with findings says the findings came too`, () => {
      const body = renderBody({ ...baseArgs, decision: gated(gate(), withFindings) });
      assert.ok(body.includes("**Recommendation: comment**"));
      assert.ok(body.includes("**Findings: 2 finding(s).**"));
      assert.ok(body.includes(`**Gate: comment** against \`docs/plan-gated-merges.md\``));
      assert.ok(body.includes(detail));
      assert.ok(
        body.includes(
          "The findings are why this is not an approval, and the gate flagged the PR independently.",
        ),
      );
      assert.equal(body.includes("No findings:"), false);
    });
  }

  it("a findings-only comment says the findings are the whole reason", () => {
    const body = renderBody({ ...baseArgs, decision: gated(gating({}), withFindings) });
    assert.ok(body.includes("**Findings: 2 finding(s).**"));
    assert.ok(body.includes("The findings are why this is not an approval."));
    assert.equal(body.includes("flagged the PR independently"), false);
  });

  it("a shadow comment keeps the findings verdict separate from the would-have line", () => {
    const body = renderBody({
      ...baseArgs,
      decision: gated(gating({ mode: "shadow", wouldApprove: true })),
    });
    assert.ok(body.includes("**Findings: none.**"));
    assert.ok(
      body.includes(
        "No findings: the changes look approvable, and shadow mode alone is why this is a comment rather than an approval.",
      ),
    );
    assert.ok(body.includes("A human still has to approve this PR"));
  });

  it("a shadow comment with no findings but a flag does not blame shadow alone", () => {
    // Shadow withholds on its own only when no flag fired. With a flag the
    // gate would have blocked an approval too, and the gate line in the same
    // body says "would have commented", so the sentence must not contradict it.
    const body = renderBody({
      ...baseArgs,
      decision: gated(
        gating({ mode: "shadow", flags: ["owned_paths"], ownedPaths: ["deploy/index.ts"] }),
      ),
    });
    assert.ok(body.includes("**Findings: none.**"));
    assert.ok(body.includes("**Gate: shadow, would have commented**"));
    assert.ok(
      body.includes(
        "No findings: the changes look approvable, but the gate flagged the PR as well, and shadow mode posts a comment either way.",
      ),
    );
    assert.equal(body.includes("shadow mode alone"), false);
    assert.ok(body.includes("A human still has to approve this PR"));
  });

  it("an approval does not gain a findings line", () => {
    // Approved: there is nothing withheld to explain, and the body is what it
    // was before this existed.
    const body = renderBody({
      ...baseArgs,
      decision: gated(gating({ wouldApprove: true }), { verdict: "none", count: 0 }),
    });
    assert.ok(body.startsWith("**Recommendation: approve**"));
    assert.equal(body.includes("**Findings:"), false);
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
