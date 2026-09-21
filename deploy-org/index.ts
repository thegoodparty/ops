import * as aws from "@pulumi/aws";

/**
 * Organization-level resources: organizational units and member accounts.
 *
 * Separate from `deploy/` because these are the only resources in the program
 * that act on the organization rather than inside the management account, and
 * because they are applied by a different role. See
 * docs/workbench-account.md, "Repo and Pulumi structure", for why this is a
 * third project rather than a second provider or a second stack of `ops`.
 *
 * Stack: organization/org/main. Account: 333022194791, the management
 * account, which is where Organizations calls have to originate.
 * Role: github-actions-org-deploy.
 *
 * Nothing here takes an explicit provider. Organizations is a global service
 * and the default provider's credentials already come from the right account
 * via OIDC in .github/workflows/deploy-org.yml.
 */

// Holds the workbench account, and later anything else whose availability
// obligations differ from production's. An OU rather than a bare account
// under the root because step 9 attaches a service control policy, and SCPs
// attach to an OU; retrofitting one later means moving a live account.
//
// The root id is hardcoded, matching how identity-center.ts hardcodes
// ACCOUNT_ID and index.ts hardcodes subnet and security group ids. There is
// exactly one root per organization and it cannot be recreated, so looking it
// up with getOrganization() would trade a constant for an API call and a
// permission, and buy nothing.
//
// Organizations does not enforce unique OU names under a parent. If an apply
// ever fails partway and the OU is left in AWS but not in state, a rerun
// creates a *second* OU also called Workbench rather than failing. Check for
// an orphan before rerunning a failed apply of this file.
const workbenchOu = new aws.organizations.OrganizationalUnit("workbench", {
  name: "Workbench",
  parentId: "r-jqqe",
});

// Four independent guards against losing this account, because the blast
// radius of deleting it is the whole point of reviewing this file.
//
// `protect: true` blocks the delete itself. It does not block an update, so
// it is not a guard against a bad edit here, only against removal.
//
// `closeOnDeletion: false` decides what a delete would do if it ever got
// past that. It is already the provider default, and is set explicitly
// because the difference matters and defaults drift: false removes the
// account from the organization, leaving it standalone; true calls
// CloseAccount, which begins a 90 day suspension window nobody can shorten.
// Neither outcome is recoverable in a hurry. Rejoining an organization needs
// a fresh invitation, and a standalone account has no consolidated billing
// and no SCP governance in the meantime.
//
// Third and fourth, github-actions-org-deploy holds neither
// organizations:CloseAccount nor organizations:RemoveAccountFromOrganization,
// so IAM refuses *both* delete paths independently of the two settings above.
// A `pulumi destroy` of this stack fails with AccessDenied rather than
// detaching anything. Do not add either action in order to make a destroy
// work.
//
// CreateAccount is asynchronous: the call returns immediately and Pulumi then
// polls DescribeCreateAccountStatus, so expect this apply to take minutes
// rather than seconds. The most likely failure is the email address already
// being attached to some other account anywhere in AWS, which surfaces as
// EMAIL_ALREADY_EXISTS.
//
// The email is a group alias, not a person. It is the break-glass recovery
// path for the root user of this account, so it has to outlive any individual.
const workbench = new aws.organizations.Account(
  "workbench",
  {
    name: "goodparty-workbench",
    email: "aws-workbench@goodparty.org",
    parentId: workbenchOu.id,
    iamUserAccessToBilling: "ALLOW",
    closeOnDeletion: false,
  },
  { protect: true },
);

// Exported for humans reading `pulumi stack output`, and to record the id in
// docs/workbench-account.md at step 6. Deliberately not consumed by the other
// projects through a StackReference: the id is immutable for the life of the
// account, so the consuming projects hardcode it as a constant instead. See
// the "Cross-project dependencies" section of that doc.
export const workbenchOuId = workbenchOu.id;
export const workbenchAccountId = workbench.id;
