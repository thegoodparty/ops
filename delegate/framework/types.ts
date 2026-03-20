import type { Options } from "@anthropic-ai/claude-agent-sdk";

export type McpServerConfig = NonNullable<Options["mcpServers"]>[string];

export type CallbackTarget =
  | { type: "slack"; channel: string; threadTs?: string }
  | { type: "github"; repo: string; issueNumber: number }
  | { type: "github-pr"; repo: string; prNumber: number };

export type AgentConfig = {
  name: string;
  systemPrompt: string;
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: Options["permissionMode"];
};

export type AgentJob = {
  agent: string;
  message: string;
  callback?: CallbackTarget;
  cwd?: string;
  metadata?: Record<string, string>;
};

export type AgentResult = {
  agent: string;
  output: string;
  durationMs: number;
  sessionId?: string;
};
