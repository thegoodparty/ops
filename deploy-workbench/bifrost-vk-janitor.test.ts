import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { MANAGEMENT_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import {
  bifrostVkReaderTrust,
  VK_READER_SESSION_NAME,
} from "../deploy/components/bifrost-vk-reader";
import { GATEWAY_SECRET_NAME, secretArnPattern } from "./ecs";
import { BIFROST_PORT } from "./network";
import { BIFROST_DISCOVERY_DNS_NAME } from "./discovery";
import {
  SETUP_TOKEN_SECRET_JSON_KEY,
  SETUP_TOKEN_SECRET_NAME,
  VK_READER_ROLE_ARN,
} from "./bifrost-vk-mint";
import {
  VK_JANITOR_FUNCTION_NAME,
  VK_JANITOR_INTERVAL_MINUTES,
  VK_JANITOR_LOG_GROUP_NAME,
  VK_JANITOR_LOG_RETENTION_DAYS,
  VK_JANITOR_MEMORY_MB,
  VK_JANITOR_NAME,
  VK_JANITOR_RESERVED_CONCURRENCY,
  VK_JANITOR_ROLE_NAME,
  VK_JANITOR_SCHEDULE_EXPRESSION,
  VK_JANITOR_TIMEOUT_SECONDS,
  vkJanitorEnvironment,
  vkJanitorExecutionPolicy,
} from "./bifrost-vk-janitor";

/**
 * Step 5's infrastructure, pinned without standing up Pulumi, the same shape as
 * `bifrost-vk-mint.test.ts`: the literals other files depend on, and the grants
 * that are too easy to widen by accident.
 *
 * The two directions of the trust get their own test because they are two files
 * that apply asynchronously: this stack creates the role the merged
 * `bifrost-vk-reader` trust names, and this role grants itself an
 * `sts:AssumeRole` on the reader. A drift either way is an `AccessDenied` at
 * the first directory read, not an apply-time error.
 */

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost-vk-janitor.ts"),
  "utf8",
);
const CORE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost/vk-janitor-core.ts"),
  "utf8",
);
const NETWORK_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "network.ts"),
  "utf8",
);
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");

const policy = () =>
  vkJanitorExecutionPolicy({
    logGroupArn: `arn:aws:logs:us-west-2:${WORKBENCH_ACCOUNT_ID}:log-group:${VK_JANITOR_LOG_GROUP_NAME}`,
  });

describe("the execution role the merged reader trust depends on", () => {
  it("is named exactly bifrost-vk-janitor, the literal step 2's trust names", () => {
    assert.equal(VK_JANITOR_NAME, "bifrost-vk-janitor");
    assert.equal(VK_JANITOR_ROLE_NAME, "bifrost-vk-janitor");
    assert.equal(VK_JANITOR_FUNCTION_NAME, "bifrost-vk-janitor");

    const trustedRoleArns = bifrostVkReaderTrust.Statement.flatMap((statement) =>
      (statement as { Condition?: { ArnEquals?: Record<string, string[]> } })
        .Condition?.ArnEquals?.["aws:PrincipalArn"] ?? [],
    );
    const expected = `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/${VK_JANITOR_ROLE_NAME}`;
    assert.ok(
      trustedRoleArns.includes(expected),
      `deploy/components/bifrost-vk-reader.ts does not trust ${expected}; the first AssumeRole would be an AccessDenied`,
    );
  });

  it("grants itself sts:AssumeRole on the reader role and nothing wider", () => {
    assert.equal(
      VK_READER_ROLE_ARN,
      `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/bifrost-vk-reader`,
    );
    assert.ok(!VK_READER_ROLE_ARN.includes(WORKBENCH_ACCOUNT_ID));

    const assume = policy().Statement.find((s) => s.Sid === "AssumeVkReader");
    assert.ok(assume, "no AssumeVkReader statement");
    assert.deepEqual(assume.Action, ["sts:AssumeRole"]);
    assert.deepEqual(assume.Resource, [VK_READER_ROLE_ARN]);
    assert.ok(!assume.Resource.includes("*"));
  });

  it("passes VK_READER_SESSION_NAME rather than retyping the literal", () => {
    assert.equal(VK_READER_SESSION_NAME, "bifrost-vk-reader");
    assert.equal(vkJanitorEnvironment().READER_SESSION_NAME, VK_READER_SESSION_NAME);
    assert.match(SOURCE, /READER_SESSION_NAME:\s*VK_READER_SESSION_NAME,/);
    assert.doesNotMatch(SOURCE, /READER_SESSION_NAME:\s*"bifrost-vk-reader"/);
  });
});

