import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as esbuild from "esbuild";
import * as path from "node:path";

import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import { VK_READER_SESSION_NAME } from "../deploy/components/bifrost-vk-reader";
import {
  GOVERNANCE_OVERRIDES_PARAMETER_NAME,
  RECONCILER_PARAMETER_NAMES,
  VK_MINT_TEMPLATE_PARAMETER_NAME,
} from "./governance-parameters";
import {
  LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN,
  VK_READER_ROLE_ARN,
  SETUP_TOKEN_SECRET_JSON_KEY,
  SETUP_TOKEN_SECRET_NAME,
  type PolicyDocument,
} from "./bifrost-vk-mint";
import { BIFROST_CONFIG_PARAMETER_NAME, secretArnPattern } from "./ecs";
import { BIFROST_DISCOVERY_DNS_NAME } from "./discovery";
import {
  VK_JANITOR_INTERVAL_MINUTES,
  VK_JANITOR_RETRY_WINDOW_SECONDS,
  VK_JANITOR_SCHEDULE_EXPRESSION,
  VK_JANITOR_TIMEOUT_SECONDS,
} from "./bifrost/vk-janitor-contract";
import {
  BIFROST_PORT,
  REGION,
  VPC_CIDR,
  type createWorkbenchNetwork,
} from "./network";

/**
 * The timing budget, re-exported so a caller of this module (and
 * `bifrost-vk-janitor.test.ts`) keeps finding it here. The numbers and both of
 * their guards are in `bifrost/vk-janitor-contract.ts`, which the deploy's poll
 * reads too.
 */
export {
  VK_JANITOR_INTERVAL_MINUTES,
  VK_JANITOR_SCHEDULE_EXPRESSION,
  VK_JANITOR_TIMEOUT_SECONDS,
  VK_JANITOR_RETRY_WINDOW_SECONDS,
};

/**
 * The Bifrost virtual-key janitor: step 5 of `docs/bifrost-virtual-keys.md`,
 * and since step 3 of `docs/bifrost-reconciler.md` the reconciler's function too.
 *
 * Two jobs over one function and one set of reads, which is decision 3 of the
 * reconciler plan: a second Lambda would have duplicated this VPC attachment,
 * this setup-token read, this directory hop and these tests.
 *
 * 1. **Revocation**, step 5's loop: one Lambda on an EventBridge rule that makes
 *    the set of Lambda-managed keys follow the `Engineers` group. It lists the
 *    group, lists the gateway's keys, keeps the ones carrying the description
 *    marker, resolves each owner's email to a user id, and deactivates the keys
 *    whose owner is no longer a member.
 * 2. **Governance convergence**, step 3's loop: the same function reads the two
 *    governance documents, composes the desired state per key, diffs it against
 *    what the gateway reports, and `PUT`s only the keys that differ.
 *
 * The behaviour is `bifrost/vk-janitor-core.ts`; this module owns what it runs
 * as and what it may reach.
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
 *   secret" as the mint, so `SETUP_TOKEN_SECRET_NAME` is imported rather than
 *   retyped. It is the gateway's own container (decision 3), one name shared by
 *   the task definition, the mint and this function; two readers of one
 *   container, and the same rule about never logging a body.
 * - **The governance documents themselves.** Both parameters are step 2's
 *   (`governance-parameters.ts` and `ecs.ts`); this module names them and grants
 *   itself `ssm:GetParameter` on them. A second writer would be a second source
 *   of truth.
 * - **The task's 8080 ingress.** `bifrost-vk-mint.ts` adds the first exception
 *   to `network.ts`'s "from the ALB only" invariant; this module adds the
 *   second, from its own group, because it is the second caller of the same
 *   VPC-internal admin API (decision 3 and 6).
 *
 * ## What the two triggers are (step 4, now built)
 *
 * Step 4 of the reconciler plan adds a `rate(5 minutes)` schedule and the deploy
 * workflow's `RequestResponse` invoke with a poll. Both are built: the schedule
 * is the same `EventRule` this file already creates, moved to a new expression
 * (`bifrost/vk-janitor-contract.ts`), and the invoke is a same-account IAM call
 * that needs no resource-based policy on the function.
 *
 * **One rule, deliberately, and not two.** Splitting revocation's cadence from
 * convergence's would mean a second `aws.lambda.Permission`, because each one
 * grants a single `sourceArn`. Two permissions must then have distinct
 * `statementId`s: Lambda refuses a duplicate id on one function's resource
 * policy (`AddPermission`'s `ResourceConflictException`, a `409`) and the apply
 * fails with "The statement id already exists". This file gives no permission a
 * literal id, so Pulumi derives a distinct one per resource and a copy cannot
 * collide; `bifrost-vk-janitor.test.ts` pins one rule and one permission, and
 * fails if two explicit statement ids here ever match. There is no second rule because there is no second cadence to give
 * it: the reconciler's bound is five minutes (decision 4) and the argument for
 * an hour was about paging, which the alarm (step 6) answers better than a
 * slower rule does.
 *
 * ## Why a plain EventBridge rule and not Scheduler
 *
 * The same reasoning as `deploy-infrastructure/group-sync-lambda.ts`: a fixed
 * interval with no per-invocation state and no per-schedule payload worth
 * carrying. A schedule group and a DLQ would be more machinery around one
 * `rate()` expression than the job is.
 *
 * ## Why the interval, and where it is argued with
 *
 * Open item 3 of `bifrost-virtual-keys.md`: hourly is the design's choice, not a
 * measured one, argued from the revocation bound rather than from a measurement.
 * `docs/bifrost-reconciler.md` decision 4 changes it to five minutes, for the
 * reason a convergence loop needs: an override should land without a deploy.
 *
 * The number and both guards on it (below the interval, and above it for the
 * deploy's retry window) live in `bifrost/vk-janitor-contract.ts`, which is a
 * plain module rather than part of this Pulumi program so
 * `scripts/verify-convergence.ts` can read the timeout it has to outlast. They
 * are re-exported below, so this module is still the one place a reader of the
 * stack meets them.
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
 * The function's shell, which is not part of the timing budget: memory is a
 * property of what the loop holds in one request, not of when it runs.
 */
