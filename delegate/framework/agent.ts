import { spawnChild } from "./child/spawn";
import type { SpawnOptions } from "./child/spawn";
import { guardSpecs } from "./guards";
import { costUsdFor } from "../pricing";
import type { GuardSpec } from "./guards";
import type { ChildRequest, ChildResult, ChildSpec, ChildStepEvent, ChildToolCall, ParentResponse } from "./protocol";
import type {
  AgentConfig,
  AgentResult,
  RunOverrides,
  SubagentCall,
  SubagentDefinition,
  TokenUsage,
} from "./types";

// `runAgent` on the Vercel AI SDK, in a spawned child.
//
// Three things move and one does not. Move: the model call (`generateText` over a
// provider package, in a child process), the tool list (the `tool()` set this repo
// writes, in `tools.ts`), and the caps (delegate's own step and spend counters,
// with one abort). Does not move: this function's signature and `AgentResult`,
// because S2 made the contract neutral on purpose and S6 removed the SDK
// implementation that was its second caller.
//
// **The credential boundary is `spawn`.** The worker holds the whole `DELEGATES`
// bundle; in-process, `/proc/self/environ` is the worker's own environ and no path
// guard applies to it. So the model call and the tools that read files happen in a
// child holding only what `agentEnv()` allowed across. Everything this side can
// decide without the model — the caps, the abort, the logging, the pricing — stays
// here, and a subagent is a request the child makes of the parent so that its own
// model and its own spend are the parent's numbers.

const log = (agent: string, event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ agent, event, ...data }));

/**
 * The failure vocabulary.
 *
 * The Claude SDK's `subtype` strings had no AI SDK equivalent, so a run that hits
 * a bound needs a closed set of its own or every cap becomes a generic `error`
 * status. `run.ts` puts `errorSubtype` in the failure reason, so these names are
 * what a reader sees. A step is not a turn — `num_turns` and an AI SDK step count
 * different things — which is why these are new names rather than the old
 * spellings, and why the caps are re-tuned from measurement rather than assumed
 * equivalent. They keep their shape now that the SDK is gone, because stored
 * `ReviewRecord`s carry these strings and a replay has to read them.
 */
export type RunnerError = "error_max_steps" | "error_max_budget_usd" | "error_aborted" | "error_agent";

/**
 * What this run spent, as the operator's `usage` line and the caps' input.
 *
 * `costUsd` is `undefined` when the price table has no row for a model the run
 * called, and that is not zero: a cap reading `$0` can never fire, so an unpriced
 * run has to be visibly unpriced. `run.ts` asserts the distinction downstream — a
 * run that reported tokens and a `costUsd` of 0 is a failure, not a free win.
 */
export type Spend = {
  usage: TokenUsage;
  costUsd: number | undefined;
  /** Models this run called that `delegate/pricing/models.json` cannot price. */
  unpriced: string[];
};

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Sum `from` into `into`, which is what the run's total is built from. */
export const addUsageInto = (into: TokenUsage, from: TokenUsage): TokenUsage => {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  return into;
};

/** Price one step into the running spend, as each step lands so the cap reads live numbers. */
export const addStepSpend = (spend: Spend, model: string, usage: TokenUsage): void => {
  addUsageInto(spend.usage, usage);
  const cost = costUsdFor(model, usage);
  if (cost === undefined) {
    if (!spend.unpriced.includes(model)) spend.unpriced.push(model);
    return;
  }
  spend.costUsd = (spend.costUsd ?? 0) + cost;
};

/**
 * The caps, as delegate's own counters.
 *
 * `maxTurns` and `maxBudgetUsd` keep the contract's names because they are what
 * the agents set and renaming them here would be a config change for no gain. What
 * changes is who enforces them: the Claude SDK capped between turns, and here the
 * parent counts steps as they arrive, prices each one against
 * `delegate/pricing/models.json`, and aborts the child the first time either bound
 * is crossed. `stopWhen` in the child is the cooperative half only.
 *
 * **A cap that fires is a failed run, never an approval**: `errorSubtype` is set,
 * which `run.ts` turns into a `failed` record and an `error` status, exactly the
 * way `error_max_turns` did.
 */
