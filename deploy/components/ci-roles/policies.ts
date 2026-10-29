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
import {
  INFRASTRUCTURE_ACCOUNT_ID,
  MANAGEMENT_ACCOUNT_ID,
  WORKBENCH_ACCOUNT_ID,
} from "../../../utils/accounts";

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

// Four repositories in three statements. Ops is pinned to `main` and to one
// workflow file; gpvpn is pinned to `main`; gp-terraform-dataplatform and omni
// keep the captured `:*` pattern, which includes pull_request refs.
//
// Why the exact pins are not in the wildcard list. `sub` under both
// `StringEquals` and `StringLike` in the same statement is not "either": IAM
// ANDs the condition operators for one key, so the subject would have to be
// both the exact main ref and one of the wildcard patterns at once, and no
// request would match. Each exact pin therefore needs its own statement.
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
// before that, a PR run still assumed this role and would now fail.
//
// Five archived repositories were removed from the wildcard list in step 2 of
// docs/deploy-role-trust.md: gp-api, people-api, election-api, runbooks and
// campaign-plan-service. An archived repository cannot run a workflow, so
// their entries granted nothing and only made the list look load bearing.
//
// The three left after step 2 are live and do assume this role. Correcting an
// earlier version of this comment, which said the other eight stay wildcarded
// because omni's `publish-experiments.yml` assumes the role on
// `pull_request`: it does not, and has not since that workflow's publish job
// was gated to push and workflow_dispatch. What does need `pull_request`
// today is five other omni workflows and one in gp-terraform-dataplatform.
// gpvpn is pinned to main in its own statement (step 9): its only workflow
// runs on push to main, so nothing needed the wildcard. See
// docs/deploy-role-trust.md for what each one does and the order to narrow
// the other two in.
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
            "repo:thegoodparty/gp-terraform-dataplatform:*",
            "repo:thegoodparty/omni:*",
          ],
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
          // Its own statement, because `sub` under StringEquals and StringLike
          // in one statement is ANDed, not ORed. gpvpn's one workflow,
          // `main.yml`, runs only on push to main.
          "token.actions.githubusercontent.com:sub":
            "repo:thegoodparty/gpvpn:ref:refs/heads/main",
        },
      },
    },
  ],
};

// Superseded, and kept only until it can be deleted safely. The role now
// carries the AWS-managed AdministratorAccess as well (ci-roles.ts), so this
// document no longer decides anything and should not accrue new actions: an
// action missing here stopped being an AccessDenied the moment admin
// attached. The comment on `deployPolicy` in ci-roles.ts says why removing it
// is a separate change rather than part of the one that attached admin.
//
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
const opsWorkflowTrust = (...workflowFiles: string[]): TrustPolicyDocument => ({
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
          "token.actions.githubusercontent.com:job_workflow_ref":
            workflowFiles.length === 1
              ? `thegoodparty/ops/.github/workflows/${workflowFiles[0]}@refs/heads/main`
              : workflowFiles.map((f) => `thegoodparty/ops/.github/workflows/${f}@refs/heads/main`),
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

// Pinned ahead of the workflow existing, for the same reason as the workbench
// trust above. Step 7 of `docs/infrastructure-account.md` creates
// `.github/workflows/deploy-infrastructure.yml` and must use exactly this
// filename; until it does, no job can assume the role.
export const githubActionsInfrastructureDeployTrust = opsWorkflowTrust(
  "deploy-infrastructure.yml",
);

// The read-only eval role, for the comment-triggered eval and the dispatched
// one. A list under StringEquals is an OR, and both files are main-only, so
// this widens the role to a second workflow that holds the same read access.
export const githubActionsDelegateEvalTrust = opsWorkflowTrust(
  "delegate-eval.yml",
  "delegate-eval-run.yml",
);

// The one credential that can write the eval cache, kept off the role above
// because every job in delegate-eval.yml can assume that one, including the
// jobs that execute the PR head's code. A job in a called reusable workflow
// presents the called file as its `job_workflow_ref`, so pinning this trust to
// delegate-eval-cache-push.yml means no job in delegate-eval.yml can assume it.
export const githubActionsDelegateEvalCachePushTrust = opsWorkflowTrust(
  "delegate-eval-cache-push.yml",
);

// The hill-climb budget ledger's writer. Kept off the read role and off the
// cache-push role: delegate-eval-run.yml runs candidate code, so it must not
// be able to assume a role that writes spend records, and the cache-push role
// reaches the whole of eval-cache/. A called workflow presents its own file as
// the `job_workflow_ref`, so only delegate-eval-ledger.yml, which runs main's
// code over a cost file main's scoring job made, can assume this one.
export const githubActionsDelegateEvalLedgerTrust = opsWorkflowTrust(
  "delegate-eval-ledger.yml",
);

// One new object per measured dispatch under the ledger prefix, and nothing
// else. Requiring If-None-Match means an entry can be created but never
// replaced, so the role cannot lower a run's recorded spend. It has no delete
// and no read.
export const githubActionsDelegateEvalLedger: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DelegateEvalLedgerAppend",
      Effect: "Allow",
      Action: "s3:PutObject",
      Resource: "arn:aws:s3:::delegate-reviews/eval-cache/ledger/*",
      Condition: { Null: { "s3:if-none-match": "false" } },
    },
  ],
};

// Main's replay results, cached per replay key. Production review records
// under reviews/ are not writable. The condition requires If-None-Match, so S3
// itself refuses to overwrite an entry. (Multipart uploads carry no such
// header and are refused too.) Nothing here reads: the push only puts.
export const githubActionsDelegateEvalCachePush: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DelegateEvalCacheWrite",
      Effect: "Allow",
      Action: "s3:PutObject",
      Resource: "arn:aws:s3:::delegate-reviews/eval-cache/*",
      Condition: { Null: { "s3:if-none-match": "false" } },
    },
  ],
};

