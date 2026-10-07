import * as aws from "@pulumi/aws";
import { INFRASTRUCTURE_ACCOUNT_ID } from "../utils/accounts";
import { createDeployRole, DEPLOY_ROLE_NAME } from "./deploy-role";
import { createPreviewRole } from "./preview-role";

/**
 * Contents of the `goodparty-infrastructure` account.
 *
 * Stack: `organization/infrastructure/main`. Account: 394495727159, reached
 * by assuming a role from the management account. Role running the deploy:
 * `github-actions-infrastructure-deploy`, via
 * `.github/workflows/deploy-infrastructure.yml`.
 *
 * Modelled on `deploy-workbench/`, the other project whose provider points at
 * an account its credentials do not belong to. Everything here takes an
 * explicit provider, and `deploy.sh` disables the default one, so a resource
 * that omits `{ provider }` fails the apply rather than landing in the
 * management account.
 */

/**
 * The way into the account.
 *
 * Step 7's cutover: the provider assumes `pulumi-deploy`, the role this same
 * stack creates in `deploy-role.ts`, which makes this file self-referential
 * in a way worth stating plainly. The apply runs as the role the apply
 * manages. That works because the role is administrator, including over
 * itself; `protect` on the role and its attachment is what keeps an edit from
 * locking CI out of the account, and the step 8 Admins Identity Center
 * assignment is the recovery path once it lands.
 *
 * Until the cutover this assumed `OrganizationAccountAccessRole`, the
 * administrator role Organizations plants in every member account, whose
 * trust names the management account *root* — any principal there holding
 * `sts:AssumeRole` — rather than a single role. The management-side grant for
 * it was removed in the same change. The in-account bootstrap role itself is
 * left alone; nothing here manages or deletes it, and removing it is a
 * console action if the account's owner wants it gone.
 *
 * `defaultTags` lives here rather than in `deploy.sh`, because the
 * `aws:defaultTags` stack config applies to the default provider, which this
 * project disables.
 *
 * `allowedAccountIds` is the second wrong-account guard: it catches this
 * provider resolving to credentials in some other account, before any
 * resource is touched.
 */
const provider = new aws.Provider("infrastructure", {
  region: "us-west-2",
  assumeRoles: [
    {
      // DEPLOY_ROLE_NAME rather than a literal: the grant in
      // deploy/components/ci-roles/policies.ts and the trust in
      // deploy-role.ts spell the same ARN out, and a drift between the three
      // is an assume failure that reads as a trust problem.
      roleArn: `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/${DEPLOY_ROLE_NAME}`,
      // The session name in this account's CloudTrail. It separates a CI
      // apply from a human who assumed the same role by hand.
      sessionName: "pulumi-deploy-infrastructure",
    },
  ],
  allowedAccountIds: [INFRASTRUCTURE_ACCOUNT_ID],
  defaultTags: {
    tags: { Environment: "infrastructure", Project: "infrastructure" },
  },
});

/**
 * Evidence, not what forces the assume: an explicit provider is configured
 * and its credentials validated whether or not anything uses it. The step 7
 * entry records this output reading 394495727159, which also closes step 3's
 * open half, that STS sees the in-account deploy role.
 */
export const accountId = aws.getCallerIdentityOutput({}, { provider }).accountId;

// The admin deploy role the provider above assumes. In its own file because
// its trust is the design record for the door into this account.
const deployRole = createDeployRole({ provider });

/** Evidence for the step 7 entry: the apply log should show this ARN. */
export const deployRoleArn = deployRole.arn;

// The read-only sibling a `pulumi preview` will assume once step 11 wires
// previews for this project, so a PR never reaches this account as admin.
const previewRole = createPreviewRole({ provider });

/** Evidence for the step 7 entry: the apply log should show this ARN. */
export const previewRoleArn = previewRole.arn;
