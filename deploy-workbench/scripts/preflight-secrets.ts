import { readFileSync } from "node:fs";
import { WORKBENCH_ACCOUNT_ID } from "../../utils/accounts";
import { assumeRoleEnvironment, runAws } from "./aws-role";

/**
 * Fail the deploy before it drains the service if the task definition names a
 * Secrets Manager key that does not exist.
 *
 * On 2026-10-26 an apply rolled out a task definition naming
 * `BIFROST_SETUP_TOKEN` in `bifrost/gateway`, which did not contain that key.
 * ECS discovered it at task launch:
 *
 *   ResourceInitializationError: retrieved secret from Secrets Manager did not
 *   contain json key BIFROST_SETUP_TOKEN
 *
 * The task stopped with `TaskFailedToStart`, `minimumHealthyPercent: 0` had
 * already drained the only healthy task, and the service sat at running 0 /
 * desired 1 for about three hours. The deploy run reported success, because
 * ECS accepts a task definition without resolving its secrets.
 *
 * This check is deliberately derived from the task definition that Pulumi
 * will deploy, not from `GATEWAY_SECRET_KEYS` or any other hand-maintained
 * list: a list in the repo can drift from the synthesized container
 * definitions, and the drift is exactly the failure being guarded against.
 * `deploy.sh` captures `pulumi preview --json` before the full apply (with
 * `pulumi stack export` as the fallback for an unchanged task definition,
 * which can be absent from the preview steps).
 *
 * Comparing keys only is the whole point. The script reads each secret's
 * `SecretString`, parses it, and keeps `Object.keys()`; no value is logged or
 * put in an error message. Anything that prevents the comparison (a missing
 * permission, a secret that is not JSON, a preview with no task definition)
 * fails the run rather than being treated as a pass.
 *
 * Only Secrets Manager references are compared. `container.secrets` is also
 * where ECS accepts an SSM parameter ARN, and the gateway's configuration is
 * injected that way (`BIFROST_CONFIG`, from `/bifrost/config`), so a task
 * definition can carry both kinds. An SSM parameter is not a secret and is not
 * read through `secretsmanager:GetSecretValue`; it is a Pulumi resource in the
 * same stack, so there is no out-of-band write that could be missing. Passing
 * its ARN to `parseSecretReference` used to be a silent misparse - the ARN has
 * no `:secret:` marker, so the fields shifted and the "secret" became `arn` -
 * and the next deploy failed on `ResourceNotFoundException` from a
 * `get-secret-value` for a secret named `arn`. Both halves are pinned by tests.
 */

