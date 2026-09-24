import * as aws from "@pulumi/aws";

/**
 * The in-account deploy role. Step 10 of docs/workbench-account.md.
 *
 * What this replaces: `OrganizationAccountAccessRole`, the administrator
 * role Organizations plants in every member account. That role trusts the
 * management account *root* — any principal there holding `sts:AssumeRole`
 * can walk in, an invisible delegation decided by IAM drift in another
 * account. This role is the same front door with the trust narrowed to
 * exactly the CI role. That narrowing, not the permission set, is the
 * security content of step 10.
 *
 * What it carries: `AdministratorAccess`, the AWS-managed policy. The
 * original design was a permission set scoped to this stack's resources.
 * The derivation was done (it is in git history, and it caught real things
 * — the `UpdateRoleDescription` quirk, and proof that `iam:ListRoleTags` is
 * never called for this resource) and then the scoped design was
 * deliberately simplified away in review, for three reasons:
 *
 * - Self-management undercut it. The role would have held
 *   `iam:PutRolePolicy` on itself — unavoidable, since after cutover no
 *   other automated path reaches this account — so anything that could
 *   drive the pipeline could widen the role. The action list was friction,
 *   not a boundary. The boundary is the trust below plus CODEOWNERS review,
 *   exactly as it was under the bootstrap role.
 * - The account is deliberately sleepy: developer tooling, no production
 *   data. The exclusions that genuinely matter — no IAM users or access
 *   keys, the region lock, no `LeaveOrganization`, no CloudTrail tampering,
 *   no cross-account S3 — live in the SCP attached to the Workbench OU,
 *   which binds every principal in the account, admins included.
 *   Exclusions belong there; permissions can be simple here.
 * - The cost was real and recurring. Every new service in the account would
 *   have opened with a policy PR, and because grant and consumer live in
 *   the same stack, each would have carried the red-then-green first apply
 *   that the v18 `UpdateRoleDescription` comment in ci-roles/policies.ts
 *   records living through.
 *
 * The trust is therefore the whole control, and it names one principal: the
 * CI role. Humans do not belong in it — the Identity Center
 * `AdministratorAccess` assignment (step 8's break-glass) is the human
 * door, and the PR-preview plan is designing its own read-only role — and
 * every additional name here is a door that bypasses those two considered
 * paths. A cross-account assume needs both sides to allow it; the other
 * side is `AssumeWorkbenchDeployRole` in
 * deploy/components/ci-roles/policies.ts.
 */

/** The management account. Matches `ACCOUNT_ID` in deploy/components/ci-roles.ts. */
const MANAGEMENT_ACCOUNT_ID = "333022194791";

/**
 * Named rather than inlined: the management-side grant in
 * deploy/components/ci-roles/policies.ts spells this ARN out, the provider
 * in index.ts spells it out after cutover, and a drift between the three is
 * an assume failure that reads as a trust problem.
 *
 * `pulumi-deploy` for the family, not the acronym: `pulumi-preview` is the
 * name the PR-preview plan already expects for its read-only sibling, and
 * the two will sit side by side in this account.
 */
export const DEPLOY_ROLE_NAME = "pulumi-deploy";

const ADMINISTRATOR_ACCESS_ARN =
  "arn:aws:iam::aws:policy/AdministratorAccess";

export const createDeployRole = (args: { provider: aws.Provider }) => {
  const role = new aws.iam.Role(
    "deployRole",
    {
      name: DEPLOY_ROLE_NAME,
      description:
        "Admin deploy role for the workbench account (deploy-workbench). Assumed only by github-actions-workbench-deploy in the management account. Step 10 of docs/workbench-account.md.",
      /**
       * Names the one CI role rather than the management account root,
       * which is how `OrganizationAccountAccessRole` writes it. Root
       * delegates the decision to IAM over there, so any principal in that
       * account holding `sts:AssumeRole` gets in; a named principal means
       * this trust and the identity-side grant must agree on a single role.
       *
       * No condition beyond that. `sts:ExternalId` defends against a third
       * party assuming on our behalf; this is our own other account.
       */
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              AWS: `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/github-actions-workbench-deploy`,
            },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      /**
       * One hour is the default, restated so nobody raises it expecting an
       * effect: the hop into this role is role chaining (a web-identity
       * session, then `AssumeRole`), which AWS caps at one hour regardless
       * of what is set here.
       */
      maxSessionDuration: 3600,
    },
    /**
     * Protected for the same reason `githubActionsPulumiDeploy` is in
     * ci-roles.ts: after cutover this role runs this stack's applies, so a
     * destroy — or a replacement triggered by an innocent-looking edit — is
     * CI locking itself out of the account. Recovery either way is the
     * Admins `AdministratorAccess` assignment, which does not depend on CI
     * and is kept for exactly this.
     */
    { provider: args.provider, protect: true },
  );

  /**
   * The AWS-managed policy, attached rather than inlined: self-updating,
   * and honest about what this role is. Protected because detaching it
   * strips the role's permissions without deleting anything — the quiet
   * version of the lockout described above, which is why ci-roles.ts
   * protects its attachments too. Swapping the policy is still easy:
   * remove `protect` in the PR that does it.
   */
  new aws.iam.RolePolicyAttachment(
    "deployRoleAdministratorAccess",
    { role: role.id, policyArn: ADMINISTRATOR_ACCESS_ARN },
    { provider: args.provider, protect: true },
  );

  return role;
};
