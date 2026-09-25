// Captured verbatim from AWS on 2026-09-17: the trust policy of
// github-actions-pulumi-deploy, and version v18 of its attached
// GitHubActionsPulumiDeployPolicy. Both are adopted rather than authored, so
// the acceptance test for the adoption is that a preview reports no change to
// either document. Edit them here from now on, never in the console.
//
// Ordering follows what AWS returned. The provider parses these as JSON, so
// serialisation does not have to match how AWS stores it, but keeping the
// adoption diff empty is worth more than tidying the shape.
//
// The trust document is no longer byte-identical to what was captured: step 7
// of `docs/pr-previews.md` pins the ops subject to `main` and to `deploy.yml`
// (the first statement below). The policy document is still as adopted.

import type { PolicyDocument, PolicyStatement } from "../identity-center/policies";

// The assume-role document carries a Principal, which PolicyStatement does
// not model, so it gets its own narrow type rather than widening that one.
type TrustStatement = {
  Effect: "Allow";
  Principal: { Federated: string };
  Action: string;
  Condition: Record<string, Record<string, string | string[]>>;
};

export type TrustPolicyDocument = {
  Version: "2012-10-17";
  Statement: TrustStatement[];
};

// Nine repositories. Ops is pinned to `main` and to one workflow file in its
// own statement; the other eight keep the captured `:*` pattern, which includes
// pull_request refs.
//
// Why two statements rather than one list. `sub` under both `StringEquals` and
// `StringLike` in the same statement is not "either": IAM ANDs the condition
// operators for one key, so the subject would have to be both the exact main
// ref and one of the wildcard patterns at once, and no request would match. The
// exact pin therefore needs its own statement.
//
// Why the ops statement pins `job_workflow_ref` too. `sub` is per-ref, not
// per-workflow: every workflow on main presents the same subject, so a
// `main`-only pin still lets any workflow file added to the repo assume this
// role. That is the same gap `opsWorkflowTrust()` below closes for the scoped
// roles, and this role is broader, so it needs the pin at least as much. Only
// `deploy.yml` should hold it.
//
// The ops pin is only safe now. It depends on `deploy.yml` no longer requesting
// credentials on `pull_request` (docs/pr-previews.md step 6, merged as PR #90);
// before that, a PR run still assumed this role and would now fail. The other
// eight stay wildcarded on purpose: omni's `publish-experiments.yml` assumes
// this role on `pull_request`.
export const githubActionsPulumiDeployTrust: TrustPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        Federated: "arn:aws:iam::333022194791:oidc-provider/token.actions.githubusercontent.com",
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          // No wildcard, so this matches only a `main` run in this repo. A
          // `pull_request` run presents a `refs/pull/N/merge` subject and is
          // refused.
          "token.actions.githubusercontent.com:sub":
            "repo:thegoodparty/ops:ref:refs/heads/main",
          // Pins which workflow file the job came from. `sub` is identical for
          // every workflow on main, so without this any workflow added to the
          // repo could assume the role. See `opsWorkflowTrust()` for the full
          // reasoning.
          "token.actions.githubusercontent.com:job_workflow_ref":
            "thegoodparty/ops/.github/workflows/deploy.yml@refs/heads/main",
        },
      },
    },
    {
      Effect: "Allow",
      Principal: {
        Federated: "arn:aws:iam::333022194791:oidc-provider/token.actions.githubusercontent.com",
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": [
            "repo:thegoodparty/gp-api:*",
            "repo:thegoodparty/people-api:*",
            "repo:thegoodparty/election-api:*",
            "repo:thegoodparty/gp-terraform-dataplatform:*",
            "repo:thegoodparty/campaign-plan-service:*",
            "repo:thegoodparty/gpvpn:*",
            "repo:thegoodparty/runbooks:*",
            "repo:thegoodparty/omni:*",
          ],
        },
      },
    },
  ],
};

