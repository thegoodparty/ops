import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubActionsJudgeSweepTrust } from "./components/ci-roles/policies";

const SUBJECT_KEY = "token.actions.githubusercontent.com:sub";
const WORKFLOW_KEY = "token.actions.githubusercontent.com:job_workflow_ref";

const asList = (value: unknown) =>
  Array.isArray(value) ? value : [value as string];

describe("githubActionsJudgeSweepTrust", () => {
  const statements = githubActionsJudgeSweepTrust.Statement;

  it("trusts exactly one subject, main in omni, under StringEquals", () => {
    assert.equal(statements.length, 1);
    const condition = statements[0].Condition;
    assert.equal(condition.StringLike, undefined);
    assert.deepEqual(condition.StringEquals?.[SUBJECT_KEY], [
      "repo:thegoodparty/omni:ref:refs/heads/main",
    ]);
  });

  // The pin that does the work. Without it the subject above admits every
  // workflow in omni that runs on main — a hundred-odd jobs — to a role that
  // can start agents and spend money. `sub` is per-ref, not per-workflow.
  it("pins the one workflow file that may assume it", () => {
    assert.equal(
      statements[0].Condition.StringEquals?.[WORKFLOW_KEY],
      "thegoodparty/omni/.github/workflows/judge.yml@refs/heads/main",
    );
  });

  // The two claims have to name the SAME ref or neither pin means anything:
  // judge.yml is reached by relative path, so GitHub resolves it from the
  // caller's ref, and a job on some branch would present that branch in both
  // claims at once. Derived from the documents rather than restated, so a
  // widening edit to either one fails here.
  it("requires the same ref on both claims", () => {
    const subject = asList(
      statements[0].Condition.StringEquals?.[SUBJECT_KEY],
    )[0];
    const workflow = statements[0].Condition.StringEquals?.[WORKFLOW_KEY] as
      string | undefined;
    assert.ok(workflow);
    assert.equal(subject.split(":ref:")[1], workflow.split("@")[1]);
  });

  // A sweep is always ABOUT a pull request and never RUNS on one: both entry
  // points are default-branch events. A `pull_request` subject here would mean
  // the PR's own judge.yml could assume the role, which is the whole thing the
  // pin above prevents.
  it("admits no pull_request subject and no wildcard", () => {
    for (const statement of statements) {
      for (const operator of Object.values(statement.Condition)) {
        for (const [key, value] of Object.entries(operator)) {
          for (const one of asList(value)) {
            assert.equal(one.includes("*"), false, `wildcard ${key}: ${one}`);
            assert.equal(
              one.includes("pull_request"),
              false,
              `pull_request ${key}: ${one}`,
            );
          }
        }
      }
    }
  });

  it("requires the sts audience", () => {
    assert.equal(
      statements[0].Condition.StringEquals?.[
        "token.actions.githubusercontent.com:aud"
      ],
      "sts.amazonaws.com",
    );
  });

  it("federates to this account's GitHub OIDC provider", () => {
    assert.equal(
      statements[0].Principal.Federated,
      "arn:aws:iam::333022194791:oidc-provider/token.actions.githubusercontent.com",
    );
    assert.equal(statements[0].Action, "sts:AssumeRoleWithWebIdentity");
    assert.equal(statements[0].Effect, "Allow");
  });
});
