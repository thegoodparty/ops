// What the Boss's own request path has to hold, now that it is the agent's
// request path too.
//
// Every test here drives a real ModelRuntime with a scripted invoke, because
// the defects this file exists to catch all live in the wiring rather than in
// a function: which provider the request reaches, whether a failure looks
// like an answer, and whether anybody counted the tokens.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type BedrockInvoke, resolveBedrockModel } from "./index";
import { assertBedrockInvokeModelRouting, registerBedrockRouting } from "./runtime";
import { createPiModelClient } from "./client";
import { addModelUsage, emptyModelUsage } from "../model";
import { runStructuredCall } from "../triage/model";
import { z } from "zod";

const encoder = new TextEncoder();

interface ScriptedTurn {
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite1h?: number };
}

/** An Anthropic event stream for one assistant turn. */
const eventsFor = (turn: ScriptedTurn) => {
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        model: "us.anthropic.claude-sonnet-5",
        usage: {
          input_tokens: turn.usage?.input ?? 100,
          cache_read_input_tokens: turn.usage?.cacheRead ?? 0,
          // Both halves, as a real response carries them: the total is what
          // `cacheWrite` is read from, the split is what proves the 1h ttl
          // was actually honoured.
          cache_creation_input_tokens: turn.usage?.cacheWrite1h ?? 0,
          cache_creation: {
            ephemeral_1h_input_tokens: turn.usage?.cacheWrite1h ?? 0,
            ephemeral_5m_input_tokens: 0,
          },
        },
      },
    },
  ];
  if (turn.text !== undefined) {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: turn.text } },
      { type: "content_block_stop", index: 0 },
    );
  }
  if (turn.toolUse) {
    events.push(
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: turn.toolUse.id, name: turn.toolUse.name, input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.toolUse.input) },
      },
      { type: "content_block_stop", index: 1 },
    );
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: turn.toolUse ? "tool_use" : "end_turn" },
      usage: { output_tokens: turn.usage?.output ?? 20 },
    },
    { type: "message_stop" },
  );
  return events;
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

interface Harness {
  client: Awaited<ReturnType<typeof createPiModelClient>>;
  bodies: Record<string, unknown>[];
}

/**
 * The Boss's client over a real runtime, with the routing asserted exactly as
 * the composition root asserts it.
 */
const harness = async (script: (ScriptedTurn | "fail")[]): Promise<Harness> => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const runtime = await pi.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const model = await resolveBedrockModel({ id: "us.anthropic.claude-sonnet-5" });

  const bodies: Record<string, unknown>[] = [];
  let call = 0;
  const invoke: BedrockInvoke = async (input) => {
    bodies.push(JSON.parse(new TextDecoder().decode(input.body as Uint8Array)));
    const turn = script[Math.min(call, script.length - 1)];
    call += 1;
    if (turn === "fail") throw new Error("ThrottlingException: slow down");
    return {
      $metadata: { httpStatusCode: 200 },
      body: (async function* () {
        for (const event of eventsFor(turn)) {
          yield { chunk: { bytes: encoder.encode(JSON.stringify(event)) } };
        }
      })(),
    };
  };

  await registerBedrockRouting({ runtime, invoke });
  assertBedrockInvokeModelRouting(runtime, model);
  return { client: createPiModelClient({ runtime, model }), bodies };
};

const request = (over: Partial<Parameters<Harness["client"]["complete"]>[0]> = {}) => ({
  system: "You are the triage step.",
  messages: [{ role: "user" as const, text: "place this signal" }],
  tools: [
    {
      name: "decide",
      description: "Record the triage decision.",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string" } },
        required: ["action"],
      },
    },
  ],
  maxTokens: 2048,
  signal: AbortSignal.timeout(5_000),
  ...over,
});

// ---------------------------------------------------------------------------
// The point of the change: one request path
// ---------------------------------------------------------------------------

test("a Boss call is written with the 1h cache ttl the agent's calls get", async () => {
  await withAwsEnv(async () => {
    const { client, bodies } = await harness([{ text: "ok" }]);
    await client.complete(request());

    // The old hand-rolled body had no cache_control at all, so every triage
    // call rewrote its prefix and none of the 1h work reached this path.
    const body = bodies[0] as {
      system?: { cache_control?: { type: string; ttl?: string } }[];
      tools?: { cache_control?: { type: string; ttl?: string } }[];
    };
    const breakpoints = [...(body.system ?? []), ...(body.tools ?? [])]
      .map((block) => block.cache_control)
      .filter((control): control is { type: string; ttl?: string } => !!control);
    assert.ok(breakpoints.length > 0, "no cache breakpoint was written");
    for (const control of breakpoints) assert.equal(control.ttl, "1h");
  });
});

