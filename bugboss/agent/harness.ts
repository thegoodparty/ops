// The one Pi Durable harness every BugBoss agent runs on, and the one Models
// collection every model call goes through.
//
// ops compiles as CommonJS and every Pi 1.0 entry point is ESM-only, so values
// arrive through one memoized dynamic import and types through `import type`.
// The rest of bugboss imports Pi Durable types from here, not from the
// package, so a moving 1.0 API breaks in one file.

import type { Context } from "@earendil-works/chord";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  Extension,
  Harness,
  HarnessSettings,
  Storage,
  UsageState,
  Conversation,
} from "@earendil-works/pi-durable";

import { type BedrockInvoke, createBedrockInvokeModelProvider } from "../bedrock/index";
import { type InferenceProfiles, invokeModelIdFor, resolveBedrockModel } from "../bedrock/model";
import { assertBedrockInvokeModelRouting, routeBedrockProvider } from "../bedrock/runtime";
import { makeAlarm } from "../logging";

export type { Context } from "@earendil-works/chord";
export type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
export type { Models } from "@earendil-works/pi-ai/models";
export type {
  AgentChange,
  ContextView,
  Conversation,
  ConversationDocToken,
  ConversationId,
  EntryId,
  EntryRecord,
  Extension,
  Harness,
  HarnessSettings,
  HookApi,
  InboxState,
  ModelRef,
  SettledSubmissionRecord,
  Storage,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
  Tx,
  UsageState,
} from "@earendil-works/pi-durable";

export interface PiRuntime {
  durable: typeof import("@earendil-works/pi-durable");
  tools: typeof import("@earendil-works/pi-durable/tools");
  nodeEnv: typeof import("@earendil-works/pi-durable/env/node");
  sqlite: typeof import("@earendil-works/pi-durable/storage/sqlite/node");
  ai: typeof import("@earendil-works/pi-ai");
  context: Context;
}

let loading: Promise<PiRuntime> | null = null;

export const loadPi = (): Promise<PiRuntime> => {
  loading ??= (async () => {
    const [durable, tools, nodeEnv, sqlite, ai, chord] = await Promise.all([
      import("@earendil-works/pi-durable"),
      import("@earendil-works/pi-durable/tools"),
      import("@earendil-works/pi-durable/env/node"),
      import("@earendil-works/pi-durable/storage/sqlite/node"),
      import("@earendil-works/pi-ai"),
      import("@earendil-works/chord/context"),
    ]);
    return { durable, tools, nodeEnv, sqlite, ai, context: chord.BACKGROUND_CONTEXT };
  })();
  // A failed load must not be memoized, or one bad boot poisons every retry.
  loading.catch(() => {
    loading = null;
  });
  return loading;
};

export interface BugbossModels {
  models: Models;
  agent: Model<Api>;
  boss: Model<Api>;
  intent: Model<Api> | null;
  goal: Model<Api> | null;
}

export const createBugbossModels = async (cfg: {
  agentModelId: string;
  bossModelId: string;
  intentModelId?: string;
  goalModelId?: string;
  inferenceProfiles?: InferenceProfiles;
  invoke?: BedrockInvoke;
}): Promise<BugbossModels> => {
  const [{ createModels }, { amazonBedrockProvider }] = await Promise.all([
    import("@earendil-works/pi-ai/models"),
    import("@earendil-works/pi-ai/providers/amazon-bedrock"),
  ]);

  const resolved = new Map<string, Model<Api>>();
  const resolve = async (id: string): Promise<Model<Api>> => {
    const existing = resolved.get(id);
    if (existing) return existing;
    const entry = await resolveBedrockModel({ id });
    resolved.set(id, entry);
    return entry;
  };

  const agent = await resolve(cfg.agentModelId);
  const boss = await resolve(cfg.bossModelId);
  const intent = cfg.intentModelId ? await resolve(cfg.intentModelId) : null;
  // The gates are a check on the agent, not a dependency of it: an evaluator
  // that cannot be built leaves them unjudged rather than stopping every
  // incident from being worked.
  let goal: Model<Api> | null = null;
  if (cfg.goalModelId) {
    try {
      goal = await resolve(cfg.goalModelId);
    } catch (err: unknown) {
      makeAlarm("agent")("goal_model_unavailable", { modelId: cfg.goalModelId, error: String(err) });
    }
  }

  const invokeModel = await createBedrockInvokeModelProvider({
    ...(cfg.invoke ? { invoke: cfg.invoke } : {}),
    invokeModelIdFor: invokeModelIdFor(cfg.inferenceProfiles ?? {}),
  });
  const provider = routeBedrockProvider(amazonBedrockProvider(), invokeModel, [
    ...resolved.values(),
  ]);

  const models = createModels();
  models.setProvider(provider);
  for (const entry of resolved.values()) assertBedrockInvokeModelRouting(models, entry);

  return { models, agent, boss, intent, goal };
};

