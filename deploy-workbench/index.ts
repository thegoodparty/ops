import * as aws from "@pulumi/aws";

/**
 * Contents of the `goodparty-workbench` account.
 *
 * Stack: `organization/workbench/main`. Account: 024901689212, reached by
 * assuming a role from the management account. Role running the deploy:
 * `github-actions-workbench-deploy`, via
 * `.github/workflows/deploy-workbench.yml`.
 *
 * Empty of real resources on purpose. Steps 8 through 11 of
 * docs/workbench-account.md are what fill this account, and step 10 creates
 * the first resource that belongs here. What this file establishes now is the
 * path into the account, so that the next step debugs its own resources
 * rather than the credential chain underneath them.
 *
 * Unlike `deploy/` and `deploy-org/`, everything here takes an explicit
 * provider. Those two run in the account their credentials already belong to;
 * this one does not, and the default provider would quietly land resources in
 * the management account instead. `deploy.sh` disables the default provider
 * so that omitting `{ provider }` fails the apply rather than succeeding in
 * the wrong account.
 */

// Hardcoded rather than read from the `org` stack. See "Cross-project
// dependencies" in the doc: an account id is immutable for the life of the
// account, so a StackReference would buy propagation that can never fire, at
// the cost of backend read access and the state passphrase in every consuming
// project. Matches how identity-center.ts hardcodes ACCOUNT_ID.
const WORKBENCH_ACCOUNT_ID = "024901689212";

/**
 * The way into the account.
 *
 * `OrganizationAccountAccessRole` is created automatically by Organizations
 * when it provisions a member account, and it is effectively administrator.
 * Step 10 replaces it with a scoped in-account role and repoints this
 * `assumeRole` at that; the matching `sts:AssumeRole` grant on
 * `github-actions-workbench-deploy` moves at the same time rather than being
 * joined by a second one.
 *
 * `defaultTags` lives here rather than in `deploy.sh`. The `aws:defaultTags`
 * stack config the other two projects set applies to the *default* provider,
 * which this project disables, so setting it there would silently tag
 * nothing.
 *
 * `assumeRoles`, plural and an array, is the @pulumi/aws v7 spelling. The
 * singular `assumeRole` in the plan's sketch was v6 and no longer type
 * checks; the array is for role chaining, and one element is the ordinary
 * case.
 *
 * `allowedAccountIds` is the second guard, independent of the disabled
 * default provider. That one catches a resource that names no provider; this
 * one catches this provider resolving to credentials in some other account,
 * which is the same wrong-account create arriving by a different route. The
 * provider refuses to do anything rather than writing to the wrong place.
 */
const provider = new aws.Provider("workbench", {
  region: "us-west-2",
  assumeRoles: [
    {
      roleArn: `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/OrganizationAccountAccessRole`,
      // Shows up in the workbench account's CloudTrail as the session name.
      // Worth setting for an assume this privileged: it distinguishes a CI
      // apply from a human who assumed the same role by hand.
      sessionName: "pulumi-deploy-workbench",
    },
  ],
  allowedAccountIds: [WORKBENCH_ACCOUNT_ID],
  defaultTags: { tags: { Environment: "workbench", Project: "workbench" } },
});

/**
 * The account this stack actually reached, recorded as an output.
 *
 * Not what forces the assume. Checked rather than assumed: a provider that
 * nothing uses is still registered and still validates its credentials, so
 * the role is assumed either way and a broken chain fails the apply with or
 * without this line. `allowedAccountIds` above is what turns landing in the
 * wrong account into an error.
 *
 * It earns its place as evidence. `pulumi stack output accountId` gives a
 * human, and the step 7 entry in docs/workbench-account.md, something to read
 * that says 024901689212, rather than an absence of errors in a run log.
 * `sts:GetCallerIdentity` needs no permission, so it adds nothing to the
 * grant.
 */
export const accountId = aws.getCallerIdentityOutput({}, { provider }).accountId;
