import type { IncidentOutput } from "./blind";
import type { CaseVerdict } from "./judge";
import { addSpend, ZERO_SPEND, type Spend } from "./metrics";

export type Side = "baseline" | "candidate";

/** Where a run stops. `closed` is the whole lifecycle. */
export type Milestone = "root_cause" | "pr_opened" | "closed";

/** Null is not applicable: the run's tier stops before a merge. */
export interface Gates {
  /** The incident reached CLOSED. */
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
  /** The scenario's own gates (core/gates.ts), by id. */
  scenarioGates: Record<string, boolean | null>;
  spend: Spend;
  /** From the alert to the tier's milestone. Null when it never got there. */
  wallClockSeconds: number | null;
  output: IncidentOutput;
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
  meanWall: number | null;
}

const summarise = (runs: RunResult[]): SideSummary => {
  const gateCells = Object.fromEntries(
    (Object.keys(GATE_NAMES) as (keyof Gates)[]).map((g) => [g, ratio(runs.map((r) => r.gates[g]))]),
  ) as Record<keyof Gates, string>;
  const walls = runs.map((r) => r.wallClockSeconds).filter((w): w is number => w !== null);
  return {
    runs: runs.length,
    gatesPassed: runs.filter((r) => gatesPass(r.gates)).length,
    gateCells,
    spend: runs.reduce((sum, r) => addSpend(sum, r.spend), ZERO_SPEND),
    meanUsd: mean(runs.map((r) => r.spend.usd)),
    meanWall: walls.length ? mean(walls) : null,
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
  /** `fast`, `full` or `stub`. */
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
      `${s.gatesPassed}/${s.runs} | ${s.meanUsd === null ? "–" : usd(s.meanUsd)} | ${minutes(s.meanWall)}`;
    return `| ${label} | ${cell(base)} | ${cell(cand)} | ${verdictLine(verdictsFor(scenario))} |`;
  };

  const gateTable = (["baseline", "candidate"] as Side[]).map((side) => {
    const s = summarise(pick(null, side));
    return `| ${side} | ${(Object.keys(GATE_NAMES) as (keyof Gates)[]).map((g) => s.gateCells[g]).join(" | ")} |`;
  });

  const spendTable = (["baseline", "candidate"] as Side[]).map((side) => {
    const s = summarise(pick(null, side)).spend;
    return `| ${side} | ${tokens(s.input)} | ${tokens(s.output)} | ${tokens(s.cacheRead)} | ${tokens(s.cacheWrite)} | ${s.turns} | ${usd(s.usd)} |`;
  });

  const scenarioGateRows = scenarios.flatMap((scenario) => {
    const ids = [...new Set(args.runs.filter((r) => r.scenario === scenario).flatMap((r) => Object.keys(r.scenarioGates ?? {})))];
    return ids.map((id) => {
      const cell = (side: Side) => ratio(pick(scenario, side).map((r) => r.scenarioGates?.[id]));
      return `| ${scenario} | ${id} | ${cell("baseline")} | ${cell("candidate")} |`;
    });
  });

  const failures = args.runs.filter((r) => !gatesPass(r.gates));
  const excluded = args.verdicts.filter((v) => v.excluded !== null);
  const unpriced = [...new Set(args.runs.flatMap((r) => r.spend.unpriced))];
  const spent = args.runs.reduce((sum, r) => sum + r.spend.usd, 0) + args.judgeUsd;
  const capped = args.runs.filter((r) => r.end === "spend_cap").length;

  return [
    "## BugBoss eval (advisory)",
    "",
    `Tier: **${args.tier}**, each run stopping at ${milestone}. Baseline \`${args.baselineRef}\` against candidate \`${args.candidateRef}\`. Each cell is gates passed, mean estimated cost per run (priced from tokens), and mean time from alert to ${milestone}. Quality is the candidate's wins-losses-ties from a blind, order-swapped judge.`,
    "",
    `Estimated spend: ${usd(spent)}${args.capUsd === null ? "" : ` of the ${usd(args.capUsd)} cap`}.${capped ? ` ${capped} runs stopped at the cap.` : ""}`,
    "",
    "| Scenario | Baseline gates | cost | wall | Candidate gates | cost | wall | Quality W-L-T |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...scenarios.map((s) => row(s, s)),
    row("**Total**", null),
    "",
    qualityCall(args.verdicts),
    "",
    "<details><summary>Gates and tokens</summary>",
    "",
    `| Side | ${Object.values(GATE_NAMES).join(" | ")} |`,
    `| --- |${" --- |".repeat(Object.keys(GATE_NAMES).length)}`,
    ...gateTable,
    "",
    ...(scenarioGateRows.length
      ? ["| Scenario | Scenario gate | Baseline | Candidate |", "| --- | --- | --- | --- |", ...scenarioGateRows, ""]
      : []),
    "| Side | Input | Output | Cache read | Cache write | Turns | Cost (est.) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...spendTable,
    "",
    `Judge: ${usd(args.judgeUsd)}. Cost covers the incident agents' sessions only; the Boss's own calls are not in a transcript.`,
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
