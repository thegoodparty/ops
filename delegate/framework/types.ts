// What `runAgent` takes and returns, written without a harness.
//
// Nothing here names the Claude Agent SDK: a second implementation can satisfy
// this contract, and the two things it used to borrow from that SDK — the
// subagent definitions and the MCP server config — are described locally. The
// shapes are modelled on the AI SDK's (`ToolSet`, a guard over one tool call,
// an `Output.object` ask), declared here rather than imported so this module
// pulls in no provider package before S5 adds one.
//
// What is *measured*, not assumed: a value built with the AI SDK's `tool()` is
// assignable to the `Tool` declared below, so S5 can fill a config that is
// typed against this module with real AI SDK tools and pass those same values
// to the AI SDK's own `tools` parameter. The reverse does not hold and does not
// need to — a `Tool` here may be a name with no implementation, which is what
// the Claude harness is given in S2, and no such value is ever handed to the AI
// SDK. The one-way seam is the point: the contract is what both harnesses can
// satisfy, not a copy of either one's type.

/**
 * One tool the model may call: the part of the AI SDK's `Tool` this contract
 * uses. A real `tool({ description, inputSchema, execute })` satisfies it (the
 * assignability was checked against `ai` 6.0.333 in a scratch tree, and
 * `types.test.ts` records what can be re-checked here), and so does a bare
 * `{}`, which is how S2 says "this agent may call the harness's own tool of
 * this name".
 *
 * `execute`'s parameters are `any` rather than the input schema's inferred
 * type, deliberately: the AI SDK types `execute` against the tool's own input,
 * so a narrower local signature makes a real tool *not* assignable. `any` here
 * is the difference between a declaration a real tool satisfies and one it does
 * not, and the safety it gives up is the schema's, which the tool itself owns.
 */
export type Tool = {
  description?: string;
  inputSchema?: unknown;
  // `any`, not the input schema's inferred type — see above.
  execute?: (input: any, options?: any) => any;
};

/**
 * The tools an agent may call, keyed by the name the model uses — the AI SDK's
 * `ToolSet`.
 */
export type ToolSet = Record<string, Tool>;

/**
 * A set of tools named only, with no local implementation.
 *
 * The Claude harness implements these itself: its built-ins (`Read`, `Grep`,
 * `Glob`, `Task`, `StructuredOutput`) and the tools of an MCP server it
 * connects. A name is therefore all it needs from config, and `Object.keys` is
 * what it is given. S5 replaces each entry with the `tool()` we write, which is
 * when this helper and its empty definitions go.
 */
export const toolSet = (...names: readonly string[]): ToolSet =>
  Object.fromEntries(names.map((name) => [name, {}]));

/**
 * One tool call, as the model asked for it, on its way to execution.
 */
export type ToolCall = { toolName: string; input: Record<string, unknown> };

/**
 * What a guard decided about a tool call. A denied call never executes and its
 * `reason` goes back to the model in the tool result.
 */
export type ToolCallDecision = { decision: "allow" } | { decision: "deny"; reason: string };

/**
 * A guard over one tool call: the seam `pathGuardHook` and `replayToolGuard`
 * are on. A call runs only if every guard allows it, so a guard that throws
 * fails closed.
 *
 * Nothing in this shape names a harness, which is the point: a guard decides
 * over a tool name and an input object, and the harness it runs under adapts
 * itself to that (`toPreToolUseHook` in `agent.ts`) rather than the other way
 * round. A guard is therefore the same code under either implementation.
 */
export type ToolCallHandler = (call: ToolCall) => ToolCallDecision | PromiseLike<ToolCallDecision>;

/**
 * The structured-output ask, modelled on `Output.object({ schema })`: the
 * schema the answer has to satisfy.
 *
 * It is *not* the AI SDK's `Output` value, and that is checked rather than
 * assumed: `Output.object(...)` returns `{ name, responseFormat,
 * parseCompleteOutput, parsePartialOutput, ... }` with no `schema` member, so
 * it is not assignable here. S5 therefore wraps one (`output: Output.object({
 * schema: ReviewOutputSchema })` as the whole ask) rather than passing it into
 * this shape, which is a one-line change at one call site.
 *
 * `schema` is `object` and not a Zod type because the two harnesses take
 * different dialects: S2 hands the Claude API the JSON Schema the review
 * schema is translated to, S5 hands it the Zod schema itself.
 */
