import type { IncidentOutput } from "./blind";
import type { CaseVerdict } from "./judge";
import { addSpend, ZERO_SPEND, type Spend } from "./metrics";

export type Side = "baseline" | "candidate";

export interface Gates {
  /** The incident reached CLOSED. */
  closed: boolean;
  /** The hidden check passed on what was merged. Null when nothing merged. */
  fixed: boolean | null;
  /** Every merged pull request had green CI at its head. */
  mergedGreen: boolean;
  /** Nothing moved the sandbox's main, or the run's base, except a merge. */
  noPushToMain: boolean;
}

export const GATE_NAMES: Record<keyof Gates, string> = {
  closed: "closed",
  fixed: "fix check",
  mergedGreen: "CI green at merge",
  noPushToMain: "no push to main",
};

export const gatesPass = (gates: Gates): boolean =>
  gates.closed && gates.fixed === true && gates.mergedGreen && gates.noPushToMain;

export interface RunResult {
  runId: string;
  scenario: string;
  rep: number;
  side: Side;
  ref: string;
  /** How the run ended: `closed`, `root_cause`, `pr_opened`, `wall_clock`, or `error: …`. */
  end: string;
  gates: Gates;
  /** The scenario's own gates (core/gates.ts), by id. */
  scenarioGates: Record<string, boolean>;
  spend: Spend;
  /** From the alert to the close. Null when it never closed. */
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

interface SideSummary {
  runs: number;
  gatesPassed: number;
  gateCounts: Record<keyof Gates, number>;
  spend: Spend;
  meanUsd: number | null;
  meanWall: number | null;
}

const summarise = (runs: RunResult[]): SideSummary => {
  const gateCounts = { closed: 0, fixed: 0, mergedGreen: 0, noPushToMain: 0 };
  for (const run of runs) {
    if (run.gates.closed) gateCounts.closed += 1;
    if (run.gates.fixed === true) gateCounts.fixed += 1;
    if (run.gates.mergedGreen) gateCounts.mergedGreen += 1;
    if (run.gates.noPushToMain) gateCounts.noPushToMain += 1;
  }
  const walls = runs.map((r) => r.wallClockSeconds).filter((w): w is number => w !== null);
  return {
    runs: runs.length,
    gatesPassed: runs.filter((r) => gatesPass(r.gates)).length,
    gateCounts,
    spend: runs.reduce((sum, r) => addSpend(sum, r.spend), ZERO_SPEND),
    meanUsd: mean(runs.map((r) => r.spend.usd)),
    meanWall: walls.length ? mean(walls) : null,
  };
};

const verdictLine = (verdicts: CaseVerdict[]): string => {
  const judged = verdicts.filter((v) => v.excluded === null);
  const wins = judged.filter((v) => v.winner === "candidate").length;
  const losses = judged.filter((v) => v.winner === "baseline").length;
  const ties = judged.length - wins - losses;
  return `${wins}-${losses}-${ties}`;
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
}): string => {
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

  const judged = args.verdicts.filter((v) => v.excluded === null);
  const wins = judged.filter((v) => v.winner === "candidate").length;
  const losses = judged.filter((v) => v.winner === "baseline").length;
  const p = signTest(wins, losses);

  const gateTable = (["baseline", "candidate"] as Side[]).map((side) => {
    const s = summarise(pick(null, side));
    return `| ${side} | ${(Object.keys(GATE_NAMES) as (keyof Gates)[]).map((g) => `${s.gateCounts[g]}/${s.runs}`).join(" | ")} |`;
  });

  const spendTable = (["baseline", "candidate"] as Side[]).map((side) => {
    const s = summarise(pick(null, side)).spend;
    return `| ${side} | ${tokens(s.input)} | ${tokens(s.output)} | ${tokens(s.cacheRead)} | ${tokens(s.cacheWrite)} | ${s.turns} | ${usd(s.usd)} |`;
  });

  const scenarioGateRows = scenarios.flatMap((scenario) => {
    const ids = [...new Set(args.runs.filter((r) => r.scenario === scenario).flatMap((r) => Object.keys(r.scenarioGates ?? {})))];
    return ids.map((id) => {
      const cell = (side: Side) => {
        const runs = pick(scenario, side);
        return `${runs.filter((r) => r.scenarioGates?.[id] === true).length}/${runs.length}`;
      };
      return `| ${scenario} | ${id} | ${cell("baseline")} | ${cell("candidate")} |`;
    });
  });

  const failures = args.runs.filter((r) => !gatesPass(r.gates));
  const excluded = args.verdicts.filter((v) => v.excluded !== null);
  const unpriced = [...new Set(args.runs.flatMap((r) => r.spend.unpriced))];

  return [
    "## BugBoss eval (advisory)",
    "",
    `Baseline \`${args.baselineRef}\` against candidate \`${args.candidateRef}\`. Each cell is gates passed, mean estimated cost per run (priced from tokens), and mean time from alert to close. Quality is the candidate's wins-losses-ties from a blind, order-swapped judge.`,
    "",
    "| Scenario | Baseline gates | cost | wall | Candidate gates | cost | wall | Quality W-L-T |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...scenarios.map((s) => row(s, s)),
    row("**Total**", null),
    "",
    p === undefined
      ? "Quality: no decisive pairs."
      : `Quality: sign test p=${p.toFixed(3)} over ${wins + losses} decisive pairs${p < 0.05 ? "." : ", so this could be chance."}`,
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
                .filter((g) => r.gates[g] !== true)
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
