import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { loadCases, saveCases } from "./cases";
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
