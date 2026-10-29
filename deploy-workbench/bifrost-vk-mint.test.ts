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
  VK_MINT_FUNCTION_NAME,
  VK_MINT_LOG_GROUP_NAME,
  VK_MINT_LOG_RETENTION_DAYS,
  VK_MINT_ROLE_NAME,
  SETUP_TOKEN_SECRET_JSON_KEY,
  SETUP_TOKEN_SECRET_NAME,
  VK_MINT_TEMPLATE_PARAMETER_NAME,
  VK_READER_ROLE_ARN,
  readVkMintTemplate,
  vkMintEnvironment,
  vkMintExecutionPolicy,
} from "./bifrost-vk-mint";
import { VK_DESCRIPTION_MARKER } from "./bifrost/vk-marker";

/**
 * Step 3's infrastructure, pinned without standing up Pulumi. The resources
 * themselves run through the PR's `pulumi preview`; what a unit test can
 * usefully hold is the set of literals that other files depend on and the
 * grants that are too easy to widen by accident.
 *
 * The two directions of the trust get their own tests because they are two
 * files that apply asynchronously: this stack creates the role the merged
 * `bifrost-vk-reader` trust names, and this role grants itself an
 * `sts:AssumeRole` on the reader. A drift either way is an `AccessDenied` at
 * the first membership read, not an apply-time error.
 */

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, "bifrost-vk-mint.ts"),
  "utf8",
);
const ECS_SOURCE = fs.readFileSync(path.resolve(__dirname, "ecs.ts"), "utf8");
const NETWORK_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "network.ts"),
  "utf8",
);
const INDEX_SOURCE = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf8");
const TEMPLATE = JSON.parse(readVkMintTemplate()) as {
  description?: string;
  [key: string]: unknown;
};

const policy = () =>
  vkMintExecutionPolicy({
    templateParameterArn: `arn:aws:ssm:us-west-2:${WORKBENCH_ACCOUNT_ID}:parameter${VK_MINT_TEMPLATE_PARAMETER_NAME}`,
    logGroupArn: `arn:aws:logs:us-west-2:${WORKBENCH_ACCOUNT_ID}:log-group:${VK_MINT_LOG_GROUP_NAME}`,
  });

describe("the execution role the merged reader trust depends on", () => {
  it("is named exactly bifrost-vk-mint, the literal step 2's trust names", () => {
    assert.equal(VK_MINT_ROLE_NAME, "bifrost-vk-mint");
    assert.equal(VK_MINT_FUNCTION_NAME, "bifrost-vk-mint");

    const trustedRoleArns = bifrostVkReaderTrust.Statement.flatMap((statement) =>
      (statement as { Condition?: { ArnEquals?: Record<string, string[]> } })
        .Condition?.ArnEquals?.["aws:PrincipalArn"] ?? [],
    );
    const expected = `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/${VK_MINT_ROLE_NAME}`;
    assert.ok(
      trustedRoleArns.includes(expected),
      `deploy/components/bifrost-vk-reader.ts does not trust ${expected}; the first AssumeRole would be an AccessDenied`,
    );
  });

  it("grants itself sts:AssumeRole on the reader role and nothing wider", () => {
    // The reader role is in the *management* account: it is created by
    // `deploy/`, whose stack is the management account, and the Identity Store
    // it reads lives there. A reader ARN in the workbench account does not
    // exist (step 2's trust runs the other way), so the account here is the
    // literal that makes the assume succeed.
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
    assert.equal(vkMintEnvironment().READER_SESSION_NAME, VK_READER_SESSION_NAME);
    // The environment is built from the imported constant, so changing the
    // session name in `deploy/components/bifrost-vk-reader.ts` changes it here.
    // An env value spelled as a string literal would pass the assertion above
    // only for as long as nobody edited either copy.
    assert.match(SOURCE, /READER_SESSION_NAME:\s*VK_READER_SESSION_NAME,/);
    assert.doesNotMatch(SOURCE, /READER_SESSION_NAME:\s*"bifrost-vk-reader"/);
  });
});