// v18 added SelfManageDeployPolicy, without which Pulumi could import
// this policy but never update it: the role holds no managed-policy
// version actions otherwise. Scoped to this one ARN because the program
// creates no other managed policies; its IAM idiom is inline role
// policies, covered by the unscoped iam:PutRolePolicy above.
export const githubActionsPulumiDeploy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "CodebuildFullAccess",
      Effect: "Allow",
      Action: [
        "codebuild:*",
      ],
      Resource: [
        "*",
      ],
    },
    {
      Sid: "S3FullAccess",
      Effect: "Allow",
      Action: [
        "s3:*",
      ],
      Resource: [
        "*",
      ],
    },
    {
      Sid: "SecretsManagerAccess",
      Effect: "Allow",
      Action: [
        "secretsmanager:*",
      ],
      Resource: "*",
    },
    {
      Sid: "ECSFullAccess",
      Effect: "Allow",
      Action: [
        "ecs:*",
      ],
      Resource: "*",
    },
    {
      Sid: "RDSFullAccess",
      Effect: "Allow",
      Action: [
        "rds:*",
      ],
      Resource: "*",
    },
    {
      Sid: "SQSFullAccess",
      Effect: "Allow",
      Action: [
        "sqs:*",
      ],
      Resource: "*",
    },
    {
      Sid: "CloudWatchFullAccess",
      Effect: "Allow",
      Action: [
        "cloudwatch:*",
        "logs:*",
      ],
      Resource: "*",
    },
    {
      Sid: "EC2FullAccess",
      Effect: "Allow",
      Action: [
        "ec2:*",
      ],
      Resource: "*",
    },
    {
      Sid: "ELBFullAccess",
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:*",
      ],
      Resource: "*",
    },
    {
      Effect: "Allow",
      Action: [
        "cloudfront:*",
      ],
      Resource: "*",
    },
    {
      Sid: "IAMPassRole",
      Effect: "Allow",
      Action: [
        "iam:PassRole",
        "iam:GetRole",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:ListInstanceProfilesForRole",
        "iam:UpdateAssumeRolePolicy",
        // A separate API call from UpdateAssumeRolePolicy above, and so a
        // separate action. Missing from v18 and not noticed, because the only
        // two roles this program gives a description to are the scoped roles
        // below and CreateRole carried theirs; the first edit to one of those
        // descriptions is what found the gap, by failing the deploy on main.
        //
        // Unlike the org-deploy grants, this one cannot ship ahead of its
        // consumer: the grant and the roles that need it are in the same
        // stack, applied by the same `deploy.yml` run, with no Pulumi
        // dependency ordering the two. If that run reaches the roles first it
        // fails again and a re-run succeeds, the policy version having landed.
        "iam:UpdateRoleDescription",
        "iam:TagRole",
        "iam:UntagRole",
      ],
      Resource: "*",
    },
    {
      Sid: "ECRAccess",
      Effect: "Allow",
      Action: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
      ],
      Resource: "*",
    },
    {
      Sid: "Route53Access",
      Effect: "Allow",
      Action: [
        "route53:ChangeResourceRecordSets",
        "route53:GetChange",
        "route53:GetHostedZone",
        "route53:ListResourceRecordSets",
      ],
      Resource: [
        "arn:aws:route53:::hostedzone/Z10392302OXMPNQLPO07K",
        "arn:aws:route53:::change/*",
      ],
    },
    {
      Effect: "Allow",
      Action: [
        "acm:DescribeCertificate",
        "acm:ListCertificates",
      ],
      Resource: "*",
    },
    {
      Effect: "Allow",
      Action: [
        "ssm:GetParameter",
      ],
      Resource: [
        "arn:aws:ssm:us-west-2:333022194791:parameter/pulumi-state-config-passphrase",
      ],
    },
    {
      Effect: "Allow",
      Action: [
        "lambda:*",
      ],
      Resource: [
        "*",
      ],
    },
    {
      Sid: "GpApiGroupInlinePolicies",
      Effect: "Allow",
      Action: [
        "iam:GetGroupPolicy",
        "iam:PutGroupPolicy",
        "iam:DeleteGroupPolicy",
        "iam:ListGroupPolicies",
      ],
      Resource: "arn:aws:iam::333022194791:group/gp-api",
    },
    {
      Sid: "IdentityCenterFullAccess",
      Effect: "Allow",
      Action: [
        "sso:*",
      ],
      Resource: "*",
    },
    {
      Sid: "AgentFailureAlertsSnsAndEvents",
      Effect: "Allow",
      Action: [
        "sns:CreateTopic",
        "sns:DeleteTopic",
        "sns:SetTopicAttributes",
        "sns:TagResource",
        "sns:UntagResource",
        "sns:Subscribe",
        "sns:Unsubscribe",
      ],
      Resource: [
        "arn:aws:sns:us-west-2:333022194791:autopilot-*",
        "arn:aws:sns:us-west-2:333022194791:engineer-agent-*",
        "arn:aws:sns:us-west-2:333022194791:alert-filter-*",
      ],
    },
    {
      Sid: "AgentFailureAlertsEventBridge",
      Effect: "Allow",
      Action: [
        "events:PutRule",
        "events:DeleteRule",
        "events:PutTargets",
        "events:RemoveTargets",
        "events:TagResource",
        "events:UntagResource",
        "events:DescribeRule",
        "events:ListTargetsByRule",
        "events:ListTagsForResource",
      ],
      Resource: [
        "arn:aws:events:us-west-2:333022194791:rule/autopilot-*",
        "arn:aws:events:us-west-2:333022194791:rule/engineer-agent-*",
      ],
    },
    {
      Sid: "AutopilotDynamoDb",
      Effect: "Allow",
      Action: [
        "dynamodb:CreateTable",
        "dynamodb:UpdateTable",
        "dynamodb:DeleteTable",
        "dynamodb:TagResource",
        "dynamodb:UntagResource",
        "dynamodb:UpdateTimeToLive",
        "dynamodb:UpdateContinuousBackups",
      ],
      Resource: [
        "arn:aws:dynamodb:us-west-2:333022194791:table/autopilot-*",
        "arn:aws:dynamodb:us-west-2:333022194791:table/alert-filter-*",
      ],
    },
    {
      Sid: "SelfManageDeployPolicy",
      Effect: "Allow",
      Action: [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      Resource: "arn:aws:iam::333022194791:policy/GitHubActionsPulumiDeployPolicy",
    },
  ],
};

