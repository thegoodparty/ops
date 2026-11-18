import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeOptions,
  forceSynchronousTaskHook,
  toPreToolUseHook,
  toTokenUsage,
  totalTokenUsage,
} from "./agent";
import { toolSet } from "./types";
import type { AgentConfig, McpServerConfig, ToolCallHandler } from "./types";
import { prReviewerSubagents } from "../agents/pr-reviewer-subagents";
import prReviewer from "../agents/pr-reviewer";
import { POSTMORTEM_SELECTOR } from "../review/postmortems";

const preToolUse = (tool_name: string, tool_input: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
});

// A value-level marker for functions, so an options object can be compared as
// data. Two different functions are still two functions here: the point is
// which slots are occupied, not which closure is in them.
const mark = (value: unknown): unknown => {
  if (typeof value === "function") return "[fn]";
  if (Array.isArray(value)) return value.map(mark);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mark(v)]),
    );
  }
  return value;
};

// Claude's own option construction, written out as it stood before S2, with
// the six SDK-derived fields supplied from the harness side rather than the
// contract. This is the spec the refactor has to reproduce: `claudeOptions`
// translates a neutral config into exactly this, so a difference here is a
// behaviour change wearing a refactor's clothes.
const sdkOptionsAsTheyWere = (
  config: {
    systemPrompt: string;
    model: string;
    tools: string[];
    allowedTools: string[];
    maxTurns: number;
    maxBudgetUsd: number;
    outputFormat?: Options["outputFormat"];
    agents?: Options["agents"];
    mcpServers?: Record<string, McpServerConfig>;
  },
  overrides: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    resume?: string;
    abortController?: AbortController;
    preToolUseHooks?: unknown[];
    mcpServers?: Record<string, McpServerConfig>;
  } = {},
) => ({
  abortController: overrides.abortController,
  resume: overrides.resume,
  systemPrompt: config.systemPrompt,
  model: config.model,
  mcpServers:
    config.mcpServers || overrides.mcpServers
      ? { ...config.mcpServers, ...overrides.mcpServers }
      : undefined,
  env: overrides.env,
  tools: config.tools,
  outputFormat: config.outputFormat,
  agents: config.agents,
  allowedTools: config.allowedTools,
  maxTurns: config.maxTurns,
  maxBudgetUsd: config.maxBudgetUsd,
  permissionMode: "bypassPermissions" as const,
  cwd: overrides.cwd,
  hooks: {
    PreToolUse: [
      { hooks: [forceSynchronousTaskHook, ...(overrides.preToolUseHooks ?? [])] },
    ],
  },
  stderr: "[fn]",
});

// The configs, as the six fields they left behind. `pr-reviewer` is the only
// agent that sets all of them; the selector and the three subagents are here
// because they are the ones that pass `tools` most narrowly (an empty list for
// the selector) and would silently lose that if the translation were wrong.
const configs = [
  {
    label: "pr-reviewer",
    neutral: prReviewer,
    sdk: {
      systemPrompt: prReviewer.systemPrompt,
      model: prReviewer.model,
      tools: ["Read", "Grep", "Glob", "Task", "StructuredOutput"],
      allowedTools: prReviewer.allowedTools!,
      maxTurns: 80,
      maxBudgetUsd: 10,
      outputFormat: { type: "json_schema", schema: prReviewer.output!.schema as Record<string, unknown> },
      agents: {
        scout: {
          description: prReviewerSubagents.scout.description,
          prompt: prReviewerSubagents.scout.prompt,
          model: prReviewerSubagents.scout.model,
          tools: Object.keys(prReviewerSubagents.scout.tools!),
        },
        architect: {
          description: prReviewerSubagents.architect.description,
          prompt: prReviewerSubagents.architect.prompt,
          model: prReviewerSubagents.architect.model,
          tools: Object.keys(prReviewerSubagents.architect.tools!),
        },
        "deep-reviewer": {
          description: prReviewerSubagents["deep-reviewer"].description,
          prompt: prReviewerSubagents["deep-reviewer"].prompt,
          model: prReviewerSubagents["deep-reviewer"].model,
          tools: Object.keys(prReviewerSubagents["deep-reviewer"].tools!),
        },
      },
    },
  },
  {
    label: "postmortem-selector",
    neutral: POSTMORTEM_SELECTOR,
    sdk: {
      systemPrompt: POSTMORTEM_SELECTOR.systemPrompt,
      model: POSTMORTEM_SELECTOR.model,
      tools: [],
      allowedTools: [],
      maxTurns: 2,
      maxBudgetUsd: 3,
    },
  },
] satisfies { label: string; neutral: AgentConfig; sdk: Parameters<typeof sdkOptionsAsTheyWere>[0] }[];

