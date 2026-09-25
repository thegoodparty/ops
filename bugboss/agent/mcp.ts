// A minimal MCP stdio client, because Pi has no MCP support of its own.
//
// It exists for the Grafana MCP server, whose tools encode real query-building
// knowledge that the model would otherwise have to reinvent as hand-written
// LogQL piped through curl. Tools are exposed to Pi sorted by name: the tools
// array is part of the bound prefix, so a server that enumerates in a
// different order on the next container would invalidate every thinking block
// after the resume.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { truncateOutput, DEFAULT_MAX_TOOL_CHARS } from "./tools";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  requestTimeoutMs?: number;
  maxOutputChars?: number;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolSpec {
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

  const tools = specs.map((spec) => {
    const parameters = Type.Unsafe<Record<string, unknown>>(
      stripSchemaKeyword(spec.inputSchema),
    );
    return {
      name: sanitizeToolName(config.name, spec.name),
      label: spec.name,
      description: `${spec.description ?? spec.name}\n\nOutput is capped at ${maxChars} characters; narrow the query rather than relying on truncation.`,
      parameters,
      execute: async (_toolCallId: string, params: unknown) => {
        const result = await client.request("tools/call", {
          name: spec.name,
          arguments: params ?? {},
        });
        return {
          content: [
            { type: "text" as const, text: truncateOutput(mcpResultToText(result), maxChars) },
          ],
          details: undefined,
        };
      },
    } as unknown as ToolDefinition;
  });

  return { tools, close: () => client.close() };
};