export const githubActionsDelegateEval: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DelegateReviewsRead",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:GetObjectVersion"],
      Resource: "arn:aws:s3:::delegate-reviews/*",
    },
    {
      Sid: "DelegateReviewsList",
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: "arn:aws:s3:::delegate-reviews",
    },
  ],
};

// Trust for the PR preview role. The subject is the `pull_request` subject
// exactly: not `:*`, not `main`, and no other repository. Fork PRs cannot
// obtain an OIDC token at all, but the workflow skips them explicitly so the
// failure is a skip rather than a confusing assumption error.
//
// Unlike the scoped deploy roles this cannot also pin `job_workflow_ref`. That
// pin protects a role from a *new* workflow file; here the workflow and the
// Pulumi program both come from the pull request, so the pin would only name
// `@refs/pull/N/merge` and constrain nothing. The role has to be safe to hand
// to an unreviewed branch on that basis alone, which is what its read-only
// policy is for. See `docs/pr-previews.md`.
export const githubActionsPulumiPreviewTrust: TrustPolicyDocument = {
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
          "token.actions.githubusercontent.com:sub":
            "repo:thegoodparty/ops:pull_request",
        },
      },
    },
  ],
};

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

/**
 * Read-only counterpart to `pulumiBackendStatements`, for the PR preview role.
 *
 * A separate function rather than a read-only flag on the one above, on
 * purpose: a flag is one character of drift away from granting writes to a
 * role any branch with push access can assume. Here the write actions in the
 * read-write list are absent by construction, and a test asserts it.
 *
 * No lock objects, and no backups/history either. A preview is expected not to
 * take the state lock or write those. If one turns out to need the lock, the
 * missing grant fails closed with AccessDenied, and the lock objects get added
 * then, scoped to these same projects. See `docs/pr-previews.md`, step 4.
 */
const pulumiBackendReadStatements = (projects: string[]): PolicyStatement[] => [
  {
    Sid: "PulumiStateBucket",
    Effect: "Allow",
    Action: ["s3:ListBucket", "s3:GetBucketLocation"],
    Resource: BUCKET,
  },
  {
    Sid: "PulumiStateObjects",
    Effect: "Allow",
    Action: ["s3:GetObject"],
    Resource: projects.map(
      (project) => `${BUCKET}/.pulumi/stacks/${project}/*`,
    ),
  },
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
// way that matters below. The account segment is `MANAGEMENT_ACCOUNT_ID`
// rather than a repeated literal: the organization is always addressed
// through the management account, and that id already has one home in
// `utils/accounts.ts`.
const ORG_ID = "o-uuiolqc1di";
const WORKBENCH_OU_ARN = `arn:aws:organizations::${MANAGEMENT_ACCOUNT_ID}:ou/${ORG_ID}/ou-jqqe-dv88i5zn`;

// The Infrastructure OU, added by step 4 of
// `docs/infrastructure-account.md`. A second literal rather than a pattern
// over `ou-jqqe-*`: the property this grant is praised for is that the role
// can name only the OUs it is responsible for, and a prefix pattern would
// pick up `ElectionAPI` and every OU added later for free. Recorded from the
// apply that created it, `Deploy org` run 37354688503, not assembled from
// the ARN format string.
const INFRASTRUCTURE_OU_ARN = `arn:aws:organizations::${MANAGEMENT_ACCOUNT_ID}:ou/${ORG_ID}/ou-jqqe-orrk423t`;

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
const ORG_SCP_ARN_PATTERN = `arn:aws:organizations::${MANAGEMENT_ACCOUNT_ID}:policy/${ORG_ID}/service_control_policy/*`;

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
    // namespace and only the two OUs this role is responsible for is
    // therefore two independent bounds: this role cannot attach our policy to
    // the root or to any other OU, and it cannot detach FullAWSAccess from
    // anything.
    {
      Sid: "ServiceControlPolicyAttachment",
      Effect: "Allow",
      Action: ["organizations:AttachPolicy", "organizations:DetachPolicy"],
      Resource: [ORG_SCP_ARN_PATTERN, WORKBENCH_OU_ARN, INFRASTRUCTURE_OU_ARN],
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
    // Both OUs, matching the attachment above. The provider reads an
    // attachment back by listing the target's policies, so this has to name
    // every OU the attachment statement can touch or the read-back fails
    // after the attach has already happened.
    {
      Sid: "ServiceControlPolicyListingForTarget",
      Effect: "Allow",
      Action: ["organizations:ListPoliciesForTarget"],
      Resource: [WORKBENCH_OU_ARN, INFRASTRUCTURE_OU_ARN],
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
// The grant has twice had to be applied before the project that consumes it
// — see "Apply ordering between workflows": the grant is in `deploy/` and
// applied by `deploy.yml`, while its consumer is applied by
// `deploy-workbench.yml`.

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

// The management-account half of the infrastructure deploy path, step 6 of
// `docs/infrastructure-account.md`: assumed by deploy-infrastructure.yml on
// main, and holds the assume grant below plus this project's Pulumi backend
// access. Nothing else in this account.
//
// The grant moved rather than gained. Until step 7's cutover this also granted
// the Organizations-planted `OrganizationAccountAccessRole`, and the cutover
// removed that statement once the provider was repointed at `pulumi-deploy`.
// Git history shows the two coexisting; that was the workbench step 10
// "gain-then-remove" transition, not the end state. Keeping both would have
// left a permanent admin path that nothing uses and nobody would notice.
//
// The target side narrowed at the same time: the bootstrap role trusted the
// management account root, delegating the decision to any principal there
// holding sts:AssumeRole, while `pulumi-deploy` names this role exactly. A
// cross-account assume needs both sides to allow it, and both sides now agree
// on a single role. That narrowing matters more here than it did for
// workbench, because this account exists to hold privileged automation.
export const githubActionsInfrastructureDeploy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    // The role's reason to exist: reach the infrastructure account's deploy
    // role, whose trust names this role exactly.
    {
      Sid: "AssumeInfrastructureDeployRole",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      Resource: `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/pulumi-deploy`,
    },
    ...pulumiBackendStatements("infrastructure"),
  ],
};

/**
 * The whole grant for the PR preview role. Read-only, and only the four
 * projects a PR can preview. The one exception is `sts:AssumeRole`, on the
 * workbench and infrastructure preview roles, which is how a preview reaches
 * those accounts without the admin apply role; each role it reaches holds no
 * permissions.
 *
 * Widened only by observed failures. `ecs:DescribeTaskDefinition` cannot be
 * resource-scoped; it exists so preview mode can resolve the currently
 * deployed delegate image rather than invent a URI. `secretsmanager` is
 * `DescribeSecret` metadata only: the value read was removed in step 3, which
 * is what lets this role exist without `GetSecretValue`.
 */
export const githubActionsPulumiPreview: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    ...pulumiBackendReadStatements([
      "ops",
      "org",
      "workbench",
      "infrastructure",
    ]),
    {
      Sid: "RuntimeSecretMetadata",
      Effect: "Allow",
      // The Secrets Manager secret the ops program looks up by name:
      // `DELEGATES` (`deploy/index.ts`). The `getSecret` data source reads the
      // secret's resource policy along with `DescribeSecret` (tags come back
      // from the describe itself), so `GetResourcePolicy` is needed as well.
      // All metadata; neither returns a value. Found by running a real
      // preview, which failed on `GetResourcePolicy`.
      Action: [
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetResourcePolicy",
      ],
      Resource: [
        "arn:aws:secretsmanager:us-west-2:333022194791:secret:DELEGATES-??????",
      ],
    },
    {
      Sid: "CurrentTaskDefinition",
      Effect: "Allow",
      Action: ["ecs:DescribeTaskDefinition"],
      Resource: "*",
    },
    {
      Sid: "AssumeWorkbenchPreviewRole",
      Effect: "Allow",
      // The workbench stack reaches its account by assuming a role into
      // 024901689212, and a preview must not use the admin apply role. This
      // is the management-side half; the trust on the other side is in
      // deploy-workbench/preview-role.ts. Not read-only like the rest, but
      // it only reaches a role that holds no permissions. Last, so adding it
      // does not renumber the statements above in every later diff.
      Action: ["sts:AssumeRole"],
      Resource: `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/pulumi-preview`,
    },
    {
      Sid: "AssumeInfrastructurePreviewRole",
      Effect: "Allow",
      // The infrastructure stack reaches its account by assuming a role into
      // 394495727159, and a preview must not use the admin apply role. This
      // is the management-side half; the trust on the other side is in
      // deploy-infrastructure/preview-role.ts. Same shape as the workbench
      // assume above, and last for the same reason.
      Action: ["sts:AssumeRole"],
      Resource: `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/pulumi-preview`,
    },
    {
      Sid: "EcrPublicLogin",
      Effect: "Allow",
      // Not for previews. `deploy.yml` assumes this role on pull_request runs
      // to log in to ECR Public before building the worker image: anonymous
      // pulls there are limited per IP and shared runners hit 429s, logged-in
      // pulls are limited per account. A login token reads nothing and pushes
      // nothing (pulling public images needs no permission at all), and
      // neither action can be resource-scoped. Last, for the same reason as
      // the assumes above.
      Action: ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"],
      Resource: "*",
    },
  ],
};

