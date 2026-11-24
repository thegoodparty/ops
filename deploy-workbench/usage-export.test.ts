import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { MANAGEMENT_ACCOUNT_ID } from "../utils/accounts";
import {
  USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME,
  USAGE_EXPORT_DAILY_SCHEDULE,
  USAGE_EXPORT_FUNCTION_NAME,
  USAGE_EXPORT_FAILURE_ALARM_NAME,
  USAGE_EXPORT_MONTHLY_SCHEDULE,
  USAGE_EXPORT_NEVER_RAN_ALARM_NAME,
  USAGE_EXPORT_NEVER_RAN_PERIOD_SECONDS,
  USAGE_EXPORT_RESERVED_CONCURRENCY,
  USAGE_EXPORT_TIMEOUT_SECONDS,
} from "./bifrost/usage-export-contract";

/**
 * The usage export's Pulumi program, checked as source.
 *
 * The resources themselves are exercised by CI's `pulumi preview`; what a unit
 * test can pin is the handful of properties a review is actually about, and the
 * ones that fail silently if they are wrong. The two that matter most:
 *
 * - **The bucket policy admits the management account, not this one.** Under the
 *   approved design the Databricks role lives in the account
 *   `gp-terraform-dataplatform` deploys into. Getting this wrong applies cleanly
 *   and denies every read.
 * - **The never-ran alarm treats missing data as breaching.** With the provider's
 *   default it could never fire on a function that had been deleted, which is the
 *   one thing it exists for.
 */

const SOURCE = fs.readFileSync(path.resolve(__dirname, "usage-export.ts"), "utf8");

/**
 * A resource block by its logical name, the way `ingress.test.ts` reads one.
 *
 * Sliced to the **next** `new aws.` declaration rather than to a fixed width: the
 * alarm blocks are long, and a fixed window would either truncate them or spill
 * into the next resource's properties and make the assertions pass for the wrong
 * reason.
 */
const resourceBlock = (logicalName: string): string => {
  const start = SOURCE.indexOf(`"${logicalName}"`);
  assert.notEqual(start, -1, `usage-export.ts does not declare ${logicalName}`);
  const next = SOURCE.indexOf("new aws.", start);
  return SOURCE.slice(start, next === -1 ? undefined : next);
};

