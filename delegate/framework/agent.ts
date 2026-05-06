import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig, AgentResult } from "./types";

const log = (agent: string, event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ agent, event, ...data }));

const phaseFromAgentName = (name: string): string | null =>
  name.endsWith("-agent") ? name.replace(/-agent$/, "") : null;

export const runAgent = async (
  config: AgentConfig,
  message: string,
  cwd?: string,
): Promise<AgentResult> => {
  const start = Date.now();
  let output = "";
  let sessionId: string | undefined;
  let turnCount = 0;
  let costUsd: number | undefined;
  let resultTurns: number | undefined;

  for await (const msg of query({
    prompt: message,
    options: {
      systemPrompt: config.systemPrompt,
      model: config.model,
      mcpServers: config.mcpServers,
      agents: config.agents,
      allowedTools: config.allowedTools ?? [
        "mcp__*",
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "Task",
      ],
      maxTurns: config.maxTurns ?? 50,
      maxBudgetUsd: config.maxBudgetUsd ?? 5,
      permissionMode: config.permissionMode ?? "bypassPermissions",
      cwd,
      stderr: (data: string) => console.error("[claude stderr]", data),
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
      log(config.name, "session_init", { sessionId });

      const connected = msg.mcp_servers?.filter(
        (s: { status: string; name: string }) => s.status === "connected",
      );
      const failed = msg.mcp_servers?.filter(
        (s: { status: string; name: string }) => s.status !== "connected",
      );
      if (connected?.length) {
        log(config.name, "mcp_connected", {
          servers: connected.map((s: { name: string }) => s.name),
        });
      }
      if (failed?.length) {
        log(config.name, "mcp_failed", { servers: failed });
      }
    }

    if (msg.type === "assistant") {
      turnCount++;

      const blocks = msg.message.content as Array<{
        type: string;
        name?: string;
        input?: Record<string, unknown>;
        text?: string;
        thinking?: string;
      }>;

      const thinking = blocks
        .filter((b) => b.type === "thinking" && b.thinking)
        .map((b) => b.thinking!.slice(0, 200))
        .join(" ");

      const text = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!.slice(0, 200))
        .join(" ");

      const tools = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const summary: Record<string, unknown> = { tool: b.name };
          if (b.input) {
            if (b.name === "Bash" && b.input.command)
              summary.command = (b.input.command as string).slice(0, 200);
            else if (b.name === "Read" && b.input.file_path)
              summary.file = b.input.file_path;
            else if (b.name === "Grep" && b.input.pattern)
              summary.pattern = b.input.pattern;
            else if (b.name === "Glob" && b.input.pattern)
              summary.pattern = b.input.pattern;
            else if (b.name === "Edit" && b.input.file_path)
              summary.file = b.input.file_path;
            else if (b.name === "Write" && b.input.file_path)
              summary.file = b.input.file_path;
            else if (b.name?.startsWith("mcp__"))
              summary.input = JSON.stringify(b.input).slice(0, 300);
          }
          return summary;
        });

      log(config.name, "turn", {
        turn: turnCount,
        model: msg.message.model,
        ...(thinking && { thinking: thinking.slice(0, 300) }),
        ...(text && { text: text.slice(0, 300) }),
        ...(tools.length > 0 && { tools }),
      });
    }

    if (msg.type === "user" && msg.message.role === "user") {
      const parts = (
        msg.message.content as Array<{
          type: string;
          tool_use_id?: string;
          content?: unknown;
        }>
      )
        .filter((b) => b.type === "tool_result")
        .map((b) => {
          const content =
            typeof b.content === "string"
              ? b.content.slice(0, 500)
              : JSON.stringify(b.content).slice(0, 500);
          return { tool_use_id: b.tool_use_id, result: content };
        });
      if (parts.length > 0) {
        log(config.name, "tool_results", { results: parts });
      }
    }

    if (msg.type === "result" && msg.subtype === "success") {
      output = msg.result;
      costUsd = msg.total_cost_usd;
      resultTurns = msg.num_turns;
      log(config.name, "completed", {
        turns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        durationApiMs: msg.duration_api_ms,
        usage: msg.usage,
      });
      const phase = phaseFromAgentName(config.name);
      if (phase) {
        console.log(
          JSON.stringify({
            event: "workflow_phase_completed",
            phase,
            status: "success",
            durationMs: msg.duration_ms,
            costUsd: msg.total_cost_usd ?? 0,
            sessionId,
          }),
        );
      }
    }

    if (msg.type === "result" && msg.subtype !== "success") {
      const err = msg as {
        subtype: string;
        errors?: string[];
        num_turns?: number;
        total_cost_usd?: number;
      };
      output = `Agent error: ${err.errors ?? "unknown error"}`;
      costUsd = err.total_cost_usd;
      resultTurns = err.num_turns;
      log(config.name, "error", {
        subtype: err.subtype,
        errors: err.errors,
        turns: err.num_turns,
        costUsd: err.total_cost_usd,
      });
      const phase = phaseFromAgentName(config.name);
      if (phase) {
        console.log(
          JSON.stringify({
            event: "workflow_phase_completed",
            phase,
            status: "error",
            durationMs: Date.now() - start,
            costUsd: err.total_cost_usd ?? 0,
            sessionId,
          }),
        );
      }
    }
  }

  return {
    agent: config.name,
    output,
    durationMs: Date.now() - start,
    sessionId,
    costUsd,
    turns: resultTurns,
  };
};
