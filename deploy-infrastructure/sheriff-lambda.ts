import * as path from "node:path";
import * as esbuild from "esbuild";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import {
  INFRASTRUCTURE_ACCOUNT_ID,
  MANAGEMENT_ACCOUNT_ID,
} from "../utils/accounts";
import { DEFAULT_APPROVAL_CHANNEL } from "./sheriff/config";

/**
 * The break-glass Lambda, step 4 ("approval wired to a real grant") of
 * `docs/sheriff.md`, in the infrastructure account.
 *
 * Everything here takes the explicit provider from `index.ts`; the default
 * provider is disabled in `deploy.sh`, so a resource that omits `{ provider }`
 * fails the apply rather than landing in the management account.
 *
 * Step 4 assumes `sheriff-grant` and toggles `Admins` membership. The Lambda's
 * own role gets `sts:AssumeRole` on exactly that one ARN and **no**
 * `identitystore` action: every directory call goes through the assumed role,
 * which is the scoped one. The execution role is named `sheriff`, matching the
 * exact role ARN the management-account grant role trusts
 * (`deploy/components/sheriff-grant.ts`); the two names must stay in lockstep
 * or the first AssumeRole is an AccessDenied, not an apply-time error.
 *
 * This file also owns the step-4 sweeper's trigger and the orphaned-membership
 * alarm. The one-shot expiry scheduler is step 5; until it lands the sweeper is
 * the revoke path.
 */

const NAME = "sheriff";
const REGION = "us-west-2";

/** Matches the `PrincipalArn` condition on the `sheriff-grant` role. */
export const SHERIFF_ROLE_NAME = NAME;

/** The one management-account role the Lambda may assume. */
export const SHERIFF_GRANT_ROLE_ARN = `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/sheriff-grant`;

/**
 * Where the orphaned-membership alarm goes. The budget alerts in `index.ts`
 * use the same address. The SNS subscription is created here but stays
 * unconfirmed until someone accepts the AWS email; that is a manual step, the
 * same as the Slack secret's.
 */
export const SHERIFF_ALERT_EMAIL = "aws-infrastructure@goodparty.org";

/** The audit event the alarm watches for. `handler.ts` emits it. */
export const ORPHANED_AUDIT_EVENT = "membership.orphaned";

export const SHERIFF_TABLE_NAME = "sheriff";
// The Slack app is `@sheriff`, expected to grow beyond break-glass to other
// privileged ops, so its credentials secret is app-scoped (`sheriff`). The
// table below is the break-glass workflow's request records and now shares the
// app's name; that is deliberate, and safe because Secrets Manager and
// DynamoDB are separate namespaces.
export const SHERIFF_SECRET_NAME = "sheriff";
export const SHERIFF_LOG_GROUP = `/aws/lambda/${NAME}`;

/**
 * The id the secret's one-time `import` option adopts it by.
 *
 * The AWS provider's importer for `aws:secretsmanager/secret:Secret` requires
 * an ARN, not the bare name: it parses the id as an ARN before the read. It is
 * the *partial* ARN, without the six random characters Secrets Manager appends
 * to a name, because that suffix does not exist until the secret does and must
 * not be committed. Secrets Manager resolves a partial ARN to the one secret
 * with that name (the name does not end in a hyphen plus six characters), so
 * the suffix never has to be known here.
 */
export const SHERIFF_SECRET_IMPORT_ID = `arn:aws:secretsmanager:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:secret:${SHERIFF_SECRET_NAME}`;

const TAGS = { Name: NAME, Project: NAME };

/**
 * Lambda only. Exported so the test can pin it without standing up Pulumi.
 */
export const sheriffLambdaTrust = {
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
 * The whole grant for step 4, and nothing else: read its own secret, assume
 * the one grant role, read/write the one request table, write its own log
 * group.
 *
 * Deliberately absent, and asserted by the test:
 *
 * - every `identitystore:*` action. The Lambda has no directory permission of
 *   its own; `sheriff-grant` is the scoped role and `sts:AssumeRole` on it is
 *   the only management-account reach.
 * - `DELEGATES` or any secret but the tool's own.
 * - `dynamodb:Scan`. `Query` on the fixed `GRANT` partition is the sweeper's
 *   grant scan; a full-table scan is not needed and not granted.
 */
export const sheriffLambdaPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ReadOwnSecret",
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      // Secrets Manager appends a random six-character suffix to the ARN, so
      // the name has to be a wildcard. It is scoped to this one secret name
      // and this account, not `*`.
      Resource: `arn:aws:secretsmanager:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:secret:${SHERIFF_SECRET_NAME}-*`,
    },
    {
      Sid: "AssumeSheriffGrant",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      // Exactly one ARN. The management-account role's own inline policy is
      // the scoping that matters; this is the only door to it.
      Resource: SHERIFF_GRANT_ROLE_ARN,
    },
    {
      Sid: "RequestTable",
      Effect: "Allow",
      Action: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        // The sweeper queries every grant record by the fixed `GRANT`
        // partition. Not `Scan`: the query is bounded by the partition key.
        "dynamodb:Query",
      ],
      Resource: `arn:aws:dynamodb:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:table/${SHERIFF_TABLE_NAME}`,
    },
    {
      Sid: "OwnLogs",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      // The log group is created below, so no `logs:CreateLogGroup` is needed.
      Resource: `arn:aws:logs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:log-group:${SHERIFF_LOG_GROUP}:*`,
    },
  ],
} as const;

