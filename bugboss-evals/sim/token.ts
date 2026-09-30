import { writeFileSync, renameSync } from "node:fs";

import { createAppAuth } from "@octokit/auth-app";

import { normalizePrivateKey } from "../../bugboss/github";

/**
 * The trusted half of GitHub access: mints installation tokens scoped to the
 * sandbox repository and nothing else, and keeps a file of the current one
 * fresh. The BugBoss under test reads that file (BUGBOSS_GITHUB_TOKEN_FILE)
 * and never sees the App's private key.
 */

export const SANDBOX_OWNER = "thegoodparty";
export const SANDBOX_REPO = "bugboss-eval-sandbox";

export const SANDBOX_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  actions: "write",
  deployments: "read",
  metadata: "read",
} as const;

export interface AppKey {
  appId: string;
  privateKey: string;
  installationId: string;
}

export const createSandboxMinter = (key: AppKey): (() => Promise<string>) => {
  const auth = createAppAuth({
    appId: key.appId,
    privateKey: normalizePrivateKey(key.privateKey),
    installationId: key.installationId,
  });
  return async () =>
    (
      await auth({
        type: "installation",
        repositoryNames: [SANDBOX_REPO],
        permissions: SANDBOX_PERMISSIONS,
        refresh: true,
      })
    ).token;
};

/** Written whole and renamed, so a reader never sees half a token. */
export const writeToken = (path: string, token: string): void => {
  writeFileSync(`${path}.part`, token, { mode: 0o644 });
  renameSync(`${path}.part`, path);
};

// Tokens last an hour. Refreshing every fifteen minutes means a reader that
// caches for twenty (bugboss/agent/run.ts does) always holds one with at
// least twenty-five minutes left.
export const REFRESH_MS = 15 * 60_000;

if (require.main === module) {
  const path = process.argv[2];
  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID } = process.env;
  if (!path || !GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY || !GITHUB_APP_INSTALLATION_ID) {
    console.error("usage: GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY=… GITHUB_APP_INSTALLATION_ID=… token.ts <file>");
    process.exit(2);
  }
  const mint = createSandboxMinter({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_APP_PRIVATE_KEY,
    installationId: GITHUB_APP_INSTALLATION_ID,
  });
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  const refresh = async () => {
    try {
      writeToken(path, await mint());
      console.error(JSON.stringify({ at: new Date().toISOString(), event: "sandbox_token_refreshed" }));
    } catch (error: unknown) {
      console.error(JSON.stringify({ at: new Date().toISOString(), event: "sandbox_token_failed", error: String(error) }));
    }
  };
  void refresh().then(() => setInterval(() => void refresh(), REFRESH_MS));
}
