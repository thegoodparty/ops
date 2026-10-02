import type { CaseVerdict } from "./judge";
import { addSpend, ZERO_SPEND, type Spend } from "./metrics";

export type Side = "baseline" | "candidate";

/** Where a run stops. `closed` is the whole lifecycle. */
export type Milestone = "root_cause" | "pr_opened" | "closed";

/** Null is not applicable: the run's tier stops before a merge. */
export interface Gates {
  /** The incident was closed. */
  closed: boolean | null;
  /** The hidden check passed on what was merged. */
  fixed: boolean | null;
  /** Every merged pull request had green CI at its head. */
  mergedGreen: boolean | null;
  /** Nothing moved the sandbox's main, or the run's base, except a merge. */
  noPushToMain: boolean;
}

export const GATE_NAMES: Record<keyof Gates, string> = {
  closed: "closed",
  fixed: "fix check",
  mergedGreen: "CI green at merge",
  noPushToMain: "no push to main",
};

export const gatesPass = (gates: Gates): boolean => Object.values(gates).every((g) => g !== false);

export interface RunResult {
  runId: string;
  scenario: string;
  rep: number;
  side: Side;
  ref: string;
  /** Where the run's tier stops. */
  until: Milestone;
  /** How the run ended: `closed`, `root_cause`, `pr_opened`, `wall_clock`, `spend_cap`, or `error: …`. */
  end: string;
  gates: Gates;
  spend: Spend;
  /** Seconds from the alert to each milestone. Null when the run never got there. */
  wallClock: WallClock;
  /** Head branch of every pull request the run opened, so blinding can remove them by name. */
  prHeads?: string[];
}

export interface WallClock {
  prOpened: number | null;
  merged: number | null;
  closed: number | null;
}

/**
 * Two-sided exact sign test, p = 0.5. Undefined when there is nothing to
 * test. Six untied pairs is the fewest that can reach p < 0.05.
 */
export const signTest = (wins: number, losses: number): number | undefined => {
  const n = wins + losses;
  if (n === 0) return undefined;
  const k = Math.min(wins, losses);
  let tail = 0;
  let choose = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) choose = (choose * (n - i + 1)) / i;
    tail += choose;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
};

const usd = (value: number) => `$${value.toFixed(2)}`;
const minutes = (seconds: number | null) => (seconds === null ? "–" : `${Math.round(seconds / 60)}m`);
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

const MILESTONE_NAMES: Record<Milestone, string> = { root_cause: "root cause", pr_opened: "PR opened", closed: "close" };

/** Passed over applicable, or n/a when the gate applied to none of the runs. */
const ratio = (values: (boolean | null | undefined)[]) => {
  const applicable = values.filter((v) => v !== null && v !== undefined);
  return applicable.length ? `${applicable.filter((v) => v === true).length}/${applicable.length}` : "n/a";
};

interface SideSummary {
  runs: number;
  gatesPassed: number;
  gateCells: Record<keyof Gates, string>;
  spend: Spend;
  meanUsd: number | null;
  meanTurns: number | null;
  meanWall: Record<keyof WallClock, number | null>;
}

const WALL_NAMES: Record<keyof WallClock, string> = { prOpened: "to PR", merged: "to merge", closed: "to close" };

const summarise = (runs: RunResult[]): SideSummary => {
  const gateCells = Object.fromEntries(
    (Object.keys(GATE_NAMES) as (keyof Gates)[]).map((g) => [g, ratio(runs.map((r) => r.gates[g]))]),
  ) as Record<keyof Gates, string>;
  const meanWall = Object.fromEntries(
    (Object.keys(WALL_NAMES) as (keyof WallClock)[]).map((k) => {
      const reached = runs.map((r) => r.wallClock[k]).filter((w): w is number => w !== null);
      return [k, reached.length ? mean(reached) : null];
    }),
  ) as Record<keyof WallClock, number | null>;
  return {
    runs: runs.length,
    gatesPassed: runs.filter((r) => gatesPass(r.gates)).length,
    gateCells,
    spend: runs.reduce((sum, r) => addSpend(sum, r.spend), ZERO_SPEND),
    meanUsd: mean(runs.map((r) => r.spend.usd)),
    meanTurns: mean(runs.map((r) => r.spend.turns)),
    meanWall,
  };
};

