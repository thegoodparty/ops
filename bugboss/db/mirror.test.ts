import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { S3Client } from "@aws-sdk/client-s3";

import { loadPi } from "../agent/harness";
import { createHarnessMirror } from "./mirror";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-mirror-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeS3 = () => {
  const state = { objects: new Map<string, Buffer>(), puts: 0, failing: false };
  const s3 = {
    send: async (cmd: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) => {
      if (cmd.constructor.name === "GetObjectCommand") {
        const body = state.objects.get(cmd.input.Key);
        if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => body } };
      }
      state.puts += 1;
      if (state.failing) throw new Error("RequestTimeTooSkewed");
      state.objects.set(cmd.input.Key, Buffer.from(cmd.input.Body!));
      return {};
    },
  };
  return { s3: s3 as unknown as S3Client, state };
};

const captureEvents = async (fn: () => Promise<unknown>): Promise<string[]> => {
  const events: string[] = [];
  const original = { error: console.error, log: console.log };
  const capture = (line: unknown) => {
    try {
      events.push(JSON.parse(String(line)).event);
    } catch {
      original.error(line);
    }
  };
  console.error = capture;
  console.log = capture;
  try {
    await fn();
  } finally {
    console.error = original.error;
    console.log = original.log;
  }
  return events;
};

const openHarness = async (path: string) => {
  const pi = await loadPi();
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const storage = await pi.sqlite.openNodeSqliteStorage(path);
  const harness = await pi.durable.Harness.open(
    storage,
    { models: createModels(), registry: pi.durable.createRegistry() },
    pi.context,
  );
  return { pi, harness };
};

test("a snapshot taken under a live harness restores into a file a new harness reads", async () => {
  const path = join(dir, "harness.sqlite");
  const { s3, state } = fakeS3();
  const { pi, harness } = await openHarness(path);
  const mirror = createHarnessMirror({ path, bucket: "b", key: "state/harness.sqlite", s3 });
  harness.subscribeCommits(() => mirror.markDirty());

  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { instructions: "remember me" } },
    pi.context,
  );
  await mirror.snapshotIfDirty();
  assert.equal(state.puts, 1);
  await mirror.snapshotIfDirty();
  assert.equal(state.puts, 1, "nothing committed, nothing PUT");
  mirror.close();
  await harness.close(pi.context);

  const restoredPath = join(dir, "restored.sqlite");
  const restorer = createHarnessMirror({ path: restoredPath, bucket: "b", key: "state/harness.sqlite", s3 });
  assert.equal(await restorer.restore(), true);
  const reopened = await openHarness(restoredPath);
  const found = await reopened.harness.conversation(conversation.id, pi.context);
  assert.ok(found, "the conversation survived the round trip");
  assert.equal((await found.agent(pi.context)).instructions, "remember me");
  await reopened.harness.close(pi.context);
});

test("restore leaves an existing local file alone and treats a missing object as a cold start", async () => {
  const { s3, state } = fakeS3();
  const present = join(dir, "present.sqlite");
  writeFileSync(present, "local");
  state.objects.set("k", Buffer.from("remote"));
  assert.equal(await createHarnessMirror({ path: present, bucket: "b", key: "k", s3 }).restore(), false);

  const absent = join(dir, "absent.sqlite");
  const events = await captureEvents(async () => {
    assert.equal(await createHarnessMirror({ path: absent, bucket: "b", key: "missing", s3 }).restore(), false);
  });
  assert.deepEqual(events, ["harness_cold_start"]);
  assert.equal(existsSync(absent), false);
});

test("a failed PUT alarms once, alarms again after five minutes, keeps the mirror dirty, and never throws", async () => {
  const path = join(dir, "harness.sqlite");
  const { s3, state } = fakeS3();
  const { pi, harness } = await openHarness(path);
  let clock = 0;
  const mirror = createHarnessMirror({ path, bucket: "b", key: "k", s3, now: () => clock });
  await harness.createConversation({ ownership: { kind: "ownerless" } }, pi.context);

  state.failing = true;
  mirror.markDirty();
  const events = await captureEvents(async () => {
    await mirror.snapshotIfDirty();
    clock = 60_000;
    await mirror.snapshotIfDirty();
    clock = 5 * 60_000;
    await mirror.snapshotIfDirty();
    clock = 10 * 60_000;
    await mirror.snapshotIfDirty();
    state.failing = false;
    await mirror.snapshotIfDirty();
    await mirror.snapshotIfDirty();
  });

  assert.deepEqual(events, [
    "harness_snapshot_failed",
    "harness_snapshot_still_failing",
    "harness_snapshot_recovered",
  ]);
  assert.equal(state.puts, 5, "each failure stayed dirty and retried; the success cleared it");
  assert.ok(state.objects.has("k"));
  assert.equal(existsSync(`${path}.snapshot`), false, "the local copy is always cleaned up");
  mirror.close();
  await harness.close(pi.context);
});

test("a commit during an in-flight PUT is picked up by the next snapshot", async () => {
  const path = join(dir, "harness.sqlite");
  const { pi, harness } = await openHarness(path);
  let puts = 0;
  let release!: () => void;
  const s3 = {
    send: async () => {
      puts += 1;
      if (puts === 1) await new Promise<void>((resolve) => (release = resolve));
      return {};
    },
  } as unknown as S3Client;
  const mirror = createHarnessMirror({ path, bucket: "b", key: "k", s3 });

  mirror.markDirty();
  const first = mirror.snapshotIfDirty();
  await new Promise((resolve) => setImmediate(resolve));
  mirror.markDirty();
  release();
  await first;
  await mirror.snapshotIfDirty();
  assert.equal(puts, 2);
  mirror.close();
  await harness.close(pi.context);
});