// ---------------------------------------------------------------------------
// The Terraform plan role (step 4 of docs/deploy-role-trust.md)
//
// Two repositories plan Terraform on pull requests today and assume the shared
// admin deploy role to do it: omni's `gp-ai.yml` (its `terraform-plan` job,
// eleven dev roots) and gp-terraform-dataplatform's `on-pull-request.yaml`.
// Neither applies anything, and neither touches Pulumi.
//
// Two subjects on one role, which the rest of this plan argues against for the
// preview roles. It is right here because the separation that matters is plan
// versus apply, not repository: both subjects are read-only, and the denies
// below mean neither can reach anything the other owns.
//
// gp-api's diff workflow is deliberately NOT on this role. Its Pulumi program
// reads secret values at program time, so it cannot run without
// GetSecretValue on a production secret. That is step 4b.

const TF_BUCKET = "arn:aws:s3:::goodparty-terraform-state-us-west-2";

// Every state object a plan on this role may read, allowed below and used
// again as the NotResource of the deny that makes the allow meaningful.
//
// `shared/slack-notifier` is not a `*/dev/*` key and is easy to miss: gp-ai's
// dev roots reach it through `data "terraform_remote_state"`. It read fine
// before the deny existed, because ReadOnlyAccess covered it.
//
// The `.tflock` object is on this list because releasing a lock reads it
// before deleting it, to check the ID it is about to remove is the one it
// took. `DataplatformStateLock` below allows the Put and the Delete, but the
// deny's NotResource is what decides the Get, and an explicit deny beats the
// ReadOnlyAccess that would otherwise cover it. Leaving it off let a plan
// take the lock and then fail to release it, stranding the lockfile and
// blocking every later plan until someone removed it by hand.
const TF_STATE_READABLE = [
  `${TF_BUCKET}/*/dev/terraform.tfstate`,
  `${TF_BUCKET}/dataplatform/terraform.tfstate`,
  `${TF_BUCKET}/dataplatform/terraform.tfstate.tflock`,
  `${TF_BUCKET}/shared/slack-notifier/terraform.tfstate`,
];

export const githubActionsPulumiPlanTrust: TrustPolicyDocument = {
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
          // Multiple values for one key under one operator are ORed, so this
          // is a single statement. Exact matches, not `:*`: main runs keep the
          // deploy role, and no other ref should hold this one.
          //
          // No `job_workflow_ref` pin, unlike the scoped roles above. It would
          // name `@refs/pull/N/merge` and constrain nothing, because the
          // workflow file comes from the pull request too.
          "token.actions.githubusercontent.com:sub": [
            "repo:thegoodparty/omni:pull_request",
            "repo:thegoodparty/gp-terraform-dataplatform:pull_request",
          ],
        },
      },
    },
  ],
};

