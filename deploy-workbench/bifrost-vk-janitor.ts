import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as esbuild from "esbuild";
import * as path from "node:path";

import { VK_READER_SESSION_NAME } from "../deploy/components/bifrost-vk-reader";
import {
  LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN,
  VK_READER_ROLE_ARN,
  VK_MINT_SECRET_JSON_KEY,
  VK_MINT_SECRET_NAME,
  type PolicyDocument,
} from "./bifrost-vk-mint";
import { BIFROST_DISCOVERY_DNS_NAME } from "./discovery";
import { secretArnPattern } from "./ecs";
import {
  BIFROST_PORT,
  VPC_CIDR,
  type createWorkbenchNetwork,
} from "./network";

/**
 * The Bifrost virtual-key janitor: step 5 of `docs/bifrost-virtual-keys.md`.
 *
 * The reconcile loop of decision 6, as infrastructure: one Lambda on an hourly
 * EventBridge rule that makes the set of Lambda-managed keys follow the
 * `Engineers` group. It lists the group, lists the gateway's keys, keeps the
 * ones carrying the description marker, resolves each owner's email to a user
 * id, and deactivates the keys whose owner is no longer a member. The
 * behaviour is `bifrost/vk-janitor-core.ts`; this module owns what it runs as
 * and what it may reach.
 *
 * What it deliberately does not own:
 *
 * - **The marker.** `bifrost/vk-marker.ts` is the one constant both Lambdas
 *   import (decision 5). There is no second copy of the string here.
 * - **The read-only directory role.** Step 2, `deploy/components/bifrost-vk-reader.ts`,
 *   already trusts `arn:aws:iam::<workbench>:role/bifrost-vk-janitor` by name;
 *   the role below is that literal, and the test reads the trust to prove the
 *   two have not drifted.
 * - **The setup-token secret.** Decision 6 says the janitor "reads the same
 *   secret" as the mint, so `VK_MINT_SECRET_NAME` is imported rather than
 *   retyped. One container, two readers, and the same rule about never logging
 *   a body.
 * - **The task's 8080 ingress.** `bifrost-vk-mint.ts` adds the first exception
 *   to `network.ts`'s "from the ALB only" invariant; this module adds the
 *   second, from its own group, because it is the second caller of the same
 *   VPC-internal admin API (decision 3 and 6).
 *
 * ## Why a plain EventBridge rule and not Scheduler
 *
 * The same reasoning as `deploy-infrastructure/group-sync-lambda.ts`: a fixed
 * interval with no per-invocation state and no per-schedule payload worth
 * carrying. A schedule group and a DLQ would be more machinery around one
 * `rate()` expression than the job is.
 *
 * ## Why the hourly interval is a named constant
 *
 * Open item 3: hourly is the design's choice, not a measured one. Decision 6
 * puts the revocation bound at "about an hour and a quarter of the person
 * leaving the Workspace group", counting the fifteen-minute Workspace →
 * Identity Center sync, and argues the interval from consequences rather than
 * measurement: an hour because a person who has left is not a five-minute
 * emergency, and a job that runs often enough to page on is a job that pages
 * for a bad reason. The constant keeps the number reviewable and gives a later
 * change one place to argue with; the test pins the expression the rule
 * actually uses to it.
 */

/**
 * The function and the role share the name on purpose. The role name is not a
 * choice: `deploy/components/bifrost-vk-reader.ts` (step 2, merged) trusts
 * exactly `arn:aws:iam::024901689212:role/bifrost-vk-janitor`, so renaming this
 * string is an `AccessDenied` on every directory read rather than an
 * apply-time error.
 */
export const VK_JANITOR_NAME = "bifrost-vk-janitor";
export const VK_JANITOR_FUNCTION_NAME = VK_JANITOR_NAME;
export const VK_JANITOR_ROLE_NAME = VK_JANITOR_NAME;

/** Named beside the gateway's and the mint's own groups, from the function name. */
export const VK_JANITOR_LOG_GROUP_NAME = `/aws/lambda/${VK_JANITOR_FUNCTION_NAME}`;

