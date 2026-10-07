import type { PairVerdict } from "./judge";

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
