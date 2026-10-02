// The seam the other bedrock tests leave open.
//
// provider.test.ts proves the provider is correct and that it claims its api
// id; it passed for the whole time production was streaming Converse, because
// nothing in it asks the question this file asks: given a real Models
// collection, and a durable conversation that names our model only by id,
// which implementation does the request actually reach?

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models, Provider } from "@earendil-works/pi-ai/models";

import {
  BEDROCK_INVOKE_MODEL_API,
  type BedrockInvoke,
  createBedrockInvokeModelProvider,
  invokeModelIdFor,
  resolveBedrockModel,
} from "./index";
import { assertBedrockInvokeModelRouting, BEDROCK_PROVIDER_ID, routeBedrockProvider } from "./runtime";

const encoder = new TextEncoder();

/** One silent-thinking turn: a signature with no thinking text, as Opus 5 produces. */
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

const streamTurn: BedrockInvoke = async () => ({
  $metadata: { httpStatusCode: 200 },
  body: (async function* () {
    for (const event of turn) {
      yield { chunk: { bytes: encoder.encode(JSON.stringify(event)) } };
    }
  })(),
});

/**
 * Models built the way `createBugbossModels` builds them. Ambient AWS env vars
 * stand in for the ECS task role that satisfies the builtin's auth resolver in
 * production.
 */
const routedModels = async (
  invoke: BedrockInvoke,
  ours: readonly Model<Api>[],
  options: { invokeModelIdFor?: (modelId: string) => string } = {},
): Promise<Models> => {
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { amazonBedrockProvider } = await import("@earendil-works/pi-ai/providers/amazon-bedrock");
  const models = createModels();
  models.setProvider(
    routeBedrockProvider(
      amazonBedrockProvider(),
      await createBedrockInvokeModelProvider({ invoke, ...options }),
      ours,
    ),
  );
  return models;
};

const withAwsEnv = async (body: () => Promise<void>): Promise<void> => {
  const previous = {
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
  };
  process.env.AWS_ACCESS_KEY_ID = "AKIATESTTESTTESTTEST";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";
  try {
    await body();
  } finally {
    if (previous.key === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previous.key;
    if (previous.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
  }
};

test("Models streams our model through InvokeModel, not Converse", async () => {
  await withAwsEnv(async () => {
    const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });

    let invoked = 0;
    const models = await routedModels(async (input, context) => {
      invoked += 1;
      return streamTurn(input, context);
    }, [model]);
    assertBedrockInvokeModelRouting(models, model);

    const message = await models.completeSimple(model, {
      systemPrompt: "You are the incident agent.",
      messages: [{ role: "user", content: "why are we 500ing", timestamp: 0 }],
    });

    // Reaching our invoke at all is the assertion. Before the router existed
    // this was zero: the builtin provider served Converse to every model it
    // owned, whatever api id the model carried.
    assert.equal(invoked, 1);
    assert.equal(message.api, BEDROCK_INVOKE_MODEL_API);
    assert.equal(message.stopReason, "stop");
    assert.equal(
      message.content.find((block) => block.type === "thinking")?.thinkingSignature,
      "ErUBCkYIBRgCIkDsilent",
    );
  });
});

// The harness never sees the model object we resolved. It stores
// `{ provider, modelId }` and resolves it from the provider's catalog, so
// this is the path that silently streamed Converse in the spike until the
// router learnt to serve our catalog entries.
test("a durable conversation that names our model by id streams InvokeModel and stores the signature", async () => {
  await withAwsEnv(async () => {
    const { AssistantEntry, MemoryStorage, Harness, createRegistry } = await import(
      "@earendil-works/pi-durable"
    );
    const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
    const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });

    let invoked = 0;
    const models = await routedModels(async (input, ctx) => {
      invoked += 1;
      return streamTurn(input, ctx);
    }, [model]);
    assertBedrockInvokeModelRouting(models, model);

    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      context,
    );
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: BEDROCK_PROVIDER_ID, modelId: model.id } },
      });
      const settled = await (
        await root.submit({ type: "input", content: "why are we 500ing" }, context)
      ).wait(context);

      assert.equal(settled.status, "done");
      assert.equal(invoked, 1, "the request reached our InvokeModel, not Converse");
      if (settled.status !== "done" || settled.type !== "input") throw new Error("unreachable");
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const message = entry?.model?.[0];
      assert.ok(message && message.role === "assistant");
      assert.equal(message.api, BEDROCK_INVOKE_MODEL_API);
      assert.equal(
        message.content.find((block) => block.type === "thinking")?.thinkingSignature,
        "ErUBCkYIBRgCIkDsilent",
      );
    } finally {
      await harness.close(context);
    }
  });
});

