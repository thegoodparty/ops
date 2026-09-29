import * as aws from "@pulumi/aws";

import { MANAGEMENT_ACCOUNT_ID } from "../utils/accounts";

/**
 * The read-only preview role. Step 8 of docs/pr-previews.md.
 *
 * The sibling of `pulumi-deploy` in deploy-role.ts: that one is the admin
 * front door for applies, this one is what a `pulumi preview` uses so a PR
 * never holds admin in this account. The two sit side by side on purpose,
 * which is why the name follows the family (`pulumi-`) rather than the
 * acronym.
 *
 * What it may do: nothing yet. The workbench program's only invoke is
 * `aws.getCallerIdentityOutput`, which `sts:GetCallerIdentity` answers for
 * any principal without a grant. Preview does not call AWS to create or read
 * the resources, so there is no policy to attach until a real preview fails
 * closed and names an action.
 *
 * The trust is therefore the whole role, and it has two doors:
 *
 * - `github-actions-pulumi-preview` in the management account, the same role
 *   step 4 created and the PR workflow assumes. The other side of the
 *   cross-account assume is `AssumeWorkbenchPreviewRole` in
 *   deploy/components/ci-roles/policies.ts.
 * - The human `ReadOnlyAccess` session in the management account, for local
 *   previews (step 10). Its role name carries a random suffix and sits under
 *   `/aws-reserved/sso.amazonaws.com/`, so the principal is the account root
 *   and an `ArnLike` pins `aws:PrincipalArn` to that path and permission set
 *   rather than spelling an ARN that changes on every reprovision.
 */

/**
 * Named rather than inlined: the grant in
 * deploy/components/ci-roles/policies.ts spells this ARN out, and a drift
 * between the two is an assume failure that reads as a trust problem.
 */
export const PREVIEW_ROLE_NAME = "pulumi-preview";

/**
 * Exported separately from the role so the test can assert who may assume it
 * without standing up a Pulumi resource. `deploy-workbench/preview-role.test.ts`
 * reads this.
 */
type WorkbenchTrustStatement = {
  Effect: "Allow";
  Principal: { AWS: string };
  Action: string;
  Condition?: { ArnLike: Record<string, string> };
};

export const workbenchPreviewRoleTrust: {
  Version: "2012-10-17";
  Statement: WorkbenchTrustStatement[];
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
        "Read-only role for workbench previews. Assumed by github-actions-pulumi-preview for PR previews and by management-account ReadOnlyAccess sessions for local previews. Step 8 of docs/pr-previews.md.",
      assumeRolePolicy: JSON.stringify(workbenchPreviewRoleTrust),
      /**
       * One hour is the default, restated for the same reason deploy-role.ts
       * restates it: the hop in is role chaining, which AWS caps at one hour
       * whatever this is set to.
       */
      maxSessionDuration: 3600,
    },
    { provider: args.provider },
  );

  return role;
};
