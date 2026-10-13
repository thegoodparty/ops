import type { Decision } from "./gates";

// Findings are inline comments, never body text. The body carries the verdict,
// the agent's reasoning for it (so a human can check that the PR description,
// the review and the code agree), and the bookkeeping a reader needs to trust it.
export const renderBody = (args: {
  decision: Decision;
  summary: string;
  runId: string;
  headSha: string;
  inlineCount: number;
  droppedCount?: number;
  unparseableCount?: number;
  carriedForward: Array<{ id: string; path: string; line: number; url?: string }>;
}): string => {
  const parts: string[] = [];
  const sha7 = args.headSha.slice(0, 7);

  parts.push(`**Recommendation: ${args.decision.verdict}**`);
  parts.push(args.summary.trim());

  if (args.inlineCount > 0) {
    parts.push(
      `${args.inlineCount} new finding(s) inline. Each one blocks merge on its own. Push a fix, then comment \`delegate review\`.`,
    );
  }

  if (args.droppedCount) {
    parts.push(
      `${args.droppedCount} finding(s) pointed at files outside the diff and could not be posted inline. They count against approval; the run record has them.`,
    );
  }

  if (args.unparseableCount) {
    parts.push(
      `${args.unparseableCount} finding(s) in the reviewer's output did not match the review schema and could not be posted. This is a reviewer defect, not a clean result; they count against approval. The run logs have the validation error.`,
    );
  }

  if (args.carriedForward.length > 0) {
    const n = args.carriedForward.length;
    const bullets = args.carriedForward.map((cf) => {
      const label = `${cf.path}:${cf.line}`;
      return cf.url ? `- [${label}](${cf.url})` : `- ${label}`;
    });
    parts.push(`${n} prior finding(s) still open:\n${bullets.join("\n")}`);
  }

  parts.push(`_run ${args.runId} · ${sha7}_`);

  return parts.join("\n\n");
};

// A reviewer failure is not a verdict. The body is deliberately short and
// free of raw model or Zod output: the validation error goes to the logs, and
// the check stays non-success so a failed review can never read as approval.
export const renderFailureBody = (args: {
  runId: string;
  headSha: string;
  logsUrl?: string;
}): string => {
  const sha7 = args.headSha.slice(0, 7);
  const footer = `_run ${args.runId} · ${sha7}_`;
  const logs = args.logsUrl
    ? ` The full validation error is in the [run logs](${args.logsUrl}).`
    : " The full validation error is in the run logs.";
  return [
    `**Review failed.** The reviewer hit an internal error on \`${sha7}\` and did not produce a verdict. This is a reviewer failure, not an approval or a clean result; the \`pr-reviewer\` check is marked as an error.`,
    `Push a new commit, then comment \`delegate review\` to retry.${logs}`,
    footer,
  ].join("\n\n");
};
