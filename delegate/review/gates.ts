import type { ReviewOutput } from "./schema";

// Who may merge is GitHub's job (classic branch protection restricts pushes
// to main to humans). The only question left here is whether the code is
// clean, and a finding is a blocker by definition.
export type Decision = {
  verdict: "approve" | "comment";
  action: "approve" | "comment";
  gates: string[];
};

// `unparseableCount` is the number of findings the model emitted that failed
// the schema and were dropped. A dropped finding is not a clean result: it
// blocks approval exactly like a finding that could not be anchored does,
// even though it cannot be posted. It never fails the review on its own.
export const decide = (
  output: Extract<ReviewOutput, { status: "complete" }>,
  opts: { unparseableCount?: number } = {},
): Decision => {
  const unparseable = (opts.unparseableCount ?? 0) > 0;
  const verdict: "approve" | "comment" =
    output.findings.length === 0 && !unparseable ? "approve" : "comment";
  return {
    verdict,
    action: verdict,
    gates: unparseable ? ["unparseable_findings"] : [],
  };
};
