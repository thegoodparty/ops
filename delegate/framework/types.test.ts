import { test } from "node:test";
import assert from "node:assert/strict";
import { addUsage, toolSet } from "./types";
import type { AgentConfig, ToolCallHandler, ToolSet } from "./types";
import { prReviewerSubagents } from "../agents/pr-reviewer-subagents";
import prReviewer from "../agents/pr-reviewer";
import { REVIEW_OUTPUT_JSON_SCHEMA } from "../agents/pr-reviewer";

// The contract's two claims about the AI SDK are structural, and this repo
// cannot import `ai` to check them until S5 adds it — so they were checked
// against `ai` 6.0.333 in a scratch tree, and what is pinned here is the half
// that can be checked here: the values this repo actually builds. Re-checking
// the SDK half needs an install, which is S5's step.
//
// What was verified there, for the reviewer who wants to redo it:
//   - a tool built with `tool({ description, inputSchema, execute })` is
//     assignable to this module's `Tool`, so a config typed against the
//     contract can hold real AI SDK tools;
//   - a set of them is assignable to `ToolSet` here;
//   - the reverse does not hold, and must not: a name-only entry is not an AI
//     SDK tool, so nothing here can be passed to the AI SDK's own `tools`;
//   - `Output.object({ schema })` is *not* assignable to `StructuredOutputAsk`,
//     because it has no `schema` member. S5 wraps it instead.

test("toolSet keys are the tool names, in the order they were declared", () => {
  // The order is not cosmetic: `agent.ts` passes `Object.keys(...)` as the
  // harness's tool list, and an agent's prompt names its tools in that order.
  assert.deepEqual(Object.keys(toolSet("Read", "Grep", "Glob", "Task")), [
    "Read",
    "Grep",
    "Glob",
    "Task",
  ]);
  // Every entry is an empty tool: the harness implements these itself in S2,
  // and S5 replaces each with a `tool()` we write.
  assert.deepEqual(toolSet("Read"), { Read: {} });
});

test("toolSet with no names is an empty set, not undefined", () => {
  // The difference matters downstream: an empty list disables the harness's
  // built-in tools and `undefined` leaves them alone. The post-mortem selector
  // asks for none, and it says so with an empty set.
  assert.deepEqual(toolSet(), {});
});

test("the agents this repo declares carry tools as sets, not name lists", () => {
  const configs: [string, AgentConfig][] = [
    ["pr-reviewer", prReviewer],
    ...Object.entries(prReviewerSubagents).map(
      ([name, sub]): [string, AgentConfig] => [
        name,
        { name, systemPrompt: sub.prompt, model: sub.model ?? "", tools: sub.tools },
      ],
    ),
  ];
  for (const [name, config] of configs) {
    const tools: ToolSet | undefined = config.tools;
    assert.ok(tools !== undefined, `${name} declares no tools`);
    for (const [toolName, tool] of Object.entries(tools)) {
      assert.equal(typeof toolName, "string");
      assert.equal(typeof tool, "object", `${name}.${toolName} is not a tool entry`);
    }
  }
});

test("the reviewer's structured-output ask carries the schema it is given, unchanged", () => {
  // S2's ask wraps the JSON Schema the Claude API compiles. The assertion is
  // identity: a translation that rebuilt or re-ordered the schema would change
  // what the model is asked for without changing this type.
  assert.equal(prReviewer.output?.schema, REVIEW_OUTPUT_JSON_SCHEMA);
});

test("addUsage treats a missing usage as unknown, never as zero", () => {
  // A run that reported nothing is a gap in the record. Adding it to a real
  // count has to leave the real count alone, or a failed run reads as free.
  const real = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
  assert.deepEqual(addUsage(undefined, real), real);
  assert.deepEqual(addUsage(real, undefined), real);
  assert.equal(addUsage(undefined, undefined), undefined);
  assert.deepEqual(addUsage(real, real), {
    inputTokens: 2,
    outputTokens: 4,
    cacheReadTokens: 6,
    cacheWriteTokens: 8,
  });
});

test("ToolCallHandler can express what the existing guards decide", () => {
  // `pathGuardHook` and `replayToolGuard` decide allow or deny-with-a-reason
  // today, in Claude's `PreToolUse` vocabulary. S3 moves them onto this type,
  // so the point of pinning it here is that nothing they express is lost in the
  // move: an allowance, and a denial that carries the sentence the model is
  // shown. If this needed a third arm, S3 would be a behaviour question rather
  // than a shape change.
  const allow: ToolCallHandler = () => ({ decision: "allow" });
  const deny: ToolCallHandler = () => ({
    decision: "deny",
    reason: "Path is outside the review checkout: /proc/1/environ",
  });

  assert.deepEqual(allow({ toolName: "Read", input: { file_path: "src/a.ts" } }), { decision: "allow" });
  const denial = deny({ toolName: "Read", input: { file_path: "/proc/1/environ" } });
  assert.equal((denial as { decision: string }).decision, "deny");
  assert.match((denial as { reason: string }).reason, /^Path is outside the review checkout: /);
});
