import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  isRefusal,
  type Trace,
  type Ttl,
  type Turn,
  type Usage,
} from "../trace";

/**
 * Reads the model proxy's JSONL log (`sim/proxy/`) into Traces. The proxy
 * sees Anthropic Messages bodies on Bedrock InvokeModel and nothing about the
 * harness that sent them, so this adapter keeps working when Pi is replaced,
 * provided the replacement still speaks that protocol.
 */

export type ProxyOutcome =
  | "ok"
  | "budget_throttled"
  | "refused"
  | "upstream_error"
  | "upstream_unreachable"
  | "stream_exception"
  | "client_aborted";

export interface ProxyUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  /**
   * False when the response carried no `cache_creation` split. The proxy
   * then prices the whole write at the 1h rate, an upper bound, so the budget
   * never under-counts.
   */
  split: boolean;
}

export interface ProxyCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type AssembledBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      /** Set when the streamed input did not parse as JSON; `input` is then the raw string. */
      inputUnparsed?: boolean;
    }
  | { type: string; [key: string]: unknown };

export interface AssembledMessage {
  id: string;
  model: string;
  content: AssembledBlock[];
  stopReason: string | null;
}

export interface ProxyLogRecord {
  v: 1;
  seq: number;
  requestId: string;
  startedAt: number;
  endedAt: number;
  operation: "invoke" | "invoke-with-response-stream" | "unknown";
  /** The model id as it appeared on the wire, which may be an ARN. */
  modelId: string;
  /** The id priced through PRICE_TABLE; empty when the request was refused before pricing. */
  model: string;
  outcome: ProxyOutcome;
  status: number;
  error: { type: string; message: string } | null;
  /** The request body, parsed. A body that is not JSON is kept as its text. */
  request: unknown;
  response: {
    message: AssembledMessage | null;
    invocationMetrics: Record<string, number> | null;
    /** The body of a non-2xx upstream response, verbatim. */
    errorBody: string | null;
  };
  usage: ProxyUsage;
  cost: ProxyCost;
  spendUsdAfter: number;
  budgetUsd: number;
}

type Json = Record<string, unknown>;

const blocksOf = (content: unknown): Json[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Json[]) : [];
};

const textOf = (content: unknown): string =>
  blocksOf(content)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");

const systemTextOf = (system: unknown): string => textOf(system);

const hasCacheTtl1h = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasCacheTtl1h);
  if (value && typeof value === "object") {
    const object = value as Json;
    const control = object.cache_control as Json | undefined;
    if (control?.ttl === "1h") return true;
    return Object.values(object).some(
      (child) => typeof child === "object" && hasCacheTtl1h(child),
    );
  }
  return false;
};

const requestTtl = (body: Json): Ttl =>
  hasCacheTtl1h([body.system, body.tools, body.messages]) ? "1h" : "5m";

const isToolResultMessage = (message: Json): boolean =>
  blocksOf(message.content).some((block) => block.type === "tool_result");

export const conversationKey = (body: Json): string => {
  const toolNames = ((body.tools as Json[] | undefined) ?? []).map((tool) =>
    String(tool.name),
  );
  return createHash("sha256")
    .update(JSON.stringify([systemTextOf(body.system), toolNames]))
    .digest("hex");
};

const toUsage = (record: ProxyLogRecord): Usage => ({
  input: record.usage.input,
  output: record.usage.output,
  cacheRead: record.usage.cacheRead,
  cacheWrite: record.usage.cacheWrite,
  cacheWrite1h: record.usage.split
    ? record.usage.cacheWrite1h
    : record.usage.cacheWrite,
  cost: { ...record.cost },
});

interface Conversation {
  trace: Trace;
  byCallId: Map<string, Turn>;
  lastTail: string | null;
  launch: number;
}

