import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PULUMI_UNKNOWN_SENTINEL,
  extractRequiredSecretReferences,
  formatMissingSecretKeys,
  missingSecretKeys,
  parseSecretReference,
} from "./scripts/preflight-secrets";

/**
 * The pre-apply secret check, tested as functions rather than by shelling out
 * to AWS.
 *
 * The check exists because a task definition that names a key a secret does
 * not contain is not a deploy-time error: ECS discovers it at task launch,
 * after `minimumHealthyPercent: 0` has already drained the only healthy task.
 * The incident on 2026-10-26 was `BIFROST_SETUP_TOKEN` absent from
 * `bifrost/gateway`; the service sat at running 0 / desired 1 for three hours
 * and the deploy run reported success.
 *
 * The required keys are derived from the synthesized task definition, not from
 * a list in this repository, so the test fixtures are shaped like Pulumi's
 * preview and stack-export documents rather than like `GATEWAY_SECRET_KEYS`.
 */

const ACCOUNT = "024901689212";
const REGION = "us-west-2";

const secretArn = (name: string, key: string): string =>
  `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${name}:${key}::`;

const containerDefinitions = (
  secrets: Array<{ name: string; valueFrom: string }>,
): unknown[] => [{ name: "bifrost", secrets }];

const previewWith = (definitions: unknown) => ({
  steps: [
    {
      op: "update",
      urn: "urn:pulumi:main::workbench::aws:ecs/taskDefinition:TaskDefinition::bifrostTaskDefinition",
      newState: {
        type: "aws:ecs/taskDefinition:TaskDefinition",
        inputs: { containerDefinitions: JSON.stringify(definitions) },
      },
    },
  ],
});

describe("parseSecretReference", () => {
  it("reads the secret name and JSON key out of a partial ARN", () => {
    assert.deepEqual(
      parseSecretReference(secretArn("bifrost/gateway", "BIFROST_SETUP_TOKEN")),
      {
        secretId: "bifrost/gateway",
        secretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost/gateway`,
        key: "BIFROST_SETUP_TOKEN",
      },
    );
  });

  it("reads a full ARN, including the six-character suffix Secrets Manager adds", () => {
    assert.deepEqual(
      parseSecretReference(
        `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost-db-AbCdEf:password::`,
      ),
      {
        secretId: "bifrost-db-AbCdEf",
        secretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost-db-AbCdEf`,
        key: "password",
      },
    );
  });
  it("refuses an SSM parameter ARN rather than reading its service segment as the secret", () => {
    // The gateway's `BIFROST_CONFIG` is an SSM parameter carried in the same
    // `secrets` list. Splitting it as if it were a Secrets Manager reference
    // yields { secretId: "arn", key: "us-west-2" }, and the deploy then fails
    // on a get-secret-value for a secret named `arn`.
    assert.throws(
      () =>
        parseSecretReference(
          `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/bifrost/config`,
        ),
      /not a Secrets Manager key reference/i,
    );
  });
});

