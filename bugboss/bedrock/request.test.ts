import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";

import { buildInvokeModelBody, convertMessages, resolveCacheControl } from "./request";
import { resolveCacheRetention } from "./options";
import { BEDROCK_INVOKE_MODEL_API, type BedrockInvokeModelApi } from "./options";

const model: Model<BedrockInvokeModelApi> = {
  id: "us.anthropic.claude-opus-5",
  name: "Claude Opus 5",
  api: BEDROCK_INVOKE_MODEL_API,
  provider: "amazon-bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
  contextWindow: 1000000,
  maxTokens: 128000,
};

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: BEDROCK_INVOKE_MODEL_API,
  provider: "amazon-bedrock",
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

const build = (messages: Message[], options = {}) =>
  buildInvokeModelBody({
    model,
    messages,
    initialSystemMessage: undefined,
    systemText: "",
    tools: [],
    options,
  });

test("a thinking block with an empty text but a signature survives verbatim", () => {
  // The Opus 5 / Sonnet 5 adaptive shape. Converse drops this block entirely
  // (bedrock-converse-stream.ts:1022), which is why this provider exists.
  const body = build([
    assistant([
      { type: "thinking", thinking: "", thinkingSignature: "ErUBCkYIBRgCIkD" },
      { type: "text", text: "done" },
    ]),
  ]);

  assert.deepEqual(body.messages[0].content[0], {
    type: "thinking",
    thinking: "",
    signature: "ErUBCkYIBRgCIkD",
  });
});

test("a whitespace-only thinking block with a signature also survives", () => {
  const body = build([
    assistant([{ type: "thinking", thinking: "   \n ", thinkingSignature: "sig-1" }]),
  ]);

  assert.equal(body.messages[0].content.length, 1);
  assert.equal(body.messages[0].content[0].type, "thinking");
});

test("a redacted thinking block replays as redacted_thinking, not thinking", () => {
  const body = build([
    assistant([
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "encrypted-payload",
        redacted: true,
      },
    ]),
  ]);

  assert.deepEqual(body.messages[0].content[0], {
    type: "redacted_thinking",
    data: "encrypted-payload",
  });
});

test("a thinking block with no signature degrades to text rather than 400ing", () => {
  const body = build([assistant([{ type: "thinking", thinking: "half a thought" }])]);

  assert.deepEqual(body.messages[0].content[0], { type: "text", text: "half a thought" });
});

test("a thinking block with neither text nor signature is dropped", () => {
  const body = build([
    assistant([
      { type: "thinking", thinking: "", thinkingSignature: "" },
      { type: "text", text: "kept" },
    ]),
  ]);

  assert.equal(body.messages[0].content.length, 1);
  assert.equal(body.messages[0].content[0].type, "text");
});

