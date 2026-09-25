import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubActionsPulumiDeploy } from "./components/ci-roles/policies";

const actions = () =>
  githubActionsPulumiDeploy.Statement.flatMap((s) =>
    Array.isArray(s.Action) ? s.Action : [s.Action]
  ).filter((a): a is string => typeof a === "string");

describe("githubActionsPulumiDeploy", () => {
  // The run that attaches AdministratorAccess authenticates with this
  // document, so the attachment can only ever land while this action is here.
  it("grants the attach action the AdministratorAccess attachment needs", () => {
    assert.equal(actions().includes("iam:AttachRolePolicy"), true);
  });

  // This absence is the whole reason the superseded policy is still attached:
  // the removal calls DeletePolicy with these credentials, and a 403 there
  // fails the entire update. When this assertion starts failing, the role can
  // delete its own policy and the removal is unblocked — drop the policy, the
  // attachment and this file together.
  it("holds no iam:DeletePolicy, which is what defers its own removal", () => {
    assert.equal(actions().includes("iam:DeletePolicy"), false);
  });
});
