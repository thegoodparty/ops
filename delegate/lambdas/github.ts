import { dispatch } from "./dispatch";
import { getReviewerInstallationToken } from "./github-auth";
import { getSecrets } from "./secrets";
import { verifyGithubWebhook } from "./verify";

// Distinct from delegate/framework/repos.ts:WRITE_REPOS (bot-write scope).
// Update both lists when adding a repo.
const REVIEW_REPOS = new Set([
  "gp-api",
  "gp-webapp",
  "people-api",
  "election-api",
  "runbooks",
  "gp-ai-projects",
  "ai-rules",
  "gp-sdk",
  "campaign-plan-service",
  "gp-data-platform",
  "candidate-sites",
]);
const DISPATCH_ACTIONS = new Set(["opened", "ready_for_review"]);

// Matches either form, case-insensitive, with whole-token boundaries:
//   @delegate review        (preferred — also matches @delegate-bot / @delegate[bot])
//   /delegate-review        (legacy alias, kept working)
const RE_REVIEW_TRIGGER =
  /(^|\s)(?:@delegate(?:-?bot)?(?:\[bot\])?\s+review|\/delegate-review)(\s|$)/i;

const UNAUTHORIZED = { statusCode: 401, body: "unauthorized" };
const OK = { statusCode: 200, body: "ok" };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type PullRequestPayload = {
  action: string;
  pull_request: {
    number: number;
    draft: boolean;
    html_url: string;
    title: string;
    user: { login: string };
    base: { ref: string };
    head: { sha: string };
  };
  repository: { name: string; full_name: string };
};

type IssueCommentPayload = {
  action: string;
  issue: {
    number: number;
    title: string;
    html_url: string;
    state: string;
    pull_request?: { html_url: string };
    user: { login: string };
  };
  comment: {
    id: number;
    body: string;
    user: { login: string };
  };
  repository: { name: string; full_name: string };
};

export const shouldDispatch = (
  eventType: string | undefined,
  payload: unknown,
): payload is PullRequestPayload => {
  if (eventType !== "pull_request") return false;
  const p = payload as Partial<PullRequestPayload>;
  if (!p?.pull_request || !p?.repository) return false;
  if (!DISPATCH_ACTIONS.has(p.action ?? "")) return false;
  if (p.pull_request.draft) return false;
  if (!REVIEW_REPOS.has(p.repository.name ?? "")) return false;
  return true;
};

export const shouldDispatchReReview = (
  eventType: string | undefined,
  payload: unknown,
): payload is IssueCommentPayload => {
  if (eventType !== "issue_comment") return false;
  const p = payload as Partial<IssueCommentPayload>;
  if (!p?.issue || !p?.comment || !p?.repository) return false;
  if (p.action !== "created") return false;
  // issue_comment fires on both issues and PRs — pull_request is present only on PRs.
  if (!p.issue.pull_request) return false;
  if (p.issue.state !== "open") return false;
  if (!RE_REVIEW_TRIGGER.test(p.comment.body ?? "")) return false;
  if (!REVIEW_REPOS.has(p.repository.name ?? "")) return false;
  return true;
};

const dispatchPullRequest = async (
  payload: PullRequestPayload,
  deliveryId: string | undefined,
) => {
  const pr = payload.pull_request;
  const repoFullName = payload.repository.full_name;

  const { taskArn } = await dispatch({
    agent: "pr-reviewer",
    message: `<pr>
  <repo>${esc(repoFullName)}</repo>
  <number>${pr.number}</number>
  <url>${esc(pr.html_url)}</url>
  <title>${esc(pr.title)}</title>
  <author>${esc(pr.user.login)}</author>
  <baseRef>${esc(pr.base.ref)}</baseRef>
  <headSha>${esc(pr.head.sha)}</headSha>
</pr>`,
    metadata: {
      source: "github",
      repo: repoFullName,
      prNumber: String(pr.number),
      author: pr.user.login,
      headSha: pr.head.sha,
      deliveryId: deliveryId ?? "",
    },
  });

  console.log(
    JSON.stringify({
      event: "github_webhook_dispatched",
      repo: repoFullName,
      prNumber: pr.number,
      author: pr.user.login,
      taskArn,
      deliveryId,
    }),
  );
};

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

// Mirrors the URL the pr-reviewer agent builds in its step 1. Keeping these in
// sync matters so the lambda's pending status and the agent's terminal status
// point at the same CloudWatch stream.
const computeLogsUrl = (taskArn: string) => {
  const taskId = taskArn.split("/").pop();
  return `https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#logsV2:log-groups/log-group/$252Faws$252Fecs$252Fdelegate/log-events/agent$252Fagent$252F${taskId}`;
};

