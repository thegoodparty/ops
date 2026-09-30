import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { join } from "node:path";

import { loadCase } from "../replay/case";
import {
  CAPS,
  REPLAY_CAPS,
  gateRegressions,
  isReplayComment,
  listCases,
  pairUp,
  parseArgs,
  planFromComment,
  planReplayFromComment,
  renderReport,
  statusOf,
  type Pair,
} from "./cli";
import type { GateResult } from "./gates";
import type { RunResult } from "./orchestrator";

const plan = (comment: string, available = ["a", "b", "c"], cap = 35) =>
  planFromComment({ comment, baseline: "base", candidate: "head", available, capUsd: () => cap, evalId: "e1" });

describe("plan", () => {
  test("defaults to every scenario, three reps, both sides", () => {
    const result = plan("bugboss eval");
    assert.equal(result.runs.length, 18);
    assert.equal(result.maxUsd, 630);
    assert.deepEqual(result.runs.slice(0, 2).map((run) => [run.side, run.ref, run.runId]), [
      ["baseline", "base", "e1-a-baseline-r1"],
      ["candidate", "head", "e1-a-candidate-r1"],
    ]);
  });

  test("aa runs the baseline on both sides", () => {
    assert.ok(plan("bugboss eval aa scenarios=a reps=1").runs.every((run) => run.ref === "base"));
  });

  test("refuses past every cap, and anything it does not recognise", () => {
    assert.throws(() => plan("bugboss eval reps=4"), /reps must be 1 to 3/);
    assert.throws(() => plan("bugboss eval scenarios=a,b,c,d,e,f,g", ["a", "b", "c", "d", "e", "f", "g"]), /at most 6/);
    assert.throws(() => plan("bugboss eval", ["a", "b", "c"], 50), /over the cap of \$700/);
    assert.throws(() => plan("bugboss eval scenarios=nope"), /no such scenario/);
    assert.throws(() => plan("bugboss eval please"), /unrecognised option/);
    assert.throws(() => plan("please bugboss eval"), /must start with/);
    assert.equal(CAPS.runs, 36);
  });

  test("argument parsing keeps flags and values apart", () => {
    assert.deepEqual(parseArgs(["run", "--scenario", "x", "--upload", "--rep", "2"]), {
      command: "run",
      args: { scenario: "x", upload: true, rep: "2" },
    });
  });
});

const gates = (failing: string[] = []): GateResult[] =>
  (["incident_closed", "no_truncation"] as const).map((name) => ({ name, pass: !failing.includes(name), detail: "" }));

const result = (over: Partial<RunResult> & { side: string | null; scenario: string; rep: number }): RunResult & { side: string | null; dir: string } => ({
  runId: `${over.scenario}-${over.side}-r${over.rep}`,
  seed: over.rep,
  bugbossImage: "img",
  ref: null,
  startedAt: 0,
  firstAlertAt: 0,
  end: { kind: "closed", at: 0, detail: "" },
  wallClockSeconds: 600,
  costUsd: 20,
  turns: 10,
  gates: gates(),
  resultsDir: "/tmp",
  dir: "/nonexistent",
  ...over,
});

