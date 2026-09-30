// The environment a child agent runs with. Design spec:
// bugboss/docs/architecture.md, "The agent boundary".
//
// The child environment is built up from nothing rather than filtered down
// from process.env. The container holds the Slack token, the GitHub App key
// and the whole secret blob, and an agent has no use for any of them, so an
// allowlist the composition root owns is what a child gets.
//
// That allowlist is hygiene, not a boundary: the child is a process of this
// container and can read the parent's own environment. What it buys is that
// a credential nobody handed the agent does not end up in a log line, a
// session transcript or a Slack post by accident.
//
// AWS is the deliberate exception. The child runs on the task role, resolved
// through the container credential provider, which refreshes on its own for
// as long as the run lasts.

import { gitHubEndpoints } from "../github";

export interface ChildEnvInput {
  /**
   * Non-secret process essentials a child needs to run at all: PATH, HOME and
   * friends. Use pickBaseEnv to take them from the parent explicitly.
   */
  base?: Record<string, string | undefined>;
  /**
   * The outbound credentials this child is allowed to hold, by variable name
   * (GitHub, Grafana, and so on). The composition root decides what an agent
   * gets; this module only guarantees nothing else does.
   */
  credentials: Record<string, string | undefined>;
  incidentId: string;
  /** Scoped to this one incident. */
  token: string;
  sessionRef: string | null;
  /** Epoch ms. The agent's own in-container deadline. */
  deadlineAt: number;
  /**
   * Turns this incident's agent may take in total, across every launch.
   * Absolute rather than remaining: the child counts what the restored
   * session already holds, which is the only copy either side has.
   */
  maxTurns: number;
  attempt: number;
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
 * Static keys, which production never sets: the task role arrives through the
 * container provider above. The eval harness sets fake ones, which MinIO
 * accepts and the model proxy re-signs over, so the agent there holds nothing
 * that reaches real AWS. A named profile is deliberately not here: it would
 * hand the child whatever the parent's credentials file holds.
 */
export const AWS_STATIC_CREDENTIAL_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

export const CHILD_BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  ...AWS_CREDENTIAL_PATH_VARS,
  ...AWS_STATIC_CREDENTIAL_VARS,
] as const;

/** Explicit opt-in for the handful of parent variables a child needs. */
export const pickBaseEnv = (
  src: Record<string, string | undefined>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of CHILD_BASE_ENV_NAMES) {
    const value = src[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
};

/**
 * Where a child's outbound calls go and which certificates it trusts, when
 * the parent was told something other than the defaults.
 *
 * Production sets none of these, so a production child gets nothing from
 * here and every endpoint is the SDK's, git's and `gh`'s own. They exist for
 * the eval harness, which runs this container against stand-ins for GitHub,
 * AWS and the npm registry behind a local certificate authority. Without
 * them the agent in that harness would be the one process in the container
 * still pointed at production -- with real-looking credentials and a real
 * shell, which is the outcome the harness is built to make impossible.
 *
 * `AWS_ENDPOINT_URL_<SERVICE>` is a family rather than a list, because the
 * SDK and the CLI read one per service and the set the agent reaches grows.
 * `PRISMA_ENGINES_MIRROR` is here because `npm ci` in omni downloads Prisma's
 * engines from a host the harness has no route to.
 */
export const CHILD_ENDPOINT_ENV_NAMES = [
  "BUGBOSS_OMNI_REPO",
  "BUGBOSS_GITHUB_URL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
  "npm_config_registry",
  "PRISMA_ENGINES_MIRROR",
  "AWS_ENDPOINT_URL",
] as const;

const AWS_SERVICE_ENDPOINT = /^AWS_ENDPOINT_URL_[A-Z0-9_]+$/;

/**
 * The endpoint overrides the parent holds, plus `GH_HOST` when GitHub is not
 * github.com: `gh` ignores the checkout's remote host for API calls unless it
 * is told, and on any other host it reads `GH_ENTERPRISE_TOKEN` rather than
 * `GH_TOKEN` (`gitHubTokenEnv` below sets that one, since the token is minted
 * in the child).
 */
export const pickEndpointEnv = (
  src: Record<string, string | undefined>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of CHILD_ENDPOINT_ENV_NAMES) {
    const value = src[name];
    if (value !== undefined) out[name] = value;
  }
  for (const [name, value] of Object.entries(src)) {
    if (value !== undefined && AWS_SERVICE_ENDPOINT.test(name)) out[name] = value;
  }
  const github = gitHubEndpoints(src.BUGBOSS_GITHUB_URL);
  if (github.enterprise) out.GH_HOST = github.host;
  return out;
};

/**
 * The variables an installation token is written to, in the child's own
 * environment, each time it is minted. `git` reads `GITHUB_TOKEN` through the
 * credential helper and `gh` reads `GH_TOKEN` for github.com; a `GH_HOST`
 * that is anything else makes `gh` read `GH_ENTERPRISE_TOKEN` instead.
 */
export const gitHubTokenEnv = (
  token: string,
  env: Record<string, string | undefined>,
): Record<string, string> => ({
  GITHUB_TOKEN: token,
  GH_TOKEN: token,
  ...(env.GH_HOST ? { GH_ENTERPRISE_TOKEN: token } : {}),
});

/** Whether a built child environment can resolve AWS credentials at all. */
export const hasAwsCredentialPath = (env: Record<string, string>): boolean =>
  AWS_CREDENTIAL_PATH_VARS.some((name) => env[name] !== undefined) ||
  (env.AWS_ACCESS_KEY_ID !== undefined && env.AWS_SECRET_ACCESS_KEY !== undefined);

export const buildChildEnv = (
  input: ChildEnvInput,
): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const source of [input.base ?? {}, input.credentials]) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue;
      env[name] = value;
    }
  }

  env.BUGBOSS_INCIDENT_ID = input.incidentId;
  env.BUGBOSS_TOKEN = input.token;
  env.BUGBOSS_ATTEMPT = String(input.attempt);
  env.BUGBOSS_DEADLINE_AT = String(input.deadlineAt);
  env.BUGBOSS_MAX_TURNS = String(input.maxTurns);
  if (input.sessionRef) env.BUGBOSS_SESSION_REF = input.sessionRef;

  return env;
};