// Best-effort :eyes: ack on the triggering comment. Returns the reaction's
// ID on success so the worker can DELETE it after the review posts. Posted as
// the reviewer App so the same identity that ultimately approves owns the
// reaction (and can later remove it). Failures are swallowed — never block
// dispatch on the ack.
const addEyesReaction = async (
  token: string,
  repoFullName: string,
  commentId: number,
): Promise<number | null> => {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/issues/comments/${commentId}/reactions`,
      {
        method: "POST",
        headers: { ...GH_HEADERS(token), "Content-Type": "application/json" },
        body: JSON.stringify({ content: "eyes" }),
      },
    );
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          event: "github_reaction_failed",
          status: res.status,
          repo: repoFullName,
          commentId,
        }),
      );
      return null;
    }
    const data = (await res.json()) as { id: number };
    return data.id;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "github_reaction_error",
        repo: repoFullName,
        commentId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
};

// The issue_comment payload doesn't carry the PR head SHA, but the statuses
// API is keyed on it. One GET to /pulls/{num} resolves it.
const fetchHeadSha = async (
  token: string,
  repoFullName: string,
  prNumber: number,
): Promise<string | null> => {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
      { headers: GH_HEADERS(token) },
    );
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          event: "github_head_sha_fetch_failed",
          status: res.status,
          repo: repoFullName,
          prNumber,
        }),
      );
      return null;
    }
    const data = (await res.json()) as { head?: { sha?: string } };
    return data.head?.sha ?? null;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "github_head_sha_fetch_error",
        repo: repoFullName,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
};

// Flip the pr-reviewer status check to pending immediately on re-review so the
// PR's check stops reading "Approved" / "Commented" from the prior run while
// the worker (re)boots. GitHub status checks accumulate (they don't upsert by
// context+state), so the agent's step 1 explicitly SKIPS its own pending post
// on the re-review path — only this lambda post lands. On the non-re-review
// path (opened / ready_for_review) the lambda does not post pending; the
// agent's step 1 does.
const postPendingStatus = async (
  token: string,
  repoFullName: string,
  sha: string,
  targetUrl: string,
): Promise<void> => {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/statuses/${sha}`,
      {
        method: "POST",
        headers: { ...GH_HEADERS(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          state: "pending",
          context: "pr-reviewer",
          description: "Review in progress",
          target_url: targetUrl,
        }),
      },
    );
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          event: "github_pending_status_failed",
          status: res.status,
          repo: repoFullName,
          sha,
        }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "github_pending_status_error",
        repo: repoFullName,
        sha,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
};

const dispatchReReview = async (
  payload: IssueCommentPayload,
  deliveryId: string | undefined,
  reviewerPrivateKey: string | undefined,
) => {
  const { issue, comment } = payload;
  const repoFullName = payload.repository.full_name;
  // issue.html_url points at the issue/PR itself; use pull_request.html_url when present for clarity.
  const prUrl = issue.pull_request?.html_url ?? issue.html_url;

  // Mint the reviewer App token once and reuse for reaction + status post.
  // If the key isn't provisioned we proceed without either ack; the worker
  // still runs and the agent posts its own status from step 1.
  const token = reviewerPrivateKey
    ? await getReviewerInstallationToken(reviewerPrivateKey).catch((err) => {
        console.warn(
          JSON.stringify({
            event: "github_reviewer_token_error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return null;
      })
    : null;

  // Parallel: react on the comment + fetch the head SHA needed for the
  // pending status post. Both are best-effort.
  const [reactionId, headSha] = await Promise.all([
    token ? addEyesReaction(token, repoFullName, comment.id) : null,
    token ? fetchHeadSha(token, repoFullName, issue.number) : null,
  ]);

  const { taskArn } = await dispatch({
    agent: "pr-reviewer",
    message: `<pr>
  <repo>${esc(repoFullName)}</repo>
  <number>${issue.number}</number>
  <url>${esc(prUrl)}</url>
  <title>${esc(issue.title)}</title>
  <author>${esc(issue.user.login)}</author>
  <reReview>true</reReview>
  <triggeredBy>${esc(comment.user.login)}</triggeredBy>
</pr>`,
    metadata: {
      source: "github",
      repo: repoFullName,
      prNumber: String(issue.number),
      author: issue.user.login,
      triggeredBy: comment.user.login,
      reReview: "true",
      reactionRepo: repoFullName,
      reactionCommentId: String(comment.id),
      ...(reactionId !== null ? { reactionId: String(reactionId) } : {}),
      deliveryId: deliveryId ?? "",
    },
  });

  // Now that we have the task ARN, flip the pr-reviewer commit status to
  // pending with the matching logs URL. Doing this from the lambda closes
  // the 30–60s gap before the worker boots and posts the same status.
  if (token && headSha && taskArn) {
    await postPendingStatus(
      token,
      repoFullName,
      headSha,
      computeLogsUrl(taskArn),
    );
  }

  console.log(
    JSON.stringify({
      event: "github_webhook_re_review_dispatched",
      repo: repoFullName,
      prNumber: issue.number,
      triggeredBy: comment.user.login,
      taskArn,
      deliveryId,
    }),
  );
};

export const handleGithub = async (
  body: string,
  headers: Record<string, string>,
) => {
  const secrets = await getSecrets();
  const secret = secrets["GITHUB_WEBHOOK_SECRET"];
  if (!secret) throw new Error("Missing GITHUB_WEBHOOK_SECRET in secrets");

  const signature = headers["x-hub-signature-256"];
  if (!verifyGithubWebhook(body, signature, secret)) return UNAUTHORIZED;

  const eventType = headers["x-github-event"];
  const deliveryId = headers["x-github-delivery"];

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { statusCode: 400, body: "invalid json" };
  }

  try {
    if (shouldDispatch(eventType, payload)) {
      await dispatchPullRequest(payload, deliveryId);
    } else if (shouldDispatchReReview(eventType, payload)) {
      await dispatchReReview(
        payload,
        deliveryId,
        secrets["REVIEWER_APP_PRIVATE_KEY"],
      );
    } else {
      console.log(
        JSON.stringify({
          event: "github_webhook_skipped",
          eventType,
          deliveryId,
        }),
      );
    }
  } catch (err) {
    // Swallow dispatch failures and return 200 to prevent GitHub from retrying
    // the same delivery for up to 72h — a missed review is far better than N
    // duplicate reviews posted to the PR.
    const p = payload as Partial<PullRequestPayload & IssueCommentPayload>;
    console.error(
      JSON.stringify({
        event: "github_webhook_dispatch_failed",
        eventType,
        deliveryId,
        repo: p.repository?.full_name,
        prNumber: p.pull_request?.number ?? p.issue?.number,
        author: p.pull_request?.user?.login ?? p.issue?.user?.login,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return OK;
};
