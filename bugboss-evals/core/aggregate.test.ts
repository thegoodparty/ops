import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compare,
  gateRegressions,
  MAX_FLIP_RATE,
  median,
  signTest,
  summariseDelta,
  summariseQuality,
  type PairRecord,
  type RunRecord,
} from "./aggregate";
import type { CaseVerdict, Margin, RootCauseLabel } from "./judge";
import { renderComparison } from "./report";

const verdict = (
  pairId: string,
  winner: CaseVerdict["winner"],
  margin: Margin,
  flipped = false,
  excluded: string | null = null,
): CaseVerdict => ({
  pairId,
  winner,
  margin,
  decidingCriterion: "root cause",
  rationale: "because",
  flipped,
  excluded,
  judgeCostUsd: 0.01,
  blindedLines: 0,
});

const runRecord = (costUsd: number, wall: number, gates: Record<string, boolean> = {}): RunRecord => ({
  status: "completed",
  costUsd,
  wallClockSeconds: wall,
  gates,
});

const pair = (
  i: number,
  scenarioId: string,
  baseline: RunRecord,
  candidate: RunRecord,
  v: CaseVerdict | null = null,
): PairRecord => ({ pairId: `${scenarioId}/${i}`, scenarioId, rep: i, baseline, candidate, verdict: v });

test("the sign test is universal judge's: undefined, even, sweep, symmetric", () => {
  assert.equal(signTest(0, 0), undefined);
  assert.equal(signTest(5, 5), 1);
  assert.ok(Math.abs((signTest(10, 0) as number) - 2 / 1024) < 1e-12);
  assert.equal(signTest(8, 2), signTest(2, 8));
  // The power floor: 5-0 cannot reach 0.05, 6-0 can.
  assert.ok((signTest(5, 0) as number) > 0.05);
  assert.ok((signTest(6, 0) as number) < 0.05);
});

test("a clean candidate sweep of six is much better and significant", () => {
  const s = summariseQuality(Array.from({ length: 6 }, (_, i) => verdict(`c${i}`, "candidate", "better")));
  assert.equal(s.verdict, "candidate is much better");
  assert.ok((s.signTestP as number) < 0.05);
});

test("below six decided pairs no direction is claimed", () => {
  const s = summariseQuality(Array.from({ length: 5 }, (_, i) => verdict(`c${i}`, "baseline", "much_better")));
  assert.equal(s.verdict, "not enough pairs to call");
});

test("more than 20% flips is inconclusive; flips are excluded from the score", () => {
  const many = summariseQuality([
    ...Array.from({ length: 3 }, (_, i) => verdict(`f${i}`, "tie", "tie", true)),
    ...Array.from({ length: 5 }, (_, i) => verdict(`c${i}`, "candidate", "much_better")),
  ]);
  assert.ok(many.flipRate > MAX_FLIP_RATE);
  assert.equal(many.verdict, "inconclusive");
  const one = summariseQuality([
    verdict("f", "tie", "tie", true),
    ...Array.from({ length: 9 }, (_, i) => verdict(`c${i}`, "candidate", "better")),
  ]);
  assert.equal(one.meanScore, 1);
});

test("an excluded pair is counted but neither scored nor a flip", () => {
  const s = summariseQuality([
    verdict("x", "tie", "tie", false, "refused: too long"),
    ...Array.from({ length: 6 }, (_, i) => verdict(`c${i}`, "candidate", "better")),
  ]);
  assert.equal(s.excluded, 1);
  assert.equal(s.judged, 6);
  assert.equal(s.flipRate, 0);
});

test("cost and wall clock report median deltas and a sign test on direction", () => {
  const pairs = Array.from({ length: 7 }, (_, i) => pair(i, "s", runRecord(20 + i, 3600), runRecord(15 + i, 3600 + i)));
  const cost = summariseDelta(pairs, "costUsd");
  assert.equal(cost.medianDelta, -5);
  assert.equal(cost.lower, 7);
  assert.equal(cost.verdict, "candidate is cheaper");
  const wall = summariseDelta(pairs, "wallClockSeconds");
  assert.equal(wall.equal, 1);
  assert.equal(wall.verdict, "candidate is slower");
  assert.equal(median([3, 1, 2, 4]), 2.5);
});

test("a gate every baseline rep passed and any candidate rep failed is a regression", () => {
  const pairs = [
    pair(1, "a", runRecord(1, 1, { closed: true, noTruncation: true }), runRecord(1, 1, { closed: true, noTruncation: true })),
    pair(2, "a", runRecord(1, 1, { closed: true, noTruncation: true }), runRecord(1, 1, { closed: false, noTruncation: true })),
    pair(1, "b", runRecord(1, 1, { closed: false }), runRecord(1, 1, { closed: false })),
  ];
  const regressions = gateRegressions(pairs);
  assert.deepEqual(regressions, [{ scenarioId: "a", gate: "closed", baselineReps: 2, failedReps: [2] }]);
});

