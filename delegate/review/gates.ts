import type { GatingFlag, GatingMode, GatingResult } from "./gating";
import { consistencyFlag } from "./gating";
import type { ReviewOutput } from "./schema";

// The verdict is now two questions, in this order.
//
// 1. Is there authority to approve at all? Deterministic, and not the model's
//    to answer: is the repo gated, is the base ref `main`, does a `Plan:`
//    binding resolve on `main`, does every changed path resolve to no owner in
//    `CODEOWNERS` on `main`, does the PR leave `docs/` alone? Authority is
//    derived from `CODEOWNERS` and never asserted by the model, so a prompt
//    injection in a diff or a PR body cannot mint it.
// 2. Is the code clean, and did it do the plan? The finding gate unchanged,
//    plus the model's one consistency answer; a finding is a blocker by
//    definition.
//
// `approve` requires both halves, so the verdict is "clean, and within the
// authority a merged plan grants it". A failure in either half is a comment
// rather than an error, because a comment is what sends the PR to a human --
// which is exactly where every PR in this repo goes today. GitHub still
// decides mergeability and still decides who a code owner is; nothing here
// replaces that, and `delegate` is never a required check. The design is
// `docs/plan-gated-merges.md`.
export type Decision = {
  verdict: "approve" | "comment";
  action: "approve" | "comment";
  gates: string[];
  /**
   * The gate's reasoning, for the review body. Present only when the gate ran
   * (`DELEGATE_GATING_MODE` is not `off` and the repo has adopted gating), so
   * an ungated review is byte-for-byte the review it was before this existed.
   */
  gating?: DecisionGating;
};

export type DecisionGating = {
  mode: GatingMode;
  /** What the gate would have decided with no mode in the way. */
  wouldApprove: boolean;
  binding: { path?: string; step?: number };
  baseRef: string;
  plan?: { path: string; blobSha: string };
  flags: GatingFlag[];
  ownedPaths: string[];
};

// `unparseableCount` is the number of findings the model emitted that failed
// the schema and were dropped. A dropped finding is not a clean result: it
// blocks approval exactly like a finding that could not be anchored does,
// even though it cannot be posted. It never fails the review on its own.
//
// `gating` is the deterministic result from `gating.ts`. When it is absent the
// gate did not run and this function is what it was before the gate existed.
// When it is present, case 5 (the model's consistency answer) is folded in
// here, because that answer is part of the model's output, and `shadow` is
// forced to a comment regardless of what the two halves add up to.
export const decide = (
  output: Extract<ReviewOutput, { status: "complete" }>,
  opts: { unparseableCount?: number; gating?: GatingResult } = {},
): Decision => {
  const unparseable = (opts.unparseableCount ?? 0) > 0;
  const clean = output.findings.length === 0 && !unparseable;
  const unparseableGates = unparseable ? ["unparseable_findings"] : [];
  const gating = opts.gating;

  if (gating === undefined) {
    const verdict: "approve" | "comment" = clean ? "approve" : "comment";
    return { verdict, action: verdict, gates: unparseableGates };
  }

  const flags: GatingFlag[] = [...gating.flags];
  // Case 5 is asked only when a plan was put in front of the model. With no
  // plan there is no answer to score, and "no answer" is not a second flag on
  // top of the binding one that already sent the PR to a human.
  if (gating.plan !== undefined) {
    const flag = consistencyFlag(output.planConsistency?.verdict);
    if (flag !== undefined) flags.push(flag);
  }

  const wouldApprove = clean && flags.length === 0;
  const verdict: "approve" | "comment" =
    gating.mode === "enforce" && wouldApprove ? "approve" : "comment";

  return {
    verdict,
    action: verdict,
    gates: [...unparseableGates, ...flags],
    gating: {
      mode: gating.mode,
      wouldApprove,
      binding: gating.binding,
      baseRef: gating.baseRef,
      ...(gating.plan !== undefined ? { plan: gating.plan } : {}),
      flags,
      ownedPaths: gating.authority.ownedPaths,
    },
  };
};