test("a model on the builtin api still reaches the builtin", async () => {
  const seen: string[] = [];
  const builtin = {
    id: BEDROCK_PROVIDER_ID,
    name: "Amazon Bedrock",
    auth: {},
    getModels: () => [],
    stream: (model: Model<Api>) => {
      seen.push(`stream:${model.api}`);
      return null as never;
    },
    streamSimple: (model: Model<Api>) => {
      seen.push(`streamSimple:${model.api}`);
      return null as never;
    },
  } as unknown as Provider;

  const invokeModel = await createBedrockInvokeModelProvider({
    invoke: async () => {
      throw new Error("the InvokeModel provider must not see a Converse model");
    },
  });
  const router = routeBedrockProvider(builtin, invokeModel);
  const { normalizeContext } = await import("@earendil-works/pi-ai");
  const context = normalizeContext({ systemPrompt: "", messages: [] });
  const converseModel = {
    ...(await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" })),
    api: "bedrock-converse-stream",
  } as Model<Api>;

  router.stream(converseModel, context);
  router.streamSimple(converseModel, context);

  assert.deepEqual(seen, ["stream:bedrock-converse-stream", "streamSimple:bedrock-converse-stream"]);
});

test("an unrouted Models is refused before the session starts", async () => {
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { amazonBedrockProvider } = await import("@earendil-works/pi-ai/providers/amazon-bedrock");
  const models = createModels();
  models.setProvider(amazonBedrockProvider());
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });

  assert.throws(
    () => assertBedrockInvokeModelRouting(models, model),
    /is Pi's builtin, not the bugboss InvokeModel router/,
  );
});

test("a model that lost the api id is refused rather than run on Converse", async () => {
  const resolved = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });
  const models = await routedModels(async () => ({}), [resolved]);
  const model = { ...resolved, api: "bedrock-converse-stream" } as Model<Api>;

  assert.throws(
    () => assertBedrockInvokeModelRouting(models, model),
    /Converse would drop its thinking signatures/,
  );
});

// The bug the spike found. The router is installed and the model we hold is
// right, but the catalog the harness resolves from still carries the
// builtin's Converse entry for the same id.
test("a router whose catalog still serves Converse for our id is refused", async () => {
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });
  const models = await routedModels(async () => ({}), []);

  assert.equal(models.getModel(BEDROCK_PROVIDER_ID, model.id)?.api, "bedrock-converse-stream");
  assert.throws(
    () => assertBedrockInvokeModelRouting(models, model),
    /serves model "us.anthropic.claude-opus-5" with api "bedrock-converse-stream"/,
  );
});

test("a model the builtin catalog does not list is still served", async () => {
  const arn = "arn:aws:bedrock:us-west-2:333022194791:inference-profile/us.anthropic.claude-opus-5";
  const model = await resolveBedrockModel({ id: arn });
  const models = await routedModels(async () => ({}), [model]);

  assert.equal(models.getModel(BEDROCK_PROVIDER_ID, arn)?.api, BEDROCK_INVOKE_MODEL_API);
  assertBedrockInvokeModelRouting(models, model);
});

// The same seam this file exists for, one layer up. The router builds the
// provider from options, so a profile resolver it accepts and forgets to pass
// on fails exactly the way Converse did: nothing throws, every request looks
// right, and the only symptom is a Cost Explorer line that never appears.
test("the profile resolver survives the trip through the router", async () => {
  await withAwsEnv(async () => {
    const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });
    const arn =
      "arn:aws:bedrock:us-west-2:333022194791:application-inference-profile/abcd1234efgh";

    const ids: (string | undefined)[] = [];
    const models = await routedModels(
      async (input, context) => {
        ids.push(input.modelId);
        return streamTurn(input, context);
      },
      [model],
      { invokeModelIdFor: invokeModelIdFor({ "us.anthropic.claude-opus-5": arn }) },
    );

    await models.completeSimple(model, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    });

    assert.deepEqual(ids, [arn]);
  });
});