/**
 * Inline half of the plan role. The other half is the AWS-managed
 * `ReadOnlyAccess`, attached in ci-roles.ts.
 *
 * Why a managed policy plus denies, rather than the enumerate-and-widen
 * discipline the preview role above uses. `terraform plan` reads whatever its
 * roots manage, and these twelve roots span Lambda, ECS, SQS, SNS, DynamoDB,
 * EventBridge, S3, IAM and VPC endpoints. Enumerating that surface means
 * several rounds of red pull requests in omni, each needing a deploy here
 * first, and it silently breaks again every time a root is added.
 *
 * The objection `pr-previews.md` raises to `ReadOnlyAccess` is precise and
 * still stands: it carries broad `s3:Get*` and `ssm:Get*`, which together read
 * every project's Pulumi state and the passphrase that decrypts it. The denies
 * below remove exactly that, and cost these two subjects nothing, because a
 * Terraform plan needs no Pulumi state, no secret values and no passphrase.
 * An explicit Deny beats an Allow from any attached policy, so this holds even
 * if AWS widens `ReadOnlyAccess` later.
 */
export const githubActionsPulumiPlan: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "TerraformStateBucket",
      Effect: "Allow",
      Action: ["s3:ListBucket", "s3:GetBucketLocation"],
      Resource: TF_BUCKET,
    },
    {
      // Scoped to the states these two actually plan. gp-ai plans only its
      // dev roots on a pull request ("Only dev is planned" in gp-ai.yml), so
      // the prod states are not reachable from here.
      Sid: "TerraformStateObjects",
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: TF_STATE_READABLE,
    },
    {
      // The allow above is not the whole story, and this is the statement that
      // makes it one. `ReadOnlyAccess` grants `s3:GetObject` on `*`, so
      // scoping the allow scopes nothing: without this deny the role reads
      // every object in the account, including `*/prod/terraform.tfstate`.
      // Terraform state stores resource attributes in plaintext, and gp-ai's
      // prod roots put values derived from AI_SECRETS_PROD into theirs, so
      // that is a production secret read by another name.
      //
      // Verified against the live role by `iam simulate-principal-policy`
      // rather than reasoned about: before this statement,
      // `broker/prod/terraform.tfstate` evaluated to `allowed`.
      //
      // NotResource, so anything not on the list is denied, including buckets
      // that do not exist yet. Terraform plans read no other S3 object: there
      // is no `aws_s3_object` data source in either repo, and every
      // `terraform_remote_state` key is on the list.
      //
      // `GetObjectVersion` is a separate IAM action that returns object
      // content for a given `versionId`, and `ReadOnlyAccess` grants it, so
      // denying only `GetObject` leaves the same prod state readable one
      // parameter away. This bucket has versioning `Enabled`, checked against
      // AWS, so that was a live bypass rather than a theoretical one. Denying
      // both is free: the S3 backend reads the current version and never
      // passes a `versionId`.
      Sid: "DenyOtherS3Objects",
      Effect: "Deny",
      Action: ["s3:GetObject", "s3:GetObjectVersion"],
      NotResource: TF_STATE_READABLE,
    },
    {
      // gp-terraform-dataplatform plans without `-lock=false`, so it takes the
      // real lock. Its backend sets `use_lockfile = true`, so the lock is an
      // S3 object rather than a DynamoDB item, and this is the whole grant.
      // gp-ai passes `-lock=false` and needs none of it.
      Sid: "DataplatformStateLock",
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:DeleteObject"],
      Resource: `${TF_BUCKET}/dataplatform/terraform.tfstate.tflock`,
    },
    {
      // The Pulumi backend, denied outright. Nothing on this role plans
      // Pulumi, and this is the bucket `ReadOnlyAccess` would otherwise open.
      Sid: "DenyPulumiState",
      Effect: "Deny",
      Action: "s3:*",
      Resource: [BUCKET, `${BUCKET}/*`],
    },
    {
      // Blanket. No plan on this role reads a secret value: gp-ai's
      // `shared-infra` roots take SERVE_API_KEY as a variable that
      // ci-plan-root.sh fills from the root's own state, and no gp-ai root
      // manages an `aws_secretsmanager_secret_version`, which Terraform would
      // refresh during plan. gp-terraform-dataplatform reads none either.
      //
      // So a root that starts reading a secret at plan time fails here with
      // a clean AccessDenied, rather than widening this role. The fix belongs
      // in the root, as in step 4c of docs/deploy-role-trust.md.
      //
      // BatchGetSecretValue needs GetSecretValue on each secret it returns,
      // so this deny covers it too.
      Sid: "DenySecretValues",
      Effect: "Deny",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: "*",
    },
    {
      // Blanket, matching the shape above. `ReadOnlyAccess` grants
      // `ssm:GetParameter*` on `*`, and neither planner reads an SSM
      // parameter: there is no `aws_ssm_parameter` data source in gp-ai's
      // roots or in gp-terraform-dataplatform, checked rather than assumed.
      // Naming the passphrase and the Grafana tokens specifically would leave
      // every other parameter, and every one added later, readable by
      // PR-authored code.
      //
      // `GetParameterHistory` is in the list because it returns prior
      // versions including current SecureString values in plaintext, so
      // denying only the three obvious reads leaves the passphrase reachable.
      Sid: "DenySensitiveParameters",
      Effect: "Deny",
      Action: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:GetParameterHistory",
      ],
      Resource: "*",
    },
    {
      Sid: "EcrPublicLogin",
      Effect: "Allow",
      // Not for plans. omni's `gp-ai.yml` assumes this role in its pull
      // request image builds to log in to ECR Public: anonymous pulls there
      // are limited per IP and shared runners hit 429s, logged-in pulls are
      // limited per account. A login token reads nothing and pushes nothing
      // (pulling public images needs no permission at all), and neither
      // action can be resource-scoped. Any omni pull request can already
      // assume this role by editing gp-ai.yml, so handing it to the build job
      // exposes nothing new.
      Action: ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"],
      Resource: "*",
    },
  ],
};