const verdictLine = (verdicts: CaseVerdict[]): string => {
  const judged = verdicts.filter((v) => v.excluded === null);
  const flips = judged.filter((v) => v.flipped).length;
  const wins = judged.filter((v) => !v.flipped && v.winner === "candidate").length;
  const losses = judged.filter((v) => !v.flipped && v.winner === "baseline").length;
  const ties = judged.length - flips - wins - losses;
  return `${wins}-${losses}-${ties}${flips ? ` (${flips} flipped)` : ""}`;
};

const POINTS = { tie: 0, better: 1, much_better: 2 } as const;

/**
 * The universal judge's call (omni packages/universal-judge), in this order:
 * too many flips to trust, too small a mean to matter, too few decisive pairs
 * to call, or better or worse with the sign test's p.
 */
export const qualityCall = (verdicts: CaseVerdict[]): string => {
  const judged = verdicts.filter((v) => v.excluded === null);
  if (judged.length === 0) return "Quality: no pairs judged.";
  const flips = judged.filter((v) => v.flipped).length;
  if (flips / judged.length > 0.2) return `Quality: inconclusive, the judge flipped on ${flips} of ${judged.length} pairs when their order was swapped.`;
  const scored = judged.filter((v) => !v.flipped);
  const score = scored.reduce((sum, v) => sum + (v.winner === "tie" ? 0 : (v.winner === "candidate" ? 1 : -1) * POINTS[v.margin]), 0) / scored.length;
  const wins = scored.filter((v) => v.winner === "candidate").length;
  const losses = scored.filter((v) => v.winner === "baseline").length;
  const mean = `mean ${score >= 0 ? "+" : ""}${score.toFixed(2)} on -2..+2`;
  if (Math.abs(score) < 0.25) return `Quality: no material change (${mean}).`;
  if (wins + losses < 6) return `Quality: not enough cases to call (${mean}, ${wins + losses} decisive pairs; six is the fewest that can reach p < 0.05).`;
  const p = signTest(wins, losses)!;
  return `Quality: the candidate is ${Math.abs(score) >= 1 ? "much " : ""}${score > 0 ? "better" : "worse"} (${mean}, sign test p=${p.toFixed(3)} over ${wins + losses} decisive pairs${p < 0.05 ? "" : ", so this could be chance"}).`;
};

/**
 * The comment posted back to the PR. Advisory: nothing gates on it.
 */
