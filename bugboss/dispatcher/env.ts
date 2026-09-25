// The environment a child agent runs with. Design spec:
// bugboss/docs/architecture.md, Authentication.
//
// The child environment is built up from nothing rather than filtered down
// from process.env. Agents share a container with the Slack token, the GitHub
// token and S3 write credentials, and they read attacker-writable log lines
// for a living, so an allowlist the composition root owns is the only thing
// that reaches them.
//
// WHY THIS IS NOT A BLANKET "NO AWS VARIABLES" SCRUB:
//
// On Fargate the task role is delivered through
// AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, not through AWS_ACCESS_KEY_ID,
// which is never set there. Dropping every AWS_* name would therefore remove
// nothing that matters while also removing the agent's Bedrock access and its
// read-only investigation access. So the boundary is an IAM role rather than
// a list of variable names: strip every ambient credential path, then inject
// the temporary credentials of a dedicated read-only agent role. See
// ./credentials.ts.

import type { AgentAwsCredentials } from "./credentials";

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
  /** Temporary credentials for the agent role, assumed by the parent. */
  aws: AgentAwsCredentials;
  incidentId: string;
  /** Scoped to this one incident. */
  token: string;
  sessionRef: string | null;
  /** Epoch ms. The agent's own in-container deadline. */
  deadlineAt: number;
  attempt: number;
}

export interface ChildEnv {
  env: Record<string, string>;
  /** Names dropped on the way in. Nothing is ever dropped silently. */
  stripped: string[];
}

/**
 * Every ambient path by which a child could pick up credentials we did not
 * hand it. The first two are the ones that actually matter on Fargate: they
 * are the task role, which holds S3 write and Secrets Manager.
 */
export const AMBIENT_CREDENTIAL_VARS = [
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
] as const;

/** The three we inject, listed so nothing else can smuggle them in. */
export const INJECTED_AWS_VARS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

export const CHILD_BASE_ENV_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
] as const;

const RESERVED = new Set<string>([
  ...AMBIENT_CREDENTIAL_VARS,
  ...INJECTED_AWS_VARS,
]);

export const isReservedChildEnvVar = (name: string): boolean =>
  RESERVED.has(name.toUpperCase());

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

export const buildChildEnv = (input: ChildEnvInput): ChildEnv => {
  const env: Record<string, string> = {};
  const stripped: string[] = [];

  for (const source of [input.base ?? {}, input.credentials]) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (isReservedChildEnvVar(name)) {
        stripped.push(name);
        continue;
      }
      env[name] = value;
    }
  }

  env.AWS_ACCESS_KEY_ID = input.aws.accessKeyId;
  env.AWS_SECRET_ACCESS_KEY = input.aws.secretAccessKey;
  env.AWS_SESSION_TOKEN = input.aws.sessionToken;
  if (input.aws.expiresAt) {
    env.BUGBOSS_CREDENTIALS_EXPIRE_AT = String(input.aws.expiresAt);
    // The SDK's env provider reads this to know when to re-resolve. Without
    // it the initial credentials look permanent, so if the child's first
    // refresh against the Boss fails, the SDK keeps presenting them past
    // their expiry and the failure surfaces as a Bedrock rejection rather
    // than as the credential problem it is.
    env.AWS_CREDENTIAL_EXPIRATION = new Date(input.aws.expiresAt).toISOString();
  }

  env.BUGBOSS_INCIDENT_ID = input.incidentId;
  env.BUGBOSS_TOKEN = input.token;
  env.BUGBOSS_ATTEMPT = String(input.attempt);
  env.BUGBOSS_DEADLINE_AT = String(input.deadlineAt);
  if (input.sessionRef) env.BUGBOSS_SESSION_REF = input.sessionRef;

  return { env, stripped };
};
