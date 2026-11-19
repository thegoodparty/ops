import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ToolSet } from "./types";
import { confineTo } from "./tool-paths";

// The reviewer's own tools, replacing the ones the Claude harness used to
// implement. Read, Grep and Glob are reimplemented here rather than proxied,
// because the point of S5 is that the tool list starts empty and the loop is
// ours: a tool we do not write is a tool whose path resolution we do not
// control, and S3's symlink finding is exactly what that costs.
//
// Each tool guards its own paths through `confineTo` — the same implementation
// `pathGuardHook` uses — so there is no spelling of a path that one accepts and
// the other refuses. That is the property S3's amendment says becomes available
// now, and it is worth having even though the literal half of the check is kept.

const MAX_READ_LINES = 2_000;

/** File contents as the model sees them: numbered lines, like a pager. */
const withLineNumbers = (text: string, offset: number): string =>
  text
    .split("\n")
    .map((line, i) => `${String(offset + i).padStart(6, "\t")}|${line}`)
    .join("\n");

const denyText = (path: string): string =>
  `Path is outside the review checkout: ${path}`;

/** A tool result the model reads. `isError` is the AI SDK's flag for a failed call. */
const textResult = (text: string) => text;

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "__pycache__"]);

export type ReadToolOptions = {
  /** The directory the tools may not escape. */
  root: string;
};

/**
 * Read, Grep and Glob over the review checkout.
 *
 * Deliberately identical in behaviour to the harness tools they replace where
 * the reviewer depends on it — `file_path` / `offset` / `limit` for Read,
 * `pattern` / `path` / `glob` / `output_mode` for Grep, `pattern` / `path` for
 * Glob — because `pr-reviewer.ts`'s prompt tells the model to use them that way,
 * and the prompt is not what this step changes.
 */
