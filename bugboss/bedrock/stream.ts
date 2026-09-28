// Turns the native Anthropic event stream Bedrock InvokeModel returns into
// Pi's AssistantMessageEvent protocol.
//
// Kept free of runtime imports from pi-ai so it can be unit tested against a
// scripted event sequence with no AWS call and no module loading.

import type {
  AssistantMessage,
  AssistantMessageEvent,
  CacheRetention,
  JsonObject,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";

export interface AnthropicUsagePayload {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
}

/** Loose by design: a block type we do not know yet must not be a type error. */
export interface AnthropicBlockStart {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: JsonObject;
}

export interface AnthropicBlockDelta {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  partial_json?: string;
}

/**
 * One thinking block the service dropped before inference. `reason` is the
 * binding check that removed it: prefix_binding_mismatch is our resume drift,
 * organization_binding_mismatch is a block replayed under a different AWS
 * account, model_binding_mismatch a block replayed against another model.
 */
export interface AnthropicInputTransformation {
  type?: string | null;
  path?: string | null;
  reason?: string | null;
}

export interface BedrockInvocationMetrics {
  inputTokenCount?: number;
  outputTokenCount?: number;
  cacheReadInputTokenCount?: number;
  cacheWriteInputTokenCount?: number;
}

export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: AnthropicUsagePayload;
    input_transformations?: AnthropicInputTransformation[];
  };
  content_block?: AnthropicBlockStart;
  /** Partial because a message_delta carries a stop reason and no block type. */
  delta?: Partial<AnthropicBlockDelta> & { stop_reason?: string | null };
  usage?: AnthropicUsagePayload;
  error?: { type?: string; message?: string };
  input_transformations?: AnthropicInputTransformation[];
  "amazon-bedrock-invocationMetrics"?: BedrockInvocationMetrics;
}

export const REDACTED_THINKING_PLACEHOLDER = "[Reasoning redacted]";

/** The diagnostic Pi's Anthropic path emits, so one listener covers both. */
export const INPUT_TRANSFORMATIONS_DIAGNOSTIC = "anthropic_input_transformations";

export const mapStopReason = (reason: string): { stopReason: StopReason; errorMessage?: string } => {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return { stopReason: "error", errorMessage: "The model refused to complete the request" };
    default:
      return { stopReason: "error", errorMessage: `Unhandled stop reason: ${reason}` };
  }
};

type TrackedBlock = { contentIndex: number; partialJson: string };

/** What a request asked the cache for, against what the service billed it as. */
export interface CacheRetentionReport {
  requested: CacheRetention;
  /** Total tokens written to the cache on this turn. */
  written: number;
  /** The 1h share, or null when the response carried no `cache_creation` split. */
  written1h: number | null;
  /** The 5m share, or null when the response carried no `cache_creation` split. */
  written5m: number | null;
}

/**
 * Detects a cache write that did not get the retention it asked for.
 *
 * This exists because the failure mode is indistinguishable from the bug it
 * fixes: a request that asks for 1h and is served 5m rebuilds its prefix on
 * exactly the same schedule, at exactly the same price, and reports nothing.
 * Bedrock returns both halves of the split on us.anthropic.claude-opus-5, so a
 * downgrade is an observed number rather than an inference -- and an absent
 * split is reported too, because `calculateCost` reads a missing 1h share as
 * zero and would then bill a 1h write at the 5m rate.
 */
const unhonouredRetention = (
  retention: CacheRetention,
  usage: AnthropicUsagePayload,
  written: number,
): CacheRetentionReport | undefined => {
  if (retention !== "long" || written === 0) return undefined;
  const split = usage.cache_creation;
  const written1h = split?.ephemeral_1h_input_tokens ?? null;
  const written5m = split?.ephemeral_5m_input_tokens ?? null;
  if (written1h !== null && written1h > 0) return undefined;
  return { requested: retention, written, written1h, written5m };
};

const applyUsage = (
  output: AssistantMessage,
  usage: AnthropicUsagePayload,
  retention?: CacheRetention,
  onUnhonoured?: (report: CacheRetentionReport) => void,
): void => {
  if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) {
    output.usage.cacheWrite = usage.cache_creation_input_tokens;
  }
  const longWrite = usage.cache_creation?.ephemeral_1h_input_tokens;
  if (longWrite != null) output.usage.cacheWrite1h = longWrite;
  const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
  if (thinkingTokens != null) output.usage.reasoning = thinkingTokens;
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  if (retention && onUnhonoured && usage.cache_creation_input_tokens != null) {
    const report = unhonouredRetention(retention, usage, usage.cache_creation_input_tokens);
    if (report) onUnhonoured(report);
  }
};

