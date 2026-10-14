import { execFileSync } from "node:child_process";
import { createAppAuth } from "@octokit/auth-app";

const normalizePrivateKey = (raw: string) =>
  [
    "-----BEGIN RSA PRIVATE KEY-----",
    raw
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
      .replace(/-----END RSA PRIVATE KEY-----/, "")
      .replace(/\s+/g, ""),
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

// Teach git to authenticate to github.com through the gh CLI. `gh` already
// holds the installation token in GH_TOKEN/GITHUB_TOKEN and emits
// `username=x-access-token` for it, so this needs no credential of its own.
// Without it, only gh's own API calls are authenticated: the raw `git fetch`,
// `git checkout` and `git submodule update` in the pr-reviewer worker reach
// GitHub over plain HTTPS with no credential helper, so a private repo fails
// to check out while a public one (no credentials required) succeeds.
//
// Must run after the token is minted and before any checkout, including the
// `gh repo clone` (which shells out to git and needs the helper too). The
// worker runs as user `agent` with HOME=/home/agent, so this writes
// /home/agent/.gitconfig.
const configureGitCredentials = (token: string) => {
  execFileSync("gh", ["auth", "setup-git", "--hostname", "github.com"], {
    env: { ...process.env, GH_TOKEN: token },
    stdio: "inherit",
    timeout: 30_000,
  });
  console.log("git credential helper configured for github.com");
};

export const setupGitHubAuth = async () => {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) {
    throw new Error("GITHUB_APP_PRIVATE_KEY environment variable not set");
  }

  const auth = createAppAuth({
    appId: 3107048,
    privateKey: normalizePrivateKey(raw),
    installationId: 117364330,
  });

  const { token } = await auth({ type: "installation" });
  process.env.GITHUB_TOKEN = token;
  configureGitCredentials(token);
  console.log("GitHub App installation token acquired");
};

// Mints an installation token for the *reviewer* GitHub App — a separate App
// from the delegate App so that pr-reviewer's approvals come from a distinct
// identity (avoids the self-approval block on PRs authored by delegate[bot]).
export const setupReviewerGitHubAuth = async () => {
  const raw = process.env.REVIEWER_APP_PRIVATE_KEY;
  if (!raw) {
    throw new Error("REVIEWER_APP_PRIVATE_KEY environment variable not set");
  }

  const auth = createAppAuth({
    appId: 3615711,
    privateKey: normalizePrivateKey(raw),
    installationId: 129861839,
  });

  const { token } = await auth({ type: "installation" });
  process.env.REVIEWER_GITHUB_TOKEN = token;
  configureGitCredentials(token);
  console.log("Reviewer GitHub App installation token acquired");
};
