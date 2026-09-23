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
  console.log("GitHub App installation token acquired");
};

// Mints an installation token for the *reviewer* GitHub App — a separate App
// from the delegate App so that pr-reviewer's approvals come from a distinct
// identity (avoids the self-approval block on PRs authored by delegate[bot]).
// No-op when the private key isn't provisioned, so the worker still boots
// before the secret lands.
export const setupReviewerGitHubAuth = async () => {
  const raw = process.env.REVIEWER_APP_PRIVATE_KEY;
  if (!raw) {
    console.log(
      "REVIEWER_APP_PRIVATE_KEY not set; skipping reviewer GitHub auth",
    );
    return;
  }

  const auth = createAppAuth({
    appId: 3615711,
    privateKey: normalizePrivateKey(raw),
    installationId: 129861839,
  });

  const { token } = await auth({ type: "installation" });
  process.env.REVIEWER_GITHUB_TOKEN = token;
  console.log("Reviewer GitHub App installation token acquired");
};

// Mints an installation token for the dedicated *security* GitHub App — a THIRD
// identity, distinct from both the delegate App (authors PRs) and the reviewer
// App (pr-reviewer). A separate login is what guarantees the security pass never
// gets reconciled by pr-reviewer, which filters its own reviews/threads by its
// bot login. App id + installation id come from env so the App can be
// provisioned with config only (no code change). No-op until the key lands, so
// the worker still boots and the security pass simply doesn't run.
export const setupSecurityGitHubAuth = async () => {
  const raw = process.env.SECURITY_APP_PRIVATE_KEY;
  const appId = process.env.SECURITY_APP_ID;
  const installationId = process.env.SECURITY_INSTALLATION_ID;
  if (!raw || !appId || !installationId) {
    console.log(
      "SECURITY_APP_PRIVATE_KEY/SECURITY_APP_ID/SECURITY_INSTALLATION_ID not all set; skipping security GitHub auth",
    );
    return;
  }

  const auth = createAppAuth({
    appId: Number(appId),
    privateKey: normalizePrivateKey(raw),
    installationId: Number(installationId),
  });

  const { token } = await auth({ type: "installation" });
  process.env.SECURITY_GITHUB_TOKEN = token;
  console.log("Security GitHub App installation token acquired");
};