// ---------------------------------------------------------------------------
// Scoped CI roles (step 4 of docs/workbench-account.md)
//
// Authored, not adopted. Unlike the role above, these are ours from the start,
// so a preview of them is expected to show creations.
//
// The reason they exist at all is that github-actions-pulumi-deploy is trusted
// by nine repositories at `:*`, which includes pull_request refs. Giving it
// organizations:CreateAccount would hand account creation to nine repos' CI,
// and step 9 would later add DetachPolicy on top of that. These two are
// trusted by one repo, on one branch.

const OPS_MAIN_SUBJECT = "repo:thegoodparty/ops:ref:refs/heads/main";

/**
 * Trust for a role that exactly one workflow, on main, may assume.
 *
 * Two conditions, doing two different jobs.
 *
 * `sub` is `ref:refs/heads/main` rather than `:*`. A pull_request ref cannot
 * match it, so a fork PR or an unreviewed branch cannot assume these roles
 * even though the workflow file is visible to anyone.
 *
 * `job_workflow_ref` pins *which workflow file* the job came from. Without it
 * the trust policy is per-ref only: `sub` is identical for every workflow
 * running on main, so any workflow in the repo could assume the role. Adding
 * a new workflow file touches no code-owned path, which means it needs no
 * human review, which means the CODEOWNERS gate alone did not protect this
 * credential. Raised in review on the PR that added deploy-org.yml, and fixed
 * on both sides: the whole workflows directory is now code-owned, and this
 * condition means an added file would not be believed even if it landed.
 *
 * Changing this is a tightening, so it has no apply-ordering hazard in either
 * direction: the workflows that assume these roles already satisfy the new
 * condition, and the old policy admits them too. The ordering rule in
 * docs/workbench-account.md is about *widening*.
 */
const opsWorkflowTrust = (workflowFile: string): TrustPolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        Federated: "arn:aws:iam::333022194791:oidc-provider/token.actions.githubusercontent.com",
      },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": OPS_MAIN_SUBJECT,
          "token.actions.githubusercontent.com:job_workflow_ref": `thegoodparty/ops/.github/workflows/${workflowFile}@refs/heads/main`,
        },
      },
    },
  ],
});

export const githubActionsOrgDeployTrust = opsWorkflowTrust("deploy-org.yml");

// Pinned ahead of the workflow existing, deliberately. Until step 7 creates
// `.github/workflows/deploy-workbench.yml`, no workflow can satisfy this
// condition and the role cannot be assumed at all, which is the correct state
// for a role nothing uses yet. Step 7 must use exactly this filename; if it
// does not, the assume fails with a message that does not obviously point
// here.
export const githubActionsWorkbenchDeployTrust =
  opsWorkflowTrust("deploy-workbench.yml");

