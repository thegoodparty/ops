// A minimal MCP stdio client, because Pi has no MCP support of its own.
//
// It exists for the Grafana MCP server, whose tools encode real query-building
// knowledge that the model would otherwise have to reinvent as hand-written
// LogQL piped through curl. Tools are exposed to Pi sorted by name: the tools
// array is part of the bound prefix, so a server that enumerates in a
// different order on the next container would invalidate every thinking block
// after the resume.
//
// TWO BOUNDS LIVE HERE, AND BOTH ARE COST BOUNDS. mcp-grafana ships ~80 tools
// and fifteen agents can hold them at once; on 2026-09-28 a third of all Loki
// read volume was ad-hoc MCP queries, 2.06 TB/day from 130 of them, individual
// 30-day reads at 54-149 GB. So the surface is an allowlist and the time range
// has a ceiling. Neither is in the prompt: an instruction is advice, and the
// queries that produced that bill were run by something that had been advised.
//
// The existing output cap does not help with either. It bounds the bytes a
// tool returns; Loki bills the bytes a query scans, and `count_over_time` over
// 30 days returns one number after reading 149 GB.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { makeAlarm, makeLog } from "../logging";
import { truncateOutput, DEFAULT_MAX_TOOL_CHARS } from "./tools";

const log = makeLog("mcp");

const alarm = makeAlarm("mcp");

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  requestTimeoutMs?: number;
  maxOutputChars?: number;
  /** Tool names to expose. Unset exposes whatever the server lists. */
  allowedTools?: readonly string[];
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolset {
  tools: ToolDefinition[];
  close: () => void;
}

