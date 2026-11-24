import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as esbuild from "esbuild";
import * as path from "node:path";

import { INFRASTRUCTURE_ACCOUNT_ID, MANAGEMENT_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import { LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN } from "./bifrost-vk-mint";
import {
  USAGE_EXPORT_ALERT_TOPIC_NAME,
  USAGE_EXPORT_DB_ROLE,
  USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME,
  USAGE_EXPORT_BOOTSTRAP_LOG_GROUP_NAME,
  USAGE_EXPORT_BOOTSTRAP_MEMORY_MB,
  USAGE_EXPORT_BOOTSTRAP_ROLE_NAME,
  USAGE_EXPORT_BOOTSTRAP_TIMEOUT_SECONDS,
  USAGE_EXPORT_DAILY_SCHEDULE,
  USAGE_EXPORT_DAILY_WINDOW_DAYS,
  USAGE_EXPORT_FAILURE_ALARM_NAME,
  USAGE_EXPORT_FUNCTION_NAME,
  USAGE_EXPORT_LOG_GROUP_NAME,
  USAGE_EXPORT_LOG_RETENTION_DAYS,
  USAGE_EXPORT_MEMORY_MB,
  USAGE_EXPORT_MONTHLY_SCHEDULE,
  USAGE_EXPORT_MONTHLY_WINDOW_DAYS,
  USAGE_EXPORT_NEVER_RAN_ALARM_NAME,
  USAGE_EXPORT_NEVER_RAN_PERIOD_SECONDS,
  USAGE_EXPORT_RESERVED_CONCURRENCY,
  USAGE_EXPORT_ROLE_NAME,
  USAGE_EXPORT_SECRET_NAME,
  USAGE_EXPORT_TIMEOUT_SECONDS,
} from "./bifrost/usage-export-contract";
import { DATABASE_NAME, DATABASE_USERNAME, type BifrostDatabase } from "./rds";
import { POSTGRES_PORT, REGION, VPC_CIDR, type createWorkbenchNetwork } from "./network";
import { WORKBENCH_ALERT_EMAIL } from "./alert-email";

/**
 * The Bifrost usage export: the job that reads the gateway's `logs` table and
 * writes one Parquet object per run to a bucket this account owns.
 *
 * ## What this module owns
 *
 * The bucket and everything about it, the export function, the bootstrap
 * function, their two roles and two security groups, the two database ingress
 * rules this account's database group needs for them, the two schedule rules, the
 * two alarms, and the alert topic.
 *
 * ## Why a Lambda and not an ECS task
 *
 * Measured, not assumed: the 30-column file at the daily window's row count writes
 * in well under a second and produces well under a megabyte, and at the monthly
 * row count it is a few seconds and a few megabytes. Both are far inside Lambda's
 * 15-minute ceiling. A Fargate task would need a task definition, an ECR
 * repository, a build and push step in `deploy-workbench.yml`, and a scheduler,
 * for a job that runs about half a minute a day. `deploy-workbench.yml` already
 * carries an ordered sequence of image pushes whose whole purpose is to keep the
 * gateway from being rolled onto an image that does not exist yet; adding a fifth
 * image to that sequence is cost with no return.
 *
 * The two existing VPC-attached Lambdas are the pattern: `bifrost-vk-mint.ts` for
 * the bundle-and-attach shape, `bifrost-vk-janitor.ts` for the schedule, the
 * reserved concurrency and the alarm.
 *
 * ## The bucket policy admits a role in *another* account, and it is built from
 * ## `MANAGEMENT_ACCOUNT_ID`
 *
 * Under the approved design the Databricks storage-credential role lives in the
 * account `gp-terraform-dataplatform` deploys into, which is the management
 * account, not this one. The policy therefore admits
 * `arn:aws:iam::<management>:root` with an `ArnEquals aws:PrincipalArn` condition
 * pinning the one role name. Using this account's id here would apply cleanly and
 * deny every read, which is the worst kind of wrong: it looks correct in review
 * and fails at the first `COPY INTO` with a permission error on an object that is
 * plainly there.
 *
 * `ArnEquals` on `aws:PrincipalArn` rather than naming the role as `Principal`,
 * for a second reason: S3 validates the principals in a bucket policy, so naming
 * a role that does not exist yet is `MalformedPolicy: Invalid principal in
 * policy`. The account root plus the condition is accepted before the role
 * exists, so this PR and the terraform one can land in either order. It is the
 * same construction `deploy/components/bifrost-vk-reader.ts` uses for the same
 * reason.
 *
 * ## The two alarms
 *
 * `Errors` catches a run that starts and fails. `Invocations` at a one-day period
 * with `treatMissingData: breaching` catches a run that never starts at all: a
 * disabled rule, a schedule that stopped matching, a function deleted by a bad
 * apply. Without the second, a dead job is silent, because `Errors` publishes no
 * datapoint for a function that was never invoked and the first alarm reads that
 * absence as healthy.
 *
 * dbt source freshness was considered for that job and rejected: nothing in
 * `gp-data-platform` runs `dbt source freshness` or `dbt freshness`, so the
 * source's `warn_after`/`error_after` are configured and never evaluated.
 */

/**
 * The bucket. Globally unique names cannot be checked from here, so the name is a
 * constant and a collision is a failed apply naming it.
 */
const BUCKET_NAME = "goodparty-workbench-bifrost-usage";

/**
 * The prefix the loader's `bifrost_export_prefix` Airflow Variable must equal, and
 * the terraform repo's external location must point at. Exported as a stack
 * output so the three places read it rather than retype it.
 */
const EXPORT_PREFIX = "bifrost/logs";

/**
 * The role name the bucket policy's condition pins, in the management account.
 *
 * A constant in two repos, and the terraform PR spells the same string. A drift
 * between them is not an apply failure: it is a bucket policy that admits nothing
 * and a `COPY INTO` that cannot read.
 */
const USAGE_EXPORT_READER_ROLE_NAME = "bifrost-usage-export-reader";

/**
 * The swarm host's role, in the infrastructure account. The same string
 * `deploy-infrastructure/agent-swarm.ts` gives its role, and pinned equal by
 * `usage-export.test.ts`.
 */
const SWARM_HOST_ROLE_NAME = "delegate-swarm-host";

/**
 * The two prefixes the swarm's exporter writes, one per table.
 *
 * One prefix per table and not one shared prefix, because `COPY INTO` reads a
 * whole prefix: a shared one would make each table's load read the other table's
 * file and fail on the columns it does not have. Both sit under
 * `delegate-swarm/`, a sibling of `bifrost/logs` rather than a child of it,
 * because Unity Catalog refuses an external location nested in another.
 *
 * Pinned equal to `SWARM_USAGE_EXPORT_PREFIXES` in
 * `deploy-infrastructure/agent-swarm.ts` by `usage-export.test.ts` and by a test
 * on that side: the exporter's own test pins the paths it writes, so a rename has
 * to travel through all three.
 */
const SWARM_EXPORT_PREFIXES = ["delegate-swarm/session-cost", "delegate-swarm/task-edge"];

/**
 * Everything the Databricks reader role may read here, which is the gateway's
 * prefix and the swarm's two.
 *
 * The read grant is widened rather than duplicated so there is one statement per
 * action: the loader reads each prefix through one Unity Catalog external
 * location per table, and both halves of a prefix-scoped read (the objects and
 * the `ListBucket` on the prefix) then cover the same list. A prefix added to one
 * statement and not the other fails as a listing that returns nothing, which
 * looks like an empty day rather than a permission error.
 */
const READ_PREFIXES = [EXPORT_PREFIX, ...SWARM_EXPORT_PREFIXES];

/** Bundle the export handler the way the two existing functions bundle theirs. */
export const buildUsageExportCode = (): pulumi.asset.AssetArchive => {
  const result = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, "bifrost/usage-export-handler.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("esbuild produced no output for the usage-export handler");
  return new pulumi.asset.AssetArchive({
    "handler.js": new pulumi.asset.StringAsset(output.text),
  });
};

/** The bootstrap handler, same shape. */
export const buildUsageExportBootstrapCode = (): pulumi.asset.AssetArchive => {
  const result = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, "bifrost/usage-export-db-bootstrap.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("esbuild produced no output for the usage-export bootstrap handler");
  return new pulumi.asset.AssetArchive({
    "handler.js": new pulumi.asset.StringAsset(output.text),
  });
};

/** Lambda's own trust. Nothing else may assume either role. */
const lambdaTrust = {
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
 * The four egress rules both functions' groups need, in one place.
 *
 * `network.ts` removes AWS's default allow-all egress from every group it creates,
 * so a group with no egress rule has none — which is why 5432 has to be declared
 * here and not only as an ingress rule on the database group. A group reference
 * admits one direction, so the pair is what makes the connection possible, and
 * copying only the ingress half is the mistake this comment exists to prevent.
 *
 * 443 and DNS go to `0.0.0.0/0` for S3, Secrets Manager, STS and CloudWatch Logs
 * through the single NAT, which is the same trade the task's, the mint's and the
 * janitor's groups make. Their reasons apply unchanged: those endpoints are on the
 * public internet, so a CIDR is the only honest scope.
 */
const egressRulesFor = (
  args: { provider: aws.Provider; name: string; securityGroupId: pulumi.Input<string> },
  network: ReturnType<typeof createWorkbenchNetwork>,
) => {
  const { provider, name, securityGroupId } = args;
  new aws.vpc.SecurityGroupEgressRule(
    `${name}EgressPostgres`,
    {
      securityGroupId,
      description: "postgres on the gateway database",
      ipProtocol: "tcp",
      fromPort: POSTGRES_PORT,
      toPort: POSTGRES_PORT,
      referencedSecurityGroupId: network.databaseSecurityGroup.id,
    },
    { provider },
  );
  new aws.vpc.SecurityGroupEgressRule(
    `${name}EgressHttps`,
    {
      securityGroupId,
      description: "AWS APIs via the NAT: S3, Secrets Manager, STS, CloudWatch Logs",
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      cidrIpv4: "0.0.0.0/0",
    },
    { provider },
  );
  for (const protocol of ["udp", "tcp"] as const) {
    new aws.vpc.SecurityGroupEgressRule(
      `${name}EgressDns${protocol.toUpperCase()}`,
      {
        securityGroupId,
        description: `DNS to the VPC resolver (${protocol})`,
        ipProtocol: protocol,
        fromPort: 53,
        toPort: 53,
        cidrIpv4: VPC_CIDR,
      },
      { provider },
    );
  }
};

export const createBifrostUsageExport = (args: {
  provider: aws.Provider;
  network: ReturnType<typeof createWorkbenchNetwork>;
  database: BifrostDatabase;
}) => {
  const { provider, network, database } = args;
  const tags = { Name: USAGE_EXPORT_FUNCTION_NAME, Project: "bifrost-usage-export" };

  // -------------------------------------------------------------------------
  // The bucket.
  //
  // Follows `deploy/components/worker.ts`'s reviews bucket: public access blocked
  // on all four settings, SSE-S3, versioning, and a bucket policy. Read this
  // bucket's comments before changing any of them; each one has a failure mode.
  // -------------------------------------------------------------------------
  const bucket = new aws.s3.BucketV2(
    "bifrostUsageExportBucket",
    {
      bucket: BUCKET_NAME,
      tags,
    },
    { provider },
  );

  new aws.s3.BucketPublicAccessBlock(
    "bifrostUsageExportBucketPublicAccess",
    {
      bucket: bucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    },
    { provider },
  );

  /**
   * SSE-S3, not SSE-KMS, and that is a deliberate choice about cross-account
   * policy. Databricks' own S3 external-location instructions say that with KMS
   * "you must update your KMS key policy in AWS to grant access to the Unity
   * Catalog IAM role" — a second cross-account policy to write and keep right.
   * SSE-S3 needs none. `worker.ts` makes the same choice for the reviews bucket.
   */
  new aws.s3.BucketServerSideEncryptionConfigurationV2(
    "bifrostUsageExportBucketEncryption",
    {
      bucket: bucket.id,
      rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
    },
    { provider },
  );

  /**
   * Versioning on, with **no lifecycle rule** and that is not an oversight.
   *
   * The design says a run never rewrites a file, and two things enforce it: this,
   * so an overwrite leaves the earlier object as a noncurrent version rather than
   * destroying it, and `IfNoneMatch: "*"` on the PUT, so an overwrite is refused
   * at the store in the first place. A rule expiring noncurrent versions would
   * delete the recovery copy that versioning exists to keep, so there is not one.
   *
   * There is no expiry rule on current objects either: these files are the copy
   * that outlives the database's 90-day retention and the record that makes any
   * day reproducible as of any run. A day's file is well under a megabyte.
   *
   * No abort-multipart rule: the export makes one `PutObject`, so a multipart rule
   * would guard a code path this design does not have. `l2_voter_files_storage.tf`
   * in the other repo carries one because its DAG does upload in parts.
   */
  new aws.s3.BucketVersioningV2(
    "bifrostUsageExportBucketVersioning",
    {
      bucket: bucket.id,
      versioningConfiguration: { status: "Enabled" },
    },
    { provider },
  );

  /**
   * The bucket policy: read-only for one role in the management account, and a
   * write-only statement for the swarm host in the infrastructure account.
   *
   * Two statements for the read because S3 needs both halves of a prefix-scoped
   * read: an object action on the objects and `ListBucket` on the bucket itself.
   * The list is `s3:prefix`-conditioned, so the credential cannot enumerate the
   * bucket, only the one prefix it is given.
   *
   * The principal is the account root with an `ArnEquals aws:PrincipalArn`
   * condition rather than the role ARN as `Principal`. See the module header: S3
   * validates named principals, so the role cannot be named before it exists, and
   * the condition is exactly as narrow.
   *
   * ## The swarm host's write, and why it is a bucket-policy statement too
   *
   * The delegate swarm exporter writes two of its own prefixes here
   * (`delegate-swarm/session-cost/` and `delegate-swarm/task-edge/`; see
   * `agent-swarm/host/export-usage-core.ts`). Its role lives in the
   * infrastructure account, so this is a cross-account write: both sides of the
   * request are evaluated, and the identity grant in
   * `deploy-infrastructure/agent-swarm.ts` alone would be refused by this bucket.
   *
   * `s3:PutObject` only. No read, no list, no delete, and no version permission:
   * the exporter writes a new key per run and never reads one back. The statement
   * carries `StringEquals s3:if-none-match: "*"`, so the conditional write is
   * required by the grant and not only chosen by the script. Versioning behind
   * that is the recovery copy.
   *
   * Object ownership is the default `BucketOwnerEnforced` for a bucket created
   * today, which is what makes this writable without an ACL: the object belongs
   * to this account whatever the writer's. It also means the Databricks role
   * reads the swarm's objects under the same statement as the gateway's, so the
   * two new prefixes need no second grant on the read side.
   */
  new aws.s3.BucketPolicy(
    "bifrostUsageExportBucketPolicy",
    {
      bucket: bucket.id,
      policy: pulumi
        .all([
          bucket.arn,
          pulumi.output(`arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/${USAGE_EXPORT_READER_ROLE_NAME}`),
          pulumi.output(
            `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/${SWARM_HOST_ROLE_NAME}`,
          ),
        ])
        .apply(([bucketArn, roleArn, swarmHostRoleArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "DatabricksReadExportObjects",
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:root` },
                Action: ["s3:GetObject", "s3:GetObjectVersion"],
                Resource: READ_PREFIXES.map((prefix) => `${bucketArn}/${prefix}/*`),
                Condition: { ArnEquals: { "aws:PrincipalArn": roleArn } },
              },
              {
                Sid: "DatabricksListExportPrefix",
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:root` },
                Action: "s3:ListBucket",
                Resource: bucketArn,
                Condition: {
                  ArnEquals: { "aws:PrincipalArn": roleArn },
                  StringLike: {
                    "s3:prefix": READ_PREFIXES.flatMap((prefix) => [prefix, `${prefix}/*`]),
                  },
                },
              },
              {
                // The cross-account call needs the bucket policy to allow this as
                // well as the role's identity policy, because both sides of a
                // cross-account request are evaluated. Without it the external
                // location's validation at apply can fail AccessDenied on a
                // bucket the role is otherwise allowed to read.
                Sid: "DatabricksReadBucketLocation",
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:root` },
                Action: "s3:GetBucketLocation",
                Resource: bucketArn,
                Condition: { ArnEquals: { "aws:PrincipalArn": roleArn } },
              },
              {
                // The swarm host's exporter. Cross-account, so this bucket has to
                // allow it as well as the host role; see the comment above. Write
                // only, on the two prefixes and never the bucket itself, so the
                // host cannot enumerate what is there.
                //
                // The `s3:if-none-match` condition is deliberate, and it is what
                // makes "a run never replaces a file" true of the grant rather
                // than of one script. It requires every PUT under these prefixes
                // to carry `If-None-Match: *`, so the store refuses an overwrite
                // for any caller holding the host role, not only for the exporter
                // that remembers the header. The cost of that is a future writer
                // with a different code path being refused with a 412 it does not
                // expect; a 412 here therefore means "that key already exists",
                // never "permission denied", and the reader of a 412 should check
                // the key before the policy.
                Sid: "SwarmHostWriteExportObjects",
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:root` },
                Action: "s3:PutObject",
                Resource: SWARM_EXPORT_PREFIXES.map((prefix) => `${bucketArn}/${prefix}/*`),
                Condition: {
                  ArnEquals: { "aws:PrincipalArn": swarmHostRoleArn },
                  StringEquals: { "s3:if-none-match": "*" },
                },
              },
            ],
          }),
        ),
    },
    { provider },
  );

  // -------------------------------------------------------------------------
  // The export's own secret.
  //
  // A Pulumi-owned container with no value in it. The bootstrap writes the
  // password; nothing in this stack ever reads it, which is what keeps
  // `pulumi preview` working without `secretsmanager:GetSecretValue` on this
  // value. It exists as a resource rather than being created by the bootstrap so
  // that it survives a rotation and so that the grant below can name a real ARN.
  // -------------------------------------------------------------------------
  const exportSecret = new aws.secretsmanager.Secret(
    "bifrostUsageExportSecret",
    {
      name: USAGE_EXPORT_SECRET_NAME,
      description:
        "Password for the Bifrost usage export's read-only Postgres role. Written by the bootstrap Lambda, read by the export.",
      tags,
    },
    { provider },
  );

  // -------------------------------------------------------------------------
  // The export function.
  // -------------------------------------------------------------------------
  const exportSecurityGroup = new aws.ec2.SecurityGroup(
    "bifrostUsageExportSecurityGroup",
    {
      // Inline rather than the constant, and `security-group-descriptions.test.ts`
      // is why: it resolves a name statically so it can check AWS's charset
      // before an apply discovers it. The constant and this literal are pinned
      // equal by `usage-export.test.ts`.
      name: "bifrost-usage-export",
      description:
        "Bifrost usage export Lambda: 5432 to the database, 443 out for AWS APIs, DNS to the VPC resolver. No ingress rules.",
      vpcId: network.vpc.id,
      tags,
    },
    { provider },
  );
  egressRulesFor(
    { provider, name: "bifrostUsageExport", securityGroupId: exportSecurityGroup.id },
    network,
  );

  const exportLogGroup = new aws.cloudwatch.LogGroup(
    "bifrostUsageExportLogGroup",
    {
      name: USAGE_EXPORT_LOG_GROUP_NAME,
      retentionInDays: USAGE_EXPORT_LOG_RETENTION_DAYS,
      tags,
    },
    { provider },
  );

  /**
   * The export's role: read its own secret, write the prefix, log.
   *
   * Deliberately **no** access to the master secret. The two roles' policies are
   * the boundary between the permanent function and the temporary one, and
   * `usage-export.test.ts` asserts that this document names no `secretsmanager:`
   * action beyond reading its own secret.
   */
  const exportRole = new aws.iam.Role(
    "bifrostUsageExportRole",
    {
      name: USAGE_EXPORT_ROLE_NAME,
      description:
        "Bifrost usage export Lambda: reads its database password, writes Parquet to the export bucket, logs.",
      assumeRolePolicy: JSON.stringify(lambdaTrust),
      // Required for `vpcConfig`. Without it `CreateFunction` is refused with
      // "the execution role does not have permissions to call
      // CreateNetworkInterface on EC2", which fails the apply rather than the
      // run. The mint and the janitor attach the same managed policy.
      managedPolicyArns: [LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN],
      tags,
    },
    { provider },
  );

  const exportRolePolicy = new aws.iam.RolePolicy(
    "bifrostUsageExportRolePolicy",
    {
      name: "usage-export",
      role: exportRole.id,
      // The log group's ARN has to be lifted into this `pulumi.all`, not read
      // with its own `.apply` inside the callback: `JSON.stringify` on a nested
      // `Output` does not produce the value, it produces Pulumi's "Calling
      // [toJSON] on an [Output<T>] is not supported" message, which would land
      // in the policy as the Resource string. Verified by running it.
      policy: pulumi
        .all([exportSecret.arn, bucket.arn, exportLogGroup.arn])
        .apply(([secretArn, bucketArn, logGroupArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "ReadOwnPassword",
              Effect: "Allow",
              Action: "secretsmanager:GetSecretValue",
              Resource: secretArn,
            },
            {
              Sid: "WriteExportObject",
              Effect: "Allow",
              Action: "s3:PutObject",
              Resource: `${bucketArn}/${EXPORT_PREFIX}/*`,
            },
            {
              Sid: "Log",
              Effect: "Allow",
              Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
              Resource: `${logGroupArn}:*`,
            },
          ],
        }),
      ),
    },
    { provider },
  );

  const exportFunction = new aws.lambda.Function(
    "bifrostUsageExport",
    {
      name: USAGE_EXPORT_FUNCTION_NAME,
      description:
        "Reads the Bifrost gateway's logs table and writes one Parquet object per run for the finance mart (DATA-2808).",
      role: exportRole.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: buildUsageExportCode(),
      timeout: USAGE_EXPORT_TIMEOUT_SECONDS,
      memorySize: USAGE_EXPORT_MEMORY_MB,
      reservedConcurrentExecutions: USAGE_EXPORT_RESERVED_CONCURRENCY,
      vpcConfig: {
        subnetIds: network.privateSubnetIds,
        securityGroupIds: [exportSecurityGroup.id],
      },
      environment: {
        variables: {
          EXPORT_BUCKET: bucket.bucket,
          EXPORT_PREFIX,
          EXPORT_SECRET_NAME: USAGE_EXPORT_SECRET_NAME,
          PG_HOST: database.address,
          PG_PORT: database.port.apply(String),
          PG_DATABASE: DATABASE_NAME,
          // The role the bootstrap creates, not the master user. One constant,
          // shared with the bootstrap's DDL, so the two cannot disagree.
          PG_USER: USAGE_EXPORT_DB_ROLE,
        },
      },
      tags,
    },
    { provider, dependsOn: [exportLogGroup, exportRolePolicy] },
  );

  // -------------------------------------------------------------------------
  // The two schedule rules.
  //
  // Two rules means two `aws.lambda.Permission` resources, and neither gets a
  // literal `statementId`: Lambda refuses a duplicate id on one function's
  // resource policy (a 409 that the apply reports as "The statement id already
  // exists"), so Pulumi derives a distinct one per resource. The janitor's header
  // records the same trap.
  // -------------------------------------------------------------------------
  const dailyRule = new aws.cloudwatch.EventRule(
    "bifrostUsageExportDaily",
    {
      name: `${USAGE_EXPORT_FUNCTION_NAME}-daily`,
      description: `Reads the last ${USAGE_EXPORT_DAILY_WINDOW_DAYS} days of Bifrost gateway usage and writes one Parquet object.`,
      scheduleExpression: USAGE_EXPORT_DAILY_SCHEDULE,
      tags,
    },
    { provider },
  );

  new aws.cloudwatch.EventTarget(
    "bifrostUsageExportDailyTarget",
    {
      rule: dailyRule.name,
      arn: exportFunction.arn,
      input: JSON.stringify({ window_days: USAGE_EXPORT_DAILY_WINDOW_DAYS }),
    },
    { provider },
  );

  new aws.lambda.Permission(
    "bifrostUsageExportDailyPermission",
    {
      action: "lambda:InvokeFunction",
      function: exportFunction.name,
      principal: "events.amazonaws.com",
      sourceArn: dailyRule.arn,
    },
    { provider },
  );

  const monthlyRule = new aws.cloudwatch.EventRule(
    "bifrostUsageExportMonthly",
    {
      name: `${USAGE_EXPORT_FUNCTION_NAME}-monthly`,
      description: `Reads the last ${USAGE_EXPORT_MONTHLY_WINDOW_DAYS} days of Bifrost gateway usage and writes one Parquet object.`,
      scheduleExpression: USAGE_EXPORT_MONTHLY_SCHEDULE,
      tags,
    },
    { provider },
  );

  new aws.cloudwatch.EventTarget(
    "bifrostUsageExportMonthlyTarget",
    {
      rule: monthlyRule.name,
      arn: exportFunction.arn,
      input: JSON.stringify({ window_days: USAGE_EXPORT_MONTHLY_WINDOW_DAYS }),
    },
    { provider },
  );

  new aws.lambda.Permission(
    "bifrostUsageExportMonthlyPermission",
    {
      action: "lambda:InvokeFunction",
      function: exportFunction.name,
      principal: "events.amazonaws.com",
      sourceArn: monthlyRule.arn,
    },
    { provider },
  );

  // -------------------------------------------------------------------------
  // The alert topic and the two alarms.
  // -------------------------------------------------------------------------
  const alertTopic = new aws.sns.Topic(
    "bifrostUsageExportAlertTopic",
    {
      name: USAGE_EXPORT_ALERT_TOPIC_NAME,
      tags,
    },
    { provider },
  );

  /**
   * **Unconfirmed until someone clicks the link in AWS's email.** An unconfirmed
   * subscription means a firing alarm is delivered to nobody and nothing in the
   * apply reports it. `bifrost-vk-janitor.ts` and `alarms.ts` record the same
   * trap; the PR body names it as a manual step.
   */
  new aws.sns.TopicSubscription(
    "bifrostUsageExportAlertSubscription",
    {
      topic: alertTopic.arn,
      protocol: "email",
      endpoint: WORKBENCH_ALERT_EMAIL,
    },
    { provider },
  );

  // CloudWatch publishes as the CloudWatch service principal, which the default
  // topic policy does not admit. The condition is the account rather than the
  // alarm ARN, so the topic policy and the alarms do not depend on each other.
  new aws.sns.TopicPolicy(
    "bifrostUsageExportAlertTopicPolicy",
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
              Condition: { StringEquals: { "aws:SourceAccount": WORKBENCH_ACCOUNT_ID } },
            },
          ],
        }),
      ),
    },
    { provider },
  );

  /**
   * A run that started and failed.
   *
   * `evaluationPeriods: 1` and `period: 300`, and the janitor's 3 must not be
   * copied here: it alarms on three consecutive five-minute periods because it
   * runs every five minutes, so three periods is three failed runs. This job runs
   * once a day, and three five-minute periods would need three failures inside a
   * quarter hour, which it can never produce — the alarm would sit in `OK`
   * through an outage of any length.
   */
  const failureAlarm = new aws.cloudwatch.MetricAlarm(
    "bifrostUsageExportFailureAlarm",
    {
      name: USAGE_EXPORT_FAILURE_ALARM_NAME,
      alarmDescription: `The Bifrost usage export ran and failed. Answer: docs/runbooks.md, "The Bifrost usage export is failing".`,
      namespace: "AWS/Lambda",
      metricName: "Errors",
      dimensions: { FunctionName: exportFunction.name },
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      // A function that has not run yet publishes no `Errors` datapoint. The
      // never-ran alarm below is what covers absence.
      treatMissingData: "notBreaching",
      alarmActions: [alertTopic.arn],
      tags,
    },
    { provider, dependsOn: [alertTopic, exportFunction] },
  );

  /**
   * A run that never started.
   *
   * **`treatMissingData: breaching` is the alarm.** A disabled rule, a schedule
   * that stopped matching or a delete by a bad apply produces no `Invocations`
   * datapoint at all, and `notBreaching` would read that as healthy forever — the
   * precise failure this alarm exists for. `alarms.ts` sets `breaching` on its
   * availability alarm for the same reason ("an absent datapoint here is the
   * signal").
   *
   * One day is the period because one day is the cadence, so one period is one
   * expected run. The cost of that choice, accepted: the alarm cannot evaluate a
   * day until it closes, so a silent stop is noticed up to a day late. For a job
   * whose data is reproduced by the next run and whose bucket keeps every file,
   * that is the right trade; anything tighter would need a heartbeat metric.
   */
  const neverRanAlarm = new aws.cloudwatch.MetricAlarm(
    "bifrostUsageExportNeverRanAlarm",
    {
      name: USAGE_EXPORT_NEVER_RAN_ALARM_NAME,
      alarmDescription: `The Bifrost usage export has not run for a day. Answer: docs/runbooks.md, "The Bifrost usage export is failing".`,
      namespace: "AWS/Lambda",
      metricName: "Invocations",
      dimensions: { FunctionName: exportFunction.name },
      statistic: "Sum",
      period: USAGE_EXPORT_NEVER_RAN_PERIOD_SECONDS,
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator: "LessThanThreshold",
      treatMissingData: "breaching",
      alarmActions: [alertTopic.arn],
      tags,
    },
    { provider, dependsOn: [alertTopic, exportFunction] },
  );

  // -------------------------------------------------------------------------
  // The bootstrap function, which exists to be removed.
  //
  // The only thing in this ticket that touches the RDS master credential. It has
  // no schedule and no trigger other than the deploy workflow's invoke, and its
  // resource is deleted in a follow-up PR once the export has run. The source
  // stays committed, because that is what makes rotation possible later.
  //
  // Its role holds two privileges the export's does not: read of the master
  // secret, and write on the export's own secret, which is how it provisions.
  // Without the second the DDL would commit and the write would fail with
  // `AccessDenied`, leaving a role that exists with a password nobody holds.
  // -------------------------------------------------------------------------
  const bootstrapSecurityGroup = new aws.ec2.SecurityGroup(
    "bifrostUsageExportBootstrapSecurityGroup",
    {
      name: "bifrost-usage-export-db-bootstrap",
      description:
        "Bifrost usage export bootstrap Lambda: 5432 to the database, 443 out for AWS APIs, DNS to the VPC resolver. No ingress rules.",
      vpcId: network.vpc.id,
      tags: { Name: USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME, Project: "bifrost-usage-export" },
    },
    { provider },
  );
  egressRulesFor(
    {
      provider,
      name: "bifrostUsageExportBootstrap",
      securityGroupId: bootstrapSecurityGroup.id,
    },
    network,
  );

  const bootstrapLogGroup = new aws.cloudwatch.LogGroup(
    "bifrostUsageExportBootstrapLogGroup",
    {
      name: USAGE_EXPORT_BOOTSTRAP_LOG_GROUP_NAME,
      retentionInDays: USAGE_EXPORT_LOG_RETENTION_DAYS,
      tags: { Name: USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME, Project: "bifrost-usage-export" },
    },
    { provider },
  );

  const bootstrapRole = new aws.iam.Role(
    "bifrostUsageExportBootstrapRole",
    {
      name: USAGE_EXPORT_BOOTSTRAP_ROLE_NAME,
      description:
        "Bifrost usage export bootstrap Lambda: creates the read-only Postgres role and writes its password. Removed once the export has run.",
      assumeRolePolicy: JSON.stringify(lambdaTrust),
      // Required for `vpcConfig`, same reason as the export's role above.
      managedPolicyArns: [LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN],
      tags: { Name: USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME, Project: "bifrost-usage-export" },
    },
    { provider },
  );

  const bootstrapRolePolicy = new aws.iam.RolePolicy(
    "bifrostUsageExportBootstrapRolePolicy",
    {
      name: "usage-export-bootstrap",
      role: bootstrapRole.id,
      // Same lifting as the export's policy above: every Output this document
      // needs goes into the one `pulumi.all`.
      policy: pulumi
        .all([exportSecret.arn, database.secretArn, bootstrapLogGroup.arn])
        .apply(([exportSecretArn, masterSecretArn, logGroupArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "ReadMasterPassword",
                Effect: "Allow",
                Action: "secretsmanager:GetSecretValue",
                Resource: masterSecretArn,
              },
              {
                // The no-op check reads the export's secret, and the write is how
                // it provisions. No CreateSecret: the container is the Pulumi
                // resource above, so it exists before this function can run.
                Sid: "ReadAndWriteOwnPassword",
                Effect: "Allow",
                Action: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
                Resource: exportSecretArn,
              },
              {
                Sid: "Log",
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: `${logGroupArn}:*`,
              },
            ],
          }),
        ),
    },
    { provider },
  );

  const bootstrapFunction = new aws.lambda.Function(
    "bifrostUsageExportBootstrap",
    {
      name: USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME,
      description:
        "Creates the Bifrost usage export's read-only Postgres role and writes its password. Invoked by the deploy; removed once the export has run.",
      role: bootstrapRole.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: buildUsageExportBootstrapCode(),
      timeout: USAGE_EXPORT_BOOTSTRAP_TIMEOUT_SECONDS,
      memorySize: USAGE_EXPORT_BOOTSTRAP_MEMORY_MB,
      reservedConcurrentExecutions: USAGE_EXPORT_RESERVED_CONCURRENCY,
      vpcConfig: {
        subnetIds: network.privateSubnetIds,
        securityGroupIds: [bootstrapSecurityGroup.id],
      },
      environment: {
        variables: {
          EXPORT_SECRET_NAME: USAGE_EXPORT_SECRET_NAME,
          MASTER_SECRET_ARN: database.secretArn,
          PG_HOST: database.address,
          PG_PORT: database.port.apply(String),
          PG_DATABASE: DATABASE_NAME,
          PG_MASTER_USER: DATABASE_USERNAME,
        },
      },
      tags: { Name: USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME, Project: "bifrost-usage-export" },
    },
    { provider, dependsOn: [bootstrapLogGroup, bootstrapRolePolicy] },
  );

  // -------------------------------------------------------------------------
  // The database's first two ingress exceptions.
  //
  // `network.ts` admits 5432 from the task group and nothing else. These two are
  // the exceptions, both referenced by group and never by CIDR, so each admits
  // one named principal and nothing addressable. They are declared here rather
  // than in `network.ts` because they are this job's, exactly as the two 8080
  // exceptions live in the modules that need them.
  //
  // `rds.test.ts` walks **every** Pulumi file for a rule on this group and
  // asserts the total is three, so a fourth cannot be added anywhere without
  // that test failing.
  // -------------------------------------------------------------------------
  new aws.vpc.SecurityGroupIngressRule(
    "bifrostDatabaseIngressUsageExport",
    {
      securityGroupId: network.databaseSecurityGroup.id,
      description:
        "postgres from the usage export Lambda: selects 29 named columns, cannot write",
      ipProtocol: "tcp",
      fromPort: POSTGRES_PORT,
      toPort: POSTGRES_PORT,
      referencedSecurityGroupId: exportSecurityGroup.id,
    },
    { provider },
  );

  new aws.vpc.SecurityGroupIngressRule(
    "bifrostDatabaseIngressUsageExportBootstrap",
    {
      securityGroupId: network.databaseSecurityGroup.id,
      description:
        "postgres from the usage export bootstrap Lambda: provisions the read-only role, then no-ops",
      ipProtocol: "tcp",
      fromPort: POSTGRES_PORT,
      toPort: POSTGRES_PORT,
      referencedSecurityGroupId: bootstrapSecurityGroup.id,
    },
    { provider },
  );

  return {
    bucket,
    bucketName: bucket.bucket,
    exportPrefix: EXPORT_PREFIX,
    function: exportFunction,
    functionName: exportFunction.name,
    role: exportRole,
    logGroup: exportLogGroup,
    dailyRule,
    monthlyRule,
    alertTopic,
    failureAlarm,
    neverRanAlarm,
    bootstrapFunction,
    bootstrapFunctionName: bootstrapFunction.name,
    exportSecret,
    /** The ARN string the terraform repo's role is created under, for the PR body. */
    readerRoleArn: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/${USAGE_EXPORT_READER_ROLE_NAME}`,
    region: REGION,
  };
};

export type BifrostUsageExport = ReturnType<typeof createBifrostUsageExport>;