// Every Pulumi project needs its own backend access. The shared role never had
// to think about this because it holds s3:* on *; a scoped role does not
// inherit that, and it does not inherit ReadOnlyAccess either.
//
// Scoped per project rather than to the bucket. goodparty-iac-state is shared
// by seven projects today (gp-api, people-api, election-api, delegates, gpvpn,
// campaign-plan-service and ops), and all of them are encrypted with the one
// passphrase granted below. A bucket-wide object grant would therefore let
// either of these roles decrypt and rewrite any of those stacks, and the next
// deploy of the victim project would apply the rewritten state with whatever
// role that project uses. That is the opposite of what this whole change is
// for.
//
// The DIY backend's layout is per project, verified against the live bucket
// rather than assumed:
//
//   .pulumi/stacks/<project>/<stack>.json          (and .bak)
//   .pulumi/locks/organization/<project>/<stack>/  ("organization" is literal)
//   .pulumi/backups/<project>/<stack>/
//   .pulumi/history/<project>/<stack>/
//   .pulumi/meta.yaml                              (bucket-wide, read only)
//
// Trailing slashes matter. A prefix of `.pulumi/stacks/org` without one would
// also match `.pulumi/stacks/organization-anything`.
//
// The passphrase parameter is a SecureString under the AWS-managed
// alias/aws/ssm key. No kms:Decrypt grant is needed: that key's policy admits
// callers in this account via ssm, which is why the shared role decrypts it
// today holding ssm:GetParameter and nothing else. Omitting the ssm grant
// surfaces as a state decryption error that does not obviously point at IAM.
//
// Known wart, not fixed here: every project shares that one passphrase, so the
// separation above is enforced by the object ARNs alone. A passphrase per
// project would make it defence in depth instead. That is a change to the
// existing stacks, not to this one.
const BUCKET = "arn:aws:s3:::goodparty-iac-state";

const pulumiBackendStatements = (project: string): PolicyStatement[] => [
  // ListBucket is deliberately not prefix-conditioned. Pulumi enumerates
  // stacks by listing `.pulumi/stacks/`, so an s3:prefix condition tight
  // enough to matter risks breaking `stack select` in a way nothing here can
  // verify until step 5 runs. What it leaks is key names, which are project
  // and stack names we already publish in this repo. The content boundary is
  // the object statements below, which is where the reviewable risk was.
  {
    Sid: "PulumiStateBucket",
    Effect: "Allow",
    Action: ["s3:ListBucket", "s3:GetBucketLocation"],
    Resource: BUCKET,
  },
  {
    Sid: "PulumiStateObjects",
    Effect: "Allow",
    Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
    Resource: [
      `${BUCKET}/.pulumi/stacks/${project}/*`,
      `${BUCKET}/.pulumi/locks/organization/${project}/*`,
      `${BUCKET}/.pulumi/backups/${project}/*`,
      `${BUCKET}/.pulumi/history/${project}/*`,
    ],
  },
  // Read only, and bucket-wide because it is a single bucket-level file. It
  // already exists, so the backend reads it to check the format version and
  // writes it only when initialising an empty bucket.
  {
    Sid: "PulumiStateMeta",
    Effect: "Allow",
    Action: ["s3:GetObject"],
    Resource: `${BUCKET}/.pulumi/meta.yaml`,
  },
  {
    Sid: "PulumiStatePassphrase",
    Effect: "Allow",
    Action: ["ssm:GetParameter"],
    Resource: "arn:aws:ssm:us-west-2:333022194791:parameter/pulumi-state-config-passphrase",
  },
];

