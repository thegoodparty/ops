import { readFile } from "node:fs/promises";

import type { Trace, Ttl, Turn, Usage } from "../trace";

/**
 * Reads the model proxy's JSONL log (`sim/model-proxy/`) into a Trace. The
 * proxy sees Anthropic Messages bodies, on Bedrock InvokeModel or on the
 * Anthropic API, and nothing about the system that sent them. So this is the
 * one trace source that works for any runtime under test.
 */

export type ProxyUpstream = "bedrock" | "anthropic";

export type ProxyOperation = "invoke" | "invoke-with-response-stream" | "messages" | "unknown";

export type ProxyOutcome =
  | "ok"
  | "cap_exceeded"
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
   * then prices the whole write at the 1h rate, an upper bound, so a cap
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
  upstream: ProxyUpstream;
  operation: ProxyOperation;
  /** The model id as it appeared on the wire: a Bedrock ARN or id, or the Anthropic model field. */
  modelId: string;
  /** The id the price table was asked for; empty when the request was refused before pricing. */
  model: string;
  /** False when no rates were known for the model, so `cost` is zero and not a measurement. */
  priced: boolean;
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
  capUsd: number | null;
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

const hasCacheTtl1h = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasCacheTtl1h);
  if (value && typeof value === "object") {
    const object = value as Json;
    const control = object.cache_control as Json | undefined;
    if (control?.ttl === "1h") return true;
    return Object.values(object).some((child) => typeof child === "object" && hasCacheTtl1h(child));
  }
  return false;
};

const requestTtl = (body: Json): Ttl => (hasCacheTtl1h([body.system, body.tools, body.messages]) ? "1h" : "5m");

const toUsage = (record: ProxyLogRecord): Usage => ({
  input: record.usage.input,
  output: record.usage.output,
  cacheRead: record.usage.cacheRead,
  cacheWrite: record.usage.cacheWrite,
  cacheWrite1h: record.usage.split ? record.usage.cacheWrite1h : record.usage.cacheWrite,
  cost: { ...record.cost },
});

const toolCallsOf = (message: AssembledMessage | null) =>
  (message?.content ?? [])
    .filter((block) => block.type === "tool_use")
    .map((block) => {
      const input = (block as { input: unknown }).input;
      return {
        id: String((block as { id: unknown }).id),
        name: String((block as { name: unknown }).name),
        args: input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
      };
    });

/**
 * One Trace, every request in order. The proxy cannot tell which agent or
 * process sent a request, and the eval no longer asks: turns, tool calls and
 * cost are measured over the whole system. `launch` is always 0 and `exits`
 * empty for the same reason.
 */
export const parseProxyLog = (jsonl: string): Trace => {
  const records = jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProxyLogRecord)
    .sort((a, b) => a.seq - b.seq);

  const first = records.find((record) => record.request && typeof record.request === "object");
  const firstBody = (first?.request ?? {}) as Json;
  const trace: Trace = {
    id: "proxy",
    startedAt: records[0]?.startedAt ?? 0,
    model: first?.model || first?.modelId || "",
    systemPrompt: textOf(firstBody.system),
    toolNames: ((firstBody.tools as Json[] | undefined) ?? []).map((tool) => String(tool.name)),
    turns: [],
    exits: [],
    launches: records.length > 0 ? 1 : 0,
  };

  for (const record of records) {
    const body = record.request && typeof record.request === "object" ? (record.request as Json) : {};
    const usage = toUsage(record);
    const failed = record.outcome !== "ok";
    const turn: Turn = {
      index: trace.turns.length + 1,
      id: record.requestId || String(record.seq),
      startedAt: record.startedAt,
      model: record.model || record.modelId,
      cacheTtl: record.usage.split && record.usage.cacheWrite1h > 0 ? "1h" : requestTtl(body),
      stopReason: failed ? "error" : String(record.response.message?.stopReason ?? ""),
      error: failed ? (record.error ? `${record.error.type}: ${record.error.message}` : record.outcome) : null,
      usage,
      toolCalls: toolCallsOf(record.response.message),
      results: [],
      launch: 0,
    };
    trace.turns.push(turn);
  }
  return trace;
};

export const tracesFromProxyLog = async (logPath: string): Promise<Trace[]> => {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (text.trim() === "") return [];
  return [parseProxyLog(text)];
};
