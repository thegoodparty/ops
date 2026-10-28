import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forceSynchronousTaskHook } from "./agent";

const preToolUse = (tool_name: string, tool_input: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
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
