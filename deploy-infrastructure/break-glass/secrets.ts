import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * Reads the break-glass Slack secret, following the pattern in
 * `delegate/lambdas/secrets.ts`: a cached module-level read of the JSON secret
 * named by `SECRET_ARN`.
 *
 * Local rather than imported for the same reason as `verify.ts`: the
 * break-glass function must not depend on the delegate bundle. It reads only
 * the tool's own secret, never `DELEGATES`.
 */
const client = new SecretsManagerClient({});

let cached: Record<string, string> | null = null;

export const getSecrets = async (): Promise<Record<string, string>> => {
  if (cached) return cached;

  const secretArn = process.env.SECRET_ARN;
  if (!secretArn) throw new Error("Missing SECRET_ARN env var");

  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );

  cached = JSON.parse(result.SecretString ?? "{}") as Record<string, string>;
  return cached;
};
