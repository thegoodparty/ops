import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { ScenarioSchema, loadCases, loadScenarios, readManifest, saveCases, scenarioNames, scenarioSplits } from "./cases";
import type { Scenario } from "./cases";
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

test("loadCases from dir returns valid records", async () => {
  const dir = tmpDir();
  const record = makeRecord();
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record));

  const records = await loadCases({ from: dir });
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, record.runId);
});

test("loadCases from dir skips invalid JSON files with a warn", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "bad.json"), "not json");
  const record = makeRecord();
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record));

  const records = await loadCases({ from: dir });
  assert.equal(records.length, 1);
});

test("loadCases from dir skips invalid schema files with a warn", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ notARecord: true }));
  const record = makeRecord();
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record));

  const records = await loadCases({ from: dir });
  assert.equal(records.length, 1);
});

test("loadCases filters by repo", async () => {
  const dir = tmpDir();
  const r1 = makeRecord({ repo: "thegoodparty/ops" });
  const r2 = makeRecord({ repo: "thegoodparty/gp-webapp" });
  writeFileSync(join(dir, `${r1.runId}.json`), JSON.stringify(r1));
  writeFileSync(join(dir, `${r2.runId}.json`), JSON.stringify(r2));

  const records = await loadCases({ from: dir, repo: "thegoodparty/ops" });
  assert.equal(records.length, 1);
  assert.equal(records[0].repo, "thegoodparty/ops");
});

test("loadCases applies limit", async () => {
  const dir = tmpDir();
  for (let i = 0; i < 5; i++) {
    const r = makeRecord();
    writeFileSync(join(dir, `${r.runId}.json`), JSON.stringify(r));
  }

  const records = await loadCases({ from: dir, limit: 3 });
  assert.equal(records.length, 3);
});

test("loadCases filters onlyComplete", async () => {
  const dir = tmpDir();
  const complete = makeRecord({ output: { status: "complete", findings: [], summary: "ok" } });
  const failed = makeRecord({ output: { status: "failed", reason: "agent failed" }, verdict: "failed", action: "failed" });
  writeFileSync(join(dir, `${complete.runId}.json`), JSON.stringify(complete));
  writeFileSync(join(dir, `${failed.runId}.json`), JSON.stringify(failed));

  const records = await loadCases({ from: dir, onlyComplete: true });
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, complete.runId);
});

test("loadCases from dir ignores non-json files", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "README.md"), "# not a record");
  const record = makeRecord();
  writeFileSync(join(dir, `${record.runId}.json`), JSON.stringify(record));

  const records = await loadCases({ from: dir });
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

test("loadCases from S3 loads records and skips lock keys", async () => {
  const record = makeRecord();
  const calls: string[] = [];

  const fakeClient = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      calls.push(name);
      if (name === "ListObjectsV2Command") {
        return {
          Contents: [
            { Key: `reviews/thegoodparty/ops/42/bbbbbb/${record.runId}.json` },
            { Key: `reviews/thegoodparty/ops/42/bbbbbb/lock` },
          ],
          NextContinuationToken: undefined,
        };
      }
      if (name === "GetObjectCommand") {
        const body = Buffer.from(JSON.stringify(record));
        return {
          Body: (async function* () { yield body; })(),
        };
      }
      return {};
    },
  } as unknown as S3Client;

  const records = await loadCases({ from: "s3" }, fakeClient);
  assert.equal(records.length, 1);
  assert.equal(records[0].runId, record.runId);
  assert.ok(calls.includes("ListObjectsV2Command"));
  assert.ok(calls.includes("GetObjectCommand"));
});

test("loadCases from S3 skips invalid records with a warn", async () => {
  const fakeClient = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return {
          Contents: [{ Key: "reviews/repo/1/sha/runid.json" }],
          NextContinuationToken: undefined,
        };
      }
      const body = Buffer.from(JSON.stringify({ bad: "data" }));
      return { Body: (async function* () { yield body; })() };
    },
  } as unknown as S3Client;

  const records = await loadCases({ from: "s3" }, fakeClient);
  assert.equal(records.length, 0);
});