// Correction to an earlier version of this comment, which said Organizations
// actions "are not resource-scopable in any useful way" and that the API
// takes "*" for the calls we make. That is true only of `CreateAccount`.
// Checked against AWS's machine-readable service reference on 2026-09-22,
// the same source `adminReservedActions` was built from:
// `CreateOrganizationalUnit` accepts `organizationalunit` and `root`,
// `MoveAccount` accepts `account`, `organizationalunit` and `root`, and every
// policy action accepts `policy` plus its target types.
//
// The policy statements added for step 9 are scoped accordingly. The two
// older writes are not, which is a known wart rather than a considered
// choice: narrowing `MoveAccount` to the `Workbench` OU would also close the
// move vector documented in docs/workbench-account.md, and it is worth doing
// in a PR that can verify the exact ARNs the provider sends against the
// existing state, rather than riding along here.
//
// organizations:CloseAccount is deliberately absent and must stay absent.
// Nothing in the plan needs it, and its absence is a second barrier alongside
// protect: true against a resource deletion closing a real AWS account, which
// would begin a 90 day suspension. organizations:RemoveAccountFromOrganization
// is absent on the same reasoning: it is the other delete path, the one taken
// when closeOnDeletion is false, and leaving it out means IAM refuses both.
//
// Widening this policy needs its own PR, merged and applied before the PR that
// depends on the widening. It is tempting to pair a grant with the code that
// uses it, and that is wrong here: this policy is applied by the ops stack via
// deploy.yml, while the code using it is applied by deploy-org.yml, and both
// start on the same push to main with nothing sequencing them. A same-PR grant
// races its own consumer. That applies to step 9's service control policy
// actions too.
// Organizations resource ARNs, verified against live AWS on 2026-09-22 rather
// than assembled from the ARN format strings, because the two disagree in a
// way that matters below.
const ORG_ID = "o-uuiolqc1di";
const WORKBENCH_OU_ARN = `arn:aws:organizations::333022194791:ou/${ORG_ID}/ou-jqqe-dv88i5zn`;

/**
 * Every service control policy this organization owns, and nothing else.
 *
 * The wildcard is on the policy id because a policy's id does not exist until
 * it is created, so the grant cannot name it. What the wildcard does not
 * reach is the thing that matters: AWS-managed policies live outside this
 * organization's namespace entirely. `FullAWSAccess` is
 * `arn:aws:organizations::aws:policy/service_control_policy/p-FullAWSAccess`,
 * with `aws` where the account id goes and no `o-` segment at all, so this
 * pattern cannot match it.
 *
 * That is what makes the detach grant below safe. Detaching `FullAWSAccess`
 * from the root is the single action that would break every member account at
 * once, and the role is structurally unable to name it rather than merely
 * discouraged from it.
 */
const ORG_SCP_ARN_PATTERN = `arn:aws:organizations::333022194791:policy/${ORG_ID}/service_control_policy/*`;

// Every policy action accepts this condition key, so it is applied to all of
// them. It keeps the grant to service control policies even if tag policies,
// backup policies or AI opt-out policies are enabled on the root later: those
// are the same API with a different PolicyType, and a role scoped by ARN
// alone would pick them up for free.
const SCP_ONLY = {
  StringEquals: { "organizations:PolicyType": "SERVICE_CONTROL_POLICY" },
};

