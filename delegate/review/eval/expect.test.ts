import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  baselineGaps,
  commitSyntheticHead,
  computeGate,
  mainRunsShort,
  ManifestSchema,
  ParkedSchema,
  scoreDir,
  scoreHistory,
  readBundleFile,
  readManifest,
  renderExpectJson,
  renderExpectReport,
  scoreRun,
  selectCases,
} from "./expect";
import type { Expect, RunScore } from "./expect";
import type { ExpectedCase } from "./expect";
import type { Result } from "./replay";
import type { Bundle, Finding } from "../schema";
import type { BlockJudge, BlockJudgment } from "./block-judge";

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

const block: Expect = { verdict: "block", reason: "the cache key drops the org id" };

const matched: BlockJudgment = { match: true, finding: 1, why: "finding 1 says the key drops the org id" };
const unmatched: BlockJudgment = { match: false, why: "the findings are about logging, not the key" };

test("the manifest parses and every simulated bundle matches its diff", () => {
  const cases = readManifest(MANIFEST);
  assert.ok(cases.some((c) => c.expect.verdict === "approve"), "needs an approve case");
  for (const c of cases) {
    const bundle = readBundleFile(MANIFEST, c.bundle);
    const inDiff = [...bundle.diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
    assert.deepEqual([...bundle.changedFiles].sort(), inDiff.sort(), c.id);
  }
});

// The plan cases are simulated PRs in the same corpus, and each carries the
// plan the model is judged against inside its bundle: nothing fetches it, so a
// case replays with no GitHub access. Step 5 scores their outcomes and keeps
// the consistency answer as a diagnostic.
test("the plan cases assert an outcome and keep consistency as a diagnostic", () => {
  const cases = readManifest(MANIFEST).filter((c) => c.id.startsWith("ops-plan-"));
  const byId = new Map(cases.map((c) => [c.id, c]));
  assert.deepEqual(byId.get("ops-plan-consistent-change")?.expect, {
    verdict: "approve",
    consistency: "consistent",
  });
  assert.deepEqual(byId.get("ops-plan-inconsistent-change")?.expect, {
    verdict: "flag",
    reason: "inconsistent",
    consistency: "inconsistent",
  });
  // The three cases added with case 5's vocabulary: an addition the step does
  // not name is still consistent (that case blocks on a real defect in its
  // handler), an amendment the harness flags is still a consistent diagnostic,
  // and a widening is a flag on the model's answer.
  const unnamed = byId.get("ops-plan-addition-unnamed")?.expect;
  assert.equal(unnamed?.verdict, "block");
  assert.match(unnamed?.verdict === "block" ? unnamed.reason : "", /vk-mint-handler\.ts/);
  assert.equal(unnamed?.consistency, "consistent");
  assert.deepEqual(byId.get("ops-plan-amends-itself")?.expect, {
    verdict: "flag",
    reason: "touches_docs",
    consistency: "consistent",
  });
  assert.deepEqual(byId.get("ops-plan-widens-access")?.expect, {
    verdict: "flag",
    reason: "inconsistent",
    consistency: "inconsistent",
  });
  // Each one names the PR its shape came from, so a case cannot drift into an
  // anecdote with no provenance.
  for (const id of ["ops-plan-addition-unnamed", "ops-plan-amends-itself", "ops-plan-widens-access"]) {
    assert.match(byId.get(id)!.tests, /#41[14]/, `${id} must name the PR it came from`);
  }
  for (const c of cases) {
    const bundle = readBundleFile(MANIFEST, c.bundle);
    const inDiff = [...bundle.diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
    assert.deepEqual([...bundle.changedFiles].sort(), inDiff.sort(), c.id);
    assert.ok(bundle.plan, `${c.id} must carry the plan in its bundle`);
    assert.match(bundle.plan!.path, /^docs\/.+\.md$/, c.id);
    assert.ok(bundle.plan!.text.length > 0, c.id);
    assert.match(bundle.plan!.blobSha, /^[0-9a-f]{40}$/, c.id);
    assert.match(bundle.body, /^Plan: docs\//m, `${c.id} must name its plan in the body`);
  }
});

test("the manifest rejects an unknown answer, verdict or gate name, and an incomplete expectation", () => {
  const dir = mkdtempSync(join(tmpdir(), "expect-manifest-"));
  const write = (name: string, body: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };
  const c = readManifest(MANIFEST).find((x) => x.id === "ops-plan-inconsistent-change")!;
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
    () => readManifest(write("noreason.json", [{ ...c, expect: { verdict: "flag" } }])),
    "a flag expectation needs the gate it names",
  );
  assert.throws(
    () =>
      readManifest(
        write("unknown.json", [{ ...c, expect: { verdict: "flag", reason: "looks_bad" } }]),
      ),
    "a flag must name a gate that exists",
  );
  const ok = readManifest(
    write("ok.json", [{ ...c, expect: { verdict: "flag", reason: "inconsistent" } }]),
  );
  assert.equal(ok[0].expect.verdict, "flag");
});

test("a manifest entry missing split, source or kind, or with a bad value, is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "expect-labels-"));
  const parse = (entry: unknown) => {
    const path = join(dir, "m.json");
    writeFileSync(path, JSON.stringify([entry]));
    return readManifest(path);
  };
  const full = readManifest(MANIFEST)[0];
  assert.equal(parse(full)[0].id, full.id);
  for (const field of ["split", "source", "kind"] as const) {
    const { [field]: _dropped, ...without } = full;
    assert.throws(() => parse(without), new RegExp(field));
    assert.throws(() => parse({ ...full, [field]: "bogus" }), new RegExp(field));
  }
});

test("the checked-in manifest holds out a minority, with block and approve on both sides", () => {
  const cases = readManifest(MANIFEST);
  assert.equal(cases.length, 43);
  const holdout = selectCases(cases, { split: "holdout" });
  // The three vocabulary cases are tune: the prompt's worked examples are their
  // shapes, so none of them can honestly claim holdout independence.
  assert.equal(holdout.length, 18);
  for (const split of ["tune", "holdout"]) {
    const verdicts = new Set(selectCases(cases, { split }).map((c) => c.expect.verdict));
    assert.ok(verdicts.has("block") && verdicts.has("approve"), `${split} needs block and approve`);
  }
  assert.ok(selectCases(cases, { split: "holdout" }).some((c) => c.expect.verdict === "flag"));
});

test("selectCases filters by split and case, and returns everything with no filter", () => {
  const cases = readManifest(MANIFEST);
  assert.equal(selectCases(cases, {}).length, cases.length);
  const tune = selectCases(cases, { split: "tune" });
  const holdout = selectCases(cases, { split: "holdout" });
  assert.equal(tune.length + holdout.length, cases.length);
  assert.ok(holdout.every((c) => c.split === "holdout"));
  const one = holdout[0];
  assert.deepEqual(selectCases(cases, { case: one.id, split: "holdout" }), [one]);
  assert.deepEqual(selectCases(cases, { case: one.id, split: "tune" }), []);
  assert.throws(() => selectCases(cases, { split: "dev" }));
});

test("scoreDir with a holdout filter scores only holdout cases", async () => {
  const out = mkdtempSync(join(tmpdir(), "expect-split-"));
  const holdout = selectCases(readManifest(MANIFEST), { split: "holdout" });
  const reports = await scoreDir(holdout, out);
  assert.deepEqual(reports.map((r) => r.c.id), holdout.map((c) => c.id));
});

// Every answer carries the justification its verdict requires; a verdict
// without one is a schema failure, so a test helper that omitted it would be
// building an output the parser can never produce.
const justified = (verdict: "consistent" | "inconsistent" | "unclear", reasoning = "r") =>
  verdict === "consistent"
    ? { verdict, reasoning }
    : verdict === "inconsistent"
      ? { verdict, reasoning, departure: { plan: "the step's words", diff: "does something else" } }
      : { verdict, reasoning, uncertainty: { unknown: "what is missing", settle: "the file that would show it" } };

const withConsistency = (
  verdict?: "consistent" | "inconsistent" | "unclear",
  findings: Finding[] = [],
) =>
  result({
    output: {
      status: "complete",
      findings,
      summary: "s",
      ...(verdict ? { planConsistency: justified(verdict) } : {}),
    },
  });

// A replayed gated case: the gate's event and the reason it commented. `repo`
// defaults to a gated one, because that is where a verdict exists at all.
const withGating = (
  answer: "consistent" | "inconsistent" | "unclear",
  gating: { verdict: "approve" | "comment"; gates?: string[] },
  repo = "thegoodparty/ops",
) =>
  result({
    repo,
    output: {
      status: "complete",
      findings: [],
      summary: "s",
      planConsistency: justified(answer),
    },
    gating: {
      mode: "enforce",
      verdict: gating.verdict,
      gates: gating.gates ?? [],
      wouldApprove: gating.verdict === "approve",
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
    reason: "r",
    consistency: "inconsistent",
  };
  assert.equal(scoreRun(blockWithAnswer, withConsistency("inconsistent", [finding("b.ts")]), matched).pass, true);
  assert.equal(scoreRun(blockWithAnswer, withConsistency("consistent", [finding("b.ts")]), matched).pass, false);
  // A matching answer never rescues a wrong outcome.
  assert.equal(scoreRun(blockWithAnswer, withConsistency("inconsistent", [finding("c.ts")]), unmatched).pass, false);
});

test("the report names a consistency expectation, a flag and an outcome diagnostic", () => {
  const cases = readManifest(MANIFEST);
  const base = cases[0];
  const report = renderExpectReport(
    [
      {
        c: { ...base, id: "consistency", expect: { verdict: "consistency", consistency: "inconsistent" } },
        scores: [],
        costs: [],
      },
      {
        c: { ...base, id: "flagged", expect: { verdict: "flag", reason: "no_binding" } },
        scores: [],
        costs: [],
      },
      {
        c: { ...base, id: "diagnosed", expect: { verdict: "approve", consistency: "consistent" } },
        scores: [],
        costs: [],
      },
    ],
    "v",
  );
  assert.match(report, /planConsistency: inconsistent/);
  assert.match(report, /flag `no_binding`/);
  assert.match(report, /approve \(diagnostic: planConsistency: consistent\)/);
});

test("a flag passes only when the review commented and that named gate fired", () => {
  const flag: Expect = { verdict: "flag", reason: "inconsistent" };
  const passed = scoreRun(flag, withGating("inconsistent", { verdict: "comment", gates: ["inconsistent"] }));
  assert.equal(passed.pass, true);
  assert.match(passed.outcome, /flagged: inconsistent/);

  // A comment is not enough: the named gate has to be the one that fired.
  const other = scoreRun(flag, withGating("unclear", { verdict: "comment", gates: ["unclear_consistency"] }));
  assert.equal(other.pass, false);
  assert.match(other.outcome, /commented: unclear_consistency \(expected inconsistent\)/);

  // Nor is an approval, which is the other thing the agent's output alone
  // cannot distinguish from a clean comment.
  assert.equal(scoreRun(flag, withGating("consistent", { verdict: "approve" })).pass, false);
  assert.equal(scoreRun(flag, result()).pass, false);
  assert.match(scoreRun(flag, result()).outcome, /no gating verdict/);
});

test("approve reads the gating verdict, not just the absence of findings", () => {
  const approve: Expect = { verdict: "approve" };
  assert.equal(scoreRun(approve, withGating("consistent", { verdict: "approve" })).pass, true);

  const commented = withGating("inconsistent", { verdict: "comment", gates: ["inconsistent"] });
  assert.equal(scoreRun(approve, commented).pass, false);
  assert.match(scoreRun(approve, commented).outcome, /commented: inconsistent/);

  // A gated repo's case with no recorded gate verdict fails closed rather
  // than assuming a clean review.
  assert.equal(scoreRun(approve, result({ repo: "thegoodparty/ops" })).pass, false);
  // A repo that has not adopted gating keeps the findings-only outcome.
  assert.equal(scoreRun(approve, result()).pass, true);
});

test("a flag's diagnostic must be right too", () => {
  const flag: Expect = { verdict: "flag", reason: "inconsistent", consistency: "inconsistent" };
  assert.equal(
    scoreRun(flag, withGating("inconsistent", { verdict: "comment", gates: ["inconsistent"] })).pass,
    true,
  );

  // The gate fired on the right reason but the model's answer says otherwise:
  // the diagnostic attributes that to the model rather than to the gate.
  const wrongModel = withGating("consistent", { verdict: "comment", gates: ["inconsistent"] });
  const resultWrong = scoreRun(flag, wrongModel);
  assert.equal(resultWrong.pass, false);
  assert.match(resultWrong.outcome, /planConsistency: consistent \(expected inconsistent\)/);
});

test("approve passes only with zero findings", () => {
  assert.equal(scoreRun({ verdict: "approve" }, result()).pass, true);
  assert.equal(scoreRun({ verdict: "approve" }, withFindings([finding("a.ts")])).pass, false);
});

test("block passes only when the judge finds the reason among the findings", () => {
  const hit = scoreRun(block, withFindings([finding("c.ts")]), matched);
  assert.deepEqual(hit, { pass: true, outcome: "blocked for the reason: finding 1 says the key drops the org id" });
  const miss = scoreRun(block, withFindings([finding("a.ts", "architecture")]), unmatched);
  assert.equal(miss.pass, false);
  assert.match(miss.outcome, /^blocked on something else: the findings are about logging, not the key \(a\.ts:10 \[architecture\]\)$/);
  assert.deepEqual(scoreRun(block, result(), matched), { pass: false, outcome: "approved" });
});

test("a block that was not judged does not pass", () => {
  const r = scoreRun(block, withFindings([finding("a.ts")]));
  assert.equal(r.pass, false);
  assert.match(r.outcome, /reason not judged/);
});

test("a block whose gate approved is an approval, whatever the findings", () => {
  const approved = result({
    repo: "thegoodparty/ops",
    output: { status: "complete", findings: [finding("a.ts")], summary: "s" },
    gating: { mode: "enforce", verdict: "approve", gates: [], wouldApprove: true },
  });
  assert.deepEqual(scoreRun(block, approved, matched), { pass: false, outcome: "approved" });
});

test("a block expectation needs a reason, and paths, categories and reviewedAt are refused", () => {
  const entry = { id: "c", bundle: "c.bundle.json", expect: { verdict: "block", reason: "r" }, tests: "t", split: "tune", source: "simulated", kind: "bug" };
  assert.equal(ManifestSchema.parse([entry])[0].expect.verdict, "block");
  assert.throws(() => ManifestSchema.parse([{ ...entry, expect: { verdict: "block" } }]), /reason/);
  assert.throws(() => ManifestSchema.parse([{ ...entry, expect: { verdict: "block", reason: " " } }]), /reason/);
  assert.throws(() => ManifestSchema.parse([{ ...entry, expect: { verdict: "block", reason: "r", paths: ["a.ts"] } }]), /paths/);
  assert.throws(() => ManifestSchema.parse([{ ...entry, expect: { verdict: "block", reason: "r", categories: ["bugs"] } }]), /categories/);
  assert.throws(() => ManifestSchema.parse([{ ...entry, reviewedAt: "2026-11-13T00:00:00Z" }]), /reviewedAt/);
});

test("every block case in the manifest and in parked names its reason", () => {
  const parked = ParkedSchema.parse(JSON.parse(readFileSync(join(dirname(MANIFEST), "parked.json"), "utf-8")));
  for (const c of [...readManifest(MANIFEST), ...parked.map((p) => p.case)]) {
    if (c.expect.verdict === "block") assert.ok(c.expect.reason.length > 40, c.id);
  }
});

const stubJudge = (answers: BlockJudgment[]) => {
  const calls: { reason: string; findings: Finding[] }[] = [];
  const judge: BlockJudge = async (reason, findings) => {
    calls.push({ reason, findings });
    return answers[calls.length - 1] ?? matched;
  };
  return { calls, judge };
};

const blockCaseIn = (out: string, runs: Result[]): ExpectedCase => {
  const c = { ...readManifest(MANIFEST).find((x) => x.expect.verdict === "block")!, id: "block-case" };
  mkdirSync(join(out, c.id), { recursive: true });
  runs.forEach((r, i) => writeFileSync(join(out, c.id, `run-${i + 1}.json`), JSON.stringify(r)));
  return c;
};

test("scoreDir judges each blocked run once and caches the judgment next to it", async () => {
  const out = mkdtempSync(join(tmpdir(), "expect-judge-"));
  const c = blockCaseIn(out, [withFindings([finding("a.ts")]), withFindings([finding("b.ts")]), result()]);
  const first = stubJudge([matched, unmatched]);
  const [r] = await scoreDir([c], out, first.judge);
  assert.equal(first.calls.length, 2, "an approved run is not judged");
  assert.ok(first.calls.every((x) => x.reason === (c.expect as { reason: string }).reason));
  assert.deepEqual(r.scores.map((s) => s.pass), [true, false, false]);
  assert.match(r.scores[0].outcome, /^blocked for the reason: /);
  assert.match(r.scores[1].outcome, /^blocked on something else: /);
  const cached = JSON.parse(readFileSync(join(out, c.id, "run-1.judge.json"), "utf-8"));
  assert.equal(cached.match, true);
  assert.match(cached.key, /^[0-9a-f]{64}$/);

  const again = stubJudge([]);
  const [r2] = await scoreDir([c], out, again.judge);
  assert.equal(again.calls.length, 0, "a rerun reads the cached judgments");
  assert.deepEqual(r2.scores, r.scores);
});

test("a cached judgment is not reused once the reason or the findings change", async () => {
  const out = mkdtempSync(join(tmpdir(), "expect-judge-"));
  const c = blockCaseIn(out, [withFindings([finding("a.ts")])]);
  await scoreDir([c], out, stubJudge([matched]).judge);

  const reworded = stubJudge([unmatched]);
  const [r] = await scoreDir([{ ...c, expect: { verdict: "block", reason: "something else entirely" } }], out, reworded.judge);
  assert.equal(reworded.calls.length, 1);
  assert.equal(r.scores[0].pass, false);

  writeFileSync(join(out, c.id, "run-1.json"), JSON.stringify(withFindings([finding("a.ts"), finding("z.ts")])));
  const refound = stubJudge([matched]);
  await scoreDir([c], out, refound.judge);
  assert.equal(refound.calls.length, 1);
  assert.equal(refound.calls[0].findings.length, 2);
});

test("scoreDir never asks the judge about approve or flag cases", async () => {
  const out = mkdtempSync(join(tmpdir(), "expect-judge-"));
  const approveCase = readManifest(MANIFEST).find((c) => c.expect.verdict === "approve")!;
  mkdirSync(join(out, approveCase.id));
  writeFileSync(join(out, approveCase.id, "run-1.json"), JSON.stringify(withFindings([finding("a.ts")])));
  const flagCase = readManifest(MANIFEST).find((c) => c.expect.verdict === "flag")!;
  mkdirSync(join(out, flagCase.id));
  writeFileSync(
    join(out, flagCase.id, "run-1.json"),
    JSON.stringify(withGating("inconsistent", { verdict: "comment", gates: [(flagCase.expect as { reason: string }).reason] })),
  );
  const { calls, judge } = stubJudge([]);
  const reports = await scoreDir([approveCase, flagCase], out, judge);
  assert.equal(calls.length, 0);
  assert.equal(reports[0].scores[0].pass, false);
  assert.match(reports[1].scores[0].outcome, /^flagged: /);
});

const blockNotOn: Expect = { ...block, noFindingIn: ["refuted.ts"] };

test("a block case with noFindingIn fails on a finding in a refuted path, even when the reason is caught", () => {
  const scored = scoreRun(blockNotOn, withFindings([finding("other.ts"), finding("refuted.ts")]), matched);
  assert.equal(scored.pass, false);
  assert.match(scored.outcome, /^blocked on the refuted path: refuted\.ts:10/);
});

test("a block case with noFindingIn passes on the reason caught elsewhere, and still fails an approval", () => {
  assert.equal(scoreRun(blockNotOn, withFindings([finding("other.ts")]), matched).pass, true);
  assert.deepEqual(scoreRun(blockNotOn, result(), matched), { pass: false, outcome: "approved" });
});

test("the manifest rejects an empty noFindingIn", () => {
  const c = readManifest(MANIFEST)[0];
  assert.throws(() => ManifestSchema.parse([{ ...c, expect: { verdict: "block", reason: "r", noFindingIn: [] } }]));
});

test("the two refuted omni cases block on the PR's real defect and pin the file production's false finding was on", () => {
  const byId = new Map(readManifest(MANIFEST).map((c) => [c.id, c]));
  const e2702 = byId.get("omni-2702-multi-office-skip")?.expect;
  const e2679 = byId.get("omni-2679-starlette-sync-background")?.expect;
  assert.equal(e2702?.verdict, "block");
  assert.deepEqual(e2702?.verdict === "block" && e2702.noFindingIn, ["packages/gp-api/src/priorities/services/priorityOnboarding.service.ts"]);
  assert.equal(e2679?.verdict, "block");
  assert.deepEqual(e2679?.verdict === "block" && e2679.noFindingIn, ["packages/gp-ai/broker/page_replay.py"]);
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

test("scoreDir fails a case the replay left no results for", async () => {
  const [approveCase] = readManifest(MANIFEST).filter((c) => c.expect.verdict === "approve");
  const out = mkdtempSync(join(tmpdir(), "expect-out-"));
  const report = renderExpectReport(await scoreDir([approveCase], out), "v");
  assert.match(report, /\*\*0\/1 cases passed\*\*/);
  assert.match(report, /FAIL, no results/);

  mkdirSync(join(out, approveCase.id));
  writeFileSync(join(out, approveCase.id, "run-1.json"), JSON.stringify(result()));
  assert.match(renderExpectReport(await scoreDir([approveCase], out), "v"), /\*\*1\/1 cases passed\*\*/);
});

test("the report carries main's pass count per case, and the json does too", () => {
  const cases = readManifest(MANIFEST).slice(0, 2);
  const pass = { pass: true, outcome: "x" };
  const fail = { pass: false, outcome: "approved" };
  const pr = [
    { c: cases[0], scores: [pass, pass, pass], costs: [1, 1, 1] },
    { c: cases[1], scores: [pass, pass, pass], costs: [1, 1, 1] },
  ];
  const main = {
    variant: "main-def5678",
    runs: 3,
    reports: [
      { c: cases[0], scores: [pass, fail, pass], costs: [1, 1, 1] },
      { c: cases[1], scores: [], costs: [] },
    ],
  };

  const md = renderExpectReport(pr, "pr-abc1234", main);
  assert.match(md, /Main runs passed \(`main-def5678`\)/);
  assert.match(md, new RegExp(`${cases[0].id} \\|[^\\n]*\\| 3/3 \\| 2/3 \\|`));

  const json = JSON.parse(renderExpectJson(pr, "pr-abc1234", main));
  assert.equal(json.baselineVariant, "main-def5678");
  assert.deepEqual(json.cases[0], {
    id: cases[0].id,
    runs: 3,
    runsPassed: 3,
    main: { runs: 3, completed: 3, runsPassed: 2, unfinished: 0 },
  });
});

test("errored and missing main runs are unfinished, never a pass or a fail", () => {
  const cases = readManifest(MANIFEST).slice(0, 3);
  const pass = { pass: true, outcome: "x" };
  const fail = { pass: false, outcome: "approved" };
  const noReview = { pass: false, outcome: "no review: boom", errored: true };
  const pr = cases.map((c) => ({ c, scores: [pass, pass, pass], costs: [1, 1, 1] }));
  const main = {
    variant: "main-def5678",
    runs: 3,
    reports: [
      { c: cases[0], scores: [pass, noReview, fail], costs: [1, null, 1] },
      { c: cases[1], scores: [pass, pass], costs: [1, 1] },
      { c: cases[2], scores: [noReview, noReview, noReview], costs: [null, null, null] },
    ],
  };

  const json = JSON.parse(renderExpectJson(pr, "v", main));
  assert.deepEqual(json.cases[0].main, { runs: 3, completed: 2, runsPassed: 1, unfinished: 1 });
  assert.deepEqual(json.cases[1].main, { runs: 3, completed: 2, runsPassed: 2, unfinished: 1 });
  assert.deepEqual(json.cases[2].main, { runs: 3, completed: 0, runsPassed: 0, unfinished: 3 });

  const md = renderExpectReport(pr, "v", main);
  assert.match(md, /\| 1\/2 \(1 of 3 runs unfinished\) \|/);
  assert.match(md, /\| 2\/2 \(1 of 3 runs unfinished\) \|/);
  assert.match(md, /\| n\/a \(3 of 3 runs unfinished\) \|/);
});

test("a result with no review scores as errored", () => {
  assert.equal(scoreRun({ verdict: "approve" }, result({ output: null, error: "boom" })).errored, true);
  assert.equal(scoreRun({ verdict: "approve" }, result()).errored, undefined);
});

test("without a baseline the report keeps its original columns", () => {
  const cases = readManifest(MANIFEST).slice(0, 1);
  const pr = [{ c: cases[0], scores: [{ pass: true, outcome: "x" }], costs: [1] }];
  assert.doesNotMatch(renderExpectReport(pr, "v"), /Main runs passed/);
  assert.equal(JSON.parse(renderExpectJson(pr, "v")).cases[0].main, null);
});

const P = { pass: true, outcome: "x" };
const F = { pass: false, outcome: "approved" };
const runsOf = (...passes: boolean[]) => passes.map((p) => (p ? P : F));
const gateCases = () => {
  const all = readManifest(MANIFEST);
  return { tune: all.find((c) => c.split === "tune")!, holdout: all.find((c) => c.split === "holdout")! };
};
const mkReport = (c: ExpectedCase, scores: RunScore[], cost = 1) => ({
  c,
  scores,
  costs: scores.map(() => cost),
});
const mkBase = (reports: ReturnType<typeof mkReport>[]) => ({ variant: "main-abc", runs: 3, reports });

test("gate: main 3/3 and candidate 3/3 passes", () => {
  const { tune } = gateCases();
  const g = computeGate([mkReport(tune, runsOf(true, true, true))], mkBase([mkReport(tune, runsOf(true, true, true))]), [], false);
  assert.equal(g.pass, true);
  assert.deepEqual([g.regressions, g.rerun, g.targetsMissed], [[], [], []]);
});

test("gate: a drop to 2/3 asks for a rerun, then 5 of 6 passes and 4 of 6 is a regression", () => {
  const { tune } = gateCases();
  const base = mkBase([mkReport(tune, runsOf(true, true, true))]);
  const first = computeGate([mkReport(tune, runsOf(true, true, false))], base, [], false);
  assert.deepEqual(first.rerun, [tune.id]);
  assert.equal(first.pass, false);

  const five = computeGate([mkReport(tune, runsOf(true, true, false, true, true, true))], base, [], true);
  assert.deepEqual([five.rerun, five.regressions, five.pass], [[], [], true]);

  const four = computeGate([mkReport(tune, runsOf(true, true, false, true, false, true))], base, [], true);
  assert.deepEqual([four.rerun, four.regressions, four.pass], [[], [tune.id], false]);
});

test("gate: a final pass with the rerun missing counts the drop as a regression", () => {
  const { tune } = gateCases();
  const base = mkBase([mkReport(tune, runsOf(true, true, true))]);
  const g = computeGate([mkReport(tune, runsOf(true, true, false))], base, [], true);
  assert.deepEqual([g.rerun, g.regressions], [[], [tune.id]]);
});

test("gate: a case main did not pass 3/3 cannot regress, and unfinished main runs do not count as passes", () => {
  const { tune, holdout } = gateCases();
  const base = mkBase([
    mkReport(tune, runsOf(true, false, false)),
    mkReport(holdout, [P, P, { pass: false, outcome: "no review", errored: true }]),
  ]);
  const g = computeGate(
    [mkReport(tune, runsOf(false, false, false)), mkReport(holdout, runsOf(false, false, false))],
    base,
    [],
    false,
  );
  assert.deepEqual(g.cases.map((c) => c.outcome), ["not-held", "not-held"]);
  assert.equal(g.pass, true);
});

test("gate: a case marked flakyOnMain cannot regress even when main passed it 3/3", () => {
  const { tune } = gateCases();
  const flaky = { ...tune, flakyOnMain: "main drops the real bug on some runs" };
  const base = mkBase([mkReport(flaky, runsOf(true, true, true))]);
  const g = computeGate([mkReport(flaky, runsOf(true, false, false, true, false, false))], base, [], true);
  assert.deepEqual([g.cases[0].outcome, g.cases[0].flaky, g.regressions, g.pass], ["not-held", true, [], true]);
});

test("gate: earlier main runs of the same reviewer that failed make a 3/3 case not held", () => {
  const { tune } = gateCases();
  const base = mkBase([mkReport(tune, runsOf(true, true, true))]);
  const cand = mkReport(tune, runsOf(true, false, false, true, false, false));
  const lucky = computeGate([cand], base, [], true, [mkReport(tune, runsOf(true, false, true))]);
  assert.deepEqual(
    [lucky.cases[0].outcome, lucky.cases[0].flaky, lucky.cases[0].earlierPassed, lucky.cases[0].earlierCompleted, lucky.pass],
    ["not-held", true, 2, 3, true],
  );
  const stable = computeGate([cand], base, [], true, [mkReport(tune, runsOf(true, true, true))]);
  assert.deepEqual([stable.cases[0].outcome, stable.cases[0].flaky, stable.regressions], ["regression", false, [tune.id]]);
  const errored = computeGate([cand], base, [], true, [mkReport(tune, [{ pass: false, outcome: "no review", errored: true }])]);
  assert.deepEqual([errored.cases[0].outcome, errored.cases[0].earlierCompleted], ["regression", 0]);
});

test("gate: with minMainRuns, main 3/3 holds a case only once its runs here and earlier reach it", () => {
  const { tune } = gateCases();
  const cand = mkReport(tune, runsOf(true, false, false, true, false, false));
  const short = computeGate([cand], mkBase([mkReport(tune, runsOf(true, true, true))]), [], true, [], 6);
  assert.deepEqual([short.cases[0].outcome, short.regressions, short.minMainRuns], ["not-held", [], 6]);
  const withEarlier = computeGate([cand], mkBase([mkReport(tune, runsOf(true, true, true))]), [], true, [mkReport(tune, runsOf(true, true, true))], 6);
  assert.deepEqual(withEarlier.regressions, [tune.id]);
  const topped = computeGate([cand], mkBase([mkReport(tune, runsOf(true, true, true, true, true, true))]), [], true, [], 6);
  assert.deepEqual([topped.cases[0].mainCompleted, topped.regressions], [6, [tune.id]]);
  const toppedFail = computeGate([cand], mkBase([mkReport(tune, runsOf(true, true, true, true, false, true))]), [], true, [], 6);
  assert.deepEqual([toppedFail.cases[0].outcome, toppedFail.cases[0].flaky], ["not-held", true]);
});

test("mainRunsShort names cases main passed every run so far with fewer than minMainRuns runs", () => {
  const { tune, holdout } = gateCases();
  const second = readManifest(MANIFEST).filter((c) => c.split === "tune")[1];
  const base = mkBase([
    mkReport(tune, runsOf(true, true, true)),
    mkReport(holdout, runsOf(true, true, false)),
    mkReport(second, runsOf(true, true, true)),
  ]);
  assert.deepEqual(mainRunsShort(base, [mkReport(second, runsOf(true, true, true))], 6), [tune.id]);
  assert.deepEqual(mainRunsShort(base, [], 3), []);
  const errored = mkBase([mkReport(tune, [P, P, { pass: false, outcome: "no review", errored: true }])]);
  assert.deepEqual(mainRunsShort(errored, [], 6), []);
});

test("gate: a target below 3/3 fails, and an unknown target id does too", () => {
  const { tune } = gateCases();
  const base = mkBase([mkReport(tune, runsOf(false, false, false))]);
  const two = computeGate([mkReport(tune, runsOf(true, true, false))], base, [tune.id, "nope"], false);
  assert.deepEqual(two.targetsMissed, [tune.id, "nope"]);
  assert.equal(two.pass, false);
  const ok = computeGate([mkReport(tune, runsOf(true, true, true))], base, [tune.id], false);
  assert.deepEqual([ok.targetsMissed, ok.pass], [[], true]);
});

test("gate: cost over 110% of main is flagged but does not fail the gate", () => {
  const { tune } = gateCases();
  const base = mkBase([mkReport(tune, runsOf(true, true, true), 1)]);
  const over = computeGate([mkReport(tune, runsOf(true, true, true), 1.2)], base, [], false);
  assert.equal(over.costRatio, 1.2);
  assert.deepEqual([over.costOver, over.pass], [true, true]);
  const at = computeGate([mkReport(tune, runsOf(true, true, true), 1.1)], base, [], false);
  assert.equal(at.costOver, false);
});

test("gate: refuses a baseline with no completed runs", () => {
  const { tune } = gateCases();
  assert.throws(
    () => computeGate([mkReport(tune, runsOf(true, true, true))], mkBase([mkReport(tune, [])]), [], false),
    /no completed runs/,
  );
});

test("gate report shows main beside every tune case and holdout only as an aggregate", () => {
  const { tune, holdout } = gateCases();
  const base = mkBase([mkReport(tune, runsOf(true, false, true)), mkReport(holdout, runsOf(true, true, true))]);
  const reports = [mkReport(tune, runsOf(true, true, true)), mkReport(holdout, runsOf(false, false, false))];
  const gate = computeGate(reports, base, [], false);
  const md = renderExpectReport(reports, "pr-abc", base, gate);
  assert.match(md, new RegExp(`${tune.id} \\|[^\\n]*\\| 3/3 \\| 2/3 \\(flaky\\) \\|`));
  assert.match(md, /Holdout: passed 0 of 1, regressions: 0\./);
  assert.doesNotMatch(md, new RegExp(holdout.id));
  assert.doesNotMatch(md, new RegExp(holdout.tests.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("gate report flags cost over the limit", () => {
  const { tune } = gateCases();
  const base = mkBase([mkReport(tune, runsOf(true, true, true), 1)]);
  const reports = [mkReport(tune, runsOf(true, true, true), 1.5)];
  const md = renderExpectReport(reports, "v", base, computeGate(reports, base, [], false));
  assert.match(md, /Cost vs main: 150%, needs justification in the PR body\./);
});

test("baselineGaps: a run still errored after both passes is not held, and only an absent result blocks", async () => {
  const { tune } = gateCases();
  const out = mkdtempSync(join(tmpdir(), "eval-gaps-"));
  const put = (n: number, r: Result) => {
    mkdirSync(join(out, tune.id), { recursive: true });
    writeFileSync(join(out, tune.id, `run-${n}.json`), JSON.stringify(r));
  };
  put(1, result({ caseId: tune.id }));
  put(2, result({ caseId: tune.id, output: null, error: "API Error: Opus 5's safeguards flagged this message" }));
  put(3, result({ caseId: tune.id, output: { status: "failed", reason: "gave up" } }));
  assert.deepEqual(baselineGaps([tune], out, 3), { total: 3, missing: 0, errored: 1, gaveUp: 1 });

  const base = { variant: "main-abc", runs: 3, reports: await scoreDir([tune], out) };
  const gate = computeGate([mkReport(tune, runsOf(true, true, true))], base, [], true);
  assert.deepEqual([gate.cases[0].outcome, gate.regressions, gate.pass], ["not-held", [], true]);

  assert.deepEqual(baselineGaps([tune], out, 4), { total: 4, missing: 1, errored: 1, gaveUp: 1 });
});

test("selectCases takes a comma-separated list of ids", () => {
  const all = readManifest(MANIFEST);
  const ids = [all[0].id, all[2].id];
  assert.deepEqual(selectCases(all, { case: ids.join(",") }).map((c) => c.id), ids);
});

test("history keeps only earlier runs of the same case head as the baseline", async () => {
  const { tune } = gateCases();
  const root = mkdtempSync(join(tmpdir(), "eval-history-"));
  const put = (dir: string, n: number, headSha: string) => {
    mkdirSync(join(root, dir, tune.id), { recursive: true });
    writeFileSync(
      join(root, dir, tune.id, `run-${n}.json`),
      JSON.stringify({ caseId: tune.id, headSha, variant: "main-1111111", output: null, error: "x", costUsd: null }),
    );
  };
  put("base", 1, "head-now");
  put("history", 1, "head-now");
  put("history", 2, "head-old");
  put("history", 3, "head-now");
  const [r] = await scoreHistory([tune], join(root, "history"), join(root, "base"));
  assert.equal(r.scores.length, 2);
});

test("history drops runs cached before the harness recorded a gating verdict", async () => {
  const { tune } = gateCases();
  const root = mkdtempSync(join(tmpdir(), "eval-history-"));
  const put = (dir: string, n: number, gating?: { verdict: string; gates: string[] }) => {
    mkdirSync(join(root, dir, tune.id), { recursive: true });
    writeFileSync(
      join(root, dir, tune.id, `run-${n}.json`),
      JSON.stringify({ caseId: tune.id, headSha: "h", variant: "main-1111111", output: null, error: "x", costUsd: null, gating }),
    );
  };
  put("base", 1, { verdict: "approve", gates: [] });
  put("history", 1);
  put("history", 2, { verdict: "approve", gates: [] });
  const [r] = await scoreHistory([tune], join(root, "history"), join(root, "base"));
  assert.equal(r.scores.length, 1);
});

test("every parked case has a reason, a valid case and an id the manifest no longer uses", () => {
  const parked = ParkedSchema.parse(JSON.parse(readFileSync(join(dirname(MANIFEST), "parked.json"), "utf-8")));
  const ids = new Set(readManifest(MANIFEST).map((c) => c.id));
  for (const p of parked) assert.equal(ids.has(p.case.id), false, p.case.id);
});
