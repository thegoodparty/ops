import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

import { MANAGEMENT_ACCOUNT_ID, WORKBENCH_ACCOUNT_ID } from "../utils/accounts";
import { VK_READER_SESSION_NAME } from "../deploy/components/bifrost-vk-reader";
import { BIFROST_DISCOVERY_DNS_NAME, type BifrostDiscovery } from "./discovery";
import { secretArnPattern } from "./ecs";
import {
  BIFROST_PORT,
  REGION,
  VPC_CIDR,
  type createWorkbenchNetwork,
} from "./network";

/**
 * The Bifrost virtual-key mint Lambda: step 3 of
 * `docs/bifrost-virtual-keys.md`.
 *
 * What this module owns:
 *
 * - the function itself, its execution role (named exactly `bifrost-vk-mint`,
 *   the literal the merged `bifrost-vk-reader` trust depends on), and its log
 *   group;
 * - the Function URL with `AuthType: AWS_IAM`, which is how a caller arrives
 *   SigV4-signed and how the function learns who called it (decision 2);
 * - its VPC attachment to the gateway's private subnets, its own security
 *   group, and the **new ingress rule on `bifrostTaskSecurityGroup` for 8080**;
 * - the SSM `String` parameter that stores the committed key template, and the
 *   read grant on the setup token.
 *
 * What it deliberately does not own:
 *
 * - the template file itself (`bifrost/vk-mint-template.json`, step 1) — this
 *   module stores the reviewed bytes and nothing else;
 * - `bifrost/vk-mint`, the secret container. Like `bifrost/gateway` and
 *   `bifrost/oauth2-proxy` it is filled out of band by
 *   `bifrost/fill-secrets.sh` (`ecs.ts` explains why nothing in this stack
 *   declares those containers); this module names it and grants read on the
 *   name pattern only, so `pulumi preview` needs no Secrets Manager permission;
 * - the invoke grant for people. That is step 4, in `deploy/`, and it is
 *   deliberately absent here: `WorkbenchAccess` gets `lambda:InvokeFunctionUrl`
 *   plus the condition-guarded `lambda:InvokeFunction` there, and a bare
 *   `InvokeFunction` in this stack would be the wrong door (decision 2).
 *
 * ## The 8080 ingress rule, which is the first exception to an invariant
 *
 * `network.ts` establishes that the task accepts 8080 and 4180 from the ALB's
 * group and from nothing else. The mint cannot go through the ALB: `/api` is
 * routed to oauth2-proxy and Google SSO at every path, and a Lambda has no
 * browser and no Google session (decision 3). So the function is attached to
 * the same private subnets and calls the task on 8080 directly, and that needs
 * one rule from the function's own group. It is the first exception and it
 * stays one: the source is a group, not a CIDR, so it is exactly this function
 * and not "anything in the VPC"; the function is IAM-gated at its own URL; and
 * the alternative — a public or proxy-bypassing admin path — is worse.
 *
 * The addressing half of that (`bifrost.workbench.local`) is `discovery.ts`,
 * with the reasoning for adding service discovery at all.
 *
 * ## The setup-token secret: decision 3's open item
 *
 * The function reads `bifrost/vk-mint`, a dedicated container holding only
 * `BIFROST_SETUP_TOKEN`, rather than `bifrost/gateway`. The gateway container
 * also holds `BIFROST_ENCRYPTION_KEY` and `FIREWORKS_API_KEY`, so a read grant
 * on it would make this small, request-facing function able to decrypt every
 * stored provider key and spend the Fireworks account, for the sake of one
 * value. The cost is a second copy of a credential the design never rotates.
 * `VK_MINT_SECRET_NAME` below is the whole switch: pointing it at
 * `bifrost/gateway` (and dropping the copy in `fill-secrets.sh`) is the
 * alternative the engineer may prefer, and it is one line because the grant is
 * derived from this constant.
 */

/**
 * The function and the role share the name on purpose. The role name is not a
 * choice: `deploy/components/bifrost-vk-reader.ts` (step 2, merged) trusts
 * exactly `arn:aws:iam::024901689212:role/bifrost-vk-mint` by name, so renaming
 * this string is an `AccessDenied` on every membership read rather than an
 * apply-time error. The function being the same name makes `describe-function`
 * and the role a single thing to look up.
 */
export const VK_MINT_NAME = "bifrost-vk-mint";
export const VK_MINT_FUNCTION_NAME = VK_MINT_NAME;
export const VK_MINT_ROLE_NAME = VK_MINT_NAME;

