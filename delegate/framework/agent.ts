import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { SUBAGENT_TOOLS, recordSubagentResults, recordSubagentUses } from "./subagent-calls";
import type {
  AgentConfig,
  AgentResult,
  McpServerConfig,
  RunOverrides,
  SubagentCall,
  SubagentDefinition,
  TokenUsage,
  ToolCallHandler,
  ToolSet,
} from "./types";

const log = (agent: string, event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ agent, event, ...data }));

// The guard element in S2 is a Claude `PreToolUse` hook — see
// `RunOverrides.toolCallGuards` for why the contract's generic parameter
// exists and why it disappears in S3.
type ClaudeGuards = HookCallback;

// The contract carries tools as a set, because that is what the AI SDK wants:
// `{ name: { description, inputSchema, execute } }`. The Claude harness takes
// the same list as names and implements the tools itself, so the names are the
// whole translation and every key survives in order. `Object.keys` of a name-keyed
// set is exactly the list this SDK's `tools`/`agents[].tools` wants, which is
// why the config declares names rather than definitions in S2.
const toolNames = (tools: ToolSet | undefined): string[] | undefined =>
  tools === undefined ? undefined : Object.keys(tools);

// The subagents the orchestrator may spawn. The contract describes each one as
// a prompt, a model and its tools; the harness's own `AgentDefinition` is the
// same list plus fields this repo does not set.
const toAgentDefinitions = (
  subagents: Record<string, SubagentDefinition> | undefined,
): Options["agents"] =>
  subagents === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(subagents).map(([name, s]) => [
          name,
          {
            description: s.description,
            prompt: s.prompt,
            ...(s.model !== undefined ? { model: s.model } : {}),
            ...(s.tools !== undefined ? { tools: toolNames(s.tools) } : {}),
          },
        ]),
      );

// The structured-output ask. In S2 the schema handed over is the JSON Schema
// `REVIEW_OUTPUT_JSON_SCHEMA` builds, because the Claude harness routes the
// answer through a tool whose input schema the API compiles; S5 hands the Zod
// schema itself. The `type` wrapper is the harness's, not the contract's.
const toOutputFormat = (output: AgentConfig["output"]): Options["outputFormat"] =>
  output === undefined
    ? undefined
    : { type: "json_schema", schema: output.schema as Record<string, unknown> };

// Claude reports token counts twice, in two spellings. `usage` on the result
// message is the main loop only — it excludes Task subagents and sidechains —
// and it is snake_case (`input_tokens`, `cache_read_input_tokens`). `modelUsage`
// is the same numbers per model, subagents included, in camelCase
// (`inputTokens`, `cacheReadInputTokens`), and the SDK's own docs call it "the
// correct field for token/cost accounting". A review's subagent spend is
// invisible in `usage` and visible in `modelUsage`, so `modelUsage` is summed
// when the result carries it and `usage` is the fallback.
//
// Both spellings map onto the neutral shape the same way, and the mapping is
// the part that matters for S5: the AI SDK's `inputTokens` is the prompt total
// (uncached + cache reads + cache writes), while Claude's `input_tokens` is
// only the uncached part. So the neutral `inputTokens` is Claude's
// `input_tokens` unchanged and the two cache counts keep their own names.
// Getting this backwards would make S5 compare a total against a remainder.
type ClaudeUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

type ClaudeModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

const n = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

export const toTokenUsage = (usage: ClaudeUsage | undefined): TokenUsage | undefined => {
  if (usage === undefined) return undefined;
  return {
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
    cacheWriteTokens: n(usage.cache_creation_input_tokens),
  };
};

export const totalTokenUsage = (result: {
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
}): TokenUsage | undefined => {
  const perModel = result.modelUsage === undefined ? [] : Object.values(result.modelUsage);
  if (perModel.length === 0) return toTokenUsage(result.usage);
  return perModel.reduce<TokenUsage>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + n(u.inputTokens),
      outputTokens: acc.outputTokens + n(u.outputTokens),
      cacheReadTokens: acc.cacheReadTokens + n(u.cacheReadInputTokens),
      cacheWriteTokens: acc.cacheWriteTokens + n(u.cacheCreationInputTokens),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
};

// Force every Task spawn to be synchronous. Background-mode Task lets the
// model proceed before subagents finish — for pr-reviewer this caused
// reviews to publish on partial specialist results, dropping late blockers
// and producing duplicate / contradictory reviews on the same SHA.
// Synchronous Task blocks the parent turn until the subagent's final result
// returns, which is what every existing agent prompt assumes anyway.
export const forceSynchronousTaskHook = async (input: unknown) => {
  const i = input as {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
  };
  if (i.hook_event_name !== "PreToolUse" || !SUBAGENT_TOOLS.has(i.tool_name ?? "")) {
    return { continue: true } as const;
  }
  const ti = (i.tool_input ?? {}) as Record<string, unknown>;
  if (ti.run_in_background === false) {
    return { continue: true } as const;
  }
  // The Agent tool runs in the background when the flag is omitted, so it is
  // set to false rather than stripped.
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      updatedInput: { ...ti, run_in_background: false },
      additionalContext:
        "Subagent calls are forced synchronous in this runtime. Wait for this call's result before issuing the next tool call.",
    },
  };
};

