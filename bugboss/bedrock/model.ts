// Model definitions for the InvokeModel api id.
//
// Because we register a new api id rather than overriding the builtin (see
// ./options.ts), a model has to be re-pointed at it. Pi's published package
// ships the hydrated catalog at dist/providers/data/amazon-bedrock.json -- it
// is gitignored in Pi's repo but generated at publish time -- so the real
// Bedrock rates for every anthropic.* id are available and we reuse them
// rather than hardcoding prices that go stale.

import type { Model, ModelCost } from "@earendil-works/pi-ai";

import { BEDROCK_INVOKE_MODEL_API, type BedrockInvokeModelApi } from "./options";

export { DEFAULT_MODEL_ID } from "./defaults";

export type BedrockInvokeModelModel = Model<BedrockInvokeModelApi>;

/** `arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-opus-5` */
const INFERENCE_PROFILE_ARN = /^arn:aws(?:-[a-z0-9-]+)?:bedrock:[a-z0-9-]+:\d+:inference-profile\/(.+)$/;

/** The catalog is keyed by inference profile id, so an ARN resolves via its suffix. */
export const catalogIdFor = (modelId: string): string => {
  const match = modelId.match(INFERENCE_PROFILE_ARN);
  return match ? match[1] : modelId;
};

export const regionFromModelId = (modelId: string): string | undefined => {
  const match = modelId.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
  return match ? match[1] : undefined;
};

// ---------------------------------------------------------------------------
// Application inference profiles
// ---------------------------------------------------------------------------

/**
 * Model id to application inference profile ARN, as the task definition
 * carries it.
 *
 * Bedrock puts no request-level cost tag on InvokeModel. The one mechanism
 * AWS offers is an application inference profile: a tagged wrapper you pass
 * as `modelId`, whose usage then shows up under those tags in Cost Explorer.
 * That is the only way to check the local price table against a real
 * invoice, which is the whole reason cost is an estimate everywhere else.
 *
 * A map rather than a single ARN because the model is runtime-configurable
 * through `BUGBOSS_MODEL_ID` and retunes from SSM without a deploy. A model
 * nobody wrapped has to keep working; it just loses the attribution.
 */
export type InferenceProfiles = Readonly<Record<string, string>>;

/**
 * Parse the map, or throw.
 *
 * Throwing is for the composition root, which parses at boot so a typo stops
 * the container where somebody is watching. The agent path never throws --
 * see `invokeModelIdFor`.
 */
export const parseInferenceProfiles = (raw: string | undefined): InferenceProfiles => {
  if (!raw || raw.trim() === "") return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "BUGBOSS_INFERENCE_PROFILES must be a JSON object of model id to profile ARN",
    );
  }
  const out: Record<string, string> = {};
  for (const [modelId, arn] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof arn !== "string" || arn === "") {
      throw new Error(
        `BUGBOSS_INFERENCE_PROFILES["${modelId}"] must be a non-empty profile ARN`,
      );
    }
    out[modelId] = arn;
  }
  return out;
};

/**
 * The id to put on the wire for `modelId`.
 *
 * Falls back to the bare model id, never throws, and never warns twice: an
 * unrecognised model must lose cost attribution, not lose the agent. It is
 * the request field only -- `model.id` stays the logical id, so the session
 * prefix, the pinned-model check and the stored `modelId` are all untouched
 * and a run that predates a profile resumes on the same value it was signed
 * against.
 */
export const invokeModelIdFor =
  (profiles: InferenceProfiles) =>
  (modelId: string): string =>
    profiles[modelId] ?? modelId;

export const toInvokeModelModel = (
  model: Model<string>,
  overrides: Partial<BedrockInvokeModelModel> = {},
): BedrockInvokeModelModel => {
  const { compat: _compat, ...rest } = model;
  return { ...rest, api: BEDROCK_INVOKE_MODEL_API, ...overrides };
};

export interface ResolveBedrockModelInput {
  /** Inference profile id, base model id, or an inference profile ARN. */
  id: string;
  /** Required only when the id resolves to no catalog entry. */
  cost?: ModelCost;
  overrides?: Partial<BedrockInvokeModelModel>;
}

/**
 * Build a model definition for `id`, taking context window, limits and cost
 * from Pi's Bedrock catalog when it knows the id.
 *
 * An application inference profile ARN has an opaque suffix that maps to no
 * catalog entry, so `cost` has to be supplied for one. Failing loudly beats
 * reporting a run that cost zero dollars: the Boss derives spend from usage.
 */
export const resolveBedrockModel = async ({
  id,
  cost,
  overrides = {},
}: ResolveBedrockModelInput): Promise<BedrockInvokeModelModel> => {
  const { getBuiltinModels } = await import("@earendil-works/pi-ai/providers/all");
  const catalogId = catalogIdFor(id);
  const entry = getBuiltinModels("amazon-bedrock").find((model) => model.id === catalogId);

  if (!entry) {
    if (!cost) {
      throw new Error(
        `No Bedrock catalog entry for "${catalogId}"; pass explicit cost rates for "${id}"`,
      );
    }
    return {
      id,
      name: id,
      api: BEDROCK_INVOKE_MODEL_API,
      provider: "amazon-bedrock",
      baseUrl: "",
      reasoning: true,
      input: ["text", "image"],
      cost,
      contextWindow: 200000,
      maxTokens: 64000,
      ...overrides,
    };
  }

  return toInvokeModelModel(entry, { id, ...(cost ? { cost } : {}), ...overrides });
};
