/**
 * Turns pairs of runs into a comparison. The unit is a pair: the same
 * (scenario, rep), run once on each side and started together.
 *
 * Quality uses universal judge's rules unchanged (omni
 * packages/universal-judge/src/aggregate.ts): a two-sided exact sign test over
 * stable, non-tied verdicts, no direction below six decided pairs, and an
 * inconclusive result when more than 20% of pairs flip under order swap.
 *
 * Cost and wall clock get the same sign test on the direction of each pair's
 * difference, with the median difference as the magnitude.
 *
 * Gates are not statistical. A gate that passed in every baseline rep of a
 * scenario and failed in any candidate rep is a blocking regression, named
 * per scenario.
 */

import type { CaseVerdict, Margin } from "./judge";

const POINTS: Record<Margin, number> = { much_better: 2, better: 1, tie: 0 };

/** Below this, a direction is not worth acting on even if the sign test likes it. */
export const MIN_DECISIVE_MEAN = 0.25;

/** Above this share of order flips the judge is not measuring anything stable. */
export const MAX_FLIP_RATE = 0.2;

/**
 * Fewest non-tied pairs that could ever reach p<0.05 on a two-sided sign test:
 * a clean sweep of n is 2/2^n, which first crosses 0.05 at n=6.
 */
export const MIN_POWERED_CASES = 6;

export type RunStatus = "completed" | "timed_out" | "over_budget" | "stalled" | "error";

/** One side of one pair, as the orchestrator or the replay runner recorded it. */
export interface RunRecord {
  status: RunStatus;
  /** From the model proxy. An over-budget run is recorded at the cap. */
  costUsd: number | null;
  wallClockSeconds: number | null;
  /** Deterministic gates, by name. True is a pass. */
  gates: Record<string, boolean>;
}

export interface PairRecord {
  pairId: string;
  scenarioId: string;
  rep: number;
  baseline: RunRecord;
  candidate: RunRecord;
  /** Null when the pair was not judged at all, which Tier 2 allows. */
  verdict: CaseVerdict | null;
}

const choose = (n: number, k: number) => {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result;
};

/**
 * Two-sided exact binomial, p=0.5. Answers only "could this split have come
 * from a coin?", and says nothing about magnitude.
 */
