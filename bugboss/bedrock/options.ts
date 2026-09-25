// The api id and request options for the Bedrock InvokeModel provider.
//
// WHY A NEW API ID RATHER THAN OVERRIDING "bedrock-converse-stream":
//
// Overriding the builtin is possible -- registerBuiltInApiProviders() only
// registers an id that is unclaimed, and registerApiProvider() overwrites
// unconditionally -- and it would keep Pi's 165 catalog models pointed here for
// free. We do not do it, for two reasons.
//
// 1. This provider sends the *native Anthropic* message body. That body is
//    valid only for anthropic.* model ids. The "bedrock-converse-stream" id
//    also covers Nova, Llama, Mistral and DeepSeek in Pi's catalog, and
//    hijacking the id would break every one of them in-process.
// 2. The override would not reliably take effect anyway. pi-coding-agent's
//    provider-composer prefers `base.stream()` whenever the builtin provider
//    declares any model with that api id, and only falls through to
//    getApiProvider() otherwise. A distinct api id is what actually routes a
//    model through the registry.
//
// The cost is that model definitions must carry this api id, which is what
// toInvokeModelModel() in ./model.ts is for. We have to pin the inference
// profile id and cost rates per Layer 3 of the design anyway.

import type { StreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";

export const BEDROCK_INVOKE_MODEL_API = "bedrock-invoke-model";

export type BedrockInvokeModelApi = typeof BEDROCK_INVOKE_MODEL_API;

export type BedrockEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface BedrockInvokeModelOptions extends StreamOptions {
  /** Overrides the region derived from the model id or the environment. */
  region?: string;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  /** Adaptive-thinking effort. Omitted lets the model pick its own default. */
  effort?: BedrockEffort;
  /**
   * "omitted" returns empty thinking text while the signature still travels.
   * Cheaper time-to-first-token, and safe here precisely because this provider
   * preserves a signature-only block.
   */
  thinkingDisplay?: "summarized" | "omitted";
  /** Set false to send no thinking config at all. */
  thinkingEnabled?: boolean;
  /**
   * "drop_block" (the default) trades a stale thinking block for reasoning
   * instead of a 400. "error" surfaces the mismatch, which is only useful when
   * you are debugging prefix drift.
   */
  prefixMismatchBehavior?: "drop_block" | "error";
  /** anthropic_beta entries, e.g. context-editing betas. */
  betas?: string[];
}

export const mapThinkingLevelToEffort = (
  level: ThinkingLevel | undefined,
  thinkingLevelMap: Partial<Record<string, string | null>> | undefined,
): BedrockEffort => {
  const mapped = level ? thinkingLevelMap?.[level] : undefined;
  if (typeof mapped === "string") return mapped as BedrockEffort;
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return "high";
  }
};