describe("the function, its schedule and its network", () => {
  it("reaches the task by its private name on the gateway's port, not through the ALB", () => {
    const environment = vkJanitorEnvironment();
    assert.equal(
      environment.BIFROST_BASE_URL,
      `http://${BIFROST_DISCOVERY_DNS_NAME}:${BIFROST_PORT}`,
    );
    assert.equal(BIFROST_DISCOVERY_DNS_NAME, "bifrost.workbench.local");
    assert.equal(BIFROST_PORT, 8080);
    assert.doesNotMatch(environment.BIFROST_BASE_URL, /goodparty\.org/);
  });

  it("is scheduled hourly from a named constant (open item 3), with a timeout below the interval", () => {
    assert.equal(VK_JANITOR_INTERVAL_MINUTES, 60);
    assert.equal(VK_JANITOR_SCHEDULE_EXPRESSION, "rate(60 minutes)");
    // The expression is derived from the constant, so changing the interval
    // cannot leave the rule and the documented number disagreeing.
    assert.match(
      SOURCE,
      /scheduleExpression:\s*VK_JANITOR_SCHEDULE_EXPRESSION/,
    );
    assert.ok(VK_JANITOR_TIMEOUT_SECONDS < VK_JANITOR_INTERVAL_MINUTES * 60);
    // A reconcile that reads, classifies and writes must not have two runs
    // interleaved.
    assert.equal(VK_JANITOR_RESERVED_CONCURRENCY, 1);
    assert.match(SOURCE, /reservedConcurrentExecutions:\s*VK_JANITOR_RESERVED_CONCURRENCY/);
  });

  it("has one EventBridge rule, target and invoke permission", () => {
    assert.match(SOURCE, /new aws\.cloudwatch\.EventRule\(/);
    assert.match(SOURCE, /new aws\.cloudwatch\.EventTarget\(/);
    const permission = /new aws\.lambda\.Permission\(([\s\S]*?)\{ provider \}/.exec(SOURCE);
    assert.ok(permission, "no lambda:Permission for the schedule");
    assert.match(permission[1], /action:\s*"lambda:InvokeFunction"/);
    assert.match(permission[1], /principal:\s*"events\.amazonaws\.com"/);
    assert.match(permission[1], /sourceArn:\s*rule\.arn/);
  });

  it("is a scheduled function, not an endpoint: no Function URL and no IAM-gated URL", () => {
    // The mint's door is a Function URL; the janitor has no caller but
    // EventBridge, so it must not grow one by accident.
    assert.doesNotMatch(SOURCE, /aws\.lambda\.FunctionUrl/);
    assert.doesNotMatch(SOURCE, /authorizationType/);
    assert.match(SOURCE, /principal:\s*"events\.amazonaws\.com"/);
  });

  it("is attached to the gateway's private subnets with its own security group", () => {
    assert.match(SOURCE, /subnetIds:\s*network\.privateSubnetIds/);
    assert.match(SOURCE, /securityGroupIds:\s*\[securityGroup\.id\]/);
    assert.match(SOURCE, /name:\s*"bifrost-vk-janitor",/);
    assert.equal(VK_JANITOR_MEMORY_MB, 256);
  });

  it("adds its own 8080 ingress rule to the task security group, from its own group only", () => {
    const ingress = /new aws\.vpc\.SecurityGroupIngressRule\(\s*"bifrostTaskIngressVkJanitor",([\s\S]*?)\{ provider \}/.exec(
      SOURCE,
    );
    assert.ok(ingress, "no ingress rule on the task's group");
    const body = ingress[1];
    assert.match(body, /securityGroupId:\s*network\.taskSecurityGroup\.id/);
    assert.match(body, /fromPort:\s*BIFROST_PORT/);
    assert.match(body, /toPort:\s*BIFROST_PORT/);
    assert.match(body, /referencedSecurityGroupId:\s*securityGroup\.id/);
    // A CIDR would admit more than this function; the task group's invariant is
    // that every rule names a group.
    assert.doesNotMatch(body, /cidrIpv4/);

    // The gateway's own group description is deliberately unchanged: it is
    // ForceNew, and both Lambdas' exceptions are documented where their rules
    // are, not in a string that would replace the group.
    assert.match(
      NETWORK_SOURCE,
      /Bifrost gateway Fargate task: 8080 \(Bifrost\) and 4180 \(oauth2-proxy\) from the ALB only\./,
    );
  });

  it("egresses 8080 to the task, 443 to AWS APIs and DNS to the resolver", () => {
    assert.match(SOURCE, /fromPort:\s*BIFROST_PORT,\s*toPort:\s*BIFROST_PORT,\s*referencedSecurityGroupId:\s*network\.taskSecurityGroup\.id/);
    assert.match(SOURCE, /fromPort:\s*443,\s*toPort:\s*443,\s*cidrIpv4:\s*"0\.0\.0\.0\/0"/);
    assert.match(SOURCE, /fromPort:\s*53,\s*toPort:\s*53,\s*cidrIpv4:\s*VPC_CIDR/);
  });

  it("is wired into the stack and exports its evidence", () => {
    assert.match(INDEX_SOURCE, /createBifrostVkJanitor\(\{\s*provider,\s*network\s*\}\)/);
    assert.match(INDEX_SOURCE, /export const vkBifrostJanitorFunctionArn/);
    assert.match(INDEX_SOURCE, /export const vkBifrostJanitorScheduleRuleName/);
  });
});

describe("the shared secret and the grants", () => {
  it("reads the same setup-token container the mint reads (decision 6)", () => {
    assert.equal(SETUP_TOKEN_SECRET_NAME, GATEWAY_SECRET_NAME);
    assert.equal(vkJanitorEnvironment().SETUP_TOKEN_SECRET_NAME, GATEWAY_SECRET_NAME);
    assert.equal(
      vkJanitorEnvironment().SETUP_TOKEN_SECRET_JSON_KEY,
      SETUP_TOKEN_SECRET_JSON_KEY,
    );

    const secret = policy().Statement.find((s) => s.Sid === "ReadSetupToken");
    assert.ok(secret, "no ReadSetupToken statement");
    assert.deepEqual(secret.Action, ["secretsmanager:GetSecretValue"]);
    assert.deepEqual(secret.Resource, [secretArnPattern(GATEWAY_SECRET_NAME)]);

    // One container, named through the shared constant, and nothing broader:
    // this grant reaches the gateway's encryption and Fireworks keys too (the
    // cost decision 3 records), and it must not reach a second secret.
    const secretResources = policy()
      .Statement.flatMap((s) => s.Resource)
      .filter((r) => r.includes(":secret:"));
    assert.deepEqual(secretResources, [secretArnPattern(GATEWAY_SECRET_NAME)]);
    assert.doesNotMatch(SOURCE, /VK_MINT_SECRET/);
    assert.doesNotMatch(SOURCE, /["']bifrost\/(gateway|vk-mint)["']/);
  });

  it("holds the token in the secret, never in the function's environment", () => {
    assert.deepEqual(Object.keys(vkJanitorEnvironment()).sort(), [
      "BIFROST_BASE_URL",
      "READER_ROLE_ARN",
      "READER_SESSION_NAME",
      "SETUP_TOKEN_SECRET_JSON_KEY",
      "SETUP_TOKEN_SECRET_NAME",
    ]);
    assert.ok(
      !Object.values(vkJanitorEnvironment()).some((value) =>
        /token-[a-z0-9]/i.test(value),
      ),
    );
  });

  it("grants no identitystore action, no SSM, no CreateLogGroup and no KMS", () => {
    const actions = policy().Statement.flatMap((s) => s.Action);
    assert.deepEqual(actions.sort(), [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "secretsmanager:GetSecretValue",
      "sts:AssumeRole",
    ]);
    assert.ok(!actions.some((action) => action.startsWith("identitystore:")));
    assert.ok(!actions.some((action) => action.startsWith("ssm:")));
    assert.ok(!actions.includes("kms:Decrypt"));
    assert.ok(!actions.includes("logs:CreateLogGroup"));
  });

  it("writes to its own log group, with a retention longer than the key window", () => {
    assert.equal(VK_JANITOR_LOG_GROUP_NAME, "/aws/lambda/bifrost-vk-janitor");
    assert.equal(VK_JANITOR_LOG_RETENTION_DAYS, 90);
    assert.match(SOURCE, /retentionInDays:\s*VK_JANITOR_LOG_RETENTION_DAYS/);
    const logs = policy().Statement.find((s) => s.Sid === "WriteOwnLogs");
    assert.ok(logs);
    assert.deepEqual(logs.Resource, [
      `arn:aws:logs:us-west-2:${WORKBENCH_ACCOUNT_ID}:log-group:${VK_JANITOR_LOG_GROUP_NAME}:*`,
    ]);
  });

  it("reads no SSM template and declares no SSM parameter", () => {
    // The template is the mint's; a janitor that read it would be a second
    // consumer of a shape it never needs.
    assert.doesNotMatch(SOURCE, /aws\.ssm\.Parameter/);
    assert.doesNotMatch(SOURCE, /TEMPLATE_PARAMETER_NAME/);
  });
});

describe("the marker is the shared constant, not a local copy", () => {
  it("imports isManagedKeyDescription from vk-marker.ts", () => {
    assert.match(CORE_SOURCE, /import \{ isManagedKeyDescription \} from "\.\/vk-marker"/);
    assert.match(CORE_SOURCE, /isManagedKeyDescription\(key\.description\)/);
    // The literal would be a second declaration of the one string decision 5
    // says both Lambdas must match.
    assert.doesNotMatch(CORE_SOURCE, /["'`]lambda-managed/);
  });
});
