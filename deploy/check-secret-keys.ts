/**
 * Apply-time drift check for the `DELEGATES` secret.
 *
 * `deploy/index.ts` no longer reads the secret's value (see
 * `docs/pr-previews.md`, step 3), so the task definition's `secrets` list is
 * driven by `DELEGATE_SECRET_KEYS` in `./delegate-secret`. This reads the live
 * secret and compares the two. `deploy.sh` runs it on apply only, so a preview
 * never needs `secretsmanager:GetSecretValue`.
 *
 * A declared key that is missing is an error: the task would start and then
 * fail on the missing environment variable. A key that is present but not
 * declared is a warning: it is deliberately not passed to the task, but it may
 * mean the secret has drifted from the repo.
 */
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DELEGATE_SECRET_KEYS,
  diffDelegateSecretKeys,
} from "./delegate-secret";

const SECRET_ID = "DELEGATES";

const main = async (): Promise<void> => {
  const client = new SecretsManagerClient({});
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: SECRET_ID })
  );

  if (!result.SecretString) {
    throw new Error(
      `${SECRET_ID} has no SecretString; expected a JSON object of keys`
    );
  }

  const actual = Object.keys(
    JSON.parse(result.SecretString) as Record<string, unknown>
  );
  const { missing, extra } = diffDelegateSecretKeys(actual);

  if (extra.length > 0) {
    console.warn(
      `Warning: ${SECRET_ID} holds ${extra.length} key(s) not declared in ` +
        `deploy/delegate-secret.ts, so they are not passed to the task: ` +
        extra.join(", ")
    );
  }

  if (missing.length > 0) {
    console.error(
      `Error: ${SECRET_ID} is missing ${missing.length} key(s) declared in ` +
        `deploy/delegate-secret.ts: ${missing.join(", ")}. Add them to the ` +
        `secret, or remove them from the declared list.`
    );
    process.exit(1);
  }

  console.log(
    `${SECRET_ID} holds all ${DELEGATE_SECRET_KEYS.length} declared keys.`
  );
};

void main();