export const githubActionsOrgDeploy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "OrganizationWrites",
      Effect: "Allow",
      Action: [
        "organizations:CreateOrganizationalUnit",
        "organizations:CreateAccount",
        "organizations:MoveAccount",
        "organizations:TagResource",
        // Paired with TagResource on purpose. Removing or renaming a tag on
        // the OU or the account calls UntagResource, and without it step 5's
        // apply fails partway with AccessDenied against a half-created
        // account.
        "organizations:UntagResource",
      ],
      Resource: "*",
    },
    // Spelled out because a scoped role does not inherit the shared role's
    // ReadOnlyAccess. DescribeCreateAccountStatus is the one Pulumi polls
    // while CreateAccount runs; without it the apply fails mid-creation, with
    // the account already half provisioned.
    {
      Sid: "OrganizationReads",
      Effect: "Allow",
      Action: [
        "organizations:DescribeOrganization",
        "organizations:DescribeOrganizationalUnit",
        "organizations:DescribeAccount",
        "organizations:DescribeCreateAccountStatus",
        "organizations:ListRoots",
        "organizations:ListAccounts",
        "organizations:ListParents",
        "organizations:ListOrganizationalUnitsForParent",
        // Not obvious from the code that will use it, which only asks for an
        // OU. The OU resource exposes a computed `accounts` attribute, so the
        // provider's read-back after CreateOrganizationalUnit lists the OU's
        // children. Without this the create succeeds and the read that
        // follows it fails, which is the worst of both: an OU in the
        // organization, an apply that errored, and possibly no state for it.
        // Organizations does not require OU names to be unique under a
        // parent, so the rerun makes a second Workbench instead of failing.
        "organizations:ListAccountsForParent",
        "organizations:ListTagsForResource",
      ],
      Resource: "*",
    },
    // Step 9. The SCP itself is a separate PR that merges after this grant
    // has finished applying, per the widening rule above.
    {
      Sid: "ServiceControlPolicyWrites",
      Effect: "Allow",
      Action: [
        "organizations:CreatePolicy",
        // Paired with CreatePolicy for the same reason UntagResource is
        // paired with TagResource above. The SCP's document is the thing
        // most likely to change after it first lands, and without this the
        // first tightening pass fails on update rather than on create.
        "organizations:UpdatePolicy",
        // Kept despite nothing in the plan deleting a policy, because
        // removing the resource from the program is how a bad SCP gets
        // withdrawn, and discovering the grant is missing at that moment is
        // discovering it at the worst moment. Unlike CloseAccount and
        // RemoveAccountFromOrganization, deleting a service control policy
        // destroys no data and is recoverable by reapplying.
        "organizations:DeletePolicy",
      ],
      Resource: ORG_SCP_ARN_PATTERN,
      Condition: SCP_ONLY,
    },
    // Attach and detach name two resources, the policy and its target, and
    // the request has to be permitted for both. Listing only our own policy
    // namespace and only the Workbench OU is therefore two independent
    // bounds: this role cannot attach our policy to the root, and it cannot
    // detach FullAWSAccess from anything.
    {
      Sid: "ServiceControlPolicyAttachment",
      Effect: "Allow",
      Action: ["organizations:AttachPolicy", "organizations:DetachPolicy"],
      Resource: [ORG_SCP_ARN_PATTERN, WORKBENCH_OU_ARN],
      Condition: SCP_ONLY,
    },
    {
      Sid: "ServiceControlPolicyReads",
      Effect: "Allow",
      Action: [
        // The provider's read-back after CreatePolicy and after UpdatePolicy.
        "organizations:DescribePolicy",
        // The attachment resource has no describe of its own; it reads back
        // by listing one side or the other.
        "organizations:ListTargetsForPolicy",
      ],
      Resource: ORG_SCP_ARN_PATTERN,
      Condition: SCP_ONLY,
    },
    {
      Sid: "ServiceControlPolicyListingForTarget",
      Effect: "Allow",
      Action: ["organizations:ListPoliciesForTarget"],
      Resource: WORKBENCH_OU_ARN,
      Condition: SCP_ONLY,
    },
    // The one policy action that accepts no resource type at all, so it
    // cannot be scoped and gets its own statement rather than quietly
    // widening one of the scoped ones to "*". It leaks the names of the
    // organization's policies, which is not sensitive.
    {
      Sid: "ServiceControlPolicyListing",
      Effect: "Allow",
      Action: ["organizations:ListPolicies"],
      Resource: "*",
      Condition: SCP_ONLY,
    },
    ...pulumiBackendStatements("org"),
  ],
};

// The management-account half of the workbench deploy path: assumed by
// deploy-workbench.yml on main, and holds the assume grant below plus this
// project's Pulumi backend access. Nothing else in this account.
//
// The account id is written out rather than imported from a constant.
// Hardcoding matches house style (identity-center.ts does the same), and the
// grant has twice had to be applied before the project that consumes it —
// see "Apply ordering between workflows": the grant is in `deploy/` and
// applied by `deploy.yml`, while its consumer is applied by
// `deploy-workbench.yml`.
const WORKBENCH_ACCOUNT_ID = "024901689212";

export const githubActionsWorkbenchDeploy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    // The role's reason to exist: reach the workbench account's deploy role.
    //
    // Until step 10's cutover this granted the Organizations-planted
    // `OrganizationAccountAccessRole`. The move happened as gain-then-remove
    // across step 10's two PRs, because this grant has to be applied before
    // the consumer change merges ("Apply ordering between workflows"). If
    // git history shows the two statements coexisting, that was the
    // transition, not the end state — the end state is this one statement,
    // since keeping the old one would have left a permanent admin path that
    // nothing uses and nobody would notice.
    //
    // The target side narrowed at the same time: the bootstrap role trusted
    // the management account root, delegating the decision to any principal
    // there holding sts:AssumeRole, while `pulumi-deploy` names this role
    // exactly. A cross-account assume needs both sides to allow it, and both
    // sides now agree on a single role.
    {
      Sid: "AssumeWorkbenchDeployRole",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      Resource: `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/pulumi-deploy`,
    },
    ...pulumiBackendStatements("workbench"),
  ],
};
