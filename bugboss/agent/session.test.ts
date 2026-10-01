import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  EXIT_ENTRY_TYPE,
  PROMPT_ENTRY_TYPE,
  createS3SessionStore,
  createSessionSync,
  readStoredPrefixFromFile,
  readStoredPrefixFromJsonl,
  restoreSessionFile,
  sessionKeyFor,
  sessionSyncExtension,
  sumSessionUsage,
  describeOutcome,
  readSessionOutcome,
  lastSessionEventAt,
  type SessionStore,
  type StoredExit,
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
  cacheWrite1h?: number;
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

test("the 1h share of a cache write is summed, because it does not price like the rest", () => {
  // Every run here asks for the 1h ttl, and a 1h write costs 2x base input
  // against 1.25x for 5m. A row that stored only the total would re-price a
  // long-cache run as a short-cache one and understate it by most of the gap,
  // which is the whole reason dollars are not stored in the first place.
  const contents = [
    modelChange,
    assistantTurn({ input: 2, output: 39, cacheRead: 0, cacheWrite: 78_492, cacheWrite1h: 78_492 }),
    assistantTurn({ input: 4, output: 12, cacheRead: 78_492, cacheWrite: 1_200, cacheWrite1h: 900 }),
    // A turn Bedrock returned no split for. Absent is not zero-and-fine, but
    // summing it as zero is the only honest thing a reader can do with it.
    assistantTurn({ input: 1, output: 3, cacheRead: 79_692, cacheWrite: 500 }),
  ].join("\n");

  const usage = sumSessionUsage(contents);

  assert.equal(usage.cacheWrite, 80_192);
  assert.equal(usage.cacheWrite1h, 79_392);
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

// ---------------------------------------------------------------------------
// The exit record
// ---------------------------------------------------------------------------

const exitTurn = (text: string) =>
  JSON.stringify({ type: "message", message: { role: "assistant", content: text } });

const exitToolResult = (text: string) =>
  JSON.stringify({ type: "tool_result", content: text });

const exitLine = (exit: Partial<StoredExit> = {}) =>
  JSON.stringify({
    type: "custom",
    customType: EXIT_ENTRY_TYPE,
    data: { reason: "completed", at: 1, attempt: 1, ...exit } satisfies StoredExit,
  });

test("a run that ended on purpose says so", () => {
  const outcome = readSessionOutcome(
    [exitTurn("working"), exitToolResult("done"), exitLine({ reason: "completed" })].join("\n"),
  );
  assert.equal(outcome.kind, "ended");
  assert.equal(outcome.kind === "ended" && outcome.exit.reason, "completed");
});

// The whole point of the record. A killed run's file ends on an ordinary
// event, exactly like a finished one's did before this existed, and three of
// seven real runs died that way without anybody being able to tell.
test("a run killed mid-turn is not mistaken for one that finished", () => {
  const outcome = readSessionOutcome([exitTurn("working"), exitToolResult("done")].join("\n"));
  assert.equal(outcome.kind, "killed");
  assert.equal(outcome.kind === "killed" && outcome.turns, 1);
});

// The resume case, and the one a last-record-wins reader gets wrong: every
// launch writes its own record, so a restored file carries an older one under
// the turns that followed it.
test("an exit record with a later turn after it is a killed run, not an ended one", () => {
  const outcome = readSessionOutcome(
    [
      exitTurn("first launch"),
      exitLine({ reason: "signal", signal: "SIGTERM" }),
      exitTurn("second launch"),
      exitToolResult("still going"),
    ].join("\n"),
  );
  assert.equal(outcome.kind, "killed");
  assert.equal(outcome.kind === "killed" && outcome.turns, 2);
});

test("a resumed run that then ended cleanly reports the newer record", () => {
  const outcome = readSessionOutcome(
    [
      exitTurn("first launch"),
      exitLine({ reason: "signal", signal: "SIGTERM", attempt: 1 }),
      exitTurn("second launch"),
      exitLine({ reason: "completed", attempt: 2 }),
    ].join("\n"),
  );
  assert.equal(outcome.kind, "ended");
  assert.equal(outcome.kind === "ended" && outcome.exit.attempt, 2);
});

// A child killed before its first turn synced has lost nothing, and calling
// that a killed run would put an alarm on every crash at boot.
test("a session with nothing in it is empty rather than killed", () => {
  assert.equal(readSessionOutcome("").kind, "empty");
  assert.equal(readSessionOutcome("\n  \n").kind, "empty");
});

// A kill mid-write leaves a torn last line. That is evidence of a kill, not
// a parse problem to skip past.
test("a torn last line counts as a run that carried on past its last record", () => {
  const outcome = readSessionOutcome(
    [exitTurn("working"), exitLine(), '{"type":"message","mess'].join("\n"),
  );
  assert.equal(outcome.kind, "killed");
});

test("a malformed exit record is not trusted as an ending", () => {
  const outcome = readSessionOutcome(
    [
      exitTurn("working"),
      JSON.stringify({ type: "custom", customType: EXIT_ENTRY_TYPE, data: { reason: "nope" } }),
    ].join("\n"),
  );
  assert.equal(outcome.kind, "killed");
});

test("describeOutcome says which of the three it is", () => {
  assert.match(describeOutcome({ kind: "killed", turns: 4 }), /killed after 4 turns/);
  assert.match(
    describeOutcome({ kind: "ended", exit: { reason: "timed_out", at: 1, attempt: 1 } }),
    /ended on purpose \(timed_out\)/,
  );
  assert.match(describeOutcome({ kind: "empty" }), /before its first turn/);
});

test("lastSessionEventAt is the newest stamp in the file, whatever order it is in", () => {
  const contents = [
    JSON.stringify({ type: "session", id: "s", timestamp: "2026-09-29T21:30:00.000Z" }),
    JSON.stringify({ type: "message", id: "a", timestamp: "2026-09-30T02:04:10.000Z" }),
    JSON.stringify({ type: "message", id: "b", timestamp: "2026-09-30T01:56:00.000Z" }),
    '{"type":"message","id":"c","timestamp":"2026-09-30T02:0',
  ].join("\n");
  assert.equal(lastSessionEventAt(contents), Date.parse("2026-09-30T02:04:10.000Z"));
});

test("lastSessionEventAt is null for a file with no readable stamp", () => {
  assert.equal(lastSessionEventAt(""), null);
  assert.equal(lastSessionEventAt(JSON.stringify({ type: "message" })), null);
});

test("a session PUT that never answers fails the sync instead of freezing turn_end", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "bugboss-hung-"));
  const file = join(dir, "inc-100.jsonl");
  await writeFile(file, sessionJsonl);

  // The stalled socket: no answer until the deadline aborts it.
  const client = {
    send: (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
      new Promise((_, reject) => {
        options?.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason));
      }),
  };
  const store = createS3SessionStore("bugboss-test", "us-west-2", { client, timeoutMs: 50 });
  const sync = createSessionSync({ store, key: "sessions/inc-100.jsonl", sessionFile: () => file });
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[event] = handler;
      return () => {};
    },
  } as unknown as ExtensionAPI;
  const failures: number[] = [];
  sessionSyncExtension(sync, (_error, streak) => failures.push(streak))(pi);

  // AbortSignal.timeout does not hold the event loop open on its own.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const started = Date.now();
    await handlers.turn_end({ type: "turn_end" }, {});
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(failures, [1]);
    assert.ok(sync.lastError());
  } finally {
    clearInterval(keepAlive);
  }
});
