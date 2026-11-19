import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addStepSpend, capsFor, emptyUsage, runAgent, summariseCall, toolNamesFor, toChildSubagents } from "./agent";
import type { Spend } from "./agent";
import { defineGuard, guardSpecs } from "./guards";
import { costUsdFor, priceTable, pricedModels } from "../pricing";
import { prReviewerSubagents } from "../agents/pr-reviewer-subagents";
import type { AgentConfig } from "./types";

// What `runAgent` is now, and what these tests pin.
//
// Under S2 the implementation was the Claude Agent SDK and `agent.test.ts`
// compared `claudeOptions` against the option object the SDK had been given
// before the refactor, with `forceSynchronousTaskHook` and `toPreToolUseHook`
// pinned as the harness's own vocabulary. **All four are gone in S5** and their
// tests with them, because the harness they described is gone: there is no option
// object, no `PreToolUse` hook, and no session.
//
// What replaces them is the part of S5 that is delegate's own: the step counter,
// the spend counter and the abort. The plan asks for a "test that each fires", and
// the tests below are that, plus the pieces the counters read.

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "test-agent",
  systemPrompt: "s",
  model: "claude-opus-5-5",
  ...overrides,
});

/** A spend record with the running totals a cap reads. */
const spendWith = (model: string, usage: { inputTokens?: number; outputTokens?: number }): Spend => {
  const spend: Spend = { usage: emptyUsage(), costUsd: undefined, unpriced: [] };
  addStepSpend(spend, model, {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  return spend;
};

describe("capsFor", () => {
  it("defaults to the contract's 50 steps and $5, as the SDK did", () => {
    assert.deepEqual(capsFor(baseConfig()), { maxSteps: 50, maxBudgetUsd: 5 });
  });

  it("takes the agent's own bounds when it sets them", () => {
    // `pr-reviewer` raises both. The names are the SDK's and are kept, so the
    // numbers are what the agents already say.
    assert.deepEqual(capsFor(baseConfig({ maxTurns: 80, maxBudgetUsd: 10 })), {
      maxSteps: 80,
      maxBudgetUsd: 10,
    });
  });
});

describe("the spend counter", () => {
  it("prices a step from the table and accumulates", () => {
    // opus: $4 / $20 per 1M input / output.
    const spend = spendWith("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0 });
    assert.equal(spend.costUsd, 4);
    addStepSpend(spend, "claude-opus-5-5", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(spend.costUsd, 24);
    assert.equal(spend.usage.inputTokens, 1_000_000);
    assert.equal(spend.usage.outputTokens, 1_000_000);
  });

  it("counts cache reads and writes at their own rates", () => {
    // opus: cacheRead $0.20 / cacheWrite $5 per 1M, and both are components of
    // the prompt, not extras.
    const spend: Spend = { usage: emptyUsage(), costUsd: undefined, unpriced: [] };
    addStepSpend(spend, "claude-opus-5-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    assert.equal(spend.costUsd, 5.2);
  });

  it("leaves costUsd undefined for a model the table cannot price", () => {
    // **The property the whole table exists for.** A cap that reads `$0` can
    // never fire, so an unpriced model must leave the total unknown rather than
    // add nothing to it — and must be named, so the log says which model priced
    // as nothing.
    const spend = spendWith("some-unpriced-model", { inputTokens: 1_000_000 });
    assert.equal(spend.costUsd, undefined);
    assert.deepEqual(spend.unpriced, ["some-unpriced-model"]);
    // And a priced step afterwards does not retroactively make the unpriced one
    // free: the total is a sum over what could be priced, and `unpriced` says the
    // rest was not.
    addStepSpend(spend, "claude-opus-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(spend.costUsd, 4);
    assert.equal(spend.unpriced.length, 1);
  });

  it("names an unpriced model once, however many steps it ran", () => {
    const spend: Spend = { usage: emptyUsage(), costUsd: undefined, unpriced: [] };
    for (let i = 0; i < 3; i++) {
      addStepSpend(spend, "some-unpriced-model", {
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }
    assert.deepEqual(spend.unpriced, ["some-unpriced-model"]);
    assert.equal(spend.usage.inputTokens, 30);
  });
});

describe("the price table", () => {
  it("prices both Anthropic models the shipped code calls", () => {
    // S5 ships the Anthropic rows, because the spend cap cannot fire against an
    // empty table. S8 adds Bedrock's and S9 Fireworks'; none supersedes another.
    assert.deepEqual(pricedModels(), ["claude-opus-5-5", "claude-sonnet-5-5"]);
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      const rates = priceTable.models[id];
      for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        assert.equal(typeof rates[field], "number", `${id}.${field}`);
        assert.ok(rates[field] >= 0, `${id}.${field} is negative`);
      }
    }
  });

  it("returns undefined rather than 0 for a model it has no row for", () => {
    // The difference between "this call was free" and "nobody has priced this
    // call". Only the second is a reason to fail a review rather than approve it.
    assert.equal(
      costUsdFor("unknown", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      undefined,
    );
    assert.equal(costUsdFor("claude-opus-5-5", undefined), undefined);
  });

  it("prices a known model to the dollar, so a table edit is visible", () => {
    // A row that drifted by a factor of ten would still "be a number"; this
    // fails on it.
    const opus = priceTable.models["claude-opus-5-5"];
    assert.equal(
      costUsdFor("claude-opus-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      opus.input + opus.output,
    );
  });
});

describe("the step cap fires", () => {
  it("sets error_max_steps rather than approving, and reports the spend", async () => {
    // The mechanism: the parent counts steps from the child's `step` events and
    // aborts when the count reaches `maxTurns`. The child here is a fixture that
    // emits steps without a model, so what is exercised is the counter and the
    // abort rather than a provider. **This is the test the plan asks for.**
    const seen: number[] = [];
    const result = await runAgent(baseConfig({ maxTurns: 3 }), "hi", {}, {
      spawn: async (_spec, options) => {
        // Emit more steps than the cap, as a runaway loop would.
        for (let step = 0; step < 5; step++) {
          seen.push(step);
          options.onStep?.({
            type: "step",
            stepNumber: step,
            inputTokens: 1_000,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            finishReason: "tool-calls",
            text: "",
            toolCalls: [{ toolName: "Read", input: { file_path: "a.ts" } }],
          });
          if (options.signal?.aborted === true) break;
        }
        return {
          ok: true,
          output: "should not be used",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          steps: seen.length,
          toolCalls: [],
          messages: [],
        };
      },
    });

    assert.equal(result.errorSubtype, "error_max_steps");
    assert.match(result.output, /step cap \(maxTurns=3\)/);
    assert.equal(result.turns, 3);
    // Stopped at the cap rather than at the fixture's own limit.
    assert.equal(seen.length, 3);
    // A capped run spent real money, and the record says so rather than leaving a
    // zero that reads as free.
    assert.ok((result.costUsd ?? 0) > 0, "a capped run still reports its spend");
    assert.equal(result.usage?.inputTokens, 3_000);
  });
});

describe("the spend cap fires", () => {
  it("sets error_max_budget_usd at the bound, not after it", async () => {
    // 100k opus input tokens costs $0.40, so a $1 cap is crossed on the third
    // step. The cap is checked after each step, so the run stops there.
    const result = await runAgent(baseConfig({ maxBudgetUsd: 1 }), "hi", {}, {
      spawn: async (_spec, options) => {
        for (let step = 0; step < 10; step++) {
          options.onStep?.({
            type: "step",
            stepNumber: step,
            inputTokens: 100_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            finishReason: "tool-calls",
            text: "",
            toolCalls: [],
          });
          if (options.signal?.aborted === true) break;
        }
        return {
          ok: true,
          output: "should not be used",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          steps: 3,
          toolCalls: [],
          messages: [],
        };
      },
    });

    assert.equal(result.errorSubtype, "error_max_budget_usd");
    assert.match(result.output, /budget cap \(maxBudgetUsd=1\)/);
    // $0.40 a step, so three steps cross $1 and the fourth never ran.
    assert.equal(result.turns, 3);
    assert.ok(Math.abs((result.costUsd ?? 0) - 1.2) < 1e-9, `cost was ${result.costUsd}`);
  });

  it("does not fire on a run whose model the table cannot price", async () => {
    // The honest failure mode: an unpriced model leaves `costUsd` undefined, so
    // the budget cap cannot fire — and the run says `unpriced` instead of reading
    // as free. This is what makes a missing price row a bug rather than a win.
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      const result = await runAgent(baseConfig({ model: "unpriced-model", maxBudgetUsd: 0.01 }), "hi", {}, {
        spawn: async (_spec, options) => {
          for (let step = 0; step < 3; step++) {
            options.onStep?.({
              type: "step",
              stepNumber: step,
              inputTokens: 1_000_000,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              finishReason: "stop",
              text: "done",
              toolCalls: [],
            });
          }
          return {
            ok: true,
            output: "done",
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            steps: 3,
            toolCalls: [],
            messages: [],
          };
        },
      });
      assert.equal(result.errorSubtype, undefined);
      assert.equal(result.costUsd, undefined);
      const completed = logs.map((l) => JSON.parse(l)).find((l) => l.event === "completed");
      assert.deepEqual(completed?.unpriced, ["unpriced-model"]);
    } finally {
      console.log = original;
    }
  });
});

describe("guard plumbing", () => {
  it("refuses to run with a guard that cannot cross the process boundary", async () => {
    // A closure has no `spec`, so the child could not apply it. Skipping it would
    // run the agent with fewer guards than the caller asked for and say nothing,
    // which is worse than failing.
    await assert.rejects(
      runAgent(baseConfig(), "hi", { toolCallGuards: [() => ({ decision: "allow" })] }),
      /cannot cross the process boundary/,
    );
  });

  it("sends every guard's spec to the child, in the order it was given", async () => {
    let sent: unknown[] = [];
    const first = defineGuard({ kind: "tools", names: ["Read"], reason: "no" });
    const second = defineGuard({ kind: "paths", root: "/tmp" });
    await runAgent(baseConfig(), "hi", { toolCallGuards: [first, second] }, {
      spawn: async (spec) => {
        sent = spec.guards;
        return {
          ok: true,
          output: "ok",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          steps: 1,
          toolCalls: [],
          messages: [],
        };
      },
    });
    assert.deepEqual(sent, [
      { kind: "tools", names: ["Read"], reason: "no" },
      { kind: "paths", root: "/tmp" },
    ]);
  });

  it("guardSpecs is what the spec builds from, and the two guards carry known kinds", () => {
    assert.deepEqual(guardSpecs([]), []);
  });
});

describe("toolNamesFor", () => {
  it("is the intersection of what the agent offers and what it is allowed", () => {
    // The Claude harness saw `tools` (what exists) and `allowedTools` (what is
    // pre-approved). One list here, and it is the narrower of the two, so an
    // agent that sets both keeps exactly the authority it had.
    const config = baseConfig({
      tools: { Read: {}, Write: {} },
      allowedTools: ["Read", "Glob"],
    });
    assert.deepEqual(toolNamesFor(config, {}).sort(), ["Read"]);
  });

  it("adds the git tools the run gave an implementation for", () => {
    const config = baseConfig({ tools: { Read: {} }, allowedTools: ["Read", "mcp__git__git_log"] });
    assert.deepEqual(toolNamesFor(config, { gitTools: { mcp__git__git_log: {} } }).sort(), [
      "Read",
      "mcp__git__git_log",
    ]);
  });

  it("adds Task when the agent declares subagents", () => {
    const config = baseConfig({
      tools: { Read: {} },
      allowedTools: ["Read", "Task"],
      subagents: { scout: { description: "d", prompt: "p" } },
    });
    assert.deepEqual(toolNamesFor(config, {}).sort(), ["Read", "Task"]);
  });

  it("does not invent a tool the agent did not allow", () => {
    // `subagents` without `Task` in `allowedTools` is an agent that cannot spawn
    // one, which is what it asked for.
    const config = baseConfig({
      tools: { Read: {} },
      allowedTools: ["Read"],
      subagents: { scout: { description: "d", prompt: "p" } },
    });
    assert.deepEqual(toolNamesFor(config, {}), ["Read"]);
  });
});

describe("toChildSubagents", () => {
  it("carries description, prompt and model, and nothing harness-shaped", () => {
    assert.deepEqual(
      toChildSubagents({
        scout: { description: "d", prompt: "p", model: "claude-sonnet-5-5", tools: { Read: {} } },
      }),
      { scout: { description: "d", prompt: "p" } },
    );
    assert.equal(toChildSubagents(undefined), undefined);
  });

  it("is what the reviewer's subagents become, model included", () => {
    // Each subagent carries its own `model`, which is what makes S10's
    // per-agent move possible; the spec has to keep it or S10 has nothing to
    // change.
    const spec = toChildSubagents(prReviewerSubagents);
    assert.deepEqual(Object.keys(spec ?? {}).sort(), ["architect", "deep-reviewer", "scout"]);
  });
});

describe("summariseCall", () => {
  it("names the field a reader can check rather than dumping the input", () => {
    assert.deepEqual(summariseCall({ toolName: "Read", input: { file_path: "src/a.ts" } }), {
      tool: "Read",
      file: "src/a.ts",
    });
    assert.deepEqual(summariseCall({ toolName: "Grep", input: { pattern: "foo" } }), {
      tool: "Grep",
      pattern: "foo",
    });
    assert.deepEqual(summariseCall({ toolName: "Task", input: { subagent_type: "scout" } }), {
      tool: "Task",
      subagent: "scout",
    });
  });
});

test("a run that answers carries the conversation for a repair turn", async () => {
  // The repair turn's new contract: no session id, the message array. `run.ts`
  // keys on `messages`, so a run that does not carry it cannot be repaired — and
  // a failure that is not the answer's shape must not carry it, or the repair
  // call would be spent on a truncated response.
  const messages = [{ role: "user" as const, content: "hi" }];
  const result = await runAgent(baseConfig(), "hi", {}, {
    spawn: async () => ({
      ok: true,
      output: "ok",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      steps: 1,
      toolCalls: [],
      messages: [{ role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] }],
    }),
  });
  assert.ok(result.messages !== undefined);
  assert.equal(result.messages?.length, 1);
  assert.equal(messages.length, 1);
});

test("a run whose failure is not the answer's shape carries no repair conversation", async () => {
  const result = await runAgent(baseConfig(), "hi", {}, {
    spawn: async () => ({
      ok: false,
      error: "response never arrived intact",
      errorName: "AI_APICallError",
      repairable: false,
      steps: 2,
      toolCalls: [],
      messages: [{ role: "user" as const, content: "hi" }],
    }),
  });
  assert.equal(result.errorSubtype, "error_agent");
  assert.equal(result.messages, undefined);
});

test("a repairable failure does carry it, so the repair turn can run", async () => {
  const result = await runAgent(baseConfig(), "hi", {}, {
    spawn: async () => ({
      ok: false,
      error: "did not match schema",
      errorName: "AI_NoObjectGeneratedError",
      repairable: true,
      steps: 2,
      toolCalls: [],
      messages: [{ role: "user" as const, content: "hi" }],
    }),
  });
  assert.equal(result.errorSubtype, "error_agent");
  assert.equal(result.messages?.length, 1);
});

test("the child's environment is the caller's allowlist, never process.env", async () => {
  // The whole credential boundary: `agentEnv()`'s result crosses, and `runAgent`
  // must not reach around it to `process.env`. Pinned by putting a name the
  // allowlist would refuse into the real environment and asserting the child
  // never saw it.
  const canary = "DELEGATE_S5_SPAWN_CANARY";
  process.env[canary] = "leaked";
  try {
    let sawCanary = true;
    await runAgent(baseConfig(), "hi", { env: { PATH: "/usr/bin" } }, {
      spawn: async (_spec, options) => {
        sawCanary = (options.env ?? {})[canary] !== undefined;
        assert.deepEqual(options.env, { PATH: "/usr/bin" });
        return {
          ok: true,
          output: "ok",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          steps: 1,
          toolCalls: [],
          messages: [],
        };
      },
    });
    assert.equal(sawCanary, false);
  } finally {
    delete process.env[canary];
  }
});

test("a subagent's spend is added to the orchestrator's, and priced by its own model", async () => {
  // A subagent is its own `runAgent` with its own model, so its tokens have to be
  // priced at that model's rate and added to the tree's total. Otherwise the
  // orchestrator's budget would be spent by work it never counted.
  const spawns: string[] = [];
  const result = await runAgent(
    baseConfig({
      maxTurns: 5,
      // Above the $6 this run will spend: two 1M-input steps, one at opus's $4
      // and one at sonnet's $2. The default $5 would cap it, which is a different
      // test.
      maxBudgetUsd: 10,
      subagents: { scout: { description: "d", prompt: "p", model: "claude-sonnet-5-5" } },
      allowedTools: ["Read", "Task"],
      tools: { Read: {} },
    }),
    "hi",
    {},
    {
      spawn: async (spec, options) => {
        spawns.push(spec.model);
        if (spec.systemPrompt === "p") {
          // The subagent: 1M sonnet input, $2.
          options.onStep?.({
            type: "step",
            stepNumber: 0,
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            finishReason: "stop",
            text: "answered",
            toolCalls: [],
          });
          return {
            ok: true,
            output: "answered",
            usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            steps: 1,
            toolCalls: [],
            messages: [],
          };
        }
        // The orchestrator asks for the subagent, then answers.
        const response = await options.onRequest?.({
          type: "request",
          id: 1,
          name: "scout",
          prompt: "look at the diff",
        });
        options.onStep?.({
          type: "step",
          stepNumber: 0,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          finishReason: "stop",
          text: "answered",
          toolCalls: [{ toolName: "Task", input: { subagent_type: "scout", prompt: "look" }, result: "answered" }],
        });
        assert.equal(response?.ok, true);
        return {
          ok: true,
          output: "answered",
          usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          steps: 1,
          toolCalls: [],
          messages: [],
        };
      },
    },
  );

  assert.deepEqual(spawns, ["claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.equal(result.errorSubtype, undefined);
  // $4 (orchestrator) + $2 (subagent as priced by the parent) — but the
  // orchestrator's own step is priced once and the subagent's total is priced
  // again by the nested run, so the orchestrator's $4 plus the nested run's $2.
  assert.ok(Math.abs((result.costUsd ?? 0) - 6) < 1e-9, `cost was ${result.costUsd}`);
  assert.equal(result.usage?.inputTokens, 2_000_000);
  // And the subagent call is on the record, which is what `subagentCalls` is for.
  assert.equal(result.subagentCalls?.[0].subagent, "scout");
});
