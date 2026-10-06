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

export const renderFailureBody = (args: {
  runId: string;
  headSha: string;
  reason: string;
}): string => {
  const sha7 = args.headSha.slice(0, 7);
  const footer = `_run ${args.runId} · ${sha7}_`;
  return `Review failed: ${args.reason}. Push a new commit, then comment \`delegate review\`.\n\n${footer}`;
};
