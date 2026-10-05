import { execFileSync } from "child_process";
import type { Bundle, PriorFinding, ReviewRecord } from "./schema";
import type { createGitHub } from "./github";

const EXEC_OPTS = { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 } as const;

export const priorFindingsFrom = (record: ReviewRecord | undefined): PriorFinding[] => {
  if (!record) return [];
  return record.findings.map((f) => ({
    id: f.id,
    path: f.path,
    line: f.line,
    body: f.body,
    category: f.category,
    headSha: record.headSha,
  }));
};

export const buildBundle = async (args: {
  repo: string;
  prNumber: number;
  reviewDir: string;
  github: ReturnType<typeof createGitHub>;
  priorFindings: PriorFinding[];
}): Promise<Bundle> => {
  const pull = await args.github.getPull(args.repo, args.prNumber);

  const mergeBase = execFileSync(
    "git",
    ["merge-base", pull.baseSha, "HEAD"],
    { cwd: args.reviewDir, ...EXEC_OPTS },
  )
    .toString()
    .trim();

  const diff = execFileSync(
    "git",
    ["diff", mergeBase, "HEAD"],
    { cwd: args.reviewDir, ...EXEC_OPTS },
  ).toString();

  const changedFiles = execFileSync(
    "git",
    ["diff", "--name-only", mergeBase, "HEAD"],
    { cwd: args.reviewDir, ...EXEC_OPTS },
  )
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);

  const headSha = execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: args.reviewDir, ...EXEC_OPTS },
  )
    .toString()
    .trim();

  return {
    repo: args.repo,
    prNumber: args.prNumber,
    baseRef: pull.baseRef,
    baseSha: mergeBase,
    headSha,
    author: pull.author,
    title: pull.title,
    body: pull.body,
    diff,
    changedFiles,
    priorFindings: args.priorFindings,
  };
};