export const VK_JANITOR_MEMORY_MB = 256;

/**
 * The one run at a time the reconcile needs. It lives here rather than in the
 * timing module because it is a property of this function's wiring rather than
 * a number the deploy's poll reads; the throttle it causes is that module's
 * subject, which is why the two guards about it are there.
 */
export const VK_JANITOR_RESERVED_CONCURRENCY = 1;

/**
 * What the function is, in the words AWS stores on it and the console shows.
 *
 * Exported so `bifrost-vk-janitor.test.ts` asserts the *interpolated* string
 * rather than the source text of it, which is what the apply sends. That check
 * exists because this one did not: the description below used to be 276
 * characters, AWS's limit on a Lambda function description is 256, and the
 * workbench deploy found out (`UpdateFunctionConfiguration`,
 * `ValidationException`, on the merge of #453) *after* the same apply had
 * already moved the schedule to `rate(5 minutes)`. A preview cannot see a
 * length constraint either, so nothing short of the unit suite can.
 *
 * Accuracy is the other half of the constraint, and it is why the text is
 * trimmed to the vocabulary that carries the behaviour rather than to
 * initials: every job the function does is still named here, with the two
 * plan steps it comes from, because a description that fits by having stopped
 * describing something would be the wrong fix.
 */
export const VK_JANITOR_FUNCTION_DESCRIPTION = `Deactivates Bifrost virtual keys whose owner has left the Engineers group and converges their governance and gateway live config, every ${VK_JANITOR_INTERVAL_MINUTES} minutes and on every workbench deploy (docs/bifrost-virtual-keys.md step 5, docs/bifrost-reconciler.md steps 3-4).`;

/**
 * The rule's own description, derived from the same interval so the two cannot
 * disagree about the cadence. It is a separate string because it describes the
 * trigger rather than the work, and it is exported for the same reason as the
 * one above: the length guard has to see the interpolated value.
 */
export const VK_JANITOR_RULE_DESCRIPTION = `Reconciles Bifrost virtual keys and the gateway's live config against the committed state every ${VK_JANITOR_INTERVAL_MINUTES} minutes.`;

/**
 * The execution role's description, which is a separate string from the
 * function's because it is a separate resource with a separate (much larger)
 * limit. It is exported only so the length guard sees the value the apply
 * sends; nothing reads it.
 */
export const VK_JANITOR_ROLE_DESCRIPTION =
  "Bifrost reconcile loop: deactivates virtual keys whose owner has left the Engineers group and converges every managed key to the committed governance (steps 5 of docs/bifrost-virtual-keys.md and 3 of docs/bifrost-reconciler.md).";

/**
 * The address the failure alarm emails. The same group alias the spend alerts
 * use (`index.ts`, `SPEND_ALERT_EMAIL`), because it is the same operator
 * question — "something in the workbench account is wrong" — and a second alias
 * would split the answer in two.
 */
