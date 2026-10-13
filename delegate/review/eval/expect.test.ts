import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commitSyntheticHead,
  readBundleFile,
  readManifest,
  renderExpectReport,
  scoreRun,
} from "./expect";
import type { Expect } from "./expect";
import type { Result } from "./replay";
import type { Bundle, Finding } from "../schema";

const MANIFEST = join(__dirname, "expected", "manifest.json");

const result = (overrides: Partial<Result> = {}): Result => ({
  caseId: "c",
  repo: "thegoodparty/omni",
  prNumber: 1,
  headSha: "h",
  variant: "v",
  output: { status: "complete", findings: [], summary: "s" },
  costUsd: 1,
  wallTimeMs: 1,
  ...overrides,
});

const finding = (path: string, category: Finding["category"] = "bugs"): Finding => ({
  path,
  line: 10,
  body: "b",
  category,
  confidence: "high",
});

const withFindings = (findings: Finding[]) =>
  result({ output: { status: "complete", findings, summary: "s" } });

const block: Expect = { verdict: "block", paths: ["a.ts", "b.ts"] };

test("the manifest parses and every simulated bundle matches its diff", () => {
  const cases = readManifest(MANIFEST);
  assert.ok(cases.some((c) => c.expect.verdict === "approve"), "needs an approve case");
  for (const c of cases.filter((x) => x.bundle)) {
    const bundle = readBundleFile(MANIFEST, c.bundle!);
    const inDiff = [...bundle.diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
    assert.deepEqual([...bundle.changedFiles].sort(), inDiff.sort(), c.id);
  }
});

test("approve passes only with zero findings", () => {
  assert.equal(scoreRun({ verdict: "approve" }, result()).pass, true);
  assert.equal(scoreRun({ verdict: "approve" }, withFindings([finding("a.ts")])).pass, false);
});

test("block passes only on a finding in an expected file", () => {
  assert.equal(scoreRun(block, withFindings([finding("b.ts")])).pass, true);
  assert.equal(scoreRun(block, withFindings([finding("c.ts")])).pass, false);
  assert.equal(scoreRun(block, result()).pass, false);
});

test("block with categories ignores findings of another category", () => {
  const security: Expect = { ...block, categories: ["security"] };
  assert.equal(scoreRun(security, withFindings([finding("a.ts", "tests")])).pass, false);
  assert.equal(scoreRun(security, withFindings([finding("a.ts", "security")])).pass, true);
});

test("a run that produced no review fails either way", () => {
  const failed = result({ output: null, error: "agent returned no JSON" });
  assert.equal(scoreRun({ verdict: "approve" }, failed).pass, false);
  assert.equal(scoreRun(block, failed).pass, false);
  assert.match(scoreRun(block, failed).outcome, /no JSON/);
});

test("the simulated head commit has the same sha in every clone", () => {
  const origin = mkdtempSync(join(tmpdir(), "expect-origin-"));
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  git(origin, ["init", "-q", "-b", "main"]);
  writeFileSync(join(origin, "a.ts"), "export const a = 1\n");
  git(origin, ["add", "."]);
  git(origin, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  const baseSha = git(origin, ["rev-parse", "HEAD"]);
  writeFileSync(join(origin, "a.ts"), "export const a = 2\n");
  const diff = execFileSync("git", ["diff"], { cwd: origin }).toString();

  const bundle: Bundle = {
    repo: "local/origin",
    prNumber: 1,
    baseRef: "main",
    baseSha,
    headSha: "0000000000000000000000000000000000000000",
    author: "t",
    title: "Change a",
    body: "",
    diff,
    changedFiles: ["a.ts"],
    priorFindings: [],
  };
  const cloneAt = () => {
    const dir = mkdtempSync(join(tmpdir(), "expect-clone-"));
    git(dir, ["clone", "-q", origin, "."]);
    git(dir, ["checkout", "-q", baseSha]);
    return dir;
  };

  let actual = "";
  assert.throws(
    () => commitSyntheticHead(bundle, cloneAt()),
    (err: Error) => {
      actual = err.message.match(/head is ([0-9a-f]{40})/)?.[1] ?? "";
      return actual.length === 40;
    },
  );
  commitSyntheticHead({ ...bundle, headSha: actual }, cloneAt());
});

test("the report counts a case as passed only when every run passed", () => {
  const cases = readManifest(MANIFEST).slice(0, 2);
  const report = renderExpectReport(
    [
      { c: cases[0], scores: [{ pass: true, outcome: "x" }, { pass: true, outcome: "x" }], costs: [1, 2] },
      { c: cases[1], scores: [{ pass: true, outcome: "x" }, { pass: false, outcome: "approved" }], costs: [1, null] },
    ],
    "abc1234",
  );
  assert.match(report, /\*\*1\/2 cases passed\*\*/);
  assert.match(report, /\| 2\/2 \| \$1\.50 \|/);
  assert.match(report, /run 2: FAIL, approved/);
});
