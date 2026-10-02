// The environment an incident agent's shell runs with: bash, a monitor
// command, npm ci and the Grafana MCP server. Design spec:
// bugboss/docs/architecture.md, "The agent boundary".
//
// Built up from nothing rather than filtered down from process.env. The agent
// runs inside the Boss's own process now, and that process holds the Slack
// token, the GitHub App key and the whole secret blob; an agent has no use for
// any of them, so an allowlist the composition root owns is what its shell
// gets.
//
// That allowlist is hygiene, not a boundary: the shell is a child of this
// container and could read /proc. What it buys is that a credential nobody
// handed the agent does not end up in a log line, a transcript or a Slack post
// by accident.
//
// AWS is the deliberate exception. The shell runs on the task role, resolved
// through the container credential provider, which refreshes on its own for
// as long as the run lasts.

export interface AgentShellEnvInput {
  /**
   * Non-secret process essentials a shell needs to run at all: PATH, HOME and
   * friends. Use pickBaseEnv to take them from the parent explicitly.
   */
  base?: Record<string, string | undefined>;
  /**
   * The outbound credentials the agent's shell is allowed to hold, by
   * variable name. The composition root decides what an agent gets; this
   * module only guarantees nothing else does.
   */
  credentials: Record<string, string | undefined>;
}

/**
 * How the AWS SDK finds the task role inside a container. On Fargate only the
 * relative URI is ever set; the other two are how the same provider is fed
 * outside it, and they cost nothing to carry.
 */
export const AWS_CREDENTIAL_PATH_VARS = [
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
] as const;

/**
 * Where an agent clones from, works, reads its GitHub token, which CA it
 * trusts, how long a review wait settles, and where it sends its AWS calls.
 * Production sets none of them, so a production shell gets nothing from here.
 * The eval harness sets them all: without them the agent's bash and npm ci
 * would be the one place in the run still pointed at omni and real S3.
 */
export const AGENT_EVAL_ENV_NAMES = [
  "BUGBOSS_OMNI_REPO",
  "BUGBOSS_WORK_ROOT",
  "BUGBOSS_GITHUB_TOKEN_FILE",
  "BUGBOSS_REVIEW_SETTLE_SECONDS",
  "NODE_EXTRA_CA_CERTS",
] as const;

const AWS_ENDPOINT = /^AWS_ENDPOINT_URL(_[A-Z0-9_]+)?$/;

export const AGENT_BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  ...AWS_CREDENTIAL_PATH_VARS,
  ...AGENT_EVAL_ENV_NAMES,
] as const;

/** Explicit opt-in for the handful of parent variables a shell needs. */
export const pickBaseEnv = (
  src: Record<string, string | undefined>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of AGENT_BASE_ENV_NAMES) {
    const value = src[name];
    if (value !== undefined) out[name] = value;
  }
  for (const [name, value] of Object.entries(src)) {
    if (value !== undefined && AWS_ENDPOINT.test(name)) out[name] = value;
  }
  return out;
};

export const buildAgentShellEnv = (
  input: AgentShellEnvInput,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const source of [input.base ?? {}, input.credentials]) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue;
      env[name] = value;
    }
  }
  return env;
};

/**
 * The allowlist plus the GitHub token as it is right now. `gh` and `git` read
 * the token out of the environment each time they are invoked, and an
 * installation token lasts an hour against an incident that can run for a
 * day, so it is read at every call rather than captured at launch. Without
 * that, the way an expiry shows up is `gh` refusing to push a branch the agent
 * has already built and committed.
 */
export const withGitHubToken = (
  env: Record<string, string>,
  token: string | undefined,
): Record<string, string> =>
  token ? { ...env, GITHUB_TOKEN: token, GH_TOKEN: token } : env;