describe("claudeOptions", () => {
  for (const { label, neutral, sdk } of configs) {
    it(`translates ${label} into exactly the options the SDK was given before`, () => {
      const overrides = {
        cwd: "/app/review",
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant" },
      };
      assert.deepEqual(
        mark(claudeOptions(neutral, overrides, () => undefined)),
        mark(sdkOptionsAsTheyWere(sdk, overrides)),
      );
    });
  }

  it("keeps the SDK's defaults for an agent that sets neither cap", () => {
    const minimal: AgentConfig = { name: "x", systemPrompt: "s", model: "m" };
    const options = claudeOptions(minimal, {}, () => undefined);
    assert.equal(options.maxTurns, 50);
    assert.equal(options.maxBudgetUsd, 5);
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.deepEqual(options.allowedTools, [
      "mcp__*",
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "Task",
      "Skill",
    ]);
  });

  it("carries continuation into the harness's own resume field", () => {
    // The rename is the one place a contract field could be dropped without a
    // type error, because both sides are an optional string.
    const options = claudeOptions(
      { name: "x", systemPrompt: "s", model: "m" },
      { continuation: "session-abc" },
      () => undefined,
    );
    assert.equal(options.resume, "session-abc");
  });

  it("defaults the guard list to the synchronous-task hook alone", () => {
    const options = claudeOptions({ name: "x", systemPrompt: "s", model: "m" }, {}, () => undefined);
    assert.deepEqual(mark(options.hooks?.PreToolUse), [
      { hooks: ["[fn]"] },
    ]);
  });

  it("puts the caller's guards after the synchronous-task hook, in order", async () => {
    // Guards are the contract's own (a decision over a tool call); the harness
    // adapts each one to a `PreToolUse` hook at this boundary. So there are
    // three function slots here — the synchronous-task hook and one adapter per
    // guard — and the order the caller gave is the order they are asked in.
    const tags: string[] = [];
    const tagging = (tag: string): ToolCallHandler => () => {
      tags.push(tag);
      return { decision: "allow" };
    };
    const options = claudeOptions(
      { name: "x", systemPrompt: "s", model: "m" },
      { toolCallGuards: [tagging("first"), tagging("second")] },
      () => undefined,
    );
    const hooks = options.hooks?.PreToolUse?.[0]?.hooks ?? [];
    assert.equal(hooks.length, 3);
    assert.equal(hooks[0], forceSynchronousTaskHook);
    const event = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} };
    for (const hook of hooks.slice(1)) {
      await hook(event as never, undefined, { signal: new AbortController().signal });
    }
    assert.deepEqual(tags, ["first", "second"]);
  });

  it("adapts a guard's allow to a pass-through and its deny to a deny envelope", async () => {
    const call = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/etc/passwd" } };
    const allow = await toPreToolUseHook(() => ({ decision: "allow" }))(
      call as never,
      undefined,
      { signal: new AbortController().signal },
    );
    // Not `permissionDecision: "allow"`: a guard grants confinement, not a
    // permission-system bypass.
    assert.deepEqual(allow, { continue: true });

    const deny = await toPreToolUseHook(() => ({
      decision: "deny",
      reason: "Path is outside the review checkout: /etc/passwd",
    }))(call as never, undefined, { signal: new AbortController().signal });
    assert.deepEqual(deny, {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Path is outside the review checkout: /etc/passwd",
      },
    });
  });

  it("asks a guard only about tool calls, and hands it the call's own input", async () => {
    const seen: unknown[] = [];
    const hook = toPreToolUseHook((c) => {
      seen.push(c);
      return { decision: "allow" };
    });
    // A non-`PreToolUse` event never reaches the guard: the guard's vocabulary
    // has no events in it.
    assert.deepEqual(
      await hook({ hook_event_name: "Stop" } as never, undefined, {
        signal: new AbortController().signal,
      }),
      { continue: true },
    );
    assert.deepEqual(seen, []);
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "Glob", tool_input: { pattern: "**/*.ts" } } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    assert.deepEqual(seen, [{ toolName: "Glob", input: { pattern: "**/*.ts" } }]);
  });

  it("denies a call when the guard throws, rather than letting the SDK continue", async () => {
    // The SDK documents `onFailure: 'continue'` as the default for a hook that
    // fails, and a callback matcher cannot set it, so a rejected hook would let
    // the call through. The adapter denies instead, which is what makes
    // `ToolCallHandler`'s "a guard that throws fails closed" true here.
    const hook = toPreToolUseHook(() => {
      throw new Error("boom");
    });
    assert.deepEqual(
      await hook(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/etc/passwd" } } as never,
        undefined,
        { signal: new AbortController().signal },
      ),
      {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Guard failed: boom",
        },
      },
    );
  });

  it("passes a tool set through as names, in the order it was declared", () => {
    // Order matters: the reviewer's prompt names its tools in this order, and a
    // set that came back sorted would be a different prompt.
    const options = claudeOptions(
      { name: "x", systemPrompt: "s", model: "m", tools: toolSet("Read", "Grep", "Task") },
      {},
      () => undefined,
    );
    assert.deepEqual(options.tools, ["Read", "Grep", "Task"]);
  });

  it("leaves tools undefined rather than empty when the contract sets none", () => {
    // The distinction is load-bearing: an empty list disables the harness's
    // built-ins, and `undefined` leaves them alone. Only an agent that asks for
    // no tools gets `[]`, and it asks with an empty set.
    const noTools = claudeOptions({ name: "x", systemPrompt: "s", model: "m" }, {}, () => undefined);
    assert.equal(noTools.tools, undefined);
    const emptySet = claudeOptions(
      { name: "x", systemPrompt: "s", model: "m", tools: toolSet() },
      {},
      () => undefined,
    );
    assert.deepEqual(emptySet.tools, []);
  });
});