export const sanitizeToolName = (serverName: string, toolName: string): string =>
  `${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");

/** typebox rejects a schema carrying $schema, and servers vary on sending it. */
export const stripSchemaKeyword = (
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const base = schema ?? { type: "object", properties: {} };
  const { $schema: _ignored, ...rest } = base as Record<string, unknown>;
  return rest;
};

export const mcpResultToText = (result: unknown): string => {
  const payload = result as { content?: Array<{ type?: string; text?: string }> };
  if (!payload?.content) return JSON.stringify(result ?? null);
  return payload.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join("\n");
};

/**
 * The Grafana tools an incident agent reads with. Every one is a read: logs,
 * metrics, traces, the datasources behind them, and the dashboards that say
 * what somebody already thought was worth watching.
 *
 * Alert *rule* reads are missing on purpose. In mcp-grafana v1.6.1 reading a
 * rule and creating one are the same tool (`alerting_manage_rules`, an
 * `operation` argument), so there is no way to take the read without handing
 * an agent the ability to rewrite production alerting. The alert that opened
 * the incident already arrives in full through `ingress/grafana.ts`, and the
 * rule definitions are checked into omni, so the read is available elsewhere
 * and the write is not available at all.
 */
export const GRAFANA_READ_TOOLS = [
  "analyze_loki_labels",
  "check_datasources_health",
  "get_dashboard_by_uid",
  "get_dashboard_panel_queries",
  "get_dashboard_property",
  "get_dashboard_summary",
  "get_datasource",
  "get_tempo_trace",
  "get_tempo_traceql_docs",
  "list_datasources",
  "list_loki_label_names",
  "list_loki_label_values",
  "list_prometheus_label_names",
  "list_prometheus_label_values",
  "list_prometheus_metric_metadata",
  "list_prometheus_metric_names",
  "list_tempo_attribute_names",
  "list_tempo_attribute_values",
  "query_loki_logs",
  "query_loki_patterns",
  "query_loki_stats",
  "query_prometheus",
  "query_prometheus_histogram",
  "query_tempo_metrics",
  "search_dashboards",
  "search_tempo_traces",
] as const;

/**
 * What the server itself is told, and it is the weaker half of the pair.
 * `--enabled-tools` is **category**-granular, not tool-granular: passing tool
 * names leaves the server with "No tool categories are currently enabled" and
 * `tools/list` answering `tools not supported`, which is why the allowlist
 * above exists in our own code rather than only in this flag.
 *
 * `--disable-write` is what removes create/update/delete inside the categories
 * we do enable, and `--disable-api` removes `grafana_api_request`, which is a
 * raw proxy to every Grafana endpoint and would make the rest of this
 * decorative.
 *
 * The Loki guardrail is the one bound our own clamp cannot express: it counts
 * range-vector durations inside the query, so `count_over_time(…[30d])` inside
 * a 6h window is rejected there and nowhere else. Its byte budget is left at
 * the server default — the range is what the outage gave us a number for, and
 * a byte ceiling nobody sized would fail queries for a reason nobody could
 * defend.
 */
export const GRAFANA_MCP_ARGS = [
  "mcp-grafana",
  "--enabled-tools=loki,prometheus,tempo,datasource,dashboard,search",
  "--disable-write",
  "--disable-api",
  "--disable-rendering",
  "--loki-guardrail-mode=enforce",
  "--loki-guardrail-max-range=24h",
];

/**
 * The alerts these agents work evaluate over ten minutes, so the incident is
 * minutes old: 6h answers "is it still happening, and when did it start", 24h
 * answers "did this happen yesterday too", and nothing in the loop needs a
 * month.
 */
export const DEFAULT_LOOKBACK_HOURS = 6;

export const MAX_LOOKBACK_HOURS = 24;

export interface TimeRangeShape {
  start: string;
  end: string;
}

/**
 * mcp-grafana names its time arguments three ways, read off its own
 * `tools/list` schemas (v1.6.1) rather than guessed:
 *
 * - `startRfc3339`/`endRfc3339` — the Loki tools and the Prometheus metadata
 *   tools. RFC3339 or relative (`now`, `now-1h`).
 * - `startTime`/`endTime` — `query_prometheus`, `query_prometheus_histogram`.
 *   RFC3339 or relative, with units down to `ns`.
 * - `start`/`end` — `search_tempo_traces`, `query_tempo_metrics`. RFC3339.
 *
 * Anything else is not clamped, and that is a decision, not an oversight. The
 * epoch-millisecond `from`/`to` of the annotation tools and the Pyroscope
 * `start_rfc_3339`/`end_rfc_3339` pair are both outside the allowlist, so the
 * agent cannot reach them; adding either to the allowlist means adding its
 * shape here in the same change.
 */
export const TIME_RANGE_SHAPES: readonly TimeRangeShape[] = [
  { start: "startRfc3339", end: "endRfc3339" },
  { start: "startTime", end: "endTime" },
  { start: "start", end: "end" },
];

/** Read from the tool's own schema, so an upstream rename drops the clamp
 * rather than silently renaming an argument the server ignores. */
export const timeRangeShapeFor = (
  schema: Record<string, unknown> | undefined,
): TimeRangeShape | null => {
  const properties = (schema?.properties ?? {}) as Record<string, unknown>;
  return (
    TIME_RANGE_SHAPES.find(
      (shape) => shape.start in properties && shape.end in properties,
    ) ?? null
  );
};

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

const RELATIVE = /^now(?:([+-])((?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d))+))?$/;

const DURATION = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d)/g;

const UNIT_MILLIS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Milliseconds, or null when the value is in a form we cannot reason about. */
export const parseInstant = (value: string, now: number): number | null => {
  const text = value.trim();
  if (RFC3339.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const relative = RELATIVE.exec(text);
  if (!relative) return null;
  if (!relative[1]) return now;
  let delta = 0;
  for (const [, amount, unit] of relative[2].matchAll(DURATION)) {
    delta += Number(amount) * UNIT_MILLIS[unit];
  }
  return relative[1] === "-" ? now - delta : now + delta;
};

const describeSpan = (millis: number): string => {
  const hours = millis / 3_600_000;
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  if (hours >= 1) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.max(1, Math.round(millis / 60_000))}m`;
};

