import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AWS_REGION_ENV_NAME,
  BIFROST_CLUSTER_NAME,
  BIFROST_CONTAINER_NAME,
  BIFROST_LOG_GROUP_NAME,
  BIFROST_LOG_RETENTION_DAYS,
  BIFROST_LOG_STREAM_PREFIX,
  BIFROST_SERVICE_NAME,
  BIFROST_TASK_FAMILY,
  ECS_EXECUTION_MANAGED_POLICY_ARN,
  EXECUTION_ROLE_NAME,
  EXECUTION_SECRET_ACTIONS,
  GATEWAY_SECRET_KEYS,
  GATEWAY_SECRET_NAME,
  OAUTH2_PROXY_SECRET_KEYS,
  OAUTH2_PROXY_SECRET_NAME,
  PG_PASSWORD_ENV_NAME,
  RDS_PASSWORD_JSON_KEY,
  TASK_BEDROCK_ACTIONS,
  TASK_CPU,
  TASK_MEMORY,
  TASK_ROLE_NAME,
  executionRoleSecretsPolicyDocument,
  secretArnPattern,
  secretReference,
  taskRolePolicyDocument,
} from "./ecs";
import { BIFROST_PORT, REGION } from "./network";
import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import { bedrockInvokeResources } from "../utils/bedrock-models";
import { BIFROST_UPSTREAM_TAG } from "./bifrost-image";

/**
 * The ECS module's constants, its two policy documents, and the wiring of the
 * task definition, checked without standing up a Pulumi resource. The
 * resources themselves are exercised by the CI `pulumi preview` on the pull
 * request; what a unit test can usefully pin is the handful of things that
 * would break silently in an apply: the execution/task role split, the secret
 * references by name and key (a rename there is a container that starts
 * without its credentials), `initProcessEnabled`, the log configuration, the
 * subnet and security-group wiring, and the absence of any wildcard IAM
 * action.
 *
 * The task definition's arguments are asserted against the source, the way
 * `rds.test.ts` and `ingress.test.ts` do it, because the resource cannot be
 * constructed here without a Pulumi runtime.
 */

const ECS_SOURCE = fs.readFileSync(path.resolve(__dirname, "ecs.ts"), "utf8");
const INDEX_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "index.ts"),
  "utf8",
);
const FILL_SECRETS_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost/fill-secrets.sh"),
  "utf8",
);

/**
 * The source of one named resource's constructor call, from its logical-name
 * literal to the next `new aws.` (or the end of the file). Enough to tell
 * whether an argument belongs to that resource rather than a sibling, which a
 * bare `includes` on the whole file cannot.
 */
const resourceBlock = (logicalName: string): string => {
  const marker = `"${logicalName}"`;
  const start = ECS_SOURCE.indexOf(marker);
  assert.ok(start >= 0, `ecs.ts has no resource named ${logicalName}`);
  const rest = ECS_SOURCE.slice(start);
  const next = rest.indexOf("new aws.", 1);
  return next >= 0 ? rest.slice(0, next) : rest;
};

/**
 * The container-definition body, which ecs.ts builds above the task definition
 * (it is assembled as an `Output` first, then passed in). Assertions about the
 * container — its secrets, its log driver, its init process, its port — read
 * this rather than the task-definition block, which holds only the task-level
 * arguments.
 */
const containerBlock = (): string => {
  const start = ECS_SOURCE.indexOf("const containerDefinitions");
  assert.ok(start >= 0, "ecs.ts has no containerDefinitions builder");
  const end = ECS_SOURCE.indexOf("new aws.ecs.TaskDefinition(");
  assert.ok(
    end > start,
    "the container definitions must precede the task definition",
  );
  return ECS_SOURCE.slice(start, end);
};

