#!/usr/bin/env node
// Runs one hidden check, a vitest file, inside an omni checkout, and turns the
// result into an exit code the deploy hook and the proof test both read:
//
//   0  every test in the check passed: the symptom is gone
//   1  the check ran and a SYMPTOM assertion failed: the fault is present
//   2  the check could not run, or failed for any other reason
//
// Keeping 1 and 2 apart is the point. A check that "fails at baseSha" because
// the file did not compile, or Postgres was unreachable, proves nothing about
// the fault, so the proof test demands exit 1 exactly, and every assertion
// that stands for the symptom carries the SYMPTOM: prefix in its message.
//
// Usage: vitest-check.mjs <omni checkout> <package dir> <check file>
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// Node exits 1 on an uncaught error, which would read as "the fault is
// present". Anything unexpected here is the check failing to run.
process.on("uncaughtException", (error) => {
  console.error(`vitest-check: ${error.stack ?? error}`);
  process.exit(2);
});

const [omniArg, pkgArg, checkArg] = process.argv.slice(2);
if (!omniArg || !pkgArg || !checkArg) {
  console.error("usage: vitest-check.mjs <omni checkout> <package dir> <check file>");
  process.exit(2);
}

const omni = realpathSync(resolve(omniArg));
const pkgDir = join(omni, pkgArg);
const check = resolve(checkArg);
if (!existsSync(join(pkgDir, "package.json"))) {
  console.error(`vitest-check: no package at ${pkgDir}`);
  process.exit(2);
}

// The file is placed under src/ because that is the one directory every
// package's vitest include covers, and its relative imports (./test-service)
// are written against it. It is removed afterwards so the check never lands
// in the checkout the agent or CI sees.
const relative = join("src", basename(check).replace(/\.vitest\.ts$/, ".test.ts"));
const placed = join(pkgDir, relative);
const report = join(tmpdir(), `bugboss-check-${process.pid}-${Date.now()}.json`);

copyFileSync(check, placed);
let run;
try {
  run = spawnSync(
    "npx",
    // Relative, because vitest matches its filter against real paths and a
    // temp directory reached through a symlink (macOS /var) never matches.
    ["vitest", "run", relative, "--reporter=json", `--outputFile=${report}`, "--reporter=default"],
    { cwd: pkgDir, stdio: "inherit", env: process.env },
  );
} finally {
  rmSync(placed, { force: true });
}

if (!existsSync(report)) {
  console.error(`vitest-check: vitest wrote no report (exit ${run?.status}, signal ${run?.signal})`);
  process.exit(2);
}

const result = JSON.parse(readFileSync(report, "utf8"));
rmSync(report, { force: true });

const assertions = result.testResults.flatMap((file) => file.assertionResults);
const suiteErrors = result.testResults.filter(
  (file) => file.status === "failed" && file.message,
);
const failed = assertions.filter((a) => a.status === "failed");
const passed = assertions.filter((a) => a.status === "passed");

if (suiteErrors.length > 0 && failed.length === 0) {
  for (const file of suiteErrors) console.error(`vitest-check: suite error: ${file.message}`);
  process.exit(2);
}
if (assertions.length === 0) {
  console.error("vitest-check: the check collected no tests");
  process.exit(2);
}
if (failed.length === 0 && passed.length === assertions.length) {
  console.log(`vitest-check: PASS (${passed.length} tests)`);
  process.exit(0);
}
if (failed.length === 0) {
  console.error("vitest-check: some tests were skipped, so the check is not conclusive");
  process.exit(2);
}

const symptomatic = failed.filter((a) =>
  a.failureMessages.some((m) => m.includes("SYMPTOM:")),
);
for (const a of failed) {
  const tag = symptomatic.includes(a) ? "symptom" : "other";
  console.error(`vitest-check: FAIL [${tag}] ${a.fullName}`);
}
if (symptomatic.length === failed.length && suiteErrors.length === 0) {
  process.exit(1);
}
process.exit(2);