// ---------------------------------------------------------------------------
// The gp-api preview role boundary (step 6a of docs/deploy-role-trust.md)
//
// A permissions boundary, not a grant. omni's gp-api preview stack creates two
// IAM roles per pull request, an ECS execution role and a task role, and
// writes their policies from the pull request's own branch. A role's effective
// permissions are the intersection of its identity policies and its boundary,
// so whatever a pull request writes into those roles, they can do no more than
// this document allows.
//
// Sized to what the preview task already holds on main, not to what a dev
// task holds: the union of the execution role's needs (pull the gp-api image,
// write its own log stream, read GP_API_DEV at task start) and the preview
// branch of the task role's statements in omni's
// `packages/gp-api/deploy/index.ts`. A grant the preview task gains in omni
// therefore needs this document widened first, in its own merged and applied
// change, per the ordering rule in docs/deploy-role-trust.md. The failure
// without it is an AccessDenied inside the running preview, which is the
// intended fail-closed behaviour.
//
// Nothing here reaches IAM, STS, SSM parameters, any secret but GP_API_DEV, or
// any bucket or queue a dev or prod task owns rather than shares with preview.
//
// A managed policy rather than an inline one, because a boundary has to be
// one: `PutRolePermissionsBoundary` takes a policy ARN. See ci-roles.ts.

export const GP_API_PREVIEW_ROLE_BOUNDARY_NAME = "GpApiPreviewRoleBoundary";

export const GP_API_PREVIEW_ROLE_BOUNDARY_ARN = `arn:aws:iam::333022194791:policy/${GP_API_PREVIEW_ROLE_BOUNDARY_NAME}`;

// The two buckets each preview stack creates for itself, named
// `<prefix>-pr-<n>` from the stack's stage.
const PREVIEW_OWNED_BUCKETS = [
  "arn:aws:s3:::tevyn-poll-csvs-pr-*",
  "arn:aws:s3:::zip-to-area-code-mappings-pr-*",
];

// Dev buckets a preview shares rather than owns, named one by one. A pattern
// such as `*-dev` would also reach every dev bucket added later, by anyone.
const PREVIEW_SHARED_DEV_BUCKETS = [
  "arn:aws:s3:::annotation-attachments-dev",
  "arn:aws:s3:::goodparty-chat-attachments-dev",
  "arn:aws:s3:::campaign-plan-shares-dev",
  "arn:aws:s3:::robocall-audio-dev",
  "arn:aws:s3:::gp-agent-run-inputs-dev",
  "arn:aws:s3:::meeting-pipeline-dev",
  "arn:aws:s3:::serve-analyze-data-dev",
  "arn:aws:s3:::assets-dev.goodparty.org",
];

const PREVIEW_READ_ONLY_DEV_BUCKETS = ["arn:aws:s3:::gp-agent-artifacts-dev"];

const PREVIEW_QUEUES = [
  "arn:aws:sqs:us-west-2:333022194791:pr-*-Queue.fifo",
  "arn:aws:sqs:us-west-2:333022194791:pr-*-DLQ.fifo",
];

const objectsIn = (buckets: string[]) => buckets.map((b) => `${b}/*`);

export const gpApiPreviewRoleBoundary: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      // The execution role's half. AmazonECSTaskExecutionRolePolicy grants
      // these on "*"; the boundary narrows them to the one repository the
      // preview image comes from and the preview's own log groups.
      // GetAuthorizationToken takes no resource.
      Sid: "PullGpApiImage",
      Effect: "Allow",
      Action: [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ],
      Resource: "arn:aws:ecr:us-west-2:333022194791:repository/gp-api",
    },
    {
      Sid: "EcrLogin",
      Effect: "Allow",
      Action: ["ecr:GetAuthorizationToken"],
      Resource: "*",
    },
    {
      Sid: "OwnLogStreams",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: "arn:aws:logs:us-west-2:333022194791:log-group:/sst/cluster/gp-pr-*",
    },
    {
      // Every container secret on a preview comes from GP_API_DEV. This is
      // the ceiling, whatever the execution role's own policy says: today
      // that policy is `*` over secrets and SSM parameters (step 6b of the
      // plan), and under this boundary it reaches this one secret.
      Sid: "DevAppSecret",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: "arn:aws:secretsmanager:us-west-2:333022194791:secret:GP_API_DEV-??????",
    },
    {
      Sid: "OwnAndSharedBucketObjects",
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
      ],
      Resource: objectsIn([...PREVIEW_OWNED_BUCKETS, ...PREVIEW_SHARED_DEV_BUCKETS]),
    },
    {
      Sid: "ReadOnlyBucketObjects",
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: objectsIn(PREVIEW_READ_ONLY_DEV_BUCKETS),
    },
    {
      Sid: "BucketListing",
      Effect: "Allow",
      Action: ["s3:ListBucket", "s3:GetBucketLocation"],
      Resource: [
        ...PREVIEW_OWNED_BUCKETS,
        ...PREVIEW_SHARED_DEV_BUCKETS,
        ...PREVIEW_READ_ONLY_DEV_BUCKETS,
      ],
    },
    {
      // The preview's own FIFO queue and its dead-letter queue, by their full
      // name shape rather than `pr-*`, so a queue someone else names `pr-...`
      // is not reached. Dev and prod queues are `develop-*` and `master-*`,
      // and a preview gets no agent dispatch queue.
      Sid: "OwnQueues",
      Effect: "Allow",
      Action: [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueUrl",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility",
      ],
      Resource: PREVIEW_QUEUES,
    },
    {
      // Actions that take no resource, copied from the task role's preview
      // statements as they stand. ssmmessages is ECS Exec's channel into the
      // container, not SSM parameter access.
      Sid: "UnscopableServiceCalls",
      Effect: "Allow",
      Action: [
        "route53domains:List*",
        "route53domains:Get*",
        "route53domains:CheckDomainAvailability",
        "ssmmessages:OpenDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:CreateControlChannel",
        "transcribe:StartTranscriptionJob",
        "transcribe:GetTranscriptionJob",
        "transcribe:StartStreamTranscription",
        "transcribe:StartStreamTranscriptionWebSocket",
        "polly:SynthesizeSpeech",
        "textract:DetectDocumentText",
        "textract:AnalyzeDocument",
      ],
      Resource: "*",
    },
  ],
};