export interface OpenHarnessOptions {
  storage: Storage;
  models: Models;
  extensions: readonly Extension[];
  shellEnv: (conversationId: ConversationId) => Record<string, string>;
  settings?: HarnessSettings;
  onReport: (error: unknown) => void;
}

export interface BugbossHarness {
  readonly harness: Harness;
  readonly context: Context;
  readonly pi: PiRuntime;
  conversation(id: ConversationId): Promise<Conversation>;
  isBusy(id: ConversationId): Promise<boolean>;
  usage(id: ConversationId): Promise<UsageState>;
  /** Model responses that count against a budget: a failed or aborted attempt does not. */
  countTurns(id: ConversationId): Promise<number>;
  onCommit(listener: () => void): () => void;
  close(): Promise<void>;
}

const ENTRY_PAGE = 500;

/** Oldest first, from `from` (inclusive) when given, the whole history otherwise. */
export const allEntries = async (
  conversation: Conversation,
  context: Context,
  from?: EntryId,
): Promise<EntryRecord[]> => {
  const newestFirst: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries(
      from === undefined ? {} : { minEntryId: from },
      ENTRY_PAGE,
      cursor,
      context,
    );
    newestFirst.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return newestFirst.reverse();
};

export const openBugbossHarness = async (options: OpenHarnessOptions): Promise<BugbossHarness> => {
  const pi = await loadPi();
  const { durable, nodeEnv, context } = pi;

  const registry = durable.createRegistry();
  for (const extension of options.extensions) registry.install(extension);

  const harness = await durable.Harness.open(
    options.storage,
    {
      models: options.models,
      registry,
      ...(options.settings ? { settings: options.settings } : {}),
      // A conversation without a cwd (the Boss's) gets no shell at all.
      env: (target) => {
        if (target.cwd === undefined) return undefined;
        const shellEnv = options.shellEnv(target.conversationId);
        const env = new nodeEnv.NodeExecutionEnv({ cwd: target.cwd, shellEnv });
        // NodeExecutionEnv only applies `shellEnv` on top of process.env, and
        // drops it entirely under `inheritEnv: false`. Either way a tool that
        // forgot the flag would hand BUGBOSS_SECRETS to the agent's shell, so
        // every exec is forced onto the allowlist here, once, for all tools.
        const exec = env.exec.bind(env);
        env.exec = (command, execOptions, ctx) =>
          exec(
            command,
            { ...execOptions, inheritEnv: false, env: { ...shellEnv, ...execOptions?.env } },
            ctx,
          );
        return env;
      },
      onReport: options.onReport,
    },
    context,
  );

  const conversation = async (id: ConversationId): Promise<Conversation> => {
    const found = await harness.conversation(id, context);
    if (!found) throw new Error(`no harness conversation ${id}`);
    return found;
  };

  return {
    harness,
    context,
    pi,
    conversation,

    isBusy: async (id) => {
      const live = await harness.snapshot(durable.LiveDoc, id, context);
      return live?.run !== undefined;
    },

    usage: async (id) =>
      (await harness.snapshot(durable.UsageDoc, id, context)) ?? { models: {}, tools: {} },

    countTurns: async (id) =>
      (await allEntries(await conversation(id), context)).filter((entry) => {
        if (entry.kind !== "pi.assistant") return false;
        const message = entry.model?.[0] as { stopReason?: string } | undefined;
        return message?.stopReason !== "error" && message?.stopReason !== "aborted";
      }).length,

    onCommit: (listener) => harness.subscribeCommits(() => listener()),

    close: () => harness.close(context),
  };
};
