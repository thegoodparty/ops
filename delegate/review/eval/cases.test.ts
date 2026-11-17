import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ScenarioSchema, loadCases, loadScenarios, readManifest, saveCases, scenarioNames, scenarioSplits } from "./cases";
import type { ReviewRecord } from "../schema";

const makeRecord = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  runId: randomUUID(),
  repo: "thegoodparty/ops",
  prNumber: 42,
  baseSha: "aaaaaa",
  headSha: "bbbbbb",
  trigger: "webhook",
  agentVersion: "1.0.0",
  model: "claude-opus-4-6",
  startedAt: "2024-01-01T00:00:00.000Z",
  finishedAt: "2024-01-01T00:01:00.000Z",
  wallTimeMs: 60000,
  costUsd: 0.05,
  bundle: {
    repo: "thegoodparty/ops",
    prNumber: 42,
    baseRef: "develop",
    baseSha: "aaaaaa",
    headSha: "bbbbbb",
    author: "swain",
    title: "Test PR",
    body: "A test pull request",
    diff: "diff --git a/foo.ts b/foo.ts\n",
    changedFiles: ["foo.ts"],
    priorFindings: [],
  },
  output: { status: "complete", findings: [], summary: "LGTM" },
  verdict: "approve",
  action: "approved",
  gates: [],
  findings: [],
  droppedFindings: [],
  ...overrides,
});

