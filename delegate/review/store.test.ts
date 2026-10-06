import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { createStore } from "./store";
import type { ReviewRecord } from "./schema";

const makeBody = (text: string) => ({
  [Symbol.asyncIterator]: async function* () {
    yield Buffer.from(text);
  },
});

const RUN_ID_1 = "a0000000-0000-4000-8000-000000000001";
const RUN_ID_2 = "a0000000-0000-4000-8000-000000000002";
const RUN_ID_3 = "a0000000-0000-4000-8000-000000000003";

const baseRecord: ReviewRecord = {
  runId: RUN_ID_1,
  repo: "thegoodparty/ops",
  prNumber: 42,
  baseSha: "aaaaaa",
  headSha: "bbbbbb",
  trigger: "webhook",
  agentVersion: "1.0.0",
  model: "claude-opus-4-5",
  startedAt: "2024-01-01T00:00:00.000Z",
  finishedAt: "2024-01-01T00:01:00.000Z",
  wallTimeMs: 60000,
  costUsd: 0.05,
  bundle: {
    repo: "thegoodparty/ops",
    prNumber: 42,
    baseRef: "main",
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
};

describe("acquireLock", () => {
  it("returns true when PutObject succeeds", async () => {
    const fake = {
      send: async (_cmd: { constructor: { name: string }; input: Record<string, unknown> }) => ({}),
    } as unknown as S3Client;

    const store = createStore(fake);
    const result = await store.acquireLock("thegoodparty/ops", 42, "bbbbbb");
    assert.equal(result, true);
  });

  it("returns false on 412 PreconditionFailed", async () => {
    const fake = {
      send: async () => {
        const err = new Error("PreconditionFailed") as Error & {
          $metadata: { httpStatusCode: number };
        };
        err.$metadata = { httpStatusCode: 412 };
        throw err;
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    const result = await store.acquireLock("thegoodparty/ops", 42, "bbbbbb");
    assert.equal(result, false);
  });

  it("returns false on 409 ConditionalRequestConflict", async () => {
    const fake = {
      send: async () => {
        const err = new Error("ConditionalRequestConflict") as Error & {
          $metadata: { httpStatusCode: number };
        };
        err.$metadata = { httpStatusCode: 409 };
        throw err;
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    const result = await store.acquireLock("thegoodparty/ops", 42, "bbbbbb");
    assert.equal(result, false);
  });

  it("rethrows unexpected errors", async () => {
    const fake = {
      send: async () => {
        const err = new Error("InternalError") as Error & {
          $metadata: { httpStatusCode: number };
        };
        err.$metadata = { httpStatusCode: 500 };
        throw err;
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    await assert.rejects(() => store.acquireLock("thegoodparty/ops", 42, "bbbbbb"), /InternalError/);
  });

  it("sends PutObject to the correct lock key with IfNoneMatch *", async () => {
    let captured: Record<string, unknown> = {};
    const fake = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        captured = cmd.input;
        return {};
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    await store.acquireLock("thegoodparty/ops", 42, "bbbbbb");
    assert.equal(captured["Key"], "reviews/thegoodparty/ops/42/bbbbbb/lock");
    assert.equal(captured["IfNoneMatch"], "*");
  });
});

describe("releaseLock and lockAcquiredAt", () => {
  it("releaseLock deletes the lock key", async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const store = createStore({
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        return {};
      },
    } as unknown as S3Client);
    await store.releaseLock("thegoodparty/ops", 42, "bbbbbb");
    assert.equal(calls[0].name, "DeleteObjectCommand");
    assert.equal(calls[0].input.Key, "reviews/thegoodparty/ops/42/bbbbbb/lock");
  });

  it("lockAcquiredAt reads the timestamp and treats a missing lock as undefined", async () => {
    const body = (text: string) => ({
      Body: (async function* () {
        yield Buffer.from(text);
      })(),
    });
    const present = createStore({
      send: async () => body(JSON.stringify({ acquiredAt: "2026-01-01T00:00:00.000Z" })),
    } as unknown as S3Client);
    assert.equal(
      (await present.lockAcquiredAt("thegoodparty/ops", 42, "bbbbbb"))?.toISOString(),
      "2026-01-01T00:00:00.000Z",
    );
    const missing = createStore({
      send: async () => {
        throw Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } });
      },
    } as unknown as S3Client);
    assert.equal(await missing.lockAcquiredAt("thegoodparty/ops", 42, "bbbbbb"), undefined);
  });
});

describe("putRecord", () => {
  it("sends PutObject to the correct record key", async () => {
    let capturedKey = "";
    let capturedContentType = "";
    const fake = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        capturedKey = cmd.input["Key"] as string;
        capturedContentType = cmd.input["ContentType"] as string;
        return {};
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    await store.putRecord(baseRecord);
    assert.equal(
      capturedKey,
      `reviews/thegoodparty/ops/42/bbbbbb/${RUN_ID_1}.json`
    );
    assert.equal(capturedContentType, "application/json");
  });

  it("throws when the record fails schema validation", async () => {
    const fake = {
      send: async () => ({}),
    } as unknown as S3Client;

    const store = createStore(fake);
    const bad = { ...baseRecord, runId: "not-a-uuid" };
    await assert.rejects(() => store.putRecord(bad as ReviewRecord));
  });
});

describe("listRecords", () => {
  it("returns records sorted by finishedAt ascending", async () => {
    const recordA: ReviewRecord = {
      ...baseRecord,
      runId: RUN_ID_2,
      headSha: "cccccc",
      finishedAt: "2024-01-02T00:01:00.000Z",
    };
    const recordB: ReviewRecord = {
      ...baseRecord,
      runId: RUN_ID_1,
      headSha: "bbbbbb",
      finishedAt: "2024-01-01T00:01:00.000Z",
    };

    const objects = [
      {
        key: `reviews/thegoodparty/ops/42/cccccc/${RUN_ID_2}.json`,
        body: JSON.stringify(recordA),
      },
      {
        key: "reviews/thegoodparty/ops/42/bbbbbb/lock",
        body: "",
      },
      {
        key: `reviews/thegoodparty/ops/42/bbbbbb/${RUN_ID_1}.json`,
        body: JSON.stringify(recordB),
      },
    ];

    const fake = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") {
          return {
            Contents: objects.map((o) => ({ Key: o.key })),
            NextContinuationToken: undefined,
          };
        }
        if (cmd.constructor.name === "GetObjectCommand") {
          const key = cmd.input["Key"] as string;
          const obj = objects.find((o) => o.key === key);
          return { Body: makeBody(obj?.body ?? "") };
        }
        return {};
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    const records = await store.listRecords("thegoodparty/ops", 42);
    assert.equal(records.length, 2);
    assert.equal(records[0].finishedAt, "2024-01-01T00:01:00.000Z");
    assert.equal(records[1].finishedAt, "2024-01-02T00:01:00.000Z");
  });

  it("skips keys ending in /lock", async () => {
    const fake = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") {
          return {
            Contents: [
              { Key: "reviews/thegoodparty/ops/42/bbbbbb/lock" },
            ],
            NextContinuationToken: undefined,
          };
        }
        return {};
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    const records = await store.listRecords("thegoodparty/ops", 42);
    assert.equal(records.length, 0);
  });

  it("skips and warns on invalid JSON", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

    try {
      const fake = {
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (cmd.constructor.name === "ListObjectsV2Command") {
            return {
              Contents: [{ Key: "reviews/thegoodparty/ops/42/bbbbbb/bad.json" }],
              NextContinuationToken: undefined,
            };
          }
          if (cmd.constructor.name === "GetObjectCommand") {
            return { Body: makeBody("not-valid-json{{{") };
          }
          return {};
        },
      } as unknown as S3Client;

      const store = createStore(fake);
      const records = await store.listRecords("thegoodparty/ops", 42);
      assert.equal(records.length, 0);
      assert.ok(warnings.some((w) => w.includes("invalid JSON")));
    } finally {
      console.warn = origWarn;
    }
  });

  it("skips and warns on schema-invalid objects", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));

    try {
      const fake = {
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (cmd.constructor.name === "ListObjectsV2Command") {
            return {
              Contents: [{ Key: "reviews/thegoodparty/ops/42/bbbbbb/bad.json" }],
              NextContinuationToken: undefined,
            };
          }
          if (cmd.constructor.name === "GetObjectCommand") {
            return { Body: makeBody(JSON.stringify({ runId: "bad" })) };
          }
          return {};
        },
      } as unknown as S3Client;

      const store = createStore(fake);
      const records = await store.listRecords("thegoodparty/ops", 42);
      assert.equal(records.length, 0);
      assert.ok(warnings.some((w) => w.includes("invalid ReviewRecord")));
    } finally {
      console.warn = origWarn;
    }
  });

  it("paginates using ContinuationToken", async () => {
    const page1Objects = [
      {
        key: `reviews/thegoodparty/ops/42/aaaaaa/${RUN_ID_3}.json`,
        body: JSON.stringify({
          ...baseRecord,
          runId: RUN_ID_3,
          headSha: "aaaaaa",
          finishedAt: "2024-01-03T00:00:00.000Z",
        }),
      },
    ];
    const page2Objects = [
      {
        key: `reviews/thegoodparty/ops/42/bbbbbb/${RUN_ID_1}.json`,
        body: JSON.stringify(baseRecord),
      },
    ];
    const allObjects = [...page1Objects, ...page2Objects];

    let callCount = 0;
    const fake = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") {
          callCount++;
          if (callCount === 1) {
            return {
              Contents: page1Objects.map((o) => ({ Key: o.key })),
              NextContinuationToken: "token-page-2",
            };
          }
          return {
            Contents: page2Objects.map((o) => ({ Key: o.key })),
            NextContinuationToken: undefined,
          };
        }
        if (cmd.constructor.name === "GetObjectCommand") {
          const key = cmd.input["Key"] as string;
          const obj = allObjects.find((o) => o.key === key);
          return { Body: makeBody(obj?.body ?? "") };
        }
        return {};
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    const records = await store.listRecords("thegoodparty/ops", 42);
    assert.equal(records.length, 2);
    assert.equal(callCount, 2);
  });
});

