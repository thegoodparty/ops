import type { PairVerdict } from "./judge";
import type { Result } from "./replay";

export interface Summary {
  a: number;
  b: number;
  ties: number;
  unstable: number;
  n: number;
  signTestP: number;
}

const signTestP = (wins: number, losses: number): number => {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  let choose = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) choose = (choose * (n - i + 1)) / i;
    tail += choose;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
};

export const summarize = (verdicts: PairVerdict[]): Summary => {
  const a = verdicts.filter((v) => v.winner === "a").length;
  const b = verdicts.filter((v) => v.winner === "b").length;
  const ties = verdicts.filter((v) => v.winner === "tie").length;
  const unstable = verdicts.filter((v) => v.winner === "unstable").length;
  return { a, b, ties, unstable, n: verdicts.length, signTestP: signTestP(a, b) };
};

export const renderMarkdown = (
  summary: Summary,
  verdicts: PairVerdict[],
  labels: { labelA: string; labelB: string },
): string => {
  const { labelA, labelB } = labels;
  const lines: string[] = [];

  lines.push("# PR-reviewer eval report");
  lines.push("");
  lines.push(`| | ${labelA} | ${labelB} | Ties | Unstable | Total |`);
  lines.push("| --- | --- | --- | --- | --- | --- |");
  lines.push(
    `| Verdicts | ${summary.a} | ${summary.b} | ${summary.ties} | ${summary.unstable} | ${summary.n} |`,
  );
  lines.push("");
  lines.push(
    `Sign test p-value (${labelA} vs ${labelB}, two-sided): **${summary.signTestP.toFixed(4)}**`,
  );
  lines.push(
    "> Excludes ties and unstable verdicts. At 12 cases, 10+ wins one way is p<0.05.",
  );
  lines.push("");
  lines.push("## Per-case results");
  lines.push("");
  lines.push("| Case ID | Repo#PR | Winner | Deciding criterion |");
  lines.push("| --- | --- | --- | --- |");

  for (const v of verdicts) {
    const winnerLabel =
      v.winner === "a"
        ? labelA
        : v.winner === "b"
          ? labelB
          : v.winner;
    const criterion = v.passes.find((p) => p.deciding_criterion)?.deciding_criterion ?? "";
    lines.push(
      `| ${v.caseId} | ${v.repo}#${v.prNumber} | ${winnerLabel} | ${criterion} |`,
    );
  }

  return lines.join("\n");
};

export interface PrCommentOptions {
  labelA: string;
  labelB: string;
  casesCount: number;
  unjudgedCount?: number;
  replayCost: number;
  replayFailures: number;
  runUrl: string;
  resultsA?: Result[];
  resultsB?: Result[];
}

const renderPerCaseTable = (
  verdicts: PairVerdict[],
  labelA: string,
  labelB: string,
): string => {
  const rows = verdicts.map((v) => {
    const winnerLabel =
      v.winner === "a" ? labelA : v.winner === "b" ? labelB : v.winner;
    const criterion =
      v.passes.find((p) => p.deciding_criterion)?.deciding_criterion ?? "";
    return `| ${v.caseId} | ${v.repo}#${v.prNumber} | ${winnerLabel} | ${criterion} |`;
  });
  return [
    "| Case ID | Repo#PR | Winner | Deciding criterion |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
};

const renderWhatEachSideSaid = (
  verdicts: PairVerdict[],
  resultsA: Result[],
  resultsB: Result[],
  labelA: string,
  labelB: string,
): string => {
  const aById = new Map(resultsA.map((r) => [r.caseId, r]));
  const bById = new Map(resultsB.map((r) => [r.caseId, r]));
  const sections: string[] = [];

  for (const v of verdicts) {
    const a = aById.get(v.caseId);
    const b = bById.get(v.caseId);
    const lines: string[] = [`**${v.repo}#${v.prNumber}** — verdict: ${v.winner === "a" ? labelA : v.winner === "b" ? labelB : v.winner}`, ""];

    for (const [label, result] of [[labelA, a], [labelB, b]] as [string, Result | undefined][]) {
      if (!result) {
        lines.push(`**${label}**: (no result)`);
        continue;
      }
      if (result.error) {
        lines.push(`**${label}**: FAILED — ${result.error}`);
        continue;
      }
      const out = result.output;
      if (!out || out.status === "failed") {
        lines.push(`**${label}**: FAILED`);
        continue;
      }
      lines.push(`**${label}**: ${out.findings.length === 0 ? "approve" : "comment"} — ${out.summary}`);
      for (const f of out.findings) {
        lines.push(`- ${f.path}:${f.line} ${f.body.slice(0, 200)}`);
      }
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
};

// Two verdicts a reader can act on, then a link for the rest.
export const qualityVerdict = (summary: Summary): "Better" | "Worse" | "Can't tell" => {
  if (summary.signTestP >= 0.05 || summary.a === summary.b) return "Can't tell";
  return summary.b > summary.a ? "Better" : "Worse";
};

// Same cases on both sides, or a replay that failed on one side moves the
// headline without any review having changed price.
const pairedAvgCost = (a: Result[], b: Result[]): [number | null, number | null] => {
  const bById = new Map(b.map((r) => [r.caseId, r]));
  const pairs = a
    .map((ra) => [ra, bById.get(ra.caseId)] as const)
    .filter((p): p is readonly [Result, Result] =>
      p[1] !== undefined && typeof p[0].costUsd === "number" && typeof p[1].costUsd === "number",
    );
  if (pairs.length === 0) return [null, null];
  const avg = (pick: (p: readonly [Result, Result]) => number) =>
    pairs.reduce((sum, p) => sum + pick(p), 0) / pairs.length;
  return [avg((p) => p[0].costUsd ?? 0), avg((p) => p[1].costUsd ?? 0)];
};

export const costVerdict = (
  before: number | null,
  after: number | null,
): "Better" | "Worse" | "Same" | "Can't tell" => {
  if (before === null || after === null || before === 0) return "Can't tell";
  const change = (after - before) / before;
  if (Math.abs(change) < 0.1) return "Same";
  return change < 0 ? "Better" : "Worse";
};

export const renderPrComment = (
  summary: Summary,
  verdicts: PairVerdict[],
  opts: PrCommentOptions,
): string => {
  const { labelA, labelB, casesCount, unjudgedCount = 0, replayFailures, runUrl, resultsA = [], resultsB = [] } = opts;
  const [before, after] = pairedAvgCost(resultsA, resultsB);
  const money = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(2)}`);
  const judged = casesCount - unjudgedCount;
  const unjudgedNote = unjudgedCount ? `, ${unjudgedCount} not judged` : "";
  const failureNote = replayFailures ? `, ${replayFailures} replay failure(s)` : "";

  return [
    "<!-- delegate-eval -->",
    `### Delegate eval: ${labelB} vs ${labelA}`,
    "",
    `**Quality: ${qualityVerdict(summary)}** — ${labelB} won ${summary.b}, ${labelA} won ${summary.a}, ${summary.ties + summary.unstable} tied or unstable, over ${judged} of ${casesCount} cases (p=${summary.signTestP.toFixed(2)})${unjudgedNote}${failureNote}.`,
    "",
    `**Cost: ${costVerdict(before, after)}** — ${money(before)} → ${money(after)} per review (${labelA} → ${labelB}).`,
    "",
    "<details><summary>Per-case results</summary>",
    "",
    renderPerCaseTable(verdicts, labelA, labelB),
    "",
    "</details>",
    "",
    `[Workflow run](${runUrl}) has every result as an artifact.`,
  ].join("\n");
};
