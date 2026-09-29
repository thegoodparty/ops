// The Boss's ModelClient, over the same Pi runtime the incident agent streams
// through.
//
// WHY THIS REPLACED A SECOND INVOKEMODEL CALL:
//
// The Boss's bounded calls used to build their own Anthropic body. That is two
// request paths to the same model, and a fix landed on one of them is a fix
// missing from the other -- which is how an absent beta header killed every
// incident agent while triage carried on working, and opened two incidents no
// agent could investigate.
//
// Going through the runtime inherits, rather than reimplements: the
// InvokeModel routing `bedrock/runtime.ts` exists to assert, the 1h cache
// retention and its downgrade check, the lone-surrogate sanitizer, the
// consecutive-tool-result coalescing Anthropic requires, and `calculateCost`
// -- which is what finally puts a number on a triage call.
//
// What it deliberately does not inherit is Pi's agent session. `runStructuredCall`
// owns the loop, because the bound that matters here is an answer a Zod schema
// accepts inside a wall-clock budget, and a session owns a JSONL file, resume
// and compaction instead. Everything below is one request.

import type {
  AssistantMessage,
  Context,
  JsonObject,
  Message,
  Model,
  Tool,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  ModelRequestFailed,
  type ModelClient,
  type ModelToolCall,
  type ModelToolSpec,
  type ModelTurn,
  type ModelUsage,
} from "../model";
import { BEDROCK_INVOKE_MODEL_API, type BedrockInvokeModelApi } from "./options";
import { BEDROCK_PROVIDER_ID } from "./runtime";

/**
 * Stands in for an assistant turn that carries no text and no tool calls.
 *
 * Pi's body builder skips an assistant message whose blocks all came out
 * empty, and the round that follows one is a user turn -- so without a
 * placeholder the transcript hands Anthropic two consecutive user messages
 * and is rejected. That shape is reachable: `runStructuredCall` records the
 * assistant turn before nudging a prose reply back towards the answer tool,
 * and a reply can be empty.
 */
const EMPTY_ASSISTANT_TEXT = "(no reply)";

const toPiTool = (spec: ModelToolSpec): Tool =>
  ({
    name: spec.name,
    description: spec.description,
    // `convertTools` reads `properties` and `required` off this and nothing
    // else, so a JSON Schema literal is passed through as written. Typed as
    // a typebox schema upstream, which a plain object does not satisfy
    // nominally and does satisfy structurally.
    parameters: spec.inputSchema,
  }) as unknown as Tool;

const EMPTY_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Replay our own turn shape as Pi messages.
 *
 * The assistant fields Pi requires and we have nothing to say about -- `api`,
 * `provider`, `model`, `usage` -- are stubbed because the body builder does
 * not read them off a replayed turn; it reads `content`. They exist for a
 * message that came *from* a provider, and these came from this loop.
 */
const toPiMessages = (turns: ModelTurn[]): Message[] =>
  turns.map((turn): Message => {
    if (turn.role === "user") {
      return { role: "user", content: turn.text, timestamp: Date.now() };
    }

    if (turn.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: turn.toolCallId,
        // Anthropic keys a result to its call by id alone, and the loop
        // tracks no name. The body builder does not read this.
        toolName: "",
        content: [{ type: "text", text: turn.text }],
        isError: turn.isError === true,
        timestamp: Date.now(),
      };
    }

    const content: AssistantMessage["content"] = [];
    if (turn.text.trim().length > 0) content.push({ type: "text", text: turn.text });
    for (const call of turn.toolCalls) {
      content.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: call.input as JsonObject,
      });
    }
    if (content.length === 0) content.push({ type: "text", text: EMPTY_ASSISTANT_TEXT });

    return {
      role: "assistant",
      content,
      api: BEDROCK_INVOKE_MODEL_API,
      provider: BEDROCK_PROVIDER_ID,
      model: "",
      usage: EMPTY_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    };
  });

export interface PiModelClientDeps {
  runtime: ModelRuntime;
  model: Model<BedrockInvokeModelApi>;
}

export const createPiModelClient = ({ runtime, model }: PiModelClientDeps): ModelClient => ({
  complete: async (request) => {
    const context: Context = {
      systemPrompt: request.system,
      messages: toPiMessages(request.messages),
      ...(request.tools.length > 0 ? { tools: request.tools.map(toPiTool) } : {}),
    };

    // `maxTokens` is passed on every call on purpose. Pi falls back to
    // `model.maxTokens` when it is absent, which on a resolved Bedrock model
    // is 64000 -- so an omission is not a smaller request, it is a 30x
    // larger one.
    const message = await runtime.complete(model, context, {
      maxTokens: request.maxTokens,
      signal: request.signal,
      // Off, and not by omission.
      //
      // DO NOT "fix" this to match the agent. The shared body builder turns
      // adaptive thinking on for any model whose catalog entry says it
      // reasons, and these calls cannot afford it: triage caps output at 2048
      // tokens and the inbound-language read at 512, so a thinking block can
      // spend the whole budget before the answer tool is reached. The call
      // then falls back, which is silent by design -- so the symptom is
      // triage quality quietly degrading and looking like a bad model rather
      // than like a harness bug. That is the failure nobody diagnoses.
      //
      // The asymmetry with the agent is the point, not an inconsistency. An
      // incident agent reasons for a living across ~90 turns and asks for
      // thinking explicitly; a bounded call that answers with one label does
      // not. It also keeps this path off `thinking.block_binding`, and so off
      // the beta that gates it -- see `request.ts`, where the field and its
      // beta are deliberately one decision.
      thinkingEnabled: false,
    });

    const usage: ModelUsage = {
      tokensIn: message.usage.input,
      tokensOut: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      costUsd: message.usage.cost.total,
      modelId: message.model || model.id,
      calls: 1,
    };

    // A failed request resolves here rather than rejecting: Pi turns a setup
    // failure, a transport error, a missing credential and an abort alike
    // into a terminal event carrying a message with `stopReason: "error"`
    // and zeroed usage. Left unchecked that is an empty reply with no tool
    // calls, which every caller would read as a model that answered in prose
    // and would retry against -- a dead model wearing a healthy one's
    // clothes, which is the one thing triage/CLAUDE.md says must not happen.
    // The tokens are attached to the throw so a call that died still costs
    // what it spent.
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new ModelRequestFailed(
        message.errorMessage ?? `model request ${message.stopReason}`,
        usage,
      );
    }

    let text = "";
    const toolCalls: ModelToolCall[] = [];
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "toolCall") {
        toolCalls.push({ id: block.id, name: block.name, input: block.arguments ?? {} });
      }
    }

    return { text, toolCalls, usage };
  },
});