export const createReadTools = (options: ReadToolOptions): ToolSet => {
  const confine = confineTo(options.root);

  const read = tool({
    description:
      "Read a file from the repository under review. Returns numbered lines. Use offset and limit to read a large file in parts.",
    inputSchema: z.object({
      file_path: z.string().describe("Path to the file, absolute or relative to the repository root."),
      offset: z.number().int().min(1).optional().describe("First line to return, 1-indexed."),
      limit: z.number().int().min(1).optional().describe("How many lines to return."),
    }),
    execute: async ({ file_path, offset, limit }) => {
      const { inside, resolved } = confine.check(file_path);
      if (!inside) return denyText(file_path);
      let text: string;
      try {
        text = readFileSync(resolved, "utf-8");
      } catch (err) {
        return `Could not read ${file_path}: ${err instanceof Error ? err.message : String(err)}`;
      }
      const lines = text.split("\n");
      const start = (offset ?? 1) - 1;
      const end = limit === undefined ? start + MAX_READ_LINES : start + limit;
      return withLineNumbers(lines.slice(start, Math.min(end, lines.length)).join("\n"), start + 1);
    },
  });

  const grep = tool({
    description:
      "Search file contents with a JavaScript regular expression. Returns matching lines as path:line:text, or file names when output_mode is files_with_matches.",
    inputSchema: z.object({
      pattern: z.string().describe("A JavaScript regular expression."),
      path: z.string().optional().describe("File or directory to search. Defaults to the repository root."),
      glob: z.string().optional().describe('Restrict the search to files matching this glob, e.g. "*.ts".'),
      output_mode: z
        .enum(["content", "files_with_matches", "count"])
        .optional()
        .describe("content for matching lines (default), files_with_matches for paths only, count per file."),
      ignore_case: z.boolean().optional(),
    }),
    execute: async ({ pattern, path: searchPath, glob, output_mode, ignore_case }) => {
      const start = searchPath ?? ".";
      const { inside, resolved } = confine.check(start);
      if (!inside) return denyText(start);
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (err) {
        return `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`;
      }
      const globRe = glob === undefined ? undefined : globToRegExp(glob);
      const mode = output_mode ?? "content";
      const out: string[] = [];
      let matches = 0;

      const visit = (abs: string) => {
        let stat;
        try {
          stat = statSync(abs);
        } catch {
          return;
        }
        if (stat.isDirectory()) {
          let entries: string[];
          try {
            entries = readdirSync(abs);
          } catch {
            return;
          }
          for (const entry of entries) {
            if (SKIP_DIRS.has(entry)) continue;
            visit(join(abs, entry));
          }
          return;
        }
        const rel = relative(confine.root, abs);
        if (globRe !== undefined && !globRe.test(rel)) return;
        let text: string;
        try {
          text = readFileSync(abs, "utf-8");
        } catch {
          return;
        }
        if (text.includes("\u0000")) return; // binary
        const hits: string[] = [];
        text.split("\n").forEach((line, i) => {
          if (!re.test(line)) return;
          hits.push(`${rel}:${i + 1}:${line.slice(0, 400)}`);
        });
        if (hits.length === 0) return;
        matches += hits.length;
        if (mode === "content") out.push(...hits);
        else if (mode === "files_with_matches") out.push(rel);
        else out.push(`${rel}:${hits.length}`);
      };

      try {
        if (statSync(resolved).isDirectory()) visit(resolved);
        else visit(resolved);
      } catch (err) {
        return `Could not search ${start}: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (out.length === 0) return "No matches found.";
      return mode === "content" ? out.slice(0, 500).join("\n") : out.join("\n");
    },
  });

  const globTool = tool({
    description:
      "Find files by glob pattern, e.g. \"**/*.test.ts\". Returns repo-relative paths sorted by modification time.",
    inputSchema: z.object({
      pattern: z.string().describe("A glob to match against repo-relative paths."),
      path: z.string().optional().describe("Directory to search from. Defaults to the repository root."),
    }),
    execute: async ({ pattern, path: from }) => {
      const start = from ?? ".";
      const { inside, resolved } = confine.check(start);
      if (!inside) return denyText(start);
      const re = globToRegExp(pattern);
      const found: { rel: string; mtime: number }[] = [];
      const visit = (abs: string) => {
        let entries: string[];
        try {
          entries = readdirSync(abs);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (SKIP_DIRS.has(entry)) continue;
          const child = join(abs, entry);
          let stat;
          try {
            stat = statSync(child);
          } catch {
            continue;
          }
          if (stat.isDirectory()) visit(child);
          else {
            const rel = relative(confine.root, child);
            if (re.test(rel)) found.push({ rel, mtime: stat.mtimeMs });
          }
        }
      };
      visit(resolved);
      if (found.length === 0) return "No files found.";
      return found
        .sort((a, b) => b.mtime - a.mtime)
        .map((f) => f.rel)
        .join("\n");
    },
  });

  return { Read: read, Grep: grep, Glob: globTool };
};

/**
 * A glob to a matcher over repo-relative paths.
 *
 * Small on purpose: the model writes `**\/*.ts`, `*.md` or `src/**\/*.ts`, and
 * support for character classes or brace expansion would be more code than the
 * reviewer needs. `**\/` matches zero or more directories, `*` matches within a
 * path segment, and a pattern with no `/` is matched against the basename as
 * well, which is what makes `*.ts` find `src/a.ts`.
 */
export const globToRegExp = (glob: string): RegExp => {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000") // **/ -> zero or more directories
    .replace(/\*\*/g, "\u0001") // ** -> anything, crossing /
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  const body = `^${escaped}$`;
  // A bare filename pattern matches at any depth, which is how every glob
  // implementation a model has seen behaves.
  return glob.includes("/") ? new RegExp(body) : new RegExp(`(?:^|/)${escaped}$`);
};

/** Absolute-or-relative resolution that never leaves `root`, for callers that need only a path. */
export const insideRoot = (root: string, candidate: string): string | undefined => {
  const confine = confineTo(root);
  const { inside, resolved } = confine.check(candidate);
  if (!inside) return undefined;
  return isAbsolute(resolved) ? resolved : resolve(root, resolved);
};

/** Re-exported so a caller does not have to know the separator rule. */
export { sep as pathSeparator };