describe("token usage", () => {
  it("maps Claude's usage onto the neutral shape without folding the cache into the prompt count", () => {
    // The mapping S5 depends on: the AI SDK's `inputTokens` is the prompt
    // total, Claude's is the uncached remainder. Folding them here would make
    // the two sides incomparable in exactly the way Stage A's token gate exists
    // to measure.
    assert.deepEqual(
      toTokenUsage({
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 560,
        cache_creation_input_tokens: 78,
      }),
      { inputTokens: 12, outputTokens: 34, cacheReadTokens: 560, cacheWriteTokens: 78 },
    );
  });

  it("reads nulls as zero, because a null count is a harness answer and not a missing one", () => {
    assert.deepEqual(
      toTokenUsage({
        input_tokens: 1,
        output_tokens: null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
      { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
  });

  it("is undefined when the harness reported no usage at all", () => {
    assert.equal(toTokenUsage(undefined), undefined);
  });

  it("sums modelUsage when it is present, because usage excludes subagents", () => {
    // `usage` on a result message is the main loop only. The subagents are the
    // expensive half of a review, so the recorded total has to come from
    // modelUsage when the harness supplies it.
    assert.deepEqual(
      totalTokenUsage({
        usage: { input_tokens: 1, output_tokens: 2 },
        modelUsage: {
          "claude-opus-5-5": {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 2000,
          },
          "claude-sonnet-5-5": {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 200,
          },
        },
      }),
      {
        inputTokens: 110,
        outputTokens: 220,
        cacheReadTokens: 1100,
        cacheWriteTokens: 2200,
      },
    );
  });

  it("falls back to usage when modelUsage is empty", () => {
    assert.deepEqual(
      totalTokenUsage({ usage: { input_tokens: 7, output_tokens: 9 }, modelUsage: {} }),
      { inputTokens: 7, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
  });
});

describe("forceSynchronousTaskHook", () => {
  const updatedInput = (out: unknown) =>
    (out as { hookSpecificOutput?: { updatedInput?: unknown } }).hookSpecificOutput?.updatedInput;

  for (const tool of ["Agent", "Task"]) {
    it(`makes a background ${tool} call synchronous`, async () => {
      const out = await forceSynchronousTaskHook(
        preToolUse(tool, { subagent_type: "scout", prompt: "p", run_in_background: true }),
      );
      assert.deepEqual(updatedInput(out), { subagent_type: "scout", prompt: "p", run_in_background: false });
    });
  }

  // Eval run 40778431408: every deep-reviewer call omitted the flag and came
  // back "Async agent launched" instead of findings.
  it("makes a call that omits the flag synchronous", async () => {
    const out = await forceSynchronousTaskHook(preToolUse("Agent", { subagent_type: "deep-reviewer", prompt: "p" }));
    assert.deepEqual(updatedInput(out), { subagent_type: "deep-reviewer", prompt: "p", run_in_background: false });
  });

  it("leaves an explicitly synchronous call alone", async () => {
    const out = await forceSynchronousTaskHook(
      preToolUse("Agent", { subagent_type: "scout", prompt: "p", run_in_background: false }),
    );
    assert.deepEqual(out, { continue: true });
  });

  it("leaves other tools alone", async () => {
    const out = await forceSynchronousTaskHook(preToolUse("Bash", { command: "ls", run_in_background: true }));
    assert.deepEqual(out, { continue: true });
  });
});
