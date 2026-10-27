import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import "../../agents";
import { getAgent, runAgent } from "../../framework";
import type { AgentConfig, AgentResult, McpServerConfig } from "../../framework";
import type { SubagentCall } from "../../framework/types";
import { buildReviewPrompt } from "../../agents/pr-reviewer";
import { parseDiffAnchors, placeFindings } from "../anchors";
import { decide } from "../gates";
import { evaluateGating, isGatedRepo, type GatingMode } from "../gating";
import { createGitTool } from "../git-tool";
import { promptDiff } from "../prompt-diff";
import { agentEnv, extractJsonObjects, parseReviewOutput, pathGuardHook } from "../run";
import { FindingSchema } from "../schema";
import type { Bundle, Finding, ReviewOutput, ReviewRecord } from "../schema";

// not-investigated: no deep-reviewer was given the lead. dropped: it returned
// no findings. raised: it returned findings, none of which reached the final
// output. reported: one did. unknown: its answer could not be parsed.
export type LeadOutcome = "not-investigated" | "dropped" | "raised" | "reported" | "unknown";

export interface LeadTrace {
  area: string;
  paths: string[];
  category: string;
  hypothesis: string;
  lineRange?: string;
  outcome: LeadOutcome;
  findings: number;
}

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
  // Absent on results written before this existed and on production records,
  // which do not keep the scout's output. An empty array is a real answer: the
  // scout raised no leads. Absent means the scout's answer could not be read.
  leads?: LeadTrace[];
  /** Absent for a repo that has not adopted gating, which is every case but
   *  the `ops` ones; also absent on a run that produced no complete review. */
  gating?: ResultGating;
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

const lastObjectWith = (text: string, key: string): Record<string, unknown> | undefined => {
  const hits = extractJsonObjects(text).filter(
    (o): o is Record<string, unknown> => typeof o === "object" && o !== null && key in o,
  );
  return hits[hits.length - 1];
};

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const sameSpot = (a: Finding, b: Finding) => a.path === b.path && a.line === b.line;

export const traceLeads = (
  calls: SubagentCall[] | undefined,
  output: ReviewOutput | null,
): LeadTrace[] | undefined => {
  const scout = calls?.find((c) => c.subagent === "scout");
  const scoutObj = scout?.result ? lastObjectWith(scout.result, "leads") : undefined;
  if (!scoutObj || !Array.isArray(scoutObj.leads)) return undefined;

  const reported = output?.status === "complete" ? output.findings : [];
  const deep = (calls ?? []).filter((c) => c.subagent === "deep-reviewer");
  const claimed = new Set<SubagentCall>();

  const traces: LeadTrace[] = [];
  for (const raw of scoutObj.leads) {
    if (typeof raw !== "object" || raw === null) continue;
    const lead = raw as Record<string, unknown>;
    const area = typeof lead.area === "string" ? lead.area : "";
    const hypothesis = typeof lead.hypothesis === "string" ? lead.hypothesis : "";
    const base = {
      area,
      paths: asStrings(lead.paths),
      category: typeof lead.category === "string" ? lead.category : "",
      hypothesis,
      ...(typeof lead.lineRange === "string" ? { lineRange: lead.lineRange } : {}),
    };

    // The orchestrator pastes each lead's fields into the deep-reviewer's
    // prompt, so the hypothesis text finds the call that handled it.
    const call = deep.find(
      (c) => !claimed.has(c) && hypothesis !== "" && c.prompt.includes(hypothesis),
    );
    if (!call) {
      traces.push({ ...base, outcome: "not-investigated", findings: 0 });
      continue;
    }
    claimed.add(call);

    const answer = call.result ? lastObjectWith(call.result, "findings") : undefined;
    if (!answer || !Array.isArray(answer.findings)) {
      traces.push({ ...base, outcome: "unknown", findings: 0 });
      continue;
    }
    const found = answer.findings.flatMap((f) => {
      const parsed = FindingSchema.safeParse(f);
      return parsed.success ? [parsed.data] : [];
    });
    const outcome: LeadOutcome =
      found.length === 0
        ? "dropped"
        : found.some((f) => reported.some((r) => sameSpot(f, r)))
          ? "reported"
          : "raised";
    traces.push({ ...base, outcome, findings: found.length });
  }
  return traces;
};

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
  unparseableCount = 0,
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
  // The same blockers production passes: a dropped finding or one that cannot
  // be anchored to a diff line still counts against an approval, even though
  // the eval scores the gate's event rather than the inline comments.
  const placed = placeFindings(output.findings, parseDiffAnchors(bundle.diff));
  const unplaceableCount = placed.filter((p) => "unplaceable" in p).length;
  const decision = decide(output, { unparseableCount, unplaceableCount, gating });
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
    leads?: LeadTrace[],
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
    ...(leads ? { leads } : {}),
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
      traceLeads(agentResult.subagentCalls, null),
    );
  }

  const parsed = parseReviewOutput(agentResult);
  if ("error" in parsed) {
    return makeResult(
      null,
      agentResult.costUsd ?? null,
      parsed.error,
      traceLeads(agentResult.subagentCalls, null),
    );
  }

  const gating =
    parsed.output.status === "complete"
      ? replayGating(bundle, parsed.output, parsed.droppedFindingCount)
      : undefined;
  return makeResult(
    parsed.output,
    agentResult.costUsd ?? null,
    undefined,
    traceLeads(agentResult.subagentCalls, parsed.output),
    gating,
  );
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