describe("extractRequiredSecretReferences", () => {
  it("skips an SSM parameter and still compares the real secrets beside it", () => {
    // The task definition as the workbench stack actually synthesizes it:
    // item 10's `BIFROST_CONFIG` from `/bifrost/config` sits in the same
    // `secrets` list as the Secrets Manager entries. The parameter is Pulumi's
    // own resource, so it is not a key-presence question.
    const preview = previewWith(
      containerDefinitions([
        {
          name: "BIFROST_CONFIG",
          valueFrom: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/bifrost/config`,
        },
        {
          name: "PG_PASSWORD",
          valueFrom: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost-db-AbCdEf:password::`,
        },
      ]),
    );

    assert.deepEqual(extractRequiredSecretReferences(preview), [
      {
        secretId: "bifrost-db-AbCdEf",
        secretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost-db-AbCdEf`,
        key: "password",
      },
    ]);
  });
  it("derives every key from the task definition Pulumi will deploy", () => {
    const preview = previewWith(
      containerDefinitions([
        {
          name: "BIFROST_SETUP_TOKEN",
          valueFrom: secretArn("bifrost/gateway", "BIFROST_SETUP_TOKEN"),
        },
        {
          name: "PG_PASSWORD",
          valueFrom: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost-db-AbCdEf:password::`,
        },
        {
          name: "OAUTH2_PROXY_CLIENT_ID",
          valueFrom: secretArn("bifrost/oauth2-proxy", "OAUTH2_PROXY_CLIENT_ID"),
        },
      ]),
    );

    assert.deepEqual(extractRequiredSecretReferences(preview), [
      {
        secretId: "bifrost/gateway",
        secretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost/gateway`,
        key: "BIFROST_SETUP_TOKEN",
      },
      {
        secretId: "bifrost-db-AbCdEf",
        secretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost-db-AbCdEf`,
        key: "password",
      },
      {
        secretId: "bifrost/oauth2-proxy",
        secretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost/oauth2-proxy`,
        key: "OAUTH2_PROXY_CLIENT_ID",
      },
    ]);
  });

  it("falls back to the exported state when the preview has no task-definition step", () => {
    // An unchanged task definition can be absent from the preview's steps. The
    // exported state is then exactly what will be deployed, so it is a safe
    // fallback rather than a reason to skip the check.
    const exported = {
      deployment: {
        resources: [
          {
            urn: "urn:pulumi:main::workbench::aws:ecs/taskDefinition:TaskDefinition::bifrostTaskDefinition",
            type: "aws:ecs/taskDefinition:TaskDefinition",
            inputs: {
              containerDefinitions: JSON.stringify(
                containerDefinitions([
                  {
                    name: "BIFROST_SETUP_TOKEN",
                    valueFrom: secretArn(
                      "bifrost/gateway",
                      "BIFROST_SETUP_TOKEN",
                    ),
                  },
                ]),
              ),
            },
          },
        ],
      },
    };

    assert.deepEqual(extractRequiredSecretReferences({ steps: [] }, exported), [
      {
        secretId: "bifrost/gateway",
        secretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost/gateway`,
        key: "BIFROST_SETUP_TOKEN",
      },
    ]);
  });

  it("fails explicitly when no task definition can be found", () => {
    assert.throws(
      () => extractRequiredSecretReferences({ steps: [] }),
      /could not find an ECS task definition/i,
    );
  });
});