describe("the function, its URL and its network", () => {
  it("reaches the task by its private name on the gateway's port, not through the ALB", () => {
    const environment = vkMintEnvironment();
    assert.equal(
      environment.BIFROST_BASE_URL,
      `http://${BIFROST_DISCOVERY_DNS_NAME}:${BIFROST_PORT}`,
    );
    assert.equal(BIFROST_DISCOVERY_DNS_NAME, "bifrost.workbench.local");
    assert.equal(BIFROST_PORT, 8080);
    assert.doesNotMatch(environment.BIFROST_BASE_URL, /goodparty\.org/);
  });

  it("has an AWS_IAM Function URL, so the caller's identity is SigV4-verified", () => {
    assert.match(SOURCE, /authorizationType:\s*"AWS_IAM"/);
    assert.doesNotMatch(SOURCE, /authorizationType:\s*"NONE"/);
    // No resource policy: with AWS_IAM the caller's own identity policy is the
    // grant (step 4), and a `lambda:Permission` here would be a second door.
    assert.doesNotMatch(SOURCE, /new aws\.lambda\.Permission\(/);
  });

  it("is attached to the gateway's private subnets with its own security group", () => {
    assert.match(SOURCE, /subnetIds:\s*network\.privateSubnetIds/);
    assert.match(SOURCE, /securityGroupIds:\s*\[securityGroup\.id\]/);
    assert.match(SOURCE, /name:\s*"bifrost-vk-mint",/);
  });

  it("adds the 8080 ingress rule to the task security group, from its own group only", () => {
    const ingress = /new aws\.vpc\.SecurityGroupIngressRule\(\s*"bifrostTaskIngressVkMint",([\s\S]*?)\{ provider \}/.exec(
      SOURCE,
    );
    assert.ok(ingress, "no ingress rule on the task's group");
    const body = ingress[1];
    assert.match(body, /securityGroupId:\s*network\.taskSecurityGroup\.id/);
    assert.match(body, /fromPort:\s*BIFROST_PORT/);
    assert.match(body, /toPort:\s*BIFROST_PORT/);
    assert.match(body, /referencedSecurityGroupId:\s*securityGroup\.id/);
    // A CIDR would admit more than this function; the task group's invariant
    // is that every rule names a group.
    assert.doesNotMatch(body, /cidrIpv4/);

    // And the task group's own description is deliberately unchanged. It is
    // ForceNew: editing the string replaces the group and, with it, every rule
    // that references it (the database's ingress, both ALB egress rules, the
    // two existing ingress rules) — a gateway outage for a sentence. The
    // exception is documented where the rule is, and the rule's own
    // description says so.
    assert.match(NETWORK_SOURCE, /Bifrost gateway Fargate task: 8080 \(Bifrost\) and 4180 \(oauth2-proxy\) from the ALB only\./);
    assert.match(NETWORK_SOURCE, /The exception is 8080 from the vk-mint Lambda's own group/);
  });

  it("is wired into the stack, and the ECS service registers itself for discovery", () => {
    assert.match(INDEX_SOURCE, /createBifrostVkMint\(\{\s*provider,\s*network,\s*discovery\s*\}\)/);
    assert.match(INDEX_SOURCE, /createBifrostDiscovery\(\{\s*provider,\s*vpcId:\s*network\.vpc\.id\s*\}\)/);
    assert.match(ECS_SOURCE, /serviceRegistries:\s*\{\s*registryArn:\s*discovery\.service\.arn\s*\}/);
  });
});

describe("the template, the secret and the logs", () => {
  it("stores the committed template as an SSM String parameter", () => {
    assert.equal(VK_MINT_TEMPLATE_PARAMETER_NAME, "/bifrost/vk-mint-template");
    assert.equal(vkMintEnvironment().TEMPLATE_PARAMETER_NAME, VK_MINT_TEMPLATE_PARAMETER_NAME);
    assert.match(SOURCE, /name:\s*VK_MINT_TEMPLATE_PARAMETER_NAME,\s*type:\s*"String",\s*value:\s*readVkMintTemplate\(\)/);
    // The stored bytes are the reviewed file, marker included, so a mint
    // creates exactly the shape step 1 pinned.
    assert.equal(
      (TEMPLATE.description ?? "").startsWith(VK_DESCRIPTION_MARKER),
      true,
    );
  });

  it("reads the gateway's setup token, and no other secret (decision 3)", () => {
    // The container is `ecs.ts`'s name for the gateway's own secret — the one
    // the task definition injects from — so the Lambdas and the task cannot
    // disagree about where the token lives. `bifrost/vk-mint` no longer exists
    // in the design: it held the same value, was never filled on a first apply,
    // and made the first mint fail after a green deploy.
    assert.equal(GATEWAY_SECRET_NAME, "bifrost/gateway");
    assert.equal(SETUP_TOKEN_SECRET_NAME, GATEWAY_SECRET_NAME);
    assert.equal(vkMintEnvironment().SETUP_TOKEN_SECRET_NAME, GATEWAY_SECRET_NAME);
    assert.equal(SETUP_TOKEN_SECRET_JSON_KEY, "BIFROST_SETUP_TOKEN");

    const secret = policy().Statement.find((s) => s.Sid === "ReadSetupToken");
    assert.ok(secret, "no ReadSetupToken statement");
    assert.deepEqual(secret.Action, ["secretsmanager:GetSecretValue"]);
    assert.deepEqual(secret.Resource, [secretArnPattern(GATEWAY_SECRET_NAME)]);

    // Nothing else. The cost decision 3 accepts is that this grant reaches the
    // encryption key and the Fireworks key as well; what it must not do is
    // reach a second container, a second ARN or a wildcard.
    const secretResources = policy()
      .Statement.flatMap((s) => s.Resource)
      .filter((r) => r.includes(":secret:"));
    assert.deepEqual(secretResources, [secretArnPattern(GATEWAY_SECRET_NAME)]);
    assert.ok(!secretResources.some((r) => r.endsWith(":*")));
    // One constant, no second literal: the source names the secret through
    // `GATEWAY_SECRET_NAME` and the old `VK_MINT_SECRET_*` spelling is gone.
    assert.doesNotMatch(SOURCE, /VK_MINT_SECRET/);
    assert.doesNotMatch(SOURCE, /["']bifrost\/(gateway|vk-mint)["']/);
  });

  it("holds the token in the secret, never in the function's environment", () => {
    const environment = vkMintEnvironment();
    assert.deepEqual(Object.keys(environment).sort(), [
      "BIFROST_BASE_URL",
      "READER_ROLE_ARN",
      "READER_SESSION_NAME",
      "SETUP_TOKEN_SECRET_JSON_KEY",
      "SETUP_TOKEN_SECRET_NAME",
      "TEMPLATE_PARAMETER_NAME",
    ]);
    assert.ok(!Object.values(environment).some((value) => /token-[a-z0-9]/i.test(value)));
  });

  it("grants no identitystore action, no CreateLogGroup, no KMS and no SSM write", () => {
    const actions = policy().Statement.flatMap((s) => s.Action);
    assert.deepEqual(actions.sort(), [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "secretsmanager:GetSecretValue",
      "ssm:GetParameter",
      "sts:AssumeRole",
    ]);
    assert.ok(!actions.some((action) => action.startsWith("identitystore:")));
    assert.ok(!actions.includes("kms:Decrypt"));
    assert.ok(!actions.includes("logs:CreateLogGroup"));
  });

  it("writes to its own log group, with retention set", () => {
    assert.equal(VK_MINT_LOG_GROUP_NAME, "/aws/lambda/bifrost-vk-mint");
    assert.equal(VK_MINT_LOG_RETENTION_DAYS, 30);
    const logs = policy().Statement.find((s) => s.Sid === "WriteOwnLogs");
    assert.ok(logs);
    assert.deepEqual(logs.Resource, [
      `arn:aws:logs:us-west-2:${WORKBENCH_ACCOUNT_ID}:log-group:${VK_MINT_LOG_GROUP_NAME}:*`,
    ]);
  });
});
