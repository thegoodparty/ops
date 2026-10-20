import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commitSyntheticHead,
  scoreDir,
  readBundleFile,
  readManifest,
  renderExpectReport,
  scoreRun,
} from "./expect";
import type { Expect } from "./expect";
import type { ExpectedCase } from "./expect";
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

// The two plan cases are simulated PRs in the same corpus, and each carries the
// plan the model is judged against inside its bundle: nothing fetches it, so a
// case replays with no GitHub access.
test("the corpus has one consistent and one inconsistent plan case, both with a plan", () => {
  const cases = readManifest(MANIFEST).filter((c) => c.expect.verdict === "consistency");
  const wanted = cases.map((c) =>
    c.expect.verdict === "consistency" ? c.expect.consistency : null,
  );
  assert.deepEqual([...wanted].sort(), ["consistent", "inconsistent"]);
  for (const c of cases) {
    assert.ok(c.bundle, `${c.id} must be a simulated bundle`);
    const bundle = readBundleFile(MANIFEST, c.bundle!);
    const inDiff = [...bundle.diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
    assert.deepEqual([...bundle.changedFiles].sort(), inDiff.sort(), c.id);
    assert.ok(bundle.plan, `${c.id} must carry the plan in its bundle`);
    assert.match(bundle.plan!.path, /^docs\/.+\.md$/, c.id);
    assert.ok(bundle.plan!.text.length > 0, c.id);
    assert.match(bundle.plan!.blobSha, /^[0-9a-f]{40}$/, c.id);
    assert.match(bundle.body, /^Plan: docs\//m, `${c.id} must name its plan in the body`);
  }
});

test("the manifest rejects an unknown answer or verdict, and a consistency case without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "expect-manifest-"));
  const write = (name: string, body: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };
  const c = readManifest(MANIFEST).find((x) => x.expect.verdict === "consistency")!;
  assert.throws(
    () =>
      readManifest(
        write("bad.json", [{ ...c, expect: { verdict: "consistency", consistency: "probably" } }]),
      ),
    "consistency must be one of the three answers",
  );
  assert.throws(
    () => readManifest(write("missing.json", [{ ...c, expect: { verdict: "consistency" } }])),
    "a consistency expectation needs the answer it asserts",
  );
  assert.throws(
    () => readManifest(write("unknown.json", [{ ...c, expect: { verdict: "flag" } }])),
    "flag is not an expectation type until step 5",
  );
});

const withConsistency = (
  verdict?: "consistent" | "inconsistent" | "unclear",
  findings: Finding[] = [],
) =>
  result({
    output: {
      status: "complete",
      findings,
      summary: "s",
      ...(verdict ? { planConsistency: { verdict, reasoning: "r" } } : {}),
    },
  });

const consistency = (answer: "consistent" | "inconsistent" | "unclear"): Expect => ({
  verdict: "consistency",
  consistency: answer,
});

test("a consistency expectation scores the model's answer alone", () => {
  assert.equal(scoreRun(consistency("inconsistent"), withConsistency("inconsistent")).pass, true);
  assert.equal(scoreRun(consistency("inconsistent"), withConsistency("consistent")).pass, false);
  assert.match(
    scoreRun(consistency("inconsistent"), withConsistency("consistent")).outcome,
    /planConsistency: consistent \(expected inconsistent\)/,
  );
  assert.equal(scoreRun(consistency("consistent"), withConsistency()).pass, false);
  assert.match(scoreRun(consistency("consistent"), withConsistency()).outcome, /absent/);
  assert.equal(scoreRun(consistency("unclear"), withConsistency("unclear")).pass, true);
});

test("findings do not enter a consistency score, and no review still fails", () => {
  assert.equal(
    scoreRun(consistency("consistent"), withConsistency("consistent", [finding("a.ts")])).pass,
    true,
  );
  assert.equal(
    scoreRun(consistency("consistent"), result({ output: null, error: "agent returned no JSON" }))
      .pass,
    false,
  );
});

// The diagnostic is what the consistency expectation becomes once the gate can
// score an outcome (step 5): the outcome decides the case, and the answer says
// whether a wrong outcome came from the model or from the gate.
test("a diagnostic on an outcome case has to be right as well", () => {
  const approveWithAnswer: Expect = { verdict: "approve", consistency: "consistent" };
  assert.equal(scoreRun(approveWithAnswer, withConsistency("consistent")).pass, true);
  assert.equal(scoreRun(approveWithAnswer, withConsistency("inconsistent")).pass, false);
  assert.match(
    scoreRun(approveWithAnswer, withConsistency("inconsistent")).outcome,
    /approved; planConsistency: inconsistent \(expected consistent\)/,
  );
  assert.equal(scoreRun(approveWithAnswer, withConsistency()).pass, false);

  const blockWithAnswer: Expect = {
    verdict: "block",
    paths: ["b.ts"],
    consistency: "inconsistent",
  };
  assert.equal(scoreRun(blockWithAnswer, withConsistency("inconsistent", [finding("b.ts")])).pass, true);
  assert.equal(scoreRun(blockWithAnswer, withConsistency("consistent", [finding("b.ts")])).pass, false);
  // A matching answer never rescues a wrong outcome.
  assert.equal(scoreRun(blockWithAnswer, withConsistency("inconsistent", [finding("c.ts")])).pass, false);
});

test("the report names a consistency expectation and an outcome diagnostic", () => {
  const cases = readManifest(MANIFEST);
  const planCases = cases.filter((c) => c.expect.verdict === "consistency");
  const diagnosed: ExpectedCase = {
    ...cases[0],
    id: "diagnosed",
    expect: { verdict: "approve", consistency: "consistent" },
  };
  const report = renderExpectReport(
    [...planCases, diagnosed].map((c) => ({ c, scores: [], costs: [] })),
    "v",
  );
  assert.match(report, /planConsistency: consistent/);
  assert.match(report, /planConsistency: inconsistent/);
  assert.match(report, /approve \(diagnostic: planConsistency: consistent\)/);
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

test("scoreDir fails a case the replay left no results for", () => {
  const [approveCase] = readManifest(MANIFEST).filter((c) => c.expect.verdict === "approve");
  const out = mkdtempSync(join(tmpdir(), "expect-out-"));
  const report = renderExpectReport(scoreDir([approveCase], out), "v");
  assert.match(report, /\*\*0\/1 cases passed\*\*/);
  assert.match(report, /FAIL, no results/);

  mkdirSync(join(out, approveCase.id));
  writeFileSync(join(out, approveCase.id, "run-1.json"), JSON.stringify(result()));
  assert.match(renderExpectReport(scoreDir([approveCase], out), "v"), /\*\*1\/1 cases passed\*\*/);
});
