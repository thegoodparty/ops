import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  infrastructurePreviewRolePolicy,
  infrastructurePreviewRoleTrust,
} from "./preview-role";
import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";

const MANAGEMENT_ACCOUNT_ID = "333022194791";

const asList = (value: unknown): string[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? (value as string[])
      : [String(value)];

describe("infrastructurePreviewRoleTrust", () => {
  it("admits the PR preview role and the human ReadOnlyAccess session only", () => {
    assert.equal(infrastructurePreviewRoleTrust.Statement.length, 2);

    const [ci, human] = infrastructurePreviewRoleTrust.Statement;
    assert.equal(ci.Effect, "Allow");
    assert.equal(ci.Action, "sts:AssumeRole");
    assert.equal(
      ci.Principal.AWS,
      `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/github-actions-pulumi-preview`
    );
    assert.equal(ci.Condition, undefined);

    assert.equal(human.Effect, "Allow");
    assert.equal(human.Action, "sts:AssumeRole");
    // The principal is the account root, not a literal role ARN: the SSO role
    // name carries a random suffix. The condition is what pins it to the
    // ReadOnlyAccess permission set.
    assert.equal(
      human.Principal.AWS,
      `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:root`
    );
    assert.equal(
      human.Condition?.ArnLike["aws:PrincipalArn"],
      `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_ReadOnlyAccess_*`
    );
  });
});

// Minimal IAM ARN wildcard matcher: `*` and `?` are the only wildcards IAM
// honours. Used to prove the chosen scope matches the suffix-less partial ARN
// the failing preview named.
const iamArnMatches = (pattern: string, arn: string): boolean =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`
  ).test(arn);

describe("infrastructurePreviewRolePolicy", () => {
  const statements = infrastructurePreviewRolePolicy.Statement;
  const actions = statements.flatMap((s) => asList(s.Action));
  const actionsFor = (sid: string) =>
    statements.filter((s) => s.Sid === sid).flatMap((s) => asList(s.Action));

  it("grants exactly the reads the provider makes on a table read", () => {
    assert.deepEqual([...actionsFor("DynamoDbTableRead")].sort(), [
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:ListTagsOfResource",
    ]);
  });

  // `resourceSecretRead` calls DescribeSecret; `resourceSecretFlatten` then
  // reads the resource policy and the tags. These three, and nothing else.
  it("grants exactly the reads the provider makes on a secret read", () => {
    assert.deepEqual([...actionsFor("SecretsManagerSecretRead")].sort(), [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:ListTagsForResource",
    ]);
  });

  // The point of the grant is metadata only. A data action slipping in would
  // make a PR-authored preview able to read request records and reasons, or
  // the contents of a secret.
  it("grants no data reads and no writes", () => {
    for (const action of actions) {
      // `GetResourcePolicy` is a metadata read on the secret read path, not a
      // value read; every other `Get`/`Put`/... action is out of bounds.
      if (action === "secretsmanager:GetResourcePolicy") {
        continue;
      }
      assert.doesNotMatch(
        action,
        /:(Get|Put|Update|Delete|Query|Scan|Batch|Transact)/,
        action
      );
    }
  });

  // Mirror of the data-read assertion above, named for the action that would
  // matter most here: the secret value is what the preview must never see.
  it("does not grant secretsmanager:GetSecretValue or any value action", () => {
    for (const action of actionsFor("SecretsManagerSecretRead")) {
      assert.doesNotMatch(
        action,
        /^secretsmanager:(GetSecretValue|BatchGetSecretValue|ListSecretVersionIds|GetRandomPassword)$/,
        action
      );
    }
    assert.ok(!actions.includes("secretsmanager:GetSecretValue"));
    assert.ok(!actions.includes("secretsmanager:BatchGetSecretValue"));
  });

  it("scopes every statement to this account and region, never a bare wildcard", () => {
    const scopes = statements.flatMap((s) => asList(s.Resource));
    assert.deepEqual([...scopes].sort(), [
      `arn:aws:dynamodb:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:table/*`,
      `arn:aws:secretsmanager:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:secret:*`,
    ]);
    for (const scope of scopes) {
      assert.notEqual(scope, "*");
      assert.match(scope, /^arn:aws:[a-z0-9-]+:us-west-2:\d+:/);
    }
  });

  it("scopes the secret grant so the import's partial ARN matches", () => {
    const statement = statements.find(
      (s) => s.Sid === "SecretsManagerSecretRead"
    );
    assert.ok(statement);
    const scope = statement.Resource;
    assert.equal(
      scope,
      `arn:aws:secretsmanager:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:secret:*`
    );
    // The import names the suffix-less partial ARN, because the six random
    // characters Secrets Manager appends do not exist until the secret does.
    assert.equal(
      iamArnMatches(
        scope,
        "arn:aws:secretsmanager:us-west-2:394495727159:secret:sheriff"
      ),
      true
    );
    // The obvious tighter scope would not match that ARN, which is why the
    // grant is `secret:*` rather than `secret:sheriff-*`.
    assert.equal(
      iamArnMatches(
        "arn:aws:secretsmanager:us-west-2:394495727159:secret:sheriff-*",
        "arn:aws:secretsmanager:us-west-2:394495727159:secret:sheriff"
      ),
      false
    );
  });
});