export interface ClampedRange {
  arguments: Record<string, unknown>;
  /** Null when nothing was changed, so an untouched call stays untouched. */
  notice: string | null;
}

/**
 * Bound one call's time range, and say so when it moved. Silence here would be
 * the worst outcome available: an agent that believes it read a month and read
 * a day reports a negative on evidence it never had.
 */
export const clampTimeRange = (
  args: Record<string, unknown>,
  shape: TimeRangeShape,
  now: number,
): ClampedRange => {
  const rawStart = args[shape.start];
  const rawEnd = args[shape.end];
  const givenStart = typeof rawStart === "string" && rawStart.trim() !== "";
  const givenEnd = typeof rawEnd === "string" && rawEnd.trim() !== "";

  const parsedEnd = givenEnd ? parseInstant(rawEnd as string, now) : now;
  const parsedStart = givenStart ? parseInstant(rawStart as string, now) : null;

  const unparseable = [
    ...(givenStart && parsedStart === null ? [`${shape.start}="${rawStart}"`] : []),
    ...(givenEnd && parsedEnd === null ? [`${shape.end}="${rawEnd}"`] : []),
  ];

  // Anchored at `now`, because a window's position bounds what it can find
  // just as its width bounds what it costs. A future end returns nothing,
  // and nothing is the same shape as "the problem stopped" -- so an agent
  // that queried tomorrow would report a negative on evidence it never had.
  const requestedEnd = parsedEnd ?? now;
  const end = Math.min(requestedEnd, now);
  const endWasFuture = requestedEnd > now;
  const defaultStart = end - DEFAULT_LOOKBACK_HOURS * 3_600_000;
  const rewrite = (start: number, why: string): ClampedRange => ({
    arguments: {
      ...args,
      [shape.start]: new Date(start).toISOString(),
      [shape.end]: new Date(end).toISOString(),
    },
    notice: `[bugboss] ${why} The window actually queried is ${new Date(start).toISOString()} to ${new Date(end).toISOString()}. Grafana bills the bytes it scans, not the bytes it returns, so the time range is the cost; ask for a narrower window and more of them rather than one wide one.`,
  });

  if (unparseable.length) {
    return rewrite(
      defaultStart,
      `Could not read ${unparseable.join(" and ")}, so the default ${DEFAULT_LOOKBACK_HOURS}h window was used instead.`,
    );
  }
  if (parsedStart === null) {
    return rewrite(
      defaultStart,
      `No start time was given, so the default ${DEFAULT_LOOKBACK_HOURS}h window was used rather than the server's.`,
    );
  }

  const futureNote = endWasFuture
    ? `The end time you gave is in the future, so it was pulled back to now; a future window matches nothing, which reads the same as a problem that stopped.`
    : "";

  const span = end - Math.min(parsedStart, end);
  if (span > MAX_LOOKBACK_HOURS * 3_600_000) {
    return rewrite(
      end - MAX_LOOKBACK_HOURS * 3_600_000,
      `${futureNote} You asked for ${describeSpan(span)} and the ceiling is ${MAX_LOOKBACK_HOURS}h, so the range was clamped.`.trim(),
    );
  }
  // A start that is also in the future collapses to an empty window once the
  // end is pulled back, so it gets the default rather than an inverted range.
  if (parsedStart >= end) {
    return rewrite(
      defaultStart,
      `${futureNote} The start you gave is not before that, so the default ${DEFAULT_LOOKBACK_HOURS}h window was used instead.`.trim(),
    );
  }
  if (endWasFuture) return rewrite(parsedStart, futureNote);
  return { arguments: args, notice: null };
};

export interface ToolSelection {
  allowed: McpToolSpec[];
  /** Listed by the server, not on the allowlist. Dropped. */
  unexpected: string[];
  /** On the allowlist, not listed by the server. A capability we lost. */
  missing: string[];
}

