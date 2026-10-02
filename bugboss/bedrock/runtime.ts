// Wiring the InvokeModel provider into the Models collection every BugBoss
// model call goes through.
//
// WHY THIS FILE EXISTS -- an api id on a model does not route anything.
//
// ./model.ts stamps "bedrock-invoke-model" onto the model. Nothing in Pi's
// request path reads that to pick an implementation:
//
//   1. Models looks a provider up by `model.provider` -- "amazon-bedrock" --
//      never by `model.api`.
//   2. The builtin is createProvider({ api: bedrockConverseStreamApi() }). Given
//      one api rather than a map, createProvider serves it to every model and
//      never reads model.api at all.
//   3. Pi Durable does not stream the model object we resolved. It stores a
//      `{ provider, modelId }` ref and resolves it from the provider's own
//      catalog through `models.getModel()`, and the builtin catalog stamps
//      Converse on every entry. So even a correct router is handed a Converse
//      model unless the catalog it serves carries ours.
//
// So a model carrying "bedrock-invoke-model" streamed Converse, and could not
// report it: createProvider's only "no API implementation for ..." error
// belongs to the multi-api branch that a single-api provider never takes. The
// agent ran for days on the provider this module exists to avoid, losing the
// thinking signatures that resume replays.
//
// The router below puts the dispatch back where model.api can be honoured,
// serves our resolved models in place of the builtin's entries, and leaves
// auth to the builtin we wrap.

import type {
  Api,
  ApiStreamOptions,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ApiProvider } from "@earendil-works/pi-ai/compat";
import type { Models, Provider } from "@earendil-works/pi-ai/models";

import {
  BEDROCK_INVOKE_MODEL_API,
  type BedrockInvokeModelApi,
  type BedrockInvokeModelOptions,
} from "./options";

export const BEDROCK_PROVIDER_ID = "amazon-bedrock";

export type BedrockInvokeModelApiProvider = ApiProvider<
  BedrockInvokeModelApi,
  BedrockInvokeModelOptions
>;

// Identity, not a name or a flag: the assertion below has to prove the runtime
// holds *this* object, and a provider rebuilt from the builtin would copy any
// marker we wrote into it.
const routers = new WeakSet<Provider>();

/**
 * Wrap `builtin` so the api implementation is chosen per model rather than
 * once for the whole provider. Anything that is not ours keeps reaching
 * Converse, which still owns Nova, Llama, Mistral and DeepSeek in Pi's
 * Bedrock catalog.
 *
 * `ours` replaces the builtin catalog entry with the same id, and is added
 * when the builtin has none (an inference profile ARN is never a catalog id).
 * Without it a conversation that names our model by id resolves the
 * builtin's Converse-stamped entry, and the router hands it straight back to
 * Converse.
 */
export const routeBedrockProvider = (
  builtin: Provider,
  invokeModel: BedrockInvokeModelApiProvider,
  ours: readonly Model<Api>[] = [],
): Provider => {
  const byId = new Map(ours.map((model) => [model.id, model]));
  const provider: Provider = {
    ...builtin,
    getModels: () => {
      const catalog = builtin.getModels().map((model) => byId.get(model.id) ?? model);
      const listed = new Set(catalog.map((model) => model.id));
      return [...catalog, ...ours.filter((model) => !listed.has(model.id))];
    },
    stream: <T extends Api>(
      model: Model<T>,
      context: TranscriptContext,
      options?: ApiStreamOptions<T>,
    ): AssistantMessageEventStream =>
      model.api === BEDROCK_INVOKE_MODEL_API
        ? invokeModel.stream(
            model as Model<BedrockInvokeModelApi>,
            context,
            options as BedrockInvokeModelOptions | undefined,
          )
        : builtin.stream(model, context, options),
    streamSimple: (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream =>
      model.api === BEDROCK_INVOKE_MODEL_API
        ? invokeModel.streamSimple(model as Model<BedrockInvokeModelApi>, context, options)
        : builtin.streamSimple(model, context, options),
  };
  routers.add(provider);
  return provider;
};

/**
 * Throw unless `models` will stream `model` through this module.
 *
 * Called before the session starts, because the alternative is discovering it
 * from a transcript afterwards -- which is how this went unnoticed. A run on
 * Converse produces no error of its own: it just quietly drops every thinking
 * block whose text is empty, and the agent cannot resume its own session.
 */
export const assertBedrockInvokeModelRouting = (models: Models, model: Model<Api>): void => {
  if (model.api !== BEDROCK_INVOKE_MODEL_API) {
    throw new Error(
      `Model "${model.id}" carries api "${model.api}", not "${BEDROCK_INVOKE_MODEL_API}"; Converse would drop its thinking signatures`,
    );
  }
  const provider = models.getProvider(model.provider);
  if (!provider) {
    throw new Error(`Pi has no provider "${model.provider}" for model "${model.id}"`);
  }
  if (!routers.has(provider)) {
    throw new Error(
      `Provider "${model.provider}" is Pi's builtin, not the bugboss InvokeModel router; model "${model.id}" would stream over Converse`,
    );
  }
  // What the harness will actually stream, since it resolves a model ref by
  // id from the catalog rather than using the object we hold.
  const served = models.getModel(model.provider, model.id);
  if (served?.api !== BEDROCK_INVOKE_MODEL_API) {
    throw new Error(
      `Provider "${model.provider}" serves model "${model.id}" with api "${served?.api ?? "none"}", not "${BEDROCK_INVOKE_MODEL_API}"; a conversation that names it would stream over Converse`,
    );
  }
};
