import { dispatch } from "./dispatch";
import { getSecrets } from "./secrets";
import { verifyGithubWebhook } from "./verify";

const REVIEW_AUTHOR_WHITELIST = new Set(["swain", "delegate[bot]"]);
const REVIEW_REPOS = new Set([
  "gp-api",
  "gp-webapp",
  "people-api",
  "election-api",
  "serve-ops",
]);
const DISPATCH_ACTIONS = new Set(["opened", "ready_for_review"]);

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
  if (!REVIEW_AUTHOR_WHITELIST.has(p.pull_request.user?.login ?? ""))
    return false;
  if (!REVIEW_REPOS.has(p.repository.name ?? "")) return false;
  return true;
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

  if (!shouldDispatch(eventType, payload)) {
    console.log(
      JSON.stringify({
        event: "github_webhook_skipped",
        eventType,
        deliveryId,
      }),
    );
    return OK;
  }

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

  return OK;
};
