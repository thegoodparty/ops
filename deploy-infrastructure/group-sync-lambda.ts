import * as path from "node:path";
import * as esbuild from "esbuild";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import {
  IDENTITY_STORE_ARN,
  INFRASTRUCTURE_ACCOUNT_ID,
  MANAGEMENT_ACCOUNT_ID,
} from "../utils/accounts";
import {
  GRANT_SESSION_NAME,
} from "../deploy/components/identity-group-sync-grant";
import {
  POLL_INTERVAL_SECONDS,
  RESERVED_TARGET_GROUP_IDS,
  SYNC_CONFIG,
  SYNC_PAIRS,
} from "./group-sync/config";

/**
 * The group-sync Lambda and everything it needs, step 3 of
 * `docs/google-group-sync.md`, in the infrastructure account.
 *
 * The shape follows `deploy-infrastructure/sheriff-lambda.ts`: an explicit
 * provider on every resource (the default provider is disabled in `deploy.sh`),
 * the secret created empty with its value filled by hand, the log group created
 * before the function, a metric filter per alarm and an SNS topic whose email
 * subscription stays unconfirmed until someone accepts AWS's email.
 *
 * The role is named `identity-group-sync` because the management-account grant
 * (`deploy/components/identity-group-sync-grant.ts`) trusts exactly
 * `arn:aws:iam::394495727159:role/identity-group-sync`; the two names must stay
 * in lockstep or the first `AssumeRole` is an `AccessDenied` rather than an
 * apply-time error. The session name is imported from that file for the same
 * reason: CloudTrail's record of every directory mutation depends on it.
 *
 * Deliberate divergences from the sheriff runtime, called out in the PR body:
 *
 * - **No function URL, no DynamoDB table, no scheduler.** The trigger is one
 *   EventBridge rule, the state is the directory, and the audit record is the
 *   log group.
 * - **`reservedConcurrentExecutions: 1`.** A mirror that reads, diffs and then
 *   writes must not have two runs of itself interleaved; the cap is the
 *   simplest correct serialization and it is cheaper to reason about than a
 *   lock. The rule's interval and the function's timeout are set so runs do not
 *   overlap by design either.
 * - **Google credentials are a service-account key, not an app secret.** The
 *   secret is created empty and never written by Pulumi (see "Secrets").
 * - **The pair list is Pulumi state, not code.** It is written to SSM, so adding
 *   a pair is a reviewed apply and the live value cannot drift from the repo,
 *   while the Lambda picks it up without a redeploy.
 */

const NAME = "identity-group-sync";
const REGION = "us-west-2";

/** Matches the `PrincipalArn` condition on the `identity-group-sync-grant` role. */
export const GROUP_SYNC_ROLE_NAME = NAME;

/** The one management-account role the Lambda may assume. */
export const GROUP_SYNC_GRANT_ROLE_ARN = `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/identity-group-sync-grant`;

/** The function's own ARN, so the policy can name its log group. */
export const GROUP_SYNC_FUNCTION_NAME = NAME;
export const GROUP_SYNC_LOG_GROUP = `/aws/lambda/${NAME}`;

/** The config parameter, and the secret container. Both are named in the plan. */
export const GROUP_SYNC_PARAMETER_NAME = "/identity-group-sync/pairs";
export const GROUP_SYNC_SECRET_NAME = "identity-group-sync/google-service-account";

/** The namespace every metric and alarm below uses. */
export const GROUP_SYNC_METRIC_NAMESPACE = "IdentityGroupSync";

/** Where the alarms go: the same address the infrastructure budget and sheriff use. */
export const GROUP_SYNC_ALERT_EMAIL = "aws-infrastructure@goodparty.org";

/**
 * The function timeout, below the poll interval so a run cannot overlap the
 * next one. Five minutes is far more than a group read, a diff and a few
 * hundred membership calls need; the point is the ordering, not the number.
 */
export const GROUP_SYNC_TIMEOUT_SECONDS = 300;

