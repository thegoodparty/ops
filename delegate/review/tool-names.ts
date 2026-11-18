// The git MCP tools' names, in a module with no harness import.
//
// They lived in `git-tool.ts`, which imports the Claude Agent SDK for `tool()`
// and `createSdkMcpServer`. That made a plain list of four strings reachable
// only by importing a harness, which is the shape S5 has to unwind: the names
// outlive the SDK (they are what the agent's `allowedTools` and the replay's
// tool guard both compare against), so they move here and `git-tool.ts`
// re-exports nothing from its old home.
export const GIT_TOOL_NAMES = [
  "mcp__git__git_log",
  "mcp__git__git_show",
  "mcp__git__git_diff",
  "mcp__git__git_blame",
] as const;