export type SecretReference = {
  /** The secret's name, used for grouping and for the failure message. */
  secretId: string;
  /**
   * The ARN to hand `aws secretsmanager`, when `valueFrom` carried one. The
   * name alone is not always enough: an RDS-managed secret's ARN ends in the
   * six-character suffix, and stripping it to a name can be ambiguous. A
   * partial ARN is accepted by Secrets Manager in the same account and
   * region, which is the form the stack itself uses.
   */
  secretArn?: string;
  /** The JSON key inside that secret. */
  key: string;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a `secrets[].valueFrom` names an SSM parameter rather than a
 * Secrets Manager secret. The two ARNs differ in the service segment:
 * `arn:aws:ssm:<region>:<account>:parameter/<name>` against
 * `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<key>::`. ECS also
 * allows a bare secret name, which is always a Secrets Manager name.
 */
export const isSsmParameterReference = (valueFrom: string): boolean =>
  /^arn:[^:]+:ssm:[^:]*:[^:]*:parameter\//.test(valueFrom);

/**
 * Read `{ secretId, key }` from an ECS `secrets[].valueFrom` reference.
 *
 * A `valueFrom` that is an ARN for some other service is rejected rather than
 * parsed: there is no unambiguous reading of it as `<secret>:<key>::`, and the
 * silent alternative is the wrong-field interpretation described at the top of
 * this file.
 *
 * The stack builds these as
 * `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<key>::`, and the
 * RDS-managed password is a full ARN with Secrets Manager's six-character
 * suffix. Both end in `:<key>:<versionStage>:<versionId>`, so the key is the
 * third field from the end and the secret is everything between `:secret:`
 * and the key. Secret names cannot contain `:`, so splitting is unambiguous.
 */
export const parseSecretReference = (valueFrom: string): SecretReference => {
  const marker = ":secret:";
  const markerAt = valueFrom.indexOf(marker);

  if (markerAt === -1 && valueFrom.startsWith("arn:")) {
    throw new Error(
      `not a Secrets Manager key reference (no ":secret:" in the ARN): ${valueFrom}`,
    );
  }

  const nameAndKey =
    markerAt === -1 ? valueFrom : valueFrom.slice(markerAt + marker.length);
  const parts = nameAndKey.split(":");

  if (parts.length < 4) {
    throw new Error(
      `not a Secrets Manager key reference (expected <secret>:<key>::): ${valueFrom}`,
    );
  }

  const secretId = parts[0];
  const key = parts[parts.length - 3];

  if (!secretId || !key) {
    throw new Error(
      `not a Secrets Manager key reference (expected <secret>:<key>::): ${valueFrom}`,
    );
  }

  if (markerAt === -1) {
    return { secretId, key };
  }

  // Drop `:<key>:<versionStage>:<versionId>` and keep the ARN as written,
  // including the suffix when the reference is a full ARN.
  const suffix = `:${parts.slice(-3).join(":")}`;
  return {
    secretId,
    secretArn: valueFrom.slice(0, valueFrom.length - suffix.length),
    key,
  };
};

/**
 * Find every task-definition object in a Pulumi preview or stack-export
 * document. Walking the document rather than relying on one fixed path keeps
 * this working across the two shapes: preview resources carry `newState`,
 * exported state resources are the state itself.
 */
const containerDefinitionsFrom = (document: unknown): unknown[] => {
  const found: unknown[] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;

    const urn = node.urn;
    if (
      typeof urn === "string" &&
      urn.includes("aws:ecs/taskDefinition:TaskDefinition")
    ) {
      const state = isRecord(node.newState) ? node.newState : node;
      for (const candidate of [state.inputs, state.outputs, state]) {
        if (isRecord(candidate) && candidate.containerDefinitions !== undefined) {
          found.push(candidate.containerDefinitions);
          break;
        }
      }
    }

    for (const value of Object.values(node)) visit(value);
  };

  visit(document);
  return found;
};

const parseContainerDefinitions = (
  raw: unknown,
): Array<{ secrets?: unknown }> => {
  let definitions = raw;

  if (typeof raw === "string") {
    try {
      definitions = JSON.parse(raw);
    } catch {
      throw new Error(
        "the synthesized task definition's containerDefinitions is not valid JSON",
      );
    }
  }

  if (!Array.isArray(definitions)) {
    throw new Error(
      "the synthesized task definition's containerDefinitions is not a list",
    );
  }

  return definitions as Array<{ secrets?: unknown }>;
};

/**
 * Every secret key the task definition will ask the ECS agent to resolve.
 *
 * The first document that contains a task definition wins: the preview is the
 * thing about to be applied. The stack export is passed as the second document
 * only to cover the case where an unchanged task definition is not a preview
 * step at all.
 */
