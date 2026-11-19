import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { runChild } from "./run";
import type { ChildSpec } from "../protocol";

// The child's loop, in-process, against a mock provider.
//
// `spawn.test.ts` proves the *process* boundary with a real `node` and a real
// provider that fails for lack of a key. It cannot prove the loop: what the model
// does there is fixed. This file is the other half — the tool loop, the subagent
// channel, the step events and the structured answer — driven by a provider whose
// responses are scripted, so the mechanics the plan cares about are exercised
// rather than inferred.

const checkout = () => {
  const root = mkdtempSync(join(tmpdir(), "child-run-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "alpha\nbeta\n");
  return root;
};

const spec = (root: string, extra: Partial<ChildSpec> = {}): ChildSpec => ({
  model: "claude-opus-5-5",
  systemPrompt: "You are a test agent.",
  messages: [{ role: "user", content: "hi" }],
  root,
  allowedTools: ["Read"],
  guards: [{ kind: "paths", root }],
  maxSteps: 4,
  ...extra,
});

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

type Step = Record<string, unknown>;

const textStep = (text: string, input = 10, output = 5): Step => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: usage(input, output),
  warnings: [],
});

const toolStep = (calls: Array<{ id: string; name: string; input: unknown }>, input = 10, output = 5): Step => ({
  content: calls.map((c) => ({
    type: "tool-call",
    toolCallId: c.id,
    toolName: c.name,
    input: JSON.stringify(c.input),
  })),
  finishReason: { unified: "tool-calls", raw: "tool_use" },
  usage: usage(input, output),
  warnings: [],
});

/** A provider that returns each scripted step in turn. */
const scripted = (steps: Step[]) => {
  const model = new MockLanguageModelV3({ doGenerate: steps as never });
  return { provider: () => model, calls: () => model.doGenerateCalls.length };
};

test("the loop runs a tool, feeds the result back, and ends in the answer", async () => {
  // The whole point of S5: a tool list we write, a loop we drive. The model reads
  // a file through our Read tool, then answers — so the second step can only
  // succeed if the first step's result reached it.
  const root = checkout();
  const { provider, calls } = scripted([
    toolStep([{ id: "c1", name: "Read", input: { file_path: "src/a.ts" } }]),
    textStep("it starts with alpha"),
  ]);

  const result = await runChild(spec(root, { allowedTools: ["Read"] }), { provider });

  assert.equal(result.ok, true);
  assert.equal(result.output, "it starts with alpha");
  assert.equal(result.steps, 2);
  assert.equal(calls(), 2, "the loop made a second model call with the tool's result");
  // The tool ran for real: its answer is what the second step saw.
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].toolName, "Read");
  assert.match(result.toolCalls[0].result ?? "", /alpha/);
});

test("a subagent call is a request to the parent, and its answer is recorded", async () => {
  // A subagent has its own model and its own spend, so the child asks the parent
  // rather than calling `generateText` a second time. The answer has to come back
  // **paired with the call**: `step.toolCalls` carries input only, so a loop that
  // passed them through as-is left `recordSubagentCall` storing a subagent that
  // never reported, and `traceLeads` read an empty scout result on every eval run.
  const root = checkout();
  const requests: Array<{ name: string; prompt: string }> = [];
  const { provider } = scripted([
    toolStep([{ id: "c1", name: "Task", input: { subagent_type: "scout", prompt: "find leads" } }]),
    textStep("done"),
  ]);

  const result = await runChild(
    spec(root, {
      allowedTools: ["Task"],
      subagents: { scout: { description: "Lead finder", prompt: "find leads" } },
    }),
    {
      provider,
      askSubagent: async (request) => {
        requests.push({ name: request.name, prompt: request.prompt });
        return { type: "response", id: request.id, ok: true, output: "LEAD: src/a.ts" };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(requests, [{ name: "scout", prompt: "find leads" }]);
  const call = result.toolCalls.find((c) => c.toolName === "Task");
  assert.ok(call !== undefined, "the Task call is recorded");
  assert.equal(call.result, "LEAD: src/a.ts", "the subagent's answer is stored beside its call");
});

test("the step events a parent prices carry token counts and the tool's answer", async () => {
  // The parent's spend cap multiplies these counts by the price table, and its
  // `subagentCalls` record reads the tool results, so both have to survive the
  // event rather than only the returned result.
  const root = checkout();
  const seen: Array<{ inputTokens: number; toolCalls: Array<{ result?: string }> }> = [];
  const { provider } = scripted([
    toolStep([{ id: "c1", name: "Read", input: { file_path: "src/a.ts" } }], 100, 20),
    textStep("done", 200, 30),
  ]);

  const result = await runChild(spec(root), { provider, onStep: (event) => seen.push(event as never) });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].inputTokens, 100);
  assert.equal(seen[1].inputTokens, 200);
  assert.match(seen[0].toolCalls[0].result ?? "", /alpha/);
  // The run's own totals are the sum, not the last step's.
  assert.equal(result.usage.inputTokens, 300);
  assert.equal(result.usage.outputTokens, 50);
});

test("a structured ask returns the object and keeps the conversation", async () => {
  // The one mechanic the plan says does not dissolve: the run both calls tools and
  // ends in an object. The conversation comes back so a repair turn can continue
  // it — there is no session id to resume under this SDK.
  const root = checkout();
  const { provider } = scripted([
    textStep(JSON.stringify({ status: "complete", findings: [], summary: "clean" })),
  ]);

  const result = await runChild(
    spec(root, { output: { schema: { type: "object", properties: { status: { type: "string" } } } } }),
    { provider },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.structuredOutput, { status: "complete", findings: [], summary: "clean" });
  assert.ok(result.messages.length > 0, "the conversation is carried for a repair turn");
});

test("a provider failure comes back as a value, not a rejection", async () => {
  // A failure is a result: an abort and a cap are both normal outcomes, and the
  // parent turns them into a failed review rather than a crash.
  const root = checkout();
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("the provider said no");
    },
  });

  const result = await runChild(spec(root), { provider: () => model });

  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /provider said no/);
});
