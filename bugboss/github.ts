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
