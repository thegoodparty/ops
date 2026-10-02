// Question 1: does our InvokeModel provider survive the move to Pi Durable?
//
// Pi Durable takes a Models collection rather than pi-coding-agent's
// ModelRuntime, so registerBedrockRouting() has nothing to attach to. The
// router itself is runtime-agnostic, and this test proves that routing it
// through models.setProvider() still reaches InvokeModel, keeps the silent
// thinking signature that resume depends on, and commits it to storage.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { AssistantEntry, MemoryStorage } from "@earendil-works/pi-durable";

import type { BedrockInvoke } from "../bedrock/index.ts";
// ops is CommonJS and Pi 1.0 is ESM-only, so ESM code reaches bugboss modules
// through their default export. See README.md.
import bedrock from "../bedrock/index.ts";
import runtime from "../bedrock/runtime.ts";
import { context, openSpikeHarness } from "./harness.mts";

const { BEDROCK_INVOKE_MODEL_API, createBedrockInvokeModelProvider, resolveBedrockModel } = bedrock;
const { routeBedrockProvider } = runtime;

const encoder = new TextEncoder();

const turn = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "us.anthropic.claude-opus-5",
      usage: { input_tokens: 10, cache_read_input_tokens: 0 },
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
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

test("a durable conversation streams our model through InvokeModel and stores the signature", async () => {
  process.env.AWS_ACCESS_KEY_ID ??= "AKIATESTTESTTESTTEST";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test-secret";
  process.env.AWS_REGION ??= "us-west-2";

  const ours = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });
  let invoked = 0;
  const invoke: BedrockInvoke = async () => {
    invoked += 1;
    return {
      $metadata: { httpStatusCode: 200 },
      body: (async function* () {
        for (const event of turn) yield { chunk: { bytes: encoder.encode(JSON.stringify(event)) } };
      })(),
    };
  };

  const builtin = amazonBedrockProvider();
  const routed = routeBedrockProvider(builtin, await createBedrockInvokeModelProvider({ invoke }));
  // The one adaptation Pi Durable needs. The harness resolves a model from the
  // provider's own catalog by id, and the builtin catalog stamps Converse on
  // every entry, so without this the router is reached with a Converse model
  // and hands it straight back to the builtin.
  const provider = {
    ...routed,
    getModels: () => builtin.getModels().map((model) => (model.id === ours.id ? ours : model)),
  };
  const models = createModels();
  models.setProvider(provider as typeof routed);

  const { harness } = await openSpikeHarness(new MemoryStorage(), models);
  const root = await harness.root(context, {
    agent: { model: { provider: "amazon-bedrock", modelId: ours.id } },
  });
  const settled = await (await root.submit({ type: "input", content: "why are we 500ing" }, context)).wait(context);

  assert.equal(settled.status, "done");
  assert.equal(invoked, 1, "the request reached our InvokeModel, not Converse");
  if (settled.status !== "done" || settled.type !== "input") throw new Error("unreachable");
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  const message = entry!.model![0] as {
    api: string;
    content: { type: string; thinkingSignature?: string }[];
  };
  assert.equal(message.api, BEDROCK_INVOKE_MODEL_API);
  assert.equal(
    message.content.find((block) => block.type === "thinking")?.thinkingSignature,
    "ErUBCkYIBRgCIkDsilent",
  );
  await harness.close(context);
});