describe("bifrost ecs", () => {
  it("runs one Fargate task at the plan's sizing", () => {
    // 0.5 vCPU / 1 GB, per "Compute: ECS Fargate" — the smallest valid
    // Fargate pair, and a one-line change if the load ever needs more.
    assert.equal(TASK_CPU, "512");
    assert.equal(TASK_MEMORY, "1024");

    const block = resourceBlock("bifrostTaskDefinition");
    assert.ok(block.includes('networkMode: "awsvpc"'), block);
    assert.ok(block.includes('requiresCompatibilities: ["FARGATE"]'), block);
    assert.ok(block.includes("cpu: TASK_CPU"));
    assert.ok(block.includes("memory: TASK_MEMORY"));
    assert.ok(block.includes("family: BIFROST_TASK_FAMILY"));
    assert.equal(BIFROST_TASK_FAMILY, "bifrost");
  });

  it("keeps the execution role and the task role split", () => {
    // Two roles, two names, two logical resources. Collapsing them would hand
    // the network-facing gateway process the ECS and Secrets Manager
    // permissions it never uses.
    assert.notEqual(EXECUTION_ROLE_NAME, TASK_ROLE_NAME);

    const taskDef = resourceBlock("bifrostTaskDefinition");
    assert.ok(
      taskDef.includes("executionRoleArn: executionRole.arn"),
      "the task definition must use the execution role it creates",
    );
    assert.ok(
      taskDef.includes("taskRoleArn: taskRole.arn"),
      "the task definition must use the task role it creates",
    );

    // The execution role is the ECS agent's: the managed task-execution
    // policy for ECR and logs, plus read on the injected secrets. It holds no
    // managed policy beyond that one.
    const executionRole = resourceBlock("bifrostExecutionRole");
    assert.ok(
      executionRole.includes(
        "managedPolicyArns: [ECS_EXECUTION_MANAGED_POLICY_ARN]",
      ),
      executionRole,
    );
    assert.equal(
      ECS_EXECUTION_MANAGED_POLICY_ARN,
      "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    );

    // The task role is the gateway's identity: no managed policies at all,
    // which is the whole difference from the delegate's task role.
    const taskRole = resourceBlock("bifrostTaskRole");
    assert.ok(
      !taskRole.includes("managedPolicyArns"),
      "the task role must not carry AWS-managed policies",
    );

    // Neither role's assumptions are shared with anything else, and neither
    // is assumed by a human.
    for (const name of [EXECUTION_ROLE_NAME, TASK_ROLE_NAME]) {
      assert.match(name, /^bifrost-/);
    }
  });

  it("gives the execution role secrets read and the task role nothing but Bedrock", () => {
    const executionPolicy = executionRoleSecretsPolicyDocument([
      secretArnPattern(GATEWAY_SECRET_NAME),
      secretArnPattern(OAUTH2_PROXY_SECRET_NAME),
      "arn:aws:secretsmanager:us-west-2:024901689212:secret:rds!db-abc123",
    ]);
    const executionActions = executionPolicy.Statement.flatMap((s) => s.Action);
    assert.deepEqual([...EXECUTION_SECRET_ACTIONS], [
      "secretsmanager:GetSecretValue",
    ]);
    assert.ok(executionActions.every((a) => a.startsWith("secretsmanager:")));
    assert.ok(
      executionActions.every((a) => !a.includes("bedrock")),
      "the execution role must not hold Bedrock actions",
    );

    const taskPolicy = taskRolePolicyDocument(bedrockInvokeResources());
    const taskActions = taskPolicy.Statement.flatMap((s) => s.Action);
    assert.deepEqual([...TASK_BEDROCK_ACTIONS], [
      "bedrock:Converse",
      "bedrock:ConverseStream",
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]);
    assert.ok(taskActions.every((a) => a.startsWith("bedrock:")));
    assert.ok(
      taskActions.every((a) => !a.includes("secretsmanager")),
      "the task role must not read secrets: the agent does that, not Bifrost",
    );
  });

  it("scopes the task role to the model list, not to wildcard resources", () => {
    // The plan: "The role is scoped to the model list in
    // utils/bedrock-models.ts". Composed here from the same function
    // WorkbenchAccess uses, so adding a model there reaches the gateway too.
    const policy = taskRolePolicyDocument(bedrockInvokeResources());
    const resources = policy.Statement.flatMap((s) => s.Resource);
    assert.ok(resources.length > 0);
    for (const arn of resources) {
      assert.match(arn, /^arn:aws:bedrock:/);
      assert.ok(
        arn.includes(":inference-profile/") || arn.includes(":foundation-model/"),
        arn,
      );
    }
    assert.ok(ECS_SOURCE.includes("bedrockInvokeResources()"));
  });

  it("has no wildcard IAM action or a wildcard resource on either role", () => {
    // The failure this catches is an edit that "fixes" an AccessDenied by
    // widening to `bedrock:*` or `Resource: "*"`, which is exactly the broad
    // grant the plan rules out.
    const executionPolicy = executionRoleSecretsPolicyDocument([
      secretArnPattern(GATEWAY_SECRET_NAME),
    ]);
    const taskPolicy = taskRolePolicyDocument(bedrockInvokeResources());

    for (const document of [executionPolicy, taskPolicy]) {
      assert.equal(document.Version, "2012-10-17");
      for (const statement of document.Statement) {
        assert.equal(statement.Effect, "Allow");
        for (const action of statement.Action) {
          assert.ok(!action.includes("*"), `wildcard action ${action}`);
        }
        assert.ok(statement.Resource.length > 0);
        for (const resource of statement.Resource) {
          assert.notEqual(resource, "*", "a resource must not be *");
        }
      }
    }

    // The execution role's resources are secret ARNs, and the only wildcard in
    // one is the six random characters Secrets Manager appends.
    for (const resource of executionPolicy.Statement.flatMap(
      (statement) => statement.Resource,
    )) {
      assert.match(
        resource,
        /^arn:aws:secretsmanager:us-west-2:024901689212:secret:.+-\?\?\?\?\?\?$/,
      );
    }

    // The task role's are model ARNs. They carry exactly one wildcard, the
    // region, and that is deliberate: the destination set differs per model
    // (`utils/bedrock-models.ts`), so enumerating regions fails intermittently
    // and looks identical to missing model access.
    for (const resource of taskPolicy.Statement.flatMap(
      (statement) => statement.Resource,
    )) {
      assert.match(resource, /^arn:aws:bedrock:\*:/, resource);
      assert.equal(
        resource.split("*").length - 1,
        1,
        `only the region may be wildcarded: ${resource}`,
      );
    }
    // And nothing in the module sneaks a wildcard into an inline document.
    assert.ok(
      !/Action:\s*(\[?\s*)?["'][a-z0-9]+:\*["']/.test(ECS_SOURCE),
      "ecs.ts must not contain a service-wildcard action",
    );
    assert.ok(
      !/Resource:\s*(\[?\s*)?["']\*["']/.test(ECS_SOURCE),
      "ecs.ts must not contain a wildcard resource",
    );
    assert.ok(
      !/"\*"/.test(ECS_SOURCE),
      "ecs.ts must not contain a bare wildcard",
    );
  });

  it("references the gateway secrets by the names and keys fill-secrets.sh writes", () => {
    // The script announced the two containers, and its key names are what the
    // plan injects. Nothing is renamed on either side: this is the assertion
    // that keeps the task definition and the runbook in step.
    assert.equal(GATEWAY_SECRET_NAME, "bifrost/gateway");
    assert.equal(OAUTH2_PROXY_SECRET_NAME, "bifrost/oauth2-proxy");
    assert.ok(
      FILL_SECRETS_SOURCE.includes(`GATEWAY_SECRET="${GATEWAY_SECRET_NAME}"`),
      "fill-secrets.sh names a different gateway secret",
    );
    assert.ok(
      FILL_SECRETS_SOURCE.includes(`OAUTH_SECRET="${OAUTH2_PROXY_SECRET_NAME}"`),
      "fill-secrets.sh names a different oauth2-proxy secret",
    );

    assert.deepEqual([...GATEWAY_SECRET_KEYS], [
      "BIFROST_ENCRYPTION_KEY",
      "BIFROST_ADMIN_USERNAME",
      "BIFROST_ADMIN_PASSWORD",
      "FIREWORKS_API_KEY",
    ]);
    assert.deepEqual([...OAUTH2_PROXY_SECRET_KEYS], [
      "OAUTH2_PROXY_CLIENT_ID",
      "OAUTH2_PROXY_CLIENT_SECRET",
      "OAUTH2_PROXY_COOKIE_SECRET",
    ]);
    for (const key of [...GATEWAY_SECRET_KEYS, ...OAUTH2_PROXY_SECRET_KEYS]) {
      assert.ok(
        FILL_SECRETS_SOURCE.includes(key),
        `fill-secrets.sh does not write ${key}`,
      );
    }

    // The gateway container gets exactly its own four, by name, from its own
    // container; the oauth2-proxy three are item 9's to inject.
    const block = containerBlock();
    assert.ok(block.includes("GATEWAY_SECRET_KEYS.map"), block);
    assert.ok(
      block.includes("secretReference(GATEWAY_SECRET_NAME, key)"),
      block,
    );
    assert.ok(
      !ECS_SOURCE.includes("OAUTH2_PROXY_SECRET_KEYS.map"),
      "the oauth2-proxy sidecar is item 9; nothing here may inject its keys",
    );
  });

  it("builds a valueFrom that names the secret, the key and the defaults", () => {
    assert.equal(
      secretReference(GATEWAY_SECRET_NAME, "BIFROST_ENCRYPTION_KEY"),
      `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:bifrost/gateway:BIFROST_ENCRYPTION_KEY::`,
    );
    // Partial ARN: no random six-character suffix, because nothing here may
    // describe the secret, and a refill must not need a task-definition change.
    assert.ok(
      !secretReference(GATEWAY_SECRET_NAME, "X").includes("?"),
      "a valueFrom cannot wildcard the ARN suffix",
    );
    // The IAM resource is the opposite: Secrets Manager appends six random
    // characters, so the grant has to wildcard exactly them.
    assert.equal(
      secretArnPattern(GATEWAY_SECRET_NAME),
      `arn:aws:secretsmanager:${REGION}:${WORKBENCH_ACCOUNT_ID}:secret:bifrost/gateway-??????`,
    );
    assert.equal(REGION, "us-west-2");
  });

  it("injects the RDS-managed master password item 7 handed over", () => {
    // rds.ts: "The secret's ARN is returned below for item 8 to inject as the
    // task's `PG_PASSWORD`". Only the password; host, port, user and database
    // belong to config.json in item 10.
    assert.equal(RDS_PASSWORD_JSON_KEY, "password");
    assert.equal(PG_PASSWORD_ENV_NAME, "PG_PASSWORD");
    const block = containerBlock();
    assert.ok(
      block.includes("valueFrom: `${databaseSecretArn}:${RDS_PASSWORD_JSON_KEY}::`"),
      block,
    );
    // And the read grant names the same ARN.
    assert.ok(
      resourceBlock("bifrostExecutionRole").includes("database.secretArn.apply"),
      "the execution role must be granted read on the RDS secret",
    );
  });

  it("never declares, versions or reads a secret's value", () => {
    // The two containers are script-owned and already hold real values; a
    // Pulumi-declared `Secret` or `SecretVersion` here could replace one and
    // delete them. Nothing in this module reads a value either, which is what
    // keeps `preview` free of `secretsmanager:GetSecretValue`.
    for (const forbidden of [
      "new aws.secretsmanager.Secret(",
      "aws.secretsmanager.SecretVersion",
      "aws.secretsmanager.getSecret",
      "getSecretValue",
    ]) {
      assert.ok(
        !ECS_SOURCE.includes(forbidden),
        `ecs.ts must not use ${forbidden}`,
      );
    }
  });

  it("runs Bifrost under an init process with awslogs", () => {
    const block = containerBlock();
    // Both are the delegate's idiom, copied deliberately: PID 1 reaps and
    // forwards signals, and the container's stdout is the log group.
    assert.ok(
      block.includes("linuxParameters: { initProcessEnabled: true }"),
      "the container must set initProcessEnabled",
    );
    assert.ok(block.includes('logDriver: "awslogs"'), block);
    assert.ok(block.includes('"awslogs-group": logGroup.name'), block);
    assert.ok(block.includes('"awslogs-region": REGION'), block);
    assert.ok(
      block.includes('"awslogs-stream-prefix": BIFROST_LOG_STREAM_PREFIX'),
      block,
    );
    assert.equal(BIFROST_LOG_STREAM_PREFIX, "bifrost");
  });

  it("keeps the log group named, retained and the container's port", () => {
    assert.equal(BIFROST_LOG_GROUP_NAME, "/aws/ecs/bifrost");
    assert.equal(BIFROST_LOG_RETENTION_DAYS, 30);
    const logGroup = resourceBlock("bifrostLogGroup");
    assert.ok(logGroup.includes("name: BIFROST_LOG_GROUP_NAME"), logGroup);
    assert.ok(
      logGroup.includes("retentionInDays: BIFROST_LOG_RETENTION_DAYS"),
      "the log group must set a retention; CloudWatch never expires by default",
    );

    const block = containerBlock();
    assert.ok(block.includes("containerPort: BIFROST_PORT"), block);
    assert.equal(BIFROST_PORT, 8080);
    assert.equal(BIFROST_CONTAINER_NAME, "bifrost");
  });

  it("runs in the private subnets with the task security group", () => {
    const service = resourceBlock("bifrostService");
    assert.ok(service.includes("subnets: network.privateSubnetIds"), service);
    assert.ok(
      service.includes("securityGroups: [network.taskSecurityGroup.id]"),
      "the service must use item 5's task security group",
    );
    assert.ok(service.includes("assignPublicIp: false"), service);
    assert.ok(
      !service.includes("publicSubnetIds"),
      "the task must not run in the public subnets",
    );
  });

  it("registers against item 6's target group rather than a new one", () => {
    const service = resourceBlock("bifrostService");
    assert.ok(
      service.includes("targetGroupArn: ingress.bifrostTargetGroup.arn"),
      service,
    );
    assert.ok(service.includes("containerName: BIFROST_CONTAINER_NAME"));
    assert.ok(service.includes("containerPort: BIFROST_PORT"));
    assert.equal(BIFROST_SERVICE_NAME, "bifrost");

    // Nothing in this module creates a target group, a listener, an ALB or a
    // security group: they already exist, and a second copy would be a target
    // nothing routes to and a group nothing references.
    for (const forbidden of [
      "new aws.lb.TargetGroup(",
      "new aws.lb.Listener(",
      "new aws.lb.LoadBalancer(",
      "new aws.ec2.SecurityGroup(",
      "new aws.vpc.SecurityGroup",
    ]) {
      assert.ok(
        !ECS_SOURCE.includes(forbidden),
        `ecs.ts must not declare ${forbidden}`,
      );
    }
  });

  it("is one task, in a cluster with container insights", () => {
    const service = resourceBlock("bifrostService");
    assert.ok(service.includes("desiredCount: 1"), service);
    assert.ok(service.includes('launchType: "FARGATE"'), service);
    // OSS Bifrost is single-node; a second task is not a valid topology.
    assert.ok(
      !/desiredCount:\s*(BIFROST_|TASK_|[2-9])/.test(service),
      "the service must run exactly one task",
    );
    // Nothing autoscales it, which would be a second task by another name.
    assert.ok(!ECS_SOURCE.includes("aws.appautoscaling"), ECS_SOURCE);

    assert.equal(BIFROST_CLUSTER_NAME, "bifrost");
    const cluster = resourceBlock("bifrostCluster");
    assert.ok(
      cluster.includes('settings: [{ name: "containerInsights", value: "enabled" }]'),
      "the cluster must enable container insights",
    );
  });

  it("names the pinned image from the mirror, not a floating tag", () => {
    assert.ok(ECS_SOURCE.includes("${repositoryUrl}:${BIFROST_UPSTREAM_TAG}"));
    // The pin itself lives in bifrost-image.ts and is asserted there.
    assert.equal(BIFROST_UPSTREAM_TAG, "v2.3.0");
    assert.ok(ECS_SOURCE.includes("cpuArchitecture: \"X86_64\""));
  });

  it("takes its one plain environment variable from the network module", () => {
    // The Bedrock provider resolves a region from the environment; everything
    // else is BIFROST_CONFIG in item 10.
    assert.equal(AWS_REGION_ENV_NAME, "AWS_REGION");
    const block = containerBlock();
    assert.ok(
      block.includes('{ name: AWS_REGION_ENV_NAME, value: REGION }'),
      block,
    );
    assert.ok(
      !block.includes("BIFROST_CONFIG"),
      "BIFROST_CONFIG is item 10 and must not appear here yet",
    );
  });

  it("is wired into index.ts with the network, the ingress and the database", () => {
    assert.ok(
      INDEX_SOURCE.includes("createBifrostEcs"),
      "index.ts does not create the ECS resources",
    );
    for (const arg of ["network,", "ingress,", "database,"]) {
      assert.ok(
        INDEX_SOURCE.includes(`  ${arg}`),
        `index.ts does not pass ${arg} to createBifrostEcs`,
      );
    }
    assert.ok(
      INDEX_SOURCE.includes("repositoryUrl: bifrostRepository.repositoryUrl"),
      "index.ts does not pass the mirrored repository to the task definition",
    );
    assert.ok(
      INDEX_SOURCE.includes("export const bifrostLogGroupName"),
      "index.ts must export the log group name for item 12",
    );
  });
});