if (GROUP_SYNC_TIMEOUT_SECONDS >= POLL_INTERVAL_SECONDS) {
  // A run that outlives its interval would overlap the next one on a busy
  // account, and `reservedConcurrentExecutions: 1` would then start dropping
  // invocations instead. Fail at load, where a test catches it.
  throw new Error(
    `group sync timeout ${GROUP_SYNC_TIMEOUT_SECONDS}s must be below the poll interval ${POLL_INTERVAL_SECONDS}s`,
  );
}

/** The EventBridge expression for the configured interval. */
export const GROUP_SYNC_SCHEDULE_EXPRESSION = `rate(${Math.round(
  POLL_INTERVAL_SECONDS / 60,
)} minutes)`;

const TAGS = { Name: NAME, Project: NAME };

/** Lambda only. Exported so the test can pin it without standing up Pulumi. */
export const groupSyncLambdaTrust = {
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
 * The Lambda's whole grant: assume the one grant role, read its own secret,
 * read the one config parameter, publish the one metric namespace, write its
 * own log group.
 *
 * Deliberately absent, and asserted by the test:
 *
 * - every `identitystore:*` action. The directory calls all go through
 *   `identity-group-sync-grant`; the function's own role has no directory
 *   permission at all.
 * - `secretsmanager:PutSecretValue` / `CreateSecret`. The value is set by hand.
 * - `kms:Decrypt`. The secret and the parameter use the account's default
 *   `aws/secretsmanager` and `aws/ssm` keys, whose policies admit the account,
 *   the same reasoning `sheriff-lambda.ts` records.
 * - `logs:CreateLogGroup`. Pulumi creates the group below.
 * - `ssm:GetParameters`, `ssm:GetParametersByPath` and every write. One
 *   parameter, read one way.
 */
export const groupSyncLambdaPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AssumeSyncGrant",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      // Exactly one ARN: the management-account role's own inline policy is the
      // scoping that matters, and this is the only door to it.
      Resource: GROUP_SYNC_GRANT_ROLE_ARN,
    },
    {
      Sid: "ReadGoogleSecret",
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      // Secrets Manager appends a random six-character suffix to the ARN, so
      // the name needs a wildcard. Scoped to this one secret, in this account.
      // A delete-and-recreate rotation keeps working, which is what "Rotation"
      // in the plan relies on.
      Resource: `arn:aws:secretsmanager:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:secret:${GROUP_SYNC_SECRET_NAME}-*`,
    },
    {
      Sid: "ReadConfig",
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: `arn:aws:ssm:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:parameter${GROUP_SYNC_PARAMETER_NAME}`,
    },
    {
      Sid: "PutSyncMetrics",
      Effect: "Allow",
      Action: "cloudwatch:PutMetricData",
      // `PutMetricData` has no resource-level permission, so the resource is
      // `*` and the namespace condition is what scopes it: this function can
      // write `IdentityGroupSync` and nothing else.
      Resource: "*",
      Condition: {
        StringEquals: { "cloudwatch:namespace": GROUP_SYNC_METRIC_NAMESPACE },
      },
    },
    {
      Sid: "OwnLogs",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: `arn:aws:logs:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:log-group:${GROUP_SYNC_LOG_GROUP}:*`,
    },
  ],
} as const;

/**
 * Bundles the handler into a single-file archive in the Pulumi program, the
 * same way `buildSheriffCode` does and for the same reason: the
 * `deploy-infrastructure` workflow runs no build step, and the archive's hash
 * follows the source, so a code change shows up in `pulumi preview`.
 */
export const buildGroupSyncCode = (): pulumi.asset.AssetArchive => {
  const result = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "group-sync/handler.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error("esbuild produced no output for the group-sync handler");
  }
  return new pulumi.asset.AssetArchive({
    "handler.js": new pulumi.asset.StringAsset(output.text),
  });
};

