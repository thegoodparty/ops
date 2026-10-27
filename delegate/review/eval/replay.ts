import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import "../../agents";
import { getAgent, runAgent } from "../../framework";
import type { AgentConfig, AgentResult, McpServerConfig } from "../../framework";
import { buildReviewPrompt } from "../../agents/pr-reviewer";
import { decide } from "../gates";
import { evaluateGating, isGatedRepo, type GatingMode } from "../gating";
import { createGitTool } from "../git-tool";
import { promptDiff } from "../prompt-diff";
import { agentEnv, parseReviewOutput, pathGuardHook } from "../run";
import type { Bundle, ReviewOutput, ReviewRecord } from "../schema";

// The gate's outcome for a replay, kept apart from the agent's output because
// the output cannot tell a flag from an ordinary comment: both are a
// `complete` review with no findings. The expected-result scorer reads this to
// decide whether the review event was an approval or a comment, and which gate
// fired.
export interface ResultGating {
  mode: GatingMode;
  /** The review event the gate produced, under the mode below. */
  verdict: "approve" | "comment";
  /** Every reason the verdict was a comment: gating flags and blockers alike. */
  gates: string[];
  /** What the gate would have done with no mode in the way. */
  wouldApprove: boolean;
}

export interface Result {
  caseId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  variant: string;
  output: ReviewOutput | null;
  error?: string;
  costUsd: number | null;
  wallTimeMs: number;
  /** Absent for a repo that has not adopted gating, which is every case but
   *  the `ops` ones; also absent on a run that produced no complete review. */
  gating?: ResultGating;
}

/**
 * The gate's verdict for an eval replay. The corpus measures the model's one
 * judgement (case 5 of `docs/plan-gated-merges.md`), so a replay runs the gate
 * in `enforce` -- the mode an approval is reachable under -- and treats the
 * bundle's changed paths as de-owned. The bundle carries no `CODEOWNERS`, and
 * the deterministic authority cases are asserted in `gating.test.ts` rather
 * than replayed, so deriving ownership here would only make every plan case a
 * flag on a path that step 6 has not de-owned yet.
 *
 * A repo that has not adopted gating produces no verdict, exactly as in
 * production: the eval must not invent a gate for `omni` or `gp-data-platform`.
 */
export const replayGating = (
  bundle: Bundle,
  output: Extract<ReviewOutput, { status: "complete" }>,
): ResultGating | undefined => {
  if (!isGatedRepo(bundle.repo)) return undefined;
  // The last matching pattern wins, so listing each changed path after the `*`
  // default leaves exactly those paths unowned. An exact path is also safe as
  // a pattern: `gating.ts` escapes the dots.
  const codeowners = ["* @thegoodparty/gp-contrib", ...bundle.changedFiles].join("\n");
  const gating = evaluateGating({
    mode: "enforce",
    body: bundle.body,
    baseRef: bundle.baseRef,
    changedFiles: bundle.changedFiles,
    codeowners,
    plan:
      bundle.plan !== undefined
        ? { path: bundle.plan.path, blobSha: bundle.plan.blobSha }
        : undefined,
  });
  const decision = decide(output, { gating });
  return {
    mode: gating.mode,
    verdict: decision.verdict,
    gates: decision.gates,
    wouldApprove: decision.gating?.wouldApprove ?? false,
  };
};

export const resultFromRecord = (record: ReviewRecord): Result => ({
  caseId: record.runId,
  repo: record.repo,
  prNumber: record.prNumber,
  headSha: record.headSha,
  variant: `prod-${record.agentVersion.slice(0, 7)}`,
  output: record.output,
  error: record.error,
  costUsd: record.costUsd,
  wallTimeMs: record.wallTimeMs,
});

export type RunAgentImpl = (
  config: AgentConfig,
  prompt: string,
  overrides: {
    cwd: string;
    mcpServers: Record<string, McpServerConfig>;
    env: Record<string, string | undefined>;
    preToolUseHooks?: HookCallback[];
  },
) => Promise<AgentResult>;

export type CheckoutFn = (bundle: Bundle, repoDir: string) => void | Promise<void>;

// A recorded sha may be far behind the PR's live tip (re-reviews, force
// pushes), so fetch the exact commit rather than the ref. GitHub serves any
// reachable sha. The directory is wiped first so a second variant or a
// --force rerun on the same work dir starts clean.
const defaultCheckout: CheckoutFn = (bundle, repoDir) => {
  rmSync(repoDir, { recursive: true, force: true });
  execFileSync(
    "gh",
    ["repo", "clone", bundle.repo, repoDir, "--", "--depth=1", "--no-checkout"],
    { stdio: "pipe", timeout: 300_000 },
  );
  execFileSync(
    "git",
    ["fetch", "--depth=50", "origin", bundle.headSha],
    { cwd: repoDir, stdio: "pipe", timeout: 120_000 },
  );
  execFileSync("git", ["checkout", bundle.headSha], {
    cwd: repoDir,
    stdio: "pipe",
    timeout: 60_000,
  });
  execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: repoDir,
    stdio: "pipe",
    timeout: 120_000,
  });
};

