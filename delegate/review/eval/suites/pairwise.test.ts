import { test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, loadScenarios, scenarioNames } from "../cases";
import { planReplays } from "../replay-plan";
import { replayCase } from "../replay";
import { readSuiteEnv } from "./config";

// The pairwise suite under vitest: one concurrent test per (case, run),
// replacing the worker pool in `review:eval replay`. The cases are the
// scenario records the workflow materialized, and `replayCase` is unchanged,
// so the judge reads the same `<out>/<caseId>/run-<n>.json` files either way.
//
// Which checkout replays is decided by `cwd`, exactly as before: the PR side
// runs this file from the PR's own checkout, so the PR's reviewer code is
// what replay executes, and main's side runs it from main.

const env = readSuiteEnv({ replays: 2, workDir: "/tmp/review-eval" }, "pairwise");
if (env.casesDir === undefined) {
  throw new Error("EVAL_CASES_DIR is not set; it is the directory `review:eval cases scenarios` wrote");
}

let records = loadCases(env.casesDir);
if (env.split !== undefined) {
  // The scenarios manifest is the only mapping from a case record to its
  // split, the same one `review:eval replay --split` reads.
  if (env.manifest === undefined) {
    throw new Error("EVAL_SPLIT needs EVAL_MANIFEST, the scenarios.json that labels each case");
  }
  const inSplit = scenarioNames(loadScenarios(env.manifest, { split: env.split }));
  records = records.filter((r) => inSplit.has(r.runId));
}
if (env.case !== undefined) {
  const ids = new Set(env.case.split(","));
  records = records.filter((r) => ids.has(r.runId));
}
if (records.length === 0) {
  throw new Error(
    `no pairwise case in ${env.casesDir}${env.case ? ` matching EVAL_CASE ${env.case}` : ""}${env.split ? ` in split ${env.split}` : ""}`,
  );
}

const plan = planReplays(records, {
  out: env.out,
  replays: env.replays,
  fromRun: env.fromRun,
  force: env.force,
  id: (r) => r.runId,
});

console.log(
  `pairwise suite: ${records.length} case(s), ${env.replays} run(s) each, ` +
    `${plan.pending.length} to replay, ${plan.reused.length} already had results`,
);

const report = (): void => {
  for (const p of plan.pending) console.log(`  ${p.id} run ${p.run}`);
  if (plan.reused.length > 0) {
    console.log(`  reusing ${plan.reused.length} cached run(s)`);
  }
};

if (env.dryRun) {
  test("dry run lists the planned (case, run) pairs", () => {
    report();
    console.log(`  ${plan.pending.length} replay(s) planned at EVAL_REPLAYS=${env.replays}`);
  });
} else if (plan.pending.length === 0) {
  test("every run was already cached", () => {
    console.log(`  nothing to replay; ${plan.reused.length} cached run(s)`);
  });
} else {
  for (const p of plan.pending) {
    const record = p.item;
    test.concurrent(`${record.runId} run ${p.run}`, async () => {
      const result = await replayCase(record, {
        workDir: join(env.workDir, `run-${p.run}`),
        variant: env.variant,
      });
      mkdirSync(join(env.out, record.runId), { recursive: true });
      writeFileSync(p.resultPath, JSON.stringify(result, null, 2));
      // The one-line progress the pairwise pool printed per batch, now per
      // run. An errored replay is a result the judge reads, not a test
      // failure, which is what the loop did before.
      console.error(
        `  ${record.runId} run ${p.run}: ${result.error === undefined ? "replayed" : `error: ${result.error.slice(0, 200)}`}`,
      );
    });
  }
}