describe("extractRequiredSecretReferences on a preview unknown", () => {
  /**
   * The preview that failed deploy run 40725087936 (the merge of #393).
   *
   * `containerDefinitions` is built with `pulumi.jsonStringify` over a
   * `pulumi.all` that carried `aws.ssm.Parameter.version`, and #393 changed
   * `config.json`. The version is assigned by AWS, so at preview it is an
   * unknown, and Pulumi serializes the whole stringified value as this bare
   * sentinel. `typeof` is `"string"`, so the old parse path fell straight into
   * `JSON.parse` and reported "not valid JSON" with nothing else.
   */
  const unknownPreview = (containerDefinitions: unknown) => ({
    steps: [
      {
        op: "update",
        urn: "urn:pulumi:main::workbench::aws:ecs/taskDefinition:TaskDefinition::bifrostTaskDefinition",
        newState: {
          type: "aws:ecs/taskDefinition:TaskDefinition",
          inputs: { containerDefinitions },
        },
      },
    ],
  });

  it("fails closed on the bare sentinel, saying it could not be validated at preview time", () => {
    assert.throws(
      () =>
        extractRequiredSecretReferences(
          unknownPreview(PULUMI_UNKNOWN_SENTINEL),
        ),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /could not be validated at preview time/);
        assert.ok(
          message.includes(PULUMI_UNKNOWN_SENTINEL),
          `the message must name the sentinel it saw:\n${message}`,
        );
        // Everything an operator needs to diagnose it in one read.
        assert.match(message, /containerDefinitions typeof: string/);
        assert.match(message, /Pulumi preview unknown sentinel: yes/);
        assert.match(message, /JSON.parse error: /);
        assert.match(
          message,
          /value \(first \d+ chars, no secret values\): "04da6b54/,
        );
        return true;
      },
    );
  });

  it("does not fall back to the exported state, which describes the running task", () => {
    // The guard exists because a new key is missing from a secret. The export
    // holds the task definition that is already serving, so validating it
    // would compare the old keys and pass while the apply drained the task
    // onto a definition naming the missing one.
    const exported = {
      deployment: {
        resources: [
          {
            urn: "urn:pulumi:main::workbench::aws:ecs/taskDefinition:TaskDefinition::bifrostTaskDefinition",
            inputs: {
              containerDefinitions: JSON.stringify(
                containerDefinitions([
                  {
                    name: "BIFROST_SETUP_TOKEN",
                    valueFrom: secretArn("bifrost/gateway", "BIFROST_SETUP_TOKEN"),
                  },
                ]),
              ),
            },
          },
        ],
      },
    };

    assert.throws(
      () =>
        extractRequiredSecretReferences(
          unknownPreview(PULUMI_UNKNOWN_SENTINEL),
          exported,
        ),
      /could not be validated at preview time/,
    );
  });

  it("names the container and field when the sentinel is inside a definition", () => {
    // A partially-unknown definition, where the JSON string survives and only
    // one field is the sentinel. It reaches the same fail-closed path, and
    // this is the case where the message can point at the field to fix.
    const preview = unknownPreview(
      JSON.stringify([
        {
          name: "bifrost",
          environment: [
            { name: "BIFROST_CONFIG_VERSION", value: PULUMI_UNKNOWN_SENTINEL },
          ],
          secrets: [
            {
              name: "BIFROST_SETUP_TOKEN",
              valueFrom: secretArn("bifrost/gateway", "BIFROST_SETUP_TOKEN"),
            },
          ],
        },
      ]),
    );

    assert.throws(
      () => extractRequiredSecretReferences(preview),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /could not be validated at preview time/);
        assert.match(
          message,
          /bifrost: field environment\[0\]\.value/,
          `the message must name the container and field:\n${message}`,
        );
        return true;
      },
    );
  });

  it("still reports genuinely broken JSON as broken JSON, not as an unknown", () => {
    assert.throws(
      () => extractRequiredSecretReferences(unknownPreview("[{not json")),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /is not valid JSON/);
        assert.match(message, /Pulumi preview unknown sentinel: no/);
        assert.match(message, /JSON.parse error: /);
        assert.match(message, /value \(first \d+ chars/);
        assert.ok(
          !/could not be validated at preview time/.test(message),
          "a parse failure that is not an unknown must not be described as one",
        );
        return true;
      },
    );
  });

  it("accepts the definition the fix synthesizes: the config version is a plain digest", () => {
    // What `ecs.ts` now produces: `BIFROST_CONFIG_VERSION` is a SHA-256 prefix
    // computed in the program, so the preview carries the JSON string rather
    // than the sentinel and the keys can be compared.
    const preview = unknownPreview(
      JSON.stringify([
        {
          name: "bifrost",
          environment: [
            { name: "BIFROST_CONFIG_VERSION", value: "9f2c1ab34d5e" },
          ],
          secrets: [
            {
              name: "BIFROST_CONFIG",
              valueFrom: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/bifrost/config`,
            },
            {
              name: "BIFROST_SETUP_TOKEN",
              valueFrom: secretArn("bifrost/gateway", "BIFROST_SETUP_TOKEN"),
            },
          ],
        },
      ]),
    );

    assert.deepEqual(extractRequiredSecretReferences(preview), [
      {
        secretId: "bifrost/gateway",
        secretArn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:bifrost/gateway`,
        key: "BIFROST_SETUP_TOKEN",
      },
    ]);
  });
});

describe("missingSecretKeys", () => {
  const required = [
    { secretId: "bifrost/gateway", key: "BIFROST_SETUP_TOKEN" },
    { secretId: "bifrost/gateway", key: "FIREWORKS_API_KEY" },
    { secretId: "bifrost/oauth2-proxy", key: "OAUTH2_PROXY_CLIENT_ID" },
  ];

  it("reports a key that is absent from the real secret", () => {
    const actual = new Map<string, ReadonlySet<string>>([
      [
        "bifrost/gateway",
        new Set(["BIFROST_ENCRYPTION_KEY", "FIREWORKS_API_KEY"]),
      ],
      ["bifrost/oauth2-proxy", new Set(["OAUTH2_PROXY_CLIENT_ID"])],
    ]);

    assert.deepEqual(missingSecretKeys(required, actual), [
      { secretId: "bifrost/gateway", key: "BIFROST_SETUP_TOKEN" },
    ]);
  });

  it("reports nothing when every referenced key is present", () => {
    const actual = new Map<string, ReadonlySet<string>>([
      [
        "bifrost/gateway",
        new Set([
          "BIFROST_ENCRYPTION_KEY",
          "BIFROST_SETUP_TOKEN",
          "FIREWORKS_API_KEY",
        ]),
      ],
      ["bifrost/oauth2-proxy", new Set(["OAUTH2_PROXY_CLIENT_ID"])],
    ]);

    assert.deepEqual(missingSecretKeys(required, actual), []);
  });
});

describe("formatMissingSecretKeys", () => {
  it("names the missing keys and says what ECS would have said", () => {
    const message = formatMissingSecretKeys([
      { secretId: "bifrost/gateway", key: "BIFROST_SETUP_TOKEN" },
    ]);

    assert.match(message, /bifrost\/gateway/);
    assert.match(message, /BIFROST_SETUP_TOKEN/);
    assert.match(message, /did not contain json key BIFROST_SETUP_TOKEN/);
    assert.match(message, /fill-secrets\.sh/);
  });
});
