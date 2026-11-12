import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  githubActionsVercelConfigDeploy,
  githubActionsVercelConfigDeployTrust,
} from "./components/ci-roles/policies";

const asList = (value: unknown) =>
  Array.isArray(value) ? value : [value as string];

describe("githubActionsVercelConfigDeployTrust", () => {
  // The production environment subject alone would admit every omni workflow
  // that runs in that environment. The workflow pin holds it to the one apply.
  it("is assumed only by omni's vercel-config.yml on main, in production", () => {
    assert.equal(githubActionsVercelConfigDeployTrust.Statement.length, 1);
    const [statement] = githubActionsVercelConfigDeployTrust.Statement;
    assert.equal(statement.Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(statement.Condition.StringLike, undefined);
    assert.deepEqual(statement.Condition.StringEquals, {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub":
        "repo:thegoodparty/omni:environment:production",
      "token.actions.githubusercontent.com:job_workflow_ref":
        "thegoodparty/omni/.github/workflows/vercel-config.yml@refs/heads/main",
    });
  });
});

describe("githubActionsVercelConfigDeploy", () => {
  // Every project shares one passphrase, so the object ARNs are the only
  // thing keeping this role out of the other stacks' state.
  it("scopes state objects to the vercel-config project, not the bucket", () => {
    const objects = githubActionsVercelConfigDeploy.Statement.flatMap((s) =>
      asList(s.Resource)
    ).filter((r) => r.startsWith("arn:aws:s3:::goodparty-iac-state/"));
    assert.deepEqual(objects, [
      "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/vercel-config/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/locks/organization/vercel-config/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/backups/vercel-config/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/history/vercel-config/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/meta.yaml",
    ]);
  });

  it("grants nothing beyond the Pulumi backend and its passphrase", () => {
    const allowed =
      /^(s3:(ListBucket|GetBucketLocation|GetObject|PutObject|DeleteObject)$|ssm:GetParameter$)/;
    for (const s of githubActionsVercelConfigDeploy.Statement) {
      assert.equal(s.Effect, "Allow");
      for (const action of asList(s.Action)) {
        assert.match(action, allowed, `${action} is outside the role's scope`);
      }
      if (asList(s.Action).includes("ssm:GetParameter")) {
        assert.deepEqual(asList(s.Resource), [
          "arn:aws:ssm:us-west-2:333022194791:parameter/pulumi-state-config-passphrase",
        ]);
      }
    }
  });
});
