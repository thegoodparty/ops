import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubActionsPulumiDeployTrust } from "./components/ci-roles/policies";

const SUBJECT_KEY = "token.actions.githubusercontent.com:sub";

/** Every `sub` condition in the trust policy, with the operator that carries it. */
const subjectConditions = () => {
  const found: { operator: string; value: string | string[] }[] = [];

  for (const statement of githubActionsPulumiDeployTrust.Statement) {
    for (const [operator, condition] of Object.entries(statement.Condition)) {
      const value = condition[SUBJECT_KEY];
      if (value !== undefined) found.push({ operator, value });
    }
  }

  return found;
};

const allSubjects = () =>
  subjectConditions().flatMap((c) =>
    Array.isArray(c.value) ? c.value : [c.value]
  );

describe("githubActionsPulumiDeployTrust", () => {
  // Exact equality, not inclusion: this role carries AdministratorAccess, so
  // a subject added to its trust should fail the test rather than pass
  // silently.
  it("trusts exactly these subjects, all under StringEquals", () => {
    assert.deepEqual(subjectConditions(), [
      {
        operator: "StringEquals",
        value: "repo:thegoodparty/ops:ref:refs/heads/main",
      },
      {
        operator: "StringEquals",
        value: [
          "repo:thegoodparty/omni:ref:refs/heads/main",
          "repo:thegoodparty/gp-terraform-dataplatform:ref:refs/heads/main",
          "repo:thegoodparty/gp-terraform-dataplatform:environment:production",
          "repo:thegoodparty/gpvpn:ref:refs/heads/main",
        ],
      },
    ]);
  });

  // Step 8 of docs/deploy-role-trust.md. A wildcard or a pull_request subject
  // would let a branch's workflow, which nobody has reviewed, assume admin.
  it("trusts no wildcard and no pull request", () => {
    for (const statement of githubActionsPulumiDeployTrust.Statement) {
      assert.equal(statement.Condition.StringLike, undefined);
    }
    for (const subject of allSubjects()) {
      assert.equal(subject.includes("*"), false, subject);
      assert.equal(subject.endsWith(":pull_request"), false, subject);
    }
  });

  // An environment subject is only as narrow as the environment's branch
  // policy, which lives in GitHub, not here. Keep it to the one apply that
  // needs it.
  it("trusts one environment subject, dataplatform's production", () => {
    assert.deepEqual(
      allSubjects().filter((s) => s.includes(":environment:")),
      ["repo:thegoodparty/gp-terraform-dataplatform:environment:production"]
    );
  });

  // `sub` is per-ref, not per-workflow: every workflow on main shares it. The
  // workflow pin is what stops an added, unreviewed workflow from assuming it.
  it("pins the ops workflow file as well as the ref", () => {
    const ops = githubActionsPulumiDeployTrust.Statement.find(
      (s) =>
        s.Condition.StringEquals?.[SUBJECT_KEY] ===
        "repo:thegoodparty/ops:ref:refs/heads/main"
    );
    assert.equal(
      ops?.Condition.StringEquals?.[
        "token.actions.githubusercontent.com:job_workflow_ref"
      ],
      "thegoodparty/ops/.github/workflows/deploy.yml@refs/heads/main"
    );
  });

  // The five removed in step 2 are archived, so they cannot run a workflow at
  // all. Named individually so re-adding one is a deliberate act.
  it("drops the archived repositories entirely", () => {
    const archived = [
      "gp-api",
      "people-api",
      "election-api",
      "runbooks",
      "campaign-plan-service",
    ];
    for (const repo of archived) {
      assert.equal(
        allSubjects().some((s) => s.startsWith(`repo:thegoodparty/${repo}:`)),
        false,
        `${repo} is archived and must not be trusted`
      );
    }
  });

  it("requires the sts audience on every statement", () => {
    for (const statement of githubActionsPulumiDeployTrust.Statement) {
      assert.equal(
        statement.Condition.StringEquals?.[
          "token.actions.githubusercontent.com:aud"
        ],
        "sts.amazonaws.com"
      );
    }
  });
});
