import * as aws from "@pulumi/aws";

import {
  INFRASTRUCTURE_ACCOUNT_ID,
  MANAGEMENT_ACCOUNT_ID,
} from "../utils/accounts";

/**
 * The read-only preview role. Item 1 of "PR previews" in
 * docs/infrastructure-account.md, created at step 7.
 *
 * A copy of `deploy-workbench/preview-role.ts`, which carries the reasoning.
 * The sibling of `pulumi-deploy` in deploy-role.ts: that one is the admin
 * front door for applies, this one is what a `pulumi preview` will use so a
 * PR never holds admin in this account.
 *
 * What it may do: read DynamoDB table metadata, for any table in the account.
 * The program's only invoke is `aws.getCallerIdentityOutput`, which needs no
 * grant, so the role started empty. This is its first widening, added after a
 * real preview failed closed and named an action; add the next one the same
 * way.
 *
 * Why DynamoDB. `aws:dynamodb/table:Table` reads with `DescribeTable`,
 * `DescribeContinuousBackups` and `DescribeTimeToLive`, and the provider's
 * tag read adds `ListTagsOfResource`. Without them the infrastructure preview
 * of `break-glass-lambda.ts` (step 3 of `docs/break-glass.md`) fails with
 * AccessDenied while diffing the table — even before the table exists, because
 * IAM denies the call before DynamoDB can answer `ResourceNotFound`. The
 * actions are metadata only, so the grant covers every table in the account
 * rather than the one that failed first; see the policy below.
 *
 * Created now, ahead of anything that assumes it, because the management-side
 * grant and the workflow change (step 11) can only land safely once the role
 * exists. Until then the trust names principals that hold no grant to use it,
 * so the role is inert.
 *
 * Two doors, exactly as in workbench: `github-actions-pulumi-preview` in the
 * management account for PR previews, and that account's `ReadOnlyAccess`
 * SSO session for local previews, pinned by `aws:PrincipalArn` because the
 * SSO role name carries a random suffix.
 */

export const PREVIEW_ROLE_NAME = "pulumi-preview";

/**
 * Exported separately from the role so the test can assert who may assume it
 * without standing up a Pulumi resource.
 * `deploy-infrastructure/preview-role.test.ts` reads this.
 */
type InfrastructureTrustStatement = {
  Effect: "Allow";
  Principal: { AWS: string };
  Action: string;
  Condition?: { ArnLike: Record<string, string> };
};

export const infrastructurePreviewRoleTrust: {
  Version: "2012-10-17";
  Statement: InfrastructureTrustStatement[];
} = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/github-actions-pulumi-preview`,
      },
      Action: "sts:AssumeRole",
    },
    {
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:root`,
      },
      Action: "sts:AssumeRole",
      Condition: {
        ArnLike: {
          "aws:PrincipalArn": `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_ReadOnlyAccess_*`,
        },
      },
    },
  ],
};

const REGION = "us-west-2";

/**
 * The role's whole grant. Exported so `preview-role.test.ts` can pin the
 * actions and the scope without standing up a Pulumi resource.
 *
 * The four actions are the reads the provider makes on a table read, named
 * rather than `dynamodb:Describe*` so a future widening is a visible diff:
 * `DescribeTable` is what the preview failed on, and the other three follow it
 * on the same read path. No data action (`GetItem`, `Query`, `Scan`) appears
 * here, and a test asserts none does.
 *
 * The resource is `table/*` rather than one table ARN. Every table the
 * account adds would otherwise need the same four lines and its own
 * red-then-green PR, and these actions return table metadata, never items. It
 * is still scoped to this account and region, not `*`.
 */
export const infrastructurePreviewRolePolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DynamoDbTableRead",
      Effect: "Allow",
      Action: [
        "dynamodb:DescribeTable",
        "dynamodb:DescribeContinuousBackups",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:ListTagsOfResource",
      ],
      Resource: `arn:aws:dynamodb:${REGION}:${INFRASTRUCTURE_ACCOUNT_ID}:table/*`,
    },
  ],
} as const;

export const createPreviewRole = (args: { provider: aws.Provider }) => {
  const role = new aws.iam.Role(
    "previewRole",
    {
      name: PREVIEW_ROLE_NAME,
      description:
        "Read-only role for infrastructure previews. Assumed by github-actions-pulumi-preview for PR previews and by management-account ReadOnlyAccess sessions for local previews. Step 7 of docs/infrastructure-account.md.",
      assumeRolePolicy: JSON.stringify(infrastructurePreviewRoleTrust),
      maxSessionDuration: 3600,
    },
    { provider: args.provider },
  );

  // Inline, matching the other scoped roles: the deploy role cannot manage new
  // managed policies, and an inline document is covered by the `iam:PutRolePolicy`
  // it already holds.
  new aws.iam.RolePolicy(
    "previewRolePolicy",
    {
      name: PREVIEW_ROLE_NAME,
      role: role.name,
      policy: JSON.stringify(infrastructurePreviewRolePolicy),
    },
    { provider: args.provider },
  );

  return role;
};
