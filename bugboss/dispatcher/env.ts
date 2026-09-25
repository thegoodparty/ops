// The environment a child agent runs with. Design spec:
// bugboss/docs/architecture.md, "What bounds an agent".
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

export const CHILD_BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  ...AWS_CREDENTIAL_PATH_VARS,
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

/** Whether a built child environment can resolve AWS credentials at all. */
export const hasAwsCredentialPath = (env: Record<string, string>): boolean =>
  AWS_CREDENTIAL_PATH_VARS.some((name) => env[name] !== undefined);

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
  if (input.sessionRef) env.BUGBOSS_SESSION_REF = input.sessionRef;

  return env;
};
