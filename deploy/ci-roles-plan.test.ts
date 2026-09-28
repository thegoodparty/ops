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

  const AI_SECRETS_DEV =
    "arn:aws:secretsmanager:us-west-2:333022194791:secret:AI_SECRETS_DEV-??????";

  // The single documented exception, and the whole residual risk of the role.
  // Pinned to DEV: gp-ai plans only its dev roots on a pull request, and the
  // prod blob must stay unreachable.
  it("allows exactly one secret value, the dev AI secrets", () => {
    const allow = statement("AiSecretsDevForPlan");
    assert.equal(allow.Effect, "Allow");
    assert.equal(allow.Resource, AI_SECRETS_DEV);
    assert.ok(!String(allow.Resource).includes("PROD"));
  });

  // NotResource, not Resource: an explicit Deny beats the Allow above, so a
  // blanket deny here would refuse the plan the role exists to run.
  it("denies every other secret value", () => {
    const deny = statement("DenySecretValues");
    assert.equal(deny.Effect, "Deny");
    assert.ok(asList(deny.Action).includes("secretsmanager:GetSecretValue"));
    assert.equal(deny.Resource, undefined);
    assert.equal(deny.NotResource, AI_SECRETS_DEV);
  });

  // Blanket, and including GetParameterHistory: it returns prior versions
  // with current SecureString values in plaintext, so denying only the three
  // obvious reads leaves the Pulumi passphrase reachable.
  it("denies every SSM parameter read, history included", () => {
    const deny = statement("DenySensitiveParameters");
    assert.equal(deny.Effect, "Deny");
    assert.equal(deny.Resource, "*");
    for (const action of [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:GetParameterHistory",
    ]) {
      assert.ok(asList(deny.Action).includes(action), `missing ${action}`);
    }
  });

  it("lists only the Terraform state bucket, not all buckets", () => {
    const allow = statement("TerraformStateBucket");
    assert.equal(allow.Effect, "Allow");
    assert.equal(
      allow.Resource,
      "arn:aws:s3:::goodparty-terraform-state-us-west-2"
    );
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