export const extractRequiredSecretReferences = (
  ...documents: unknown[]
): SecretReference[] => {
  const references: SecretReference[] = [];
  const seen = new Set<string>();
  let sawTaskDefinition = false;

  for (const document of documents) {
    const definitions = containerDefinitionsFrom(document);
    if (definitions.length === 0) continue;
    sawTaskDefinition = true;

    for (const raw of definitions) {
      for (const container of parseContainerDefinitions(raw)) {
        if (!isRecord(container) || !Array.isArray(container.secrets)) continue;

        for (const secret of container.secrets) {
          if (!isRecord(secret) || typeof secret.valueFrom !== "string") {
            throw new Error(
              "the synthesized task definition has a secret entry without a valueFrom",
            );
          }

          // An SSM parameter in `secrets` is how ECS injects the gateway's
          // config; it is not a secret and there is nothing out of band that
          // could be missing. See the header.
          if (isSsmParameterReference(secret.valueFrom)) continue;

          const reference = parseSecretReference(secret.valueFrom);
          const identity = `${reference.secretId}\u0000${reference.key}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          references.push(reference);
        }
      }
    }

    // The preview described the task definition, so there is nothing the
    // exported state can add.
    break;
  }

  if (!sawTaskDefinition) {
    throw new Error(
      "could not find an ECS task definition in the preview or exported stack state; refusing to report success without comparing anything",
    );
  }

  return references;
};

export const missingSecretKeys = (
  required: readonly SecretReference[],
  actualKeysBySecret: ReadonlyMap<string, ReadonlySet<string>>,
): SecretReference[] =>
  required.filter(
    ({ secretId, key }) => !actualKeysBySecret.get(secretId)?.has(key),
  );

export const formatMissingSecretKeys = (
  missing: readonly SecretReference[],
): string => {
  const bySecret = new Map<string, string[]>();
  for (const { secretId, key } of missing) {
    const keys = bySecret.get(secretId) ?? [];
    keys.push(key);
    bySecret.set(secretId, keys);
  }

  const details = [...bySecret.entries()].map(
    ([secretId, keys]) => `  ${secretId}: ${keys.join(", ")}`,
  );

  return [
    "Secret preflight failed: the task definition references Secrets Manager keys that do not exist.",
    ...details,
    "",
    "ECS would discover this only at task launch, after the apply has drained the running task:",
    ...missing.map(
      ({ key }) =>
        `  ResourceInitializationError: retrieved secret from Secrets Manager did not contain json key ${key}`,
    ),
    "",
    "Fill the missing keys with deploy-workbench/bifrost/fill-secrets.sh, then deploy again.",
  ].join("\n");
};

const DEFAULT_ROLE_ARN = `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/pulumi-deploy`;
const DEFAULT_REGION = "us-west-2";

const argument = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const readJson = (file: string, description: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read the ${description} at ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/** Read only the key names. The value is parsed and discarded. */
const listSecretKeys = (
  secretId: string,
  region: string,
  env: NodeJS.ProcessEnv,
): Set<string> => {
  const raw = runAws(
    [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      secretId,
      "--query",
      "SecretString",
      "--output",
      "text",
      "--region",
      region,
    ],
    env,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `secret ${secretId} does not contain a JSON SecretString, so its keys cannot be compared`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `secret ${secretId} does not contain a JSON object, so its keys cannot be compared`,
    );
  }

  return new Set(Object.keys(parsed));
};

export const main = (argv: string[] = process.argv.slice(2)): number => {
  try {
    const previewPath = argument(argv, "--preview");
    if (!previewPath) {
      throw new Error("--preview <pulumi preview --json output> is required");
    }

    const documents: unknown[] = [readJson(previewPath, "Pulumi preview")];
    const exportPath = argument(argv, "--stack-export");
    if (exportPath) {
      documents.push(readJson(exportPath, "exported Pulumi stack state"));
    }

    const required = extractRequiredSecretReferences(...documents);
    if (required.length === 0) {
      throw new Error(
        "the task definition references no Secrets Manager keys; refusing to treat an empty comparison as a pass",
      );
    }

    const roleArn =
      argument(argv, "--role-arn") ??
      process.env.WORKBENCH_DEPLOY_ROLE_ARN ??
      DEFAULT_ROLE_ARN;
    const region =
      argument(argv, "--region") ?? process.env.AWS_REGION ?? DEFAULT_REGION;
    const env = assumeRoleEnvironment(roleArn, "bifrost-secret-preflight");

    const secretIds = [...new Set(required.map(({ secretId }) => secretId))];
    const actualKeys = new Map<string, Set<string>>();

    for (const secretId of secretIds) {
      const identifier =
        required.find((reference) => reference.secretId === secretId)
          ?.secretArn ?? secretId;
      try {
        actualKeys.set(secretId, listSecretKeys(identifier, region, env));
      } catch (error) {
        throw new Error(
          `could not read the keys of ${secretId} in ${region}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const missing = missingSecretKeys(required, actualKeys);
    if (missing.length > 0) {
      console.error(formatMissingSecretKeys(missing));
      return 1;
    }

    console.log(
      `Secret preflight passed: ${required.length} referenced key(s) across ${secretIds.length} secret(s) are present.`,
    );
    return 0;
  } catch (error) {
    console.error(
      `Secret preflight could not complete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
};

if (require.main === module) {
  process.exitCode = main();
}
