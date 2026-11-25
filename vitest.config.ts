// Loaded as CommonJS, because this package is CommonJS: an `export default`
// here makes Vite's native config loader warn on every run.
const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    // Only the eval suites. The repository's own tests are `node --test` files
    // next to the code, and `npm test` globs them non-recursively, so neither
    // runner picks up the other's work.
    include: ["delegate/review/eval/suites/**/*.test.ts"],
    // One test is one full agent replay: a clone, a checkout, a review of a
    // real diff. Vitest's 5s default would kill every one of them, and a
    // per-replay limit would be a new failure mode: the CLI loops had none,
    // so the job's own timeout is still the only ceiling on a single replay.
    testTimeout: 6 * 60 * 60_000,
    // Never vitest's github-actions reporter. It writes test names to
    // $GITHUB_STEP_SUMMARY, which a gate-mode step's `> log 2>&1` redirect
    // does not cover, and a test is named after its holdout case.
    reporters: ["default"],
  },
});
