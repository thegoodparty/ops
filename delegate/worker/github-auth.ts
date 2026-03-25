import { createAppAuth } from "@octokit/auth-app";

export const setupGitHubAuth = async () => {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) {
    throw new Error("GITHUB_APP_PRIVATE_KEY environment variable not set");
  }

  const auth = createAppAuth({
    appId: 3107048,
    privateKey: [
      "-----BEGIN RSA PRIVATE KEY-----",
      raw
        .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
        .replace(/-----END RSA PRIVATE KEY-----/, "")
        .replace(/\s+/g, ""),
      "-----END RSA PRIVATE KEY-----",
    ].join("\n"),
    installationId: 117364330,
  });

  const { token } = await auth({ type: "installation" });
  process.env.GITHUB_TOKEN = token;
  console.log("GitHub App installation token acquired");
};
