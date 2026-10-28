import { GATING_FLAG_REASON, type GatingFlag } from "./gating";
import type { Decision, DecisionGating, FindingsVerdict } from "./gates";

const flagText = (flag: GatingFlag, g: DecisionGating): string => {
  const reason = GATING_FLAG_REASON[flag];
  if (flag === "owned_paths" && g.ownedPaths.length > 0) {
    const shown = g.ownedPaths.slice(0, 5).join(", ");
    const more = g.ownedPaths.length > 5 ? `, and ${g.ownedPaths.length - 5} more` : "";
    return `\`${flag}\`: ${reason} (${shown}${more})`;
  }
  return `\`${flag}\`: ${reason}`;
};

// The two halves of the verdict, stated as two facts. The gate line says why
// the bot may not approve; this one says whether it found anything wrong with
// the code. Without it a comment gated for a missing `Plan:` line and a comment
// carrying a finding read the same to a human, and they need opposite replies.
const renderFindings = (f: FindingsVerdict): string =>
  f.verdict === "none" ? "**Findings: none.**" : `**Findings: ${f.count} finding(s).**`;

// The plain-language half of the same fact, short enough to scan. A clean PR
// blocked by the gate says so out loud and says that a human still has to
// approve it: the required check and `CODEOWNERS` do not change because the
// bot had nothing to flag.
const renderJudgement = (g: DecisionGating, f: FindingsVerdict): string => {
  if (f.verdict === "none") {
    return g.mode === "shadow"
      ? "No findings: the changes look approvable, and shadow mode alone is why this is a comment rather than an approval. A human still has to approve this PR."
      : "No findings: the changes look approvable, and the gate alone is why this is a comment rather than an approval. A human still has to approve this PR — the bot's review is not a required check and `CODEOWNERS` is unchanged.";
  }
  return g.flags.length > 0
    ? "The findings are why this is not an approval, and the gate flagged the PR independently."
    : "The findings are why this is not an approval.";
};

// One line, in the same body a reviewer already reads for findings, carrying
// the verdict, what it was checked against and why it is not an approval. A
// reader should not have to open the run record to learn why the bot declined,
// and a shadow run says so out loud rather than looking like a real comment.
const renderGating = (g: DecisionGating): string => {
  const target = g.plan
    ? `against \`${g.plan.path}\` at \`${g.plan.blobSha.slice(0, 7)}\``
    : "with no plan read";
  const why =
    g.flags.length > 0
      ? ` Flags: ${g.flags.map((f) => flagText(f, g)).join("; ")}.`
      : "";

  if (g.mode === "shadow") {
    const head = g.wouldApprove
      ? `**Gate: shadow, would have approved** ${target}.`
      : `**Gate: shadow, would have commented** ${target}.`;
    return `${head}${why} Shadow mode records the decision and posts a comment, never an approval.`;
  }

  const head = g.wouldApprove
    ? `**Gate: approve** ${target}.`
    : `**Gate: comment** ${target}.`;
  const tail = g.wouldApprove
    ? " Every changed path is unowned in `CODEOWNERS` on `main`, and the change is consistent with the plan."
    : "";
  return `${head}${why}${tail}`;
};

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
  // Absent when the gate did not run, which is what keeps an ungated body
  // identical to the one it rendered before this existed. The findings verdict
  // and the gate verdict are separate paragraphs on purpose; an approval is
  // unchanged, because it is not withholding anything a reader has to explain.
  const findings =
    args.decision.verdict === "comment" ? args.decision.findingsVerdict : undefined;
  if (findings) parts.push(renderFindings(findings));
  if (args.decision.gating) parts.push(renderGating(args.decision.gating));
  if (findings && args.decision.gating) {
    parts.push(renderJudgement(args.decision.gating, findings));
  }
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
