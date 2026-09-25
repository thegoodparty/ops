// The model seam for the Boss's own bounded calls: triage (Job 2) and
// root-cause correlation (Job 2b). Design spec: bugboss/docs/architecture.md.
//
// The interface is deliberately smaller than any SDK's -- one call, tools in,
// text and tool calls out. Two reasons. These calls run inside the Boss
// process on a wall-clock budget, so they must not inherit a harness's
// session, resume and streaming machinery; and the end-to-end test has to
// substitute a fake without standing up Bedrock.

import { makeLog } from "../logging";
import type { ZodType } from "zod";

export interface ModelToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ModelTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ModelToolCall[] }
  | { role: "toolResult"; toolCallId: string; text: string; isError?: boolean };

export interface ModelRequest {
  system: string;
  messages: ModelTurn[];
  tools: ModelToolSpec[];
  maxTokens: number;
  /** Aborted when the call's wall-clock budget runs out. */
  signal: AbortSignal;
}

export interface ModelReply {
  text: string;
  toolCalls: ModelToolCall[];
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelReply>;
}

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

      const reply = await withDeadline(
        call.model.complete({
          system: call.system,
          messages: [...messages],
          tools,
          maxTokens: call.maxTokens,
          signal: controller.signal,
        }),
        remaining,
        "model call",
      );

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
