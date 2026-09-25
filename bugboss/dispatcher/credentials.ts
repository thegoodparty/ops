// AWS credentials for a child agent. Design spec: bugboss/docs/architecture.md,
// Authentication.
//
// The parent holds the task role: S3 write, Secrets Manager, and every
// outbound token. A child gets temporary credentials for a separate,
// read-only agent role carrying investigation access plus
// bedrock:InvokeModel*, and nothing else. The containment boundary is that
// role, not a list of environment variable names someone has to keep current.
// A fully compromised agent reads AWS and calls Bedrock; it cannot write S3,
// read secrets, or reach the release path.

import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

export interface AgentAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Epoch ms, when known. */
  expiresAt?: number;
}

/** Fresh credentials per launch. Injected so tests never reach STS. */
export type AgentCredentialProvider = (
  incidentId: string,
) => Promise<AgentAwsCredentials>;

export interface AssumeRoleConfig {
  /** Injected, never hardcoded. Chunk 9 creates the role. */
  roleArn: string;
  /**
   * Ask for the longest session the role allows; AssumeRole rejects anything
   * over its MaxSessionDuration. Credentials cannot be refreshed inside a
   * running child, so expiry is one more reason a long agent is restarted,
   * and it resumes from its session at the cost of one turn.
   */
  durationSeconds?: number;
  sts?: STSClient;
}

/** RoleSessionName accepts [\w+=,.@-] and caps at 64 characters. */
const sessionName = (incidentId: string): string =>
  `bugboss-agent-${incidentId}`.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);

export const createAssumeRoleCredentials = (
  cfg: AssumeRoleConfig,
): AgentCredentialProvider => {
  const sts = cfg.sts ?? new STSClient({});
  return async (incidentId) => {
    const res = await sts.send(
      new AssumeRoleCommand({
        RoleArn: cfg.roleArn,
        RoleSessionName: sessionName(incidentId),
        DurationSeconds: cfg.durationSeconds ?? 3600,
      }),
    );
    const c = res.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new Error(`AssumeRole returned no credentials for ${cfg.roleArn}`);
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiresAt: c.Expiration ? c.Expiration.getTime() : undefined,
    };
  };
};
