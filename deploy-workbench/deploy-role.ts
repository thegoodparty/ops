import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

/**
 * The scoped in-account deploy role. Step 10 of docs/workbench-account.md.
 *
 * Everything in this stack is applied through `OrganizationAccountAccessRole`
 * today, the administrator role Organizations plants in every member account.
 * This is its replacement: the same front door — assumed by
 * `github-actions-workbench-deploy` in the management account — carrying what
 * this stack and `scripts/enable-bedrock-models.ts` actually do, and nothing
 * else.
 *
 * The permission list is derived from this project's resources, re-derived at
 * claim time as the step entry instructs rather than copied from it. The
 * step's own prediction had the logging resources right and could not have
 * known the rest: the provider's refresh reads, the tag operations
 * `defaultTags` implies, the script's three agreement actions, and the fact
 * that this stack manages the role that runs it. Resource by resource:
 *
 * - the log group: `logs:CreateLogGroup`, `DeleteLogGroup`,
 *   `PutRetentionPolicy`, `DeleteRetentionPolicy`, `TagResource`,
 *   `UntagResource`, `ListTagsForResource`/`ListTagsLogGroup` (the read-back
 *   API has changed underneath the provider before; both spellings stay),
 *   and `DescribeLogGroups`, which is the refresh read;
 * - the logging role, and this role itself: `iam:CreateRole`, `GetRole`,
 *   `UpdateRole`, `UpdateAssumeRolePolicy`, `DeleteRole`, `TagRole`,
 *   `UntagRole`, `PutRolePolicy`, `GetRolePolicy`, `DeleteRolePolicy`,
 *   `ListRolePolicies`, `ListAttachedRolePolicies`,
 *   `ListInstanceProfilesForRole`;
 * - the logging configuration: `bedrock:Put/Get/Delete`
 *   `ModelInvocationLoggingConfiguration`, plus `iam:PassRole` on the logging
 *   role, without which the Put is refused;
 * - the enable script: `bedrock:GetFoundationModelAvailability`,
 *   `ListFoundationModelAgreementOffers`, `CreateFoundationModelAgreement`;
 * - `sts:GetCallerIdentity` for the `accountId` output, which needs no grant.
 *
 * The inventory was checked against the bridged provider's source
 * (terraform-provider-aws at the commit @pulumi/aws 7.23.0 pins) rather than
 * guessed. Two findings from that check: a role refresh reads tags from the
 * `GetRole` response, so `iam:ListRoleTags` exists as an action but is never
 * called for this resource — and the tagging interceptor's ListTags fallback
 * fires only when the read handler left tags unset, which `setTagsOut` in the
 * role read never does; and a description edit goes through
 * `UpdateRoleDescription`, a separate action from `UpdateRole` and the one
 * that is actually needed. The live counter-evidence for the first is the
 * v18 grant set in deploy/components/ci-roles/policies.ts, which has no
 * `iam:ListRoleTags` and refreshes four tagged roles under `aws:defaultTags`
 * on every green `deploy.yml` run.
 *
 * Two things are deliberately absent. `aws-marketplace:*`, the permission
 * step 11 kept out of `WorkbenchAccess`: the script speaks Bedrock's
 * agreement API, not the Marketplace one, and if that ever stops being true
 * the failure is a loud AccessDenied in a workflow step, not a silent skip.
 * And `DeleteFoundationModelAgreement`: removing a model is a human decision
 * made in the console, per "Removing a model" in the doc, not something CI
 * does unattended.
 */

/** The management account. Matches `ACCOUNT_ID` in deploy/components/ci-roles.ts. */
const MANAGEMENT_ACCOUNT_ID = "333022194791";

/**
 * Named rather than inlined: the management-side grant in
 * `deploy/components/ci-roles/policies.ts` spells this ARN out, the provider
 * in index.ts spells it out after cutover, and a drift between the three is
 * an assume failure that reads as a trust problem.
 *
 * `pulumi-deploy` for the family, not the acronym: `pulumi-preview` is the
 * name the PR-preview plan already expects for its read-only sibling, and the
 * two will sit side by side in this account.
 */
export const DEPLOY_ROLE_NAME = "pulumi-deploy";

