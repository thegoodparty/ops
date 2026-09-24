// End-to-end through the real Pi runtime with a fake Bedrock client. No AWS
// call is made. The round-trip test is the acceptance gate for this chunk: a
// signature that survives one turn has to survive being replayed as history.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "@earendil-works/pi-ai";

import {
  BEDROCK_INVOKE_MODEL_API,
  type BedrockInvoke,
  createBedrockInvokeModelProvider,
  type InvokeModelBody,
  registerBedrockInvokeModelProvider,
  resolveBedrockModel,
} from "./index";

const encoder = new TextEncoder();

const chunks = (events: Record<string, unknown>[]) => ({
  $metadata: { httpStatusCode: 200 },
  body: (async function* () {
    for (const event of events) {
      yield { chunk: { bytes: encoder.encode(JSON.stringify(event)) } };
    }
  })(),
});

/** A turn where the model thinks silently: signature only, no thinking text. */
const silentThinkingTurn = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "us.anthropic.claude-opus-5",
      usage: { input_tokens: 1000, cache_read_input_tokens: 40000 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "ErUBCkYIBRgCIkDsilent" },
  },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "The 500s start at the deploy." },
  },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 250 } },
  { type: "message_stop" },
];

const setup = async () => {
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });
  const sent: InvokeModelBody[] = [];
  const invoke: BedrockInvoke = async (input) => {
    sent.push(JSON.parse(new TextDecoder().decode(input.body as Uint8Array)) as InvokeModelBody);
    return chunks(silentThinkingTurn);
  };
  const provider = await createBedrockInvokeModelProvider({ invoke });
  const pi = await import("@earendil-works/pi-ai");
  return { model, sent, provider, pi };
};

test("the catalog supplies real Bedrock rates for an inference profile id", async () => {
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });

  assert.equal(model.api, BEDROCK_INVOKE_MODEL_API);
  assert.equal(model.provider, "amazon-bedrock");
  assert.deepEqual(model.cost, { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 });
  assert.equal(model.contextWindow, 1000000);
});

test("an inference profile ARN resolves to the same catalog entry", async () => {
  const model = await resolveBedrockModel({
    id: "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-5",
  });

  assert.equal(model.id, "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-5");
  assert.deepEqual(model.cost, { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 });
});

test("an id the catalog does not know demands explicit cost rates", async () => {
  await assert.rejects(
    resolveBedrockModel({ id: "arn:aws:bedrock:us-west-2:1:application-inference-profile/opaque" }),
    /pass explicit cost rates/,
  );
});

test("a silent thinking block reaches the assistant message with its signature", async () => {
  const { model, provider, pi } = await setup();

  const message = await provider
    .stream(
      model,
      pi.normalizeContext({
        systemPrompt: "You are the incident agent.",
        messages: [{ role: "user", content: "why are we 500ing", timestamp: 0 }],
      }),
      { effort: "high" },
    )
    .result();

  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content[0], {
    type: "thinking",
    thinking: "",
    thinkingSignature: "ErUBCkYIBRgCIkDsilent",
  });
  assert.equal(message.api, BEDROCK_INVOKE_MODEL_API);
  assert.equal(message.providerThinkingLevel, "high");
});

test("usage and the cost breakdown are populated from Pi's own rates", async () => {
  const { model, provider, pi } = await setup();

  const message = await provider
    .stream(model, pi.normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }))
    .result();

  assert.equal(message.usage.input, 1000);
  assert.equal(message.usage.output, 250);
  assert.equal(message.usage.cacheRead, 40000);
  assert.equal(message.usage.totalTokens, 41250);

  const expected = {
    input: (5.5 / 1e6) * 1000,
    output: (27.5 / 1e6) * 250,
    cacheRead: (0.55 / 1e6) * 40000,
    cacheWrite: 0,
  };
  assert.ok(Math.abs(message.usage.cost.input - expected.input) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.output - expected.output) < 1e-12);
  assert.ok(Math.abs(message.usage.cost.cacheRead - expected.cacheRead) < 1e-12);
  assert.equal(message.usage.cost.cacheWrite, 0);
  assert.ok(
    Math.abs(
      message.usage.cost.total - (expected.input + expected.output + expected.cacheRead),
    ) < 1e-12,
  );
});