export interface ConsumeParams {
  events: AsyncIterable<AnthropicStreamEvent>;
  output: AssistantMessage;
  push: (event: AssistantMessageEvent) => void;
  /** Pi's calculateCost, bound to the model. Called on every usage update. */
  applyCost: () => void;
  /** Pi's parseStreamingJson. */
  parseJson: (partial: string) => JsonObject;
  /** The retention this request asked for, so the response can be held to it. */
  cacheRetention?: CacheRetention;
  /** Called when a cache write did not get the retention it asked for. */
  onUnhonouredCacheRetention?: (report: CacheRetentionReport) => void;
  signal?: AbortSignal;
}

/**
 * Drains `events` into `output`, pushing Pi events as it goes. Throws on a
 * stream error or an error stop reason; the caller owns the error event.
 */
export const consumeAnthropicStream = async ({
  events,
  output,
  push,
  applyCost,
  parseJson,
  cacheRetention,
  onUnhonouredCacheRetention,
  signal,
}: ConsumeParams): Promise<void> => {
  const tracked = new Map<number, TrackedBlock>();
  let started = false;
  let sawMessageStop = false;
  let transformations: AnthropicInputTransformation[] | undefined;

  for await (const event of events) {
    if (signal?.aborted) throw new Error("Request was aborted");

    if (event.type === "error") {
      throw new Error(event.error?.message ?? "Bedrock returned an error event");
    }

    if (event.type === "message_start") {
      if (Array.isArray(event.message?.input_transformations)) {
        transformations = event.message.input_transformations;
      }
      output.responseId = event.message?.id;
      const responseModel = event.message?.model;
      if (responseModel && responseModel !== output.model) output.responseModel = responseModel;
      if (event.message?.usage) {
        applyUsage(output, event.message.usage, cacheRetention, onUnhonouredCacheRetention);
      }
      applyCost();
      if (!started) {
        started = true;
        push({ type: "start", partial: output });
      }
      continue;
    }

    // A proxy or a future model could start emitting blocks without a
    // message_start; the protocol requires "start" before any update.
    if (!started) {
      started = true;
      push({ type: "start", partial: output });
    }

    if (event.type === "content_block_start") {
      const index = event.index ?? output.content.length;
      const block = event.content_block;
      if (!block) continue;

      if (block.type === "text") {
        const content: TextContent = { type: "text", text: block.text ?? "" };
        output.content.push(content);
        tracked.set(index, { contentIndex: output.content.length - 1, partialJson: "" });
        push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
      } else if (block.type === "thinking") {
        const content: ThinkingContent = {
          type: "thinking",
          thinking: block.thinking ?? "",
          thinkingSignature: block.signature ?? "",
        };
        output.content.push(content);
        tracked.set(index, { contentIndex: output.content.length - 1, partialJson: "" });
        push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
      } else if (block.type === "redacted_thinking") {
        // The opaque payload lives in `data` and is the only part worth keeping.
        // Storing it in thinkingSignature is what lets request.ts replay it as a
        // redacted_thinking block on the next turn.
        const content: ThinkingContent = {
          type: "thinking",
          thinking: REDACTED_THINKING_PLACEHOLDER,
          thinkingSignature: block.data ?? "",
          redacted: true,
        };
        output.content.push(content);
        tracked.set(index, { contentIndex: output.content.length - 1, partialJson: "" });
        push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
      } else if (block.type === "tool_use") {
        const content: ToolCall = {
          type: "toolCall",
          id: block.id ?? "",
          name: block.name ?? "",
          arguments: block.input ?? {},
        };
        output.content.push(content);
        tracked.set(index, { contentIndex: output.content.length - 1, partialJson: "" });
        push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
      }
      continue;
    }

    if (event.type === "content_block_delta") {
      const entry = event.index === undefined ? undefined : tracked.get(event.index);
      const delta = event.delta;
      if (!entry || !delta) continue;
      const content = output.content[entry.contentIndex];

      if (delta.type === "text_delta" && content.type === "text") {
        content.text += delta.text ?? "";
        push({
          type: "text_delta",
          contentIndex: entry.contentIndex,
          delta: delta.text ?? "",
          partial: output,
        });
      } else if (delta.type === "thinking_delta" && content.type === "thinking") {
        content.thinking += delta.thinking ?? "";
        push({
          type: "thinking_delta",
          contentIndex: entry.contentIndex,
          delta: delta.thinking ?? "",
          partial: output,
        });
      } else if (delta.type === "signature_delta" && content.type === "thinking") {
        // Signatures arrive after the text and can be chunked. No Pi event maps
        // to this, so it only ever accumulates onto the block.
        content.thinkingSignature = (content.thinkingSignature ?? "") + (delta.signature ?? "");
      } else if (delta.type === "input_json_delta" && content.type === "toolCall") {
        entry.partialJson += delta.partial_json ?? "";
        content.arguments = parseJson(entry.partialJson);
        push({
          type: "toolcall_delta",
          contentIndex: entry.contentIndex,
          delta: delta.partial_json ?? "",
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "content_block_stop") {
      const entry = event.index === undefined ? undefined : tracked.get(event.index);
      if (!entry) continue;
      const content = output.content[entry.contentIndex];
      if (content.type === "text") {
        push({
          type: "text_end",
          contentIndex: entry.contentIndex,
          content: content.text,
          partial: output,
        });
      } else if (content.type === "thinking") {
        push({
          type: "thinking_end",
          contentIndex: entry.contentIndex,
          content: content.thinking,
          partial: output,
        });
      } else {
        content.arguments = entry.partialJson.length > 0 ? parseJson(entry.partialJson) : content.arguments;
        push({
          type: "toolcall_end",
          contentIndex: entry.contentIndex,
          toolCall: content,
          partial: output,
        });
      }
      continue;
    }

    if (event.type === "message_delta") {
      if (Array.isArray(event.input_transformations)) {
        transformations = event.input_transformations;
      }
      const stopReason = event.delta?.stop_reason;
      if (stopReason) {
        output.rawStopReason = stopReason;
        const mapped = mapStopReason(stopReason);
        output.stopReason = mapped.stopReason;
        if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
      }
      if (event.usage) {
        applyUsage(output, event.usage, cacheRetention, onUnhonouredCacheRetention);
      }
      applyCost();
      continue;
    }

    if (event.type === "message_stop") {
      sawMessageStop = true;
      // Bedrock's own accounting rides on the final chunk. Treat it as a
      // backstop for a stream that never reported usage, never as an override:
      // message_delta is the authoritative count and is the only one that
      // splits cache reads from writes.
      const metrics = event["amazon-bedrock-invocationMetrics"];
      if (metrics && output.usage.totalTokens === 0) {
        applyUsage(
          output,
          {
            input_tokens: metrics.inputTokenCount,
            output_tokens: metrics.outputTokenCount,
            cache_read_input_tokens: metrics.cacheReadInputTokenCount,
            cache_creation_input_tokens: metrics.cacheWriteInputTokenCount,
          },
          cacheRetention,
          onUnhonouredCacheRetention,
        );
        applyCost();
      }
    }
  }

  // drop_block is deliberately the quiet failure mode: prompt drift costs
  // reasoning instead of a 400. Quiet is not silent -- without this the first
  // evidence of a prefix that stopped being byte-stable would be an agent that
  // just reasons worse after a resume. Recorded before the outcome checks so a
  // turn that both drifted and failed still reports the drift.
  if (transformations && transformations.length > 0) {
    output.diagnostics = [
      ...(output.diagnostics ?? []),
      {
        type: INPUT_TRANSFORMATIONS_DIAGNOSTIC,
        timestamp: Date.now(),
        details: {
          transformations: transformations.map((transformation) => ({
            type: transformation.type ?? null,
            path: transformation.path ?? null,
            reason: transformation.reason ?? null,
          })),
        },
      },
    ];
  }

  if (signal?.aborted) throw new Error("Request was aborted");

  if (output.stopReason === "pending") {
    throw new Error(
      sawMessageStop
        ? "Bedrock stream stopped without a stop reason"
        : "Bedrock stream ended before message_stop",
    );
  }
  if (output.stopReason === "error" || output.stopReason === "aborted") {
    throw new Error(output.errorMessage || "An unknown error occurred");
  }
};
