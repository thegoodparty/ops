// Builds the native Anthropic Messages body we hand to Bedrock InvokeModel.
//
// Design spec: docs/bugboss/design.md, "Model and provider" and
// "Why InvokeModel is not optional" under "Harness: Pi".
//
// The one rule the whole resume design rests on: an assistant thinking block
// that carries a signature is replayed verbatim, even when its text is empty.
// Bedrock Converse drops exactly that block (bedrock-converse-stream.ts:1022),
// which is the shape Opus 5 and Sonnet 5 return under adaptive thinking.

import type {
  CacheRetention,
  JsonObject,
  Message,
  Model,
  SystemMessage,
  Tool,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

import type { BedrockInvokeModelApi, BedrockInvokeModelOptions } from "./options";

export const ANTHROPIC_BEDROCK_VERSION = "bedrock-2023-05-31";

export interface CacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
  cache_control?: CacheControl;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonObject;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: (AnthropicTextBlock | AnthropicImageBlock)[];
  is_error?: boolean;
  cache_control?: CacheControl;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: JsonObject; required: string[] };
  cache_control?: CacheControl;
}

export interface AnthropicThinkingConfig {
  type: "adaptive";
  display: "summarized" | "omitted";
  block_binding?: { prefix_mismatch_behavior: "drop_block" };
}

export interface InvokeModelBody {
  anthropic_version: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: AnthropicTextBlock[];
  tools?: AnthropicToolDefinition[];
  tool_choice?: { type: string; name?: string };
  thinking?: AnthropicThinkingConfig;
  output_config?: { effort: string };
  temperature?: number;
  anthropic_beta?: string[];
  metadata?: { user_id: string };
}

/** The subset of a typebox schema an Anthropic input_schema needs. */
interface ObjectSchema {
  properties?: JsonObject;
  required?: string[];
}

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Lone surrogates survive in tool output (raw log lines, mostly) and make the
// JSON body unserializable for the service. Same regex Pi applies on every
// other provider path; inlined to keep this module free of async imports.
const sanitize = (text: string): string =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

export const resolveCacheControl = (
  retention: CacheRetention | undefined,
): CacheControl | undefined => {
  if (retention === "none") return undefined;
  return retention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
};

const convertToolResultContent = (
  message: ToolResultMessage,
): (AnthropicTextBlock | AnthropicImageBlock)[] => {
  const blocks = message.content.map((item) =>
    item.type === "text"
      ? ({ type: "text", text: sanitize(item.text) } as AnthropicTextBlock)
      : ({
          type: "image",
          source: {
            type: "base64",
            media_type: IMAGE_MIME_TYPES.includes(item.mimeType) ? item.mimeType : "image/png",
            data: item.data,
          },
        } as AnthropicImageBlock),
  );
  const nonEmpty = blocks.filter((b) => b.type !== "text" || b.text.trim().length > 0);
  // Anthropic rejects a tool_result with no content, and a tool that returned
  // nothing is a normal outcome rather than an error worth failing the turn for.
  return nonEmpty.length > 0 ? nonEmpty : [{ type: "text", text: "(no output)" }];
};

