import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaseVerdict } from "./judge";
import { ZERO_SPEND } from "./metrics";
import { qualityCall, renderReport, signTest, type RunResult, type Side } from "./report";

test("the sign test is the exact two-sided binomial", () => {
  assert.equal(signTest(0, 0), undefined);
  assert.equal(signTest(6, 0)!.toFixed(4), "0.0313");
  assert.equal(signTest(5, 1)!.toFixed(4), "0.2188");
  assert.equal(signTest(3, 3), 1);
});

const run = (scenario: string, rep: number, side: Side, over: Partial<RunResult> = {}): RunResult => ({
  runId: `${scenario}-${rep}-${side}`,
  scenario,
  rep,
  side,
  ref: side === "baseline" ? "main" : "pr",
  until: "closed",
  end: "closed",
  gates: { closed: true, fixed: true, mergedGreen: true, noPushToMain: true },
  spend: { ...ZERO_SPEND, usd: side === "baseline" ? 10 : 8, turns: 40, unpriced: [] },
  wallClock: { prOpened: 1200, merged: 2400, closed: 3600 },
  ...over,
});

const verdict = (pairId: string, winner: CaseVerdict["winner"]): CaseVerdict => ({
  pairId,
  winner,
  margin: winner === "tie" ? "tie" : "better",
  decidingCriterion: "",
  rationale: "",
  flipped: false,
  excluded: null,
  judgeCostUsd: 0.5,
  blindedLines: 0,
});

test("the report has a row per scenario and a total, and names the runs that failed a gate", () => {
  const text = renderReport({
    baselineRef: "main",
    candidateRef: "pr",
    runs: [
      run("a", 1, "baseline"),
      run("a", 1, "candidate", { end: "wall_clock", wallClock: { prOpened: 1200, merged: null, closed: null }, gates: { closed: false, fixed: null, mergedGreen: true, noPushToMain: true } }),
      run("b", 1, "baseline"),
      run("b", 1, "candidate"),
    ],
    verdicts: [verdict("a/1", "baseline"), verdict("b/1", "candidate")],
    judgeUsd: 1,
    tier: "full",
    capUsd: 200,
  });
  assert.match(text, /Tier: \*\*full\*\*, each run stopping at close/);
  assert.match(text, /Estimated spend: \$37\.00 of the \$200\.00 cap\./);
  assert.match(text, /## Incident eval/);
  assert.match(text, /\| a \| 1\/1 \| 40 \| \$10\.00 \| 20m \| 40m \| 60m \| 0\/1 \| 40 \| \$8\.00 \| 20m \| – \| – \| 0-1-0 \|/);
  assert.match(text, /\| \*\*Total\*\* \| 2\/2 \| 40 \| \$10\.00 \| 20m \| 40m \| 60m \| 1\/2 \| 40 \| \$8\.00 \| 20m \| 40m \| 60m \| 1-1-0 \|/);
  assert.match(text, /\| a \| candidate \| 0 \| 0 \| 0 \| 0 \| 40 \| \$8\.00 \|/);
  assert.match(text, /\| \*\*Total\*\* \| baseline \| 0 \| 0 \| 0 \| 0 \| 80 \| \$20\.00 \|/);
  assert.match(text, /- a rep 1 candidate: ended wall_clock; closed$/m);
  assert.doesNotMatch(text, /Scenario gate|BugBoss|the Boss/);
  assert.match(text, /Quality: no material change \(mean \+0\.00 on -2\.\.\+2\)/);
});

test("a fast-tier run's merge gates read n/a, and runs stopped at the cap are counted", () => {
  const fast = (side: Side, over: Partial<RunResult> = {}) =>
    run("a", 1, side, {
      until: "pr_opened",
      end: "pr_opened",
      gates: { closed: null, fixed: null, mergedGreen: null, noPushToMain: true },
      wallClock: { prOpened: 600, merged: null, closed: null },
      ...over,
    });
  const text = renderReport({
    baselineRef: "main",
    candidateRef: "pr",
    runs: [fast("baseline"), fast("candidate", { end: "spend_cap", wallClock: { prOpened: null, merged: null, closed: null } })],
    verdicts: [],
    judgeUsd: 0,
    tier: "fast",
    capUsd: 40,
  });
  assert.match(text, /each run stopping at PR opened/);
  assert.match(text, /\| a \| 1\/1 \| 40 \| \$10\.00 \| 10m \| – \| – \| 1\/1 \| 40 \| \$8\.00 \| – \| – \| – \|/);
  assert.match(text, /\| baseline \| n\/a \| n\/a \| n\/a \| 1\/1 \|/);
  assert.match(text, /of the \$40\.00 cap\. 1 runs stopped at the cap\./);
});

test("the quality call follows the universal judge: flips, then materiality, then power, then direction", () => {
  const many = (n: number, winner: CaseVerdict["winner"]) => Array.from({ length: n }, (_, i) => verdict(`s/${i}`, winner));
  const flipped = { ...verdict("f/1", "tie"), flipped: true };
  assert.match(qualityCall([...many(3, "candidate"), flipped]), /inconclusive, the judge flipped on 1 of 4/);
  assert.match(qualityCall([...many(3, "candidate"), ...many(3, "baseline")]), /no material change \(mean \+0\.00/);
  assert.match(qualityCall(many(5, "candidate")), /not enough cases to call \(mean \+1\.00 on -2\.\.\+2, 5 decisive pairs/);
  assert.match(qualityCall(many(6, "baseline")), /the candidate is much worse \(mean -1\.00 on -2\.\.\+2, sign test p=0\.031 over 6 decisive pairs\)/);
  assert.match(qualityCall([...many(5, "candidate"), ...many(2, "baseline"), ...many(3, "tie")]), /the candidate is better \(mean \+0\.30.*so this could be chance/);
  assert.equal(qualityCall([{ ...verdict("x/1", "tie"), excluded: "too long" }]), "Quality: no pairs judged.");
});

test("a stub report says no Bedrock money was spent", () => {
  const text = renderReport({ baselineRef: "main", candidateRef: "pr", runs: [run("a", 1, "baseline"), run("a", 1, "candidate")], verdicts: [], judgeUsd: 0, tier: "stub", capUsd: null });
  assert.match(text, /No Bedrock spend: a scripted model answered every call\./);
  assert.doesNotMatch(text, /Estimated spend/);
});
