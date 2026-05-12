import { createAppAuth } from "@octokit/auth-app";

// IDs mirror delegate/worker/github-auth.ts (reviewer App). Keep in sync.
const REVIEWER_APP_ID = 3615711;
const REVIEWER_INSTALLATION_ID = 129861839;

const normalizePrivateKey = (raw: string) =>
  [
    "-----BEGIN RSA PRIVATE KEY-----",
    raw
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
      .replace(/-----END RSA PRIVATE KEY-----/, "")
      .replace(/\s+/g, ""),
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

// Module-level cache survives across warm Lambda invocations. @octokit/auth-app
// caches the installation token internally with TTL handling, so repeated calls
// don't re-mint until expiry.
let cachedAuth: ReturnType<typeof createAppAuth> | null = null;
let cachedKey: string | null = null;

export const getReviewerInstallationToken = async (
  privateKey: string,
): Promise<string> => {
  if (!cachedAuth || cachedKey !== privateKey) {
    cachedAuth = createAppAuth({
      appId: REVIEWER_APP_ID,
      privateKey: normalizePrivateKey(privateKey),
      installationId: REVIEWER_INSTALLATION_ID,
    });
    cachedKey = privateKey;
  }
  const { token } = await cachedAuth({ type: "installation" });
  return token;
};
