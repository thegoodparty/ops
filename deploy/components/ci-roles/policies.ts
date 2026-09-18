// Captured verbatim from AWS on 2026-09-17: the trust policy of
// github-actions-pulumi-deploy, and version v18 of its attached
// GitHubActionsPulumiDeployPolicy. Both are adopted rather than authored, so
// the acceptance test for the adoption is that a preview reports no change to
// either document. Edit them here from now on, never in the console.
//
// Ordering follows what AWS returned. The provider parses these as JSON, so
// serialisation does not have to match how AWS stores it, but keeping the
// adoption diff empty is worth more than tidying the shape.

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

// Nine repositories, each matched as `:*`, which includes pull_request
// refs. Deliberately captured as-is: narrowing this belongs in its own
// change, not in an adoption that is meant to be a no-op.
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
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": [
            "repo:thegoodparty/gp-api:*",
            "repo:thegoodparty/people-api:*",
            "repo:thegoodparty/election-api:*",
            "repo:thegoodparty/gp-terraform-dataplatform:*",
            "repo:thegoodparty/campaign-plan-service:*",
            "repo:thegoodparty/ops:*",
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

// Organizations actions are not resource-scopable in any useful way: the API
// takes "*" for the calls we make. The boundary here is the trust policy and
// the action list, not the resource.
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
    ...pulumiBackendStatements("org"),
  ],
};

// Backend access only, for now.
//
// The role's actual job is sts:AssumeRole on the deploy role inside the
// workbench account, but that account does not exist until step 5 and its id
// is not known until step 6. Granting it early would mean either a wildcard
// account in the resource ARN or a placeholder that silently rots, so the
// statement is added in step 7, alongside the WORKBENCH_ACCOUNT_ID constant
// and the provider that uses it.
//
// The role is still created here rather than in step 7, because a CI job
// cannot assume a role that does not exist and keeping both roles in one
// change keeps the trust scoping reviewable side by side. Until step 7 it can
// read and write Pulumi state and do nothing else.
export const githubActionsWorkbenchDeploy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [...pulumiBackendStatements("workbench")],
};
