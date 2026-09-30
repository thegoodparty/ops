// The persona's model seam. Its calls do not go through the counting proxy:
// the proxy measures BugBoss, and a persona's spend in the same trace would
// be charged to whichever variant happened to be talking to it. So this
// client counts its own usage, and the run reports it on its own line.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export type UserBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

export type PersonaMessage =
  | { role: "user"; content: UserBlock[] }
  | { role: "assistant"; content: AssistantBlock[] };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Completion {
  content: AssistantBlock[];
  usage: Usage;
}

export interface PersonaModel {
  /** The Bedrock model id, which is what the price table is keyed on. */
  id: string;
  complete(request: {
    system: string;
    messages: PersonaMessage[];
    tools: ToolSpec[];
  }): Promise<Completion>;
}

const ALIASES: Record<string, string> = {
  opus: "us.anthropic.claude-opus-5",
  sonnet: "us.anthropic.claude-sonnet-5",
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
};

/** A scenario names a model by alias or by Bedrock id. */
export const resolvePersonaModelId = (name: string): string => {
  if (ALIASES[name]) return ALIASES[name];
  if (name.includes(".")) return name;
  throw new Error(
    `persona model ${JSON.stringify(name)} is neither an alias (${Object.keys(ALIASES).join(", ")}) nor a Bedrock model id`,
  );
};

const toBedrock = (m: PersonaMessage): Message => ({
  role: m.role,
  content: m.content.map((b): ContentBlock => {
    if (b.type === "text") return { text: b.text };
    if (b.type === "tool_use") {
      return {
        toolUse: {
          toolUseId: b.id,
          name: b.name,
          input: b.input as ContentBlock.ToolUseMember["toolUse"]["input"],
        },
      };
    }
    return {
      toolResult: {
        toolUseId: b.toolUseId,
        content: [{ text: b.content }],
        status: b.isError ? "error" : "success",
      },
    };
  }),
});

export const createBedrockPersonaModel = (args: {
  model: string;
  region?: string;
  maxTokens?: number;
  client?: BedrockRuntimeClient;
}): PersonaModel => {
  const id = resolvePersonaModelId(args.model);
  const client =
    args.client ?? new BedrockRuntimeClient({ region: args.region ?? "us-west-2" });
  return {
    id,
    complete: async ({ system, messages, tools }) => {
      const res = await client.send(
        new ConverseCommand({
          modelId: id,
          system: [{ text: system }],
          messages: messages.map(toBedrock),
          toolConfig: {
            tools: tools.map((t) => ({
              toolSpec: {
                name: t.name,
                description: t.description,
                inputSchema: {
                  json: t.inputSchema as NonNullable<
                    NonNullable<ContentBlock.ToolUseMember["toolUse"]>["input"]
                  >,
                },
              },
            })),
          },
          inferenceConfig: { maxTokens: args.maxTokens ?? 4096 },
        }),
      );
      const content: AssistantBlock[] = [];
      for (const block of res.output?.message?.content ?? []) {
        if (block.text !== undefined) content.push({ type: "text", text: block.text });
        if (block.toolUse) {
          content.push({
            type: "tool_use",
            id: block.toolUse.toolUseId ?? "",
            name: block.toolUse.name ?? "",
            input: (block.toolUse.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      return {
        content,
        usage: {
          input: res.usage?.inputTokens ?? 0,
          output: res.usage?.outputTokens ?? 0,
          cacheRead: res.usage?.cacheReadInputTokens ?? 0,
          cacheWrite: res.usage?.cacheWriteInputTokens ?? 0,
        },
      };
    },
  };
};
