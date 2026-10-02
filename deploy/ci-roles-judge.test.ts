import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubActionsJudgeSweepTrust } from "./components/ci-roles/policies";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// THE SESSION HAS TO OUTLAST THE POLL, which is what makes this role
// different from every other one in this file. The others run Pulumi or
// Terraform and finish in minutes; this one dispatches a Fargate run and then
// waits for it, against agents declaring timeouts up to an hour each.
//
// Asserted against the source text rather than a Pulumi output because the
// resource is only constructed inside `createCiRoles()`, which needs a Pulumi
// runtime. The number is what matters and the number is right here.
describe("the judge role's session length", () => {
  const source = readFileSync(
    join(__dirname, "components", "ci-roles.ts"),
    "utf8"
  );

  const judgeBlock = () => {
    const start = source.indexOf('new aws.iam.Role("githubActionsJudgeSweep"');
    assert.ok(start > -1, "the judge role is gone");
    return source.slice(start, source.indexOf("});", start));
  };

  // At the one hour every other role here takes, credentials expire mid-poll:
  // the dispatch has happened, the Fargate task keeps billing, and the poll
  // fails with an auth error recorded as an infraError — paid for and
  // excluded from the comparison.
  it("outlasts the sweep job's own three-hour timeout", () => {
    const declared = /maxSessionDuration:\s*(\d+)/.exec(judgeBlock())?.[1];
    assert.ok(declared, "no maxSessionDuration on the judge role");
    assert.ok(
      Number(declared) > 180 * 60,
      `maxSessionDuration ${declared}s does not cover a 180-minute job`
    );
  });

  // Not open-ended either. The credentials cannot outlive the job holding
  // them, so anything past the job's budget plus slack is reach nobody needs.
  it("is not longer than it needs to be", () => {
    const declared = Number(
      /maxSessionDuration:\s*(\d+)/.exec(judgeBlock())?.[1]
    );
    assert.ok(declared <= 4 * 3600, `maxSessionDuration ${declared}s is loose`);
  });
});
