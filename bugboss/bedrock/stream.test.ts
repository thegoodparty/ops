import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage, AssistantMessageEvent, JsonObject } from "@earendil-works/pi-ai";

import { type AnthropicStreamEvent, consumeAnthropicStream, mapStopReason } from "./stream";
import { BEDROCK_INVOKE_MODEL_API } from "./options";

const newOutput = (): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: BEDROCK_INVOKE_MODEL_API,
  provider: "amazon-bedrock",
  model: "us.anthropic.claude-opus-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "pending",
  timestamp: 0,
});

const run = async (events: AnthropicStreamEvent[], signal?: AbortSignal) => {
  const output = newOutput();
  const pushed: AssistantMessageEvent[] = [];
  let costCalls = 0;
  await consumeAnthropicStream({
    events: (async function* () {
      for (const event of events) yield event;
    })(),
    output,
    push: (event) => pushed.push(event),
    applyCost: () => {
      costCalls++;
      output.usage.cost.total = output.usage.totalTokens * 0.000001;
    },
    parseJson: (partial): JsonObject => {
      try {
        return JSON.parse(partial) as JsonObject;
      } catch {
        return {};
      }
    },
    signal,
  });
  return { output, pushed, costCalls };
};

const messageStart: AnthropicStreamEvent = {
  type: "message_start",
  message: { id: "msg_1", model: "us.anthropic.claude-opus-5", usage: { input_tokens: 10 } },
};

const stopped = (reason = "end_turn"): AnthropicStreamEvent[] => [
  { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
];

test("a thinking block whose text stays empty keeps its signature", async () => {
  // Signature arrives as its own delta after zero thinking deltas. This is the
  // Opus 5 / Sonnet 5 adaptive shape the Converse path throws away.
  const { output, pushed } = await run([
    messageStart,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "ErUB" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "CkYI" } },
    { type: "content_block_stop", index: 0 },
    ...stopped(),
  ]);

  assert.deepEqual(output.content[0], {
    type: "thinking",
    thinking: "",
    thinkingSignature: "ErUBCkYI",
  });
  assert.equal(pushed.filter((e) => e.type === "thinking_start").length, 1);
  assert.equal(pushed.filter((e) => e.type === "thinking_end").length, 1);
});

test("thinking deltas accumulate alongside the signature", async () => {
  const { output } = await run([
    messageStart,
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step " } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "one" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    ...stopped(),
  ]);

  assert.equal(output.content[0].type === "thinking" && output.content[0].thinking, "step one");
  assert.equal(
    output.content[0].type === "thinking" && output.content[0].thinkingSignature,
    "sig",
  );
});

test("redacted thinking is marked and keeps its opaque payload", async () => {
  const { output } = await run([
    messageStart,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "encrypted" },
    },
    { type: "content_block_stop", index: 0 },
    ...stopped(),
  ]);

  assert.deepEqual(output.content[0], {
    type: "thinking",
    thinking: "[Reasoning redacted]",
    thinkingSignature: "encrypted",
    redacted: true,
  });
});

test("text and tool calls stream through with their Pi events", async () => {
  const { output, pushed } = await run([
    messageStart,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "looking" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "query_logs" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"q":' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"500s"}' },
    },
    { type: "content_block_stop", index: 1 },
    ...stopped("tool_use"),
  ]);

  assert.equal(output.content[0].type === "text" && output.content[0].text, "looking");
  assert.deepEqual(output.content[1], {
    type: "toolCall",
    id: "toolu_1",
    name: "query_logs",
    arguments: { q: "500s" },
  });
  assert.equal(output.stopReason, "toolUse");
  assert.deepEqual(
    pushed.map((e) => e.type),
    [
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
    ],
  );
});

test("usage carries every field the Boss derives cost from", async () => {
  const { output, costCalls } = await run([
    {
      type: "message_start",
      message: {
        id: "msg_2",
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 40000,
          cache_creation_input_tokens: 900,
          cache_creation: { ephemeral_1h_input_tokens: 300 },
        },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 250, output_tokens_details: { thinking_tokens: 180 } },
    },
    { type: "message_stop" },
  ]);

  assert.equal(output.usage.input, 120);
  assert.equal(output.usage.output, 250);
  assert.equal(output.usage.cacheRead, 40000);
  assert.equal(output.usage.cacheWrite, 900);
  assert.equal(output.usage.cacheWrite1h, 300);
  assert.equal(output.usage.reasoning, 180);
  assert.equal(output.usage.totalTokens, 120 + 250 + 40000 + 900);
  assert.ok(costCalls >= 2);
  assert.ok(output.usage.cost.total > 0);
});

test("bedrock invocation metrics only backstop a stream that reported nothing", async () => {
  const { output } = await run([
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    {
      type: "message_stop",
      "amazon-bedrock-invocationMetrics": { inputTokenCount: 55, outputTokenCount: 12 },
    },
  ]);

  assert.equal(output.usage.input, 55);
  assert.equal(output.usage.output, 12);
  assert.equal(output.usage.totalTokens, 67);
});

test("reported usage is never overwritten by the bedrock metrics", async () => {
  const { output } = await run([
    messageStart,
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    {
      type: "message_stop",
      "amazon-bedrock-invocationMetrics": { inputTokenCount: 999, outputTokenCount: 999 },
    },
  ]);

  assert.equal(output.usage.input, 10);
  assert.equal(output.usage.output, 7);
});

test("stop reasons map onto Pi's vocabulary", () => {
  assert.deepEqual(mapStopReason("end_turn"), { stopReason: "stop" });
  assert.deepEqual(mapStopReason("pause_turn"), { stopReason: "stop" });
  assert.deepEqual(mapStopReason("max_tokens"), { stopReason: "length" });
  assert.deepEqual(mapStopReason("tool_use"), { stopReason: "toolUse" });
  assert.equal(mapStopReason("refusal").stopReason, "error");
  assert.equal(mapStopReason("something_new").stopReason, "error");
});

test("a refusal fails the turn", async () => {
  await assert.rejects(
    run([messageStart, { type: "message_delta", delta: { stop_reason: "refusal" } }]),
    /refused/,
  );
});

test("an error event fails the turn", async () => {
  await assert.rejects(
    run([messageStart, { type: "error", error: { message: "throttled" } }]),
    /throttled/,
  );
});

test("a stream that ends without a stop reason fails rather than looking complete", async () => {
  await assert.rejects(run([messageStart]), /ended before message_stop/);
});

test("an aborted request fails even mid-stream", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run([messageStart], controller.signal), /aborted/);
});

test("start is emitted even when a provider skips message_start", async () => {
  const { pushed } = await run([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    ...stopped(),
  ]);

  assert.equal(pushed[0].type, "start");
});
