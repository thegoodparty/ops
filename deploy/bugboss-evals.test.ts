import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ECR_LIFECYCLE_POLICY,
  ECR_PULL_ACTIONS,
  ECS_AGENT_HEADROOM_MIB,
  INSTANCE_EGRESS,
  INSTANCE_METADATA_OPTIONS,
  INSTANCE_MEMORY_MIB,
  INSTANCE_VCPU,
  MODEL_ROLE_ARN,
  OPS_MAIN_SUBJECT,
  RUNNER_CPU,
  RUNNER_MEMORY_RESERVATION_MIB,
  WORKFLOW_FILE,
  modelPolicy,
  runnerTaskPolicy,
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

describe("the eval host's metadata", () => {
  // Hop limit 1 is what keeps every container, the model proxy included, off
  // the host role; tokens required is what stops a plain GET getting it.
  it("is IMDSv2 only and ends one hop past the host", () => {
    assert.deepEqual(INSTANCE_METADATA_OPTIONS, {
      httpEndpoint: "enabled",
      httpTokens: "required",
      httpPutResponseHopLimit: 1,
    });
  });
});

describe("the model role", () => {
  // Its session is written where the model proxy and the persona read it, so
  // anything added here reaches both.
  it("can call models and nothing else", () => {
    const actions = modelPolicy().Statement.flatMap((statement) => statement.Action);
    assert.deepEqual(actions, ["bedrock:InvokeModel*"]);
  });

  it("is the runner's only route to a model", () => {
    const policy = runnerTaskPolicy("arn:log");
    const actions = policy.Statement.flatMap((statement) => statement.Action);
    assert.ok(!actions.some((action) => action.startsWith("bedrock:")), "the runner calls no model itself");
    const assume = policy.Statement.filter((statement) => statement.Action.includes("sts:AssumeRole"));
    assert.deepEqual(assume.flatMap((statement) => statement.Resource), [MODEL_ROLE_ARN]);
  });
});

describe("the eval repository's lifecycle", () => {
  it("never expires the runner tag the task definition names", () => {
    for (const rule of ECR_LIFECYCLE_POLICY.rules) {
      const patterns: string[] = ("tagPatternList" in rule.selection ? rule.selection.tagPatternList : undefined) ?? [];
      assert.ok(!patterns.some((pattern) => "runner".startsWith(pattern.replace("*", ""))), JSON.stringify(rule));
    }
  });
});