/** Named beside the gateway's own groups, and from the function name. */
export const VK_MINT_LOG_GROUP_NAME = `/aws/lambda/${VK_MINT_FUNCTION_NAME}`;
export const VK_MINT_LOG_RETENTION_DAYS = 30;

/** The SSM parameter the template is stored in, in the gateway's own namespace. */
export const VK_MINT_TEMPLATE_PARAMETER_NAME = "/bifrost/vk-mint-template";

/**
 * The dedicated secret (decision 3's open item). The container holds one key:
 * `BIFROST_SETUP_TOKEN`. `fill-secrets.sh` creates it if absent and copies the
 * gateway's token into it, because the two values have to be identical — the
 * gateway checks the token it was started with.
 */
export const VK_MINT_SECRET_NAME = "bifrost/vk-mint";
export const VK_MINT_SECRET_JSON_KEY = "BIFROST_SETUP_TOKEN";

/**
 * The management-account role the function assumes for the membership check
 * (decision 1, step 2). `deploy/` creates it in the management account, which
 * is where the Identity Store lives; the workbench account is the caller.
 */
export const VK_READER_ROLE_ARN = `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/bifrost-vk-reader`;

/**
 * The managed policy that lets a Lambda in a VPC create its ENIs. Without it
 * the function cannot start at all (`ENI creation is not permitted`), and it is
 * AWS's policy rather than a hand-written `ec2:CreateNetworkInterface` set for
 * the same reason `ecs.ts` uses the ECS execution policy.
 *
 * Basic execution (`AWSLambdaBasicExecutionRole`) is deliberately *not*
 * attached: it grants `logs:CreateLogGroup`, and the group below is Pulumi's.
 */
export const LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";

/** The function's timeout: two HTTP calls, one AssumeRole and one SSM read. */
export const VK_MINT_TIMEOUT_SECONDS = 30;
export const VK_MINT_MEMORY_MB = 256;

/** The repo file the parameter is built from, read at deploy time. */
export const VK_MINT_TEMPLATE_PATH = path.resolve(
  __dirname,
  "bifrost/vk-mint-template.json",
);
export const readVkMintTemplate = (): string =>
  fs.readFileSync(VK_MINT_TEMPLATE_PATH, "utf8");

/**
 * The non-secret configuration, as data so a test can pin it without standing
 * up Pulumi. Every value is a name or an address; the setup token is not here
 * and never will be, because a Lambda environment variable is readable by
 * anything that can call `GetFunctionConfiguration`.
 *
 * `BIFROST_BASE_URL` is the task's own address inside the VPC — not the ALB,
 * where `/api` is behind Google SSO — and the port comes from `network.ts`, the
 * same constant the container publishes and the security group admits.
 *
 * `READER_SESSION_NAME` is `VK_READER_SESSION_NAME`, imported from the role's
 * own module rather than retyped: it is part of that role's contract and is
 * what makes CloudTrail group every directory read under one name. The handler
 * passes it straight to `AssumeRole`.
 */
export const vkMintEnvironment = (): Record<string, string> => ({
  BIFROST_BASE_URL: `http://${BIFROST_DISCOVERY_DNS_NAME}:${BIFROST_PORT}`,
  TEMPLATE_PARAMETER_NAME: VK_MINT_TEMPLATE_PARAMETER_NAME,
  SETUP_TOKEN_SECRET_NAME: VK_MINT_SECRET_NAME,
  SETUP_TOKEN_SECRET_JSON_KEY: VK_MINT_SECRET_JSON_KEY,
  READER_ROLE_ARN: VK_READER_ROLE_ARN,
  READER_SESSION_NAME: VK_READER_SESSION_NAME,
});

/** Lambda's own trust. Nothing else may assume this role. */
export const vkMintTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
} as const;

export type PolicyStatement = {
  Sid?: string;
  Effect: "Allow";
  Action: string[];
  Resource: string[];
};

export type PolicyDocument = {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
};

/**
 * The execution role's whole grant, as data: assume the one reader role, read
 * the one setup-token secret, read the one template parameter, write its own
 * log streams.
 *
 * Deliberately absent, and asserted by `bifrost-vk-mint.test.ts`:
 *
 * - every `identitystore:*` action — the directory reads go through
 *   `bifrost-vk-reader`, whose inline policy is the scope;
 * - `kms:Decrypt` — the secret uses the account's `aws/secretsmanager` key,
 *   whose policy admits the account, the same reasoning `group-sync-lambda.ts`
 *   records;
 * - `logs:CreateLogGroup` — Pulumi creates the group;
 * - `ssm:GetParameters`, `ssm:GetParametersByPath` and every write — one
 *   parameter, read one way;
 * - `secretsmanager:GetSecretValue` on anything but the dedicated container.
 *   That is the decision recorded in the header, and the test fails if the
 *   grant widens to `bifrost/gateway`.
 */
