import { resolve } from "node:path";

// The suites are configured from the environment, not from argv: a test file
// has no argv of its own. Whoever launches vitest names the cases, the results
// directory and the replay count the same way `JUDGE_ARM=… npx vitest run
// <file>` does for the omni judge. Concurrency is not here on purpose: that is
// vitest's `--maxConcurrency`, so the runner owns the pool and one flag sizes
// it.

const text = (name: string): string | undefined => {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const positiveInt = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} is "${raw}", which is not a positive whole number`);
  }
  return Number(raw);
};

export interface SuiteEnvDefaults {
  // Replays per case. The expected suite runs each case three times in CI;
  // pairwise twice per side.
  replays: number;
  // Per-suite scratch directory, so two suites on one machine never share a
  // checkout.
  workDir: string;
}

export interface SuiteEnv {
  // Pairwise only: the materialized scenario case records.
  casesDir?: string;
  // Expected only: the case manifest, whose bundles resolve next to it.
  manifest?: string;
  out: string;
  variant?: string;
  replays: number;
  fromRun: number;
  workDir: string;
  force: boolean;
  // Comma-separated case ids, the same selection `--case` makes.
  case?: string;
  split?: "tune" | "holdout";
  // Parse, plan and report the (case, run) pairs without calling the model.
  dryRun: boolean;
}

export const readSuiteEnv = (defaults: SuiteEnvDefaults, suite: string): SuiteEnv => {
  const out = text("EVAL_OUT");
  if (out === undefined) {
    throw new Error(`EVAL_OUT is not set; it is the results directory this ${suite} suite writes`);
  }
  const split = text("EVAL_SPLIT");
  if (split !== undefined && split !== "tune" && split !== "holdout") {
    throw new Error(`EVAL_SPLIT is "${split}", which is not tune or holdout`);
  }
  const casesDir = text("EVAL_CASES_DIR");
  const manifest = text("EVAL_MANIFEST");
  const variant = text("EVAL_VARIANT");
  const caseFilter = text("EVAL_CASE");
  return {
    ...(casesDir !== undefined && { casesDir: resolve(casesDir) }),
    ...(manifest !== undefined && { manifest: resolve(manifest) }),
    out: resolve(out),
    ...(variant !== undefined && { variant }),
    replays: positiveInt("EVAL_REPLAYS", text("EVAL_REPLAYS"), defaults.replays),
    fromRun: positiveInt("EVAL_FROM_RUN", text("EVAL_FROM_RUN"), 1),
    workDir: resolve(text("EVAL_WORK_DIR") ?? defaults.workDir),
    force: text("EVAL_FORCE") === "true",
    ...(caseFilter !== undefined && { case: caseFilter }),
    ...(split !== undefined && { split: split as "tune" | "holdout" }),
    dryRun: text("EVAL_DRY_RUN") === "true",
  };
};
