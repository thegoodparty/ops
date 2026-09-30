import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ECR_PULL_ACTIONS,
  ECS_AGENT_HEADROOM_MIB,
  INSTANCE_EGRESS,
  INSTANCE_MEMORY_MIB,
  INSTANCE_VCPU,
  OPS_MAIN_SUBJECT,
  RESULTS_BUCKET,
  RUNNER_CPU,
  RUNNER_MEMORY_RESERVATION_MIB,
  WORKFLOW_FILE,
  instancePolicy,
  workflowPolicy,
  workflowTrust,
} from "./components/bugboss-evals";

describe("the eval runner's sizing", () => {
  it("fits on the instance with room for the ECS agent", () => {
    assert.ok(
      RUNNER_MEMORY_RESERVATION_MIB <= INSTANCE_MEMORY_MIB - ECS_AGENT_HEADROOM_MIB,
      `${RUNNER_MEMORY_RESERVATION_MIB} MiB does not fit ${INSTANCE_MEMORY_MIB} less headroom`,
    );
    assert.ok(RUNNER_CPU <= INSTANCE_VCPU * 1024);
  });

  // Two per host is what lets both sides of a pair land together; the sizing
  // comment in the component depends on it.
  it("places two runs per host", () => {
    assert.ok(
      2 * RUNNER_MEMORY_RESERVATION_MIB <= INSTANCE_MEMORY_MIB - ECS_AGENT_HEADROOM_MIB,
    );
    assert.ok(2 * RUNNER_CPU <= INSTANCE_VCPU * 1024);
  });
});

describe("the eval host's security group", () => {
  it("allows only HTTP and HTTPS out", () => {
    assert.deepEqual(
      INSTANCE_EGRESS.map((rule) => [rule.protocol, rule.fromPort, rule.toPort]),
      [
        ["tcp", 443, 443],
        ["tcp", 80, 80],
      ],
    );
  });
});

describe("the eval workflow role's trust", () => {
  it("is pinned to main and to the eval workflow file", () => {
    assert.equal(workflowTrust.Statement.length, 1);
    const condition = workflowTrust.Statement[0].Condition.StringEquals;
    assert.equal(condition["token.actions.githubusercontent.com:sub"], OPS_MAIN_SUBJECT);
    assert.equal(OPS_MAIN_SUBJECT, "repo:thegoodparty/ops:ref:refs/heads/main");
    assert.equal(
      condition["token.actions.githubusercontent.com:job_workflow_ref"],
      `thegoodparty/ops/.github/workflows/${WORKFLOW_FILE}@refs/heads/main`,
    );
    assert.equal(condition["token.actions.githubusercontent.com:aud"], "sts.amazonaws.com");
    assert.equal(
      Object.keys(workflowTrust.Statement[0].Condition).join(","),
      "StringEquals",
      "a StringLike beside it would be ANDed, not a wildcard escape, but it has no business here",
    );
  });

  it("can pass only the two eval roles", () => {
    const policy = workflowPolicy({ taskRoleArn: "arn:task", executionRoleArn: "arn:exec" });
    const pass = policy.Statement.filter((s) => s.Action.includes("iam:PassRole"));
    assert.deepEqual(pass.flatMap((s) => s.Resource), ["arn:task", "arn:exec"]);
    for (const statement of policy.Statement) {
      for (const action of statement.Action) {
        assert.ok(!action.endsWith(":*"), `${action} is a wildcard action`);
      }
    }
  });
});

describe("the eval host's inline role", () => {
  // Every container on a bridge network reaches this role through IMDS, so
  // anything added here is handed to the model proxy and the persona too.
  it("holds nothing beyond Bedrock, ECR pull and the results bucket", () => {
    const allowed = new Set([
      "bedrock:InvokeModel*",
      "ecr:GetAuthorizationToken",
      ...ECR_PULL_ACTIONS,
      "s3:GetObject",
      "s3:PutObject",
    ]);
    for (const statement of instancePolicy().Statement) {
      for (const action of statement.Action) {
        assert.ok(allowed.has(action), `${action} is not an eval host action`);
      }
      if (statement.Action.some((action) => action.startsWith("s3:"))) {
        for (const resource of statement.Resource) {
          assert.ok(
            resource.startsWith(`arn:aws:s3:::${RESULTS_BUCKET}/`),
            `${resource} is outside the results bucket`,
          );
        }
      }
      if (statement.Action.some((action) => ECR_PULL_ACTIONS.includes(action))) {
        assert.deepEqual(statement.Resource, [
          "arn:aws:ecr:us-west-2:333022194791:repository/bugboss-evals",
        ]);
      }
    }
  });
});