/**
 * One Trace per conversation, ordered by first request. A conversation is
 * keyed on its system prompt and tool names, so every request an agent makes
 * lands in one trace across resume and compaction, while the Boss's triage,
 * intent and commander calls land in their own. Two agents with an identical
 * prompt and toolset would share a trace; BugBoss's incident prompt names its
 * incident, so they do not.
 *
 * A launch is counted where Pi's session adapter counts one: a request whose
 * last message is a new user message with no tool result. A retry of the same
 * request repeats the tail and is not a launch. The proxy sees no process
 * exits, so `exits` is always empty.
 */
export const parseProxyLog = (jsonl: string): Trace[] => {
  const records = jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProxyLogRecord)
    .sort((a, b) => a.seq - b.seq);

  const conversations = new Map<string, Conversation>();
  for (const record of records) {
    if (!record.request || typeof record.request !== "object") continue;
    const body = record.request as Json;
    const messages = (body.messages as Json[] | undefined) ?? [];
    const key = conversationKey(body);
    let conversation = conversations.get(key);
    if (!conversation) {
      conversation = {
        trace: {
          id: `proxy-${key.slice(0, 12)}`,
          startedAt: record.startedAt,
          model: record.model,
          systemPrompt: systemTextOf(body.system),
          toolNames: ((body.tools as Json[] | undefined) ?? []).map((tool) =>
            String(tool.name),
          ),
          turns: [],
          exits: [],
          launches: 1,
        },
        byCallId: new Map(),
        lastTail: null,
        launch: 0,
      };
      conversations.set(key, conversation);
    }

    const tail = messages[messages.length - 1];
    const tailJson = tail ? JSON.stringify(tail) : null;
    if (
      conversation.lastTail !== null &&
      tail &&
      tail.role === "user" &&
      !isToolResultMessage(tail) &&
      tailJson !== conversation.lastTail
    ) {
      conversation.launch += 1;
    }
    conversation.lastTail = tailJson;
    conversation.trace.launches = conversation.launch + 1;

    for (const message of messages) {
      if (message.role !== "user") continue;
      for (const block of blocksOf(message.content)) {
        if (block.type !== "tool_result") continue;
        const callId = String(block.tool_use_id);
        const owner = conversation.byCallId.get(callId);
        if (!owner || owner.results.some((r) => r.toolCallId === callId)) {
          continue;
        }
        const call = owner.toolCalls.find((c) => c.id === callId);
        const text = textOf(block.content);
        const isError = block.is_error === true;
        owner.results.push({
          toolCallId: callId,
          toolName: call?.name ?? "",
          text,
          isError,
          refused: isRefusal(text, isError),
        });
      }
    }

    const usage = toUsage(record);
    const message = record.response.message;
    const failed = record.outcome !== "ok";
    const turn: Turn = {
      index: conversation.trace.turns.length + 1,
      id: record.requestId || String(record.seq),
      startedAt: record.startedAt,
      model: record.model || record.modelId,
      cacheTtl:
        record.usage.cacheWrite > 0
          ? usage.cacheWrite1h > 0
            ? "1h"
            : "5m"
          : requestTtl(body),
      stopReason: failed ? "error" : String(message?.stopReason ?? ""),
      error: failed
        ? record.error
          ? `${record.error.type}: ${record.error.message}`
          : record.outcome
        : null,
      usage,
      toolCalls: (message?.content ?? [])
        .filter((block) => block.type === "tool_use")
        .map((block) => {
          const input = (block as { input: unknown }).input;
          return {
            id: String((block as { id: unknown }).id),
            name: String((block as { name: unknown }).name),
            args:
              input && typeof input === "object" && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : {},
          };
        }),
      results: [],
      launch: conversation.launch,
    };
    for (const call of turn.toolCalls) conversation.byCallId.set(call.id, turn);
    conversation.trace.turns.push(turn);
  }
  return [...conversations.values()].map((conversation) => conversation.trace);
};

export const readProxyLog = async (path: string): Promise<Trace[]> =>
  parseProxyLog(await readFile(path, "utf8"));
