import { test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutFor, loadRecord, readManifest, scoreRun, selectCases } from "../expect";
import { planReplays } from "../replay-plan";
import { replayCase } from "../replay";
import type { ReviewRecord } from "../../schema";
import { readSuiteEnv } from "./config";

// The expected-result suite under vitest: one concurrent test per (case, run),
// instead of the hand-rolled worker pool `review:expect --mode replay` used to
// run in CI. Replay itself is unchanged — the same `replayCase`, the same
// `<out>/<caseId>/run-<n>.json` files, the same per-case progress line — so
// scoring, the gate and the cache read exactly what they read before.
//
// The workflow sets EVAL_* and vitest's own `--maxConcurrency` supplies the
// pool, so a job's cost per run is the same single flag it was before.

const DEFAULT_MANIFEST = join(__dirname, "..", "expected", "manifest.json");

const env = readSuiteEnv({ replays: 3, workDir: "/tmp/review-expect" }, "expected");
const manifestPath = env.manifest ?? DEFAULT_MANIFEST;
const cases = selectCases(readManifest(manifestPath), { case: env.case, split: env.split });
if (cases.length === 0) {
  throw new Error(
    `no expected case matches${env.case ? ` EVAL_CASE ${env.case}` : ""}${env.split ? ` EVAL_SPLIT ${env.split}` : ""}`,
  );
}

const records = new Map<string, ReviewRecord>(
  cases.map((c) => [c.id, loadRecord(c, manifestPath)]),
);
const synthetic = new Set(
  cases.filter((c) => c.source === "simulated").map((c) => records.get(c.id)!.bundle.headSha),
);
const checkout = checkoutFor(synthetic);
const plan = planReplays(cases, {
  out: env.out,
  replays: env.replays,
  fromRun: env.fromRun,
  force: env.force,
  id: (c) => c.id,
});

console.log(
  `expected suite: ${cases.length} case(s), ${env.replays} run(s) each, ` +
    `${plan.pending.length} to replay, ${plan.reused.length} already had results`,
);

const report = (): void => {
  for (const p of plan.pending) console.log(`  ${p.id} run ${p.run}`);
  if (plan.reused.length > 0) {
    console.log(`  reusing ${plan.reused.length} cached run(s)`);
  }
};

if (env.dryRun) {
  // Plan only: prints the pairs the run would execute and calls no model.
  test("dry run lists the planned (case, run) pairs", () => {
    report();
    console.log(`  ${plan.pending.length} replay(s) planned at EVAL_REPLAYS=${env.replays}`);
  });
} else if (plan.pending.length === 0) {
  // No test in the file would make vitest fail the whole run, so a fully
  // cached suite says so in one passing test.
  test("every run was already cached", () => {
    console.log(`  nothing to replay; ${plan.reused.length} cached run(s)`);
  });
} else {
  for (const p of plan.pending) {
    const c = p.item;
    test.concurrent(`${c.id} run ${p.run}`, async () => {
      const result = await replayCase(
        records.get(c.id)!,
        { workDir: join(env.workDir, `run-${p.run}`), variant: env.variant },
        undefined,
        checkout,
      );
      rmSync(join(env.workDir, `run-${p.run}`, c.id), { recursive: true, force: true });
      mkdirSync(join(env.out, c.id), { recursive: true });
      writeFileSync(p.resultPath, JSON.stringify(result, null, 2));
      // The same line the expect loop prints. An errored replay is a result,
      // not a failed test: scoring decides what it means, as it did before.
      console.error(`  ${c.id} run ${p.run}: ${scoreRun(c.expect, result).outcome}`);
    });
  }
}