/**
 * A quarter, not the mint's thirty days: this group is the audit trail of who
 * was revoked and when, and decision 6's retention window is ninety days. A
 * record of a deactivation that has already been deleted is not an audit
 * trail, so the log outlives the key's longest possible life after
 * deactivation.
 */
export const VK_JANITOR_LOG_RETENTION_DAYS = 90;

/**
 * The hourly interval (open item 3), with decision 6's bounded-delay reasoning
 * above. Kept a constant so the schedule expression below cannot drift from the
 * documented number.
 */
export const VK_JANITOR_INTERVAL_MINUTES = 60;
export const VK_JANITOR_SCHEDULE_EXPRESSION = `rate(${VK_JANITOR_INTERVAL_MINUTES} minutes)`;

/**
 * Well below the interval, so two runs do not overlap by design. The work is a
 * group read, a paged key list and at most one `PUT` per managed key; two
 * minutes is far more than that needs, and the ordering is the point.
 */
export const VK_JANITOR_TIMEOUT_SECONDS = 120;
export const VK_JANITOR_MEMORY_MB = 256;

if (VK_JANITOR_TIMEOUT_SECONDS >= VK_JANITOR_INTERVAL_MINUTES * 60) {
  // A run that outlives its interval would overlap the next one, and
  // `reservedConcurrentExecutions: 1` would then start dropping invocations.
  // Fail at load, where a test catches it.
  throw new Error(
    `janitor timeout ${VK_JANITOR_TIMEOUT_SECONDS}s must be below the interval ${VK_JANITOR_INTERVAL_MINUTES}m`,
  );
}

/** The one run at a time the reconcile needs. */
export const VK_JANITOR_RESERVED_CONCURRENCY = 1;

/**
 * The non-secret configuration: the gateway's private address, the shared
 * setup-token secret's name and JSON key, and the reader role's ARN and session
 * name. The token itself is not here and never will be, because a Lambda
 * environment variable is readable by anything that can call
 * `GetFunctionConfiguration`.
 */
export const vkJanitorEnvironment = (): Record<string, string> => ({
  BIFROST_BASE_URL: `http://${BIFROST_DISCOVERY_DNS_NAME}:${BIFROST_PORT}`,
  SETUP_TOKEN_SECRET_NAME: VK_MINT_SECRET_NAME,
  SETUP_TOKEN_SECRET_JSON_KEY: VK_MINT_SECRET_JSON_KEY,
  READER_ROLE_ARN: VK_READER_ROLE_ARN,
  READER_SESSION_NAME: VK_READER_SESSION_NAME,
});

/** Lambda's own trust. Nothing else may assume this role. */
export const vkJanitorTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
} as const;

/**
 * The execution role's whole grant: assume the one reader role, read the one
 * setup-token secret, write its own log streams.
 *
 * Deliberately absent, and asserted by `bifrost-vk-janitor.test.ts`:
 *
 * - every `identitystore:*` action — the directory reads go through
 *   `bifrost-vk-reader`, whose inline policy is the scope;
 * - `ssm:GetParameter` — the janitor reads no template; the shape of a key is
 *   the mint's business;
 * - `kms:Decrypt` — the secret uses the account's `aws/secretsmanager` key,
 *   whose policy admits the account, the same reasoning the mint's and
 *   group-sync's roles record;
 * - `logs:CreateLogGroup` — Pulumi creates the group;
 * - every write to the directory or to anything but its own logs. The only
 *   mutating call the job makes is the gateway `PUT`, which is authorised by
 *   the setup token, not by IAM.
 */
export const vkJanitorExecutionPolicy = (args: {
  logGroupArn: string;
}): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AssumeVkReader",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      // Exactly one ARN. The reader role's own policy is the scoping that
      // matters; this is the only door to it, and it is the same door the mint
      // has.
      Resource: [VK_READER_ROLE_ARN],
    },
    {
      Sid: "ReadSetupToken",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      // The same container the mint reads (decision 6), named from the mint's
      // constant rather than a second literal. Secrets Manager appends six
      // random characters to the ARN, so the name needs a wildcard.
      Resource: [secretArnPattern(VK_MINT_SECRET_NAME)],
    },
    {
      Sid: "WriteOwnLogs",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: [`${args.logGroupArn}:*`],
    },
  ],
});

