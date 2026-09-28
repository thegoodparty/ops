import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  githubActionsPulumiPlan,
  githubActionsPulumiPlanTrust,
} from "./components/ci-roles/policies";

const SUBJECT_KEY = "token.actions.githubusercontent.com:sub";

const statement = (sid: string) => {
  const found = githubActionsPulumiPlan.Statement.find((s) => s.Sid === sid);
  assert.ok(found, `no statement with Sid ${sid}`);
  return found;
};

const asList = (value: unknown) =>
  Array.isArray(value) ? value : [value as string];

describe("githubActionsPulumiPlanTrust", () => {
  it("trusts exactly the two pull_request subjects, under StringEquals", () => {
    assert.equal(githubActionsPulumiPlanTrust.Statement.length, 1);
    const condition = githubActionsPulumiPlanTrust.Statement[0].Condition;
    assert.equal(condition.StringLike, undefined);
    assert.deepEqual(condition.StringEquals?.[SUBJECT_KEY], [
      "repo:thegoodparty/omni:pull_request",
      "repo:thegoodparty/gp-terraform-dataplatform:pull_request",
    ]);
  });

  // A wildcard here would admit main runs, which have their own role, and
  // every other ref besides.
  it("uses no wildcard subject", () => {
    for (const s of githubActionsPulumiPlanTrust.Statement) {
      for (const value of Object.values(s.Condition)) {
        const subject = value[SUBJECT_KEY];
        if (subject === undefined) continue;
        for (const one of asList(subject)) {
          assert.equal(one.includes("*"), false, `wildcard subject: ${one}`);
        }
      }
    }
  });

  it("requires the sts audience", () => {
    assert.equal(
      githubActionsPulumiPlanTrust.Statement[0].Condition.StringEquals?.[
        "token.actions.githubusercontent.com:aud"
      ],
      "sts.amazonaws.com"
    );
  });
});

describe("githubActionsPulumiPlan", () => {
  // The whole reason ReadOnlyAccess is safe to attach to this role. If any of
  // these denies is dropped, the managed policy's s3:Get*/ssm:Get* reach the
  // Pulumi state bucket and the passphrase that decrypts every project in it.
  it("denies the Pulumi state bucket", () => {
    const deny = statement("DenyPulumiState");
    assert.equal(deny.Effect, "Deny");
    assert.deepEqual(asList(deny.Resource), [
      "arn:aws:s3:::goodparty-iac-state",
      "arn:aws:s3:::goodparty-iac-state/*",
    ]);
  });

  it("denies secret values", () => {
    const deny = statement("DenySecretValues");
    assert.equal(deny.Effect, "Deny");
    assert.ok(asList(deny.Action).includes("secretsmanager:GetSecretValue"));
    assert.equal(deny.Resource, "*");
  });

  it("denies the passphrase and the Grafana tokens", () => {
    const deny = statement("DenySensitiveParameters");
    assert.equal(deny.Effect, "Deny");
    assert.deepEqual(asList(deny.Resource), [
      "arn:aws:ssm:us-west-2:333022194791:parameter/pulumi-state-config-passphrase",
      "arn:aws:ssm:us-west-2:333022194791:parameter/grafana-shared-service-account-token",
      "arn:aws:ssm:us-west-2:333022194791:parameter/grafana-sm-access-token",
    ]);
  });

  // gp-ai plans only its dev roots on a pull request. Reaching a prod state
  // would be a widening, so the absence of `*/prod/*` is asserted, not assumed.
  it("reads only dev Terraform state, plus dataplatform's single state", () => {
    const allow = statement("TerraformStateObjects");
    assert.equal(allow.Effect, "Allow");
    assert.deepEqual(asList(allow.Resource), [
      "arn:aws:s3:::goodparty-terraform-state-us-west-2/*/dev/terraform.tfstate",
      "arn:aws:s3:::goodparty-terraform-state-us-west-2/dataplatform/terraform.tfstate",
    ]);
    for (const one of asList(allow.Resource)) {
      assert.equal(one.includes("/prod/"), false);
    }
  });

  // dataplatform plans with the lock held; gp-ai passes -lock=false. The only
  // write this role has is that one lock object.
  it("writes nothing but the dataplatform lock object", () => {
    const writes = githubActionsPulumiPlan.Statement.filter(
      (s) =>
        s.Effect === "Allow" &&
        asList(s.Action).some((a) => /^s3:(Put|Delete)/.test(a))
    );
    assert.equal(writes.length, 1);
    assert.equal(
      writes[0].Resource,
      "arn:aws:s3:::goodparty-terraform-state-us-west-2/dataplatform/terraform.tfstate.tflock"
    );
  });
});
