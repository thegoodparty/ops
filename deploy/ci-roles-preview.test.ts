import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  githubActionsPulumiPreview,
  githubActionsPulumiPreviewTrust,
} from "./components/ci-roles/policies";

const actions = () =>
  githubActionsPulumiPreview.Statement.flatMap((s) =>
    Array.isArray(s.Action) ? s.Action : [s.Action]
  ).filter((a): a is string => typeof a === "string");

const resources = () =>
  githubActionsPulumiPreview.Statement.flatMap((s) =>
    Array.isArray(s.Resource) ? s.Resource : [s.Resource]
  ).filter((r): r is string => typeof r === "string");

describe("githubActionsPulumiPreviewTrust", () => {
  it("is assumed only by pull_request runs in this repo", () => {
    assert.equal(githubActionsPulumiPreviewTrust.Statement.length, 1);
    const [statement] = githubActionsPulumiPreviewTrust.Statement;
    assert.equal(statement.Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(
      statement.Condition.StringEquals[
        "token.actions.githubusercontent.com:aud"
      ],
      "sts.amazonaws.com"
    );
    assert.equal(
      statement.Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
      ],
      "repo:thegoodparty/ops:pull_request"
    );
  });
});

describe("githubActionsPulumiPreview", () => {
  // The role is PR-assumable, so this is the invariant the whole design rests
  // on. Reasserted as an allowlist rather than a denylist so a new write action
  // cannot slip in without failing here.
  it("grants read-only actions and nothing else", () => {
    const readOnly =
      /^(s3:(Get|List)|ssm:Get|secretsmanager:Describe|ecs:Describe)/;
    for (const action of actions()) {
      assert.match(action, readOnly, `${action} is not read-only`);
    }
  });

  it("never grants GetSecretValue", () => {
    assert.equal(actions().includes("secretsmanager:GetSecretValue"), false);
  });

  it("scopes state objects to ops, org and workbench, and nothing else", () => {
    const stacks = resources()
      .filter((r) => r.includes("/.pulumi/stacks/"))
      .sort();
    assert.deepEqual(stacks, [
      "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/ops/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/org/*",
      "arn:aws:s3:::goodparty-iac-state/.pulumi/stacks/workbench/*",
    ]);
  });

  it("touches no lock, backup or history objects", () => {
    assert.equal(
      resources().some((r) => /locks|backups|history/.test(r)),
      false
    );
  });

  it("scopes secret metadata to the DELEGATES secret, not *", () => {
    const describe = githubActionsPulumiPreview.Statement.find((s) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes(
        "secretsmanager:DescribeSecret"
      )
    );
    assert.ok(describe);
    assert.equal(
      describe.Resource,
      "arn:aws:secretsmanager:us-west-2:333022194791:secret:DELEGATES-??????"
    );
  });
});
