import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getAgent, runAgent } from "../framework";
import { buildReconsiderPrompt } from "../agents/pr-reconsider";
import { renderReconsiderBody } from "./body";
import { createGitTool } from "./git-tool";
import { createGitHub, type ThreadComment } from "./github";
import {
  agentEnv,
  commentUrl,
  latestCompletedRecord,
  parseAgentOutput,
  pathGuardHook,
  STALE_LOCK_MS,
  statusForRecord,
} from "./run";
import {
  ReconsiderOutputSchema,
  type Dispute,
  type PostedFinding,
  type ReconsiderOutput,
  type ReviewRecord,
  type SettledFinding,
  type ThreadReply,
} from "./schema";
import { createStore } from "./store";
import { emit } from "./telemetry";

// Who can answer a finding. The lambda only dispatches a reconsideration for
// a comment from one of these, and the same rule applies to each reply in a
// thread: anyone can comment on a public repo, and a reply from outside the
// team, or from another bot, must not be able to argue a finding away.
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export const threadReplies = (comments: ThreadComment[]): ThreadReply[] =>
  comments.flatMap((c): ThreadReply[] => {
    if (c.byViewer) {
      return [{ role: "reviewer", login: c.authorLogin, body: c.body, createdAt: c.createdAt }];
    }
    if (c.authorIsUser && TRUSTED_ASSOCIATIONS.has(c.authorAssociation)) {
      return [{ role: "human", login: c.authorLogin, body: c.body, createdAt: c.createdAt }];
    }
    return [];
  });

// A finding is in dispute when a trusted human has replied in its thread
// since the bot last spoke there. Without that, there is nothing new to
// weigh and the finding stays open without asking the model.
export const collectDisputes = (
  record: ReviewRecord,
  threads: Array<{ id: string; replies: ThreadComment[] }>,
): Dispute[] =>
  record.findings.flatMap((f): Dispute[] => {
    if (!f.threadId) return [];
    const thread = threads.find((t) => t.id === f.threadId);
    if (!thread) return [];
    const replies = threadReplies(thread.replies);
    let lastReviewer = -1;
    replies.forEach((r, i) => {
      if (r.role === "reviewer") lastReviewer = i;
    });
    if (!replies.slice(lastReviewer + 1).some((r) => r.role === "human")) return [];
    return [
      {
        finding: {
          id: f.id,
          path: f.path,
          line: f.line,
          body: f.body,
          category: f.category,
          headSha: record.headSha,
        },
        replies,
      },
    ];
  });

export type Applied = {
  withdrawn: Array<{ finding: PostedFinding; reason: string }>;
  maintained: Array<{ finding: PostedFinding; reason?: string }>;
};

// The model decides each disputed finding and nothing else. A decision on an
// id it was not asked about, a missing decision, or two decisions for one
// finding fail the run rather than being guessed at.
export const applyDecisions = (
  record: ReviewRecord,
  disputes: Dispute[],
  output: Extract<ReconsiderOutput, { status: "complete" }>,
): Applied | { error: string } => {
  const disputed = new Set(disputes.map((d) => d.finding.id));
  const decided = new Map(output.decisions.map((d) => [d.findingId, d]));
  if (decided.size !== output.decisions.length) {
    return { error: "agent returned more than one decision for a finding" };
  }
  for (const id of decided.keys()) {
    if (!disputed.has(id)) return { error: `agent decided a finding it was not asked about: ${id}` };
  }
  for (const id of disputed) {
    if (!decided.has(id)) return { error: `agent returned no decision for finding ${id}` };
  }
  const withdrawn: Applied["withdrawn"] = [];
  const maintained: Applied["maintained"] = [];
  for (const finding of record.findings) {
    const d = decided.get(finding.id);
    if (d?.decision === "withdraw") withdrawn.push({ finding, reason: d.reason });
    else maintained.push({ finding, reason: d?.reason });
  }
  return { withdrawn, maintained };
};