export const vkMintExecutionPolicy = (args: {
  templateParameterArn: string;
  logGroupArn: string;
}): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AssumeVkReader",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      // Exactly one ARN. The reader role's own policy is the scoping that
      // matters; this is the only door to it.
      Resource: [VK_READER_ROLE_ARN],
    },
    {
      Sid: "ReadSetupToken",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      // Secrets Manager appends six random characters to the ARN, so the name
      // needs a wildcard; the pattern is the repo's (`ecs.ts`).
      Resource: [secretArnPattern(VK_MINT_SECRET_NAME)],
    },
    {
      Sid: "ReadTemplate",
      Effect: "Allow",
      Action: ["ssm:GetParameter"],
      Resource: [args.templateParameterArn],
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
 * same way `group-sync-lambda.ts` does: the deploy workflow runs no build step,
 * and the archive's hash follows the source, so a handler change shows up in
 * `pulumi preview` instead of waiting for someone to run `npm run build`.
 */
export const buildVkMintCode = (): pulumi.asset.AssetArchive => {
  const result = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, "bifrost/vk-mint-handler.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) {
    throw new Error("esbuild produced no output for the vk-mint handler");
  }
  return new pulumi.asset.AssetArchive({
    "handler.js": new pulumi.asset.StringAsset(output.text),
  });
};

