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
  /** Overrides the catalog's rates. Never a substitute for a catalog entry. */
  cost?: ModelCost;
  overrides?: Partial<BedrockInvokeModelModel>;
}

/**
 * Build a model definition for `id`, taking context window, limits and cost
 * from Pi's Bedrock catalog.
 *
 * A miss throws, and `cost` does not rescue one. It used to: an id the
 * catalog did not know got the caller's rates and a made-up 200,000-token
 * window, on the reasoning that cost was the only thing worth failing over.
 * That reasoning was half right. Failing loudly beats reporting a run that
 * cost zero dollars, and it beats a wrong window for the same reason and
 * more: the Boss derives spend from usage, so a bad rate at least shows up
 * as a number somebody can disbelieve, whereas a window that is wrong in
 * either direction is invisible. Too small and every session compacts away
 * four fifths of a context it was entitled to keep. Too large and the
 * provider rejects a request nothing in the run predicted. The model we
 * actually run, `us.anthropic.claude-opus-5`, carries 1,000,000 -- five
 * times what was substituted here.
 *
 * An application inference profile ARN is the one id that reaches this and
 * misses: its suffix is an opaque generated id rather than a model id, so
 * `catalogIdFor` deliberately does not strip it. Teaching that regex
 * `:application-inference-profile/` would only turn one kind of miss into
 * another while looking fixed -- the stripped suffix still matches nothing.
 * The throw is what protects that case, which is why the ARN goes on the
 * request field and never on `model.id` (see `invokeModelIdFor`).
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
    throw new Error(
      `No Bedrock catalog entry for "${catalogId}", so the context window, ` +
        `token limits and rates for "${id}" are all unknown. Point ` +
        "BUGBOSS_MODEL_ID at a catalog id, or an inference profile ARN whose " +
        "suffix is one.",
    );
  }

  return toInvokeModelModel(entry, { id, ...(cost ? { cost } : {}), ...overrides });
};
