import { createAnthropic } from "@ai-sdk/anthropic";
import { Output, generateText, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { buildTools } from "../../tools";
import { applyGuards } from "../guards";
import type { GuardSpec } from "../guards";
import { schemaValidator } from "./schema-validator";
import type {
  ChildFailure,
  ChildRequest,
  ChildResult,
  ChildSpec,
  ChildStepEvent,
  ChildToolCall,
  ParentResponse,
} from "../protocol";
import type { TokenUsage } from "../types";

// The child: the agent's model call and its tools, in a process of its own.
//
// The boundary is `spawn`, not the library. The worker holds the whole
// `DELEGATES` bundle and `/proc/self/environ` is a regular file to any read tool,
// so the agent runs where only `agentEnv()`'s allowlist crossed. What lives here
// is the call and the tools; what does not is any budget policy — the step
// counter, the spend counter and the abort are the parent's (`agent.ts`), which
// prices each step as it arrives and kills this process when either cap fires.
//
// Two things this file is allowed to decide, because they are properties of the
// SDK's own machinery rather than of the budget: which failure is worth a repair
// turn (`isRepairable`), and the shape of the last step when the answer has to be
// an object (`prepareStep`).

/**
 * Whether a failure is one a re-prompt with the validation error could fix.
 *
 * The plan records the split and why it is the SDK's own: a `TypeValidationError`
 * under `NoObjectGeneratedError` is "the model answered the wrong shape" and is
 * worth one more call; anything else — a truncated response that did not parse, a
 * network error, an abort — is asking again for the same thing. `run.ts` decides
 * whether to spend the turn; this decides only whether the turn could help.
 */
export const isRepairable = (err: unknown): boolean =>
  (err as { cause?: { name?: string } }).cause?.name === "AI_TypeValidationError";

/**
 * A tool's output, as the text the parent records beside the call.
 *
 * A tool's `execute` returns a string here (every tool we write does), but the
 * SDK's type is `unknown` and a future tool could return an object. Stringifying
 * is what keeps one such tool from dropping the subagent's whole answer, which is
 * the thing this field exists to carry.
 */
const asText = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output) ?? String(output);

/**
 * The AI SDK's usage in the contract's shape.
 *
 * The AI SDK's `inputTokens` is the prompt total, cache reads and writes
 * included; the contract's is the uncached remainder, which is what the Claude
 * side recorded (`usage.input_tokens` excludes the cached part). Comparing a total
 * against a remainder is the mistake `TokenUsage` names, so the subtraction
 * happens here, once, rather than at every reader.
 */
