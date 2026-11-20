import { z } from "zod";
import type { ModelMessage } from "ai";
import type { TokenUsage } from "./types";

// What crosses the pipes between `runAgent` (the parent) and the call layer (the
// child), and nothing about how it is carried.
//
// The split is the security boundary the plan records ("The credential boundary
// is a process boundary, and the harness choice is orthogonal"): the worker holds
// the whole `DELEGATES` bundle and `/proc/self/environ` is its own environ in
// process, so the model call **and** the tools that read files run in a child
// holding only what `agentEnv()` allowed across. What stays on the parent side is
// every decision — the caps, the abort, the logging, the pricing — because a cap
// the child enforces is a cap a bug in the child can raise.
//
// Three channels, all newline-delimited JSON:
//
//   stdin   parent → child: the spec on the first line, then one
//           `ParentResponse` per request the child made.
//   stdout  child → parent: `step` and `request` events as they happen, and the
//           `result` last.
//   stderr  child → parent: whatever the runtime printed, for a failure message.
//
// Subagents are the reason there is a request channel at all. A subagent has its
// own model, its own caps and its own spend, so it has to go through `runAgent`
// rather than be spawned by the child: otherwise the orchestrator's run would
// hold a subtree of spend it never priced, and a subagent's tokens would land in
// the orchestrator's budget with no way to tell which model produced them.

/**
 * The agent's prompt, its history and its bounds, sent to the child first.
 *
 * Serialised rather than passed in argv: a review prompt is large and argv has a
 * size limit, and a spec on stdin cannot be read out of `/proc/<pid>/cmdline` by
 * a tool that escaped the checkout.
 */
export type ChildSpec = {
  model: string;
  systemPrompt: string;
  /** The initial user message, or the whole history on a repair turn. */
  messages: ModelMessage[];
  /** The checkout every path-carrying tool is confined to. */
  root: string;
  /** Subagents this run may spawn. Each is its own `runAgent` call, made by the parent. */
  subagents?: Record<string, { description: string; prompt: string}>;
  /** Present when the answer must be a structured object. A JSON Schema. */
  output?: { schema: unknown };
  /**
   * The tools the model may call, by name. The child builds only the families
   * this names and answers any other name without executing it, so the declared
   * list is the ceiling. The guards are a second, independent ceiling.
   */
  allowedTools: string[];
  /**
   * The guards, as data (`GuardSpec` in `guards.ts`). Sent rather than applied by
   * the parent because the tool that opens the file is the child's, and a guard
   * that ran somewhere else would be a guard that could not see what was opened.
   */
  guards: unknown[];
  /**
   * How many model calls the child may make. The *cooperative* bound: the parent
   * counts the same steps off the stream and kills the child when either cap
   * fires, so a child that ignored this changes nothing about enforcement.
   */
  maxSteps: number;
};

/**
 * One request from the child, answered by the parent as a `ParentResponse` on
 * the child's stdin. Paired by `id`.
 */
export type ChildRequest = { type: "request"; id: number; name: string; prompt: string };

export type ParentResponse =
  | { type: "response"; id: number; ok: true; output: string }
  | { type: "response"; id: number; ok: false; error: string };

/** One tool call the model made, with what the tool answered. */
export type ChildToolCall = {
  toolName: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
};

/**
 * One line of the child's stream.
 *
 * `step` is written as each model call finishes so the parent can price it while
 * the run continues, which is what makes the spend cap an enforcement rather than
 * a post-mortem: a run that has spent its budget is killed before it can spend
 * more, and the parent is the one holding the rate table.
 */
export type ChildStepEvent = {
  type: "step";
  stepNumber: number;
  /** The AI SDK's prompt total, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  finishReason: string;
  text: string;
  toolCalls: ChildToolCall[];
};

export type ChildEvent =
  | ChildStepEvent
  | ChildRequest
  | { type: "result"; result: ChildResult };

export type ChildSuccess = {
  ok: true;
  /** The final text; empty when the call ended in a structured object. */
  output: string;
  structuredOutput?: unknown;
  /** Tokens this child's own model calls spent. A subagent's are the parent's, not this. */
  usage: TokenUsage;
  steps: number;
  /** Every tool call, in order, with what each answered. */
  toolCalls: ChildToolCall[];
  /** The whole conversation, so a repair turn continues it rather than restarting. */
  messages: ModelMessage[];
};

export type ChildFailure = {
  ok: false;
  error: string;
  /** The AI SDK's own error name, or one of this repo's for a process-level failure. */
  errorName: string;
  /**
   * Whether a re-prompt with the validation error could help. True only for the
   * "answered the wrong shape" case (`TypeValidationError`); false for a
   * truncated response, a network error or an abort, which asking again will not
   * fix.
   */
  repairable: boolean;
  usage?: TokenUsage;
  steps: number;
  toolCalls: ChildToolCall[];
  messages: ModelMessage[];
};

export type ChildResult = ChildSuccess | ChildFailure;

/** The spec, validated at the child end so a malformed one fails loudly rather than partly. */
export const ChildSpecSchema = z.object({
  model: z.string().min(1),
  systemPrompt: z.string(),
  messages: z.array(z.unknown()),
  root: z.string().min(1),
  subagents: z.record(z.string(), z.object({ description: z.string(), prompt: z.string() })).optional(),
  output: z.object({ schema: z.unknown() }).optional(),
  allowedTools: z.array(z.string()),
  guards: z.array(z.unknown()),
  // A cap of 0 would be a run that cannot answer; the contract's default is 50
  // and every agent that raises it raises it upward.
  maxSteps: z.number().int().positive(),
});

/** Parse one line of the child's stream. `undefined` for a blank or unparseable line. */
export const parseChildEvent = (line: string): ChildEvent | undefined => {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const type = (parsed as { type?: unknown }).type;
  return type === "step" || type === "request" || type === "result" ? (parsed as ChildEvent) : undefined;
};

/** Parse one line of a response from the parent. */
export const parseParentResponse = (line: string): ParentResponse | undefined => {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return (parsed as { type?: unknown }).type === "response" ? (parsed as ParentResponse) : undefined;
};
