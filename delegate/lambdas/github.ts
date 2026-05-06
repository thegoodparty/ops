import { dispatch } from "./dispatch";
import { getSecrets } from "./secrets";
import { verifyGithubWebhook } from "./verify";

// Distinct from delegate/framework/repos.ts:WRITE_REPOS (bot-write scope).
// Update both lists when adding a repo.
const REVIEW_REPOS = new Set([
  "gp-api",
  "gp-webapp",
  "people-api",
  "election-api",
  "gp-ai-projects",
  "ops",
]);
const DISPATCH_ACTIONS = new Set(["opened", "ready_for_review"]);

// Case-insensitive, must be a whole token so "/delegate-review-foo" doesn't match.
const RE_REVIEW_TRIGGER = /(^|\s)\/delegate-review(\s|$)/i;

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
    callback: {
      type: "github-pr",
      repo: repoFullName,
      prNumber: pr.number,
    },
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

const dispatchReReview = async (
  payload: IssueCommentPayload,
  deliveryId: string | undefined,
) => {
  const { issue, comment } = payload;
  const repoFullName = payload.repository.full_name;
  // issue.html_url points at the issue/PR itself; use pull_request.html_url when present for clarity.
  const prUrl = issue.pull_request?.html_url ?? issue.html_url;

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
    callback: {
      type: "github-pr",
      repo: repoFullName,
      prNumber: issue.number,
    },
    metadata: {
      source: "github",
      repo: repoFullName,
      prNumber: String(issue.number),
      author: issue.user.login,
      triggeredBy: comment.user.login,
      reReview: "true",
      deliveryId: deliveryId ?? "",
    },
  });

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
      await dispatchReReview(payload, deliveryId);
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
