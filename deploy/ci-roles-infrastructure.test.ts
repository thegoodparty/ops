import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  githubActionsInfrastructureDeploy,
  githubActionsInfrastructureDeployTrust,
} from "./components/ci-roles/policies";

const SUBJECT_KEY = "token.actions.githubusercontent.com:sub";
const WORKFLOW_REF_KEY =
  "token.actions.githubusercontent.com:job_workflow_ref";

const statement = (sid: string) => {
  const found = githubActionsInfrastructureDeploy.Statement.find(
    (s) => s.Sid === sid
  );
  assert.ok(found, `no statement with Sid ${sid}`);
  return found;
};

const resources = () =>
  githubActionsInfrastructureDeploy.Statement.flatMap((s) =>
    Array.isArray(s.Resource) ? s.Resource : [s.Resource]
  ).filter((r): r is string => typeof r === "string");

describe("githubActionsInfrastructureDeployTrust", () => {
  // Pinned to one workflow file on main, the same shape as the org and
  // workbench trusts. Any other workflow, or any ref but main, cannot assume
  // the role even if it lands in the repo.
  it("is assumed only by deploy-infrastructure.yml on main", () => {
    assert.equal(githubActionsInfrastructureDeployTrust.Statement.length, 1);
    const condition =
      githubActionsInfrastructureDeployTrust.Statement[0].Condition.StringEquals;
    assert.equal(condition?.["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com");
    assert.equal(condition?.[SUBJECT_KEY], "repo:thegoodparty/ops:ref:refs/heads/main");
    assert.equal(
      condition?.[WORKFLOW_REF_KEY],
      "thegoodparty/ops/.github/workflows/deploy-infrastructure.yml@refs/heads/main"
    );
  });
});

describe("githubActionsInfrastructureDeploy", () => {
  // Step 7's first apply assumes the Organizations-planted bootstrap role.
  // Step 7's second PR replaces this with the in-account `pulumi-deploy`; until
  // then this exact ARN is the only role the CI role may reach.
  it("assumes the bootstrap role, and only that role", () => {
    const assume = statement("AssumeInfrastructureDeployRole");
    assert.equal(assume.Effect, "Allow");
    assert.deepEqual(assume.Action, ["sts:AssumeRole"]);
    assert.equal(
      assume.Resource,
      "arn:aws:iam::394495727159:role/OrganizationAccountAccessRole"
    );
  });

  // The project scoping is the security content: the backend is shared by
  // seven projects, so a bucket-wide grant would let this role decrypt and
  // rewrite any of them.
  it("scopes Pulumi state objects to infrastructure, and nothing else", () => {
    const stacks = resources()
      .filter((r) => r.includes("/.pulumi/stacks/"))
      .sort();
    assert.deepEqual(stacks, [
      "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/infrastructure/*",
    ]);
  });

  it("reaches no other account's roles", () => {
    const others = resources().filter((r) => r.includes(":role/"));
    assert.deepEqual(others, [
      "arn:aws:iam::394495727159:role/OrganizationAccountAccessRole",
    ]);
  });
});