export type StructuredOutputAsk = { schema: object };

/**
 * A subagent the orchestrator may spawn. The fields every harness needs to
 * describe one; each is its own call under the AI SDK, so this is a config
 * shape and not a harness one.
 */
export type SubagentDefinition = {
  description: string;
  prompt: string;
  model?: string;
  tools?: ToolSet;
};

/**
 * A tool server the agent connects to, described locally for the same reason
 * the rest of this module is: the in-process server we build (`type: "sdk"`,
 * what `createGitTool` returns) or a transport the harness can reach.
 */
export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sdk"; name: string; instance: unknown };

/**
 * Token counts for one run, per component, because the two harnesses disagree
 * about what "input tokens" means: Claude's `usage.input_tokens` excludes the
 * cached ones, and the AI SDK's `inputTokens` includes them. Naming the
 * components separately is what lets S5 map its numbers onto these without
 * silently comparing a total to a remainder.
 *
 * A run's total prompt tokens are `inputTokens + cacheReadTokens +
 * cacheWriteTokens`; the sum is left to the reader because the two harnesses
 * count the components for different reasons and a stored total could disagree
 * with its own parts.
 */
export type TokenUsage = {
  /** Prompt tokens that were neither written to nor read from the cache. */
  inputTokens: number;
  /** Completion tokens, thinking included. */
  outputTokens: number;
  /** Prompt tokens served from the cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to the cache. */
  cacheWriteTokens: number;
};

export type AgentConfig = {
  name: string;
  systemPrompt: string;
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
  /** The tools the agent may call, and nothing else. */
  tools?: ToolSet;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  subagents?: Record<string, SubagentDefinition>;
  /** Present when the agent's answer must be a structured object. */
  output?: StructuredOutputAsk;
};

export type RunOverrides = {
  cwd?: string;
  abortController?: AbortController;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  /**
   * Guards run over every tool call before the tool executes. A call runs only
   * if every guard allows it, so a guard that throws fails closed.
   *
   * The element type is the contract's own, and no harness's is accepted here.
   * S2 carried a type parameter so that running Claude `PreToolUse` hooks under
   * this contract was visible instead of a cast; S3 moved both guards onto
   * `ToolCallHandler` and the parameter went with them. A harness that has
   * hooks of its own adapts this shape at its own boundary, in one place
   * (`toPreToolUseHook` in `agent.ts`), which is what keeps a guard from
   * knowing which harness is underneath it.
   */
  toolCallGuards?: readonly ToolCallHandler[];
  /**
   * Continue the conversation whose handle the last run returned as
   * `AgentResult.sessionId`, instead of starting a fresh one: the prompt is
   * then the follow-up user message. Named for what it is rather than for the
   * harness's own field, and it disappears in S5, where the repair call is
   * handed the message array instead of resuming a session at a cwd.
   */
  continuation?: string;
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
  // The handle `RunOverrides.continuation` takes. Named for the harness in S2
  // and replaced by the message array in S5.
  sessionId?: string;
  costUsd?: number;
  /** Tokens the run spent, main loop and subagents alike. */
  usage?: TokenUsage;
  turns?: number;
  structuredOutput?: unknown;
  errorSubtype?: string;
  subagentCalls?: SubagentCall[];
};

/**
 * Sum two runs' token counts, for the two places that make more than one call
 * for a single answer: `run.ts`'s repair turn and the eval's replay.
 *
 * `undefined` means "the harness reported nothing", which is not zero: a run
 * that answered no usage is a gap in the record, and adding it to a real count
 * has to leave the real count alone rather than read as a free run.
 */
export const addUsage = (
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
};