describe("bifrost usage export", () => {
  it("admits the Databricks role in the management account, not this one", () => {
    const policy = resourceBlock("bifrostUsageExportBucketPolicy");
    assert.ok(
      policy.includes("MANAGEMENT_ACCOUNT_ID"),
      "the bucket policy must be built from MANAGEMENT_ACCOUNT_ID: the Databricks role is in that account",
    );
    assert.ok(
      !/WORKBENCH_ACCOUNT_ID/.test(policy),
      "the bucket policy must not name the workbench account, which has no such role",
    );
    // The construction that lets the terraform PR land in either order: S3
    // validates a named principal, so a role that does not exist yet cannot be
    // `Principal`.
    assert.ok(policy.includes("ArnEquals"), "the role must be admitted by an aws:PrincipalArn condition");
    assert.ok(
      policy.includes("aws:PrincipalArn"),
      "the condition key must be aws:PrincipalArn",
    );
    const root = `arn:aws:iam::\${MANAGEMENT_ACCOUNT_ID}:root`;
    assert.ok(policy.includes(root), `the principal must be the management account root: ${root}`);
  });

  it("allows GetBucketLocation in the bucket policy, not only in the role's identity policy", () => {
    // Both sides of a cross-account request are evaluated, so the role granting
    // it is not enough: without the bucket policy's allow, the external
    // location's validation at apply can fail AccessDenied on a bucket the role
    // may otherwise read. The action has to carry the same principal and the same
    // `aws:PrincipalArn` narrowing as the other two statements.
    const policy = resourceBlock("bifrostUsageExportBucketPolicy");
    const location = policy.slice(policy.indexOf("DatabricksReadBucketLocation"));
    assert.ok(location.length > 0, "the bucket policy must carry a GetBucketLocation statement");
    assert.ok(location.includes('Action: "s3:GetBucketLocation"'), "the action must be GetBucketLocation");
    assert.ok(
      location.includes("MANAGEMENT_ACCOUNT_ID"),
      "it must name the management account, like the other two statements",
    );
    assert.ok(
      location.includes('"aws:PrincipalArn": roleArn'),
      "it must be narrowed to the reader role by aws:PrincipalArn",
    );
    // Bucket-level, not prefix-level: GetBucketLocation takes the bucket ARN.
    assert.ok(
      !/s3:GetBucketLocation[\s\S]{0,200}\$\{EXPORT_PREFIX\}/.test(location),
      "GetBucketLocation is a bucket action and must not be scoped to the prefix",
    );
  });

  it("keeps the bucket private, encrypted and versioned, with no expiry rule", () => {
    assert.ok(resourceBlock("bifrostUsageExportBucketPublicAccess").includes("blockPublicPolicy: true"));
    assert.ok(resourceBlock("bifrostUsageExportBucketPublicAccess").includes("restrictPublicBuckets: true"));
    assert.ok(resourceBlock("bifrostUsageExportBucketEncryption").includes('sseAlgorithm: "AES256"'));
    assert.ok(resourceBlock("bifrostUsageExportBucketVersioning").includes('status: "Enabled"'));
    // The files are the copy that outlives the database, and a noncurrent-version
    // rule would delete the recovery copy versioning exists to keep.
    assert.ok(
      !SOURCE.includes("BucketLifecycleConfigurationV2"),
      "the export bucket must have no lifecycle rule, on current or noncurrent objects",
    );
  });

  it("sets the never-ran alarm to breaching on missing data", () => {
    const alarm = resourceBlock("bifrostUsageExportNeverRanAlarm");
    assert.ok(
      alarm.includes("name: USAGE_EXPORT_NEVER_RAN_ALARM_NAME"),
      "the alarm must take its name from the contract module",
    );
    // And the constant is the name the runbook and `pulumi stack output` use.
    assert.equal(USAGE_EXPORT_NEVER_RAN_ALARM_NAME, "bifrost-usage-export-never-ran");
    assert.ok(alarm.includes('metricName: "Invocations"'));
    assert.ok(alarm.includes("LessThanThreshold"));
    assert.ok(alarm.includes(`period: USAGE_EXPORT_NEVER_RAN_PERIOD_SECONDS`));
    assert.ok(
      alarm.includes('treatMissingData: "breaching"'),
      "a notBreaching never-ran alarm is green forever on a deleted function",
    );
    assert.equal(USAGE_EXPORT_NEVER_RAN_PERIOD_SECONDS, 86_400);
  });

  it("sets the failure alarm to one period, unlike the janitor's three", () => {
    const alarm = resourceBlock("bifrostUsageExportFailureAlarm");
    assert.ok(
      alarm.includes("name: USAGE_EXPORT_FAILURE_ALARM_NAME"),
      "the alarm must take its name from the contract module",
    );
    assert.equal(USAGE_EXPORT_FAILURE_ALARM_NAME, "bifrost-usage-export-failed");
    assert.ok(alarm.includes('metricName: "Errors"'));
    assert.ok(
      alarm.includes("evaluationPeriods: 1"),
      "a daily job with three five-minute periods can never alarm",
    );
    assert.ok(alarm.includes('treatMissingData: "notBreaching"'));
  });

  it("runs two rules a half hour apart, for the throttle reason", () => {
    assert.equal(USAGE_EXPORT_DAILY_SCHEDULE, "cron(0 9 * * ? *)");
    assert.equal(USAGE_EXPORT_MONTHLY_SCHEDULE, "cron(30 9 1 * ? *)");
    assert.ok(SOURCE.includes("USAGE_EXPORT_DAILY_SCHEDULE"));
    assert.ok(SOURCE.includes("USAGE_EXPORT_MONTHLY_SCHEDULE"));
    assert.equal(USAGE_EXPORT_RESERVED_CONCURRENCY, 1);
    assert.equal(USAGE_EXPORT_TIMEOUT_SECONDS, 900);
  });

  it("gives each rule its own permission with no literal statement id", () => {
    const permissions = [...SOURCE.matchAll(/new aws\.lambda\.Permission\(/g)];
    assert.equal(permissions.length, 2, "two rules need two permissions");
    assert.ok(
      !SOURCE.includes("statementId:"),
      "a literal statementId makes the second AddPermission a 409; Pulumi must derive them",
    );
  });

  it("gives the bootstrap the master secret and the export secret, and the export neither master nor write", () => {
    const bootstrap = resourceBlock("bifrostUsageExportBootstrapRolePolicy");
    assert.ok(bootstrap.includes('Sid: "ReadMasterPassword"'));
    assert.ok(bootstrap.includes("secretsmanager:PutSecretValue"), "the bootstrap writes the password");
    assert.ok(bootstrap.includes("secretsmanager:GetSecretValue"));

    const exporter = resourceBlock("bifrostUsageExportRolePolicy");
    assert.ok(
      !exporter.includes("PutSecretValue"),
      "the export only reads its password",
    );
    assert.ok(
      !exporter.includes("MASTER"),
      "the export must hold no grant on the master secret",
    );
  });

  it("adds exactly two database ingress exceptions, both group references", () => {
    const exportIngress = resourceBlock("bifrostDatabaseIngressUsageExport");
    const bootstrapIngress = resourceBlock("bifrostDatabaseIngressUsageExportBootstrap");
    for (const [name, block] of [
      ["export", exportIngress],
      ["bootstrap", bootstrapIngress],
    ] as const) {
      assert.ok(block.includes("referencedSecurityGroupId:"), `${name} must be a group reference`);
      assert.ok(!block.includes("cidrIpv4"), `${name} must not admit a CIDR`);
    }
  });

  it("attaches the VPC-access managed policy to both roles", () => {
    // Without it `CreateFunction` is refused with "the execution role does not
    // have permissions to call CreateNetworkInterface on EC2", so the apply fails
    // and neither function exists. Both existing VPC Lambdas attach it.
    for (const role of ["bifrostUsageExportRole", "bifrostUsageExportBootstrapRole"]) {
      assert.ok(
        resourceBlock(role).includes("managedPolicyArns: [LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN]"),
        `${role} needs the VPC-access managed policy`,
      );
    }
  });

  it("lifts every log-group ARN into the outer apply, never nesting an Output", () => {
    // `JSON.stringify` on a nested Output produces Pulumi's "Calling [toJSON] on
    // an [Output<T>] is not supported" message rather than the value, and that
    // string would land in the policy as the Resource. Verified by running it.
    // The pattern that was wrong: an `.apply` on a log group's ARN, evaluated
    // inside a `JSON.stringify` callback whose other inputs came from an outer
    // `pulumi.all`. `alertTopic.arn.apply(...)` is the correct shape — it *is* the
    // outer apply, and its whole document is computed inside it — so this looks
    // for the log group specifically rather than for `.arn.apply` in general.
    assert.ok(
      !/logGroup\.arn\.apply\(/.test(SOURCE) && !/LogGroup\.arn\.apply\(/.test(SOURCE),
      "a log-group ARN must be lifted into the outer pulumi.all, not read with its own .apply",
    );
    for (const policy of ["bifrostUsageExportRolePolicy", "bifrostUsageExportBootstrapRolePolicy"]) {
      assert.ok(
        resourceBlock(policy).includes("pulumi\n        .all([") ||
          resourceBlock(policy).includes("pulumi.all(["),
        `${policy} must gather its Outputs in one pulumi.all`,
      );
    }
    // And the log ARN actually reaches the document.
    assert.ok(SOURCE.includes("Resource: `${logGroupArn}:*`"));
  });

  it("uses the contract's names for both security groups", () => {
    // The `name` field is a literal in the source so `security-group-descriptions.
    // test.ts` can resolve it statically — it checks AWS's charset before an
    // apply discovers it — so the two have to be pinned equal here or a rename in
    // the contract would silently leave the group with the old name.
    assert.ok(SOURCE.includes('name: "bifrost-usage-export",'));
    assert.ok(SOURCE.includes('name: "bifrost-usage-export-db-bootstrap",'));
    assert.equal(USAGE_EXPORT_FUNCTION_NAME, "bifrost-usage-export");
    assert.equal(USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME, "bifrost-usage-export-db-bootstrap");
  });

  it("pins the exported bucket and prefix, which two other systems must match", () => {
    // The loader's Airflow Variables and the terraform external location both
    // have to agree with these, and a drift is a silent read failure.
    assert.ok(SOURCE.includes('const BUCKET_NAME = "goodparty-workbench-bifrost-usage"'));
    assert.ok(SOURCE.includes('const EXPORT_PREFIX = "bifrost/logs"'));
    assert.ok(SOURCE.includes('const USAGE_EXPORT_READER_ROLE_NAME = "bifrost-usage-export-reader"'));
  });

  it("admits the swarm host's write as a cross-account statement, on the two prefixes only", () => {
    const policy = resourceBlock("bifrostUsageExportBucketPolicy");
    const write = policy.slice(policy.indexOf("SwarmHostWriteExportObjects"));
    assert.ok(write.length > 0, "the bucket policy must carry the swarm host's write");
    assert.ok(
      write.includes("INFRASTRUCTURE_ACCOUNT_ID"),
      "the swarm host is in the infrastructure account, so the principal has to name it",
    );
    assert.ok(write.includes('"aws:PrincipalArn": swarmHostRoleArn'));
    assert.ok(
      !/\bGet|List|Delete/.test(write.slice(0, write.indexOf("}") + 400)),
      "the grant is write only: no read, no list, no delete",
    );
  });

  it("requires the conditional PUT in the grant, not only in the script", () => {
    // The store refuses an overwrite for every caller holding the host role, not
    // only for the exporter that remembers the header. `s3:if-none-match` is a
    // condition key on PutObject.
    const policy = resourceBlock("bifrostUsageExportBucketPolicy");
    const write = policy.slice(policy.indexOf("SwarmHostWriteExportObjects"));
    assert.ok(
      write.includes('StringEquals: { "s3:if-none-match": "*" }'),
      "the swarm writer must be required to send If-None-Match: *",
    );
    // And the exporter does send it, so the condition cannot refuse its own run.
    const aws = fs.readFileSync(path.resolve(__dirname, "../agent-swarm/host/export-usage-aws.ts"), "utf8");
    assert.ok(aws.includes('"--if-none-match"'));
    assert.match(aws, /"--if-none-match",\s*"\*"/);
  });

  it("reads the swarm's two prefixes with the same Databricks role", () => {
    // One statement per action over one list, so a prefix cannot be granted the
    // objects half and miss the list half: that fails as an empty day rather than
    // an error.
    const policy = resourceBlock("bifrostUsageExportBucketPolicy");
    assert.ok(policy.includes("READ_PREFIXES"));
    assert.ok(SOURCE.includes('const SWARM_EXPORT_PREFIXES = ["delegate-swarm/session-cost", "delegate-swarm/task-edge"]'));
    assert.ok(SOURCE.includes("const READ_PREFIXES = [EXPORT_PREFIX, ...SWARM_EXPORT_PREFIXES]"));
    // And the terraform external location must be a sibling of bifrost/logs, not
    // inside it.
    assert.ok(!SOURCE.includes("bifrost/logs/delegate-swarm"));
  });
});
