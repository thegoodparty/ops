import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

export type McpServerConfig = NonNullable<Options["mcpServers"]>[string];

export type AgentConfig = {
  name: string;
  systemPrompt: string;
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: Options["permissionMode"];
  agents?: Options["agents"];
  tools?: Options["tools"];
  outputFormat?: Options["outputFormat"];
};

export type RunOverrides = {
  cwd?: string;
  abortController?: AbortController;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  preToolUseHooks?: HookCallback[];
};

export type AgentJob = {
  agent: string;
  message: string;
  metadata?: Record<string, string>;
};

export type AgentResult = {
  agent: string;
  output: string;
  durationMs: number;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  structuredOutput?: unknown;
  errorSubtype?: string;
};
