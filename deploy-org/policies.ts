// The service control policies: one for the Workbench OU and one for the
// Infrastructure OU.
//
// In TypeScript rather than JSON so the shape is type-checked, matching
// deploy/components/*/policies.ts. Design, and the reasoning for every
// statement, is in docs/workbench-account.md under "The workbench SCP" and
// docs/infrastructure-account.md under "The infrastructure SCP". Read the
// relevant one before changing anything here: several of the workbench
// statements look over-cautious until you know what they are guarding, and
// two of its exemptions look like holes until you know what breaks without
// them.
//
// Shape, for both: a deny list layered on top of the AWS-managed
// FullAWSAccess, not an allow-list replacing it. An allow-list means
// detaching FullAWSAccess, and any gap in the replacement takes the account
// out entirely rather than refusing one service.
//
// Scope, so neither is credited with more than it does: each binds every
// principal in its own account, including the in-account `pulumi-deploy` role
// CI deploys as there, and neither binds the management account, which is
// exempt from SCPs by design and is where production runs. The workbench one
// also bound `OrganizationAccountAccessRole` until step 10's cutover.

import { WORKBENCH_ACCOUNT_ID } from "../utils/accounts";

type PolicyValue = string | string[];

type PolicyStatement = {
  Sid: string;
  Effect: "Deny";
  Action?: PolicyValue;
  NotAction?: PolicyValue;
  Resource: PolicyValue;
  Condition?: Record<string, Record<string, PolicyValue>>;
};

type PolicyDocument = {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
};

const REGION = "us-west-2";

/**
 * Services whose calls are not regional, or whose regional calls we
 * deliberately permit everywhere.
 *
 * The first group is the standard one: global services record their calls
 * against `us-east-1`, so a naive region deny refuses them all and locks the
 * account out of IAM and STS along with everything else.
 *
 * The last two are ours and are load-bearing rather than cautious.
 *
 * `bedrock`, because the `us.`-prefixed model ids are geo inference profiles
 * that route each request across member regions by capacity. AWS states it
 * directly: "If any destination Region in a cross-Region inference profile is
 * blocked in your SCPs, the request will fail even if other Regions remain
 * allowed." So this is not a hedge against a maybe. Without it every model
 * call fails, and `moonshotai.kimi-k3` has no in-region fallback at all.
 *
 * `aws-marketplace`, because `scripts/enable-bedrock-models.ts` subscribes to
 * model agreements and walks us-east-1, us-east-2, us-west-1 and us-west-2,
 * and `deploy-workbench.yml` runs it with APPLY=1 after every apply. Without
 * this the guardrail breaks our own pipeline in three of the four regions.
 * That one was found by reading the script rather than by reasoning about the
 * policy, which is the habit worth keeping.
 */
const REGION_EXEMPT_SERVICES = [
  "account:*",
  "aws-marketplace:*",
  "bedrock:*",
  "budgets:*",
  "ce:*",
  "cloudfront:*",
  "iam:*",
  "organizations:*",
  "route53:*",
  "sts:*",
  "support:*",
];