export const createGroupSync = (args: { provider: aws.Provider }) => {
  const { provider } = args;

  // Created empty and never given a value by Pulumi: the key JSON is put in by
  // hand as part of the manual Google setup ("Secrets" in the plan). No
  // `protect` -- Pulumi owns the container's lifecycle, only its value is
  // out-of-band -- and no `import`, because this container does not exist yet.
  const secret = new aws.secretsmanager.Secret(
    "groupSyncGoogleSecret",
    {
      name: GROUP_SYNC_SECRET_NAME,
      description:
        "Google Workspace service-account key for the Identity Center group sync. Filled by hand; never by Pulumi.",
      tags: TAGS,
    },
    { provider },
  );

  // The pair list, Pulumi-written and Lambda-read. `String`, not
  // `SecureString`: the config is group emails and group ids, and the plan says
  // so explicitly. It is a constant in `group-sync/config.ts` rather than
  // Pulumi config because it is policy and should be reviewed with the code
  // that consumes it.
  const parameter = new aws.ssm.Parameter(
    "groupSyncPairs",
    {
      name: GROUP_SYNC_PARAMETER_NAME,
      type: "String",
      value: JSON.stringify(SYNC_CONFIG),
      description:
        "Google group -> Identity Center group pairs for the identity-group-sync Lambda. Written by Pulumi; edit deploy-infrastructure/group-sync/config.ts.",
      // A description change rewrites the value on the next apply. That is the
      // point: the live value cannot drift from the repo.
      tags: TAGS,
    },
    { provider },
  );

  const logGroup = new aws.cloudwatch.LogGroup(
    "groupSyncLogs",
    {
      name: GROUP_SYNC_LOG_GROUP,
      // The audit trail for every membership change, and the only place the
      // per-member lines live. A quarter is the sheriff log group's retention
      // and enough to answer "who removed whom, and when".
      retentionInDays: 90,
      tags: TAGS,
    },
    { provider },
  );

  const role = new aws.iam.Role(
    "groupSyncLambdaRole",
    {
      name: GROUP_SYNC_ROLE_NAME,
      description:
        "identity-group-sync Lambda execution role: SSM config, its own Google secret, CloudWatch metrics and logs, and sts:AssumeRole on identity-group-sync-grant. No identitystore action directly.",
      assumeRolePolicy: JSON.stringify(groupSyncLambdaTrust),
      tags: TAGS,
    },
    { provider },
  );

  const lambdaPolicy = new aws.iam.RolePolicy(
    "groupSyncLambdaPolicy",
    {
      name: NAME,
      role: role.name,
      policy: JSON.stringify(groupSyncLambdaPolicy),
    },
    { provider },
  );

  const fn = new aws.lambda.Function(
    "groupSync",
    {
      name: GROUP_SYNC_FUNCTION_NAME,
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: buildGroupSyncCode(),
      timeout: GROUP_SYNC_TIMEOUT_SECONDS,
      memorySize: 256,
      // One run at a time, by construction. Two interleaved runs would each
      // read, diff and write the same group from the same snapshot, and the
      // later apply would undo the earlier one's removals.
      reservedConcurrentExecutions: 1,
      environment: {
        variables: {
          PARAMETER_NAME: GROUP_SYNC_PARAMETER_NAME,
          SECRET_ARN: secret.arn,
          // The session name the grant's trust and CloudTrail key on. Passed in
          // rather than duplicated in the handler so the bundle has no `deploy/`
          // dependency.
          GRANT_SESSION_NAME,
          // The dedicated impersonation admin. `deploy.sh` sets the
          // `googleImpersonationEmail` config key for this stack; a value left
          // empty (a local run that skipped deploy.sh) makes the handler abort
          // every pair with `source-read-failed` and write nothing.
          GOOGLE_IMPERSONATION_EMAIL:
            new pulumi.Config().get("googleImpersonationEmail") ?? "",
        },
      },
      tags: TAGS,
    },
    // The function may be invoked as soon as it exists; the log group and the
    // inline policy must exist first, or the first invocation logs to an
    // implicit group and the policy's absence is invisible until then.
    { provider, dependsOn: [logGroup, lambdaPolicy] },
  );

  // The schedule. A plain EventBridge rule rather than EventBridge Scheduler:
  // this is a fixed interval with no per-invocation state to carry, so the
  // scheduler's schedule groups and DLQs buy nothing.
  const rule = new aws.cloudwatch.EventRule(
    "groupSyncSchedule",
    {
      name: NAME,
      description: `Runs the Identity Center group sync every ${
        POLL_INTERVAL_SECONDS / 60
      } minutes.`,
      scheduleExpression: GROUP_SYNC_SCHEDULE_EXPRESSION,
      tags: TAGS,
    },
    { provider },
  );

  new aws.cloudwatch.EventTarget(
    "groupSyncTarget",
    {
      rule: rule.name,
      arn: fn.arn,
      // The scheduled shape the handler recognises. Anything else is refused,
      // so this literal is the whole contract between the rule and the handler.
      input: JSON.stringify({ action: "sync" }),
    },
    { provider },
  );

  // EventBridge needs explicit permission to invoke the function.
  new aws.lambda.Permission(
    "groupSyncSchedulePermission",
    {
      action: "lambda:InvokeFunction",
      function: fn.name,
      principal: "events.amazonaws.com",
      sourceArn: rule.arn,
    },
    { provider },
  );

  const alertTopic = new aws.sns.Topic(
    "groupSyncAlerts",
    {
      name: `${NAME}-alerts`,
      tags: TAGS,
    },
    { provider },
  );

  // Exists but stays unconfirmed until someone accepts the AWS email, the same
  // manual step as filling the secret. Called out in the PR body.
  new aws.sns.TopicSubscription(
    "groupSyncAlertsEmail",
    {
      topic: alertTopic.arn,
      protocol: "email",
      endpoint: GROUP_SYNC_ALERT_EMAIL,
    },
    { provider },
  );

  // CloudWatch publishes alarm actions as the CloudWatch service principal,
  // which the default topic policy does not admit. Conditioned on the account,
  // not the alarm ARN, so the topic and the alarms do not depend on each other.
  new aws.sns.TopicPolicy(
    "groupSyncAlertsPolicy",
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

  // -------------------------------------------------------------------------
  // Alarms.
  //
  // The dead-man's switch and the removals alarm read the metrics the handler
  // publishes with `PairId`, so both are per pair. The guard alarms read a log
  // metric filter instead: `Aborted` and `RemovalCapTripped` are invocation-
  // wide questions ("did any pair abort"), and a dimensionless filter series is
  // what lets one alarm cover every pair and every reason without a metric-math
  // expression. The handler also publishes those two with `PairId` (and
  // `Reason` for `Aborted`) for dashboards; the two series share a name and
  // differ by dimensions, which is why each alarm below names its dimensions
  // explicitly.

  new aws.cloudwatch.LogMetricFilter(
    "groupSyncAbortedFilter",
    {
      name: `${NAME}-aborted`,
      logGroupName: logGroup.name,
      pattern: `{ $.audit = "sync.aborted" }`,
      metricTransformation: {
        namespace: GROUP_SYNC_METRIC_NAMESPACE,
        name: "Aborted",
        value: "1",
        defaultValue: "0",
      },
    },
    { provider, dependsOn: [logGroup] },
  );

  new aws.cloudwatch.LogMetricFilter(
    "groupSyncRemovalCapFilter",
    {
      name: `${NAME}-removal-cap`,
      logGroupName: logGroup.name,
      pattern: `{ $.audit = "removal_cap.tripped" }`,
      metricTransformation: {
        namespace: GROUP_SYNC_METRIC_NAMESPACE,
        name: "RemovalCapTripped",
        value: "1",
        defaultValue: "0",
      },
    },
    { provider, dependsOn: [logGroup] },
  );

  // Any abort -- a source read, the cap, an invalid pair, a failed write. This
  // is the "failures" alarm: a sync that did not complete is a sync that did
  // not happen, and it must not be silent.
  const abortedAlarm = new aws.cloudwatch.MetricAlarm(
    "groupSyncAbortedAlarm",
    {
      name: `${NAME}-aborted`,
      alarmDescription:
        "A group sync pair aborted: the source or directory read failed, a pair was invalid, or a write failed after retries. Nothing was applied for that pair.",
      namespace: GROUP_SYNC_METRIC_NAMESPACE,
      metricName: "Aborted",
      statistic: "Sum",
      period: POLL_INTERVAL_SECONDS,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      // The filter's `defaultValue` means there is always data; this covers
      // only the window before the first log line.
      treatMissingData: "notBreaching",
      alarmActions: [alertTopic.arn],
      tags: TAGS,
    },
    { provider, dependsOn: [alertTopic] },
  );

  // The removal cap tripping is not an error -- it is the guard working -- but
  // it is exactly the event a human has to look at, so it pages on its own.
  const removalCapAlarm = new aws.cloudwatch.MetricAlarm(
    "groupSyncRemovalCapAlarm",
    {
      name: `${NAME}-removal-cap`,
      alarmDescription:
        "The removal cap tripped: a run wanted to remove more members than the pair allows and applied nothing. Confirm the Google group is what it should be before overriding.",
      namespace: GROUP_SYNC_METRIC_NAMESPACE,
      metricName: "RemovalCapTripped",
      statistic: "Sum",
      period: POLL_INTERVAL_SECONDS,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      treatMissingData: "notBreaching",
      alarmActions: [alertTopic.arn],
      tags: TAGS,
    },
    { provider, dependsOn: [alertTopic] },
  );

  // Per pair: removals are not errors and an error alarm would never see them.
  // The threshold is the pair's own `removalAlertThreshold` (0 = any removal
  // pages), which is why this is a loop and not one alarm.
  const removalsAlarms = SYNC_PAIRS.map((pair) => {
    const safeId = pair.id.replace(/[^a-zA-Z0-9]/g, "-");
    return new aws.cloudwatch.MetricAlarm(
      `groupSyncRemovals-${safeId}`,
      {
        name: `${NAME}-removals-${safeId}`,
        alarmDescription: `The ${pair.id} pair removed more than ${pair.removalAlertThreshold} members in one run. A removal is not an error, which is why it has its own alarm.`,
        namespace: GROUP_SYNC_METRIC_NAMESPACE,
        metricName: "Removed",
        dimensions: { PairId: pair.id },
        statistic: "Sum",
        period: POLL_INTERVAL_SECONDS,
        evaluationPeriods: 1,
        threshold: pair.removalAlertThreshold,
        comparisonOperator: "GreaterThanThreshold",
        // Zeros are published every run, so there is always data; this covers
        // only the window before the first run.
        treatMissingData: "notBreaching",
        alarmActions: [alertTopic.arn],
        tags: TAGS,
      },
      { provider, dependsOn: [alertTopic] },
    );
  });

  // Per pair: the dead-man's switch is the *absence* of the heartbeat, so the
  // alarm is on `Success` with `treatMissingData: breaching`. It fires from the
  // first interval on an account that has never synced, which is correct.
  const heartbeatAlarms = SYNC_PAIRS.map((pair) => {
    const safeId = pair.id.replace(/[^a-zA-Z0-9]/g, "-");
    return new aws.cloudwatch.MetricAlarm(
      `groupSyncHeartbeat-${safeId}`,
      {
        name: `${NAME}-heartbeat-${safeId}`,
        alarmDescription: `No successful ${pair.id} sync in two poll intervals. A run that never happened is a breach.`,
        namespace: GROUP_SYNC_METRIC_NAMESPACE,
        metricName: "Success",
        dimensions: { PairId: pair.id },
        statistic: "Sum",
        // One period is one poll interval; two of them is "no success in 2x the
        // poll interval", which is the requirement.
        period: POLL_INTERVAL_SECONDS,
        evaluationPeriods: 2,
        threshold: 1,
        comparisonOperator: "LessThanThreshold",
        treatMissingData: "breaching",
        alarmActions: [alertTopic.arn],
        tags: TAGS,
      },
      { provider, dependsOn: [alertTopic] },
    );
  });

  return {
    fn,
    role,
    secret,
    parameter,
    logGroup,
    rule,
    alertTopic,
    abortedAlarm,
    removalCapAlarm,
    removalsAlarms,
    heartbeatAlarms,
  };
};

/**
 * The resources the plan and its tests name, so a reviewer can see the scoping
 * without reading the resource bodies. `IDENTITY_STORE_ARN` is imported for the
 * comment above the assumed role: the function's own policy names no
 * identitystore resource at all, and that absence is the point.
 */
export const GROUP_SYNC_IDENTITY_STORE_ARN = IDENTITY_STORE_ARN;
export const GROUP_SYNC_RESERVED_TARGETS = RESERVED_TARGET_GROUP_IDS;