const tmpDir = () => {
  const dir = join(tmpdir(), `cases-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("loadCases returns valid records from a dir", () => {
  const dir = tmpDir();
  const record = makeRecord();
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record));

  const records = loadCases(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, record.runId);
});

test("loadCases skips invalid JSON files with a warn", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "bad.json"), "not json");
  const record = makeRecord();
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record));

  const records = loadCases(dir);
  assert.equal(records.length, 1);
});

test("loadCases skips invalid schema files with a warn", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ notARecord: true }));
  const record = makeRecord();
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record));

  const records = loadCases(dir);
  assert.equal(records.length, 1);
});

test("loadCases keeps a record whose review failed", () => {
  const dir = tmpDir();
  const complete = makeRecord({ output: { status: "complete", findings: [], summary: "ok" } });
  const failed = makeRecord({ output: { status: "failed", reason: "agent failed" }, verdict: "failed", action: "failed" });
  writeFileSync(join(dir, `${complete.runId}.json`), JSON.stringify(complete));
  writeFileSync(join(dir, `${failed.runId}.json`), JSON.stringify(failed));

  const records = loadCases(dir);
  assert.deepEqual(records.map((r) => r.output?.status).sort(), ["complete", "failed"]);
});

test("loadCases ignores non-json files", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "README.md"), "# not a record");
  const record = makeRecord();
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record));

  const records = loadCases(dir);
  assert.equal(records.length, 1);
});

test("saveCases writes records as <runId>.json files", () => {
  const dir = tmpDir();
  const records = [makeRecord(), makeRecord()];

  saveCases(records, dir);

  for (const record of records) {
    const path = join(dir, `${record.runId}.json`);
    assert.ok(existsSync(path), `expected ${path} to exist`);
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ReviewRecord;
    assert.equal(parsed.runId, record.runId);
  }
});

test("saveCases creates the output dir if it does not exist", () => {
  const dir = join(tmpdir(), `cases-save-test-${randomUUID()}`, "nested", "dir");
  const record = makeRecord();

  saveCases([record], dir);

  assert.ok(existsSync(join(dir, `${record.runId}.json`)));
});

test("the checked-in scenario manifest parses and core has 23 cases", () => {
  const scenarios = readManifest(join(__dirname, "scenarios.json"));
  assert.equal(scenarios.filter((s) => s.suite === "core").length, 23);
});

test("the checked-in scenarios hold out about a third of each suite", () => {
  const scenarios = readManifest(join(__dirname, "scenarios.json"));
  assert.equal(scenarios.length, 33);
  for (const suite of ["core", "re-review"]) {
    const inSuite = scenarios.filter((s) => s.suite === suite);
    const holdout = inSuite.filter((s) => s.split === "holdout").length;
    assert.ok(holdout >= inSuite.length / 4 && holdout <= inSuite.length / 2, `${suite}: ${holdout} holdout`);
  }
});

const scenarioDir = (records: ReviewRecord[]): string => {
  const dir = tmpDir();
  for (const record of records) {
    writeFileSync(join(dir, `${record.runId}.record.json`), JSON.stringify(record));
  }
  return dir;
};

const scenarioEntry = (id: string, suite: string, recordFile: string) => ({
  id,
  suite,
  record: recordFile,
  tests: "t",
  split: "tune" as const,
  source: "production-caught" as const,
  kind: "bug" as const,
});

test("loadScenarios loads only the named suite", () => {
  const a = makeRecord();
  const b = makeRecord();
  const dir = scenarioDir([a, b]);
  const path = join(dir, "scenarios.json");
  writeFileSync(
    path,
    JSON.stringify([scenarioEntry("a", "core", `${a.runId}.record.json`), scenarioEntry("b", "re-review", `${b.runId}.record.json`)]),
  );

  const loaded = loadScenarios(path, { suite: "core" });
  assert.deepEqual(loaded.map((l) => l.record.runId), [a.runId]);
});

test("loadScenarios refuses an empty suite and an invalid record", () => {
  const a = makeRecord();
  const dir = scenarioDir([a]);
  const path = join(dir, "scenarios.json");
  writeFileSync(path, JSON.stringify([scenarioEntry("a", "core", `${a.runId}.record.json`)]));
  assert.throws(() => loadScenarios(path, { suite: "nope" }), /no scenarios/);

  writeFileSync(join(dir, "bad.record.json"), JSON.stringify({ bad: true }));
  const badPath = join(dir, "bad-scenarios.json");
  writeFileSync(badPath, JSON.stringify([scenarioEntry("a", "core", "bad.record.json")]));
  assert.throws(() => loadScenarios(badPath), /scenario a: invalid ReviewRecord/);
});

test("loadScenarios refuses a record file that is not there", () => {
  const dir = tmpDir();
  const path = join(dir, "scenarios.json");
  writeFileSync(path, JSON.stringify([scenarioEntry("a", "core", "missing.record.json")]));
  assert.throws(() => loadScenarios(path), /ENOENT/);
});

test("scenarioNames maps a run id to its scenario id", () => {
  const record = makeRecord();
  const names = scenarioNames([{ scenario: scenarioEntry("omni-1-x", "core", "r.record.json"), record }]);
  assert.equal(names.get(record.runId), "omni-1-x");
});

test("scenarioSplits maps a run id to its split", () => {
  const a = makeRecord();
  const b = makeRecord();
  const splits = scenarioSplits([
    { scenario: scenarioEntry("a", "core", "a.record.json"), record: a },
    { scenario: { ...scenarioEntry("b", "core", "b.record.json"), split: "holdout" as const }, record: b },
  ]);
  assert.equal(splits.get(a.runId), "tune");
  assert.equal(splits.get(b.runId), "holdout");
});

test("ScenarioSchema rejects a bad kind and a missing split", () => {
  const ok = scenarioEntry("a", "core", "a.record.json");
  assert.equal(ScenarioSchema.safeParse(ok).success, true);
  assert.equal(ScenarioSchema.safeParse({ ...ok, kind: "typo" }).success, false);
  const { split: _split, ...noSplit } = ok;
  assert.equal(ScenarioSchema.safeParse(noSplit).success, false);
});

test("loadScenarios filters by split and refuses an empty or unknown split", () => {
  const a = makeRecord();
  const b = makeRecord();
  const dir = scenarioDir([a, b]);
  const path = join(dir, "scenarios.json");
  writeFileSync(
    path,
    JSON.stringify([
      scenarioEntry("a", "core", `${a.runId}.record.json`),
      { ...scenarioEntry("b", "core", `${b.runId}.record.json`), split: "holdout" },
    ]),
  );

  assert.deepEqual(loadScenarios(path, { split: "holdout" }).map((l) => l.scenario.id), ["b"]);
  assert.deepEqual(loadScenarios(path, {}).map((l) => l.scenario.id), ["a", "b"]);
  assert.throws(() => loadScenarios(path, { split: "dev" }));
});
