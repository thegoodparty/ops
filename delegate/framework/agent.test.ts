import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forceSynchronousTaskHook } from "./agent";

const preToolUse = (tool_name: string, tool_input: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
});

describe("forceSynchronousTaskHook", () => {
  for (const tool of ["Agent", "Task"]) {
    it(`strips run_in_background from a ${tool} call`, async () => {
      const out = await forceSynchronousTaskHook(
        preToolUse(tool, { subagent_type: "scout", prompt: "p", run_in_background: true }),
      );
      assert.deepEqual(
        (out as { hookSpecificOutput?: { updatedInput?: unknown } }).hookSpecificOutput?.updatedInput,
        { subagent_type: "scout", prompt: "p" },
      );
    });
  }

  it("leaves a synchronous subagent call alone", async () => {
    const out = await forceSynchronousTaskHook(preToolUse("Agent", { subagent_type: "scout", prompt: "p" }));
    assert.deepEqual(out, { continue: true });
  });

  it("leaves other tools alone", async () => {
    const out = await forceSynchronousTaskHook(preToolUse("Bash", { command: "ls", run_in_background: true }));
    assert.deepEqual(out, { continue: true });
  });
});