describe("report", () => {
  test("maps every end to the status core/aggregate.ts counts", () => {
    assert.deepEqual(
      ["closed", "closed_inline", "wall_clock", "over_budget", "stalled", "error"].map(statusOf),
      ["completed", "completed", "timed_out", "over_budget", "stalled", "error"],
    );
  });

  test("pairs by scenario and rep and sets aside the unpartnered", () => {
    const { pairs, unpaired } = pairUp([
      result({ scenario: "a", rep: 1, side: "baseline" }),
      result({ scenario: "a", rep: 1, side: "candidate" }),
      result({ scenario: "a", rep: 2, side: "baseline" }),
    ]);
    assert.equal(pairs.length, 1);
    assert.deepEqual(unpaired.map((run) => run.runId), ["a-baseline-r2"]);
  });

  test("a gate green in every baseline rep and red in one candidate rep is blocking", () => {
    const pairs: Pair[] = [1, 2].map((rep) => ({
      scenario: "a",
      rep,
      baseline: result({ scenario: "a", rep, side: "baseline" }),
      candidate: result({ scenario: "a", rep, side: "candidate", gates: gates(rep === 2 ? ["no_truncation"] : []) }),
    }));
    assert.deepEqual(gateRegressions(pairs), [{ scenario: "a", gate: "no_truncation" }]);
  });

  test("a gate already flaky on the baseline is not a regression", () => {
    const pairs: Pair[] = [1, 2].map((rep) => ({
      scenario: "a",
      rep,
      baseline: result({ scenario: "a", rep, side: "baseline", gates: gates(rep === 1 ? ["no_truncation"] : []) }),
      candidate: result({ scenario: "a", rep, side: "candidate", gates: gates(["no_truncation"]) }),
    }));
    assert.deepEqual(gateRegressions(pairs), []);
  });

  test("says when nothing was judged, and gives the sign test's direction", () => {
    const pairs: Pair[] = [
      { scenario: "a", rep: 1, baseline: result({ scenario: "a", rep: 1, side: "baseline" }), candidate: result({ scenario: "a", rep: 1, side: "candidate", costUsd: 10 }) },
    ];
    const text = renderReport({ pairs, unpaired: [], signTest: () => undefined, judged: null });
    assert.match(text, /Cost: candidate lower in 1 of 1 pairs, higher in 0\./);
    assert.match(text, /Quality was not judged/);
    assert.doesNotMatch(text, /not available/);
    assert.match(renderReport({ pairs: [], unpaired: [], signTest: () => undefined, judged: null }), /nothing was judged/);
    const withStats = renderReport({ pairs, unpaired: [], signTest: () => 1, judged: "judged." });
    assert.match(withStats, /sign test p = 1\.000/);
    assert.match(withStats, /judged\./);
  });
});

describe("replay plan", () => {
  const replay = (comment: string, available = ["c1", "c2", "c3"], cap = 15) =>
    planReplayFromComment({ comment, baseline: "base", candidate: "head", available, capUsd: () => cap, evalId: "e2" });

  test("a replay comment is told apart from a Tier 1 one", () => {
    assert.equal(isReplayComment("bugboss eval replay"), true);
    assert.equal(isReplayComment("bugboss eval aa scenarios=replay"), false);
    assert.equal(isReplayComment("bugboss eval"), false);
  });

  test("defaults to every case, three reps, one side per task", () => {
    const result = replay("bugboss eval replay");
    assert.equal(result.tier, "replay");
    assert.equal(result.runs.length, 18);
    assert.equal(result.maxUsd, 270);
    assert.deepEqual(result.runs.slice(0, 2).map((side) => [side.case, side.side, side.ref, side.runId]), [
      ["c1", "baseline", "base", "e2-c1-baseline-r1"],
      ["c1", "candidate", "head", "e2-c1-candidate-r1"],
    ]);
  });

  test("picks cases and reps, and aa runs the baseline on both sides", () => {
    const result = replay("bugboss eval replay cases=c2 reps=2");
    assert.deepEqual(result.cases, ["c2"]);
    assert.equal(result.runs.length, 4);
    assert.ok(replay("bugboss eval replay aa cases=c1 reps=1").runs.every((side) => side.ref === "base"));
  });

  test("refuses past every cap, and anything it does not recognise", () => {
    assert.throws(() => replay("bugboss eval replay reps=4"), /reps must be 1 to 3/);
    assert.throws(() => replay("bugboss eval replay reps=0"), /reps must be 1 to 3/);
    const seven = ["a", "b", "c", "d", "e", "f", "g"];
    assert.throws(() => replay(`bugboss eval replay cases=${seven.join(",")}`, seven), /at most 6 cases/);
    assert.throws(() => replay("bugboss eval replay", ["c1", "c2", "c3"], 40), /over the cap of \$600/);
    assert.throws(() => replay("bugboss eval replay cases=nope"), /no such case/);
    assert.throws(() => replay("bugboss eval replay scenarios=c1"), /unrecognised option "scenarios=c1"/);
    assert.throws(() => replay("bugboss eval"), /must start with "bugboss eval replay"/);
    assert.equal(REPLAY_CAPS.runs, REPLAY_CAPS.cases * REPLAY_CAPS.reps * 2);
  });

  test("the six committed cases at their committed caps fit under the total cap", () => {
    const dir = join(__dirname, "..", "replay", "cases");
    const cases = listCases(dir);
    assert.ok(cases.length > 0);
    const result = planReplayFromComment({
      comment: "bugboss eval replay",
      baseline: "base",
      candidate: "head",
      available: cases,
      capUsd: (id) => loadCase(join(dir, `${id}.json`)).caps.modelUsd,
    });
    assert.ok(result.maxUsd <= REPLAY_CAPS.totalUsd);
  });
});
