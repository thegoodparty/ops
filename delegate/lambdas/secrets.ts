import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});

let cached: Record<string, string> | null = null;

export const getSecrets = async (): Promise<Record<string, string>> => {
  if (cached) return cached;

  const secretArn = process.env.SECRET_ARN;
  if (!secretArn) throw new Error("Missing SECRET_ARN env var");

  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );

  cached = JSON.parse(result.SecretString ?? "{}") as Record<string, string>;
  return cached;
};