test("a Boss call carries the native Anthropic body, not a Converse one", async () => {
  await withAwsEnv(async () => {
    const { client, bodies } = await harness([{ text: "ok" }]);
    await client.complete(request());
    const body = bodies[0] as { anthropic_version?: string; max_tokens?: number };
    assert.equal(body.anthropic_version, "bedrock-2023-05-31");
    // Explicit on every call: absent, Pi bills model.maxTokens instead, which
    // is 64000 on a resolved Bedrock model.
    assert.equal(body.max_tokens, 2048);
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test("a reply carries the tokens and a priced estimate", async () => {
  await withAwsEnv(async () => {
    const { client } = await harness([
      { text: "ok", usage: { input: 1200, output: 340, cacheRead: 900, cacheWrite1h: 400 } },
    ]);
    const reply = await client.complete(request());

    assert.equal(reply.usage.tokensIn, 1200);
    assert.equal(reply.usage.tokensOut, 340);
    assert.equal(reply.usage.cacheRead, 900);
    assert.equal(reply.usage.cacheWrite, 400);
    assert.equal(reply.usage.calls, 1);
    assert.equal(reply.usage.modelId, "us.anthropic.claude-sonnet-5");
    // Priced by the provider's own calculateCost against the catalog rates,
    // which is the whole reason a triage call can be costed at all now.
    assert.ok(reply.usage.costUsd > 0, `expected a priced call, got ${reply.usage.costUsd}`);
  });
});

test("tokens are banked even when the call never produces an answer", async () => {
  await withAwsEnv(async () => {
    // Answers in prose every round, so the loop exhausts maxRounds and throws.
    const { client } = await harness([{ text: "I think it is probably fine" }]);
    const usage = emptyModelUsage();

    await assert.rejects(
      runStructuredCall({
        model: client,
        system: "decide",
        prompt: "place this signal",
        answer: {
          spec: { name: "decide", description: "d", inputSchema: { type: "object" } },
          schema: z.object({ action: z.string() }),
        },
        tools: [],
        budgetMs: 5_000,
        maxRounds: 2,
        maxInvalid: 1,
        maxTokens: 2048,
        usage,
      }),
    );

    // The storm this exists for: 67 triage calls fell back in five minutes
    // and every incident recorded costUsd 0.00. Not free, uncounted.
    assert.equal(usage.calls, 2);
    assert.ok(usage.tokensIn > 0, "a failed call reported no input tokens");
    assert.ok(usage.costUsd > 0, "a failed call reported no cost");
  });
});

// ---------------------------------------------------------------------------
// A dead model must not look like a healthy one
// ---------------------------------------------------------------------------

test("a failed request throws rather than answering with an empty reply", async () => {
  await withAwsEnv(async () => {
    const { client } = await harness(["fail"]);
    // Pi resolves a transport failure as a terminal message with
    // stopReason "error" and zeroed usage rather than rejecting. Unchecked,
    // that is an empty reply with no tool calls -- indistinguishable from a
    // model that answered in prose, which every caller retries against and
    // then records as its own bad output.
    await assert.rejects(client.complete(request()), /slow down|error/i);
  });
});

test("a failed request still reports what it spent", async () => {
  await withAwsEnv(async () => {
    const { client } = await harness(["fail"]);
    const usage = emptyModelUsage();
    try {
      await client.complete(request());
      assert.fail("expected the request to throw");
    } catch (err) {
      const failure = err as { usage?: typeof usage };
      assert.ok(failure.usage, "the throw carried no usage to bank");
      addModelUsage(usage, failure.usage);
      assert.equal(usage.calls, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Transcript shape
// ---------------------------------------------------------------------------

test("an assistant turn with no text and no tool calls is not dropped", async () => {
  await withAwsEnv(async () => {
    const { client, bodies } = await harness([{ text: "ok" }]);

    // Reachable: runStructuredCall records the assistant turn before nudging
    // a prose reply back at the answer tool, and a reply can be empty. Pi's
    // body builder skips a message whose blocks all came out empty, so
    // without a placeholder this transcript reaches Anthropic as two
    // consecutive user messages and is rejected outright.
    await client.complete(
      request({
        messages: [
          { role: "user", text: "place this signal" },
          { role: "assistant", text: "", toolCalls: [] },
          { role: "user", text: "Answer by calling the decide tool." },
        ],
      }),
    );

    const body = bodies[0] as { messages: { role: string }[] };
    const roles = body.messages.map((message) => message.role);
    assert.deepEqual(roles, ["user", "assistant", "user"]);
  });
});

test("consecutive tool results are coalesced into one user message", async () => {
  await withAwsEnv(async () => {
    const { client, bodies } = await harness([{ text: "ok" }]);
    await client.complete(
      request({
        messages: [
          { role: "user", text: "place this signal" },
          {
            role: "assistant",
            text: "",
            toolCalls: [
              { id: "t1", name: "query_incidents", input: {} },
              { id: "t2", name: "search_incidents", input: {} },
            ],
          },
          { role: "toolResult", toolCallId: "t1", text: "3 rows" },
          { role: "toolResult", toolCallId: "t2", text: "0 matches" },
        ],
      }),
    );

    // Anthropic requires every result answering one assistant turn in a
    // single user message. The hand-rolled builder did this itself; this
    // asserts the path it was replaced with still does.
    const body = bodies[0] as { messages: { role: string; content: { type: string }[] }[] };
    assert.deepEqual(
      body.messages.map((message) => message.role),
      ["user", "assistant", "user"],
    );
    const results = body.messages[2].content;
    assert.equal(results.length, 2);
    for (const block of results) assert.equal(block.type, "tool_result");
  });
});
