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

const wildcardSubjects = () =>
  subjectConditions()
    .filter((c) => c.operator === "StringLike")
    .flatMap((c) => c.value as string[]);

describe("githubActionsPulumiDeployTrust", () => {
  // `sub` under both StringEquals and StringLike in one statement is not "or":
  // IAM ANDs them, so nothing would match. The pin must be its own statement.
  it("pins the ops subject to main under StringEquals, in its own statement", () => {
    const exact = subjectConditions().filter(
      (c) => c.operator === "StringEquals"
    );
    assert.deepEqual(exact, [
      {
        operator: "StringEquals",
        value: "repo:thegoodparty/ops:ref:refs/heads/main",
      },
    ]);
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

  it("keeps no wildcard ops subject", () => {
    assert.equal(
      wildcardSubjects().some((s) =>
        s.startsWith("repo:thegoodparty/ops:")
      ),
      false
    );
  });

  // Left wildcarded on purpose: these repos assume the role on pull_request.
  it("leaves the other eight repositories wildcarded", () => {
    const wildcards = wildcardSubjects();
    for (const repo of [
      "gp-api",
      "people-api",
      "election-api",
      "gp-terraform-dataplatform",
      "campaign-plan-service",
      "gpvpn",
      "runbooks",
      "omni",
    ]) {
      assert.ok(
        wildcards.includes(`repo:thegoodparty/${repo}:*`),
        `expected a wildcard subject for ${repo}`
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
