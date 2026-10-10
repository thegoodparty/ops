import "../agents";
import { execFileSync } from "node:child_process";
import type { AgentJob } from "../framework";
import { setupReviewerGitHubAuth } from "./github-auth";
import { runReview } from "../review/run";

// The lambda posts :eyes: as the reviewer App when a `delegate review`
// comment fires; delete it once the review lands so the comment stops
// showing the in-progress signal. Same identity that owns the reaction.
const removeGitHubReaction = async (job: AgentJob, token: string) => {
  const { reactionRepo, reactionCommentId, reactionId } = job.metadata ?? {};
  if (!reactionRepo || !reactionCommentId || !reactionId) return;
  await fetch(
    `https://api.github.com/repos/${reactionRepo}/issues/comments/${reactionCommentId}/reactions/${reactionId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  ).catch((err: unknown) => {
    console.error("Failed to remove eyes reaction:", err);
  });
};

const parseJob = (): AgentJob | undefined => {
  const raw = process.env.AGENT_JOB;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AgentJob;
  } catch {
    return undefined;
  }
};

const main = async () => {
  const job = parseJob();
  if (!job) {
    console.error("AGENT_JOB environment variable not set or invalid JSON");
    process.exit(1);
  }

  if (job.agent !== "pr-reviewer") {
    console.error(`Unknown agent "${job.agent}"; only pr-reviewer runs here`);
    process.exit(1);
  }

  // Hard wall-clock deadline. The agent's maxTurns/maxBudgetUsd caps only fire
  // between turns, so a tool call that hangs (a Bash/gh/git subprocess that
  // never returns) would otherwise run forever — the delegate cluster
  // accumulated 10 zombie tasks (up to 5 weeks old) before this existed.
  // Abort the SDK query on the deadline; if teardown itself wedges, the
  // unref'd hard-exit timer fires. The blocking git clone below sets its own
  // execFileSync timeout because a sync hang there would starve this timer.
  const deadlineMs = Number(process.env.AGENT_DEADLINE_MS ?? 45 * 60 * 1000);
  const abortController = new AbortController();
  const deadline = setTimeout(() => {
    console.error(`Agent exceeded ${deadlineMs}ms deadline — aborting`);
    abortController.abort();
    setTimeout(() => process.exit(1), 10_000).unref();
  }, deadlineMs);
  deadline.unref();

  // pr-reviewer runs entirely as the reviewer App, including the gh/git
  // checkout below.
  await setupReviewerGitHubAuth();
  process.env.GITHUB_TOKEN = process.env.REVIEWER_GITHUB_TOKEN;
  process.env.GH_TOKEN = process.env.REVIEWER_GITHUB_TOKEN;

  // pr-reviewer: deterministic checkout of the PR's repo at the exact reviewed
  // head SHA, so the reviewer and its specialists read one consistent tree
  // instead of each cloning mid-run. Repo-agnostic (any REVIEW_REPOS repo).
  // The opened/ready dispatch carries headSha; the `delegate review`
  // re-review path omits it, so resolve the live head here. A failed checkout
  // is fatal — the reviewer cannot review code it doesn't have.
  const repoFullName = job.metadata?.repo;
  const prNumber = job.metadata?.prNumber;
  if (!repoFullName || !prNumber) {
    console.error(
      "pr-reviewer job missing repo/prNumber metadata; cannot check out",
    );
    process.exit(1);
  }

  const reviewDir = process.env.REVIEW_DIR ?? "/app/review";
  // Dispatch-time SHA is only a fallback for the failure-status post below.
  // The checkout itself pins to the *live* PR head resolved at boot — a
  // stale or force-pushed-away dispatch SHA isn't reachable from
  // refs/pull/<n>/head and would fail to check out.
  let headSha = job.metadata?.headSha;
  try {
    // Resolve the live PR head and make it the single authoritative SHA for
    // the whole run: the tree is checked out to it, and the agent pins its
    // diff, status posts, and review commit_id to it (via REVIEW_HEAD_SHA).
    // Keeping the reviewed tree, the diff, and the posted verdict on one
    // commit is what stops a mid-run push from landing an approval on
    // commits nobody reviewed.
    headSha = execFileSync(
      "gh",
      [
        "pr",
        "view",
        prNumber,
        "--repo",
        repoFullName,
        "--json",
        "headRefOid",
        "--jq",
        ".headRefOid",
      ],
      { timeout: 30_000 },
    )
      .toString()
      .trim();

    // Shallow-clone the base repo, fetch the PR head ref, then check out the
    // exact SHA. Going through refs/pull/<n>/head is reliable even for fork
    // PRs, whose head commit isn't on any base-repo branch. Submodules
    // (e.g. the ai-rules submodule the deep-reviewer needs) are synced after
    // the checkout so they match the PR's pinned state.
    execFileSync(
      "gh",
      ["repo", "clone", repoFullName, reviewDir, "--", "--depth=50"],
      { stdio: "inherit", timeout: 180_000 },
    );
    execFileSync(
      "git",
      [
        "-C",
        reviewDir,
        "fetch",
        "--depth=50",
        "origin",
        `refs/pull/${prNumber}/head`,
      ],
      { stdio: "inherit", timeout: 120_000 },
    );
    execFileSync("git", ["-C", reviewDir, "checkout", headSha], {
      stdio: "inherit",
      timeout: 60_000,
    });
    execFileSync(
      "git",
      ["-C", reviewDir, "submodule", "update", "--init", "--recursive"],
      { stdio: "inherit", timeout: 120_000 },
    );
    console.log(
      `${repoFullName} PR #${prNumber} checked out at ${reviewDir} (${headSha})`,
    );
  } catch (err) {
    console.error("Failed to check out PR for pr-reviewer:", err);
    // The re-review lambda already flipped the pr-reviewer check to pending;
    // exiting silently would leave it stuck. Post a best-effort error status
    // (state=error — a boot/infra failure, not a review verdict) so the
    // check resolves, as the reviewer App that owns the pending status.
    const token = process.env.REVIEWER_GITHUB_TOKEN;
    if (headSha && token) {
      try {
        await fetch(
          `https://api.github.com/repos/${repoFullName}/statuses/${headSha}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              state: "error",
              context: "pr-reviewer",
              description: "Review boot failed: could not check out the PR",
            }),
          },
        );
      } catch (statusErr) {
        console.error("Failed to post checkout-failure status:", statusErr);
      }
    }
    process.exit(1);
  }

  // The review runs through the deterministic layer: it builds the agent's
  // input, strips every credential from the agent's environment, validates
  // the structured output, and is the only thing that touches GitHub.
  const reviewerToken = process.env.REVIEWER_GITHUB_TOKEN;
  if (!reviewerToken) {
    console.error("REVIEWER_GITHUB_TOKEN missing; pr-reviewer cannot post");
    process.exit(1);
  }
  const taskArn = await fetch(`${process.env.ECS_CONTAINER_METADATA_URI_V4}/task`)
    .then((r) => r.json() as Promise<{ TaskARN?: string }>)
    .then((t) => t.TaskARN)
    .catch(() => undefined);
  const logsUrl = taskArn
    ? `https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#logsV2:log-groups/log-group/$252Faws$252Fecs$252Fdelegate/log-events/agent$252Fagent$252F${taskArn.split("/").pop()}`
    : undefined;

  try {
    await runReview({
      repo: repoFullName,
      prNumber: Number(prNumber),
      reviewDir,
      trigger: job.metadata?.reReview === "true" ? "re-review" : "webhook",
      token: reviewerToken,
      abortController,
      logsUrl,
    });
  } finally {
    clearTimeout(deadline);
    await removeGitHubReaction(job, reviewerToken);
  }
};

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
