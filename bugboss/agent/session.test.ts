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
  sumSessionUsage,
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
  assert.ok(objects.has("sessions/incident/inc-1/session.jsonl"));

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

  // A dropped sync failure is a lost investigation: the next restart restores
  // nothing and the agent starts over. The extension has to report it.
  const failures: Array<{ error: string; streak: number }> = [];
  sessionSyncExtension(sync, (error, streak) =>
    failures.push({ error: error.message, streak }),
  )(pi);
  assert.ok(handlers.turn_end);
  assert.ok(handlers.session_shutdown);

  await handlers.turn_end({ type: "turn_end" }, {});
  assert.equal(puts.length, 0);
  assert.match(String(sync.lastError()), /s3 is having a day/);
  assert.deepEqual(failures, [{ error: "s3 is having a day", streak: 1 }]);

  await handlers.turn_end({ type: "turn_end" }, {});
  assert.equal(puts.length, 1);
  assert.equal(sync.lastError(), null);
  assert.equal(puts[0].toString("utf8"), sessionJsonl);
  assert.equal(failures.length, 1, "a successful flush is not reported");
});

test("consecutive sync failures are counted, and a success resets the count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bugboss-streak-"));
  const file = join(dir, "inc-5.jsonl");
  await writeFile(file, sessionJsonl);

  let fail = true;
  const sync = createSessionSync({
    store: {
      get: async () => null,
      put: async () => {
        if (fail) throw new Error("no such bucket");
      },
    },
    key: sessionKeyFor("inc-5"),
    sessionFile: () => file,
  });

  await sync.flush();
  assert.equal(sync.failureStreak(), 1);
  await sync.flush();
  assert.equal(sync.failureStreak(), 2);

  fail = false;
  await sync.flush();
  assert.equal(sync.failureStreak(), 0);
  assert.equal(sync.lastError(), null);
});

test("the session key is the layout every reader uses", () => {
  assert.equal(sessionKeyFor("inc-1"), "sessions/incident/inc-1/session.jsonl");
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

// --- usage ------------------------------------------------------------------

/**
 * The entry shapes below are copied from a real incident's session file, not
 * invented. The bug these cover was a reader that looked for `usage` at the
 * top level of every line, which is where Pi puts it for exactly the two
 * out-of-band entry kinds and nowhere near where it puts the turns.
 */
const assistantTurn = (usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}) =>
  JSON.stringify({
    type: "message",
    id: "e1096a41",
    parentId: "46232123",
    timestamp: "2026-09-27T18:37:57.427Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I'll start by reading the incident." }],
      api: "bedrock-invoke-model",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-5",
      usage: { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite },
      stopReason: "toolUse",
    },
  });

const modelChange = JSON.stringify({
  type: "model_change",
  id: "6d71ac4a",
  timestamp: "2026-09-27T18:37:57.419Z",
  provider: "amazon-bedrock",
  modelId: "us.anthropic.claude-opus-5",
});

const toolResult = JSON.stringify({
  type: "message",
  message: { role: "toolResult", toolName: "get_incident", content: "{}", isError: false },
});

test("a real transcript's turns are counted, nested where Pi actually writes them", () => {
  const contents = [
    JSON.stringify({ type: "session", version: 3, id: "6" }),
    modelChange,
    assistantTurn({ input: 2, output: 39, cacheRead: 0, cacheWrite: 78_492 }),
    toolResult,
    assistantTurn({ input: 4, output: 1_200, cacheRead: 78_492, cacheWrite: 900 }),
    toolResult,
  ].join("\n");

  const usage = sumSessionUsage(contents);

  assert.equal(usage.tokensIn, 6);
  assert.equal(usage.tokensOut, 1_239);
  assert.equal(usage.cacheWrite, 79_392);
  assert.equal(usage.turns, 2, "only assistant messages are turns");
  assert.equal(usage.modelId, "us.anthropic.claude-opus-5");
  // The one that pays for the run. A long agent is mostly cache reads, so a
  // reader that got the totals right and this wrong would still be useless.
  assert.equal(usage.cacheRead, 78_492);
});

test("out-of-band billed calls are spend too", () => {
  const contents = [
    // Compaction's own summarization call, and a cache warm. Neither is a
    // turn, both are on the invoice.
    JSON.stringify({
      type: "compaction",
      summary: "…",
      firstKeptEntryId: "abc",
      tokensBefore: 400_000,
      usage: { input: 10, output: 2_000, cacheRead: 300_000, cacheWrite: 0 },
    }),
    JSON.stringify({
      type: "usage",
      kind: "cache_warm",
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-opus-5",
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 50_000 },
    }),
    assistantTurn({ input: 2, output: 39, cacheRead: 1_000, cacheWrite: 0 }),
  ].join("\n");

  const usage = sumSessionUsage(contents);

  assert.equal(usage.tokensIn, 13);
  assert.equal(usage.tokensOut, 2_039);
  assert.equal(usage.cacheRead, 301_000);
  assert.equal(usage.cacheWrite, 50_000);
  assert.equal(usage.turns, 1, "a compaction or a warm is billed but is not a turn");
});

test("a resumed incident counts every launch once", () => {
  const firstLaunch = [modelChange, assistantTurn({ input: 2, output: 39, cacheRead: 0, cacheWrite: 78_492 })];
  const secondLaunch = [assistantTurn({ input: 3, output: 41, cacheRead: 78_492, cacheWrite: 0 })];

  // A relaunch reopens the restored file and appends, so the object the Boss
  // reads after the second launch holds both. Totals are absolute for that
  // reason: adding onto the stored row would count the first launch twice.
  const afterFirst = sumSessionUsage(firstLaunch.join("\n"));
  const afterSecond = sumSessionUsage([...firstLaunch, ...secondLaunch].join("\n"));

  assert.equal(afterFirst.cacheRead, 0);
  assert.equal(afterSecond.cacheRead, 78_492);
  assert.equal(afterSecond.tokensIn, 5);
  assert.equal(afterSecond.turns, 2);
  assert.deepEqual(
    sumSessionUsage([...firstLaunch, ...secondLaunch].join("\n")),
    afterSecond,
    "re-reading the same file is idempotent, which is what makes the absolute write safe",
  );
});

test("turns are counted even when a turn reports no usage", () => {
  const contents = [
    modelChange,
    JSON.stringify({ type: "message", message: { role: "assistant", content: [], model: "us.anthropic.claude-opus-5" } }),
  ].join("\n");

  const usage = sumSessionUsage(contents);

  // This pair — turns above zero, tokens at zero — is what the Boss alarms
  // on. Without the turn count a broken reader is indistinguishable from a
  // run that genuinely did nothing.
  assert.equal(usage.turns, 1);
  assert.equal(usage.tokensIn + usage.tokensOut + usage.cacheRead + usage.cacheWrite, 0);
});

test("a torn last line does not cost the lines before it", () => {
  const contents = `${assistantTurn({ input: 2, output: 39, cacheRead: 5_000, cacheWrite: 0 })}\n{"type":"mess`;

  const usage = sumSessionUsage(contents);

  assert.equal(usage.cacheRead, 5_000);
  assert.equal(usage.turns, 1);
});