export const VK_JANITOR_ALERT_EMAIL = "aws-workbench@goodparty.org";

/**
 * How many consecutive failing runs mean "stuck". Three, per the plan's step 6
 * and decision 15, at a five-minute cadence: fifteen minutes of a reconciler
 * that cannot converge, with two more runs already observed than a single
 * transient needs.
 *
 * Consecutive rather than a rate, deliberately. A rate statistic pages on a
 * burst and sleeps through a steady trickle, and a stuck reconciler is a
 * trickle: one failure every five minutes until someone acts. `Errors` summed
 * over three consecutive periods of one failure each is the metric that
 * describes that shape, and it does not fire on a single bad run.
 */
export const VK_JANITOR_ALARM_EVALUATION_PERIODS = 3;

/**
 * The alarm's own name and description, named from the function so the alarm,
 * the function and the runbook entry are one string a reader can search.
 */
export const VK_JANITOR_ALARM_NAME = `${VK_JANITOR_NAME}-not-converging`;
export const VK_JANITOR_ALARM_DESCRIPTION =
  `The Bifrost reconciler has failed ${VK_JANITOR_ALARM_EVALUATION_PERIODS} consecutive runs, so gateway config and virtual-key governance are drifting from the committed state. Answer: docs/runbooks.md, "The Bifrost reconciler is not converging".`;

/**
 * The non-secret configuration: the gateway's private address, the setup-token
 * container's name and JSON key, and the reader role's ARN and session name.
 * The token itself is not here and never will be, because a Lambda environment
 * variable is readable by anything that can call `GetFunctionConfiguration`.
 */
