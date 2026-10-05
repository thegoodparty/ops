import { execFileSync } from "child_process";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const GIT_TOOL_NAMES = [
  "mcp__git__git_log",
  "mcp__git__git_show",
  "mcp__git__git_diff",
  "mcp__git__git_blame",
] as const;

const REF_RE = /^[A-Za-z0-9._/~^-]+$/;

export const isSafeRef = (ref: string): boolean =>
  REF_RE.test(ref) && !ref.startsWith("-");

export const isSafePath = (path: string): boolean =>
  !path.startsWith("-") && !path.includes("..");

const TRUNCATE_LIMIT = 100_000;

const truncate = (s: string): string =>
  s.length > TRUNCATE_LIMIT ? `${s.slice(0, TRUNCATE_LIMIT)}\n[truncated]` : s;

const EXEC_OPTS = { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 } as const;

const okResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const errResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true as const,
});

export const createGitTool = (reviewDir: string) => {
  const run = (args: string[]) => {
    try {
      const stdout = execFileSync("git", args, { cwd: reviewDir, ...EXEC_OPTS });
      return okResult(truncate(stdout.toString()));
    } catch (err) {
      const e = err as { stderr?: Buffer; message?: string };
      const msg = e.stderr ? e.stderr.toString().trim() : (err instanceof Error ? err.message : String(err));
      return errResult(truncate(msg));
    }
  };

  const logTool = tool(
    "git_log",
    "Show the git commit log. Restricted to reviewDir.",
    {
      path: z.string().optional(),
      maxCount: z.number().int().min(1).max(50).optional(),
      ref: z.string().optional(),
    },
    async ({ path, maxCount, ref }) => {
      const count = maxCount ?? 20;
      if (ref !== undefined && !isSafeRef(ref)) return errResult("Invalid ref");
      if (path !== undefined && !isSafePath(path)) return errResult("Invalid path");
      const args = ["log", `--max-count=${count}`];
      if (ref !== undefined) args.push(ref);
      if (path !== undefined) args.push("--", path);
      return run(args);
    },
  );

  const showTool = tool(
    "git_show",
    "Show a commit or file content at a given ref.",
    {
      ref: z.string(),
      path: z.string().optional(),
    },
    async ({ ref, path }) => {
      if (!isSafeRef(ref)) return errResult("Invalid ref");
      if (path !== undefined && !isSafePath(path)) return errResult("Invalid path");
      const target = path !== undefined ? `${ref}:${path}` : ref;
      return run(["show", target]);
    },
  );

  const diffTool = tool(
    "git_diff",
    "Show changes between commits or between a commit and the working tree.",
    {
      from: z.string(),
      to: z.string().optional(),
      path: z.string().optional(),
    },
    async ({ from, to, path }) => {
      if (!isSafeRef(from)) return errResult("Invalid from ref");
      if (to !== undefined && !isSafeRef(to)) return errResult("Invalid to ref");
      if (path !== undefined && !isSafePath(path)) return errResult("Invalid path");
      const args = ["diff", from];
      if (to !== undefined) args.push(to);
      if (path !== undefined) args.push("--", path);
      return run(args);
    },
  );

  const blameTool = tool(
    "git_blame",
    "Show what revision and author last modified each line of a file.",
    {
      path: z.string(),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    },
    async ({ path, startLine, endLine }) => {
      if (!isSafePath(path)) return errResult("Invalid path");
      const args = ["blame"];
      if (startLine !== undefined) {
        args.push("-L", `${startLine},${endLine ?? startLine}`);
      }
      args.push("--", path);
      return run(args);
    },
  );

  return createSdkMcpServer({
    name: "git",
    version: "1.0.0",
    tools: [logTool, showTool, diffTool, blameTool],
  });
};
