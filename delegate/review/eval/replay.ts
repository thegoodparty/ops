import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "../../agents";
import { getAgent, runAgent } from "../../framework";
import type { AgentConfig, AgentResult, McpServerConfig } from "../../framework";
import { buildReviewPrompt } from "../../agents/pr-reviewer";
import { createGitTool } from "../git-tool";
import { agentEnv, parseReviewOutput } from "../run";
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

export type RunAgentImpl = (
  config: AgentConfig,
  prompt: string,
  overrides: {
    cwd: string;
    mcpServers: Record<string, McpServerConfig>;
    env: Record<string, string | undefined>;
  },
) => Promise<AgentResult>;

export type CheckoutFn = (bundle: Bundle, repoDir: string) => void | Promise<void>;

const defaultCheckout: CheckoutFn = (bundle, repoDir) => {
  execFileSync(
    "gh",
    ["repo", "clone", bundle.repo, repoDir, "--", "--depth=50"],
    { stdio: "pipe", timeout: 300_000 },
  );
  execFileSync(
    "git",
    ["fetch", "--depth=50", "origin", `refs/pull/${bundle.prNumber}/head`],
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
  const prompt = buildReviewPrompt(bundle);
  const gitTool = createGitTool(repoDir);
  const env = agentEnv();

  let agentResult: AgentResult;
  try {
    agentResult = await runAgentImpl(config, prompt, {
      cwd: repoDir,
      mcpServers: { git: gitTool },
      env,
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

  return makeResult(parsed, agentResult.costUsd ?? null);
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
  const { concurrency = 3 } = poolOpts;

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
