// A Pi api provider that talks to Bedrock through InvokeModel with the native
// Anthropic message body, bypassing Converse.
//
// Design spec: bugboss/docs/architecture.md, "Why InvokeModel is not optional".
// Converse reshapes thinking into reasoningContent.reasoningText { text,
// signature } and then drops any block whose text is empty
// (bedrock-converse-stream.ts:1022) -- which on Opus 5 and Sonnet 5 with
// adaptive thinking is a block whose signature is the only thing in it. Resume
// replays the whole transcript, so losing signatures breaks the system.
//
// pi-ai is ESM-only and declares no "require" condition, so this CommonJS
// package can only reach it through dynamic import. That is why registration
// is async: it loads Pi once, then the stream functions close over it and stay
// synchronous, as StreamFunction requires.

import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  type InvokeModelWithResponseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";

import type {
  ApiProvider,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@earendil-works/pi-ai/compat";

import { buildInvokeModelBody, type InvokeModelBody } from "./request";
import {
  BEDROCK_INVOKE_MODEL_API,
  type BedrockInvokeModelApi,
  type BedrockInvokeModelOptions,
  mapThinkingLevelToEffort,
} from "./options";
import { regionFromModelId } from "./model";
import { type AnthropicStreamEvent, consumeAnthropicStream } from "./stream";

export * from "./options";
export * from "./model";
export * from "./request";
export * from "./stream";

export interface BedrockStreamError {
  name?: string;
  message?: string;
}

/**
 * Structurally what we read off a response stream item. The SDK's ResponseStream
 * union is assignable to this, and unlike that union a hand-built chunk is too,
 * which is what lets a test script a stream without the AWS client.
 */
export interface BedrockStreamItem {
  chunk?: { bytes?: Uint8Array };
  internalServerException?: BedrockStreamError;
  modelStreamErrorException?: BedrockStreamError;
  modelTimeoutException?: BedrockStreamError;
  serviceUnavailableException?: BedrockStreamError;
  throttlingException?: BedrockStreamError;
  validationException?: BedrockStreamError;
}

export interface BedrockInvokeResult {
  body?: AsyncIterable<BedrockStreamItem>;
  $metadata?: { httpStatusCode?: number };
}

export interface BedrockInvokeContext {
  signal?: AbortSignal;
  region?: string;
}

export type BedrockInvoke = (
  input: InvokeModelWithResponseStreamCommandInput,
  context: BedrockInvokeContext,
) => Promise<BedrockInvokeResult>;

const clients = new Map<string, BedrockRuntimeClient>();

/**
 * No `credentials` key, so the SDK default chain resolves the ECS task role
 * with nothing configured. Setting credentials explicitly would also defeat a
 * configured AWS_PROFILE.
 *
 * Region likewise: an ARN pins its own region and an explicit option wins, but
 * otherwise we leave it unset so the SDK's region chain runs rather than
 * hardcoding a default that would quietly cross-region a task.
 */
const defaultInvoke: BedrockInvoke = async (input, { signal, region }) => {
  const resolved = region ?? regionFromModelId(input.modelId ?? "");
  let client = clients.get(resolved ?? "");
  if (!client) {
    client = new BedrockRuntimeClient(resolved ? { region: resolved } : {});
    clients.set(resolved ?? "", client);
  }
  return client.send(new InvokeModelWithResponseStreamCommand(input), {
    ...(signal ? { abortSignal: signal } : {}),
  });
};

const decoder = new TextDecoder();

const decodeEvents = async function* (
  body: AsyncIterable<BedrockStreamItem>,
): AsyncGenerator<AnthropicStreamEvent> {
  for await (const item of body) {
    if (item.chunk?.bytes) {
      yield JSON.parse(decoder.decode(item.chunk.bytes)) as AnthropicStreamEvent;
      continue;
    }
    const failure =
      item.internalServerException ??
      item.modelStreamErrorException ??
      item.modelTimeoutException ??
      item.serviceUnavailableException ??
      item.throttlingException ??
      item.validationException;
    if (failure) {
      throw new Error(failure.message ?? failure.name ?? "Bedrock response stream error");
    }
  }
};

const emptyUsage = (): AssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export interface CreateBedrockInvokeModelProviderOptions {
  /** Injected in tests so no AWS call is made. */
  invoke?: BedrockInvoke;
}

export const createBedrockInvokeModelProvider = async ({
  invoke = defaultInvoke,
}: CreateBedrockInvokeModelProviderOptions = {}): Promise<
  ApiProvider<BedrockInvokeModelApi, BedrockInvokeModelOptions>
> => {
  const pi = await import("@earendil-works/pi-ai");

  const stream: StreamFunction<BedrockInvokeModelApi, BedrockInvokeModelOptions> = (
    model,
    context,
    options = {},
  ) => {
    const eventStream = pi.createAssistantMessageEventStream();

    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: BEDROCK_INVOKE_MODEL_API,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    if (options.effort) output.providerThinkingLevel = options.effort;

    void (async () => {
      try {
        // The native body carries one top-level system prompt, so later system
        // messages are replayed into the leading one rather than dropped.
        const collapsed = pi.collapseSystemMessages(context);
        const initialSystemMessage = pi.getInitialSystemMessage(collapsed.messages);
        const systemText = initialSystemMessage
          ? pi.getSystemMessageText(initialSystemMessage)
          : "";

        let body = buildInvokeModelBody({
          model,
          messages: collapsed.messages,
          initialSystemMessage,
          systemText,
          tools: pi.getCurrentTools(collapsed.messages),
          options,
        });

        // Pi's payload hook, and the escape hatch for anything not modelled
        // here (server-side context editing, guardrail config, new betas).
        const replacement = await options.onPayload?.(body, model);
        if (replacement !== undefined) body = replacement as InvokeModelBody;

        const response = await invoke(
          {
            modelId: model.id,
            contentType: "application/json",
            accept: "application/json",
            body: new TextEncoder().encode(JSON.stringify(body)),
          },
          { signal: options.signal, region: options.region },
        );

        await options.onResponse?.(
          { status: response.$metadata?.httpStatusCode ?? 200, headers: {} },
          model,
        );

        if (!response.body) throw new Error("Bedrock returned no response stream");

        await consumeAnthropicStream({
          events: decodeEvents(response.body),
          output,
          push: (event) => eventStream.push(event),
          applyCost: () => {
            pi.calculateCost(model, output.usage);
          },
          parseJson: (partial) => pi.parseStreamingJson(partial),
          signal: options.signal,
        });

        eventStream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse" | "deferred",
          message: output,
        });
        eventStream.end();
      } catch (error) {
        output.stopReason = options.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        eventStream.push({ type: "error", reason: output.stopReason, error: output });
        eventStream.end();
      }
    })();

    return eventStream;
  };

  const streamSimple: StreamFunction<BedrockInvokeModelApi, SimpleStreamOptions> = (
    model,
    context,
    options = {},
  ) =>
    stream(model, context, {
      ...options,
      ...(options.reasoning
        ? { effort: mapThinkingLevelToEffort(options.reasoning, model.thinkingLevelMap) }
        : { thinkingEnabled: false }),
    });

  return { api: BEDROCK_INVOKE_MODEL_API, stream, streamSimple };
};

/**
 * Registers the provider under its own api id. Import order does not matter:
 * pi-ai/compat registers the builtins when it loads and never clobbers an id
 * that is already claimed, and this id is not one of them.
 */
export const registerBedrockInvokeModelProvider = async (
  options: CreateBedrockInvokeModelProviderOptions = {},
): Promise<ApiProvider<BedrockInvokeModelApi, BedrockInvokeModelOptions>> => {
  const { registerApiProvider } = await import("@earendil-works/pi-ai/compat");
  const provider = await createBedrockInvokeModelProvider(options);
  registerApiProvider(provider, "bugboss-bedrock-invoke-model");
  return provider;
};

export type BedrockInvokeModelProviderModel = Model<BedrockInvokeModelApi>;