export type Caps = { maxSteps: number; maxBudgetUsd: number };

export const capsFor = (config: AgentConfig): Caps => ({
  maxSteps: config.maxTurns ?? 50,
  maxBudgetUsd: config.maxBudgetUsd ?? 5,
});

/**
 * The subagents a config declares, as the spec wants them: a prompt, a description
 * and a model. The child turns each into a `Task` tool and asks the parent to run
 * the call, which is what keeps a subagent's own `model` field meaningful (S10
 * moves the three subagents without touching the orchestrator).
 */
export const toChildSubagents = (
  subagents: Record<string, SubagentDefinition> | undefined,
): ChildSpec["subagents"] =>
  subagents === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(subagents).map(([name, s]) => [name, { description: s.description, prompt: s.prompt }]),
      );

/**
 * The tools the child may offer, by name.
 *
 * `config.tools` is a `ToolSet` since S2 and its keys are the names the model uses,
 * so the starting point is `Object.keys`. The git tools and the subagent tool are
 * named here because the run was given an implementation for them, and
 * `allowedTools` is the outer bound when an agent sets one — the same intersection
 * the earlier harness saw, where `tools` said which existed and `allowedTools` said
 * which were pre-approved. One list here, and it is the narrower of the two.
 */
export const toolNamesFor = (config: AgentConfig, overrides: RunOverrides): string[] => {
  const names = new Set<string>(Object.keys(config.tools ?? {}));
  for (const name of Object.keys(overrides.gitTools ?? {})) names.add(name);
  if (config.subagents !== undefined && Object.keys(config.subagents).length > 0) {
    names.add("Task");
    names.add("Agent");
  }
  const declared = config.allowedTools;
  if (declared === undefined) return [...names];
  return [...names].filter((name) => declared.includes(name));
};

/** One tool call, summarised for the `step` log line. */
export const summariseCall = (call: ChildToolCall): Record<string, unknown> => {
  const summary: Record<string, unknown> = { tool: call.toolName };
  const input = call.input;
  if (typeof input.file_path === "string") summary.file = input.file_path;
  else if (typeof input.pattern === "string") summary.pattern = input.pattern;
  else if (typeof input.path === "string") summary.path = input.path;
  else if (typeof input.subagent_type === "string") summary.subagent = input.subagent_type;
  else if (Object.keys(input).length > 0) summary.input = JSON.stringify(input).slice(0, 200);
  return summary;
};

/** Pair a subagent tool call with its result, for `AgentResult.subagentCalls`. */
export const recordSubagentCall = (calls: Map<string, SubagentCall>, call: ChildToolCall): void => {
  if (call.toolName !== "Task" && call.toolName !== "Agent") return;
  calls.set(`${call.toolName}:${calls.size}`, {
    subagent: String(call.input.subagent_type ?? ""),
    prompt: String(call.input.prompt ?? ""),
    ...(call.result !== undefined ? { result: call.result } : {}),
  });
};

export type RunAgentDeps = {
  /** How the child is executed. Production resolves `child/main.js`; a test points it at a fixture. */
  /** How the child is executed. Always given both arguments, so a fixture need not guard for an absent options object. */
  spawn?: (spec: ChildSpec, options: SpawnOptions) => Promise<ChildResult>;
  /** The clock, so a test can pin `durationMs`. */
  now?: () => number;
};

