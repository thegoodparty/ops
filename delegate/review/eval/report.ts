import type { PairVerdict } from "./judge";
import type { Result, RunResults } from "./replay";
import type { Scenario } from "./cases";

export type Split = Scenario["split"];

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

const caseName = (v: PairVerdict, names?: Map<string, string>): string =>
  names?.get(v.caseId) ?? v.caseId;

export const renderMarkdown = (
  summary: Summary,
  verdicts: PairVerdict[],
  labels: { labelA: string; labelB: string; names?: Map<string, string>; splits?: Map<string, Split> },
): string => {
  const { labelA, labelB, names, splits } = labels;
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
    "> Excludes ties and unstable verdicts. At 24 cases, 18+ wins one way is p<0.05.",
  );
  if (splits) {
    for (const split of ["tune", "holdout"] as const) {
      const s = summarize(verdicts.filter((v) => splits.get(v.caseId) === split));
      lines.push("");
      lines.push(
        `${split}: ${labelA} ${s.a}, ${labelB} ${s.b}, ${s.ties + s.unstable} tied or unstable, p=${s.signTestP.toFixed(4)} (${qualityVerdict(s)})`,
      );
    }
  }
  lines.push("");
  lines.push("## Per-case results");
  lines.push("");
  lines.push(splits ? "| Case | Split | Repo#PR | Winner | Deciding criterion |" : "| Case | Repo#PR | Winner | Deciding criterion |");
  lines.push(splits ? "| --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- |");

  for (const v of verdicts) {
    const winnerLabel =
      v.winner === "a"
        ? labelA
        : v.winner === "b"
          ? labelB
          : v.winner;
    const criterion = v.passes.find((p) => p.deciding_criterion)?.deciding_criterion ?? "";
    const split = splits ? ` ${splits.get(v.caseId) ?? ""} |` : "";
    lines.push(
      `| ${caseName(v, names)} |${split} ${v.repo}#${v.prNumber} | ${winnerLabel} | ${criterion} |`,
    );
  }

  return lines.join("\n");
};

export interface PrCommentOptions {
  names?: Map<string, string>;
  labelA: string;
  labelB: string;
  casesCount: number;
  replayCost: number;
  replayFailures: number;
  runUrl: string;
  resultsA?: RunResults;
  resultsB?: RunResults;
  // When present, the comment reports tune and holdout separately and lists
  // only tune cases.
  splits?: Map<string, Split>;
}

const renderPerCaseTable = (
  verdicts: PairVerdict[],
  labelA: string,
  labelB: string,
  names?: Map<string, string>,
): string => {
  const rows = verdicts.map((v) => {
    const winnerLabel =
      v.winner === "a" ? labelA : v.winner === "b" ? labelB : v.winner;
    const criterion =
      v.passes.find((p) => p.deciding_criterion)?.deciding_criterion ?? "";
    return `| ${caseName(v, names)} | ${v.repo}#${v.prNumber} | ${winnerLabel} | ${criterion} |`;
  });
  return [
    "| Case | Repo#PR | Winner | Deciding criterion |",
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

// Same replays on both sides, or a replay that failed on one side moves the
// headline without any review having changed price.
const pairedAvgCost = (a: RunResults, b: RunResults): [number | null, number | null] => {
  const pairs: [number, number][] = [];
  for (const [caseId, aRuns] of a) {
    for (const [run, ra] of aRuns) {
      const rb = b.get(caseId)?.get(run);
      if (rb && typeof ra.costUsd === "number" && typeof rb.costUsd === "number") {
        pairs.push([ra.costUsd, rb.costUsd]);
      }
    }
  }
  if (pairs.length === 0) return [null, null];
  const avg = (i: 0 | 1) => pairs.reduce((sum, p) => sum + p[i], 0) / pairs.length;
  return [avg(0), avg(1)];
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
  const { labelA, labelB, casesCount, replayFailures, runUrl, names, splits } = opts;
  const [before, after] = pairedAvgCost(opts.resultsA ?? new Map(), opts.resultsB ?? new Map());
  const money = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(2)}`);
  const failures = `${replayFailures} replay failure(s) across both sides`;

  const qualityLine = (title: string, s: Summary, total: number) => {
    const unjudged = total - s.n;
    const unjudgedNote = unjudged ? `, ${unjudged} not judged` : "";
    return `**${title}: ${qualityVerdict(s)}** — ${labelB} won ${s.b}, ${labelA} won ${s.a}, ${s.ties + s.unstable} tied or unstable, over ${s.n} of ${total} cases (p=${s.signTestP.toFixed(2)})${unjudgedNote}`;
  };

  // Holdout cases stay out of the comment (counts only); the artifact keeps them.
  const inSplit = (split: Split) => verdicts.filter((v) => splits?.get(v.caseId) === split);
  const splitTotal = (split: Split) => [...(splits?.values() ?? [])].filter((s) => s === split).length;
  const quality = splits
    ? [
        `${qualityLine("Quality (tune)", summarize(inSplit("tune")), splitTotal("tune"))}.`,
        "",
        `${qualityLine("Quality (holdout)", summarize(inSplit("holdout")), splitTotal("holdout"))}.`,
        ...(replayFailures ? ["", `${failures}.`] : []),
      ]
    : [`${qualityLine("Quality", summary, casesCount)}${replayFailures ? `, ${failures}` : ""}.`];
  const listed = splits ? inSplit("tune") : verdicts;

  return [
    "<!-- delegate-eval -->",
    `### Delegate eval: ${labelB} vs ${labelA}`,
    "",
    ...quality,
    "",
    `**Cost: ${costVerdict(before, after)}** — ${money(before)} → ${money(after)} per review (${labelA} → ${labelB}).`,
    "",
    `<details><summary>Per-case results${splits ? " (tune)" : ""}</summary>`,
    "",
    renderPerCaseTable(listed, labelA, labelB, names),
    "",
    "</details>",
    "",
    `[Workflow run](${runUrl}) has every result as an artifact.`,
  ].join("\n");
};