test("adaptive thinking is sent with output_config and never budget_tokens", () => {
  const body = build([], { effort: "high" });

  assert.deepEqual(body.thinking, {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.equal("budget_tokens" in (body.thinking ?? {}), false);
});

test("prefixMismatchBehavior: error drops the block_binding", () => {
  const body = build([], { prefixMismatchBehavior: "error" });
  assert.equal(body.thinking?.block_binding, undefined);
});

// Every field here is rejected outright by Bedrock InvokeModel unless the beta
// beside it is in `anthropic_beta`. Verified against a live call on
// us.anthropic.claude-opus-5 (us-west-2, 2026-09-28): with the beta the request
// is accepted, without it the whole request is a ValidationException reading
// `thinking.adaptive.block_binding: Extra inputs are not permitted`. Bedrock
// also validates the beta list, so a name that stops being real fails loudly.
const GATED_THINKING_FIELDS: Record<string, string> = {
  block_binding: "thinking-binding-controls-2026-08-01",
};

test("a gated thinking field is never sent without the beta that makes it legal", () => {
  // The suite was green while prod died on every launch, because one test
  // asserted block_binding IS in the body and nothing asserted the half that
  // makes Bedrock accept it. This walks the option matrix and holds the pairing.
  const cases = [
    {},
    { effort: "high" },
    { thinkingDisplay: "omitted" },
    { prefixMismatchBehavior: "drop_block" },
    { prefixMismatchBehavior: "error" },
    { betas: ["context-management-2025-06-27"] },
    { thinkingEnabled: false },
  ];

  for (const options of cases) {
    const body = build([], options);
    const sent = body.anthropic_beta ?? [];
    for (const [field, beta] of Object.entries(GATED_THINKING_FIELDS)) {
      if (body.thinking && field in body.thinking) {
        assert.ok(
          sent.includes(beta),
          `options ${JSON.stringify(options)} sent thinking.${field} without ${beta}`,
        );
      }
    }
  }
});

test("a caller's own betas survive alongside the binding beta, exactly once", () => {
  const body = build([], {
    betas: ["context-management-2025-06-27", "thinking-binding-controls-2026-08-01"],
  });

  assert.deepEqual(body.anthropic_beta, [
    "context-management-2025-06-27",
    "thinking-binding-controls-2026-08-01",
  ]);
});

test("no thinking config means no binding beta", () => {
  const body = build([], { thinkingEnabled: false });
  assert.equal(body.anthropic_beta, undefined);
});

test("thinkingEnabled: false sends no thinking config and allows temperature", () => {
  const body = build([], { thinkingEnabled: false, temperature: 0.4 });

  assert.equal(body.thinking, undefined);
  assert.equal(body.temperature, 0.4);
});

test("temperature is suppressed while thinking is on", () => {
  const body = build([], { temperature: 0.4 });
  assert.equal(body.temperature, undefined);
});

test("the body carries the bedrock anthropic_version and no model field", () => {
  const body = build([]);
  assert.equal(body.anthropic_version, "bedrock-2023-05-31");
  assert.equal("model" in body, false);
  assert.equal(body.max_tokens, model.maxTokens);
});

test("consecutive tool results are coalesced into one user message", () => {
  const messages: Message[] = [
    assistant([
      { type: "toolCall", id: "t1", name: "logs", arguments: { q: "a" } },
      { type: "toolCall", id: "t2", name: "traces", arguments: {} },
    ]),
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "logs",
      content: [{ type: "text", text: "line one" }],
      isError: false,
      timestamp: 0,
    },
    {
      role: "toolResult",
      toolCallId: "t2",
      toolName: "traces",
      content: [{ type: "text", text: "boom" }],
      isError: true,
      timestamp: 0,
    },
  ];

  const body = build(messages);

  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].role, "user");
  assert.equal(body.messages[1].content.length, 2);
  assert.deepEqual(body.messages[1].content[1], {
    type: "tool_result",
    tool_use_id: "t2",
    content: [{ type: "text", text: "boom" }],
    is_error: true,
    cache_control: { type: "ephemeral", ttl: "1h" },
  });
});

test("a trailing assistant turn gets no cache breakpoint", () => {
  const body = build([assistant([{ type: "text", text: "thinking out loud" }])]);
  const block = body.messages[0].content[0];
  assert.equal(block.type === "text" && block.cache_control, undefined);
});

test("an empty tool result still carries content", () => {
  const body = build([
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "logs",
      content: [{ type: "text", text: "   " }],
      isError: false,
      timestamp: 0,
    },
  ]);

  const block = body.messages[0].content[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.type === "tool_result" && block.content.length, 1);
});

