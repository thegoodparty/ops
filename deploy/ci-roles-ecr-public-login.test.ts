import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  githubActionsEcrPublicLogin,
  githubActionsEcrPublicLoginTrust,
} from "./components/ci-roles/policies";

const asList = (value: unknown) => (Array.isArray(value) ? value : [value]);

describe("githubActionsEcrPublicLoginTrust", () => {
  it("is assumed only by ops and omni, through the GitHub OIDC provider", () => {
    assert.equal(githubActionsEcrPublicLoginTrust.Statement.length, 1);
    const [statement] = githubActionsEcrPublicLoginTrust.Statement;
    assert.equal(statement.Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(
      statement.Principal.Federated,
      "arn:aws:iam::333022194791:oidc-provider/token.actions.githubusercontent.com",
    );
    assert.equal(
      statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"],
      "sts.amazonaws.com",
    );
    assert.deepEqual(
      statement.Condition.StringLike["token.actions.githubusercontent.com:sub"],
      ["repo:thegoodparty/ops:*", "repo:thegoodparty/omni:*"],
    );
  });
});

describe("githubActionsEcrPublicLogin", () => {
  // PR-authored code assumes this role, so the allowlist is the whole design.
  // Any other action must fail here.
  it("grants exactly the ECR Public login actions", () => {
    const actions = githubActionsEcrPublicLogin.Statement.flatMap((s) =>
      asList(s.Action),
    ).sort();
    assert.deepEqual(actions, [
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ]);
  });

  it("allows only, and uses no NotAction or NotResource", () => {
    for (const statement of githubActionsEcrPublicLogin.Statement) {
      assert.equal(statement.Effect, "Allow");
      assert.equal("NotAction" in statement, false);
      assert.equal(statement.NotResource, undefined);
    }
  });
});
