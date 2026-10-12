import * as path from "node:path";
import * as esbuild from "esbuild";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";
import { DEFAULT_APPROVAL_CHANNEL } from "./sheriff/config";

/**
 * The break-glass Lambda, step 3 ("the Lambda, dry") of `docs/sheriff.md`,
 * in the infrastructure account.
 *
 * Everything here takes the explicit provider from `index.ts`; the default
 * provider is disabled in `deploy.sh`, so a resource that omits `{ provider }`
 * fails the apply rather than landing in the management account.
 *
 * Step 3 is dry: the Lambda writes request records and posts to Slack, but it
 * gets **no** `sts:AssumeRole` on `sheriff-grant` and **no**
 * `identitystore` permission. Step 4 wires the real grant. The execution role
 * is named `sheriff`, matching the exact role ARN the management-account
 * grant role trusts (`deploy/components/sheriff-grant.ts`); the two names must
 * stay in lockstep or step 4's first AssumeRole is an AccessDenied, not an
 * apply-time error.
 */

const NAME = "sheriff";
const REGION = "us-west-2";

/** Matches the `PrincipalArn` condition on the `sheriff-grant` role. */
export const SHERIFF_ROLE_NAME = NAME;

export const SHERIFF_TABLE_NAME = "sheriff";
// The Slack app is `@sheriff`, expected to grow beyond break-glass to other
// privileged ops, so its credentials secret is app-scoped (`sheriff`). The
// table below is the break-glass workflow's request records and now shares the
// app's name; that is deliberate, and safe because Secrets Manager and
// DynamoDB are separate namespaces.
export const SHERIFF_SECRET_NAME = "sheriff";
export const SHERIFF_LOG_GROUP = `/aws/lambda/${NAME}`;

const TAGS = { Name: NAME, Project: NAME };

/**
 * Lambda only. Exported so the test can pin it without standing up Pulumi.
 */
export const breakGlassLambdaTrust = {
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
 * The whole grant for the dry flow, and nothing else: read its own secret,
 * read/write the one request table, write its own log group.
 *
 * Deliberately absent, and asserted by the test:
 *
 * - `sts:AssumeRole` on `sheriff-grant` (step 4 adds it, on exactly that
 *   one ARN).
 * - every `identitystore:*` action (step 4).
 * - `DELEGATES` or any secret but the tool's own.
 *
 * `dynamodb:Query` and `dynamodb:Scan` are absent too: step 3 only gets,
 * puts and conditionally updates request records and rate counters. Step 4
 * adds `Query` when it looks up active grants.
 */
export const breakGlassLambdaPolicy = {
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
      Sid: "RequestTable",
      Effect: "Allow",
      Action: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
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
export const buildBreakGlassCode = (): pulumi.asset.AssetArchive => {
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

export const createBreakGlass = (args: { provider: aws.Provider }) => {
  const { provider } = args;

  // Created empty, filled out of band: see the manual steps in
  // `docs/sheriff.md`. No secret value is ever committed or set by
  // Pulumi, matching the `DELEGATE_SWARM` secret's handling.
  const secret = new aws.secretsmanager.Secret(
    "breakGlassSlackSecret",
    {
      name: SHERIFF_SECRET_NAME,
      description:
        "Sheriff Slack app credentials (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN). Filled by hand; never by Pulumi.",
      tags: TAGS,
    },
    { provider, protect: true },
  );

  // Single table for step 3: request records and per-user rate counters. Step
  // 4 adds grant items under a different key prefix, no migration.
  const table = new aws.dynamodb.Table(
    "breakGlassRequests",
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
    "breakGlassLogs",
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
    "breakGlassLambdaRole",
    {
      name: SHERIFF_ROLE_NAME,
      description:
        "Sheriff Lambda execution role. Step 3 (dry) holds only DynamoDB, logs and its own secret; step 4 adds sts:AssumeRole on sheriff-grant.",
      assumeRolePolicy: JSON.stringify(breakGlassLambdaTrust),
      tags: TAGS,
    },
    { provider },
  );

  const lambdaPolicy = new aws.iam.RolePolicy(
    "breakGlassLambdaPolicy",
    {
      name: NAME,
      role: role.name,
      policy: JSON.stringify(breakGlassLambdaPolicy),
    },
    { provider },
  );

  const fn = new aws.lambda.Function(
    "breakGlass",
    {
      name: NAME,
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: buildBreakGlassCode(),
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
    "breakGlassUrl",
    {
      functionName: fn.name,
      authorizationType: "NONE",
    },
    { provider },
  );

  return { fn, url: functionUrl.functionUrl, secret, table, logGroup };
};
