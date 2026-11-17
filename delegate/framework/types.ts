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
  // Resume a previous session (a bounded repair turn) instead of starting a
  // fresh conversation. The prompt is then the follow-up user message.
  resume?: string;
};

export type AgentJob = {
  agent: string;
  message: string;
  metadata?: Record<string, string>;
};

export type SubagentCall = {
  subagent: string;
  prompt: string;
  // Final text the subagent returned to the parent; undefined if the run ended first.
  result?: string;
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
  subagentCalls?: SubagentCall[];
};