export const convertMessages = (
  messages: Message[],
  cacheControl: CacheControl | undefined,
): AnthropicMessage[] => {
  const result: AnthropicMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "system") continue;

    if (message.role === "user") {
      const blocks: AnthropicContentBlock[] =
        typeof message.content === "string"
          ? [{ type: "text", text: sanitize(message.content) }]
          : message.content.map((item) =>
              item.type === "text"
                ? ({ type: "text", text: sanitize(item.text) } as AnthropicTextBlock)
                : ({
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: IMAGE_MIME_TYPES.includes(item.mimeType)
                        ? item.mimeType
                        : "image/png",
                      data: item.data,
                    },
                  } as AnthropicImageBlock),
            );
      const nonEmpty = blocks.filter((b) => b.type !== "text" || b.text.trim().length > 0);
      if (nonEmpty.length === 0) continue;
      result.push({ role: "user", content: nonEmpty });
      continue;
    }

    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({ type: "text", text: sanitize(block.text) });
          continue;
        }

        if (block.type === "thinking") {
          // Redacted reasoning is an opaque payload, never reasoning text. Keying
          // the branch off block.type alone would serialize it as a thinking block
          // and lose it; Pi shipped that bug once.
          if (block.redacted) {
            const data = block.thinkingSignature;
            if (data && data.length > 0) blocks.push({ type: "redacted_thinking", data });
            continue;
          }
          const signature = block.thinkingSignature;
          // A signature with empty text is the Opus 5 / Sonnet 5 adaptive shape,
          // and the signature is the part that has to survive. Only a block with
          // neither text nor signature carries nothing worth replaying.
          if (signature && signature.length > 0) {
            blocks.push({ type: "thinking", thinking: sanitize(block.thinking), signature });
            continue;
          }
          // No signature means the block cannot be replayed as reasoning (an
          // aborted stream, say). Keep the words as text rather than 400 on it.
          if (block.thinking.trim().length > 0) {
            blocks.push({ type: "text", text: sanitize(block.thinking) });
          }
          continue;
        }

        blocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments ?? {},
        });
      }
      if (blocks.length === 0) continue;
      result.push({ role: "assistant", content: blocks });
      continue;
    }

    // Anthropic requires every consecutive tool result in one user message.
    const toolResults: AnthropicContentBlock[] = [];
    let j = i;
    while (j < messages.length && messages[j].role === "toolResult") {
      const toolResult = messages[j] as ToolResultMessage;
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolResult.toolCallId,
        content: convertToolResultContent(toolResult),
        ...(toolResult.isError ? { is_error: true } : {}),
      });
      j++;
    }
    i = j - 1;
    result.push({ role: "user", content: toolResults });
  }

  // Only ever breakpoint a trailing user turn. A breakpoint on a trailing
  // assistant message buys nothing and bills a cache write for a prefix the
  // next request extends anyway.
  const last = result[result.length - 1];
  if (cacheControl && last && last.role === "user") {
    const lastBlock = last.content[last.content.length - 1];
    if (
      lastBlock &&
      (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
    ) {
      lastBlock.cache_control = cacheControl;
    }
  }

  return result;
};

export const convertTools = (
  tools: Tool[],
  cacheControl: CacheControl | undefined,
): AnthropicToolDefinition[] =>
  tools.map((tool, index) => {
    const schema = tool.parameters as ObjectSchema;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      },
      ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
    };
  });

export interface BuildBodyInput {
  model: Model<BedrockInvokeModelApi>;
  messages: Message[];
  initialSystemMessage: SystemMessage | undefined;
  systemText: string;
  tools: Tool[];
  options: BedrockInvokeModelOptions;
}

export const buildInvokeModelBody = ({
  model,
  messages,
  systemText,
  tools,
  options,
}: BuildBodyInput): InvokeModelBody => {
  const cacheControl = resolveCacheControl(options.cacheRetention);

  const body: InvokeModelBody = {
    anthropic_version: ANTHROPIC_BEDROCK_VERSION,
    max_tokens: options.maxTokens ?? model.maxTokens,
    messages: convertMessages(messages, cacheControl),
  };

  if (systemText.length > 0) {
    body.system = [
      {
        type: "text",
        text: sanitize(systemText),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      },
    ];
  }

  if (tools.length > 0) body.tools = convertTools(tools, cacheControl);

  if (options.toolChoice) {
    body.tool_choice =
      typeof options.toolChoice === "string"
        ? { type: options.toolChoice }
        : { type: "tool", name: options.toolChoice.name };
  }

  if (model.reasoning && options.thinkingEnabled !== false) {
    // Adaptive only. budget_tokens is deprecated on 4.6 and 400s on 4.7+, and
    // every model this provider targets is 5-series.
    body.thinking = {
      type: "adaptive",
      display: options.thinkingDisplay ?? "summarized",
      // A resumed agent rebuilds its prompt and tool array, so a block bound to
      // the old prefix should cost reasoning rather than throw a 400 and wedge
      // the relaunch loop.
      ...(options.prefixMismatchBehavior === "error"
        ? {}
        : { block_binding: { prefix_mismatch_behavior: "drop_block" } }),
    };
    if (options.effort) body.output_config = { effort: options.effort };
  }

  // Temperature is rejected alongside extended thinking.
  if (options.temperature !== undefined && !body.thinking) {
    body.temperature = options.temperature;
  }

  if (options.betas && options.betas.length > 0) body.anthropic_beta = options.betas;

  const userId = options.metadata?.user_id;
  if (typeof userId === "string") body.metadata = { user_id: userId };

  return body;
};
