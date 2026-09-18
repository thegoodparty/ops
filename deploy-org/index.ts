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
const workbenchOu = new aws.organizations.OrganizationalUnit("workbench", {
  name: "Workbench",
  parentId: "r-jqqe",
});

// Three independent guards against losing this account, because the blast
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
// Third, github-actions-org-deploy does not hold organizations:CloseAccount
// at all, so CI could not perform the close even if both settings above were
// flipped. Do not add that action in order to make a destroy work.
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
