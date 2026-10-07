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
  replayCost: number;
  replayFailures: number;
  runUrl: string;
  resultsA?: Result[];
  resultsB?: Result[];
}

const signTestInterpretation = (
  summary: Summary,
  labelA: string,
  labelB: string,
): string => {
  if (summary.signTestP >= 0.05) return "not distinguishable from noise";
  return summary.b > summary.a ? `${labelB} is better` : `${labelB} is worse`;
};

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

export const renderPrComment = (
  summary: Summary,
  verdicts: PairVerdict[],
  opts: PrCommentOptions,
): string => {
  const { labelA, labelB, casesCount, replayCost, replayFailures, runUrl, resultsA = [], resultsB = [] } = opts;
  const lines: string[] = [];

  lines.push("<!-- delegate-eval -->");
  lines.push("");
  lines.push(`### Delegate eval: ${labelB} vs ${labelA}`);
  lines.push("");

  const interpretation = signTestInterpretation(summary, labelA, labelB);
  const pStr = summary.signTestP.toFixed(4);
  const failureNote = replayFailures > 0 ? ` ${replayFailures} replay(s) failed.` : "";
  const costNote = replayCost > 0 ? ` Replay cost: $${replayCost.toFixed(2)}.` : "";

  lines.push(
    `Judged ${casesCount} cases. ${labelA} won ${summary.a}, ${labelB} won ${summary.b}, ` +
    `${summary.ties + summary.unstable} tied or unstable. ` +
    `Sign-test p=${pStr} (${interpretation}).${failureNote}${costNote}`,
  );
  lines.push("");

  lines.push("<details><summary>Per-case results</summary>");
  lines.push("");
  lines.push(renderPerCaseTable(verdicts, labelA, labelB));
  lines.push("");
  lines.push("</details>");
  lines.push("");

  if (resultsA.length > 0 || resultsB.length > 0) {
    lines.push("<details><summary>What each side said</summary>");
    lines.push("");
    lines.push(renderWhatEachSideSaid(verdicts, resultsA, resultsB, labelA, labelB));
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push(`[View workflow run](${runUrl})`);

  return lines.join("\n");
};