export const toTokenUsage = (usage: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}): TokenUsage => {
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const inputTokens = usage.inputTokens ?? 0;
  return {
    inputTokens: Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
};

export type ChildDeps = {  /** Cancel the run: the parent's abort, its spend cap and its deadline, one signal. */
  signal?: AbortSignal;
  /** Injected by a test; production asks the parent over the pipe. */
  askSubagent?: (request: ChildRequest) => Promise<ParentResponse>;
  /** Injected by a test; production is `createAnthropic()`. */
  provider?: (modelId: string) => LanguageModel;
  /** Called as each model step finishes, so the parent can price it mid-run. */
  onStep?: (event: ChildStepEvent) => void;
  /** Called when the model asks for a subagent, so the parent can answer over the pipe. */
  onRequest?: (request: ChildRequest) => void;
};

/**
 * Run one call: `generateText` over the AI SDK, with our tools, bounded by our
 * step count, ended by the parent's signal.
 *
 * `messages` is the whole conversation, so a repair turn is the same array with
 * the validation error appended — there is no session to resume and no cwd to keep
 * fixed, which is the awkward class of problem this step removes rather than
 * ports.
 */
export const runChild = async (spec: ChildSpec, deps: ChildDeps = {}): Promise<ChildResult> => {
  const log: ChildToolCall[] = [];
  const guards = spec.guards as GuardSpec[];
  let nextRequestId = 1;

  // The subagent channel. A subagent has its own model and its own spend, so the
  // call goes to the parent's `runAgent` rather than being a second
  // `generateText` here: that keeps a subagent's tokens attributable to the model
  // that spent them and its budget separate from the orchestrator's.
  const askSubagent = async (request: ChildRequest): Promise<ParentResponse> => {
    if (deps.askSubagent !== undefined) return deps.askSubagent(request);
    if (deps.onRequest === undefined) {
      return { type: "response", id: request.id, ok: false, error: "subagents are unavailable in this runtime" };
    }
    return (await deps.onRequest(request)) as never;
  };

  const tools = buildTools(spec, log, (name, prompt) =>
    askSubagent({ type: "request", id: nextRequestId++, name, prompt }),
  );
  const messages = spec.messages as ModelMessage[];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let steps = 0;

  try {
    const result = await generateText({
      model: (deps.provider ?? ((modelId: string) => createAnthropic()(modelId)))(spec.model),
      system: spec.systemPrompt,
      messages,
      // The contract's `ToolSet` is a loose description of a tool, not the SDK's
      // type: `buildTools` returns real `tool()` values, so the cast at this one
      // boundary is the whole translation and nothing upstream has to know the
      // SDK exists. The reverse direction (`ToolSet` -> the SDK) is the one that
      // does not hold, and nothing here needs it.
      tools: tools as unknown as Parameters<typeof generateText>[0]["tools"],
      stopWhen: stepCountIs(spec.maxSteps),
      // The one mechanic the plan says does not dissolve: a review both calls
      // tools and ends in an object, and `generateText` resolves `output` only
      // when the last step finishes on `stop` rather than on a tool call. So the
      // final step gets no tools, which leaves the object the only thing the
      // model can return. `stopWhen` bounds the loop; this makes the last step
      // answer.
      prepareStep: ({ stepNumber }) =>
        spec.output !== undefined && stepNumber >= spec.maxSteps - 1
          ? { activeTools: [], toolChoice: "none" as const }
          : {},
      ...(spec.output !== undefined
        ? { output: Output.object({ schema: schemaValidator(spec.output.schema) }) }
        : {}),
      ...(deps.signal !== undefined ? { abortSignal: deps.signal } : {}),
      onStepFinish: (step) => {
        const stepUsage = toTokenUsage(step.usage);
        usage.inputTokens += stepUsage.inputTokens;
        usage.outputTokens += stepUsage.outputTokens;
        usage.cacheReadTokens += stepUsage.cacheReadTokens;
        usage.cacheWriteTokens += stepUsage.cacheWriteTokens;
        steps += 1;
        // **Pair each call with what its tool answered.** `step.toolCalls` carries
        // input only, so a `Task` call reached the parent with no `result` and
        // `recordSubagentCall` stored a subagent that never reported — which left
        // `traceLeads` reading an empty scout result on every eval run. The
        // results are on the same step, keyed by `toolCallId`.
        const outputs = new Map(
          step.toolResults.map((toolResult) => [toolResult.toolCallId, toolResult.output]),
        );
        deps.onStep?.({
          type: "step",
          stepNumber: step.stepNumber,
          ...stepUsage,
          finishReason: step.finishReason,
          text: (step.text ?? "").slice(0, 400),
          toolCalls: step.toolCalls.map((call) => {
            const output = outputs.get(call.toolCallId);
            return {
              toolName: call.toolName,
              input: (call.input ?? {}) as Record<string, unknown>,
              ...(output !== undefined ? { result: asText(output) } : {}),
            };
          }),
        });
      },
    });

    return {
      ok: true,
      output: result.text ?? "",
      ...(spec.output !== undefined ? { structuredOutput: result.output } : {}),
      usage,
      steps: result.steps.length,
      toolCalls: log,
      messages: [...messages, ...result.response.messages],
    };
  } catch (err) {
    const failure: ChildFailure = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      // Carried rather than flattened: a caller logging this is reading the SDK's
      // own vocabulary, and `repairable` is derived from its cause.
      errorName: (err as { name?: string }).name ?? "Error",
      repairable: isRepairable(err),
      ...(steps > 0 ? { usage } : {}),
      steps,
      toolCalls: log,
      messages,
    };
    return failure;
  }
};

// The guards are applied inside `buildTools`, through `applyGuards`, so a denied
// call never reaches the tool body — the same authority the Claude harness gave
// them through `PreToolUse`, held by the same implementation. Exported so a test
// can assert the wiring rather than infer it.
export { applyGuards };
