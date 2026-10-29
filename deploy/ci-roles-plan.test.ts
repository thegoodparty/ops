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

  // No plan on this role reads a secret value (step 4c of
  // docs/deploy-role-trust.md). A root that starts needing one is fixed in the
  // root, not by allowing it here.
  it("allows no secret value read", () => {
    const allows = githubActionsPulumiPlan.Statement.filter(
      (s) =>
        s.Effect === "Allow" &&
        "Action" in s &&
        asList(s.Action).some((a) => a.startsWith("secretsmanager:"))
    );
    assert.deepEqual(allows, []);
  });

  // Blanket, because ReadOnlyAccess is attached alongside and an explicit
  // Deny is the only thing that narrows it.
  it("denies every secret value", () => {
    const deny = statement("DenySecretValues");
    assert.equal(deny.Effect, "Deny");
    assert.deepEqual(asList(deny.Action), ["secretsmanager:GetSecretValue"]);
    assert.equal(deny.Resource, "*");
    assert.equal(deny.NotResource, undefined);
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

  const READABLE = [
    "arn:aws:s3:::goodparty-terraform-state-us-west-2/*/dev/terraform.tfstate",
    "arn:aws:s3:::goodparty-terraform-state-us-west-2/dataplatform/terraform.tfstate",
    "arn:aws:s3:::goodparty-terraform-state-us-west-2/dataplatform/terraform.tfstate.tflock",
    "arn:aws:s3:::goodparty-terraform-state-us-west-2/shared/slack-notifier/terraform.tfstate",
  ];

  it("reads only the listed Terraform states", () => {
    const allow = statement("TerraformStateObjects");
    assert.equal(allow.Effect, "Allow");
    assert.deepEqual(asList(allow.Resource), READABLE);
    for (const one of asList(allow.Resource)) {
      assert.equal(one.includes("/prod/"), false);
    }
  });

  // The allow above scopes nothing on its own, because ReadOnlyAccess grants
  // s3:GetObject on *. This deny is what makes the scope real, and its
  // NotResource must stay identical to the allow or one of the two is a lie.
  // Checked against the live role once: without it, broker/prod/terraform.tfstate
  // simulated as `allowed`.
  it("denies every S3 object outside that list", () => {
    const deny = statement("DenyOtherS3Objects");
    assert.equal(deny.Effect, "Deny");
    assert.equal(deny.Resource, undefined);
    assert.deepEqual(asList(deny.NotResource), READABLE);
  });

  // GetObjectVersion returns content for a versionId and is a separate IAM
  // action that ReadOnlyAccess also grants. The bucket has versioning
  // enabled, so denying only GetObject leaves the same object readable.
  it("denies the versioned read as well as the current one", () => {
    const deny = statement("DenyOtherS3Objects");
    assert.deepEqual(asList(deny.Action), [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]);
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

  // Taking the lock is a Put, but releasing it is a Get and then a Delete:
  // Terraform reads the lockfile back to confirm the ID before removing it.
  // The Put and Delete were allowed and the Get was not, so a plan acquired
  // the lock and stranded it. Asserted separately from the READABLE list
  // above because the two failures look nothing alike: this one leaves the
  // state locked for everyone, not just this role.
  it("can read the lock object back, so it can release it", () => {
    const lock =
      "arn:aws:s3:::goodparty-terraform-state-us-west-2/dataplatform/terraform.tfstate.tflock";
    assert.ok(asList(statement("TerraformStateObjects").Resource).includes(lock));
    assert.ok(asList(statement("DenyOtherS3Objects").NotResource).includes(lock));
  });

  it("logs in to ECR Public and can push nothing there", () => {
    const login = statement("EcrPublicLogin");
    assert.equal(login.Effect, "Allow");
    assert.ok("Action" in login);
    assert.deepEqual(login.Action, [
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ]);
    const ecr = githubActionsPulumiPlan.Statement.flatMap((s) =>
      "Action" in s ? asList(s.Action) : []
    ).filter((a) => a.startsWith("ecr"));
    assert.deepEqual(ecr, ["ecr-public:GetAuthorizationToken"]);
  });
});