export const renderReport = (args: {
  baselineRef: string;
  candidateRef: string;
  runs: RunResult[];
  verdicts: CaseVerdict[];
  judgeUsd: number;
  /** `fast` or `full`. */
  tier: string;
  /** The comparison's spend cap, summed over its jobs. Null when uncapped. */
  capUsd: number | null;
}): string => {
  const milestone = MILESTONE_NAMES[args.runs[0]?.until ?? "closed"];
  const scenarios = [...new Set(args.runs.map((r) => r.scenario))].sort();
  const pick = (scenario: string | null, side: Side) =>
    args.runs.filter((r) => r.side === side && (scenario === null || r.scenario === scenario));
  const verdictsFor = (scenario: string | null) =>
    args.verdicts.filter((v) => scenario === null || v.pairId.startsWith(`${scenario}/`));

  const row = (label: string, scenario: string | null): string => {
    const base = summarise(pick(scenario, "baseline"));
    const cand = summarise(pick(scenario, "candidate"));
    const cell = (s: SideSummary) =>
      `${s.gatesPassed}/${s.runs} | ${s.meanTurns === null ? "–" : Math.round(s.meanTurns)} | ${s.meanUsd === null ? "–" : usd(s.meanUsd)} | ${minutes(s.meanWall.prOpened)} | ${minutes(s.meanWall.merged)} | ${minutes(s.meanWall.closed)}`;
    return `| ${label} | ${cell(base)} | ${cell(cand)} | ${verdictLine(verdictsFor(scenario))} |`;
  };

  const gateTable = (["baseline", "candidate"] as Side[]).map((side) => {
    const s = summarise(pick(null, side));
    return `| ${side} | ${(Object.keys(GATE_NAMES) as (keyof Gates)[]).map((g) => s.gateCells[g]).join(" | ")} |`;
  });

  const spendTable = [...scenarios, null].flatMap((scenario) =>
    (["baseline", "candidate"] as Side[]).map((side) => {
      const s = summarise(pick(scenario, side)).spend;
      return `| ${scenario ?? "**Total**"} | ${side} | ${tokens(s.input)} | ${tokens(s.output)} | ${tokens(s.cacheRead)} | ${tokens(s.cacheWrite)} | ${s.turns} | ${usd(s.usd)} |`;
    }),
  );

  const failures = args.runs.filter((r) => !gatesPass(r.gates));
  const excluded = args.verdicts.filter((v) => v.excluded !== null);
  const unpriced = [...new Set(args.runs.flatMap((r) => r.spend.unpriced))];
  const spent = args.runs.reduce((sum, r) => sum + r.spend.usd, 0) + args.judgeUsd;
  const capped = args.runs.filter((r) => r.end === "spend_cap").length;

  return [
    "## Incident eval (advisory)",
    "",
    `Tier: **${args.tier}**, each run stopping at ${milestone}. Baseline \`${args.baselineRef}\` against candidate \`${args.candidateRef}\`. Each cell is gates passed (closed, fix check, CI green at merge, no push to main), then per run the mean model turns, estimated cost (priced from tokens at the provider boundary) and minutes from the alert to the PR, the merge and the close. Quality is the candidate's wins-losses-ties from a blind, order-swapped judge shown each side's full Slack thread, GitHub events and fix diff.`,
    "",
    `Estimated spend: ${usd(spent)}${args.capUsd === null ? "" : ` of the ${usd(args.capUsd)} cap`}.${capped ? ` ${capped} runs stopped at the cap.` : ""}`,
    "",
    "| Scenario | Baseline gates | turns | cost | to PR | to merge | to close | Candidate gates | turns | cost | to PR | to merge | to close | Quality W-L-T |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...scenarios.map((s) => row(s, s)),
    row("**Total**", null),
    "",
    qualityCall(args.verdicts),
    "",
    "<details><summary>Judge's reasoning, pair by pair</summary>",
    "",
    ...args.verdicts
      .filter((v) => v.excluded === null)
      .flatMap((v) => [
        `**${v.pairId}**: ${v.winner === "tie" ? "tie" : `${v.winner} ${v.margin.replace("_", " ")}`}${v.flipped ? " (flipped when swapped, excluded from the count)" : ""}. Decided on ${v.decidingCriterion}.`,
        "",
        v.rationale,
        "",
      ]),
    "</details>",
    "",
    "<details><summary>Gates and tokens</summary>",
    "",
    `| Side | ${Object.values(GATE_NAMES).join(" | ")} |`,
    `| --- |${" --- |".repeat(Object.keys(GATE_NAMES).length)}`,
    ...gateTable,
    "",
    "| Scenario | Side | Input | Output | Cache read | Cache write | Turns | Cost (est.) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...spendTable,
    "",
    `Judge: ${usd(args.judgeUsd)}.`,
    ...(unpriced.length ? [`Unpriced models (not in the price table): ${unpriced.join(", ")}.`] : []),
    ...(failures.length
      ? [
          "",
          "Runs that failed a gate:",
          ...failures.map(
            (r) =>
              `- ${r.scenario} rep ${r.rep} ${r.side}: ended ${r.end}; ${(Object.keys(GATE_NAMES) as (keyof Gates)[])
                .filter((g) => r.gates[g] === false)
                .map((g) => GATE_NAMES[g])
                .join(", ")}`,
          ),
        ]
      : []),
    ...(excluded.length ? ["", "Pairs not judged:", ...excluded.map((v) => `- ${v.pairId}: ${v.excluded}`)] : []),
    "",
    "</details>",
  ].join("\n");
};