export const createBifrostVkMint = (args: {
  provider: aws.Provider;
  network: ReturnType<typeof createWorkbenchNetwork>;
  discovery: BifrostDiscovery;
}) => {
  const { provider, network, discovery } = args;
  const tags = { Name: VK_MINT_NAME, Project: "bifrost-virtual-keys" };

  // The function's own group, created bare with each rule as its own resource
  // (`network.ts` explains why that is this project's idiom). Ingress is
  // deliberately not declared: nothing calls the function over the network; the
  // Function URL is the only way in, and AWS reaches it without a rule.
  const securityGroup = new aws.ec2.SecurityGroup(
    "bifrostVkMintSecurityGroup",
    {
      name: "bifrost-vk-mint",
      description:
        "Bifrost vk-mint Lambda: 8080 to the task, 443 out for AWS APIs, DNS to the VPC resolver. No ingress rules.",
      vpcId: network.vpc.id,
      tags,
    },
    { provider },
  );

  // The one place the task's "8080 from the ALB only" invariant is widened,
  // and the reason is in the module header. Referenced by group, so it admits
  // this function and nothing else in the VPC.
  new aws.vpc.SecurityGroupIngressRule(
    "bifrostTaskIngressVkMint",
    {
      securityGroupId: network.taskSecurityGroup.id,
      description:
        "bifrost admin API from the vk-mint Lambda (step 3 of docs/bifrost-virtual-keys.md); the only exception to 'from the ALB only', because /api through the ALB is behind Google SSO",
      ipProtocol: "tcp",
      fromPort: BIFROST_PORT,
      toPort: BIFROST_PORT,
      referencedSecurityGroupId: securityGroup.id,
    },
    { provider },
  );

  // Egress 8080 to the task only: the admin call. The task's group already
  // admits this function's group on 8080 (the ingress rule above).
  new aws.vpc.SecurityGroupEgressRule(
    "bifrostVkMintEgressBifrost",
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

  // 443 out through the NAT for STS, the Identity Store, Secrets Manager, SSM,
  // CloudWatch Logs and the cross-account AssumeRole. All of those are public
  // AWS endpoints, so a CIDR is the only honest scope; the task's own group
  // makes the same trade (`network.ts`).
  new aws.vpc.SecurityGroupEgressRule(
    "bifrostVkMintEgressHttps",
    {
      securityGroupId: securityGroup.id,
      description: "AWS APIs via the NAT: STS, Identity Store, Secrets Manager, SSM, CloudWatch Logs",
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
      `bifrostVkMintEgressDns${protocol.toUpperCase()}`,
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
    "bifrostVkMintLogGroup",
    {
      name: VK_MINT_LOG_GROUP_NAME,
      // A refusal per line and a success line with an email; no request
      // records, no bodies, no keys (decision 3). Thirty days matches the
      // gateway's own group.
      retentionInDays: VK_MINT_LOG_RETENTION_DAYS,
      tags,
    },
    { provider },
  );

  // The template, stored as a `String` and not a `SecureString`: it is a
  // reviewed file in git with no secret in it (decision 5), and a SecureString
  // would need `kms:Decrypt` for no confidentiality. Reading it at deploy time
  // is what keeps the live value from drifting from the reviewed one.
  const templateParameter = new aws.ssm.Parameter(
    "bifrostVkMintTemplate",
    {
      name: VK_MINT_TEMPLATE_PARAMETER_NAME,
      type: "String",
      value: readVkMintTemplate(),
      description:
        "Default provider_configs for a minted Bifrost virtual key (step 1 of docs/bifrost-virtual-keys.md); edit deploy-workbench/bifrost/vk-mint-template.json.",
      tags,
    },
    { provider },
  );

  const role = new aws.iam.Role(
    "bifrostVkMintRole",
    {
      name: VK_MINT_ROLE_NAME,
      description:
        "Bifrost vk-mint Lambda: sts:AssumeRole on the management-account bifrost-vk-reader, read the setup token, read the key template, write its own logs. No identitystore action, no gateway secrets.",
      assumeRolePolicy: JSON.stringify(vkMintTrust),
      managedPolicyArns: [LAMBDA_VPC_ACCESS_MANAGED_POLICY_ARN],
      tags,
    },
    { provider },
  );

  const rolePolicy = new aws.iam.RolePolicy(
    "bifrostVkMintRolePolicy",
    {
      name: VK_MINT_NAME,
      role: role.name,
      policy: pulumi
        .all([templateParameter.arn, logGroup.arn])
        .apply(([templateParameterArn, logGroupArn]) =>
          JSON.stringify(
            vkMintExecutionPolicy({ templateParameterArn, logGroupArn }),
          ),
        ),
    },
    { provider },
  );

  const fn = new aws.lambda.Function(
    "bifrostVkMint",
    {
      name: VK_MINT_FUNCTION_NAME,
      description:
        "Mints the caller's Bifrost virtual key from their WorkbenchAccess session and Identity Center membership (step 3 of docs/bifrost-virtual-keys.md).",
      role: role.arn,
      runtime: aws.lambda.Runtime.NodeJS22dX,
      handler: "handler.handler",
      code: buildVkMintCode(),
      timeout: VK_MINT_TIMEOUT_SECONDS,
      memorySize: VK_MINT_MEMORY_MB,
      // The same private subnets the gateway runs in: the whole point is to
      // reach the task on 8080 without the ALB, and the subnets' NAT gives the
      // function Secrets Manager, SSM and CloudWatch (open item 1 of the
      // design).
      vpcConfig: {
        subnetIds: network.privateSubnetIds,
        securityGroupIds: [securityGroup.id],
      },
      environment: { variables: vkMintEnvironment() },
      tags,
    },
    // The log group and the inline policy must exist before the first
    // invocation: without the group the function logs to an implicit one, and
    // without the policy the missing grant is invisible until a caller tries.
    { provider, dependsOn: [logGroup, rolePolicy, templateParameter] },
  );

  // The URL, IAM-gated. No `lambda:Permission` resource: `AWS_IAM` means AWS
  // verifies the caller's signature against the caller's own identity policy
  // (step 4 grants `WorkbenchAccess` the two invoke actions), so there is no
  // resource policy to write and no anonymous principal to name.
  //
  // `authorizationType: "AWS_IAM"` is what makes the event carry
  // `requestContext.authorizer.iam`; with `NONE` the function would have no
  // trustworthy identity and the handler refuses every call. `invokeMode` is
  // left at `BUFFERED`: the response is a small JSON key, and `RESPONSE_STREAM`
  // would change the payload shape the handler reads.
  const url = new aws.lambda.FunctionUrl(
    "bifrostVkMintUrl",
    {
      functionName: fn.name,
      authorizationType: "AWS_IAM",
      invokeMode: "BUFFERED",
    },
    { provider },
  );

  return {
    function: fn,
    role,
    rolePolicy,
    securityGroup,
    logGroup,
    templateParameter,
    functionUrl: url.functionUrl,
    /** The task's private name, exported so a human can resolve it. */
    bifrostHostname: discovery.dnsName,
    /** The account the function lives in, for step 4's ARN literal. */
    workbenchAccountId: WORKBENCH_ACCOUNT_ID,
    region: REGION,
  };
};
