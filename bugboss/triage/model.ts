// The bounded agentic loop the Boss's own calls run in.
//
// The model seam itself lives in ../model.ts, beside types.ts, because four
// modules in three directories build against it. What is here is the loop:
// the answer-tool-plus-schema contract, its retry, and its bounds.

import { makeLog } from "../logging";
import type { ZodType } from "zod";
import {
  addModelUsage,
  ModelRequestFailed,
  type ModelClient,
  type ModelReply,
  type ModelToolSpec,
  type ModelTurn,
  type ModelUsage,
} from "../model";

export type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelToolCall,
  ModelToolSpec,
  ModelTurn,
  ModelUsage,
  SizedModelClient,
} from "../model";
export { addModelUsage, emptyModelUsage, ModelRequestFailed, usageForLog } from "../model";

/** A tool the loop executes itself, rather than handing back to the caller. */
export interface LoopTool {
  spec: ModelToolSpec;
  run(input: Record<string, unknown>): Promise<string> | string;
}

export interface StructuredCall<T> {
  model: ModelClient;
  system: string;
  prompt: string;
  /** The tool the model calls to finish. Its input is the answer. */
  answer: { spec: ModelToolSpec; schema: ZodType<T> };
  tools: LoopTool[];
  budgetMs: number;
  maxRounds: number;
  /** Invalid answers tolerated before the call gives up. */
  maxInvalid: number;
  maxTokens: number;
  /**
   * Added to in place as each request returns, including the request that
   * throws. Optional so a caller that does not record spend need not carry
   * one; every caller in the Boss does.
   */
  usage?: ModelUsage;
}

const log = makeLog("triage");

const withDeadline = async <T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} exceeded ${ms}ms`)),
          Math.max(ms, 1),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Tolerates a fenced block or prose around the object. */
const parseJsonObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const issuesOf = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");

/**
 * One bounded agentic call: the model may use `tools` to look things up, and
 * finishes by calling the answer tool with something the schema accepts.
 *
 * Throws on timeout, transport failure or an answer that stays invalid. Every
 * caller here treats a throw as the signal to take its conservative default,
 * which is what makes these calls advisory rather than load-bearing.
 */
export const runStructuredCall = async <T>(call: StructuredCall<T>): Promise<T> => {
  const deadline = Date.now() + call.budgetMs;
  const controller = new AbortController();
  const budgetTimer = setTimeout(
    () => controller.abort(new Error("budget exhausted")),
    call.budgetMs,
  );

  const messages: ModelTurn[] = [{ role: "user", text: call.prompt }];
  const tools = [call.answer.spec, ...call.tools.map((t) => t.spec)];
  let invalid = 0;

  try {
    for (let round = 0; round < call.maxRounds; round++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("budget exhausted before an answer");

      let reply: ModelReply;
      const pending = call.model.complete({
        system: call.system,
        messages: [...messages],
        tools,
        maxTokens: call.maxTokens,
        signal: controller.signal,
      });

      // The deadline below races this promise, so when it wins the request is
      // still in flight and its tokens are not known yet. They were still
      // spent, so they are banked if and when they arrive. Best effort by
      // construction: the throw propagates immediately and a caller reading
      // the total in its own catch may read it before this lands. Better a
      // figure that is sometimes late than one that is reliably short, and
      // the alternative -- dropping the racing backstop and trusting the
      // abort signal alone -- trades a known undercount for an unbounded
      // hang if a provider ever stops honouring it.
      pending.catch((err: unknown) => {
        if (call.usage && err instanceof ModelRequestFailed) {
          addModelUsage(call.usage, err.usage);
        }
      });

      try {
        reply = await withDeadline(pending, remaining, "model call");
      } catch (err) {
        // Nothing to bank here: a ModelRequestFailed was already taken by the
        // handler above, and a deadline error carries no usage of its own.
        // Rethrown so every caller keeps taking its conservative default.
        throw err;
      }
      if (call.usage) addModelUsage(call.usage, reply.usage);

      messages.push({
        role: "assistant",
        text: reply.text,
        toolCalls: reply.toolCalls,
      });

      if (reply.toolCalls.length === 0) {
        const parsed = parseJsonObject(reply.text);
        const checked = parsed ? call.answer.schema.safeParse(parsed) : null;
        if (checked?.success) return checked.data;
        invalid++;
        if (invalid > call.maxInvalid) {
          throw new Error(`no valid ${call.answer.spec.name} after ${invalid} tries`);
        }
        log("answer_not_a_tool_call", { round });
        messages.push({
          role: "user",
          text: `Answer by calling the ${call.answer.spec.name} tool. Do not reply in prose.`,
        });
        continue;
      }

      for (const toolCall of reply.toolCalls) {
        if (toolCall.name === call.answer.spec.name) {
          const checked = call.answer.schema.safeParse(toolCall.input);
          if (checked.success) return checked.data;
          invalid++;
          if (invalid > call.maxInvalid) {
            throw new Error(
              `invalid ${call.answer.spec.name} input: ${issuesOf(checked.error)}`,
            );
          }
          log("invalid_answer", { round, issues: issuesOf(checked.error) });
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            isError: true,
            text: `Invalid input: ${issuesOf(checked.error)}. Call ${call.answer.spec.name} again with a valid input.`,
          });
          continue;
        }

        const tool = call.tools.find((t) => t.spec.name === toolCall.name);
        if (!tool) {
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            isError: true,
            text: `Unknown tool ${toolCall.name}. Available: ${tools.map((t) => t.name).join(", ")}.`,
          });
          continue;
        }

        try {
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            text: await tool.run(toolCall.input),
          });
        } catch (err) {
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            isError: true,
            text: `Tool failed: ${String(err)}`,
          });
        }
      }
    }

    throw new Error(`no answer within ${call.maxRounds} rounds`);
  } finally {
    clearTimeout(budgetTimer);
  }
};
