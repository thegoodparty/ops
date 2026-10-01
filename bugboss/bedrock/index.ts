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
  resolveCacheRetention,
} from "./options";
import { makeAlarm } from "../logging";
import { regionFromModelId } from "./model";
import {
  type AnthropicStreamEvent,
  type CacheRetentionReport,
  consumeAnthropicStream,
} from "./stream";

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

const alarm = makeAlarm("bedrock");

/**
 * How long a model call may go without a single byte before it is abandoned.
 *
 * Nothing else bounds it. The SDK sets no request or socket timeout, and the
 * agent's own deadline is a day out, so a stream that stops sending without
 * closing held incident 100's agent silent for over an hour. Idle rather than
 * total, because a healthy call that thinks for minutes keeps sending: across
 * 3,788 production turns the slowest whole call took 316s and the next 126s,
 * and an idle gap can only be shorter than the call it sits in.
 */
export const MODEL_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Yields `source` until it ends, refreshing the idle timer on every item, and
 * rejects as soon as `stalled` does even if the pending read never settles.
 * The race is the point: aborting the request is not proof the SDK unblocks
 * a read that is already waiting on a socket.
 */
const untilStalled = async function* <T>(
  source: AsyncIterable<T>,
  stalled: Promise<never>,
  touch: () => void,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), stalled]);
      if (next.done) return;
      touch();
      yield next.value;
    }
  } finally {
    void iterator.return?.()?.catch(() => {});
  }
};

/**
 * Reported once per provider, not once per turn. A downgrade is a property of
 * the deployment rather than of a turn, and an incident runs ~90 of them; 90
 * copies would bury the line an alert is meant to catch.
 */
const reportUnhonouredCacheRetention = (
  modelId: string,
  report: CacheRetentionReport,
): void => {
  console.error(
    JSON.stringify({
      component: "bedrock",
      event: "cache_retention_not_honoured",
      modelId,
      requested: report.requested,
      cacheWrite: report.written,
      cacheWrite1h: report.written1h,
      cacheWrite5m: report.written5m,
      detail:
        report.written1h === null
          ? "the response carried no cache_creation split, so the 1h ttl could not be confirmed and this write is being costed at the 5m rate"
          : "the 1h ttl was requested but the whole write was billed at the 5m rate, so blocking waits will keep rebuilding the prefix",
    }),
  );
};

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
  /**
   * Maps the logical model id to the id put on the wire, which is how an
   * application inference profile is reached: Bedrock has no request-level
   * cost tag, so the only way to attribute a run is to invoke a tagged
   * wrapper instead of the model.
   *
   * Only the request field changes. `model.id` stays the logical id, so the
   * cost rates, the signed session prefix and the `modelId` recorded on the
   * turn are all the same with a profile as without one -- which is what
   * lets a session started before a profile existed resume after one does.
   */
  invokeModelIdFor?: (modelId: string) => string;
  /** Overridden in tests; see MODEL_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /** Put on `model_call_stalled` so a stall names the incident it froze. */
  incidentId?: string;
}

export const createBedrockInvokeModelProvider = async ({
  invoke = defaultInvoke,
  invokeModelIdFor = (modelId) => modelId,
  idleTimeoutMs = MODEL_IDLE_TIMEOUT_MS,
  incidentId,
}: CreateBedrockInvokeModelProviderOptions = {}): Promise<
  ApiProvider<BedrockInvokeModelApi, BedrockInvokeModelOptions>
> => {
  const pi = await import("@earendil-works/pi-ai");
  let reportedUnhonouredRetention = false;

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

    const idle = new AbortController();
    const stalled = new Promise<never>((_, reject) => {
      idle.signal.addEventListener("abort", () => reject(idle.signal.reason), { once: true });
    });
    stalled.catch(() => {});
    let idleTimer: NodeJS.Timeout | undefined;
    let startedAt = Date.now();
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const elapsedMs = Date.now() - startedAt;
        alarm("model_call_stalled", {
          incidentId: incidentId ?? null,
          modelId: model.id,
          idleTimeoutMs,
          elapsedMs,
        });
        // "timed out" is in the wording on purpose: it is what Pi's
        // isRetryableAssistantError matches, so a stall is retried as a
        // transient failure and only then exits the run.
        idle.abort(
          new Error(`Bedrock model call timed out: no response for ${idleTimeoutMs}ms`),
        );
      }, idleTimeoutMs);
    };

    void (async () => {
      try {
        const requestedCacheRetention = resolveCacheRetention(options);

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

        startedAt = Date.now();
        touch();
        const response = await Promise.race([
          invoke(
            {
              modelId: invokeModelIdFor(model.id),
              contentType: "application/json",
              accept: "application/json",
              body: new TextEncoder().encode(JSON.stringify(body)),
            },
            {
              signal: options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal,
              region: options.region,
            },
          ),
          stalled,
        ]);
        touch();

        await options.onResponse?.(
          { status: response.$metadata?.httpStatusCode ?? 200, headers: {} },
          model,
        );

        if (!response.body) throw new Error("Bedrock returned no response stream");

        await consumeAnthropicStream({
          events: decodeEvents(untilStalled(response.body, stalled, touch)),
          output,
          push: (event) => eventStream.push(event),
          applyCost: () => {
            pi.calculateCost(model, output.usage);
          },
          parseJson: (partial) => pi.parseStreamingJson(partial),
          cacheRetention: requestedCacheRetention,
          onUnhonouredCacheRetention: (report) => {
            if (reportedUnhonouredRetention) return;
            reportedUnhonouredRetention = true;
            reportUnhonouredCacheRetention(model.id, report);
          },
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
      } finally {
        clearTimeout(idleTimer);
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
