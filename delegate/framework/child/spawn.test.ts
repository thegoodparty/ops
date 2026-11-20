import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEntry, childExecArgv, spawnChild } from "./spawn";
import { ChildSpecSchema, parseChildEvent, parseParentResponse } from "../protocol";
import type { ChildSpec } from "../protocol";

// The spawned child, for real.
//
// Every other test in this tree calls `runChild` in-process with a mock provider,
// which proves the loop and the tools but says nothing about the thing this step
// actually introduced: a separate process, holding the allowlisted environment,
// receiving a spec on stdin and answering on stdout. So these spawn `main.ts` with
// `node` and assert on what comes back — including, deliberately, a child that
// fails for **lack of a credential**, because that is the one failure a mocked
// provider can never reproduce and the one that proves the provider was reached
// with the environment that was sent.

const checkout = () => {
  const root = mkdtempSync(join(tmpdir(), "spawn-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "alpha\n");
  return root;
};

const spec = (root: string): ChildSpec => ({
  model: "claude-opus-5-5",
  systemPrompt: "You are a test agent.",
  messages: [{ role: "user", content: "hi" }],
  root,
  allowedTools: ["Read"],
  guards: [{ kind: "paths", root }],
  maxSteps: 2,
});

/** The environment a test sends: enough to start node, and one obviously fake key. */
const env = (extra: Record<string, string | undefined> = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...extra,
});

test("childEntry resolves a file that exists under both layouts", () => {
  // `tsx` over the source tree (every test run) and the compiled worker image are
  // different extensions for the same entry. A wrong guess is an exit-1 the parent
  // can only report as stderr, so it is resolved by looking.
  assert.match(childEntry(), /main\.(ts|js)$/);
});

test("childExecArgv keeps the loader flags and drops the test runner's", () => {
  // Under `tsx` the child needs the same `--require`/`--import` pair the parent
  // has, or it cannot resolve a `.ts` entry at all. The test runner's own flags
  // must not travel: a child that started a second `--test` would hang.
  const argv = childExecArgv([
    "--require",
    "/x/preflight.cjs",
    "--import",
    "file:///x/loader.mjs",
    "--test",
    "--test-reporter=spec",
    "--watch",
    "--inspect=0",
  ]);
  assert.deepEqual(argv, ["--require", "/x/preflight.cjs", "--import", "file:///x/loader.mjs"]);
});

test("a spawned child runs, reaches the provider, and reports its failure as a result", async () => {
  // **The runtime verification.** No `ANTHROPIC_API_KEY` crosses, so the provider
  // refuses and the child reports `AI_LoadAPIKeyError` — which means: the process
  // started, the loader resolved the TypeScript entry, the spec parsed, the AI SDK
  // provider was constructed and consulted the environment, and a structured
  // `ChildResult` came back over stdout. Nothing here needs a real key or a real
  // model, and a mocked provider could not exercise any of it.
  const root = checkout();
  const result = await spawnChild(spec(root), { env: env() });

  assert.equal(result.ok, false);
  assert.equal(result.errorName, "AI_LoadAPIKeyError");
  assert.match(result.error, /ANTHROPIC_API_KEY/);
  // The failure carries the conversation, so the parent still knows what it asked.
  assert.deepEqual(result.messages, spec(root).messages);
});

test("a child with a key that is not a key gets as far as the API", async () => {
  // One step further than the test above: with a syntactically present key the
  // provider builds a request and the API rejects it. That proves the key crossed
  // the process boundary through the env that was sent, and that the failure is
  // still a `ChildResult` rather than a thrown error or a hang.
  const root = checkout();
  const result = await spawnChild(spec(root), {
    env: env({ ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" }),
    timeoutMs: 60_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorName, "AI_APICallError");
});

test("the child exits when it has answered, rather than holding the pipe open", async () => {
  // The reader on stdin stays open for subagent responses, so a child that never
  // exited would leave the parent waiting on a `close` that cannot come — the
  // parent would hit the timeout instead of reading an answer. Resolving at all is
  // the property; this pins it with a timeout short enough to fail by name.
  const root = checkout();
  const result = await spawnChild(spec(root), { env: env(), timeoutMs: 45_000 });
  assert.equal(result.ok, false);
  assert.notEqual(
    (result as { errorName?: string }).errorName,
    "Timeout",
    "the child did not exit on its own",
  );
});

test("an aborted run comes back as a failure, not a rejection", async () => {
  // An abort is a normal outcome of a spend or step cap, so it has to be a value.
  const root = checkout();
  const controller = new AbortController();
  controller.abort();
  const result = await spawnChild(spec(root), { env: env(), signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.errorName, "Aborted");
});

test("a child that dies without an answer reports what stderr said", async () => {
  // The parent cannot see the child's exception, only its exit and its stderr, so
  // a run that crashed has to surface that text rather than a bare code.
  const root = checkout();
  const result = await spawnChild(spec(root), {
    env: env(),
    // A file that is not the entry, to get a module error rather than a run.
    command: { file: join(root, "does-not-exist.js"), execArgv: [] },
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /without an answer/);
  assert.match(result.error, /Cannot find module|does-not-exist/);
});

test("the spec is validated at the child end, so a malformed one fails loudly", () => {
  assert.equal(ChildSpecSchema.safeParse({}).success, false);
  assert.equal(ChildSpecSchema.safeParse({ ...spec("/tmp"), maxSteps: 0 }).success, false);
  assert.equal(ChildSpecSchema.safeParse(spec("/tmp")).success, true);
});

test("the protocol parsers ignore what they do not recognise", () => {
  // A stray `console.log` in the child must not be mistaken for an event, and a
  // truncated line must not throw: both would turn a readable failure into a
  // protocol error.
  assert.equal(parseChildEvent(""), undefined);
  assert.equal(parseChildEvent("not json"), undefined);
  assert.equal(parseChildEvent('{"type":"noise"}'), undefined);
  assert.equal(parseChildEvent('{"type":"result","result":{"ok":true}}')?.type, "result");
  assert.equal(parseParentResponse('{"type":"noise"}'), undefined);
  assert.equal(parseParentResponse('{"type":"response","id":1,"ok":true,"output":"x"}')?.type, "response");
});
