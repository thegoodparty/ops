import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { execFileSync } from "node:child_process";
import { cachePrefix, pullCache, pushCache, replayKey } from "./cache";

const KEY = "abc123";
const PREFIX = `eval-cache/main/${KEY}/core/`;

const tmp = () => mkdtempSync(join(tmpdir(), "eval-cache-"));

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

// A bucket in memory. PutObject honors If-None-Match: * the way S3 does.
const fakeS3 = (objects: Record<string, string>) => {
  const puts: string[] = [];
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
          if (input.IfNoneMatch === "*" && key in objects) {
            throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          }
          objects[key] = input.Body as string;
          puts.push(key);
          return {};
        }
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    },
  } as unknown as S3Client;
  return { client, objects, puts };
};

const ok = (id: string) =>
  JSON.stringify({ caseId: id, output: { status: "complete", findings: [], summary: "s" }, costUsd: 1 });
const errored = (id: string) => JSON.stringify({ caseId: id, output: null, error: "agent threw: boom", costUsd: null });
const failedOutput = (id: string) =>
  JSON.stringify({ caseId: id, output: { status: "failed", reason: "no json" }, costUsd: 1 });

test("cachePrefix is keyed on the replay key and the suite", () => {
  assert.equal(cachePrefix("t1", "expected"), "eval-cache/main/t1/expected/");
  assert.notEqual(cachePrefix("t1", "core"), cachePrefix("t2", "core"));
});

test("pull writes flat results where replay looks for them", async () => {
  const { client } = fakeS3({
    [`${PREFIX}case-a/run-1.json`]: ok("case-a"),
    [`${PREFIX}case-b/run-1.json`]: ok("case-b"),
    [`eval-cache/main/other/core/case-c/run-1.json`]: ok("case-c"),
  });
  const dir = tmp();
  const pulled = await pullCache({ key: KEY, suite: "core", layout: "flat", dir }, client);
  assert.deepEqual(pulled.sort(), ["case-a.json", "case-b.json"]);
  assert.equal(readFileSync(join(dir, "case-a.json"), "utf-8"), ok("case-a"));
  assert.equal(existsSync(join(dir, "case-c.json")), false);
});

test("pull writes the runs layout as <case>/run-<n>.json", async () => {
  const { client } = fakeS3({
    [`${PREFIX}case-a/run-1.json`]: ok("case-a"),
    [`${PREFIX}case-a/run-3.json`]: ok("case-a"),
  });
  const dir = tmp();
  await pullCache({ key: KEY, suite: "core", layout: "runs", dir }, client);
  assert.equal(existsSync(join(dir, "case-a", "run-1.json")), true);
  assert.equal(existsSync(join(dir, "case-a", "run-3.json")), true);
});

test("pull from an empty prefix succeeds and pulls nothing", async () => {
  const { client } = fakeS3({});
  const pulled = await pullCache({ key: KEY, suite: "core", layout: "flat", dir: tmp() }, client);
  assert.deepEqual(pulled, []);
});

test("push uploads new results and skips the ones that were pulled", async () => {
  const { client, puts } = fakeS3({ [`${PREFIX}case-a/run-1.json`]: ok("case-a") });
  const dir = tmp();
  const opts = { key: KEY, suite: "core", layout: "flat" as const, dir };
  await pullCache(opts, client);
  writeFileSync(join(dir, "case-b.json"), ok("case-b"));

  const summary = await pushCache(opts, client);
  assert.deepEqual(summary.pushed, ["case-b.json"]);
  assert.deepEqual(summary.skippedPulled, ["case-a.json"]);
  assert.deepEqual(puts, [`${PREFIX}case-b/run-1.json`]);
});

test("push never overwrites an existing key", async () => {
  const { client, objects } = fakeS3({ [`${PREFIX}case-a/run-1.json`]: ok("case-a") });
  const dir = tmp();
  const original = objects[`${PREFIX}case-a/run-1.json`];
  writeFileSync(join(dir, "case-a.json"), JSON.stringify({ ...JSON.parse(ok("case-a")), costUsd: 99 }));

  const summary = await pushCache({ key: KEY, suite: "core", layout: "flat", dir }, client);
  assert.deepEqual(summary.skippedExisting, ["case-a.json"]);
  assert.deepEqual(summary.pushed, []);
  assert.equal(objects[`${PREFIX}case-a/run-1.json`], original);
});

