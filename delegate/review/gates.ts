import type { ReviewOutput } from "./schema";

export const NEVER_APPROVE_AUTHORS: Set<string> = new Set(["bugboss-gp[bot]"]);

export type Decision = {
  verdict: "approve" | "comment";
  action: "approve" | "comment";
  gates: string[];
};

export const decide = (
  output: Extract<ReviewOutput, { status: "complete" }>,
  ctx: { author: string },
): Decision => {
  const verdict: "approve" | "comment" =
    output.findings.length === 0 ? "approve" : "comment";

  const gates: string[] = [];
  if (NEVER_APPROVE_AUTHORS.has(ctx.author)) {
    gates.push("never-approve-author");
  }

  const action: "approve" | "comment" =
    verdict === "approve" && gates.length === 0 ? "approve" : "comment";

  return { verdict, action, gates };
};
