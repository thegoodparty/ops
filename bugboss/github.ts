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

import type { PrStateReader, ReportPr } from "./report";

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
 * Returns the current installation token, minting a new one when the cached
 * one is spent. Call it before each use rather than holding the result: over a
 * day-long incident the value changes underneath you.
 */
export const createInstallationToken = (
  config: GitHubAppConfig,
): (() => Promise<string>) => {
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: normalizePrivateKey(config.privateKey),
    installationId: config.installationId,
  });
  return async () => (await auth({ type: "installation" })).token;
};

// ---------------------------------------------------------------------------
// What became of a PR
// ---------------------------------------------------------------------------

/**
 * Only the shape a BugBoss agent can produce. `prUrls` is whatever the model
 * put there, so anything that is not a pull request url is left unanswered
 * rather than guessed at.
 */
const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

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
): PrStateReader => ({
  states: async (urls) => {
    const token = await installationToken();
    const found: Record<string, ReportPr["state"]> = {};
    await Promise.all(
      urls.map(async (url) => {
        const parsed = PR_URL.exec(url.trim());
        if (!parsed) return;
        const [, owner, repo, number] = parsed;
        try {
          const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
            {
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "x-github-api-version": "2022-11-28",
              },
              signal: AbortSignal.timeout(PR_STATE_TIMEOUT_MS),
            },
          );
          if (!res.ok) return;
          const body = (await res.json()) as PullRequestBody;
          found[url] = body.merged_at
            ? "merged"
            : body.state === "open"
              ? "open"
              : body.state === "closed"
                ? "closed"
                : null;
        } catch {
          // Left absent, which renders as "state not known".
        }
      }),
    );
    return found;
  },
});
