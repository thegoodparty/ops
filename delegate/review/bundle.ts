import { execFileSync } from "child_process";
import type { Bundle, PriorFinding, ReviewRecord, SettledFinding } from "./schema";
import type { createGitHub } from "./github";

const EXEC_OPTS = { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 } as const;

export const priorFindingsFrom = (record: ReviewRecord | undefined): PriorFinding[] => {
  if (!record) return [];
  return record.findings.map((f) => ({
    path: f.path,
    line: f.line,
    body: f.body,
    category: f.category,
    headSha: record.headSha,
  }));
};

// Every finding withdrawn by a reconsideration on this PR, once each, oldest
// first. A re-raised concern gets a new id, so it does not unsettle these.
export const settledFindingsFrom = (records: ReviewRecord[]): SettledFinding[] => {
  const byId = new Map<string, SettledFinding>();
  for (const r of records) {
    for (const f of r.settledFindings ?? []) {
      if (!byId.has(f.id)) byId.set(f.id, f);
    }
  }
  return [...byId.values()];
};

export const buildBundle = async (args: {
  repo: string;
  prNumber: number;
  reviewDir: string;
  github: ReturnType<typeof createGitHub>;
  priorFindings: PriorFinding[];
  settledFindings?: SettledFinding[];
}): Promise<Bundle> => {
  const pull = await args.github.getPull(args.repo, args.prNumber);

  const headSha = execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: args.reviewDir, ...EXEC_OPTS },
  )
    .toString()
    .trim();

  // The checkout is a shallow clone of the default branch plus the PR head.
  // The merge base may be outside that window or on another branch, so ask
  // GitHub for it and fetch exactly that commit when it is missing locally.
  const hasCommit = (sha: string) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: args.reviewDir,
        ...EXEC_OPTS,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
  let mergeBase: string;
  try {
    mergeBase = execFileSync(
      "git",
      ["merge-base", pull.baseSha, "HEAD"],
      { cwd: args.reviewDir, ...EXEC_OPTS, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
  } catch {
    mergeBase = await args.github.getMergeBase(args.repo, pull.baseSha, headSha);
    if (!hasCommit(mergeBase)) {
      execFileSync(
        "git",
        ["fetch", "--depth=1", "origin", mergeBase],
        { cwd: args.reviewDir, ...EXEC_OPTS },
      );
    }
  }

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
    ...(args.settledFindings?.length ? { settledFindings: args.settledFindings } : {}),
  };
};
