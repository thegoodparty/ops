// The seam the other bedrock tests leave open.
//
// provider.test.ts proves the provider is correct and that it claims its api
// id; it passed for the whole time production was streaming Converse, because
// nothing in it asks the question this file asks: given a real ModelRuntime,
// which implementation does a model with our api id actually reach?

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Api, Model, Provider } from "@earendil-works/pi-ai";

import {
  BEDROCK_INVOKE_MODEL_API,
  type BedrockInvoke,
  createBedrockInvokeModelProvider,
  invokeModelIdFor,
  resolveBedrockModel,
} from "./index";
import {
  assertBedrockInvokeModelRouting,
  BEDROCK_PROVIDER_ID,
  registerBedrockRouting,
  routeBedrockProvider,
} from "./runtime";

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

/**
 * A runtime built the way the agent builds one, minus the developer's own
 * ~/.pi/models.json and the catalog refresh, so the test sees only Pi's
 * builtins. Ambient AWS env vars stand in for the ECS task role that satisfies
 * the builtin's auth resolver in production.
 */
const createRuntime = async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  return pi.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
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

test("the model runtime streams our model through InvokeModel, not Converse", async () => {
  await withAwsEnv(async () => {
    const runtime = await createRuntime();
    const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });

    let invoked = 0;
    const invoke: BedrockInvoke = async () => {
      invoked += 1;
      return {
        $metadata: { httpStatusCode: 200 },
        body: (async function* () {
          for (const event of turn) {
            yield { chunk: { bytes: encoder.encode(JSON.stringify(event)) } };
          }
        })(),
      };
    };

    await registerBedrockRouting({ runtime, invoke });
    assertBedrockInvokeModelRouting(runtime, model);

    const message = await runtime
      .streamSimple(model, {
        systemPrompt: "You are the incident agent.",
        messages: [{ role: "user", content: "why are we 500ing", timestamp: 0 }],
      })
      .result();

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

test("an unrouted runtime is refused before the session starts", async () => {
  const runtime = await createRuntime();
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });

  assert.throws(
    () => assertBedrockInvokeModelRouting(runtime, model),
    /is Pi's builtin, not the bugboss InvokeModel router/,
  );
});

test("a model that lost the api id is refused rather than run on Converse", async () => {
  await withAwsEnv(async () => {
    const runtime = await createRuntime();
    await registerBedrockRouting({ runtime, invoke: async () => ({}) });
    const model = {
      ...(await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" })),
      api: "bedrock-converse-stream",
    } as Model<Api>;

    assert.throws(
      () => assertBedrockInvokeModelRouting(runtime, model),
      /Converse would drop its thinking signatures/,
    );
  });
});

test("registering twice keeps one router rather than wrapping it in another", async () => {
  await withAwsEnv(async () => {
    const runtime = await createRuntime();
    const first = await registerBedrockRouting({ runtime, invoke: async () => ({}) });
    const second = await registerBedrockRouting({ runtime, invoke: async () => ({}) });

    assert.equal(first, second);
    assert.equal(runtime.getProvider(BEDROCK_PROVIDER_ID), first);
  });
});

// The same seam this file exists for, one layer up. `registerBedrockRouting`
// builds the provider, so a profile resolver it accepts and forgets to pass
// on fails exactly the way Converse did: nothing throws, every request looks
// right, and the only symptom is a Cost Explorer line that never appears.
test("the profile resolver survives the trip through registerBedrockRouting", async () => {
  await withAwsEnv(async () => {
    const runtime = await createRuntime();
    const model = await resolveBedrockModel({ id: "us.anthropic.claude-opus-5" });
    const arn =
      "arn:aws:bedrock:us-west-2:333022194791:application-inference-profile/abcd1234efgh";

    const ids: (string | undefined)[] = [];
    const invoke: BedrockInvoke = async (input) => {
      ids.push(input.modelId);
      return {
        $metadata: { httpStatusCode: 200 },
        body: (async function* () {
          for (const event of turn) {
            yield { chunk: { bytes: encoder.encode(JSON.stringify(event)) } };
          }
        })(),
      };
    };

    await registerBedrockRouting({
      runtime,
      invoke,
      invokeModelIdFor: invokeModelIdFor({ "us.anthropic.claude-opus-5": arn }),
    });

    await runtime
      .streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] })
      .result();

    assert.deepEqual(ids, [arn]);
  });
});
