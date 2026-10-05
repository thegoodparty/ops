import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getAgent, runAgent } from "../framework";
import { buildReviewPrompt } from "../agents/pr-reviewer";
import { parseDiffAnchors, placeFindings } from "./anchors";
import { renderBody, renderFailureBody } from "./body";
import { buildBundle, priorFindingsFrom } from "./bundle";
import { decide } from "./gates";
import { createGitTool } from "./git-tool";
import { createGitHub } from "./github";
import {
  ReviewOutputSchema,
  type Bundle,
  type PostedFinding,
  type ReviewOutput,
  type ReviewRecord,
} from "./schema";
import { createStore } from "./store";
import { emit } from "./telemetry";

export type ReviewTrigger = ReviewRecord["trigger"];

// Everything the Claude Code subprocess (and therefore the model) can see in
// its environment. No GitHub, Slack, ClickUp or AWS material: the agent has
// no network tools, but a Read on /proc/self/environ would still leak them.
const ENV_DENYLIST = [
  /^GITHUB_/,
  /^REVIEWER_/,
  /^SLACK_/,
  /^CLICKUP_/,
  /^GRAFANA_/,
  /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|CONTAINER_CREDENTIALS_RELATIVE_URI|CONTAINER_AUTHORIZATION_TOKEN)$/,
  /^AGENT_JOB$/,
  /^GH_TOKEN$/,
];

export const agentEnv = (
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !ENV_DENYLIST.some((re) => re.test(key)),
    ),
  );

export const parseReviewOutput = (
  result: { structuredOutput?: unknown; output: string },
): ReviewOutput | { error: string } => {
  const candidate =
    result.structuredOutput !== undefined
      ? result.structuredOutput
      : (() => {
          try {
            return JSON.parse(result.output);
          } catch {
            return undefined;
          }
        })();
  if (candidate === undefined) {
    return { error: `agent returned no JSON: ${result.output.slice(0, 300)}` };
  }
  const parsed = ReviewOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { error: `agent output failed schema: ${parsed.error.message.slice(0, 500)}` };
  }
  return parsed.data;
};

const commentUrl = (repo: string, prNumber: number, commentId: number) =>
  `https://github.com/${repo}/pull/${prNumber}#discussion_r${commentId}`;