export const selectAllowedTools = (
  specs: McpToolSpec[],
  allowedTools: readonly string[] | undefined,
): ToolSelection => {
  if (!allowedTools) return { allowed: specs, unexpected: [], missing: [] };
  const allow = new Set(allowedTools);
  const listed = new Set(specs.map((spec) => spec.name));
  return {
    allowed: specs.filter((spec) => allow.has(spec.name)),
    unexpected: specs.filter((spec) => !allow.has(spec.name)).map((spec) => spec.name),
    missing: allowedTools.filter((name) => !listed.has(name)),
  };
};

class StdioClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private config: McpServerConfig,
    private timeoutMs: number,
  ) {
    this.child = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("exit", () => this.failAll(new Error(`${config.name} MCP server exited`)));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.name} MCP ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.failAll(new Error(`${this.config.name} MCP server closed`));
    this.child.kill();
  }
}

export const connectMcpToolset = async (
  config: McpServerConfig,
): Promise<McpToolset> => {
  const { Type } = await import("typebox");
  const timeoutMs = config.requestTimeoutMs ?? 120000;
  const maxChars = config.maxOutputChars ?? DEFAULT_MAX_TOOL_CHARS;
  const client = new StdioClient(config, timeoutMs);

  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bugboss-incident-agent", version: "1" },
  });
  client.notify("notifications/initialized");

  const listed = (await client.request("tools/list")) as { tools?: McpToolSpec[] };
  const specs = [...(listed.tools ?? [])].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  const selection = selectAllowedTools(specs, config.allowedTools);
  // A dropped tool is `log`: the server flag is category-granular, so it over-
  // delivers by design and this line is the filter working. A *missing* one is
  // `alarm`: a tool the agent is supposed to have is gone, which is what an
  // upstream rename, a mistyped category or a version bump looks like, and
  // nothing else in the run would ever mention it — the agent would simply
  // stop being able to read traces and nobody would know why.
  if (selection.unexpected.length) {
    log("mcp_tools_filtered", { server: config.name, tools: selection.unexpected });
  }
  if (selection.missing.length) {
    alarm("mcp_tools_missing", { server: config.name, tools: selection.missing });
  }

  const tools = selection.allowed.map((spec) => {
    const parameters = Type.Unsafe<Record<string, unknown>>(
      stripSchemaKeyword(spec.inputSchema),
    );
    const shape = timeRangeShapeFor(spec.inputSchema);
    const bound = shape
      ? `\n\nTime range defaults to the last ${DEFAULT_LOOKBACK_HOURS}h and is capped at ${MAX_LOOKBACK_HOURS}h; a wider request is clamped and the result says so.`
      : "";
    return {
      name: sanitizeToolName(config.name, spec.name),
      label: spec.name,
      description: `${spec.description ?? spec.name}\n\nOutput is capped at ${maxChars} characters; narrow the query rather than relying on truncation.${bound}`,
      parameters,
      execute: async (_toolCallId: string, params: unknown) => {
        const given = (params ?? {}) as Record<string, unknown>;
        const clamped = shape
          ? clampTimeRange(given, shape, Date.now())
          : { arguments: given, notice: null };
        const result = await client.request("tools/call", {
          name: spec.name,
          arguments: clamped.arguments,
        });
        // Prepended, because truncateOutput keeps the head: a notice at the
        // end is the first thing a long result loses. Its room comes out of
        // the budget rather than on top of it -- the description promises a
        // cap, and a notice added after the truncation is the same defect
        // truncateOutput itself was just fixed for.
        const notice = clamped.notice ? `${clamped.notice}\n\n` : "";
        const text = truncateOutput(
          mcpResultToText(result),
          Math.max(0, maxChars - notice.length),
        );
        return {
          content: [{ type: "text" as const, text: `${notice}${text}` }],
          details: undefined,
        };
      },
    } as unknown as ToolDefinition;
  });

  return { tools, close: () => client.close() };
};
