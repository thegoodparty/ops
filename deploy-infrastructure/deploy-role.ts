import * as aws from "@pulumi/aws";

import { MANAGEMENT_ACCOUNT_ID } from "../utils/accounts";

/**
 * The in-account deploy role. Step 7 of docs/infrastructure-account.md.
 *
 * The same design as `deploy-workbench/deploy-role.ts`, whose header is the
 * full record of why: `AdministratorAccess`, and a trust policy naming
 * exactly one CI role, because the trust is the control and the permission
 * list was friction without a boundary. Read that before changing either.
 *
 * What this replaces, at step 7's cutover: `OrganizationAccountAccessRole`,
 * which trusts the management account *root*, so any principal there holding
 * `sts:AssumeRole` can walk in. This role is the same front door with the
 * trust narrowed to `github-actions-infrastructure-deploy`. That narrowing
 * matters more here than it did for workbench, because this account exists
 * to hold privileged automation.
 *
 * One thing that differs from workbench in effect, not in code: the
 * exclusions that bind this role are the Infrastructure SCP's, not the
 * Workbench SCP's, and that policy is deliberately smaller (no region lock,
 * no cross-account S3 deny, no data-store deny). Anything a future SCP
 * statement denies is denied to this pipeline too, so a new statement has to
 * be checked against what `deploy-infrastructure.yml` does.
 */

/**
 * Named rather than inlined: the provider in index.ts spells this ARN out
 * after the cutover, and the management-side grant in
 * deploy/components/ci-roles/policies.ts spells it out at the same time. A
 * drift between them is an assume failure that reads as a trust problem.
 */
export const DEPLOY_ROLE_NAME = "pulumi-deploy";

const ADMINISTRATOR_ACCESS_ARN =
  "arn:aws:iam::aws:policy/AdministratorAccess";

/**
 * Exported separately from the role so the test can assert who may assume it
 * without standing up a Pulumi resource. `deploy-infrastructure/deploy-role.test.ts`
 * reads this.
 *
 * A named role, not the management account root, and no condition: see the
 * workbench file for why `sts:ExternalId` does not apply between two of our
 * own accounts.
 */
export const infrastructureDeployRoleTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/github-actions-infrastructure-deploy`,
      },
      Action: "sts:AssumeRole",
    },
  ],
} as const;

export const createDeployRole = (args: { provider: aws.Provider }) => {
  const role = new aws.iam.Role(
    "deployRole",
    {
      name: DEPLOY_ROLE_NAME,
      description:
        "Admin deploy role for the infrastructure account (deploy-infrastructure). Assumed only by github-actions-infrastructure-deploy in the management account. Step 7 of docs/infrastructure-account.md.",
      assumeRolePolicy: JSON.stringify(infrastructureDeployRoleTrust),
      /**
       * The default, restated so nobody raises it expecting an effect: the
       * hop in is role chaining, which AWS caps at one hour.
       */
      maxSessionDuration: 3600,
    },
    /**
     * Protected from the start, as the workbench role is: after the cutover
     * this role runs this stack's applies, so a destroy or a replacement is
     * CI locking itself out of the account. Step 8's Admins assignment is
     * the recovery path that does not depend on CI.
     */
    { provider: args.provider, protect: true },
  );

  /**
   * Protected because detaching it strips the role's permissions without
   * deleting anything, the quiet version of the same lockout.
   */
  new aws.iam.RolePolicyAttachment(
    "deployRoleAdministratorAccess",
    { role: role.id, policyArn: ADMINISTRATOR_ACCESS_ARN },
    { provider: args.provider, protect: true },
  );

  return role;
};
