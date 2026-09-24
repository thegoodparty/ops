import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  PROMPT_ENTRY_TYPE,
  createSessionSync,
  readStoredPrefixFromFile,
  readStoredPrefixFromJsonl,
  restoreSessionFile,
  sessionKeyFor,
  sessionSyncExtension,
  type SessionStore,
} from "./session";

const fakeStore = () => {
  const objects = new Map<string, Buffer>();
  const puts: string[] = [];
  const store: SessionStore = {
    get: async (key) => objects.get(key) ?? null,
    put: async (key, body) => {
      puts.push(key);
      objects.set(key, Buffer.from(body));
    },
  };
  return { store, objects, puts };
};

const prefix = {
  systemPrompt: "You are the incident agent.\nLine two.",
  toolNames: ["bash", "monitor"],
  modelId: "us.anthropic.claude-opus-5",
};

const sessionJsonl = [
  JSON.stringify({ type: "session", version: 3, id: "inc-1", cwd: "/work/inc-1/omni" }),
  JSON.stringify({
    type: "custom",
    id: "aa",
    parentId: null,
    timestamp: "2026-09-24T00:00:00.000Z",
    customType: PROMPT_ENTRY_TYPE,
    data: prefix,
  }),
  JSON.stringify({
    type: "message",
    id: "bb",
    parentId: "aa",
    timestamp: "2026-09-24T00:00:01.000Z",
    message: { role: "user", content: "Incident inc-1 is yours.", timestamp: 1 },
  }),
  "",
].join("\n");

test("a session round-trips through the store byte for byte", async () => {
  const { store, objects } = fakeStore();
  const liveDir = await mkdtemp(join(tmpdir(), "bugboss-live-"));
  const liveFile = join(liveDir, "inc-1.jsonl");
  await writeFile(liveFile, sessionJsonl);

  const sync = createSessionSync({
    store,
    key: sessionKeyFor("inc-1"),
    sessionFile: () => liveFile,
  });
  await sync.flush();
  assert.equal(sync.lastError(), null);
  assert.ok(objects.has("sessions/inc-1.jsonl"));

  const restoreDir = await mkdtemp(join(tmpdir(), "bugboss-restore-"));
  const restoredFile = join(restoreDir, "inc-1.jsonl");
  const restored = await restoreSessionFile({
    store,
    key: sessionKeyFor("inc-1"),
    sessionFile: restoredFile,
  });

  assert.equal(restored, true);
  assert.deepEqual(await readFile(restoredFile), await readFile(liveFile));
  assert.deepEqual(await readStoredPrefixFromFile(restoredFile), prefix);
});

test("a first start finds no object and no stored prefix", async () => {
  const { store } = fakeStore();
  const dir = await mkdtemp(join(tmpdir(), "bugboss-fresh-"));
  const file = join(dir, "inc-2.jsonl");

  assert.equal(
    await restoreSessionFile({ store, key: sessionKeyFor("inc-2"), sessionFile: file }),
    false,
  );
  assert.equal(await readStoredPrefixFromFile(file), null);
});

test("turn_end syncs, and a store failure never ends the turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bugboss-turn-"));
  const file = join(dir, "inc-3.jsonl");
  await writeFile(file, sessionJsonl);

  const puts: Buffer[] = [];
  let failNext = true;
  const store: SessionStore = {
    get: async () => null,
    put: async (_key, body) => {
      if (failNext) {
        failNext = false;
        throw new Error("s3 is having a day");
      }
      puts.push(Buffer.from(body));
    },
  };

  const sync = createSessionSync({ store, key: "sessions/inc-3.jsonl", sessionFile: () => file });
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[event] = handler;
      return () => {};
    },
  } as unknown as ExtensionAPI;

  sessionSyncExtension(sync)(pi);
  assert.ok(handlers.turn_end);
  assert.ok(handlers.session_shutdown);

  await handlers.turn_end({ type: "turn_end" }, {});
  assert.equal(puts.length, 0);
  assert.match(String(sync.lastError()), /s3 is having a day/);

  await handlers.turn_end({ type: "turn_end" }, {});
  assert.equal(puts.length, 1);
  assert.equal(sync.lastError(), null);
  assert.equal(puts[0].toString("utf8"), sessionJsonl);
});

test("a missing local session file is not a sync failure", async () => {
  const { store, puts } = fakeStore();
  const sync = createSessionSync({
    store,
    key: "sessions/inc-4.jsonl",
    sessionFile: () => join(tmpdir(), "bugboss-does-not-exist", "inc-4.jsonl"),
  });

  await sync.flush();
  assert.equal(puts.length, 0);
  assert.equal(sync.lastError(), null);
});

test("the stored prefix survives entries that are not ours", () => {
  const noisy = [
    JSON.stringify({ type: "custom", customType: "someone_else", data: { systemPrompt: 1 } }),
    "not json at all",
    sessionJsonl.split("\n")[1],
  ].join("\n");

  assert.deepEqual(readStoredPrefixFromJsonl(noisy), prefix);
  assert.equal(readStoredPrefixFromJsonl('{"type":"custom","customType":"bugboss_prompt"}'), null);
});
