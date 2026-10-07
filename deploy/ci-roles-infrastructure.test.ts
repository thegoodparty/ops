import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  githubActionsInfrastructureDeploy,
  githubActionsInfrastructureDeployTrust,
} from "./components/ci-roles/policies";

const asList = (value: unknown) =>
  Array.isArray(value) ? value : [value as string];

const resources = () =>
  githubActionsInfrastructureDeploy.Statement.flatMap((s) =>
    asList(s.Resource)
  ).filter((r): r is string => typeof r === "string");

describe("githubActionsInfrastructureDeployTrust", () => {
  // Step 7 must create the workflow under exactly this name. A different name
  // fails the assume with a message that does not obviously point here.
  it("is assumed only by deploy-infrastructure.yml on main in this repo", () => {
    assert.equal(githubActionsInfrastructureDeployTrust.Statement.length, 1);
    const [statement] = githubActionsInfrastructureDeployTrust.Statement;
    assert.equal(statement.Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(statement.Condition.StringLike, undefined);
    assert.deepEqual(statement.Condition.StringEquals, {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub":
        "repo:thegoodparty/ops:ref:refs/heads/main",
      "token.actions.githubusercontent.com:job_workflow_ref":
        "thegoodparty/ops/.github/workflows/deploy-infrastructure.yml@refs/heads/main",
    });
  });
});

describe("githubActionsInfrastructureDeploy", () => {
  // Two assume statements during step 7's gain-then-remove window: the
  // `pulumi-deploy` grant the cutover needs applied first, and the bootstrap
  // grant the provider still uses until that cutover. The cutover PR drops the
  // bootstrap ARN; this assertion is where that shows up.
  it("assumes pulumi-deploy, with the bootstrap grant still present until the cutover", () => {
    const assumes = githubActionsInfrastructureDeploy.Statement.filter((s) =>
      asList(s.Action).includes("sts:AssumeRole")
    );
    const arns = assumes.flatMap((s) => asList(s.Resource)).sort();
    assert.deepEqual(arns, [
      "arn:aws:iam::394495727159:role/OrganizationAccountAccessRole",
      "arn:aws:iam::394495727159:role/pulumi-deploy",
    ]);
  });

  // The grant the cutover depends on. Asserted on its own so a later edit that
  // removes it while touching the bootstrap grant fails loudly here rather
  // than at the cutover's first assume.
  it("grants the in-account deploy role the cutover will assume", () => {
    assert.equal(
      resources().includes("arn:aws:iam::394495727159:role/pulumi-deploy"),
      true
    );
  });

  // Every project shares one passphrase, so the object ARNs are the only
  // thing keeping this role out of the other stacks' state.
  it("scopes state objects to the infrastructure project, not the bucket", () => {
    const objects = resources().filter((r) =>
      r.startsWith("arn:aws:s3:::goodparty-iac-state/")
    );
    assert.deepEqual(objects, [
      "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/infrastructure/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/locks/organization/infrastructure/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/backups/infrastructure/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/history/infrastructure/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/meta.yaml",
    ]);
  });

  it("grants nothing beyond the assume and the Pulumi backend", () => {
    const allowed =
      /^(sts:AssumeRole$|s3:(ListBucket|GetBucketLocation|GetObject|PutObject|DeleteObject)$|ssm:GetParameter$)/;
    for (const s of githubActionsInfrastructureDeploy.Statement) {
      assert.equal(s.Effect, "Allow");
      for (const action of asList(s.Action)) {
        assert.match(action, allowed, `${action} is outside the role's scope`);
      }
    }
  });
});