// ---------------------------------------------------------------------------
// The gp-api preview deploy role (step 6 of docs/deploy-role-trust.md)
//
// Assumed by omni's `gp-api.yml` preview job and `gp-api-teardown-preview.yml`
// on pull requests, which today assume the shared admin deploy role. Unlike
// the plan and preview roles above, this one applies: a preview environment is
// an ECS service, a target group, a listener rule, two queues, two buckets and
// two IAM roles, and the role has to be able to create and destroy all of
// them.
//
// The threat model, as the plan states it. The role is assumable by anyone
// with push access to omni, running unreviewed code: both the workflow and the
// Pulumi program come from the pull request. It cannot be made harmless. What
// it can be is much smaller than administrator, and kept away from dev and
// prod: every write is scoped to a preview name or a preview tag, the roles
// it creates are capped by `gpApiPreviewRoleBoundary`, and it reads one
// secret.
//
// Sized from the code on omni's main and from CloudTrail for one create, one
// update and one teardown of a live preview under the shared role
// (2026-10-28), not by enumerating services. Widened only by observed
// failures, the discipline `pr-previews.md` step 4 set.

export const githubActionsPreviewDeployTrust: TrustPolicyDocument = {
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
          // omni's pull_request subject exactly, and nothing else ever. Main
          // runs, including the scheduled preview cleanup, keep the deploy
          // role. No `job_workflow_ref` pin: it would name
          // `@refs/pull/N/merge` and constrain nothing.
          "token.actions.githubusercontent.com:sub": "repo:thegoodparty/omni:pull_request",
        },
      },
    },
  ],
};

/**
 * Backend access for one project's preview stacks, and none of its others.
 *
 * Not `pulumiBackendStatements("gp-api")`, which covers every gp-api stack.
 * gp-api's dev and prod stacks share the project prefix with its previews,
 * and their state holds the Aurora master passwords as Pulumi secrets, which
 * the shared passphrase below decrypts. The stack-name prefix is what keeps a
 * pull request to its own kind of stack.
 *
 * Read and write, unlike `pulumiBackendReadStatements`: a new pull request's
 * stack does not exist yet, so `stack select --create` writes it, and
 * teardown's `cancel` and `stack rm` delete the lock and the stack file.
 */
const pulumiBackendStackStatements = (
  project: string,
  stackPrefix: string,
): PolicyStatement[] => [
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
      `${BUCKET}/.pulumi/stacks/${project}/${stackPrefix}*`,
      `${BUCKET}/.pulumi/locks/organization/${project}/${stackPrefix}*`,
      `${BUCKET}/.pulumi/backups/${project}/${stackPrefix}*`,
      `${BUCKET}/.pulumi/history/${project}/${stackPrefix}*`,
    ],
  },
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

const PREVIEW_ROLES = "arn:aws:iam::333022194791:role/gp-pr-*";

// Every resource a preview stack creates carries these, from the stack's
// `aws:defaultTags` in omni's `infra-cli.ts`. Required on create so a new
// resource cannot be born outside the tag scope, and required on everything
// after so a dev or prod resource cannot be modified through it.
const PREVIEW_REQUEST_TAGS = {
  StringEquals: {
    "aws:RequestTag/Environment": "preview",
    "aws:RequestTag/Project": "gp-api",
  },
};

const PREVIEW_RESOURCE_TAG = {
  StringEquals: { "aws:ResourceTag/Environment": "preview" },
};

// The shared preview ALB is owned by gp-api's dev stack and tagged
// `Environment=dev`, so its listener is reached by name, not by tag. Every
// rule on it routes a `*.preview.goodparty.org` host to a preview.
const SHARED_PREVIEW_LISTENER =
  "arn:aws:elasticloadbalancing:us-west-2:333022194791:listener/app/gp-api-previews/*";
const SHARED_PREVIEW_LISTENER_RULES =
  "arn:aws:elasticloadbalancing:us-west-2:333022194791:listener-rule/app/gp-api-previews/*";

