// Spike: BugBoss's two agents on one Pi Durable harness.
//
// Nothing outside this directory imports it. It exists to answer whether
// Pi Durable can replace the session sync, the child-process dispatcher, the
// directive watcher and the commander's own loop, by running the shapes those
// replace against the real library. See README.md for what each test proves.

import { appendFileSync } from "node:fs";

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  InboxDoc,
  section,
  type ConversationId,
  type EntryId,
  type Storage,
} from "@earendil-works/pi-durable";

export const context = BACKGROUND_CONTEXT;

export interface SpikeProbes {
  /** Called when `monitor` starts, before it blocks. */
  monitorStarted?: () => void;
  /** Appended one line per `slow_query` execution, so a parent process can count reruns. */
  executionLog?: string;
  /** How long `monitor` blocks when nothing interrupts it. */
  monitorMs?: number;
  /** How long `slow_query` blocks, by query. */
  slowQueryMs?: (query: string) => number;
}

const sleep = (ms: number, ctx: Context): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    ctx.abortSignal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export const openSpikeHarness = async (
  storage: Storage,
  models: Models,
  probes: SpikeProbes = {},
): Promise<{
  harness: Harness;
  incident: ReturnType<typeof defineExtension>;
  boss: ReturnType<typeof defineExtension>;
}> => {
  // The incident agent's tools, cut to the two shapes that matter for
  // durability: a read that is safe to repeat, and a blocking wait that is not.
  const incident = defineExtension({
    name: "bugboss.incident",
    sections: [section("role", () => "You are the BugBoss incident agent.", { tag: false })],
    tools: [
      defineTool({
        name: "slow_query",
        description: "Run a read-only log query",
        parameters: Type.Object({ query: Type.String() }),
        replay: "safe",
        execute: async (args, _api, ctx) => {
          if (probes.executionLog) appendFileSync(probes.executionLog, `slow_query ${args.query}\n`);
          await sleep(probes.slowQueryMs?.(args.query) ?? 0, ctx);
          return { content: [{ type: "text", text: `0 errors matching ${args.query}` }] };
        },
      }),
      defineTool({
        name: "monitor",
        description: "Block until a deploy settles or the Boss says something",
        parameters: Type.Object({ what: Type.String() }),
        execute: async (args, api, ctx) => {
          probes.monitorStarted?.();
          // The replacement for createWaitInterrupt: the wait ends as soon as
          // anything is queued for this conversation, so a steer is placed at
          // the next tool boundary instead of after the full wait.
          const inbox = await api.watchDoc(InboxDoc, api.conversationId, ctx);
          const queued = (value: { items: readonly unknown[] } | null | undefined) =>
            (value?.items.length ?? 0) > 0;
          const interrupted = await new Promise<boolean>((resolve) => {
            const finish = (value: boolean) => {
              clearTimeout(timer);
              void inbox?.stop();
              resolve(value);
            };
            const timer = setTimeout(() => finish(false), probes.monitorMs ?? 60_000);
            if (queued(inbox?.value)) return finish(true);
            inbox?.start(async (value) => {
              if (queued(value)) finish(true);
            });
          });
          return {
            content: [
              {
                type: "text",
                text: interrupted
                  ? `stopped watching ${args.what}: the Boss sent a message`
                  : `${args.what} settled`,
              },
            ],
          };
        },
      }),
    ],
  });

  // The commander's write path to an agent. Today this is a pending_directive
  // row, a 10s poll in the child and session.steer(); here it is one submit.
  const boss = defineExtension({
    name: "bugboss.boss",
    sections: [section("role", () => "You are the BugBoss commander.", { tag: false })],
    tools: [
      defineTool({
        name: "message_agent",
        description: "Tell the incident agent something",
        parameters: Type.Object({ conversation: Type.String(), message: Type.String() }),
        replay: "safe",
        execute: async (args, api, ctx) => {
          const target = await api.conversation(Number(args.conversation) as ConversationId, ctx);
          if (!target) throw new Error(`no incident conversation ${args.conversation}`);
          await target.submit(
            {
              type: "input",
              content: `The Boss says: ${args.message}`,
              whenBusy: "steer",
              requestId: `boss:${api.taskId}`,
            },
            ctx,
          );
          return { content: [{ type: "text", text: "delivered" }] };
        },
      }),
    ],
  });

  const registry = createRegistry();
  registry.install(incident);
  registry.install(boss);
  const harness = await Harness.open(storage, { models, registry, settings: { toolExecution: "parallel" } }, context);
  harness.resume();
  return { harness, incident, boss };
};

export const answerText = async (
  harness: Harness,
  conversationId: ConversationId,
  answer: EntryId,
): Promise<string> => {
  const conversation = await harness.conversation(conversationId, context);
  const entry = await conversation!.commit((tx) => tx.entry(AssistantEntry, answer), context);
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  return (message?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
};
