import * as aws from "@pulumi/aws";

import { MANAGEMENT_ACCOUNT_ID } from "../utils/accounts";

/**
 * The read-only preview role. Item 1 of "PR previews" in
 * docs/infrastructure-account.md, created at step 7.
 *
 * A copy of `deploy-workbench/preview-role.ts`, which carries the reasoning.
 * The sibling of `pulumi-deploy` in deploy-role.ts: that one is the admin
 * front door for applies, this one is what a `pulumi preview` will use so a
 * PR never holds admin in this account.
 *
 * What it may do: nothing. The program's only invoke is
 * `aws.getCallerIdentityOutput`, which needs no grant. Add a policy when a
 * real preview fails closed and names an action.
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

  return role;
};
