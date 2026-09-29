import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { workbenchPreviewRoleTrust } from "./preview-role";

const MANAGEMENT_ACCOUNT_ID = "333022194791";

describe("workbenchPreviewRoleTrust", () => {
  it("admits the PR preview role and the human ReadOnlyAccess session only", () => {
    assert.equal(workbenchPreviewRoleTrust.Statement.length, 2);

    const [ci, human] = workbenchPreviewRoleTrust.Statement;
    assert.equal(ci.Effect, "Allow");
    assert.equal(ci.Action, "sts:AssumeRole");
    assert.equal(
      ci.Principal.AWS,
      `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/github-actions-pulumi-preview`
    );

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
