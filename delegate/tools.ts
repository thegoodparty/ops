import { jsonSchema } from "ai";
import type { ToolSet } from "./framework/types";
import { createReadTools } from "./framework/tools";
import { createGitTools } from "./review/git-tools";
import type { ChildSpec, ChildToolCall, ParentResponse } from "./framework/protocol";
import type { GuardSpec } from "./framework/guards";
import { applyGuards } from "./framework/guards";

// The tools the reviewer's agents get, assembled in one place.
//
// It lives at `delegate/` rather than under `framework/` because it is the one
// spot where the framework's read tools and the review tree's git tools meet, and
// putting it either side of that line would be either a framework import of the
// review tree or a review import of the framework's internals. `framework/` stays
// generic; `review/` stays the reviewer's; this file is the list.
//
// **S5 is where the list becomes ours.** Under the Claude harness this was
// `tools: toolSet("Read", "Grep", "Glob", "Task", "StructuredOutput")` — names,
// with the harness implementing every one of them, plus an MCP server the SDK
// built. Now each entry is a `tool()` this repo writes, each guards its own paths
// through `confineTo`, and the list starts empty and grows only by what the
// agent declared. `StructuredOutput` is gone with the tool it routed through: the
// answer is an object call (`Output.object`), not a terminating tool.

/** The names the orchestrator's prompt uses to spawn a subagent. */
export const SUBAGENT_TOOL_NAMES = ["Task", "Agent"] as const;

/** A subagent call's input, as the prompts and the replay guard already describe it. */
export const SUBAGENT_INPUT_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    description: { type: "string", description: "A short description of the task." },
    subagent_type: { type: "string", description: "The subagent to run." },
    prompt: { type: "string", description: "The complete task for the subagent." },
    run_in_background: {
      type: "boolean",
      description: "Always false. Subagent calls are synchronous in this runtime.",
    },
  },
  required: ["subagent_type", "prompt"],
  additionalProperties: false,
});

/** Ask the parent to run a subagent, and wait for its answer. */
export type AskSubagent = (name: string, prompt: string) => Promise<ParentResponse>;

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

type Definition = { description?: string; inputSchema?: unknown; execute?: (input: never) => unknown };

/**
 * Every tool the model may call, keyed by the name the prompt uses.
 *
 * Each is wrapped so that the guards run on its input before it executes and so
 * the call is recorded for the parent — which is what `subagentCalls` and the
 * `turn` log entries used to be, now that the model's loop is on the far side of
 * a pipe. The guards run **inside** the tool for the same reason the read tools
 * confine themselves: the guard and the code opening the file are then the same
 * code path, which is the condition S3's amendment said S5 would meet.
 */
export const buildTools = (
  spec: ChildSpec,
  log: ChildToolCall[],
  askSubagent: AskSubagent,
): ToolSet => {
  const guards = spec.guards as GuardSpec[];
  const tools: ToolSet = {};

  const guarded = (name: string, definition: Definition): ToolSet[string] => ({
    ...definition,
    execute: async (input: Record<string, unknown>) => {
      const decision = applyGuards({ toolName: name, input }, guards);
      if (decision.decision === "deny") {
        log.push({ toolName: name, input, result: decision.reason, isError: true });
        return decision.reason;
      }
      const output = await (definition.execute as (i: unknown) => unknown)(input);
      log.push({ toolName: name, input, result: textOf(output).slice(0, 400) });
      return output;
    },
  });

  for (const [name, definition] of Object.entries(createReadTools({ root: spec.root }))) {
    if (spec.allowedTools.includes(name)) tools[name] = guarded(name, definition as Definition);
  }
  for (const [name, definition] of Object.entries(createGitTools({ root: spec.root }))) {
    if (spec.allowedTools.includes(name)) tools[name] = guarded(name, definition as Definition);
  }

  const subagents = spec.subagents ?? {};
  if (Object.keys(subagents).length > 0) {
    for (const toolName of SUBAGENT_TOOL_NAMES) {
      if (!spec.allowedTools.includes(toolName)) continue;
      tools[toolName] = {
        description:
          "Run one of this review's specialist subagents and wait for its answer. The call blocks until the subagent finishes; a long quiet window is normal, not a timeout.",
        inputSchema: SUBAGENT_INPUT_SCHEMA,
        execute: async (input: Record<string, unknown>) => {
          const name = String(input.subagent_type ?? "");
          const prompt = String(input.prompt ?? "");
          const decision = applyGuards({ toolName, input }, guards);
          if (decision.decision === "deny") {
            log.push({ toolName, input, result: decision.reason, isError: true });
            return decision.reason;
          }
          if (subagents[name] === undefined) {
            const answer = `Unknown subagent "${name}". Available: ${Object.keys(subagents).join(", ")}`;
            log.push({ toolName, input, result: answer, isError: true });
            return answer;
          }
          const response = await askSubagent(name, prompt);
          const answer = response.ok ? response.output : `Subagent ${name} failed: ${response.error}`;
          log.push({
            toolName,
            input: { subagent_type: name, prompt: prompt.slice(0, 200) },
            result: answer.slice(0, 400),
            ...(response.ok ? {} : { isError: true }),
          });
          return answer;
        },
      };
    }
  }

  // A name the agent declared but this runtime does not implement is answered
  // rather than left undefined, so a stale config gets a sentence instead of a
  // crash. It never executes anything: `StructuredOutput` is the name that comes
  // up, and the honest answer is that the answer is an object call now.
  for (const name of spec.allowedTools) {
    if (tools[name] !== undefined) continue;
    tools[name] = {
      description: `${name} is not a tool in this runtime.`,
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: true }),
      execute: async () =>
        `Tool ${name} is not available. Use Read, Grep, Glob, the git tools, or answer; the review is returned as a JSON object, not through a tool.`,
    };
  }

  return tools;
};