export const createDeployRole = (args: {
  provider: aws.Provider;
  accountId: string;
  region: string;
  logGroupName: string;
  invocationLogsRoleName: string;
}) => {
  const { provider, accountId, region, logGroupName, invocationLogsRoleName } =
    args;

  const roleArn = (name: string) => `arn:aws:iam::${accountId}:role/${name}`;
  const deployRoleArn = roleArn(DEPLOY_ROLE_NAME);
  const logsRoleArn = roleArn(invocationLogsRoleName);
  const logGroupArn = `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`;

  const role = new aws.iam.Role(
    "deployRole",
    {
      name: DEPLOY_ROLE_NAME,
      description:
        "Scoped deploy role for the workbench account (deploy-workbench). Assumed only by github-actions-workbench-deploy in the management account. Step 10 of docs/workbench-account.md.",
      /**
       * Names the one CI role rather than the management account root, which
       * is how `OrganizationAccountAccessRole` writes it. Root delegates the
       * decision to IAM over there, so any principal in that account holding
       * `sts:AssumeRole` gets in; a named principal means this trust and the
       * identity-side grant (`AssumeWorkbenchDeployRole` in
       * deploy/components/ci-roles/policies.ts) must agree on a single role.
       * A cross-account assume needs both sides to allow it, which is the
       * point: neither side alone is enough to use this.
       *
       * No condition beyond that. `sts:ExternalId` defends a third party
       * assuming on our behalf; this is our own other account.
       */
      assumeRolePolicy: pulumi.jsonStringify({
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
       * session, then `AssumeRole`), which AWS caps at one hour regardless of
       * what is set here.
       */
      maxSessionDuration: 3600,
    },
    /**
     * Protected for the same reason `githubActionsPulumiDeploy` is in
     * ci-roles.ts: after cutover this role runs this stack's applies, so a
     * destroy — or a replacement triggered by an innocent-looking edit — is
     * CI locking itself out of the account. Not protected: the inline policy
     * below, which is the thing we deliberately edit. Recovery either way is
     * the Admins `AdministratorAccess` assignment, which does not depend on
     * CI and is kept for exactly this.
     */
    { provider, protect: true },
  );

  new aws.iam.RolePolicy(
    "deployRolePolicy",
    {
      name: "WorkbenchDeploy",
      role: role.id,
      policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            // The one log group this stack owns. Both ARN spellings: the
            // bare form is what the control-plane actions evaluate, the
            // `:*` form is the shape AWS documents for anything addressing
            // the group's streams, and which one a given provider version
            // presents has not always been obvious from its changelog.
            Sid: "InvocationLogGroup",
            Effect: "Allow",
            Action: [
              "logs:CreateLogGroup",
              "logs:DeleteLogGroup",
              "logs:PutRetentionPolicy",
              "logs:DeleteRetentionPolicy",
              "logs:TagResource",
              "logs:UntagResource",
              "logs:ListTagsForResource",
              "logs:ListTagsLogGroup",
            ],
            Resource: [logGroupArn, `${logGroupArn}:*`],
          },
          {
            // The refresh read, unscoped. DescribeLogGroups answers by
            // prefix, so a scoped grant risks a refresh that cannot see the
            // group it manages; what an unscoped one exposes is the names of
            // this account's log groups, which are not sensitive. Same call
            // the SCP grant made for `organizations:ListPolicies`.
            Sid: "InvocationLogGroupList",
            Effect: "Allow",
            Action: ["logs:DescribeLogGroups"],
            Resource: "*",
          },
          {
            /**
             * Both roles this stack owns, one of which is this role itself.
             * Self-management is the `github-actions-pulumi-deploy` shape
             * from step 2, and it is unavoidable rather than merely
             * convenient: after cutover no other automated path reaches this
             * account, so a policy edit to this role that this role could
             * not apply could never be applied.
             *
             * State the consequence plainly, as ci-roles.ts does for its
             * version: `PutRolePolicy` on itself means this role can widen
             * itself to anything in this account. What makes that acceptable
             * is the boundary in front of it — assuming it requires the
             * management-account CI role, whose trust pins one repository,
             * one branch and one workflow file, with every change to this
             * file passing CODEOWNERS review first. The permission boundary
             * is the trusted-pipeline boundary, which it already was while
             * the bootstrap role stood.
             *
             * `DeleteRole` on itself is the dramatic half of the same point.
             * The Pulumi route is blocked by `protect` above; the grant
             * stays because "matching reads and deletes" is what keeps the
             * resource removable at all, and removability is what a
             * withdrawable design needs.
             */
            Sid: "ManagedRoles",
            Effect: "Allow",
            Action: [
              "iam:CreateRole",
              "iam:GetRole",
              "iam:UpdateRole",
              // A separate API call and a separate action, and the one a
              // description edit actually needs — UpdateRole covers max
              // session duration. The v18 comment in ci-roles/policies.ts
              // records this failing a deploy when it was missing there.
              "iam:UpdateRoleDescription",
              "iam:UpdateAssumeRolePolicy",
              "iam:DeleteRole",
              "iam:TagRole",
              "iam:UntagRole",
              "iam:PutRolePolicy",
              "iam:GetRolePolicy",
              "iam:DeleteRolePolicy",
              "iam:ListRolePolicies",
              "iam:ListAttachedRolePolicies",
              "iam:ListInstanceProfilesForRole",
            ],
            Resource: [logsRoleArn, deployRoleArn],
          },
          {
            // The logging configuration takes a role ARN, and PassRole is
            // what stops "may configure logging" from becoming "may hand
            // Bedrock any role in the account". Scoped to the one role this
            // stack passes, and only to Bedrock. Without this, the Put below
            // fails with an AccessDenied that does not name PassRole.
            Sid: "PassInvocationLogsRole",
            Effect: "Allow",
            Action: ["iam:PassRole"],
            Resource: logsRoleArn,
            Condition: {
              StringEquals: { "iam:PassedToService": "bedrock.amazonaws.com" },
            },
          },
          {
            // A per-region singleton with no resource ARN, so `*` is the
            // only spelling. Region discipline comes from the SCP, not from
            // here.
            Sid: "InvocationLoggingConfiguration",
            Effect: "Allow",
            Action: [
              "bedrock:PutModelInvocationLoggingConfiguration",
              "bedrock:GetModelInvocationLoggingConfiguration",
              "bedrock:DeleteModelInvocationLoggingConfiguration",
            ],
            Resource: "*",
          },
          {
            /**
             * What `scripts/enable-bedrock-models.ts` calls, and nothing
             * more. The script moves from the bootstrap role to this one at
             * cutover, as its header has said since step 11.
             *
             * Account-level agreement APIs with no resource to scope to.
             * `CreateFoundationModelAgreement` is the weighty one — it
             * accepts a model provider's terms on GoodParty's behalf — and
             * the reviewed model list in `utils/bedrock-models.ts` is where
             * that consent lives, exactly as step 11 arranged.
             */
            Sid: "ModelAgreements",
            Effect: "Allow",
            Action: [
              "bedrock:GetFoundationModelAvailability",
              "bedrock:ListFoundationModelAgreementOffers",
              "bedrock:CreateFoundationModelAgreement",
            ],
            Resource: "*",
          },
        ],
      }),
    },
    { provider },
  );

  return role;
};
