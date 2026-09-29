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

import type { CacheRetention, StreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";

export const BEDROCK_INVOKE_MODEL_API = "bedrock-invoke-model";

/**
 * `thinking.block_binding` is gated behind this beta. Without it Bedrock
 * rejects the whole request with
 * `thinking.adaptive.block_binding: Extra inputs are not permitted`, which is
 * how the InvokeModel provider died on its first turn in prod the night it
 * first actually served a request.
 *
 * Verified against a live InvokeModel call on us.anthropic.claude-opus-5
 * (us-west-2, 2026-09-28): the field is accepted with this beta and rejected
 * without it, and Bedrock validates the beta list, so a stale name here would
 * fail loudly rather than silently do nothing.
 */
export const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";

/**
 * WHY THE 1h TIER IS THE DEFAULT HERE AND NOT PI'S "short":
 *
 * `monitor` and `contact_human` each cost one turn however long they block --
 * that is the mechanism that stops a multi-day incident saturating context on
 * polling. A tool that blocks for ten minutes and then resumes therefore lands
 * the next request outside a 5-minute cache lifetime, and the agent rebuilds
 * its whole ~190k prefix. Measured over seven production incidents: every one
 * of 32 misses followed one of those two tools, no turn with a gap under 216s
 * ever missed, no turn with a gap over 331s ever hit, and the rewrites were
 * 27-41% of each run.
 *
 * A 1h write costs 2x base input against 1.25x for 5m, so the premium is 0.75x
 * base on tokens written. Avoiding one 190k rewrite saves 1.15x base on 190k,
 * which pays that premium on ~291k written tokens -- more than a whole run
 * writes. Break-even is roughly one blocking wait per incident; the measured
 * runs had between two and ten.
 *
 * Pi cannot carry this for us: `cacheRetention` has no path in through
 * `createAgentSession`, and the `PI_CACHE_RETENTION` env fallback is read by
 * Pi's own providers, not by `resolveCacheControl` in ./request.ts.
 */
export const DEFAULT_CACHE_RETENTION: CacheRetention = "long";

/**
 * The one place the default is applied. The body builder and the provider's
 * response check both need the answer, and a check that resolved it separately
 * could hold a request to a retention the body never asked for.
 */
export const resolveCacheRetention = (
  options: Pick<BedrockInvokeModelOptions, "cacheRetention">,
): CacheRetention => options.cacheRetention ?? DEFAULT_CACHE_RETENTION;

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
