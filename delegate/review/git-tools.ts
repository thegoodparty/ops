import { execFileSync } from "node:child_process";
import { jsonSchema, tool } from "ai";
import type { ToolSet } from "../framework/types";
import { confineTo } from "../framework/tool-paths";

// The git tools, moved from `createSdkMcpServer` to the `tool()` set.
//
// **What did not change.** `isSafeRef`, `isSafePath` and `truncate` are verbatim,
// with their comments, because the plan says so and because they are the part
// that was already right: they are ref and argument validation inside a tool, not
// path confinement, and they survive the port unchanged. The tool names are
// still `mcp__git__*` — the reviewer's prompt names them that way and
// `replayToolGuard` compares against them, and renaming them here would be a
// prompt change wearing this step's clothes.
//
// **What did.** Only the registration: four `tool()` entries keyed by their old
// names, returning the AI SDK's result shape (a string the model reads) rather
// than the MCP SDK's `{ content: [{ type, text }] }`. Each call's git arguments
// are confined to the review checkout through `confineTo`, so `--` and a path are
// checked the same way the read tools check theirs; `execFileSync`'s `cwd` is
// already the checkout, which is the boundary the old tool relied on and the new
// one keeps as a second line.

/** A ref name, from the old module: git's own character set, and never a flag. */
const REF_RE = /^[A-Za-z0-9._/~^-]+$/;

export const isSafeRef = (ref: string): boolean => REF_RE.test(ref) && !ref.startsWith("-");

export const isSafePath = (path: string): boolean => !path.startsWith("-") && !path.includes("..");

const TRUNCATE_LIMIT = 100_000;

const truncate = (s: string): string =>
  s.length > TRUNCATE_LIMIT ? `${s.slice(0, TRUNCATE_LIMIT)}\n[truncated]` : s;

const EXEC_OPTS = { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 } as const;

export type GitToolOptions = { root: string };

/**
 * The four git tools, keyed by the names the reviewer's prompt uses.
 *
 * `root` is the checkout. It is used as the process `cwd` (a git command in the
 * wrong tree reads the wrong history) and as the confinement a `path` argument is
 * checked against, so a path that names something outside the checkout is refused
 * before git is invoked rather than after.
 */
export const createGitTools = (options: GitToolOptions): ToolSet => {
  const confine = confineTo(options.root);

  const run = (args: string[]): string => {
    try {
      const stdout = execFileSync("git", args, { cwd: confine.root, ...EXEC_OPTS });
      return truncate(stdout.toString());
    } catch (err) {
      const e = err as { stderr?: Buffer; message?: string };
      return truncate(e.stderr ? e.stderr.toString().trim() : err instanceof Error ? err.message : String(err));
    }
  };

  /** A path argument has to pass git's own rule and the checkout's confinement. */
  const pathProblem = (path: string): string | undefined => {
    if (!isSafePath(path)) return "Invalid path";
    if (!confine.check(path).inside) return `Path is outside the review checkout: ${path}`;
    return undefined;
  };

  // Keyed by the *MCP namespaced* names, not by `git_log`: under the Claude
  // harness these arrived as the tools of an MCP server called `git`, so the
  // model called them `mcp__git__git_log`, and that is the string the reviewer's
  // prompt tells it to use and `replayToolGuard` compares against. There is no MCP
  // layer under the AI SDK to reach one, so the namespace is carried in the key
  // rather than dropped — renaming them would be a prompt change, and this step
  // changes the call layer only.
  return {
    mcp__git__git_log: tool({
      description: "Show the git commit log. Restricted to the review checkout.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "Limit the log to this path." },
          maxCount: { type: "integer", minimum: 1, maximum: 50, description: "How many commits, at most 50." },
          ref: { type: "string", description: "The ref to start from." },
        },
        additionalProperties: false,
      }),
      execute: async ({ path, maxCount, ref }: { path?: string; maxCount?: number; ref?: string }) => {
        const count = maxCount ?? 20;
        if (ref !== undefined && !isSafeRef(ref)) return "Invalid ref";
        if (path !== undefined) {
          const problem = pathProblem(path);
          if (problem !== undefined) return problem;
        }
        const args = ["log", `--max-count=${count}`];
        if (ref !== undefined) args.push(ref);
        if (path !== undefined) args.push("--", path);
        return run(args);
      },
    }),

    mcp__git__git_show: tool({
      description: "Show a commit or file content at a given ref.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          ref: { type: "string", description: "The commit or ref to show." },
          path: { type: "string", description: "The file to show at that ref." },
        },
        required: ["ref"],
        additionalProperties: false,
      }),
      execute: async ({ ref, path }: { ref: string; path?: string }) => {
        if (!isSafeRef(ref)) return "Invalid ref";
        if (path !== undefined) {
          const problem = pathProblem(path);
          if (problem !== undefined) return problem;
        }
        return run(["show", path !== undefined ? `${ref}:${path}` : ref]);
      },
    }),

    mcp__git__git_diff: tool({
      description: "Show changes between commits or between a commit and the working tree.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          from: { type: "string", description: "The ref to diff from." },
          to: { type: "string", description: "The ref to diff to. Omit for the working tree." },
          path: { type: "string", description: "Limit the diff to this path." },
        },
        required: ["from"],
        additionalProperties: false,
      }),
      execute: async ({ from, to, path }: { from: string; to?: string; path?: string }) => {
        if (!isSafeRef(from)) return "Invalid from ref";
        if (to !== undefined && !isSafeRef(to)) return "Invalid to ref";
        if (path !== undefined) {
          const problem = pathProblem(path);
          if (problem !== undefined) return problem;
        }
        const args = ["diff", from];
        if (to !== undefined) args.push(to);
        if (path !== undefined) args.push("--", path);
        return run(args);
      },
    }),

    mcp__git__git_blame: tool({
      description: "Show what revision and author last modified each line of a file.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: { type: "string", description: "The file to blame." },
          startLine: { type: "integer", minimum: 1, description: "First line of the range." },
          endLine: { type: "integer", minimum: 1, description: "Last line of the range." },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async ({ path, startLine, endLine }: { path: string; startLine?: number; endLine?: number }) => {
        const problem = pathProblem(path);
        if (problem !== undefined) return problem;
        const args = ["blame"];
        if (startLine !== undefined) args.push("-L", `${startLine},${endLine ?? startLine}`);
        args.push("--", path);
        return run(args);
      },
    }),
  };
};