test("system text and tools carry a cache breakpoint", () => {
  const tools: Tool[] = [
    {
      name: "get_incident",
      description: "read the incident",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    } as unknown as Tool,
  ];

  const body = buildInvokeModelBody({
    model,
    messages: [{ role: "user", content: "what broke", timestamp: 0 }],
    initialSystemMessage: undefined,
    systemText: "You are the incident agent.",
    tools,
    options: {},
  });

  assert.deepEqual(body.system, [
    {
      type: "text",
      text: "You are the incident agent.",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
  ]);
  assert.deepEqual(body.tools?.[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(body.tools?.[0].input_schema, {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });
});

test("long retention asks for the 1h cache ttl", () => {
  assert.deepEqual(resolveCacheControl("long"), { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(resolveCacheControl("short"), { type: "ephemeral" });
  assert.equal(resolveCacheControl("none"), undefined);
});

// The regression these pin is the one that cost $7.53 on incident 1: a body
// built with no explicit retention asked for the 5m tier, and every blocking
// wait longer than five minutes rebuilt the whole prefix. Asserting the ttl on
// each of the three breakpoints separately is deliberate -- a default that
// reached the system prompt but not the conversation tail would still rewrite
// the expensive part on every miss.
test("a body built with no explicit retention asks for the 1h ttl everywhere", () => {
  const tools: Tool[] = [
    {
      name: "monitor",
      description: "wait for something to change",
      parameters: { type: "object", properties: {}, required: [] },
    } as unknown as Tool,
  ];

  const body = buildInvokeModelBody({
    model,
    messages: [{ role: "user", content: "why are we 500ing", timestamp: 0 }],
    initialSystemMessage: undefined,
    systemText: "You are the incident agent.",
    tools,
    options: {},
  });

  const expected = { type: "ephemeral", ttl: "1h" };
  assert.deepEqual(body.system?.[0].cache_control, expected);
  assert.deepEqual(body.tools?.[body.tools.length - 1].cache_control, expected);
  const tail = body.messages[body.messages.length - 1];
  const tailBlock = tail.content[tail.content.length - 1];
  assert.equal(tailBlock.type, "text");
  assert.deepEqual(tailBlock.type === "text" ? tailBlock.cache_control : undefined, expected);
});

test("resolveCacheRetention defaults to long and yields to an explicit choice", () => {
  assert.equal(resolveCacheRetention({}), "long");
  assert.equal(resolveCacheRetention({ cacheRetention: "short" }), "short");
  assert.equal(resolveCacheRetention({ cacheRetention: "none" }), "none");
});

test("an explicit short retention still gets the 5m ttl", () => {
  const body = buildInvokeModelBody({
    model,
    messages: [{ role: "user", content: "why are we 500ing", timestamp: 0 }],
    initialSystemMessage: undefined,
    systemText: "You are the incident agent.",
    tools: [],
    options: { cacheRetention: "short" },
  });

  assert.deepEqual(body.system?.[0].cache_control, { type: "ephemeral" });
});

test("an explicit none retention sets no breakpoint at all", () => {
  const body = buildInvokeModelBody({
    model,
    messages: [{ role: "user", content: "why are we 500ing", timestamp: 0 }],
    initialSystemMessage: undefined,
    systemText: "You are the incident agent.",
    tools: [],
    options: { cacheRetention: "none" },
  });

  assert.equal(body.system?.[0].cache_control, undefined);
});

test("the trailing conversation block gets the cache breakpoint", () => {
  const messages = convertMessages(
    [{ role: "user", content: "hello", timestamp: 0 }],
    { type: "ephemeral" },
  );

  const block = messages[0].content[0];
  assert.equal(block.type === "text" && block.cache_control?.type, "ephemeral");
});

test("tool choice accepts both a mode and a named tool", () => {
  assert.deepEqual(build([], { toolChoice: "any" }).tool_choice, { type: "any" });
  assert.deepEqual(build([], { toolChoice: { type: "tool", name: "logs" } }).tool_choice, {
    type: "tool",
    name: "logs",
  });
});

test("lone surrogates are stripped so the body stays serializable", () => {
  const lone = String.fromCharCode(0xd83d);
  const body = build([{ role: "user", content: `log ${lone} line 🙈`, timestamp: 0 }]);

  const block = body.messages[0].content[0];
  assert.equal(block.type === "text" && block.text, "log  line 🙈");
});
