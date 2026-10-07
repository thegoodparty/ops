import type { ReviewOutput } from "./schema";

// Who may merge is GitHub's job (classic branch protection restricts pushes
// to main to humans). The only question left here is whether the code is
// clean, and a finding is a blocker by definition.
export type Decision = {
  verdict: "approve" | "comment";
  action: "approve" | "comment";
  gates: string[];
};

export const decide = (
  output: Extract<ReviewOutput, { status: "complete" }>,
): Decision => {
  const verdict: "approve" | "comment" =
    output.findings.length === 0 ? "approve" : "comment";
  return { verdict, action: verdict, gates: [] };
};