/**
 * Bundles the TypeScript handler into a single-file archive in the Pulumi
 * program.
 *
 * The delegate webhook is bundled by `npm run build` into `dist/lambda` and
 * referenced with a `FileArchive`, but `deploy-infrastructure`'s workflow and
 * preview run no build step and `docs/pr-previews.md` records that. Bundling
 * here keeps that true: esbuild is a devDependency `npm ci` already installs,
 * and the archive's hash follows the source, so a code change shows up in
 * `pulumi preview` without a workflow change.
 */
export const buildSheriffCode = (): pulumi.asset.AssetArchive => {
  const result = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "sheriff/handler.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error("esbuild produced no output for the break-glass handler");
  }
  return new pulumi.asset.AssetArchive({
    "handler.js": new pulumi.asset.StringAsset(output.text),
  });
};

export const createSheriff = (args: { provider: aws.Provider }) => {
  const { provider } = args;

  // Created empty, filled out of band: see the manual steps in
  // `docs/sheriff.md`. No secret value is ever committed or set by
  // Pulumi, matching the `DELEGATE_SWARM` secret's handling.
  //
  // `import` is a one-time adoption: the secret was created by hand before
  // this resource first applied, so `CreateSecret` collided with it. Importing
  // the container adopts it in place without reading or overwriting its value.
  // Once the resource is in state the option is inert -- Pulumi ignores it for
  // a resource it already manages -- so it can stay as the record of the
  // adoption. See the ordering note in `docs/sheriff.md`.
  //
  // No `protect`: Pulumi owns the secret's whole lifecycle from here on. Only
  // its value is set out of band, by hand, and never by Pulumi.
  const secret = new aws.secretsmanager.Secret(
    "sheriffSlackSecret",
    {
      name: SHERIFF_SECRET_NAME,
      description:
        "Sheriff Slack app credentials (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN). Filled by hand; never by Pulumi.",
      tags: TAGS,
    },
    { provider, import: SHERIFF_SECRET_IMPORT_ID },
  );

  // Single table: request records, grant records, per-user active-grant locks
  // and per-user rate counters. Grants share a fixed `GRANT` partition so the
  // sweeper can query them; the lock items are per-requester.
  const table = new aws.dynamodb.Table(
    "sheriffRequests",
    {
      name: SHERIFF_TABLE_NAME,
      billingMode: "PAY_PER_REQUEST",
      hashKey: "pk",
      rangeKey: "sk",
      attributes: [
        { name: "pk", type: "S" },
        { name: "sk", type: "S" },
      ],
      // Retention only; TTL never ends a grant (`docs/sheriff.md`).
      ttl: { attributeName: "ttl", enabled: true },
      tags: TAGS,
    },
    // The application audit record lives here, so a `pulumi destroy` that
    // would take it must be a deliberate, reviewed change.
    { provider, protect: true },
  );

  const logGroup = new aws.cloudwatch.LogGroup(
    "sheriffLogs",
    {
      name: SHERIFF_LOG_GROUP,
      // Long enough to reconstruct a quarter of decisions; the durable
      // CloudTrail archive is step 1.
      retentionInDays: 90,
      tags: TAGS,
    },
    { provider },
  );

  const role = new aws.iam.Role(
    "sheriffLambdaRole",
    {
      name: SHERIFF_ROLE_NAME,
      description:
        "Sheriff Lambda execution role: DynamoDB, logs, its own secret, and sts:AssumeRole on sheriff-grant. No identitystore action directly.",
      assumeRolePolicy: JSON.stringify(sheriffLambdaTrust),
      tags: TAGS,
    },
    { provider },
  );

  const lambdaPolicy = new aws.iam.RolePolicy(
    "sheriffLambdaPolicy",
    {
      name: NAME,
      role: role.name,
      policy: JSON.stringify(sheriffLambdaPolicy),
    },
    { provider },
  );

  const fn = new aws.lambda.Function(
    "sheriff",
    {
      name: NAME,
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: buildSheriffCode(),
      timeout: 30,
      memorySize: 256,
      environment: {
        variables: {
          SECRET_ARN: secret.arn,
          REQUEST_TABLE: table.name,
          APPROVAL_CHANNEL: DEFAULT_APPROVAL_CHANNEL,
        },
      },
      tags: TAGS,
    },
    // The function may be invoked as soon as it exists; the log group and the
    // inline policy must exist first, or the first invocation logs to an
    // implicit group (and the policy's absence is invisible until then).
    { provider, dependsOn: [logGroup, lambdaPolicy] },
  );

  // Signature-only auth, exactly like the delegate webhook: every request is
  // verified against the sheriff signing secret before anything happens.
  const functionUrl = new aws.lambda.FunctionUrl(
    "sheriffUrl",
    {
      functionName: fn.name,
      authorizationType: "NONE",
    },
    { provider },
  );

  // -------------------------------------------------------------------------
  // The reconciliation sweeper.
  //
  // Step 4 has no one-shot expiry scheduler (that is step 5), so this periodic
  // rule is the revoke path: every expired grant is revoked on the next pass.
  // A plain EventBridge rule rather than EventBridge Scheduler, to keep step 4
  // and step 5's mechanism distinct. The `input` is the marker the handler
  // branches on; the event never reaches the Slack signature check.
  const sweepRule = new aws.cloudwatch.EventRule(
    "sheriffSweepRule",
    {
      name: `${NAME}-sweep`,
      description:
        "Periodic reconciliation sweep for break-glass grants. Step 4's revoke path until step 5's one-shot scheduler lands.",
      scheduleExpression: "rate(5 minutes)",
      tags: TAGS,
    },
    { provider },
  );

  new aws.cloudwatch.EventTarget(
    "sheriffSweepTarget",
    {
      rule: sweepRule.name,
      arn: fn.arn,
      input: JSON.stringify({ action: "sweep" }),
    },
    { provider },
  );

  // EventBridge needs explicit permission to invoke the function; the
  // Function URL's auth does not cover the events service.
  new aws.lambda.Permission(
    "sheriffSweepPermission",
    {
      action: "lambda:InvokeFunction",
      function: fn.name,
      principal: "events.amazonaws.com",
      sourceArn: sweepRule.arn,
    },
    { provider },
  );

  // -------------------------------------------------------------------------
  // The orphaned-membership alarm.
  //
  // Only `membership.orphaned` pages: an expired grant whose member is still
  // present after the sweeper's revoke attempt, i.e. the revoke failed or the
  // state is stuck. A normal sweep-and-revoke is silent, and every grant is
  // informational, so the channel does not train people to ignore it.
  new aws.cloudwatch.LogMetricFilter(
    "sheriffOrphanedFilter",
    {
      name: `${NAME}-membership-orphaned`,
      logGroupName: logGroup.name,
      pattern: `{ $.audit = "${ORPHANED_AUDIT_EVENT}" }`,
      metricTransformation: {
        namespace: "Sheriff",
        name: "MembershipOrphaned",
        value: "1",
      },
    },
    { provider, dependsOn: [logGroup] },
  );

  const alertTopic = new aws.sns.Topic(
    "sheriffAlerts",
    {
      name: `${NAME}-alerts`,
      tags: TAGS,
    },
    { provider },
  );

  // The subscription exists but stays unconfirmed until someone accepts the
  // AWS email. That is the same manual step as filling the Slack secret, and
  // it is called out in the PR body.
  new aws.sns.TopicSubscription(
    "sheriffAlertsEmail",
    {
      topic: alertTopic.arn,
      protocol: "email",
      endpoint: SHERIFF_ALERT_EMAIL,
    },
    { provider },
  );

  // CloudWatch publishes alarm actions to the topic as the CloudWatch service
  // principal, which the default topic policy does not admit. The condition is
  // the account, not the alarm ARN: naming the alarm would make the topic
  // policy and the alarm depend on each other.
  new aws.sns.TopicPolicy(
    "sheriffAlertsPolicy",
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
                  "aws:SourceAccount": INFRASTRUCTURE_ACCOUNT_ID,
                },
              },
            },
          ],
        }),
      ),
    },
    { provider },
  );

  const orphanedAlarm = new aws.cloudwatch.MetricAlarm(
    "sheriffOrphanedAlarm",
    {
      name: `${NAME}-membership-orphaned`,
      alarmDescription:
        "A break-glass grant expired but its Admins membership is still present after the sweeper's revoke attempt. Admin access may be standing.",
      namespace: "Sheriff",
      metricName: "MembershipOrphaned",
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      // The metric does not exist until the first orphan, so treat no data as
      // not breaching rather than alarming on an empty account.
      treatMissingData: "notBreaching",
      alarmActions: [alertTopic.arn],
      tags: TAGS,
    },
    { provider, dependsOn: [alertTopic] },
  );

  return {
    fn,
    url: functionUrl.functionUrl,
    secret,
    table,
    logGroup,
    sweepRule,
    orphanedAlarm,
    alertTopic,
  };
};
