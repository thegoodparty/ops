import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import * as pulumi from "@pulumi/pulumi";

import {
  createBugBoss,
  READONLY_DB_PASSWORD_PARAMETER_ARN,
  SQL_RUNNER_LOG_GROUP,
  SQL_RUNNER_URL,
} from "./components/bugboss";

type Registered = {
  type: string;
  name: string;
  inputs: pulumi.runtime.MockResourceArgs["inputs"];
};

type Statement = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: string | string[];
};

type Container = {
  name: string;
  essential: boolean;
  environment?: { name: string; value: string }[];
  secrets?: { name: string; valueFrom: string }[];
  portMappings?: unknown[];
  mountPoints?: unknown[];
  logConfiguration?: { options: Record<string, string> };
};

const registered: Registered[] = [];

pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      registered.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}-id`,
        state: {
          ...args.inputs,
          arn: `arn:aws:mock:us-west-2:333022194791:${args.name}`,
          name: args.inputs.name ?? args.name,
        },
      };
    },
    call: (args) => ({
      ...args.inputs,
      arn: `arn:aws:mock:us-west-2:333022194791:${args.token}`,
    }),
  },
  "ops",
  "prod",
  false,
);

const ofType = (type: string) => registered.filter((r) => r.type === type);

const one = (type: string, name: string) => {
  const found = registered.find((r) => r.type === type && r.name === name);
  assert.ok(found, `${type} ${name} was never registered`);
  return found;
};

const list = <T>(value: T | T[]) => (Array.isArray(value) ? value : [value]);

const statements = (role: Registered): Statement[] =>
  (role.inputs.inlinePolicies as { policy: string }[]).flatMap(
    (p) => JSON.parse(p.policy).Statement as Statement[],
  );

// IAM's own wildcard semantics, so a statement that reaches the parameter
// through `/gp-api-prod/*` or `*` counts as reaching it.
const matches = (pattern: string, arn: string) =>
  new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
  ).test(arn);

const SQL_RUNNER_LOG_ARNS = [
  `arn:aws:logs:us-west-2:333022194791:log-group:${SQL_RUNNER_LOG_GROUP}`,
  `arn:aws:logs:us-west-2:333022194791:log-group:${SQL_RUNNER_LOG_GROUP}:*`,
];

describe("the SQL runner's trust boundary in the task definition", () => {
  let taskRole: Registered;
  let executionRole: Registered;
  let containers: Container[];

  before(async () => {
    const bugboss = createBugBoss({
      imageUri: "333022194791.dkr.ecr.us-west-2.amazonaws.com/bugboss:test",
      subnetIds: ["subnet-a", "subnet-b"],
    });
    await new Promise((resolve) => bugboss.service.urn.apply(resolve));
    const deadline = Date.now() + 5000;
    while (
      ofType("aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule").length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    taskRole = one("aws:iam/role:Role", "bugbossTaskRole");
    executionRole = one("aws:iam/role:Role", "bugbossExecutionRole");
    containers = JSON.parse(
      one("aws:ecs/taskDefinition:TaskDefinition", "bugbossTaskDef").inputs
        .containerDefinitions,
    );
  });

  const container = (name: string) => {
    const found = containers.find((c) => c.name === name);
    assert.ok(found, `no ${name} container`);
    return found;
  };

  // The explicit deny would stop such an Allow from taking effect. This is
  // here anyway, because an Allow that covers the credential means somebody
  // believed the agent should have it, and that belongs in review.
  it("never allows the task role the read-only password or the runner's logs", () => {
    const reads: [string, string[]][] = [
      [
        READONLY_DB_PASSWORD_PARAMETER_ARN,
        ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:GetParameterHistory"],
      ],
      ...SQL_RUNNER_LOG_ARNS.map((arn): [string, string[]] => [
        arn,
        ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail"],
      ]),
    ];
    for (const s of statements(taskRole).filter((s) => s.Effect === "Allow")) {
      for (const [arn, actions] of reads) {
        const action = actions.find((a) => list(s.Action).some((p) => matches(p, a)));
        const resource = list(s.Resource).find((r) => matches(r, arn));
        assert.ok(
          !(action && resource),
          `${s.Sid ?? "a statement"} allows ${action} on ${resource}, which covers ${arn}`,
        );
      }
    }
  });

  it("explicitly denies the task role the password and the runner's logs", () => {
    const denies = statements(taskRole).filter((s) => s.Effect === "Deny");
    const denied = (action: string, arn: string) =>
      denies.some(
        (s) =>
          list(s.Action).some((a) => matches(a, action)) &&
          list(s.Resource).some((r) => matches(r, arn)),
      );
    assert.ok(denied("ssm:GetParameter", READONLY_DB_PASSWORD_PARAMETER_ARN));
    assert.ok(denied("ssm:GetParameters", READONLY_DB_PASSWORD_PARAMETER_ARN));
    for (const arn of SQL_RUNNER_LOG_ARNS) {
      assert.ok(denied("logs:GetLogEvents", arn), `${arn} is not denied`);
      assert.ok(denied("logs:FilterLogEvents", arn), `${arn} is not denied`);
    }
  });

  it("lets the execution role, which injects secrets, fetch the password", () => {
    const allowed = statements(executionRole).some(
      (s) =>
        s.Effect === "Allow" &&
        list(s.Action).includes("ssm:GetParameters") &&
        list(s.Resource).includes(READONLY_DB_PASSWORD_PARAMETER_ARN),
    );
    assert.ok(allowed);
  });

  it("puts the runner's log group outside every prefix the task role reads", () => {
    const group = one("aws:cloudwatch/logGroup:LogGroup", "bugbossSqlRunnerLogGroup");
    assert.equal(group.inputs.name, SQL_RUNNER_LOG_GROUP);
    assert.equal(
      container("sqlrunner").logConfiguration?.options["awslogs-group"],
      SQL_RUNNER_LOG_GROUP,
    );
  });

  it("gives the password to the sidecar and to no other container", () => {
    const holders = containers.filter((c) =>
      (c.secrets ?? []).some(
        (s) =>
          s.name === "GP_API_READONLY_DB_PASSWORD" ||
          s.valueFrom === READONLY_DB_PASSWORD_PARAMETER_ARN,
      ),
    );
    assert.deepEqual(
      holders.map((c) => c.name),
      ["sqlrunner"],
    );
    assert.ok(
      !(container("bugboss").environment ?? []).some((e) =>
        e.name.startsWith("GP_API_READONLY_DB"),
      ),
    );
  });

  it("keeps the sidecar off the ENI, off the work volume, and non-essential", () => {
    const runner = container("sqlrunner");
    assert.equal(runner.portMappings, undefined);
    assert.equal(runner.mountPoints, undefined);
    assert.equal(runner.essential, false);
  });

  it("tells the Boss where the sidecar listens", () => {
    const env = container("bugboss").environment ?? [];
    assert.deepEqual(
      env.find((e) => e.name === "BUGBOSS_SQL_RUNNER_URL"),
      { name: "BUGBOSS_SQL_RUNNER_URL", value: SQL_RUNNER_URL },
    );
  });

  it("opens gp-api prod's database to this task on 5432 and nothing wider", () => {
    const rules = ofType("aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule");
    assert.equal(rules.length, 1);
    const [rule] = rules;
    assert.equal(rule.inputs.securityGroupId, "sg-03783e4adbbee87dc");
    assert.equal(rule.inputs.referencedSecurityGroupId, "bugbossServiceSg-id");
    assert.equal(rule.inputs.cidrIpv4, undefined);
    assert.equal(rule.inputs.ipProtocol, "tcp");
    assert.equal(rule.inputs.fromPort, 5432);
    assert.equal(rule.inputs.toPort, 5432);
  });
});