test("the signature replays verbatim on the next turn", async () => {
  const { model, sent, provider, pi } = await setup();

  const first = await provider
    .stream(
      model,
      pi.normalizeContext({
        systemPrompt: "You are the incident agent.",
        messages: [{ role: "user", content: "why are we 500ing", timestamp: 0 }],
      }),
      { effort: "high" },
    )
    .result();

  const history: Message[] = [
    { role: "user", content: "why are we 500ing", timestamp: 0 },
    first,
    { role: "user", content: "and now?", timestamp: 0 },
  ];

  await provider
    .stream(
      model,
      pi.normalizeContext({ systemPrompt: "You are the incident agent.", messages: history }),
      { effort: "high" },
    )
    .result();

  const replayed = sent[1].messages.find((m) => m.role === "assistant");
  assert.deepEqual(replayed?.content[0], {
    type: "thinking",
    thinking: "",
    signature: "ErUBCkYIBRgCIkDsilent",
  });
});

test("the request body is native Anthropic with adaptive thinking", async () => {
  const { model, sent, provider, pi } = await setup();

  await provider
    .stream(
      model,
      pi.normalizeContext({
        systemPrompt: "You are the incident agent.",
        messages: [{ role: "user", content: "why are we 500ing", timestamp: 0 }],
        tools: [
          {
            name: "get_incident",
            description: "read the incident",
            parameters: { type: "object", properties: {}, required: [] },
          },
        ],
      }),
      { effort: "xhigh" },
    )
    .result();

  const body = sent[0];
  assert.equal(body.anthropic_version, "bedrock-2023-05-31");
  assert.equal(body.thinking?.type, "adaptive");
  assert.deepEqual(body.output_config, { effort: "xhigh" });
  assert.equal(body.system?.[0].text, "You are the incident agent.");
  assert.equal(body.tools?.[0].name, "get_incident");
  assert.equal("budget_tokens" in (body.thinking ?? {}), false);
});

test("onPayload can rewrite the body, which is how context editing gets in", async () => {
  const { model, sent, provider, pi } = await setup();

  await provider
    .stream(model, pi.normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
      onPayload: (payload) => ({
        ...(payload as InvokeModelBody),
        context_management: { edits: [{ type: "clear_thinking_20251015" }] },
      }),
    })
    .result();

  assert.deepEqual((sent[0] as unknown as Record<string, unknown>).context_management, {
    edits: [{ type: "clear_thinking_20251015" }],
  });
});

test("streamSimple maps a reasoning level onto an effort", async () => {
  const { model, sent, provider, pi } = await setup();

  await provider
    .streamSimple(
      model,
      pi.normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
      { reasoning: "low" },
    )
    .result();

  assert.deepEqual(sent[0].output_config, { effort: "low" });
});

test("streamSimple with no reasoning sends no thinking config", async () => {
  const { model, sent, provider, pi } = await setup();

  await provider
    .streamSimple(
      model,
      pi.normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
    )
    .result();

  assert.equal(sent[0].thinking, undefined);
});

test("a transport failure ends the stream as an error, not a hang", async () => {
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });
  const provider = await createBedrockInvokeModelProvider({
    invoke: async () => ({
      $metadata: { httpStatusCode: 200 },
      body: (async function* () {
        yield { throttlingException: { name: "ThrottlingException", message: "slow down" } };
      })(),
    }),
  });
  const pi = await import("@earendil-works/pi-ai");

  const message = await provider
    .stream(model, pi.normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }))
    .result();

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /slow down/);
});

test("the region option and an abort signal reach the client", async () => {
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });
  const seen: { region?: string; signal?: AbortSignal }[] = [];
  const provider = await createBedrockInvokeModelProvider({
    invoke: async (_input, context) => {
      seen.push(context);
      return chunks(silentThinkingTurn);
    },
  });
  const pi = await import("@earendil-works/pi-ai");
  const controller = new AbortController();

  await provider
    .stream(
      model,
      pi.normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
      { region: "us-west-2", signal: controller.signal },
    )
    .result();

  assert.equal(seen[0].region, "us-west-2");
  assert.equal(seen[0].signal, controller.signal);
});

test("registering claims the new id and leaves the builtin converse id alone", async () => {
  const compat = await import("@earendil-works/pi-ai/compat");
  const builtinBefore = compat.getApiProvider("bedrock-converse-stream");

  await registerBedrockInvokeModelProvider({ invoke: async () => chunks(silentThinkingTurn) });

  assert.ok(compat.getApiProvider(BEDROCK_INVOKE_MODEL_API));
  assert.equal(compat.getApiProvider("bedrock-converse-stream"), builtinBefore);
});