export const githubActionsPreviewDeploy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    ...pulumiBackendStackStatements("gp-api", "gp-api-pr-"),
    {
      // The SHA-tagged image and the `buildcache-<hash>` layer cache, both in
      // the one repository. gp-api's tags are immutable, so a push cannot
      // overwrite an image a dev or prod deploy already runs.
      Sid: "PushGpApiImage",
      Effect: "Allow",
      Action: [
        "ecr:DescribeImages",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
      ],
      Resource: "arn:aws:ecr:us-west-2:333022194791:repository/gp-api",
    },
    {
      // Neither login token reads or pushes anything, and neither action takes
      // a resource. ECR Public is for the base images, as on the PR-only roles
      // above.
      Sid: "RegistryLogin",
      Effect: "Allow",
      Action: [
        "ecr:GetAuthorizationToken",
        "ecr-public:GetAuthorizationToken",
        "sts:GetServiceBearerToken",
      ],
      Resource: "*",
    },
    {
      // Read at program time. `index.ts` calls `getSecretVersion` on
      // GP_API_DEV for every preview: the key names build the task
      // definition's secret list. The same class as steps 4b and 4c, and the
      // one secret this role can read. `getSecret` reads the resource policy
      // alongside the describe.
      Sid: "DevAppSecretForProgram",
      Effect: "Allow",
      Action: [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetResourcePolicy",
      ],
      Resource: "arn:aws:secretsmanager:us-west-2:333022194791:secret:GP_API_DEV-??????",
    },
    {
      // `aws.rds.getCluster` on the shared preview cluster, at program time,
      // and teardown's endpoint lookup. Describe only: previews create no RDS
      // resource (`skipPerPrRds`), and each preview's database is created by
      // its own container, so no RDS write is needed at all.
      Sid: "SharedPreviewCluster",
      Effect: "Allow",
      Action: ["rds:DescribeDBClusters"],
      Resource: "arn:aws:rds:us-west-2:333022194791:cluster:gp-api-preview-shared-db",
    },
    {
      // Scoped by name rather than tag. Every ECS resource a preview creates
      // carries the stack's `pr-<n>` stage in its name, which no dev or prod
      // resource does, and ECS's tag condition support is uneven across these
      // actions (the service reference lists none for DeleteCluster or
      // UpdateService), so the name is the bound that holds for all of them.
      Sid: "PreviewEcs",
      Effect: "Allow",
      Action: [
        "ecs:CreateCluster",
        "ecs:UpdateCluster",
        "ecs:UpdateClusterSettings",
        "ecs:DeleteCluster",
        "ecs:DescribeClusters",
        "ecs:RegisterTaskDefinition",
        "ecs:CreateService",
        "ecs:UpdateService",
        "ecs:DeleteService",
        "ecs:DescribeServices",
        "ecs:TagResource",
        "ecs:UntagResource",
        "ecs:ListTagsForResource",
      ],
      Resource: [
        "arn:aws:ecs:us-west-2:333022194791:cluster/gp-pr-*",
        "arn:aws:ecs:us-west-2:333022194791:service/gp-pr-*/*",
        "arn:aws:ecs:us-west-2:333022194791:task-definition/gp-pr-*",
      ],
    },
    {
      // AWS defines no resource for either. Deregistering marks a revision
      // inactive and does not stop what is running on it.
      Sid: "EcsTaskDefinitionsUnscoped",
      Effect: "Allow",
      Action: ["ecs:DescribeTaskDefinition", "ecs:DeregisterTaskDefinition"],
      Resource: "*",
    },
    {
      // Teardown drops the preview's database by running the preview's own
      // task definition in the preview's own cluster, before the destroy. Not
      // the dev task definition on the dev cluster, which is how it was done
      // under the shared role: that hands a pull request the dev task role and
      // a command override. The preview task already holds everything the drop
      // needs, so this adds no reach a running preview does not have.
      Sid: "TeardownDropTask",
      Effect: "Allow",
      Action: ["ecs:RunTask"],
      Resource: "arn:aws:ecs:us-west-2:333022194791:task-definition/gp-pr-*",
      Condition: {
        ArnLike: { "ecs:cluster": "arn:aws:ecs:us-west-2:333022194791:cluster/gp-pr-*" },
      },
    },
    {
      Sid: "TeardownDropTaskWait",
      Effect: "Allow",
      Action: ["ecs:DescribeTasks", "ecs:StopTask"],
      Resource: "arn:aws:ecs:us-west-2:333022194791:task/gp-pr-*/*",
    },
    {
      // Registering the task definition and running the drop task both pass
      // the preview's two roles, and only to ECS tasks.
      Sid: "PassPreviewRoles",
      Effect: "Allow",
      Action: ["iam:PassRole"],
      Resource: PREVIEW_ROLES,
      Condition: {
        StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
      },
    },
    {
      // The step 6a condition. Every action that can give a preview role a
      // permission requires the request to name the boundary, so a role this
      // credential creates or edits is capped by it whatever the pull request
      // writes into its policies or its trust. For CreateRole and
      // PutRolePermissionsBoundary the key is the boundary being set; for the
      // rest it is the boundary the role already carries, so a role created
      // without one, before this role existed, cannot be widened here.
      Sid: "BoundedPreviewRoles",
      Effect: "Allow",
      Action: [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:AttachRolePolicy",
        "iam:PutRolePermissionsBoundary",
        "iam:UpdateAssumeRolePolicy",
      ],
      Resource: PREVIEW_ROLES,
      Condition: {
        StringEquals: { "iam:PermissionsBoundary": GP_API_PREVIEW_ROLE_BOUNDARY_ARN },
      },
    },
    {
      // Reads, tags, and removals. None of these can add a permission, so
      // they need no boundary condition, and leaving it off lets a teardown
      // delete a preview role created before the boundary existed.
      Sid: "ManagePreviewRoles",
      Effect: "Allow",
      Action: [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole",
        "iam:ListRoleTags",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateRoleDescription",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:DeleteRole",
      ],
      Resource: PREVIEW_ROLES,
    },
    {
      // Belt and braces for the condition above, and the plan's "must not be
      // able to modify or remove the boundary itself". Nothing above grants
      // these, so this only matters if a later edit widens the role.
      Sid: "DenyBoundaryTampering",
      Effect: "Deny",
      Action: [
        "iam:DeleteRolePermissionsBoundary",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:DeletePolicy",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      Resource: "*",
    },
    {
      // The target group is created with `namePrefix: 'HTTP'` and an
      // AWS-generated suffix, the same prefix dev and prod use, so no name
      // pattern separates it. The tag condition does, which is the plan's
      // reason for scoping by tag. The listener rule goes on the shared
      // preview listener, named above.
      Sid: "CreatePreviewRouting",
      Effect: "Allow",
      Action: ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:CreateRule"],
      Resource: [
        "arn:aws:elasticloadbalancing:us-west-2:333022194791:targetgroup/*",
        SHARED_PREVIEW_LISTENER,
      ],
      Condition: PREVIEW_REQUEST_TAGS,
    },
    {
      // Tagging is part of those two creates. Restricted to them so this
      // cannot tag a dev resource `Environment=preview` and then reach it
      // through the statement below.
      Sid: "TagPreviewRoutingOnCreate",
      Effect: "Allow",
      Action: ["elasticloadbalancing:AddTags"],
      Resource: [
        "arn:aws:elasticloadbalancing:us-west-2:333022194791:targetgroup/*",
        SHARED_PREVIEW_LISTENER_RULES,
      ],
      Condition: {
        StringEquals: {
          "elasticloadbalancing:CreateAction": ["CreateTargetGroup", "CreateRule"],
        },
      },
    },
    {
      // Everything after create, on preview-tagged resources only. The load
      // balancer and listener deletes are for stacks still on a per-PR ALB
      // from before the shared one existed; a preview no longer creates one,
      // so neither create is granted.
      Sid: "ManagePreviewRouting",
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:ModifyTargetGroup",
        "elasticloadbalancing:ModifyTargetGroupAttributes",
        "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:ModifyRule",
        "elasticloadbalancing:DeleteRule",
        "elasticloadbalancing:AddTags",
        "elasticloadbalancing:RemoveTags",
        "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:DeleteLoadBalancer",
      ],
      Resource: [
        "arn:aws:elasticloadbalancing:us-west-2:333022194791:targetgroup/*",
        SHARED_PREVIEW_LISTENER_RULES,
        "arn:aws:elasticloadbalancing:us-west-2:333022194791:loadbalancer/app/gpapi-pr-*",
        "arn:aws:elasticloadbalancing:us-west-2:333022194791:listener/app/gpapi-pr-*",
      ],
      Condition: PREVIEW_RESOURCE_TAG,
    },
    {
      // Metadata only, and AWS defines no resource for any of them.
      Sid: "DescribeNetworking",
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:Describe*",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeNetworkInterfaces",
      ],
      Resource: "*",
    },
    {
      // A per-PR ALB stack's security group, on its way out. Same reason as
      // the load balancer delete above.
      Sid: "DeleteLegacyPreviewSecurityGroup",
      Effect: "Allow",
      Action: ["ec2:DeleteSecurityGroup"],
      Resource: "arn:aws:ec2:us-west-2:333022194791:security-group/*",
      Condition: PREVIEW_RESOURCE_TAG,
    },
    {
      // A per-PR ALB stack's two alias records, also on their way out. The
      // zone is goodparty.org, so the change is held to deleting A and AAAA
      // records under `pr-*.preview.goodparty.org`: this cannot create a
      // record, or touch one outside the preview names.
      Sid: "DeleteLegacyPreviewRecords",
      Effect: "Allow",
      Action: ["route53:ChangeResourceRecordSets"],
      Resource: "arn:aws:route53:::hostedzone/Z10392302OXMPNQLPO07K",
      Condition: {
        "ForAllValues:StringEquals": {
          "route53:ChangeResourceRecordSetsActions": ["DELETE"],
          "route53:ChangeResourceRecordSetsRecordTypes": ["A", "AAAA"],
        },
        "ForAllValues:StringLike": {
          "route53:ChangeResourceRecordSetsNormalizedRecordNames": [
            "pr-*.preview.goodparty.org",
          ],
        },
      },
    },
    {
      Sid: "ReadPreviewZone",
      Effect: "Allow",
      Action: ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:GetChange"],
      Resource: [
        "arn:aws:route53:::hostedzone/Z10392302OXMPNQLPO07K",
        "arn:aws:route53:::change/*",
      ],
    },
    {
      // The service's log group, and the Container Insights group ECS creates
      // on its own and teardown deletes by hand.
      Sid: "PreviewLogGroups",
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:TagLogGroup",
        "logs:UntagLogGroup",
        "logs:ListTagsForResource",
        "logs:ListTagsLogGroup",
      ],
      Resource: [
        "arn:aws:logs:us-west-2:333022194791:log-group:/sst/cluster/gp-pr-*",
        "arn:aws:logs:us-west-2:333022194791:log-group:/aws/ecs/containerinsights/gp-pr-*",
      ],
    },
    {
      Sid: "DescribeLogGroups",
      Effect: "Allow",
      Action: ["logs:DescribeLogGroups"],
      Resource: "*",
    },
    {
      // `pr-<n>-Queue.fifo` and `pr-<n>-DLQ.fifo`, the same shapes the
      // boundary names. Lifecycle only: the app sends and receives through its
      // task role, not through this one.
      Sid: "PreviewQueues",
      Effect: "Allow",
      Action: [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:GetQueueAttributes",
        "sqs:SetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:ListQueueTags",
      ],
      Resource: PREVIEW_QUEUES,
    },
    {
      // The two buckets each preview owns. The reads are what the provider
      // calls on every refresh of a bucket; the object deletes are
      // `forceDestroy` emptying it at teardown. No policy or ACL writes: the
      // stack sets neither, so the public access block it does set cannot be
      // undercut from here.
      Sid: "PreviewBuckets",
      Effect: "Allow",
      Action: [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetBucket*",
        "s3:GetAccelerateConfiguration",
        "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetReplicationConfiguration",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketTagging",
      ],
      Resource: [
        "arn:aws:s3:::tevyn-poll-csvs-pr-*",
        "arn:aws:s3:::zip-to-area-code-mappings-pr-*",
      ],
    },
    {
      Sid: "EmptyPreviewBuckets",
      Effect: "Allow",
      Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
      Resource: [
        "arn:aws:s3:::tevyn-poll-csvs-pr-*/*",
        "arn:aws:s3:::zip-to-area-code-mappings-pr-*/*",
      ],
    },
    {
      // The plan's "no write to any resource carrying the production tags",
      // as a deny so it holds whatever is later added above. Nothing this role
      // legitimately touches is tagged `Environment=prod`. The shared VPC is,
      // and this role acts on nothing in it directly: ECS places the tasks.
      Sid: "DenyProductionTagged",
      Effect: "Deny",
      Action: "*",
      Resource: "*",
      Condition: { StringEquals: { "aws:ResourceTag/Environment": "prod" } },
    },
  ],
};
