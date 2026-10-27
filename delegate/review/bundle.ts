import { execFileSync } from "child_process";
import { isPlanPath, parsePlanBinding } from "./gating";
import type { Bundle, Plan, PriorFinding, ReviewRecord } from "./schema";
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

export const buildBundle = async (args: {
  repo: string;
  prNumber: number;
  reviewDir: string;
  github: ReturnType<typeof createGitHub>;
  priorFindings: PriorFinding[];
  /**
   * Resolve the PR's `Plan:` binding and read the plan at the base ref. False
   * by default, and false is the whole no-op guarantee: with the gate off this
   * function makes exactly the GitHub calls and builds exactly the bundle it
   * built before the gate existed, so the prompt, the verdict and the body are
   * unchanged.
   */
  resolvePlan?: boolean;
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

  // The gate's authority check needs every path a PR touches, and
  // `git diff --name-only` is lossy in two ways that can hide one from it:
  // rename detection reports only the destination, so a file moved out of an
  // owned tree never shows its source path; and without `-z` a non-ASCII path
  // is C-quoted (`"docs/caf\303\251.md"`), so it fails a `docs/` prefix check.
  // Neither is reachable while the mode is `off` and `*` owns everything, but
  // the authority check is the one place that has to fail closed. Gated runs
  // ask git for both sides and raw bytes, and use that list for the gate and
  // for the bundle the model reads. Ungated runs keep the original invocation
  // verbatim -- one call, same flags, same parsing -- which is part of what
  // keeps `off` byte-identical, so the two are spelled out rather than one
  // flag turned on for everybody.
  const changedFiles = args.resolvePlan
    ? execFileSync(
        "git",
        ["diff", "--name-only", "--no-renames", "-z", mergeBase, "HEAD"],
        { cwd: args.reviewDir, ...EXEC_OPTS },
      )
        .toString()
        .split("\0")
        .filter(Boolean)
    : execFileSync(
        "git",
        ["diff", "--name-only", mergeBase, "HEAD"],
        { cwd: args.reviewDir, ...EXEC_OPTS },
      )
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);

  // The plan is read once, here, and only when the gate asked for it. The
  // binding is parsed here to decide what to fetch; the gate itself re-derives
  // it from the bundle in `gating.ts`, so the two cannot disagree about what
  // the PR named. Two things it deliberately does not do: read the plan out of
  // the PR (the author would be supplying the spec) and read it off any base
  // ref but `main` (an unmerged plan is a proposal, not a spec).
  let plan: Plan | undefined;
  if (args.resolvePlan) {
    const binding = parsePlanBinding(pull.body);
    const path = binding.paths.length === 1 ? binding.paths[0] : undefined;
    if (path !== undefined && isPlanPath(path) && pull.baseRef === "main") {
      const file = await args.github.getFileAtRef(args.repo, path, pull.baseRef);
      if (file !== undefined) plan = { path, blobSha: file.blobSha, text: file.text };
    }
  }

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
    ...(plan !== undefined ? { plan } : {}),
  };
};