export const workbenchScp: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      // Leaving strands the account outside consolidated billing and outside
      // every governance control at once, including this policy.
      Sid: "DenyLeaveOrganization",
      Effect: "Deny",
      Action: "organizations:LeaveOrganization",
      Resource: "*",
    },
    {
      // Access here is federated through Identity Center. A long-lived access
      // key in an account built for autonomous agents is the credential most
      // likely to end up somewhere it cannot be revoked from.
      //
      // Deliberately not iam:CreateRole. Step 10 creates an in-account
      // deploy role and step 17 creates the role Bedrock assumes to write
      // invocation logs; denying role creation breaks both.
      Sid: "DenyIamUsersAndLongLivedKeys",
      Effect: "Deny",
      Action: [
        "iam:CreateUser",
        "iam:CreateAccessKey",
        "iam:CreateLoginProfile",
      ],
      Resource: "*",
    },
    {
      // Inert today, because there may be no trail in this account yet, and
      // correct the moment there is one. The point of writing it now is that
      // the account is empty; the point of a tamper deny is that it predates
      // whoever would want to tamper.
      Sid: "DenyCloudTrailTampering",
      Effect: "Deny",
      Action: [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors",
      ],
      Resource: "*",
    },
    {
      // The data argument, made structural. These are the stores that would
      // make this account worth attacking, and nothing about running coding
      // agents against Bedrock needs any of them.
      Sid: "DenyDataStores",
      Effect: "Deny",
      Action: ["rds:*", "dynamodb:*", "redshift:*"],
      Resource: "*",
    },
    {
      // Scoped by resource owner rather than by service, because the risk was
      // never this account's own buckets. It was reaching the management
      // account's, which is where voter data lives. The account keeps full use
      // of buckets it owns, so Bedrock batch inference and invocation logging
      // stay available if we ever want them.
      //
      // `IfExists` is the whole control, not a detail. A plain
      // `StringNotEquals` does not match when the key is missing from the
      // request context, and a Deny whose condition does not match does not
      // apply, so the bypass would be silent and total: the statement would
      // read as a guardrail and enforce nothing. `IfExists` matches on
      // absence instead, which fails closed. AWS's own resource perimeter
      // sample uses this operator throughout, for this reason.
      //
      // An earlier version of this statement also carried a
      // `Bool` condition on `aws:ViaAWSService` being false, which was wrong
      // twice over and was caught by Bugbot on PR #77. That key is missing on
      // a direct call, so under `Bool` the condition failed and the Deny
      // applied only to service-mediated requests, the exact inverse of the
      // intent. The deeper error was taking that key from the *network*
      // perimeter row of AWS's data perimeter table and using it in a
      // *resource* perimeter control. AWS's resource perimeter does not use
      // it at all.
      //
      // What AWS uses instead, for the AWS-owned buckets that services read
      // on your behalf, is a `NotResource` allowlist of specific bucket ARNs:
      // SageMaker JumpStart caches, Glue crawler assets, Athena examples,
      // Session Manager downloads and about forty more. Deliberately omitted
      // here. This account runs Bedrock and CloudWatch and none of those
      // services, so the list would be forty ARNs of noise against a 5120
      // byte budget. If one is ever needed the failure is an AccessDenied
      // naming the bucket, and the fix is adding that one ARN.
      //
      // The Pulumi state bucket is in the management account and looks like it
      // should trip this. It does not: deploy-workbench.yml reads the backend
      // with its management-account credentials and assumes into the workbench
      // account only for the AWS provider, and SCPs never apply to the
      // management account.
      //
      // Accepted collateral: calls that name no bucket, ListAllMyBuckets
      // being the obvious one, carry no resource account and are therefore
      // denied. There are no buckets in this account, so nothing is lost
      // today.
      Sid: "DenyS3OutsideThisAccount",
      Effect: "Deny",
      Action: "s3:*",
      Resource: "*",
      Condition: {
        StringNotEqualsIfExists: {
          "aws:ResourceAccount": WORKBENCH_ACCOUNT_ID,
        },
      },
    },
    {
      // NotAction rather than an enumerated Action list: the point is that
      // everything is confined to one region unless named, so the exemption
      // list is the thing to review and the service list is not.
      //
      // Plain `StringNotEquals` here, unlike the statement above, and the
      // asymmetry is deliberate rather than an oversight. This is AWS's
      // canonical region-restriction shape: `aws:RequestedRegion` is present
      // on every call to a regional endpoint, and the calls where it is not
      // meaningful are global services, which `NotAction` already exempts.
      // Using `IfExists` here would deny on absence and so reach exactly
      // those global calls by the back door.
      //
      // Interaction with step 17 worth knowing, because it looks like a
      // problem and is not. Bedrock assumes a role in this account to write
      // invocation logs, and that role is subject to this policy. The logging
      // configuration and its log group are both in us-west-2, so the write is
      // in us-west-2 and allowed. If invocation logging turns out to follow
      // the destination region instead, there is no configuration there to
      // write with, so nothing is written and this statement is not what
      // stopped it. Either way no logs exemption is needed here.
      Sid: "DenyOutsideHomeRegion",
      Effect: "Deny",
      NotAction: REGION_EXEMPT_SERVICES,
      Resource: "*",
      Condition: {
        StringNotEquals: { "aws:RequestedRegion": REGION },
      },
    },
  ],
};

// The service control policy attached to the Infrastructure OU.
//
// Design is in docs/infrastructure-account.md under "The infrastructure SCP".
// It is deliberately three statements where the workbench policy has six. The
// three denies the workbench account can afford are exclusions here rather
// than omissions, and each exclusion is argued in that section: a region deny
// would refuse the cross-region scans and maintenance the account exists for,
// a cross-account S3 deny would block automation that reads other accounts'
// buckets, and a data-store deny would refuse DynamoDB locking and RDS
// reporting before anyone has decided those jobs do not exist.
//
// What remains is only what is universal. These three hold whatever the
// account is used for, which is why they are safe to write now, while it is
// empty. The same review rule as the workbench policy applies: this binds the
// in-account `pulumi-deploy` role step 7 will create, so every future addition
// has to be checked against what deploy-infrastructure.yml does, not only
// against what a person does.
export const infrastructureScp: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      // Leaving strands the account outside consolidated billing and outside
      // every governance control at once, including this policy.
      Sid: "DenyLeaveOrganization",
      Effect: "Deny",
      Action: "organizations:LeaveOrganization",
      Resource: "*",
    },
    {
      // Access here is federated through Identity Center or assumed. A
      // long-lived access key in an account that exists to hold privileged
      // automation is the credential most likely to end up somewhere it
      // cannot be revoked from.
      //
      // Deliberately not iam:CreateRole. Step 7 creates the in-account
      // `pulumi-deploy` and `pulumi-preview` roles and any scanner roles are
      // created by IAM too, so denying role creation breaks the pipeline.
      //
      // This is the statement most likely to need loosening if a third-party
      // tool insists on an IAM user. Loosen it deliberately, in a PR that
      // names the tool.
      Sid: "DenyIamUsersAndLongLivedKeys",
      Effect: "Deny",
      Action: [
        "iam:CreateUser",
        "iam:CreateAccessKey",
        "iam:CreateLoginProfile",
      ],
      Resource: "*",
    },
    {
      // Inert until there is a trail, and correct the moment there is one.
      // This matters more here than in the workbench account: an attacker who
      // reaches privileged automation would want the audit trail off, and a
      // tamper deny written before the trail exists is what makes the trail
      // trustworthy afterwards.
      Sid: "DenyCloudTrailTampering",
      Effect: "Deny",
      Action: [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors",
      ],
      Resource: "*",
    },
  ],
};