describe("latestRecord", () => {
  it("returns undefined when there are no records", async () => {
    const fake = {
      send: async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") {
          return { Contents: [], NextContinuationToken: undefined };
        }
        return {};
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    const result = await store.latestRecord("thegoodparty/ops", 99);
    assert.equal(result, undefined);
  });

  it("returns the record with the latest finishedAt", async () => {
    const recordA: ReviewRecord = {
      ...baseRecord,
      runId: RUN_ID_2,
      headSha: "cccccc",
      finishedAt: "2024-01-02T00:01:00.000Z",
    };
    const recordB: ReviewRecord = {
      ...baseRecord,
      runId: RUN_ID_1,
      headSha: "bbbbbb",
      finishedAt: "2024-01-01T00:01:00.000Z",
    };

    const objects = [
      {
        key: `reviews/thegoodparty/ops/42/cccccc/${RUN_ID_2}.json`,
        body: JSON.stringify(recordA),
      },
      {
        key: `reviews/thegoodparty/ops/42/bbbbbb/${RUN_ID_1}.json`,
        body: JSON.stringify(recordB),
      },
    ];

    const fake = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (cmd.constructor.name === "ListObjectsV2Command") {
          return {
            Contents: objects.map((o) => ({ Key: o.key })),
            NextContinuationToken: undefined,
          };
        }
        if (cmd.constructor.name === "GetObjectCommand") {
          const key = cmd.input["Key"] as string;
          const obj = objects.find((o) => o.key === key);
          return { Body: makeBody(obj?.body ?? "") };
        }
        return {};
      },
    } as unknown as S3Client;

    const store = createStore(fake);
    const result = await store.latestRecord("thegoodparty/ops", 42);
    assert.equal(result?.runId, RUN_ID_2);
  });
});