/**
 * Run one agent.
 *
 * The sequence, which is the part worth reading:
 *
 * 1. Build the child spec and the guard specs from the config and the overrides.
 *    The environment is `overrides.env` — the caller's allowlist — and never
 *    `process.env`, because that is the whole boundary.
 * 2. Spawn. Each model step arrives as an event; the parent prices it, logs it,
 *    and adds its tokens to the run's `usage`.
 * 3. When a step reaches `maxTurns`, or the spend so far reaches `maxBudgetUsd`,
 *    abort the child and return a capped failure with its own `errorSubtype`. The
 *    spend accumulated so far is still reported: a capped run spent real money.
 * 4. A subagent request is answered by a nested `runAgent`, and its spend is added
 *    to this run's, so the total is the whole tree's.
 */
export const runAgent = async (
  config: AgentConfig,
  message: string,
  overrides: RunOverrides = {},
  deps: RunAgentDeps = {},
): Promise<AgentResult> => {
  const start = (deps.now ?? Date.now)();
  const caps = capsFor(config);
  const spawn = deps.spawn ?? spawnChild;

  // Built before anything starts: a guard that cannot describe itself fails the
  // run here rather than running unguarded.
  const specs: GuardSpec[] = guardSpecs(overrides.toolCallGuards ?? []);

  const spend: Spend = { usage: emptyUsage(), costUsd: undefined, unpriced: [] };
  const subagentCalls = new Map<string, SubagentCall>();
  const controller = new AbortController();
  const callerAbort = overrides.abortController;
  const onCallerAbort = () => controller.abort();
  if (callerAbort !== undefined) {
    if (callerAbort.signal.aborted) controller.abort();
    else callerAbort.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let capReason: RunnerError | undefined;
  const fireCap = (reason: RunnerError) => {
    if (capReason !== undefined) return;
    capReason = reason;
    controller.abort();
  };

  const subagents = toChildSubagents(config.subagents);
  const spec: ChildSpec = {
    model: config.model,
    systemPrompt: config.systemPrompt,
    messages: [...(overrides.continuation ?? []), { role: "user", content: message }],
    root: overrides.cwd ?? process.cwd(),
    ...(subagents !== undefined ? { subagents } : {}),
    ...(config.output !== undefined ? { output: config.output } : {}),
    allowedTools: toolNamesFor(config, overrides),
    guards: specs,
    maxSteps: caps.maxSteps,
  };

  /** Run one subagent as its own child, under the same guards and the same overrides. */
  const runSubagent = async (request: ChildRequest): Promise<ParentResponse> => {
    const definition = config.subagents?.[request.name];
    if (definition === undefined) {
      return { type: "response", id: request.id, ok: false, error: `Unknown subagent "${request.name}"` };
    }
    const result = await runAgent(
      {
        name: request.name,
        systemPrompt: definition.prompt,
        model: definition.model ?? config.model,
        // A subagent answers in text — the contract `pr-reviewer.ts` parses the
        // last line of — and never spawns one of its own.
        tools: definition.tools,
        maxTurns: caps.maxSteps,
        maxBudgetUsd: caps.maxBudgetUsd,
      },
      request.prompt,
      {
        cwd: overrides.cwd,
        env: overrides.env,
        abortController: controller,
        toolCallGuards: overrides.toolCallGuards,
        gitTools: overrides.gitTools,
      },
      deps,
    );
    // Priced into this run, so the totals are the whole tree's rather than the
    // orchestrator's alone.
    if (result.usage !== undefined) addUsageInto(spend.usage, result.usage);
    if (result.costUsd === undefined) {
      const model = definition.model ?? config.model;
      if (!spend.unpriced.includes(model)) spend.unpriced.push(model);
    } else {
      spend.costUsd = (spend.costUsd ?? 0) + result.costUsd;
    }
    if (result.errorSubtype !== undefined) {
      return {
        type: "response",
        id: request.id,
        ok: false,
        error: `${result.errorSubtype}: ${result.output.slice(0, 300)}`,
      };
    }
    return { type: "response", id: request.id, ok: true, output: result.output };
  };

  let steps = 0;
  const child: ChildResult = await spawn(spec, {
    env: overrides.env,
    signal: controller.signal,
    onStep: (event: ChildStepEvent) => {
      steps += 1;
      addStepSpend(spend, config.model, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
      });
      log(config.name, "step", {
        step: event.stepNumber,
        finishReason: event.finishReason,
        ...(event.text !== "" ? { text: event.text } : {}),
        ...(event.toolCalls.length > 0 ? { tools: event.toolCalls.map(summariseCall) } : {}),
      });
      for (const call of event.toolCalls) recordSubagentCall(subagentCalls, call);
      // **Exceeded, not reached.** The child's last allowed step is the one
      // `prepareStep` reserves for the answer: with `stopWhen: stepCountIs(N)` the
      // loop ends on step `N`, and grid on that step the tools are stripped so the
      // object is the only possible answer. Firing at `>=` therefore fired on the
      // answering step of a run that had done exactly what it was told to do, so a
      // run that used its full step budget failed even though the answer arrived —
      // every subagent included, since each one comes through here. The counter
      // now fires only past the cap, which is what makes it a backstop for a child
      // that keeps sending steps rather than a tax on the one that behaves.
      if (steps > caps.maxSteps) fireCap("error_max_steps");
      else if (spend.costUsd !== undefined && spend.costUsd >= caps.maxBudgetUsd) {
        fireCap("error_max_budget_usd");
      }
    },
    onRequest: runSubagent,
  });

  callerAbort?.signal.removeEventListener("abort", onCallerAbort);

  const durationMs = (deps.now ?? Date.now)() - start;
  const costUsd = spend.costUsd;
  const usage = spend.usage;

  if (capReason !== undefined) {
    const output =
      capReason === "error_max_steps"
        ? `Agent error: the run reached its step cap (maxTurns=${caps.maxSteps}) before answering.`
        : `Agent error: the run reached its budget cap (maxBudgetUsd=${caps.maxBudgetUsd}) before answering.`;
    log(config.name, "cap_fired", { reason: capReason, steps, costUsd: costUsd ?? null, usage });
    return {
      agent: config.name,
      output,
      durationMs,
      costUsd,
      usage,
      turns: steps,
      errorSubtype: capReason,
      ...(subagentCalls.size > 0 ? { subagentCalls: [...subagentCalls.values()] } : {}),
    };
  }

  if (!child.ok) {
    const subtype: RunnerError = controller.signal.aborted ? "error_aborted" : "error_agent";
    log(config.name, "error", {
      errorName: child.errorName,
      error: child.error,
      steps,
      costUsd: costUsd ?? null,
      usage,
      repairable: child.repairable,
      ...(spend.unpriced.length > 0 ? { unpriced: spend.unpriced } : {}),
    });
    return {
      agent: config.name,
      output: `Agent error: ${child.error}`,
      durationMs,
      costUsd,
      usage,
      turns: steps,
      errorSubtype: subtype,
      // The message array is what a repair turn continues, and it is only
      // meaningful when the failure was the answer's shape; `run.ts` keys on it
      // the way it keyed on `sessionId`.
      ...(child.repairable ? { messages: child.messages } : {}),
      ...(subagentCalls.size > 0 ? { subagentCalls: [...subagentCalls.values()] } : {}),
    };
  }

  log(config.name, "completed", {
    steps: child.steps,
    costUsd: costUsd ?? null,
    durationMs,
    usage,
    ...(spend.unpriced.length > 0 ? { unpriced: spend.unpriced } : {}),
  });

  return {
    agent: config.name,
    output: child.output,
    durationMs,
    costUsd,
    usage,
    turns: child.steps,
    ...(child.structuredOutput !== undefined ? { structuredOutput: child.structuredOutput } : {}),
    // Always carried, so a repair turn continues this conversation rather than
    // starting a fresh one. There is no session to resume under this call layer.
    messages: child.messages,
    ...(subagentCalls.size > 0 ? { subagentCalls: [...subagentCalls.values()] } : {}),
  };
};