/**
 * Bundles the handler into a single-file archive in the Pulumi program, the
 * same way `bifrost-vk-mint.ts` and `group-sync-lambda.ts` do: the deploy
 * workflow runs no build step, and the archive's hash follows the source, so a
 * handler change shows up in `pulumi preview` instead of waiting for someone to
 * run `npm run build`.
 */
export const buildVkJanitorCode = (): pulumi.asset.AssetArchive => {
  const result = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, "bifrost/vk-janitor-handler.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error("esbuild produced no output for the vk-janitor handler");
  }
  return new pulumi.asset.AssetArchive({
    "handler.js": new pulumi.asset.StringAsset(output.text),
  });
};

export const createBifrostVkJanitor = (args: {
  provider: aws.Provider;
  network: ReturnType<typeof createWorkbenchNetwork>;
}) => {
  const { provider, network } = args;
  const tags = { Name: VK_JANITOR_NAME, Project: "bifrost-virtual-keys" };

  // The function's own group, created bare with each rule as its own resource,
  // the same shape as the mint's and `network.ts`'s. No ingress: nothing calls
  // the janitor over the network, only EventBridge invokes it.
  const securityGroup = new aws.ec2.SecurityGroup(
    "bifrostVkJanitorSecurityGroup",
    {
      name: "bifrost-vk-janitor",
      description:
        "Bifrost vk-janitor Lambda: 8080 to the task, 443 out for AWS APIs, DNS to the VPC resolver. No ingress rules.",
      vpcId: network.vpc.id,
      tags,
    },
    { provider },
  );

  // The second exception to the task group's "from the ALB only" invariant,
  // after the mint's. `bifrost-vk-mint.ts` carries the reasoning; this rule is
  // the same shape and the same justification, because decision 6 makes the
  // janitor the second caller of the VPC-internal admin API. Referenced by
  // group, so it admits this function and nothing else in the VPC.
  new aws.vpc.SecurityGroupIngressRule(
    "bifrostTaskIngressVkJanitor",
    {
      securityGroupId: network.taskSecurityGroup.id,
      description:
        "bifrost admin API from the vk-janitor Lambda (step 5 of docs/bifrost-virtual-keys.md); the second exception to 'from the ALB only', because /api through the ALB is behind Google SSO",
      ipProtocol: "tcp",
      fromPort: BIFROST_PORT,
      toPort: BIFROST_PORT,
      referencedSecurityGroupId: securityGroup.id,
    },
    { provider },
  );

  // Egress 8080 to the task only: the list and the one update. The task's group
  // admits this function's group on 8080 (the ingress rule above).
  new aws.vpc.SecurityGroupEgressRule(
    "bifrostVkJanitorEgressBifrost",
    {
      securityGroupId: securityGroup.id,
      description: "bifrost on the task",
      ipProtocol: "tcp",
      fromPort: BIFROST_PORT,
      toPort: BIFROST_PORT,
      referencedSecurityGroupId: network.taskSecurityGroup.id,
    },
    { provider },
  );

  // 443 out through the NAT for STS, the Identity Store, Secrets Manager and
  // CloudWatch Logs. All of those are public AWS endpoints, so a CIDR is the
  // only honest scope; the mint's and the task's own groups make the same
  // trade.
  new aws.vpc.SecurityGroupEgressRule(
    "bifrostVkJanitorEgressHttps",
    {
      securityGroupId: securityGroup.id,
      description:
        "AWS APIs via the NAT: STS, Identity Store, Secrets Manager, CloudWatch Logs",
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      cidrIpv4: "0.0.0.0/0",
    },
    { provider },
  );

  // DNS to the VPC resolver, which is what resolves `bifrost.workbench.local`
  // and every AWS endpoint. Both protocols because a large answer can come back
  // over TCP.
  for (const protocol of ["udp", "tcp"] as const) {
    new aws.vpc.SecurityGroupEgressRule(
      `bifrostVkJanitorEgressDns${protocol.toUpperCase()}`,
      {
        securityGroupId: securityGroup.id,
        description: `DNS to the VPC resolver (${protocol})`,
        ipProtocol: protocol,
        fromPort: 53,
        toPort: 53,
        cidrIpv4: VPC_CIDR,
      },
      { provider },
    );
  }

  const logGroup = new aws.cloudwatch.LogGroup(
    "bifrostVkJanitorLogGroup",
    {
      name: VK_JANITOR_LOG_GROUP_NAME,
      retentionInDays: VK_JANITOR_LOG_RETENTION_DAYS,
      tags,
    },
    { provider },
  );

  const role = new aws.iam.Role(
    "bifrostVkJanitorRole",
    {
      name: VK_JANITOR_ROLE_NAME,
      description:
        "Bifrost vk-janitor Lambda: sts:AssumeRole on the management-account bifrost-vk-reader, read the shared setup token, write its own logs. No identitystore action, no SSM template, no gateway secrets.",
      assumeRolePolicy: JSON.stringify(vkJanitorTrust),
      managedPolicyArns: [LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN],
      tags,
    },
    { provider },
  );

  const rolePolicy = new aws.iam.RolePolicy(
    "bifrostVkJanitorRolePolicy",
    {
      name: VK_JANITOR_NAME,
      role: role.name,
      policy: logGroup.arn.apply((logGroupArn) =>
        JSON.stringify(vkJanitorExecutionPolicy({ logGroupArn })),
      ),
    },
    { provider },
  );

  const fn = new aws.lambda.Function(
    "bifrostVkJanitor",
    {
      name: VK_JANITOR_FUNCTION_NAME,
      description:
        "Deactivates Bifrost virtual keys whose owner has left the Engineers group, hourly (step 5 of docs/bifrost-virtual-keys.md).",
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: buildVkJanitorCode(),
      timeout: VK_JANITOR_TIMEOUT_SECONDS,
      memorySize: VK_JANITOR_MEMORY_MB,
      // A reconcile that reads, classifies and then writes must not have two
      // runs interleaved: the second could re-read the first's partial state,
      // and each would try to set the retention clock on the same key. The cap
      // is the simplest correct serialization, and the interval and timeout are
      // set so runs do not overlap by design either.
      reservedConcurrentExecutions: VK_JANITOR_RESERVED_CONCURRENCY,
      // The same private subnets the gateway runs in, for the same reason as
      // the mint: the admin API is only reachable on 8080 from inside the VPC,
      // and the subnets' NAT gives the function STS, Secrets Manager and
      // CloudWatch.
      vpcConfig: {
        subnetIds: network.privateSubnetIds,
        securityGroupIds: [securityGroup.id],
      },
      environment: { variables: vkJanitorEnvironment() },
      tags,
    },
    // The log group and the inline policy must exist before the first
    // invocation: without the group the function logs to an implicit one, and
    // without the policy the missing grant is invisible until a run fails.
    { provider, dependsOn: [logGroup, rolePolicy] },
  );

  // The schedule. A plain EventBridge rule rather than EventBridge Scheduler,
  // for the reason in the header.
  const rule = new aws.cloudwatch.EventRule(
    "bifrostVkJanitorSchedule",
    {
      name: VK_JANITOR_NAME,
      description: `Reconciles Bifrost virtual keys against the Engineers group every ${VK_JANITOR_INTERVAL_MINUTES} minutes.`,
      scheduleExpression: VK_JANITOR_SCHEDULE_EXPRESSION,
      tags,
    },
    { provider },
  );

  new aws.cloudwatch.EventTarget(
    "bifrostVkJanitorTarget",
    {
      rule: rule.name,
      arn: fn.arn,
      // The scheduled shape the handler recognises. The handler does not read a
      // payload today; the literal is the contract between the rule and the
      // function, the same way group-sync's is.
      input: JSON.stringify({ action: "reconcile" }),
    },
    { provider },
  );

  // EventBridge needs explicit permission to invoke the function.
  new aws.lambda.Permission(
    "bifrostVkJanitorSchedulePermission",
    {
      action: "lambda:InvokeFunction",
      function: fn.name,
      principal: "events.amazonaws.com",
      sourceArn: rule.arn,
    },
    { provider },
  );

  return {
    function: fn,
    role,
    rolePolicy,
    securityGroup,
    logGroup,
    rule,
  };
};
