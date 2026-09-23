import * as aws from "@pulumi/aws";

import { workbenchScp } from "./policies";

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

// ---------------------------------------------------------------------------
// The workbench service control policy. Step 9 part 3 of
// docs/workbench-account.md; the document itself is in ./policies.ts and the
// design is in that doc under "The workbench SCP".
//
// This is the last of step 9's three parts. Part 1 enabled
// SERVICE_CONTROL_POLICY on the root, in the console, because doing it in
// code would have meant importing the Organization resource and risking
// awsServiceAccessPrincipals. Part 2 granted this role the policy actions,
// in its own PR that had to finish applying before this one merges, because
// the grant is applied by deploy.yml and this is applied by deploy-org.yml
// and nothing sequences the two.

const workbenchPolicy = new aws.organizations.Policy("workbenchScp", {
  name: "WorkbenchGuardrails",
  description:
    "Bounds the workbench account: no leaving the organization, no IAM users or access keys, no CloudTrail tampering, no managed data stores, no cross-account S3, and us-west-2 only except where cross-region inference and marketplace subscription require otherwise.",
  type: "SERVICE_CONTROL_POLICY",
  content: JSON.stringify(workbenchScp),
});

// Attached to the OU rather than to the account, so a second workbench-style
// account inherits it by being placed here. The cost of that choice is
// recorded in the doc under "What this does not protect": the policy stops
// applying if the account is moved out, which nothing inside the account can
// do, because Organizations write actions are callable only from the
// management account and there are no delegated administrators.
//
// workbenchOu.id rather than the literal, so Pulumi orders the attachment
// after the OU and a renamed or recreated OU cannot leave this pointing at
// nothing.
new aws.organizations.PolicyAttachment("workbenchScp", {
  policyId: workbenchPolicy.id,
  targetId: workbenchOu.id,
});

// Deliberately unprotected, unlike the OU and the account above.
//
// Every other resource in this file guards against losing something
// irreplaceable. This one is the opposite case: the thing most likely to go
// wrong with an SCP is that it denies something real, and the fix is to
// withdraw it quickly. protect: true would turn that into a two-step
// emergency. The same reasoning is why part 2's grant deliberately includes
// DeletePolicy and DetachPolicy.
//
// Recovery does not depend on this stack anyway. SCPs never apply to the
// management account, so github-actions-org-deploy keeps working whatever
// this policy says, and its DetachPolicy grant is scoped to exactly this OU.
// Admins hold AdministratorAccess there as a second path. The way out sits
// outside the thing being changed, which is the property that makes applying
// this safe to do at all.
export const workbenchScpId = workbenchPolicy.id;