export const runReview = async (args: {
  repo: string;
  prNumber: number;
  reviewDir: string;
  trigger: ReviewTrigger;
  token: string;
  abortController: AbortController;
  logsUrl?: string;
}): Promise<ReviewRecord | undefined> => {
  const { repo, prNumber, reviewDir, trigger } = args;
  const github = createGitHub(args.token);
  const store = createStore();
  const runId = randomUUID();
  const startedAt = new Date();
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: reviewDir,
    timeout: 30_000,
  })
    .toString()
    .trim();
  const agentVersion = process.env.AGENT_VERSION ?? "unknown";
  const config = getAgent("pr-reviewer");

  if (trigger === "webhook") {
    const locked = await store.acquireLock(repo, prNumber, headSha);
    if (!locked) {
      emit("review_skipped", { repo, pr_number: prNumber, head_sha: headSha, reason: "locked" });
      return undefined;
    }
  }

  // Boot-phase failure: nothing to review yet, so no record. Post enough to
  // GitHub that the check does not sit on pending forever.
  const abort = async (reason: string) => {
    console.error(`review aborted: ${reason}`);
    await github
      .postStatus(repo, headSha, {
        state: "error",
        description: reason.slice(0, 140),
        targetUrl: args.logsUrl,
      })
      .catch((err: unknown) => console.error("error status failed:", err));
    emit("review_failed", { repo, pr_number: prNumber, head_sha: headSha, run_id: runId, reason });
    return undefined;
  };

  let bundle: Bundle;
  let prior: ReviewRecord | undefined;
  try {
    const pull = await github.getPull(repo, prNumber);
    if (pull.isDraft) {
      emit("review_skipped", { repo, pr_number: prNumber, head_sha: headSha, reason: "draft" });
      if (trigger === "re-review") {
        await github
          .postStatus(repo, headSha, {
            state: "error",
            description: "Draft PR: mark it ready and re-trigger",
          })
          .catch(() => undefined);
      }
      return undefined;
    }

    if (trigger !== "re-review") {
      await github
        .postStatus(repo, headSha, {
          state: "pending",
          description: "Review in progress",
          targetUrl: args.logsUrl,
        })
        .catch((err: unknown) => console.error("pending status failed:", err));
    }

    prior = await store.latestRecord(repo, prNumber);
    bundle = await buildBundle({
      repo,
      prNumber,
      reviewDir,
      github,
      priorFindings: priorFindingsFrom(prior),
    });
  } catch (err) {
    return abort(`could not build review input: ${err instanceof Error ? err.message : String(err)}`);
  }

  const finish = (
    partial: Pick<ReviewRecord, "output" | "verdict" | "action" | "gates" | "findings"> &
      Partial<Pick<ReviewRecord, "reviewId" | "tipMovedTo" | "error" | "costUsd" | "model">>,
  ): ReviewRecord => {
    const finishedAt = new Date();
    return {
      runId,
      repo,
      prNumber,
      baseSha: bundle.baseSha,
      headSha,
      trigger,
      agentVersion,
      model: partial.model ?? config.model,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      wallTimeMs: finishedAt.getTime() - startedAt.getTime(),
      costUsd: partial.costUsd ?? null,
      bundle,
      output: partial.output,
      verdict: partial.verdict,
      action: partial.action,
      gates: partial.gates,
      findings: partial.findings,
      reviewId: partial.reviewId,
      tipMovedTo: partial.tipMovedTo,
      error: partial.error,
    };
  };

  const fail = async (reason: string, extra: { output?: ReviewOutput | null; costUsd?: number }) => {
    console.error(`review failed: ${reason}`);
    await github
      .postReview(repo, prNumber, {
        commitId: headSha,
        event: "COMMENT",
        body: renderFailureBody({ runId, headSha, reason }),
        comments: [],
      })
      .catch((err: unknown) => console.error("failure comment failed:", err));
    await github
      .postStatus(repo, headSha, {
        state: "error",
        description: "Review failed",
        targetUrl: args.logsUrl,
      })
      .catch((err: unknown) => console.error("error status failed:", err));
    const record = finish({
      output: extra.output ?? null,
      verdict: "failed",
      action: "failed",
      gates: [],
      findings: [],
      error: reason,
      costUsd: extra.costUsd,
    });
    await store.putRecord(record).catch((err: unknown) => console.error("putRecord failed:", err));
    emit("review_failed", {
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      run_id: runId,
      reason,
      cost_usd: extra.costUsd ?? null,
    });
    return record;
  };

  const result = await runAgent(config, buildReviewPrompt(bundle), {
    cwd: reviewDir,
    abortController: args.abortController,
    mcpServers: { git: createGitTool(reviewDir) },
    env: agentEnv(),
  });

  if (result.errorSubtype) {
    return fail(`agent error (${result.errorSubtype}): ${result.output.slice(0, 300)}`, {
      costUsd: result.costUsd,
    });
  }

  const output = parseReviewOutput(result);
  if ("error" in output) {
    return fail(output.error, { costUsd: result.costUsd });
  }
  if (output.status === "failed") {
    return fail(output.reason, { output, costUsd: result.costUsd });
  }

  const decision = decide(output, { author: bundle.author });
  const priorById = new Map((prior?.findings ?? []).map((f) => [f.id, f]));
  const placed = placeFindings(output.findings, parseDiffAnchors(bundle.diff));

  const carried: PostedFinding[] = [];
  const fresh: Array<{ finding: PostedFinding; demoted: boolean }> = [];
  for (const { finding, demoted } of placed) {
    const priorFinding = finding.priorFindingId
      ? priorById.get(finding.priorFindingId)
      : undefined;
    if (priorFinding) {
      carried.push({
        ...finding,
        id: priorFinding.id,
        commentId: priorFinding.commentId,
        threadId: priorFinding.threadId,
        demoted: priorFinding.demoted,
      });
    } else {
      fresh.push({ finding: { ...finding, id: randomUUID(), demoted }, demoted });
    }
  }

  const body = renderBody({
    decision,
    summary: output.summary,
    runId,
    headSha,
    author: bundle.author,
    carriedForward: carried.map((f) => ({
      id: f.id,
      path: f.path,
      line: f.line,
      url: f.commentId ? commentUrl(repo, prNumber, f.commentId) : undefined,
    })),
    demoted: fresh.filter((f) => f.demoted).map((f) => f.finding),
  });

  const inline = fresh.filter((f) => !f.demoted);
  const posted = await github.postReview(repo, prNumber, {
    commitId: headSha,
    event: decision.action === "approve" ? "APPROVE" : "COMMENT",
    body,
    comments: inline.map(({ finding }) => ({
      path: finding.path,
      line: finding.endLine ?? finding.line,
      side: "RIGHT",
      ...(finding.endLine && finding.endLine !== finding.line
        ? { start_line: finding.line, start_side: "RIGHT" as const }
        : {}),
      body: finding.suggestion
        ? `${finding.body}\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``
        : finding.body,
    })),
  });

  for (const { finding } of inline) {
    const match = posted.comments.find(
      (c) => c.path === finding.path && c.line === (finding.endLine ?? finding.line),
    );
    finding.commentId = match?.id;
  }

  if (prior && (carried.length > 0 || prior.findings.length > 0 || inline.length > 0)) {
    const threads = await github
      .listReviewThreads(repo, prNumber)
      .catch((err: unknown) => {
        console.error("listReviewThreads failed:", err);
        return [];
      });
    const carriedIds = new Set(carried.map((f) => f.id));

    for (const { finding } of inline) {
      if (finding.commentId) {
        finding.threadId = github.findThreadIdByCommentId(threads, finding.commentId);
      }
    }

    for (const f of carried) {
      if (!f.threadId) continue;
      const thread = threads.find((t) => t.id === f.threadId);
      if (thread?.isResolved) {
        await github.unresolveThread(f.threadId).catch((err: unknown) =>
          console.error("unresolveThread failed:", err),
        );
      }
      emit("disposition_updated", {
        repo,
        pr_number: prNumber,
        head_sha: headSha,
        finding_id: f.id,
        disposition: "pending",
      });
    }

    for (const pf of prior.findings) {
      if (carriedIds.has(pf.id)) continue;
      if (pf.threadId) {
        const thread = threads.find((t) => t.id === pf.threadId);
        if (thread && !thread.isResolved) {
          await github.resolveThread(pf.threadId).catch((err: unknown) =>
            console.error("resolveThread failed:", err),
          );
        }
      }
      emit("disposition_updated", {
        repo,
        pr_number: prNumber,
        head_sha: headSha,
        finding_id: pf.id,
        disposition: "addressed",
      });
    }
  } else {
    const threads =
      inline.length > 0
        ? await github.listReviewThreads(repo, prNumber).catch(() => [])
        : [];
    for (const { finding } of inline) {
      if (finding.commentId) {
        finding.threadId = github.findThreadIdByCommentId(threads, finding.commentId);
      }
    }
  }

  let tipMovedTo: string | undefined;
  if (decision.action === "approve") {
    const live = await github.getHeadSha(repo, prNumber).catch(() => headSha);
    if (live !== headSha) {
      tipMovedTo = live;
      await github
        .dismissReview(
          repo,
          prNumber,
          posted.reviewId,
          `Reviewed ${headSha.slice(0, 7)}; tip moved to ${live.slice(0, 7)} during review.`,
        )
        .catch((err: unknown) => console.error("dismissReview failed:", err));
    }
  }

  const findingCount = fresh.length + carried.length;
  await github
    .postStatus(repo, headSha, {
      state: "success",
      description:
        decision.action === "approve"
          ? tipMovedTo
            ? "Approved, then dismissed: tip moved"
            : "Approved"
          : `Commented: ${findingCount} finding(s)`,
      targetUrl: args.logsUrl,
    })
    .catch((err: unknown) => console.error("terminal status failed:", err));

  const record = finish({
    output,
    verdict: decision.verdict,
    action: decision.action === "approve" ? "approved" : "commented",
    gates: decision.gates,
    findings: [...fresh.map((f) => f.finding), ...carried],
    reviewId: posted.reviewId,
    tipMovedTo,
    costUsd: result.costUsd,
  });
  await store.putRecord(record);

  emit("review_posted", {
    repo,
    pr_number: prNumber,
    head_sha: headSha,
    run_id: runId,
    trigger,
    verdict: decision.verdict,
    action: record.action,
    gates: decision.gates,
    findings_new: fresh.length,
    findings_carried: carried.length,
    findings_demoted: fresh.filter((f) => f.demoted).length,
    tip_moved: Boolean(tipMovedTo),
    cost_usd: result.costUsd ?? null,
    wall_time_ms: record.wallTimeMs,
  });
  for (const { finding } of fresh) {
    emit("finding_emitted", {
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      run_id: runId,
      finding_id: finding.id,
      file: finding.path,
      line: finding.line,
      category: finding.category,
      confidence: finding.confidence,
      has_suggestion: Boolean(finding.suggestion),
      demoted: finding.demoted,
    });
  }

  return record;
};