export const vkJanitorEnvironment = (): Record<string, string> => ({
  BIFROST_BASE_URL: `http://${BIFROST_DISCOVERY_DNS_NAME}:${BIFROST_PORT}`,
  SETUP_TOKEN_SECRET_NAME,
  SETUP_TOKEN_SECRET_JSON_KEY,
  READER_ROLE_ARN: VK_READER_ROLE_ARN,
  READER_SESSION_NAME: VK_READER_SESSION_NAME,
  // The governance desired state, from the two parameters step 2 publishes, and
  // the gateway file step 4's config half converges the live subset of. Names,
  // not values: a parameter value in an environment variable would be readable
  // by anything that can call `GetFunctionConfiguration`, which is the same
  // reason the setup token is not here either.
  TEMPLATE_PARAMETER_NAME: VK_MINT_TEMPLATE_PARAMETER_NAME,
  OVERRIDES_PARAMETER_NAME: GOVERNANCE_OVERRIDES_PARAMETER_NAME,
  CONFIG_PARAMETER_NAME: BIFROST_CONFIG_PARAMETER_NAME,
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
 * The three SSM parameters the reconciler's desired state lives in, in the
 * account's partition.
 *
 * `/bifrost/config` is here because the plan's step 3 names it: the grant is one
 * policy on three parameters, and issuing it in one place is the point. The
 * governance loop reads the two governance documents; `/bifrost/config` is step
 * 4's half, read by the config loop the deploy's invoke reaches and by every
 * scheduled tick after it. Granting it in step 3 and exercising it in step 4 is
 * deliberate: a reconciler that has to grow a permission after the fact is a
 * reconciler whose first real run is an `AccessDenied`. It is read-only, on
 * three named parameters, with no wildcard.
 */
export const RECONCILER_PARAMETERS = [
  BIFROST_CONFIG_PARAMETER_NAME,
  ...RECONCILER_PARAMETER_NAMES,
] as const;

/**
 * The parameter ARNs, quoted by name rather than by the Pulumi resource.
 *
 * A name-derived ARN so this policy stays a pure function a test can read, the
 * same way the secret grant is. `/bifrost/config`'s own resource is created by
 * `ecs.ts`, and the names are constants shared with the parameters themselves,
 * so the grant and the resources cannot disagree about which parameter is which.
 * The account is the workbench one, named and not a wildcard: these three
 * parameters are this account's.
 */
export const reconcilerParameterArns = (args: { region: string }): string[] =>
  RECONCILER_PARAMETERS.map(
    (name) =>
      `arn:aws:ssm:${args.region}:${WORKBENCH_ACCOUNT_ID}:parameter${name}`,
  );

/**
 * The execution role's whole grant: assume the one reader role, read the one
 * setup-token secret, read the three reconciler parameters, write its own log
 * streams.
 *
 * Deliberately absent, and asserted by `bifrost-vk-janitor.test.ts`:
 *
 * - every `identitystore:*` action — the directory reads go through
 *   `bifrost-vk-reader`, whose inline policy is the scope;
 * - `ssm:GetParameters`, `ssm:GetParametersByPath` and every write — the three
 *   parameters are known by name, so the plural read and the path walk would
 *   reach more than this job has any use for, and nothing in this repo writes a
 *   parameter except Pulumi;
 * - `kms:Decrypt` — the secret uses the account's `aws/secretsmanager` key,
 *   whose policy admits the account, the same reasoning the mint's and
 *   group-sync's roles record;
 * - `logs:CreateLogGroup` — Pulumi creates the group;
 * - every write to the directory or to anything but its own logs. The only
 *   mutating call the job makes is the gateway `PUT`, which is authorised by
 *   the setup token, not by IAM.
 *
 * The `ssm:GetParameter` grant reverses what this file said before step 3 of
 * `docs/bifrost-reconciler.md`, and the reason is the reason the function
 * changed: it was a revocation sweep that needed no desired state, and it is now
 * a convergence loop that has to read the state it is converging to. The plan
 * names those two tests ("the janitor's IAM changes and two of its tests
 * reverse") and they are rewritten in the same PR as the grant.
 */
export const vkJanitorExecutionPolicy = (args: {
  logGroupArn: string;
  region: string;
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
      // constant rather than a second literal: it is the gateway's own
      // container (decision 3). Secrets Manager appends six random characters
      // to the ARN, so the name needs a wildcard.
      Resource: [secretArnPattern(SETUP_TOKEN_SECRET_NAME)],
    },
    {
      Sid: "ReadReconcilerParameters",
      Effect: "Allow",
      Action: ["ssm:GetParameter"],
      // Three names, no wildcard on the name itself, so the grant reaches
      // exactly the parameters the desired state is in.
      Resource: reconcilerParameterArns({ region: args.region }),
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
        "bifrost admin API from the vk-janitor Lambda (step 5 of docs/bifrost-virtual-keys.md); the second exception to the ALB-only rule, because /api through the ALB is behind Google SSO",
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
      description: VK_JANITOR_ROLE_DESCRIPTION,
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
        JSON.stringify(
          vkJanitorExecutionPolicy({ logGroupArn, region: REGION }),
        ),
      ),
    },
    { provider },
  );

  const fn = new aws.lambda.Function(
    "bifrostVkJanitor",
    {
      name: VK_JANITOR_FUNCTION_NAME,
      // Kept inside AWS's 256-character limit on a function description, and
      // guarded by length in `bifrost-vk-janitor.test.ts`: see the constant's
      // own comment for the apply that this limit failed on.
      description: VK_JANITOR_FUNCTION_DESCRIPTION,
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
  //
  // One rule, and it is the whole cadence: revocation and both convergence
  // halves run on the same five-minute tick (decision 4). A second rule would
  // need its own `aws.lambda.Permission` with a distinct `statementId` — see the
  // header and `bifrost-vk-janitor.test.ts` — and there is no cadence in this
  // design that wants one.
  const rule = new aws.cloudwatch.EventRule(
    "bifrostVkJanitorSchedule",
    {
      name: VK_JANITOR_NAME,
      description: VK_JANITOR_RULE_DESCRIPTION,
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
      // The scheduled shape the handler recognises. The handler reads `trigger`
      // and nothing else (`reconcilerTrigger`), so this literal and the deploy's
      // `{action, trigger: "deploy"}` are the contract between the two callers.
      input: JSON.stringify({ action: "reconcile", trigger: "schedule" }),
    },
    { provider },
  );

  // EventBridge needs explicit permission to invoke the function. One
  // permission per rule, and this is the only rule: the deploy's invoke is a
  // same-account IAM call authorised by the caller's own policy (the
  // `pulumi-deploy` role, which is AdministratorAccess), so it needs no
  // resource-based policy here at all. Adding one would be decoration.
  new aws.lambda.Permission(
    "bifrostVkJanitorSchedulePermission",
    {
      action: "lambda:InvokeFunction",
      function: fn.name,
      principal: "events.amazonaws.com",
      sourceArn: rule.arn,
      // No `statementId` here, deliberately. Pulumi derives one per resource
      // when it is not given, so two permissions cannot collide by accident; the
      // trap the plan records is the *literal* one, a second block copied from
      // this with the same id held over, which Lambda refuses with a 409
      // (`AddPermission`'s `ResourceConflictException`) and the apply reports as
      // "The statement id already exists". Naming this one now would replace a
      // working resource on the next apply for no functional gain, so the guard
      // is a test: `bifrost-vk-janitor.test.ts` pins one rule and one permission,
      // and fails if any two explicit statement ids in this file ever match.
    },
    { provider },
  );

  // Step 6: the failure alarm, and the wire that gets its message out.
  //
  // CloudWatch alarms cannot email directly. The account's spend alerts
  // (`index.ts`, step 13) use Budgets' own `subscriberEmailAddresses` field,
  // which a `MetricAlarm` has no equivalent of, so this is the account's first
  // alarm-to-email wire. It follows the infrastructure account's
  // `sheriff-lambda.ts` and `group-sync-lambda.ts`, which is the pattern that
  // already works here: a topic, an email subscription, a topic policy that
  // admits the CloudWatch principal, and the alarm publishing to it.
  //
  // The subscription stays unconfirmed until someone accepts the AWS email,
  // exactly as the sheriff's does. That is a manual step and the PR body says
  // so; an unconfirmed subscription means the alarm fires and nobody is told.
  const alertTopic = new aws.sns.Topic(
    "bifrostVkJanitorAlertTopic",
    {
      name: VK_JANITOR_ALARM_NAME,
      tags,
    },
    { provider },
  );

  new aws.sns.TopicSubscription(
    "bifrostVkJanitorAlertSubscription",
    {
      topic: alertTopic.arn,
      protocol: "email",
      endpoint: VK_JANITOR_ALERT_EMAIL,
    },
    { provider },
  );

  // CloudWatch publishes to the topic as the CloudWatch service principal,
  // which the default topic policy does not admit. The condition is the
  // account, not the alarm ARN: naming the alarm would make the topic policy
  // and the alarm depend on each other, and `sheriff-lambda.ts` records the
  // same reasoning.
  new aws.sns.TopicPolicy(
    "bifrostVkJanitorAlertTopicPolicy",
    {
      arn: alertTopic.arn,
      policy: alertTopic.arn.apply((topicArn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "CloudWatchAlarms",
              Effect: "Allow",
              Principal: { Service: "cloudwatch.amazonaws.com" },
              Action: "SNS:Publish",
              Resource: topicArn,
              Condition: {
                StringEquals: {
                  "aws:SourceAccount": WORKBENCH_ACCOUNT_ID,
                },
              },
            },
          ],
        }),
      ),
    },
    { provider },
  );

  // The function's own `Errors` metric, three consecutive periods of at least
  // one error. `Errors` is what Lambda increments when the handler rethrows,
  // and the handler rethrows a `JanitorFailure` on purpose for exactly this
  // counter (`bifrost/vk-janitor-handler.ts`: "rethrows, so the invocation
  // fails and step 6's alarm can count it"). It is the metric the plan names.
  //
  // Throttles are deliberately not this alarm's job: a `TooManyRequestsException`
  // from the deploy's invoke is a scheduling collision, which the deploy's
  // poll retries, and the plan keeps the two signals separate ("a throttle is
  // counted separately and loudly enough to be seen"). Nothing counts throttles
  // here yet, and the step entry records it rather than this comment implying
  // otherwise.
  const janitorAlarm = new aws.cloudwatch.MetricAlarm(
    "bifrostVkJanitorNotConvergingAlarm",
    {
      name: VK_JANITOR_ALARM_NAME,
      alarmDescription: VK_JANITOR_ALARM_DESCRIPTION,
      namespace: "AWS/Lambda",
      metricName: "Errors",
      dimensions: { FunctionName: fn.name },
      statistic: "Sum",
      // One period is one scheduled tick, so three periods is three consecutive
      // failing runs rather than fifteen minutes of wall clock that could span
      // a successful run.
      period: VK_JANITOR_INTERVAL_MINUTES * 60,
      evaluationPeriods: VK_JANITOR_ALARM_EVALUATION_PERIODS,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      // A reconciler that has not run yet publishes no `Errors` datapoint.
      // Missing data is the young-account case, not a failure.
      treatMissingData: "notBreaching",
      alarmActions: [alertTopic.arn],
      tags,
    },
    { provider, dependsOn: [alertTopic, fn] },
  );

  return {
    function: fn,
    role,
    rolePolicy,
    securityGroup,
    logGroup,
    rule,
    alertTopic,
    janitorAlarm,
  };
};