export const signTest = (wins: number, losses: number): number | undefined => {
  const n = wins + losses;
  if (n === 0) return undefined;
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += choose(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
};

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const pct = (v: number): string => `${Math.round(v * 100)}%`;
export const signed = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

export interface QualitySummary {
  pairs: number;
  judged: number;
  excluded: number;
  wins: number;
  ties: number;
  losses: number;
  meanScore: number;
  flipRate: number;
  signTestP: number | undefined;
  judgeCostUsd: number;
  verdict: string;
  explanation: string;
}

export const summariseQuality = (verdicts: CaseVerdict[]): QualitySummary => {
  const judged = verdicts.filter((v) => v.excluded === null);
  const scored = judged.filter((v) => !v.flipped);
  const wins = scored.filter((v) => v.winner === "candidate").length;
  const losses = scored.filter((v) => v.winner === "baseline").length;
  const ties = scored.length - wins - losses;
  const meanScore = mean(
    scored.map((v) =>
      v.winner === "candidate" ? POINTS[v.margin] : v.winner === "baseline" ? -POINTS[v.margin] : 0,
    ),
  );
  const flipRate = judged.length ? judged.filter((v) => v.flipped).length / judged.length : 0;
  const signTestP = signTest(wins, losses);
  return {
    pairs: verdicts.length,
    judged: judged.length,
    excluded: verdicts.length - judged.length,
    wins,
    ties,
    losses,
    meanScore,
    flipRate,
    signTestP,
    judgeCostUsd: verdicts.reduce((sum, v) => sum + v.judgeCostUsd, 0),
    ...qualityHeadline({
      judged: judged.length,
      scored: scored.length,
      wins,
      ties,
      losses,
      meanScore,
      flipRate,
      signTestP,
    }),
  };
};

const qualityHeadline = (s: {
  judged: number;
  scored: number;
  wins: number;
  ties: number;
  losses: number;
  meanScore: number;
  flipRate: number;
  signTestP: number | undefined;
}): { verdict: string; explanation: string } => {
  if (s.judged === 0) return { verdict: "no result", explanation: "No pairs were judged." };
  if (s.flipRate > MAX_FLIP_RATE) {
    return {
      verdict: "inconclusive",
      explanation:
        `The judge reversed itself on ${pct(s.flipRate)} of pairs when the two outputs ` +
        `were swapped, above the ${pct(MAX_FLIP_RATE)} bar. The outputs are too close to ` +
        `separate, or the rubric does not discriminate here.`,
    };
  }
  if (s.scored === 0) {
    return { verdict: "inconclusive", explanation: "Every pair flipped under order swap." };
  }
  const tally =
    `${s.wins} win / ${s.ties} tie / ${s.losses} loss for the candidate, mean graded ` +
    `preference ${signed(s.meanScore)} on a -2..+2 scale.`;
  if (Math.abs(s.meanScore) < MIN_DECISIVE_MEAN) {
    return { verdict: "no material change", explanation: `${tally} Too small to act on.` };
  }
  const decided = s.wins + s.losses;
  if (decided < MIN_POWERED_CASES) {
    return {
      verdict: "not enough pairs to call",
      explanation:
        `${tally} Only ${decided} pair(s) separated the two sides, and at that sample ` +
        `size even a clean sweep cannot reach p<0.05. Run at least ${MIN_POWERED_CASES} ` +
        `decided pairs to get a verdict worth acting on.`,
    };
  }
  const direction = s.meanScore > 0 ? "better" : "worse";
  const strength = Math.abs(s.meanScore) >= 1 ? "much " : "";
  const sig =
    s.signTestP === undefined
      ? ""
      : s.signTestP < 0.05
        ? ` Sign test p=${s.signTestP.toFixed(3)}.`
        : ` Sign test p=${s.signTestP.toFixed(3)}, so this could still be chance.`;
  return { verdict: `candidate is ${strength}${direction}`, explanation: `${tally}${sig}` };
};

export type DeltaField = "costUsd" | "wallClockSeconds";

export interface DeltaSummary {
  field: DeltaField;
  /** Pairs where both sides reported the measure. */
  pairs: number;
  /** Candidate minus baseline, per pair. */
  deltas: number[];
  medianDelta: number | undefined;
  medianBaseline: number | undefined;
  medianCandidate: number | undefined;
  /** Pairs where the candidate came in lower. */
  lower: number;
  higher: number;
  equal: number;
  signTestP: number | undefined;
  verdict: string;
}

export const summariseDelta = (pairs: PairRecord[], field: DeltaField): DeltaSummary => {
  const both = pairs.filter(
    (p) => typeof p.baseline[field] === "number" && typeof p.candidate[field] === "number",
  );
  const deltas = both.map((p) => (p.candidate[field] as number) - (p.baseline[field] as number));
  const lower = deltas.filter((d) => d < 0).length;
  const higher = deltas.filter((d) => d > 0).length;
  const signTestP = signTest(lower, higher);
  const decided = lower + higher;
  const noun = field === "costUsd" ? ["cheaper", "costlier"] : ["faster", "slower"];
  const verdict =
    both.length === 0
      ? "no result"
      : decided < MIN_POWERED_CASES
        ? "not enough pairs to call"
        : signTestP !== undefined && signTestP < 0.05
          ? `candidate is ${lower > higher ? noun[0] : noun[1]}`
          : "no significant difference";
  return {
    field,
    pairs: both.length,
    deltas,
    medianDelta: median(deltas),
    medianBaseline: median(both.map((p) => p.baseline[field] as number)),
    medianCandidate: median(both.map((p) => p.candidate[field] as number)),
    lower,
    higher,
    equal: deltas.length - decided,
    signTestP,
    verdict,
  };
};

export interface GateRegression {
  scenarioId: string;
  gate: string;
  baselineReps: number;
  /** The candidate reps that failed a gate every baseline rep passed. */
  failedReps: number[];
}

export const gateRegressions = (pairs: PairRecord[]): GateRegression[] => {
  const regressions: GateRegression[] = [];
  const scenarios = [...new Set(pairs.map((p) => p.scenarioId))].sort();
  for (const scenarioId of scenarios) {
    const mine = pairs.filter((p) => p.scenarioId === scenarioId);
    const gates = [
      ...new Set(mine.flatMap((p) => [...Object.keys(p.baseline.gates), ...Object.keys(p.candidate.gates)])),
    ].sort();
    for (const gate of gates) {
      // A gate the baseline never reported cannot regress: there is nothing
      // to regress from, and treating absence as a pass would invent one.
      const baselinePassedEvery = mine.every((p) => p.baseline.gates[gate] === true);
      if (!baselinePassedEvery) continue;
      const failedReps = mine.filter((p) => p.candidate.gates[gate] !== true).map((p) => p.rep);
      if (failedReps.length > 0) {
        regressions.push({ scenarioId, gate, baselineReps: mine.length, failedReps });
      }
    }
  }
  return regressions;
};

export interface Section {
  quality: QualitySummary;
  cost: DeltaSummary;
  wallClock: DeltaSummary;
  statuses: { baseline: Record<RunStatus, number>; candidate: Record<RunStatus, number> };
}

export interface Comparison {
  overall: Section;
  byScenario: Record<string, Section>;
  regressions: GateRegression[];
  pairs: PairRecord[];
  /** Both sides are the same ref: this measures noise, not a change. */
  aa: boolean;
  ship: { passes: boolean; reasons: string[] };
}

const statusCounts = (runs: RunRecord[]): Record<RunStatus, number> => {
  const counts: Record<RunStatus, number> = {
    completed: 0,
    timed_out: 0,
    over_budget: 0,
    stalled: 0,
    error: 0,
  };
  for (const run of runs) counts[run.status] += 1;
  return counts;
};

const section = (pairs: PairRecord[]): Section => ({
  quality: summariseQuality(pairs.flatMap((p) => (p.verdict ? [p.verdict] : []))),
  cost: summariseDelta(pairs, "costUsd"),
  wallClock: summariseDelta(pairs, "wallClockSeconds"),
  statuses: {
    baseline: statusCounts(pairs.map((p) => p.baseline)),
    candidate: statusCounts(pairs.map((p) => p.candidate)),
  },
});

export const compare = (pairs: PairRecord[], options: { aa?: boolean } = {}): Comparison => {
  const byScenario: Record<string, Section> = {};
  for (const id of [...new Set(pairs.map((p) => p.scenarioId))].sort()) {
    byScenario[id] = section(pairs.filter((p) => p.scenarioId === id));
  }
  const overall = section(pairs);
  const regressions = gateRegressions(pairs);
  const reasons: string[] = [];
  if (regressions.length > 0) {
    reasons.push(
      `${regressions.length} gate regression(s): ${regressions.map((r) => `${r.scenarioId} ${r.gate}`).join(", ")}`,
    );
  }
  const q = overall.quality;
  if (q.meanScore < 0 && q.signTestP !== undefined && q.signTestP < 0.05 && q.verdict.endsWith("worse")) {
    reasons.push(`quality is significantly worse (${q.verdict}, p=${q.signTestP.toFixed(3)})`);
  }
  return {
    overall,
    byScenario,
    regressions,
    pairs,
    aa: options.aa ?? false,
    ship: { passes: reasons.length === 0, reasons },
  };
};
