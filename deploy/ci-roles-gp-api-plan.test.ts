import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  githubActionsGpApiPlan,
  githubActionsGpApiPlanTrust,
} from "./components/ci-roles/policies";

const SUBJECT_KEY = "token.actions.githubusercontent.com:sub";

const statement = (sid: string) => {
  const found = githubActionsGpApiPlan.Statement.find((s) => s.Sid === sid);
  assert.ok(found, `no statement with Sid ${sid}`);
  return found;
};

const asList = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as string];

const allows = () =>
  githubActionsGpApiPlan.Statement.filter((s) => s.Effect === "Allow");

const READABLE = [
  "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/gp-api/gp-api-dev.json",
  "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/gp-api/gp-api-prod.json",
  "arn:aws:s3:::goodparty-iac-state/.pulumi/meta.yaml",
];

const PARAMETERS = [
  "arn:aws:ssm:us-west-2:333022194791:parameter/pulumi-state-config-passphrase",
  "arn:aws:ssm:us-west-2:333022194791:parameter/grafana-shared-service-account-token",
  "arn:aws:ssm:us-west-2:333022194791:parameter/grafana-sm-access-token",
];

describe("githubActionsGpApiPlanTrust", () => {
  it("is assumed by omni pull_request runs alone, under StringEquals", () => {
    assert.equal(githubActionsGpApiPlanTrust.Statement.length, 1);
    const [s] = githubActionsGpApiPlanTrust.Statement;
    assert.equal(s.Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(s.Condition.StringLike, undefined);
    assert.deepEqual(s.Condition.StringEquals, {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      [SUBJECT_KEY]: "repo:thegoodparty/omni:pull_request",
    });
  });
});

describe("githubActionsGpApiPlan", () => {
  // A preview takes no lock and writes nothing. The whole allow list is
  // reads, so a write that creeps in has to change this test on purpose.
  it("allows reads only", () => {
    const actions = allows().flatMap((s) =>
      "Action" in s ? asList(s.Action) : []
    );
    assert.deepEqual([...new Set(actions)].sort(), [
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "ssm:GetParameter",
    ]);
  });

  // ReadOnlyAccess grants s3:GetObject on *, so the deny is what limits the
  // role, and its NotResource must stay identical to the allow.
  it("reads only gp-api's current dev and prod state", () => {
    assert.deepEqual(asList(statement("PulumiStateObjects").Resource), READABLE);
    const deny = statement("DenyOtherS3Objects");
    assert.equal(deny.Effect, "Deny");
    assert.equal(deny.Resource, undefined);
    assert.deepEqual(asList(deny.Action), ["s3:GetObject"]);
    assert.deepEqual(asList(deny.NotResource), READABLE);
  });

  // Each stack's `.json.bak`, the preview stacks, `backups/` and `history/`
  // are all older or other copies of state under the same passphrase.
  it("names state objects exactly, with no wildcard", () => {
    for (const r of READABLE) {
      assert.equal(r.includes("*"), false, r);
    }
  });

  // The bucket is versioned, and versions from before step 4b hold the Aurora
  // master passwords. Denied everywhere, gp-api's own state included.
  it("denies every object version", () => {
    const deny = statement("DenyObjectVersions");
    assert.equal(deny.Effect, "Deny");
    assert.deepEqual(asList(deny.Action), ["s3:GetObjectVersion"]);
    assert.equal(deny.Resource, "*");
    assert.equal(deny.NotResource, undefined);
  });

  it("allows no secret value read and denies every one", () => {
    const secretAllows = allows().filter((s) =>
      asList("Action" in s ? s.Action : undefined).some((a) =>
        a.startsWith("secretsmanager:")
      )
    );
    assert.deepEqual(secretAllows, []);
    const deny = statement("DenySecretValues");
    assert.equal(deny.Effect, "Deny");
    assert.deepEqual(asList(deny.Action), ["secretsmanager:GetSecretValue"]);
    assert.equal(deny.Resource, "*");
  });

  it("reads three SSM parameters and denies every other", () => {
    const allowed = allows()
      .filter((s) => asList("Action" in s ? s.Action : undefined).includes("ssm:GetParameter"))
      .flatMap((s) => asList(s.Resource));
    assert.deepEqual(allowed.sort(), [...PARAMETERS].sort());
    const deny = statement("DenyOtherParameters");
    assert.equal(deny.Effect, "Deny");
    assert.deepEqual(asList(deny.Action), [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]);
    assert.deepEqual(asList(deny.NotResource).sort(), [...PARAMETERS].sort());
  });

  // History returns earlier values in plaintext, so the three above would
  // otherwise be readable at every past version.
  it("denies parameter history, the three it reads included", () => {
    const deny = statement("DenyParameterHistory");
    assert.equal(deny.Effect, "Deny");
    assert.deepEqual(asList(deny.Action), ["ssm:GetParameterHistory"]);
    assert.equal(deny.Resource, "*");
  });
});