test("the checked-in scenario manifest parses and core has 12 cases", () => {
  const scenarios = readManifest(join(__dirname, "scenarios.json"));
  assert.equal(scenarios.filter((s) => s.suite === "core").length, 12);
});

test("the checked-in scenarios hold out about a third of each suite", () => {
  const scenarios = readManifest(join(__dirname, "scenarios.json"));
  assert.equal(scenarios.length, 22);
  for (const suite of ["core", "re-review"]) {
    const inSuite = scenarios.filter((s) => s.suite === suite);
    const holdout = inSuite.filter((s) => s.split === "holdout").length;
    assert.ok(holdout >= inSuite.length / 4 && holdout <= inSuite.length / 2, `${suite}: ${holdout} holdout`);
  }
});

const scenario = (id: string, suite: string, runId: string): Scenario => ({
  id,
  suite,
  key: `reviews/thegoodparty/ops/42/bbbbbb/${runId}.json`,
  tests: "t",
  split: "tune",
  source: "simulated",
  kind: "bug",
});

const clientFor = (records: Map<string, unknown>) =>
  ({
    send: async (cmd: { input: { Key: string } }) => {
      const body = Buffer.from(JSON.stringify(records.get(cmd.input.Key)));
      return { Body: (async function* () { yield body; })() };
    },
  }) as unknown as S3Client;

test("loadScenarios loads only the named suite", async () => {
  const a = makeRecord();
  const b = makeRecord();
  const scenarios = [scenario("a", "core", a.runId), scenario("b", "re-review", b.runId)];
  const client = clientFor(new Map([[scenarios[0].key, a], [scenarios[1].key, b]]));

  const loaded = await loadScenarios(scenarios, { suite: "core" }, client);
  assert.deepEqual(loaded.map((l) => l.record.runId), [a.runId]);
});

test("loadScenarios refuses an empty suite and an invalid record", async () => {
  const a = makeRecord();
  const scenarios = [scenario("a", "core", a.runId)];
  await assert.rejects(loadScenarios(scenarios, { suite: "nope" }, clientFor(new Map())), /no scenarios/);
  await assert.rejects(
    loadScenarios(scenarios, {}, clientFor(new Map([[scenarios[0].key, { bad: true }]]))),
    /scenario a: invalid ReviewRecord/,
  );
});

test("scenarioNames maps a run id to its scenario id", () => {
  const names = scenarioNames([scenario("omni-1-x", "core", "run-123")]);
  assert.equal(names.get("run-123"), "omni-1-x");
});

test("scenarioSplits maps a run id to its split", () => {
  const holdout = { ...scenario("b", "core", "run-2"), split: "holdout" as const };
  const splits = scenarioSplits([scenario("a", "core", "run-1"), holdout]);
  assert.equal(splits.get("run-1"), "tune");
  assert.equal(splits.get("run-2"), "holdout");
});

test("ScenarioSchema rejects a bad kind and a missing split", () => {
  const ok = scenario("a", "core", "r");
  assert.equal(ScenarioSchema.safeParse(ok).success, true);
  assert.equal(ScenarioSchema.safeParse({ ...ok, kind: "typo" }).success, false);
  const { split: _split, ...noSplit } = ok;
  assert.equal(ScenarioSchema.safeParse(noSplit).success, false);
});

test("loadScenarios filters by split and refuses an empty or unknown split", async () => {
  const a = makeRecord();
  const b = makeRecord();
  const scenarios = [
    scenario("a", "core", a.runId),
    { ...scenario("b", "core", b.runId), split: "holdout" as const },
  ];
  const client = clientFor(new Map([[scenarios[0].key, a], [scenarios[1].key, b]]));

  const holdout = await loadScenarios(scenarios, { split: "holdout" }, client);
  assert.deepEqual(holdout.map((l) => l.scenario.id), ["b"]);
  const all = await loadScenarios(scenarios, {}, client);
  assert.deepEqual(all.map((l) => l.scenario.id), ["a", "b"]);
  await assert.rejects(loadScenarios([scenarios[0]], { split: "holdout" }, client), /no scenarios in split "holdout"/);
  await assert.rejects(loadScenarios(scenarios, { split: "dev" }, client));
});