// The contract describes a tool server without naming a harness, so its `sdk`
// variant carries the live instance as `unknown`. The Claude transport wants
// the SDK's own `McpServer` there, and every value that reaches this point was
// built by that SDK's `createSdkMcpServer` — the cast is the translation
// boundary, in one place, rather than a loosening of the harness's own types.
const toSdkMcpServers = (
  servers: Record<string, McpServerConfig> | undefined,
): Options["mcpServers"] => servers as Options["mcpServers"];

// The whole translation from the contract to this harness, in one function so
// that "behaviour identical" is an assertion over a value rather than a claim
// about a diff: `claudeOptions` is what S2's refactor has to preserve, and
// `agent.test.ts` pins it. It stays exported only until S5 deletes it with the
// implementation it belongs to.
export const claudeOptions = (
  config: AgentConfig,
  overrides: RunOverrides<ClaudeGuards> = {},
  stderr: (data: string) => void = (data: string) => console.error("[claude stderr]", data),
): Options => ({
  abortController: overrides.abortController,
  // The contract calls it `continuation`; this harness calls it `resume`. The
  // value is the `sessionId` the previous run returned.
  resume: overrides.continuation,
  systemPrompt: config.systemPrompt,
  model: config.model,
  mcpServers: toSdkMcpServers(
    config.mcpServers || overrides.mcpServers
      ? { ...config.mcpServers, ...overrides.mcpServers }
      : undefined,
  ),
  env: overrides.env,
  tools: toolNames(config.tools),
  outputFormat: toOutputFormat(config.output),
  agents: toAgentDefinitions(config.subagents),
  allowedTools: config.allowedTools ?? [
    "mcp__*",
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
    "Task",
    "Skill",
  ],
  maxTurns: config.maxTurns ?? 50,
  maxBudgetUsd: config.maxBudgetUsd ?? 5,
  // The one SDK-only setting no agent sets and none of the contract's six
  // fields replaced: every caller wants an agent that cannot stop to ask, and
  // it was never a per-agent decision.
  permissionMode: "bypassPermissions",
  cwd: overrides.cwd,
  hooks: {
    PreToolUse: [{ hooks: [forceSynchronousTaskHook, ...(overrides.toolCallGuards ?? [])] }],
  },
  stderr,
});

export const runAgent = async (
  config: AgentConfig,
  message: string,
  overrides: RunOverrides<ClaudeGuards> = {},
): Promise<AgentResult> => {
  const start = Date.now();
  let output = "";
  let sessionId: string | undefined;
  let turnCount = 0;
  let costUsd: number | undefined;
  let usage: TokenUsage | undefined;
  let resultTurns: number | undefined;
  let structuredOutput: unknown;
  let errorSubtype: string | undefined;
  const subagentCalls = new Map<string, SubagentCall>();

  for await (const msg of query({ prompt: message, options: claudeOptions(config, overrides) })) {
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
        id?: string;
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
            else if (b.name && SUBAGENT_TOOLS.has(b.name)) {
              if (b.input.subagent_type)
                summary.subagent = b.input.subagent_type;
              if (b.input.run_in_background)
                summary.run_in_background = b.input.run_in_background;
            }
          }
          return summary;
        });

      recordSubagentUses(subagentCalls, blocks);

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
      recordSubagentResults(
        subagentCalls,
        msg.message.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>,
      );
    }

    if (msg.type === "result" && msg.subtype === "success") {
      output = msg.result;
      costUsd = msg.total_cost_usd;
      resultTurns = msg.num_turns;
      structuredOutput = msg.structured_output;
      usage = totalTokenUsage(msg);
      log(config.name, "completed", {
        turns: msg.num_turns,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        durationApiMs: msg.duration_api_ms,
        usage: msg.usage,
        tokenUsage: usage,
      });
    }

    if (msg.type === "result" && msg.subtype !== "success") {
      // The error variant carries `usage` and `modelUsage` exactly as the
      // success one does, and a run that hit the turn cap or the budget cap
      // spent real tokens. Recording them is what makes a failed review's spend
      // comparable to a completed one rather than a gap.
      const err = msg as {
        subtype: string;
        errors?: string[];
        num_turns?: number;
        total_cost_usd?: number;
        usage?: ClaudeUsage;
        modelUsage?: Record<string, ClaudeModelUsage>;
      };
      output = `Agent error: ${err.errors ?? "unknown error"}`;
      costUsd = err.total_cost_usd;
      resultTurns = err.num_turns;
      usage = totalTokenUsage(err);
      errorSubtype = err.subtype;
      log(config.name, "error", {
        subtype: err.subtype,
        errors: err.errors,
        turns: err.num_turns,
        costUsd: err.total_cost_usd,
        usage: err.usage,
        tokenUsage: usage,
      });
    }
  }

  return {
    agent: config.name,
    output,
    durationMs: Date.now() - start,
    sessionId,
    costUsd,
    ...(usage !== undefined ? { usage } : {}),
    turns: resultTurns,
    structuredOutput,
    errorSubtype,
    ...(subagentCalls.size > 0 ? { subagentCalls: [...subagentCalls.values()] } : {}),
  };
};
