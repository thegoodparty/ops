// What `runAgent` takes and returns, written without a harness.
//
import type { ModelMessage } from "ai";

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
 * fails closed — and each harness has to *make* that true, because a harness
 * that treats a failed guard as "no objection" turns a bug in a guard into an
 * allowed call. `toPreToolUseHook` in `agent.ts` catches and denies for that
 * reason: Claude's SDK documents `onFailure: 'continue'` as the default for a
 * hook that fails, which is the wrong direction for a confinement check.
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
  /**
   * The tools the agent may call, and nothing else. Under the AI SDK these are real
   * `tool()` values the run's child executes; the earlier harness took the same set
   * as names and implemented every one itself, which is why this is a set of
   * loosely described entries rather than the SDK's own type.
   */
  tools?: ToolSet;
  /**
   * The narrower bound, when an agent sets one: the names it is pre-approved to
   * call. Under the Claude harness `tools` said which existed and `allowedTools`
   * said which were pre-approved; here the two are one list, and it is the
   * intersection, so an agent that sets both keeps the authority it had.
   */
  allowedTools?: string[];
  /**
   * The step cap. The name is the Claude harness's and is kept because it is what
   * the agents set; under the AI SDK it bounds delegate's own step counter, which
   * `agent.ts` enforces and which is a different definition from `num_turns`.
   */
  maxTurns?: number;
  /** The spend cap, priced against `delegate/pricing/models.json`. */
  maxBudgetUsd?: number;
  subagents?: Record<string, SubagentDefinition>;
  /** Present when the agent's answer must be a structured object. */
  output?: StructuredOutputAsk;
};

export type RunOverrides = {
  cwd?: string;
  abortController?: AbortController;
  /**
   * The git tools this run may call, by name, with the implementation the child
   * runs them with.
   *
   * Replaces `mcpServers`: under the AI SDK there is no MCP transport to register,
   * and the git tools are this repo's own `tool()` entries
   * (`review/git-tools.ts`), keyed by the names the reviewer's prompt and the
   * replay guard already use. The child builds them from this, so a run that passes
   * none has none.
   */
  gitTools?: ToolSet;
  /** The environment the child gets, and nothing else. Never `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Guards run over every tool call before the tool executes. A call runs only if
   * every guard allows it, so a guard that throws fails closed — and *this repo*
   * makes that true, in `applyGuards`, rather than trusting a harness to.
   *
   * The element type is the neutral handler. Each guard also carries a `spec`
   * (`GuardSpec` in `guards.ts`) describing it as data, because the model call
   * happens in a spawned child and a closure cannot cross the pipe: the spec is what
   * travels, and `applyGuard` is the only implementation either side runs. A guard
   * with no spec fails the run rather than being skipped, because a run with fewer
   * guards than the caller asked for is the failure the allowlist exists to prevent.
   */
  toolCallGuards?: readonly ToolCallHandler[];
  /**
   * The conversation so far, instead of a fresh one.
   *
   * Under the AI SDK this is the message array a previous run returned, not a
   * session id: the bounded repair turn appends its validation error to this and
   * makes one more call. That is what replaced "resume the session at a fixed cwd",
   * and the class of problem it removes rather than ports: no session to resume, so
   * a "resumed" run and a fresh one cannot be confused.
   */
  continuation?: ModelMessage[];
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
  /**
   * What `RunOverrides.continuation` takes: the conversation as the call left it,
   * so a repair turn continues it rather than starting over. Replaced the
   * `sessionId` handle in S5 — there is no session to resume under the AI SDK.
   */
  messages?: ModelMessage[];
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