export const runReconsider = async (args: {
  repo: string;
  prNumber: number;
  reviewDir: string;
  token: string;
  abortController: AbortController;
  triggeredBy?: string;
  logsUrl?: string;
}): Promise<ReviewRecord | undefined> => {
  const { repo, prNumber, reviewDir } = args;
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
  const sha7 = headSha.slice(0, 7);
  const config = getAgent("pr-reconsider");

  const comment = (body: string) =>
    github
      .postIssueComment(repo, prNumber, body)
      .catch((err: unknown) => console.error("reconsider comment failed:", err));

  // The lambda flipped the check to pending. Nothing a reconsideration does
  // short of posting a new review changes the verdict, so every early exit
  // puts back the status of the review it was asked to reconsider.
  const restore = async (record: ReviewRecord | undefined) => {
    const status = record
      ? statusForRecord(record, args.logsUrl)
      : { state: "error" as const, description: "Not reviewed: comment delegate review", targetUrl: args.logsUrl };
    await github
      .postStatus(repo, headSha, status)
      .catch((err: unknown) => console.error("status restore failed:", err));
  };

  let records: ReviewRecord[];
  try {
    const pull = await github.getPull(repo, prNumber);
    if (pull.isDraft) {
      await github
        .postStatus(repo, headSha, {
          state: "error",
          description: "Draft PR: mark it ready and re-trigger",
        })
        .catch(() => undefined);
      emit("reconsider_skipped", { repo, pr_number: prNumber, head_sha: headSha, reason: "draft" });
      return undefined;
    }
    records = await store.listRecords(repo, prNumber);
  } catch (err) {
    const reason = `could not read the PR: ${err instanceof Error ? err.message : String(err)}`;
    await github
      .postStatus(repo, headSha, { state: "error", description: reason.slice(0, 140), targetUrl: args.logsUrl })
      .catch(() => undefined);
    emit("reconsider_failed", { repo, pr_number: prNumber, head_sha: headSha, run_id: runId, reason });
    return undefined;
  }

  // Only a review of this exact commit can be reconsidered: the replies argue
  // about code the bot read, and an approval must land on the sha it covers.
  const forSha = records.filter((r) => r.headSha === headSha);
  const target = latestCompletedRecord(forSha);
  if (!target) {
    await restore(forSha.at(-1));
    await comment(
      `\`${sha7}\` has no completed review to reconsider. Comment \`delegate review\` first.`,
    );
    emit("reconsider_skipped", { repo, pr_number: prNumber, head_sha: headSha, reason: "no_review" });
    return undefined;
  }
  if (target.action === "approved") {
    await restore(target);
    await comment(`\`${sha7}\` is already approved; there is nothing to reconsider.`);
    emit("reconsider_skipped", { repo, pr_number: prNumber, head_sha: headSha, reason: "approved" });
    return undefined;
  }

  let locked = await store.acquireLock(repo, prNumber, headSha, target.runId);
  if (!locked) {
    const acquiredAt = await store
      .lockAcquiredAt(repo, prNumber, headSha, target.runId)
      .catch(() => undefined);
    if (acquiredAt && Date.now() - acquiredAt.getTime() > STALE_LOCK_MS) {
      await store.releaseLock(repo, prNumber, headSha, target.runId).catch(() => undefined);
      locked = await store.acquireLock(repo, prNumber, headSha, target.runId);
    }
  }
  if (!locked) {
    await restore(target);
    await comment(`A reconsideration of the review on \`${sha7}\` is already running.`);
    emit("reconsider_skipped", { repo, pr_number: prNumber, head_sha: headSha, reason: "locked" });
    return undefined;
  }

  // Anything that ends without a new review gives the lock back, so the
  // author can fix what went wrong (or add a reply) and ask again.
  const giveUp = async (message: string, reason: string, costUsd?: number) => {
    await store
      .releaseLock(repo, prNumber, headSha, target.runId)
      .catch((err: unknown) => console.error("releaseLock failed:", err));
    await restore(target);
    await comment(message);
    emit("reconsider_failed", {
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      run_id: runId,
      reconsidered_run_id: target.runId,
      reason,
      cost_usd: costUsd ?? null,
    });
    return undefined;
  };

  let threads: Awaited<ReturnType<typeof github.listReviewThreads>>;
  try {
    threads = await github.listReviewThreads(repo, prNumber);
  } catch (err) {
    const reason = `could not read review threads: ${err instanceof Error ? err.message : String(err)}`;
    return giveUp(`Reconsideration failed: ${reason}. Comment \`delegate reconsider\` to retry.`, reason);
  }

  const disputes = collectDisputes(target, threads);
  if (disputes.length === 0) {
    return giveUp(
      `No open finding on \`${sha7}\` has a new reply from someone with write access. Reply in the finding's thread with your evidence or reasoning, then comment \`delegate reconsider\`.`,
      "no_disputes",
    );
  }

  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await runAgent(
      config,
      buildReconsiderPrompt({
        repo,
        prNumber,
        baseSha: target.baseSha,
        headSha,
        changedFiles: target.bundle.changedFiles,
        disputes,
      }),
      {
        cwd: reviewDir,
        abortController: args.abortController,
        mcpServers: { git: createGitTool(reviewDir) },
        env: agentEnv(),
        preToolUseHooks: [pathGuardHook(reviewDir)],
      },
    );
  } catch (err) {
    const reason = `agent crashed: ${err instanceof Error ? err.message : String(err)}`;
    return giveUp(`Reconsideration failed: ${reason}. Comment \`delegate reconsider\` to retry.`, reason);
  }
  const retry = (reason: string) =>
    giveUp(`Reconsideration failed: ${reason}. Comment \`delegate reconsider\` to retry.`, reason, result.costUsd);

  if (result.errorSubtype) {
    return retry(`agent error (${result.errorSubtype})`);
  }
  const output = parseAgentOutput(result, ReconsiderOutputSchema);
  if ("error" in output) return retry(output.error);
  if (output.status === "failed") return retry(output.reason);
  const applied = applyDecisions(target, disputes, output);
  if ("error" in applied) return retry(applied.error);

  // Same rule as a review: a verdict on a sha that is no longer the tip
  // would attach to code nobody is looking at.
  const live = await github.getHeadSha(repo, prNumber).catch(() => headSha);
  if (live !== headSha) {
    return giveUp(
      `The PR moved to \`${live.slice(0, 7)}\` during the reconsideration, so nothing was posted. Comment \`delegate review\` on the new commit.`,
      "superseded",
      result.costUsd,
    );
  }

  const decisionFor = new Map(output.decisions.map((d) => [d.findingId, d]));
  for (const { finding, reason } of [...applied.withdrawn, ...applied.maintained]) {
    const d = decisionFor.get(finding.id);
    if (!d || !finding.commentId) continue;
    const label = d.decision === "withdraw" ? "**Withdrawn.**" : "**Still blocking.**";
    await github
      .replyToReviewComment(repo, prNumber, finding.commentId, `${label} ${reason}`)
      .catch((err: unknown) => console.error("thread reply failed:", err));
  }
  for (const { finding } of applied.withdrawn) {
    if (!finding.threadId) continue;
    const thread = threads.find((t) => t.id === finding.threadId);
    if (thread && !thread.isResolved) {
      await github
        .resolveThread(finding.threadId)
        .catch((err: unknown) => console.error("resolveThread failed:", err));
    }
  }

  const stillOpen = applied.maintained.map((m) => m.finding);
  const verdict: "approve" | "comment" =
    stillOpen.length === 0 && target.droppedFindings.length === 0 ? "approve" : "comment";
  const link = (f: PostedFinding) => ({
    path: f.path,
    line: f.line,
    url: f.commentId ? commentUrl(repo, prNumber, f.commentId) : undefined,
  });

  let posted: Awaited<ReturnType<typeof github.postReview>>;
  try {
    posted = await github.postReview(repo, prNumber, {
      commitId: headSha,
      event: verdict === "approve" ? "APPROVE" : "COMMENT",
      body: renderReconsiderBody({
        verdict,
        summary: output.summary,
        runId,
        reconsideredRunId: target.runId,
        headSha,
        withdrawn: applied.withdrawn.map((w) => link(w.finding)),
        stillOpen: stillOpen.map(link),
        droppedCount: target.droppedFindings.length,
      }),
      comments: [],
    });
  } catch (err) {
    return retry(`posting the review failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let tipMovedTo: string | undefined;
  if (verdict === "approve") {
    const after = await github.getHeadSha(repo, prNumber).catch(() => headSha);
    if (after !== headSha) {
      tipMovedTo = after;
      await github
        .dismissReview(
          repo,
          prNumber,
          posted.reviewId,
          `Reconsidered ${sha7}; tip moved to ${after.slice(0, 7)} during the run.`,
        )
        .catch((err: unknown) => console.error("dismissReview failed:", err));
    }
  }

  await github
    .postStatus(repo, headSha, {
      state: "success",
      description:
        verdict === "approve"
          ? tipMovedTo
            ? "Approved, then dismissed: tip moved"
            : "Approved after reconsideration"
          : `Commented: ${stillOpen.length} finding(s)`,
      targetUrl: args.logsUrl,
    })
    .catch((err: unknown) => console.error("terminal status failed:", err));

  const settled: SettledFinding[] = applied.withdrawn.map(({ finding, reason }) => ({
    id: finding.id,
    path: finding.path,
    line: finding.line,
    body: finding.body,
    category: finding.category,
    headSha,
    reason,
  }));
  const finishedAt = new Date();
  const record: ReviewRecord = {
    runId,
    repo,
    prNumber,
    baseSha: target.baseSha,
    headSha,
    trigger: "reconsider",
    agentVersion: process.env.AGENT_VERSION ?? "unknown",
    model: config.model,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallTimeMs: finishedAt.getTime() - startedAt.getTime(),
    costUsd: result.costUsd ?? null,
    bundle: target.bundle,
    output: null,
    verdict,
    action: verdict === "approve" ? "approved" : "commented",
    gates: [],
    findings: stillOpen,
    droppedFindings: target.droppedFindings,
    settledFindings: settled,
    reconsideration: {
      reconsideredRunId: target.runId,
      triggeredBy: args.triggeredBy,
      disputes,
      output,
    },
    reviewId: posted.reviewId,
    tipMovedTo,
  };
  await store.putRecord(record).catch((err: unknown) => console.error("putRecord failed:", err));

  emit("reconsider_posted", {
    repo,
    pr_number: prNumber,
    head_sha: headSha,
    run_id: runId,
    reconsidered_run_id: target.runId,
    triggered_by: args.triggeredBy ?? null,
    verdict,
    findings_disputed: disputes.length,
    findings_withdrawn: applied.withdrawn.length,
    findings_open: stillOpen.length,
    tip_moved: Boolean(tipMovedTo),
    cost_usd: result.costUsd ?? null,
    wall_time_ms: record.wallTimeMs,
  });
  for (const { finding } of applied.withdrawn) {
    emit("disposition_updated", {
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      finding_id: finding.id,
      disposition: "withdrawn",
    });
  }

  return record;
};