test("push treats a racing put (409 ConditionalRequestConflict) as already cached", async () => {
  const client = {
    send: async () => {
      throw Object.assign(new Error("conflict"), {
        name: "ConditionalRequestConflict",
        $metadata: { httpStatusCode: 409 },
      });
    },
  } as unknown as S3Client;
  const dir = tmp();
  writeFileSync(join(dir, "case-a.json"), ok("case-a"));
  const summary = await pushCache({ key: KEY, suite: "core", layout: "flat", dir }, client);
  assert.deepEqual(summary.skippedExisting, ["case-a.json"]);
  assert.deepEqual(summary.pushed, []);
});

test("push does not cache an errored replay", async () => {
  const { client, puts } = fakeS3({});
  const dir = tmp();
  writeFileSync(join(dir, "case-a.json"), errored("case-a"));
  writeFileSync(join(dir, "case-b.json"), ok("case-b"));

  const summary = await pushCache({ key: KEY, suite: "core", layout: "flat", dir }, client);
  assert.deepEqual(summary.skippedErrored, ["case-a.json"]);
  assert.deepEqual(puts, [`${PREFIX}case-b/run-1.json`]);
});

test("both layouts skip errored and failed results the same way", async () => {
  for (const layout of ["flat", "runs"] as const) {
    const { client, puts } = fakeS3({});
    const dir = tmp();
    const file = (id: string, body: string) => {
      if (layout === "flat") return writeFileSync(join(dir, `${id}.json`), body);
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, "run-1.json"), body);
    };
    file("good", ok("good"));
    file("threw", errored("threw"));
    file("failed", failedOutput("failed"));

    const summary = await pushCache({ key: KEY, suite: "core", layout, dir }, client);
    assert.deepEqual(puts, [`${PREFIX}good/run-1.json`], layout);
    assert.deepEqual(summary.skippedErrored.sort(), layout === "flat"
      ? ["failed.json", "threw.json"]
      : ["failed/run-1.json", "threw/run-1.json"], layout);
  }
});

test("push in the runs layout caches the good run and retries the errored one", async () => {
  const { client, puts } = fakeS3({});
  const dir = tmp();
  mkdirSync(join(dir, "case-a"));
  writeFileSync(join(dir, "case-a", "run-1.json"), ok("case-a"));
  writeFileSync(join(dir, "case-a", "run-2.json"), errored("case-a"));
  writeFileSync(join(dir, "report.md"), "not a result");

  await pushCache({ key: KEY, suite: "core", layout: "runs", dir }, client);
  assert.deepEqual(puts, [`${PREFIX}case-a/run-1.json`]);
});

test("push surfaces a real S3 failure instead of treating it as already cached", async () => {
  const client = {
    send: async () => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    },
  } as unknown as S3Client;
  const dir = tmp();
  writeFileSync(join(dir, "case-a.json"), ok("case-a"));
  await assert.rejects(pushCache({ key: KEY, suite: "core", layout: "flat", dir }, client), /denied/);
});

test("the replay key changes when any input main's replay executes changes", () => {
  const repo = tmp();
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      stdio: "pipe",
    });
  const write = (path: string, body: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  };
  const inputs = ["delegate/agents/a.ts", "delegate/framework/f.ts", "delegate/review/r.ts", "package-lock.json"];
  git("init", "-q");
  for (const f of inputs) write(f, "v1");
  write("README.md", "v1");
  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    return replayKey(repo);
  };
  const base = commit();

  write("README.md", "v2");
  assert.equal(commit(), base, "an unrelated file must keep the cache warm");

  let previous = base;
  for (const f of inputs) {
    write(f, "v2");
    const next = commit();
    assert.notEqual(next, previous, `${f} must change the key`);
    previous = next;
  }
});