test("a gate the baseline failed in some rep cannot regress", () => {
  const pairs = [
    pair(1, "a", runRecord(1, 1, { closed: false }), runRecord(1, 1, { closed: false })),
    pair(2, "a", runRecord(1, 1, { closed: true }), runRecord(1, 1, { closed: false })),
  ];
  assert.deepEqual(gateRegressions(pairs), []);
});

test("the ship rule fails on a gate regression and names it", () => {
  const pairs = [pair(1, "a", runRecord(1, 1, { closed: true }), runRecord(1, 1, { closed: false }))];
  const c = compare(pairs);
  assert.equal(c.ship.passes, false);
  assert.match(c.ship.reasons[0], /a closed/);
});

test("the ship rule fails when quality is significantly worse", () => {
  const pairs = Array.from({ length: 6 }, (_, i) =>
    pair(i, "a", runRecord(1, 1), runRecord(1, 1), verdict(`a/${i}`, "baseline", "better")),
  );
  assert.equal(compare(pairs).ship.passes, false);
});

test("the comparison report states the ship rule, per-scenario results and every pair", () => {
  const pairs = [
    ...Array.from({ length: 3 }, (_, i) =>
      pair(i, "pool", runRecord(20, 3600, { closed: true }), runRecord(12, 3000, { closed: true }), verdict(`pool/${i}`, "candidate", "better")),
    ),
    pair(9, "loki", runRecord(30, 4000, { closed: true }), runRecord(28, 4100, { closed: false }), verdict("loki/9", "tie", "tie", false, "refused: too long")),
  ];
  const text = renderComparison({
    comparison: compare(pairs),
    tier: "Tier 1",
    baselineRef: "main",
    candidateRef: "feat/x",
    judgeModel: "us.anthropic.claude-opus-5",
  });
  assert.match(text, /Ship rule: fails/);
  assert.match(text, /### pool/);
  assert.match(text, /### loki/);
  assert.match(text, /\| loki \| closed \| 1 \| 9 \|/);
  assert.match(text, /refused: too long/);
  assert.match(text, /\| Cost \| \$20\.00 \| \$12\.00 \| -\$8\.00 \|/);
});

test("an A/A report describes noise instead of a ship decision", () => {
  const pairs = Array.from({ length: 3 }, (_, i) => pair(i, "pool", runRecord(20, 3600), runRecord(20 + i, 3600 - i * 60)));
  const text = renderComparison({ comparison: compare(pairs, { aa: true }), tier: "Tier 2", baselineRef: "main", candidateRef: "main" });
  assert.match(text, /A\/A calibration/);
  assert.match(text, /run-to-run noise/);
  assert.ok(!/Ship rule/.test(text));
});

test("the report flags a heuristic or unknown root cause per pair, and names the side", () => {
  const withSources = (id: string, baseline: RootCauseLabel, candidate: RootCauseLabel): CaseVerdict => ({
    ...verdict(id, "candidate", "better"),
    vettedReference: true,
    rootCauseSources: { baseline, candidate },
  });
  const pairs = [
    pair(1, "pool", runRecord(20, 3600), runRecord(12, 3000), withSources("pool/1", "closing_summary", "heuristic")),
    pair(2, "pool", runRecord(20, 3600), runRecord(12, 3000), withSources("pool/2", "unknown", "closing_summary")),
    pair(3, "pool", runRecord(20, 3600), runRecord(12, 3000), withSources("pool/3", "closing_summary", "closing_summary")),
  ];
  const text = renderComparison({ comparison: compare(pairs), tier: "Tier 1", baselineRef: "main", candidateRef: "feat/x" });
  assert.match(text, /## Judge input caveats/);
  assert.match(text, /\| pool\/1 \| pool \| candidate root cause is heuristic \|/);
  assert.match(text, /\| pool\/2 \| pool \| baseline root cause source unknown \|/);
  assert.ok(!/\| pool\/3 \| pool \| [a-z]/.test(text));
});

test("a scenario with no vetted reference says so, even when no pair was judged", () => {
  const pairs = [
    { ...pair(1, "incident-80-post-pr", runRecord(20, 3600), runRecord(12, 3000)), vettedReference: false },
    pair(1, "incident-2-post-pr", runRecord(20, 3600), runRecord(12, 3000)),
  ];
  const text = renderComparison({ comparison: compare(pairs), tier: "Tier 2", baselineRef: "main", candidateRef: "feat/x" });
  const section = text.split("### incident-80-post-pr")[1].split("###")[0];
  assert.match(section, /No vetted reference/);
  assert.ok(!/No vetted reference/.test(text.split("### incident-2-post-pr")[1].split("###")[0]));
  assert.match(text, /\| incident-80-post-pr\/1 \| incident-80-post-pr \| no vetted reference \|/);
});
