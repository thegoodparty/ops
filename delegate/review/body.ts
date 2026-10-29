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
// the bot may not approve; this one says what this pass flagged. Without it a
// comment gated for a missing `Plan:` line and a comment carrying a finding
// read the same to a human, and they need opposite replies. The `in this pass`
// is load-bearing: a clean pass is not a claim that the code is sound. In
// ops#392 the reviewer reported no findings and a human reviewer then raised
// three, one of them a blocker (the schema-failure fallback in `replay.ts`).
const renderFindings = (f: FindingsVerdict): string =>
  f.verdict === "none"
    ? "**Findings: none in this pass.**"
    : `**Findings: ${f.count} finding(s) in this pass.**`;

// The plain-language half of the same fact, short enough to scan. It says what
// this pass found, never that the code is correct: the obstacle it names is the
// gate, not the diff. That distinction is the whole point of ops#392, and it is
// why the sentence does not read "the changes look approvable". A human still
// has to approve the PR: the required check and `CODEOWNERS` do not change
// because the bot had nothing to flag.
const renderJudgement = (g: DecisionGating, f: FindingsVerdict): string => {
  if (f.verdict === "none") {
    if (g.mode === "shadow") {
      // Shadow withholds on its own only when no flag fired. With a flag, the
      // gate is what would have blocked an approval too, and saying shadow
      // alone did it would contradict the gate line in the same body.
      return g.flags.length === 0
        ? "This review flagged nothing, and shadow mode alone is why this is a comment rather than an approval. A human still has to approve this PR."
        : "This review flagged nothing, but the gate flagged the PR as well, and shadow mode posts a comment either way. A human still has to approve this PR.";
    }
    return "This review flagged nothing; the gate alone is why this is a comment rather than an approval. A human still has to approve this PR — the bot's review is not a required check and `CODEOWNERS` is unchanged.";
  }
  return g.flags.length > 0
    ? "The findings are why this is not an approval, and the gate flagged the PR independently."
    : "The findings are why this is not an approval.";
};

// Case 5's answer, in the same line as the gate. A `consistent` verdict that
// needed pieces the step did not name is the shape the old vocabulary had to
// call `unclear`, so the body names what was added and why: a human can check
// the addition instead of trusting the verdict. A plan defect is listed
// separately because it belongs to the document and not to the diff, and it is
// the specific answer that replaces an `unclear`. Only a `consistent` answer
// renders here; every other one already has its own flag line.
const renderConsistency = (g: DecisionGating): string => {
  const c = g.consistency;
  if (c === undefined || c.verdict !== "consistent") return "";
  const step = g.binding.step !== undefined ? `step ${g.binding.step}` : "the plan";
  const n = c.additions.length;
  const additions =
    n === 0
      ? ""
      : ` ${n} addition${n === 1 ? "" : "s"} the step does not name: ${c.additions
          .map((a) => `\`${a.item}\` (${a.why})`)
          .join("; ")}.`;
  const d = c.planDefects.length;
  const defects =
    d === 0
      ? ""
      : ` ${d} plan defect${d === 1 ? "" : "s"}, which belong${d === 1 ? "s" : ""} to the plan and not the diff: ${c.planDefects
          .map((x) => `"${x.text}" — ${x.problem}`)
          .join("; ")}.`;
  return ` Consistent with ${step}.${additions}${defects}`;
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
  const consistency = renderConsistency(g);

  if (g.mode === "shadow") {
    const head = g.wouldApprove
      ? `**Gate: shadow, would have approved** ${target}.`
      : `**Gate: shadow, would have commented** ${target}.`;
    return `${head}${why}${consistency} Shadow mode records the decision and posts a comment, never an approval.`;
  }

  const head = g.wouldApprove
    ? `**Gate: approve** ${target}.`
    : `**Gate: comment** ${target}.`;
  // The consistency detail carries the "and it is consistent" half when the
  // model answered; without it the sentence is the whole statement, as before.
  const tail = g.wouldApprove
    ? consistency
      ? " Every changed path is unowned in `CODEOWNERS` on `main`."
      : " Every changed path is unowned in `CODEOWNERS` on `main`, and the change is consistent with the plan."
    : "";
  return `${head}${why}${tail}${consistency}`;
};

// The top line is the bot's judgement of the code, not the review event. When
// the gate withholds an approval the event is a `COMMENT` (the bot approves
// nothing the gate does not sanction), but a pass that flagged nothing still
// says so: a human reading the PR needs to know the gate is the only obstacle,
// and the gate line below states the action. Ungated, the two are one thing.
const recommendation = (d: Decision): "approve" | "comment" =>
  d.gating !== undefined && d.findingsVerdict !== undefined
    ? d.findingsVerdict.verdict === "none"
      ? "approve"
      : "comment"
    : d.verdict;

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

  parts.push(`**Recommendation: ${recommendation(args.decision)}**`);
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
