import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { addEntry, chargedUsd, checkBudget, estimateUsd, readLedger, sumResultCosts } from "./ledger";
import type { LedgerEntry } from "./ledger";

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const fakeS3 = (objects: Record<string, string> = {}) => {
  const puts: { key: string; ifNoneMatch: unknown }[] = [];
  const client = {
    send: async (cmd: Cmd) => {
      const { input } = cmd;
      switch (cmd.constructor.name) {
        case "ListObjectsV2Command":
          return {
            Contents: Object.keys(objects)
              .filter((k) => k.startsWith(input.Prefix as string))
              .map((Key) => ({ Key })),
          };
        case "GetObjectCommand":
          return { Body: Readable.from([Buffer.from(objects[input.Key as string])]) };
        case "PutObjectCommand": {
          const key = input.Key as string;
          puts.push({ key, ifNoneMatch: input.IfNoneMatch });
          if (input.IfNoneMatch === "*" && key in objects) {
            throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          }
          objects[key] = input.Body as string;
          return {};
        }
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    },
  } as unknown as S3Client;
  return { client, objects, puts };
};

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  mode: "tune",
  costUsd: 10,
  budgetUsd: 150,
  at: "2026-10-27T00:00:00.000Z",
  ghRunId: "111",
  ghRunAttempt: "1",
  branchSha: "a".repeat(40),
  ...over,
});

test("a run id with no entries reads as an empty ledger", async () => {
  const { client } = fakeS3();
  assert.deepEqual(await readLedger("climb-1", client), []);
});

test("entries are written once, under the run id, with If-None-Match", async () => {
  const { client, objects, puts } = fakeS3();
  assert.equal(await addEntry("climb-1", entry(), client), true);
  assert.deepEqual(Object.keys(objects), ["eval-cache/ledger/climb-1/111-1-tune.json"]);
  assert.equal(puts[0].ifNoneMatch, "*");
  assert.deepEqual(await readLedger("climb-1", client), [entry()]);
});

test("re-adding the same attempt and mode is a no-op, not an overwrite", async () => {
  const { client, objects } = fakeS3();
  await addEntry("climb-1", entry(), client);
  assert.equal(await addEntry("climb-1", entry({ costUsd: 99 }), client), false);
  assert.equal((JSON.parse(objects["eval-cache/ledger/climb-1/111-1-tune.json"]) as LedgerEntry).costUsd, 10);
});

test("another run id's entries are not read", async () => {
  const { client } = fakeS3();
  await addEntry("climb-2", entry(), client);
  assert.deepEqual(await readLedger("climb-1", client), []);
});

test("a run id that could escape the prefix is refused", async () => {
  const { client } = fakeS3();
  await assert.rejects(readLedger("../reviews", client), /bad run id/);
  await assert.rejects(addEntry("a/b", entry(), client), /bad run id/);
});

test("check passes within the remainder and refuses past it", () => {
  const entries = [entry({ costUsd: 100 })];
  assert.deepEqual(checkBudget(entries, 150, 50), {
    budgetUsd: 150,
    spentUsd: 100,
    estimateUsd: 50,
    remainingUsd: 50,
    ok: true,
  });
  assert.equal(checkBudget(entries, 150, 50.01).ok, false);
});

test("a first use has the whole requested budget", () => {
  assert.deepEqual(checkBudget([], 150, 20.8), {
    budgetUsd: 150,
    spentUsd: 0,
    estimateUsd: 20.8,
    remainingUsd: 150,
    ok: true,
  });
});

test("a later dispatch cannot raise the budget the run id started with", () => {
  const entries = [entry({ costUsd: 100, budgetUsd: 150 })];
  assert.equal(checkBudget(entries, 1000, 60).budgetUsd, 150);
  assert.equal(checkBudget(entries, 1000, 60).ok, false);
  assert.equal(checkBudget(entries, 120, 1).budgetUsd, 120);
});

test("estimates per mode for a case count", () => {
  assert.equal(estimateUsd("dry-run", 9), 0);
  assert.equal(estimateUsd("inner", 2), 8);
  assert.equal(estimateUsd("tune", 5), 19.5);
  assert.equal(estimateUsd("gate", 9), 35.1);
});

test("sum adds every run's cost across directories and counts a missing cost as zero", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-sum-"));
  const write = (dir: string, c: string, run: number, body: object) => {
    mkdirSync(join(root, dir, c), { recursive: true });
    writeFileSync(join(root, dir, c, `run-${run}.json`), JSON.stringify(body));
  };
  write("first", "a", 1, { costUsd: 1.25 });
  write("first", "a", 2, { costUsd: 0.75 });
  write("first", "b", 1, { costUsd: null });
  write("rerun", "a", 4, { costUsd: 2 });
  writeFileSync(join(root, "first", "gate.json"), JSON.stringify({ costUsd: 500 }));
  assert.deepEqual(sumResultCosts([join(root, "first"), join(root, "rerun"), join(root, "missing")]), {
    costUsd: 4,
    runs: 4,
  });
});

test("sum ignores negative, non-numeric and unreadable costs instead of throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-bad-"));
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "a", "run-1.json"), JSON.stringify({ costUsd: -50 }));
  writeFileSync(join(root, "a", "run-2.json"), JSON.stringify({ costUsd: "9" }));
  writeFileSync(join(root, "a", "run-3.json"), "not json");
  writeFileSync(join(root, "a", "run-4.json"), JSON.stringify({ costUsd: 2 }));
  assert.deepEqual(sumResultCosts([root]), { costUsd: 2, runs: 4 });
});

test("a run is charged at least its estimate", () => {
  assert.equal(chargedUsd(null, 20), 20);
  assert.equal(chargedUsd(0, 20), 20);
  assert.equal(chargedUsd(35, 20), 35);
  assert.equal(chargedUsd(Number.NaN, 20), 20);
});
