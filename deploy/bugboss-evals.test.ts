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
  PROD_SESSIONS_ARN,
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

describe("Tier 2's reads", () => {
  const grants = (policy: ReturnType<typeof runnerTaskPolicy>, action: string) =>
    policy.Statement.filter((statement) => statement.Action.includes(action)).flatMap((statement) => statement.Resource);

  // The runner reads the recorded sessions; the workflow never does, and
  // the grant reaches no other prefix of the prod bucket.
  it("lets the runner read prod incident sessions, and nothing else of that bucket", () => {
    assert.equal(PROD_SESSIONS_ARN, "arn:aws:s3:::bugboss-prod/sessions/incident/*");
    const prod = grants(runnerTaskPolicy("arn:log"), "s3:GetObject").filter((arn) => arn.startsWith("arn:aws:s3:::bugboss-prod"));
    assert.deepEqual(prod, [PROD_SESSIONS_ARN]);
    const statement = runnerTaskPolicy("arn:log").Statement.find((s) => s.Resource.includes(PROD_SESSIONS_ARN));
    assert.deepEqual(statement?.Action, ["s3:GetObject"]);
  });

  it("lets the runner read variant tarballs and the workflow upload them", () => {
    assert.ok(grants(runnerTaskPolicy("arn:log"), "s3:GetObject").includes("arn:aws:s3:::goodparty-bugboss-evals/*"));
    const workflow = workflowPolicy({ taskRoleArn: "arn:task", executionRoleArn: "arn:exec" });
    assert.ok(grants(workflow, "s3:PutObject").includes("arn:aws:s3:::goodparty-bugboss-evals/*"));
    assert.ok(
      !workflow.Statement.flatMap((s) => s.Resource).some((arn) => arn.startsWith("arn:aws:s3:::bugboss-prod")),
      "the workflow never reads prod sessions",
    );
  });
});

describe("the eval workflow's task starts", () => {
  it("can start eval tasks on the eval cluster only", () => {
    const policy = workflowPolicy({ taskRoleArn: "arn:task", executionRoleArn: "arn:exec" });
    const run = policy.Statement.filter((s) => s.Action.includes("ecs:RunTask"));
    assert.equal(run.length, 1);
    assert.deepEqual(run[0].Condition, {
      ArnEquals: { "ecs:cluster": "arn:aws:ecs:us-west-2:333022194791:cluster/bugboss-evals" },
    });
  });
});
