import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import "../../agents";
import { getAgent, runAgent } from "../../framework";
import type { AgentConfig, AgentResult, McpServerConfig } from "../../framework";
import { buildReviewPrompt } from "../../agents/pr-reviewer";
import { createGitTool } from "../git-tool";
import { promptDiff } from "../prompt-diff";
import { agentEnv, parseReviewOutput, pathGuardHook } from "../run";
import type { Bundle, ReviewOutput, ReviewRecord } from "../schema";

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
}

// caseId -> replay number -> result.
export type RunResults = Map<string, Map<number, Result>>;

// A replay dir holds <caseId>/run-<n>.json. A loose <caseId>.json (what
// `results from-cases` writes) counts as run 1.
export const loadRunResults = (dir: string): RunResults => {
  const runs: RunResults = new Map();
  const add = (path: string, run: number) => {
    const result = JSON.parse(readFileSync(path, "utf-8")) as Result;
    runs.set(result.caseId, (runs.get(result.caseId) ?? new Map()).set(run, result));
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const f of readdirSync(join(dir, entry.name))) {
        const m = /^run-(\d+)\.json$/.exec(f);
        if (m) add(join(dir, entry.name, f), Number(m[1]));
      }
    } else if (entry.name.endsWith(".json")) {
      add(join(dir, entry.name), 1);
    }
  }
  return runs;
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

  return makeResult(parsed.output, agentResult.costUsd ?? null);
};

export interface ReplayAllOptions {
  out: string;
  variant?: string;
  workDir?: string;
  force?: boolean;
  // Replays per case, each written to <out>/<caseId>/run-<n>.json.
  replays?: number;
}

export const replayAll = async (
  records: ReviewRecord[],
  opts: ReplayAllOptions,
  poolOpts: { concurrency?: number } = {},
  runAgentImpl?: RunAgentImpl,
  checkoutFn?: CheckoutFn,
): Promise<Result[]> => {
  const { out, variant, workDir = "/tmp/review-eval", force = false, replays = 1 } = opts;
  const { concurrency = 4 } = poolOpts;

  mkdirSync(out, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const results: Result[] = [];
  const toRun: { record: ReviewRecord; run: number }[] = [];

  for (const record of records) {
    for (let run = 1; run <= replays; run++) {
      const resultPath = join(out, record.runId, `run-${run}.json`);
      if (!force && existsSync(resultPath)) {
        try {
          results.push(JSON.parse(readFileSync(resultPath, "utf-8")) as Result);
          continue;
        } catch {
          // file unreadable — fall through to replay
        }
      }
      toRun.push({ record, run });
    }
  }

  console.error(`Replaying ${toRun.length} run(s); ${results.length} already had results`);
  if (toRun.length === 0) return results;

  let index = 0;
  const worker = async () => {
    while (index < toRun.length) {
      const { record, run } = toRun[index++];
      // A case's replays run side by side, so each needs its own checkout dir.
      const result = await replayCase(
        record,
        { workDir: join(workDir, `run-${run}`), variant },
        runAgentImpl,
        checkoutFn,
      );
      results.push(result);
      mkdirSync(join(out, result.caseId), { recursive: true });
      writeFileSync(
        join(out, result.caseId, `run-${run}.json`),
        JSON.stringify(result, null, 2),
      );
    }
  };

  const workerCount = Math.min(concurrency, toRun.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
};
