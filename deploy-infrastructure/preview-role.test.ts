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

describe("infrastructurePreviewRolePolicy", () => {
  const actions = infrastructurePreviewRolePolicy.Statement.flatMap((s) =>
    asList(s.Action)
  );

  it("grants exactly the reads the provider makes on a table read", () => {
    assert.deepEqual([...actions].sort(), [
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:ListTagsOfResource",
    ]);
  });

  // The point of the grant is metadata only. A data action slipping in would
  // make a PR-authored preview able to read request records and reasons.
  it("grants no data reads and no writes", () => {
    for (const action of actions) {
      assert.doesNotMatch(
        action,
        /:(Get|Put|Update|Delete|Query|Scan|Batch|Transact)/,
        action
      );
    }
  });

  it("scopes to this account's tables, never a bare wildcard", () => {
    for (const statement of infrastructurePreviewRolePolicy.Statement) {
      const resources = asList(statement.Resource);
      assert.equal(resources.length, 1);
      assert.equal(
        resources[0],
        `arn:aws:dynamodb:us-west-2:${INFRASTRUCTURE_ACCOUNT_ID}:table/*`
      );
      assert.notEqual(resources[0], "*");
    }
  });
});
