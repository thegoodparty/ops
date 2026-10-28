import type { SubagentCall } from "./types";

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

export const recordSubagentUses = (calls: Map<string, SubagentCall>, blocks: ContentBlock[]) => {
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === "Task" && b.id && b.input) {
      calls.set(b.id, {
        subagent: String(b.input.subagent_type ?? ""),
        prompt: String(b.input.prompt ?? ""),
      });
    }
  }
};

export const recordSubagentResults = (calls: Map<string, SubagentCall>, blocks: ContentBlock[]) => {
  for (const b of blocks) {
    const call = b.type === "tool_result" && b.tool_use_id && calls.get(b.tool_use_id);
    if (!call) continue;
    call.result =
      typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((c: { text?: string }) => c.text ?? "").join("\n")
          : "";
  }
};
