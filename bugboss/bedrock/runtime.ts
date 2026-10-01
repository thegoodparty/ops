// Wiring the InvokeModel provider into the agent's model runtime.
//
// WHY THIS FILE EXISTS -- registering the api provider does not route anything.
//
// ./index.ts claims the api id "bedrock-invoke-model" in pi-ai's api-provider
// registry, and ./model.ts stamps that id onto the model. Neither is what
// picks an implementation, because nothing in the path ever reads the
// registry:
//
//   1. pi-coding-agent streams through ModelRuntime, which looks a provider up
//      by `model.provider` -- "amazon-bedrock" -- never by `model.api`.
//   2. ModelRuntime.recomposeProvider() installs the builtin *untouched*
//      whenever a provider id has no models.json entry and no registered
//      extension, which is exactly our configuration. composeModelProvider(),
//      the only code that ever calls getApiProvider(model.api), is never built.
//   3. The builtin is createProvider({ api: bedrockConverseStreamApi() }). Given
//      one api rather than a map, createProvider serves it to every model and
//      never reads model.api at all.
//
// So a model carrying "bedrock-invoke-model" streamed Converse, and could not
// report it: createProvider's only "no API implementation for ..." error
// belongs to the multi-api branch that a single-api provider never takes. The
// agent ran for days on the provider this module exists to avoid, losing the
// thinking signatures that resume replays.
//
// Registering a native provider for "amazon-bedrock" puts the dispatch back
// where model.api can be honoured, and leaves the catalog, auth and refresh
// behaviour to the builtin we wrap.

import type {
  Api,
  ApiStreamOptions,
  AssistantMessageEventStream,
  Model,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ApiProvider } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  registerBedrockInvokeModelProvider,
  type CreateBedrockInvokeModelProviderOptions,
} from "./index";
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
 */
export const routeBedrockProvider = (
  builtin: Provider,
  invokeModel: BedrockInvokeModelApiProvider,
): Provider => {
  const provider: Provider = {
    ...builtin,
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

export interface RegisterBedrockRoutingOptions extends CreateBedrockInvokeModelProviderOptions {
  runtime: ModelRuntime;
}

/**
 * Install the router on `runtime`. Idempotent, so a second call cannot wrap a
 * router in another router and leave the builtin unreachable.
 */
export const registerBedrockRouting = async ({
  runtime,
  invoke,
  invokeModelIdFor,
  idleTimeoutMs,
  incidentId,
}: RegisterBedrockRoutingOptions): Promise<Provider> => {
  const builtin = runtime.getProvider(BEDROCK_PROVIDER_ID);
  if (!builtin) {
    throw new Error(
      `Pi has no "${BEDROCK_PROVIDER_ID}" provider to wrap; the InvokeModel provider has nothing to attach to`,
    );
  }
  if (routers.has(builtin)) return builtin;

  // Both registrations, one provider instance. The api-registry entry is not
  // what routes us today -- see the header -- but it is what getApiProvider()
  // would find if a models.json entry for "amazon-bedrock" ever pushed this
  // provider id down composeModelProvider()'s path instead.
  const invokeModel = await registerBedrockInvokeModelProvider({
    invoke,
    invokeModelIdFor,
    idleTimeoutMs,
    incidentId,
  });
  const provider = routeBedrockProvider(builtin, invokeModel);
  runtime.registerNativeProvider(provider);

  const installed = runtime.getProvider(BEDROCK_PROVIDER_ID);
  if (installed !== provider) {
    // recomposeProvider() can fall back to the previous provider when a
    // composition step throws, and does so without raising. Left unchecked
    // that is the same silent Converse fallback this module exists to end.
    throw new Error(
      `Pi did not keep the InvokeModel router for "${BEDROCK_PROVIDER_ID}"; it recomposed the provider instead`,
    );
  }
  return provider;
};

/**
 * Throw unless `runtime` will stream `model` through this module.
 *
 * Called before the session starts, because the alternative is discovering it
 * from a transcript afterwards -- which is how this went unnoticed. A run on
 * Converse produces no error of its own: it just quietly drops every thinking
 * block whose text is empty, and the agent cannot resume its own session.
 */
export const assertBedrockInvokeModelRouting = (
  runtime: ModelRuntime,
  model: Model<Api>,
): void => {
  if (model.api !== BEDROCK_INVOKE_MODEL_API) {
    throw new Error(
      `Model "${model.id}" carries api "${model.api}", not "${BEDROCK_INVOKE_MODEL_API}"; Converse would drop its thinking signatures`,
    );
  }
  const provider = runtime.getProvider(model.provider);
  if (!provider) {
    throw new Error(`Pi has no provider "${model.provider}" for model "${model.id}"`);
  }
  if (!routers.has(provider)) {
    throw new Error(
      `Provider "${model.provider}" is Pi's builtin, not the bugboss InvokeModel router; model "${model.id}" would stream over Converse`,
    );
  }
};
