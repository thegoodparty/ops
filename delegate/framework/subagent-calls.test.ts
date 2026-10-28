import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordSubagentResults, recordSubagentUses } from "./subagent-calls";
import type { SubagentCall } from "./types";

const taskUse = (id: string, subagent: string, prompt: string, name = "Agent") => ({
  type: "tool_use",
  id,
  name,
  input: { subagent_type: subagent, prompt },
});

describe("subagent call pairing", () => {
  it("records only Task tool uses", () => {
    const calls = new Map<string, SubagentCall>();
    recordSubagentUses(calls, [
      taskUse("t1", "scout", "read the diff"),
      { type: "tool_use", id: "r1", name: "Read", input: { file_path: "a.ts" } },
      { type: "text" },
    ]);
    assert.deepEqual([...calls.entries()], [["t1", { subagent: "scout", prompt: "read the diff" }]]);
  });

  it("records the subagent tool under either SDK name", () => {
    const calls = new Map<string, SubagentCall>();
    recordSubagentUses(calls, [taskUse("a1", "scout", "p", "Agent"), taskUse("t1", "deep-reviewer", "q", "Task")]);
    assert.deepEqual(
      [...calls.values()].map((c) => c.subagent),
      ["scout", "deep-reviewer"],
    );
  });

  it("pairs a string tool_result with its tool_use", () => {
    const calls = new Map<string, SubagentCall>();
    recordSubagentUses(calls, [taskUse("t1", "scout", "p")]);
    recordSubagentResults(calls, [{ type: "tool_result", tool_use_id: "t1", content: '{"leads":[]}' }]);
    assert.equal(calls.get("t1")?.result, '{"leads":[]}');
  });

  it("joins the text of an array tool_result", () => {
    const calls = new Map<string, SubagentCall>();
    recordSubagentUses(calls, [taskUse("t1", "deep-reviewer", "p")]);
    recordSubagentResults(calls, [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "part one" }, { type: "image" }, { type: "text", text: "part two" }],
      },
    ]);
    assert.equal(calls.get("t1")?.result, "part one\n\npart two");
  });

  it("ignores a tool_result with no tool_use_id", () => {
    const calls = new Map<string, SubagentCall>();
    recordSubagentUses(calls, [taskUse("t1", "scout", "p")]);
    recordSubagentResults(calls, [{ type: "tool_result", content: "orphan" }]);
    assert.deepEqual(calls.get("t1"), { subagent: "scout", prompt: "p" });
  });

  it("ignores a result for an id that was never recorded", () => {
    const calls = new Map<string, SubagentCall>();
    recordSubagentUses(calls, [taskUse("t1", "scout", "p")]);
    recordSubagentResults(calls, [{ type: "tool_result", tool_use_id: "unknown", content: "x" }]);
    assert.deepEqual([...calls.keys()], ["t1"]);
    assert.equal(calls.get("t1")?.result, undefined);
  });
});
