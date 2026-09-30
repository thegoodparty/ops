import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaseVerdict } from "./judge";
import { ZERO_SPEND } from "./metrics";
import { renderReport, signTest, type RunResult, type Side } from "./report";

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
  end: "closed",
  gates: { closed: true, fixed: true, mergedGreen: true, noPushToMain: true },
  spend: { ...ZERO_SPEND, usd: side === "baseline" ? 10 : 8, turns: 40, unpriced: [] },
  wallClockSeconds: 3600,
  output: { rootCause: "x", diff: "y", postmortem: "z" },
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
      run("a", 1, "candidate", { end: "wall_clock", wallClockSeconds: null, gates: { closed: false, fixed: null, mergedGreen: true, noPushToMain: true } }),
      run("b", 1, "baseline"),
      run("b", 1, "candidate"),
    ],
    verdicts: [verdict("a/1", "baseline"), verdict("b/1", "candidate")],
    judgeUsd: 1,
  });
  assert.match(text, /\| a \| 1\/1 \| \$10\.00 \| 60m \| 0\/1 \| \$8\.00 \| – \| 0-1-0 \|/);
  assert.match(text, /\| \*\*Total\*\* \| 2\/2 \| \$10\.00 \| 60m \| 1\/2 \| \$8\.00 \| 60m \| 1-1-0 \|/);
  assert.match(text, /- a rep 1 candidate: ended wall_clock; closed, fix check/);
  assert.match(text, /sign test p=1\.000 over 2 decisive pairs, so this could be chance/);
});