const defaultRunAgentImpl: RunAgentImpl = (config, prompt, overrides) =>
  runAgent(config, prompt, overrides);

const getVariant = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      timeout: 10_000,
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
};

export const replayCase = async (
  record: ReviewRecord,
  opts: { workDir: string; variant?: string },
  runAgentImpl: RunAgentImpl = defaultRunAgentImpl,
  checkoutFn: CheckoutFn = defaultCheckout,
): Promise<Result> => {
  const { workDir, variant = getVariant() } = opts;
  const { bundle } = record;
  const caseId = record.runId;
  const repoDir = join(workDir, caseId);
  const startMs = Date.now();

  const makeResult = (
    output: ReviewOutput | null,
    costUsd: number | null,
    error?: string,
    gating?: ResultGating,
  ): Result => ({
    caseId,
    repo: bundle.repo,
    prNumber: bundle.prNumber,
    headSha: bundle.headSha,
    variant,
    output,
    ...(error !== undefined ? { error } : {}),
    costUsd,
    wallTimeMs: Date.now() - startMs,
    ...(gating !== undefined ? { gating } : {}),
  });

  try {
    await checkoutFn(bundle, repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeResult(null, null, `checkout failed: ${message}`);
  }

  const config = getAgent("pr-reviewer");
  // Same as production: a diff too large for the first message goes to a
  // file under .git/ for the agent to read in parts.
  let diffPath: string | undefined;
  if (promptDiff(bundle.diff).oversized) {
    const dir = resolve(repoDir, ".git", "delegate-review");
    mkdirSync(dir, { recursive: true });
    diffPath = resolve(dir, "diff.patch");
    writeFileSync(diffPath, promptDiff(bundle.diff).inline);
  }

  let agentResult: AgentResult;
  try {
    agentResult = await runAgentImpl(config, buildReviewPrompt(bundle, { diffPath }), {
      cwd: repoDir,
      mcpServers: { git: createGitTool(repoDir) },
      env: agentEnv(),
      preToolUseHooks: [pathGuardHook(repoDir)],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeResult(null, null, `agent threw: ${message}`);
  }

  if (agentResult.errorSubtype) {
    return makeResult(
      null,
      agentResult.costUsd ?? null,
      `agent error (${agentResult.errorSubtype}): ${agentResult.output.slice(0, 300)}`,
    );
  }

  const parsed = parseReviewOutput(agentResult);
  if ("error" in parsed) {
    return makeResult(null, agentResult.costUsd ?? null, parsed.error);
  }

  const gating =
    parsed.output.status === "complete" ? replayGating(bundle, parsed.output) : undefined;
  return makeResult(parsed.output, agentResult.costUsd ?? null, undefined, gating);
};

export interface ReplayAllOptions {
  out: string;
  variant?: string;
  workDir?: string;
  force?: boolean;
}

export const replayAll = async (
  records: ReviewRecord[],
  opts: ReplayAllOptions,
  poolOpts: { concurrency?: number } = {},
  runAgentImpl?: RunAgentImpl,
  checkoutFn?: CheckoutFn,
): Promise<Result[]> => {
  const { out, variant, workDir = "/tmp/review-eval", force = false } = opts;
  const { concurrency = 4 } = poolOpts;

  mkdirSync(out, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const results: Result[] = [];
  const toRun: ReviewRecord[] = [];

  for (const record of records) {
    const resultPath = join(out, `${record.runId}.json`);
    if (!force && existsSync(resultPath)) {
      try {
        results.push(JSON.parse(readFileSync(resultPath, "utf-8")) as Result);
        continue;
      } catch {
        // file unreadable — fall through to replay
      }
    }
    toRun.push(record);
  }

  if (toRun.length === 0) return results;

  let index = 0;
  const worker = async () => {
    while (index < toRun.length) {
      const record = toRun[index++];
      const result = await replayCase(
        record,
        { workDir, variant },
        runAgentImpl,
        checkoutFn,
      );
      results.push(result);
      writeFileSync(
        join(out, `${result.caseId}.json`),
        JSON.stringify(result, null, 2),
      );
    }
  };

  const workerCount = Math.min(concurrency, toRun.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
};
