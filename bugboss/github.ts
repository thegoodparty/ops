// GitHub App credentials for the incident agent.
//
// The agent gets the App's own credentials rather than a token minted for it,
// because an installation token lasts an hour and an incident can run for a
// day. A token handed down at launch would expire mid-investigation, and the
// failure would surface as `gh` refusing to push a branch the agent had
// already built.
//
// @octokit/auth-app caches and refreshes on its own, so the agent re-mints
// only when the current token is close to expiry.

import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";

import { makeAlarm, makeLog } from "./logging";

import type { PrStateReader, ReportPr } from "./report";

const alarm = makeAlarm("github");
const log = makeLog("github");

/**
 * Secrets Manager stores the PEM as one line, since JSON has no way to carry
 * the newlines. Rebuilding the armour is what makes it parse. Same shape as
 * `delegate/worker/github-auth.ts`, which solved this first.
 */
export const normalizePrivateKey = (raw: string): string => {
  const body = raw
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "")
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const header = /BEGIN PRIVATE KEY/.test(raw)
    ? "PRIVATE KEY"
    : "RSA PRIVATE KEY";
  return [`-----BEGIN ${header}-----`, body, `-----END ${header}-----`].join(
    "\n",
  );
};

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

export const gitHubAppFromEnv = (
  env: NodeJS.ProcessEnv,
): GitHubAppConfig | null => {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!appId || !privateKey || !installationId) return null;
  return { appId, privateKey, installationId };
};

/**
 * Where GitHub is, for everything BugBoss asks it. Unset is github.com and
 * nothing else: production never sets `BUGBOSS_GITHUB_URL`, and the values
 * below are exactly the ones every call site hardcoded before this existed.
 *
 * Anything else is a GitHub Enterprise-shaped host, which is what the eval
 * harness's stand-in is: REST under `/api/v3` and GraphQL at `/api/graphql`,
 * because that is the only layout `gh` will talk to on a host that is not
 * github.com. A value that is not an https origin is refused rather than
 * repaired, since `gh` and git both insist on https and a half-understood URL
 * here would send the App's token somewhere nobody chose.
 */
export interface GitHubEndpoints {
  /** The web origin, e.g. `https://github.com`. PR urls live under it. */
  webUrl: string;
  /** The host, with a port when there is one: what `GH_HOST` names. */
  host: string;
  /** The REST base, without a trailing slash. */
  apiUrl: string;
  /** True for anything but github.com, which is when `gh` needs `GH_HOST`. */
  enterprise: boolean;
}

export const GITHUB_DOT_COM: GitHubEndpoints = {
  webUrl: "https://github.com",
  host: "github.com",
  apiUrl: "https://api.github.com",
  enterprise: false,
};

export const gitHubEndpoints = (githubUrl?: string): GitHubEndpoints => {
  if (githubUrl === undefined || githubUrl === "") return GITHUB_DOT_COM;
  const url = new URL(githubUrl);
  if (url.protocol !== "https:") {
    throw new Error(`BUGBOSS_GITHUB_URL must be https, got ${githubUrl}`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`BUGBOSS_GITHUB_URL must be an origin with no path, got ${githubUrl}`);
  }
  if (url.host === "github.com") return GITHUB_DOT_COM;
  return {
    webUrl: url.origin,
    host: url.host,
    apiUrl: `${url.origin}/api/v3`,
    enterprise: true,
  };
};

/**
 * Returns the current installation token, minting a new one when the cached
 * one is spent. Call it before each use rather than holding the result: over a
 * day-long incident the value changes underneath you.
 */
export const createInstallationToken = (
  config: GitHubAppConfig,
  endpoints: GitHubEndpoints = GITHUB_DOT_COM,
): (() => Promise<string>) => {
  // No `request` at all for github.com, rather than one pointed at the same
  // place: the library's own default is what production has always run on.
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: normalizePrivateKey(config.privateKey),
    installationId: config.installationId,
    ...(endpoints.enterprise
      ? { request: request.defaults({ baseUrl: endpoints.apiUrl }) }
      : {}),
  });
  return async () => (await auth({ type: "installation" })).token;
};

// ---------------------------------------------------------------------------
// What became of a PR
// ---------------------------------------------------------------------------

/**
 * Only the shape a BugBoss agent can produce. `prUrls` is whatever the model
 * put there, so anything that is not a pull request url on the configured
 * GitHub is left unanswered rather than guessed at.
 */
const prUrlPattern = (webUrl: string): RegExp =>
  new RegExp(
    `^${webUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/([^/\\s]+)\\/([^/\\s]+)\\/pull\\/(\\d+)(?:[/?#].*)?$`,
  );

/** GitHub says `closed` for a merged PR too, so `merged_at` is the difference. */
interface PullRequestBody {
  state?: string;
  merged_at?: string | null;
}

const PR_STATE_TIMEOUT_MS = 5_000;

/**
 * Reads whether each PR merged, for the closing report.
 *
 * Deliberately per-url and deliberately forgiving: a report is a notification
 * on an already-committed transition, so a PR GitHub will not answer for is
 * left out of the result and rendered as "state not known". Saying a PR
 * merged when it did not is the one outcome worth avoiding here.
 */
export const createPrStateReader = (
  installationToken: () => Promise<string>,
  endpoints: GitHubEndpoints = GITHUB_DOT_COM,
): PrStateReader => {
  const prUrl = prUrlPattern(endpoints.webUrl);
  return {
    states: async (urls) => {
      const token = await installationToken();
      const found: Record<string, ReportPr["state"]> = {};
      await Promise.all(
        urls.map(async (url) => {
          const parsed = prUrl.exec(url.trim());
          if (!parsed) return;
          const [, owner, repo, number] = parsed;
          try {
            const res = await fetch(
              `${endpoints.apiUrl}/repos/${owner}/${repo}/pulls/${number}`,
              {
                headers: {
                  accept: "application/vnd.github+json",
                  authorization: `Bearer ${token}`,
                  "x-github-api-version": "2022-11-28",
                },
                signal: AbortSignal.timeout(PR_STATE_TIMEOUT_MS),
              },
            );
            if (!res.ok) {
              // 401, 403 and 404 are not this PR's bad luck. A rotated private
              // key, a suspended installation, or an App that was never put on
              // the repository will answer the same way for every PR on every
              // incident until a human changes something -- and GitHub masks a
              // repository an installation cannot see as 404 rather than 403,
              // which is the same trap `agent/rerun.ts` has to explain to the
              // agent. A 5xx is weather: the next report will be fine. Only the
              // first kind is a failure nobody asked for.
              const durable =
                res.status === 401 || res.status === 403 || res.status === 404;
              (durable ? alarm : log)("pr_state_unavailable", {
                url,
                status: res.status,
              });
              return;
            }
            const body = (await res.json()) as PullRequestBody;
            found[url] = body.merged_at
              ? "merged"
              : body.state === "open"
                ? "open"
                : body.state === "closed"
                  ? "closed"
                  : null;
          } catch (err) {
            // Left absent, which renders as "state not known" -- but said out
            // loud, because a report that quietly stops naming PR outcomes
            // reads exactly like a report for an incident that opened none.
            //
            // The bound firing is the bound doing the job it was given, so it
            // is news about this one request and nothing more. Anything else
            // thrown here is a request that never got an answer for a reason
            // nobody chose, and is worth waking someone for on the same
            // grounds as a 401 above.
            const name = (err as { name?: string }).name;
            const transient = name === "TimeoutError" || name === "AbortError";
            (transient ? log : alarm)("pr_state_unavailable", {
              url,
              error: String(err),
            });
          }
        }),
      );
      return found;
    },
  };
};
