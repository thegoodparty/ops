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
