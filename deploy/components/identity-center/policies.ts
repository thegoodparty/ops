// Inline policies for the Identity Center permission sets, in TypeScript so
// the document shape is type-checked rather than trusted. The AWS provider
// parses this field as JSON, so how it serialises does not have to match how
// AWS stores it.

type PolicyValue = string | string[];

export type PolicyStatement = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: PolicyValue;
  Resource?: PolicyValue;
  NotAction?: PolicyValue;
  NotResource?: PolicyValue;
  Condition?: Record<string, Record<string, PolicyValue>>;
};

export type PolicyDocument = {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
};

export const engineerAccess: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:*"],
      Resource: "*",
    },
    {
      Effect: "Allow",
      Action: ["sqs:*"],
      Resource: "*",
    },
    {
      Sid: "DevResourceOperations",
      Effect: "Allow",
      Action: ["*"],
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:ResourceTag/Environment": "dev",
        },
      },
    },
    {
      Sid: "DevResourceCreation",
      Effect: "Allow",
      Action: ["*"],
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:RequestTag/Environment": "dev",
        },
        StringNotEquals: {
          "aws:ResourceTag/Environment": ["prod", "infra"],
        },
      },
    },
    {
      Effect: "Deny",
      Action: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ],
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:ResourceTag/Environment": ["prod", "infra"],
        },
      },
    },
    {
      Sid: "InvokeBedrockModels",
      Effect: "Allow",
      Action: ["bedrock:*"],
      Resource: "*",
    },
    {
      Sid: "TranscribeJobs",
      Effect: "Allow",
      Action: ["transcribe:*"],
      Resource: "*",
    },
  ],
};

export const readOnlyAccess: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Deny",
      Action: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ],
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:ResourceTag/Environment": "prod",
        },
      },
    },
  ],
};

export const productManager: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: [
        "arn:aws:s3:::serve-analyze-data-dev",
        "arn:aws:s3:::serve-analyze-data-qa",
        "arn:aws:s3:::serve-analyze-data-prod",
      ],
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: ["arn:aws:s3:::serve-analyze-data-*/input/*"],
    },
    {
      Effect: "Allow",
      Action: ["s3:*"],
      Resource: [
        "arn:aws:s3:::meeting-pipeline-dev",
        "arn:aws:s3:::meeting-pipeline-dev/*",
      ],
    },
  ],
};

// The whole grant for an engineer working in the workbench account. Unlike
// every other set here it carries no managed policies, so this document is
// the entire session: no `ReadOnlyAccess`, no S3, nothing but the two
// services below.
//
// Why a new set rather than assigning `engineerAccess` to the second account.
// That set already grants `bedrock:*`, so it would work on day one, but it
// also carries `AmazonS3FullAccess` and `ReadOnlyAccess` and two
// tag-conditioned `Action: ["*"]` statements. Provisioning that into the
// workbench account concedes the thing the account boundary exists to make
// true, which is that a coding agent's credentials cannot reach restricted
// data. The account is empty today, so the grant would be harmless today and
// wrong the first time anything lands there.
//
// `bedrock:*` rather than an invoke-only list, deliberately. The narrowing
// that matters already happened at the account boundary: there is nothing
// else in this account to reach. An action list would need revisiting for
// every new Bedrock feature the inner loop picks up, and the failure mode is
// an engineer blocked mid-task by an AccessDenied on something like
// `bedrock:ListInferenceProfiles`. Cross-region inference in particular
// invokes against both an inference profile ARN and the foundation model ARN
// in each region it routes to, which is exactly the shape of grant that gets
// guessed wrong.
//
// It does keep the `adminReservedActions` denies, since `guardrails` defaults
// to true. Those cover organization and identity actions, none of which are
// Bedrock, so nothing here collides with them.
export const workbenchAccess: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "InvokeBedrockModels",
      Effect: "Allow",
      Action: ["bedrock:*"],
      Resource: "*",
    },
    // Read-only, and read-only on purpose: this is for an engineer answering
    // "why is my agent slow" or "what did that invocation cost", not for
    // managing alarms. Bedrock's model invocation logging writes to CloudWatch
    // Logs, so the logs half is what makes a failed invocation debuggable
    // rather than opaque.
    {
      Sid: "ReadCloudWatchMetricsAndLogs",
      Effect: "Allow",
      Action: [
        "cloudwatch:Describe*",
        "cloudwatch:Get*",
        "cloudwatch:List*",
        "logs:Describe*",
        "logs:FilterLogEvents",
        "logs:Get*",
        "logs:List*",
        "logs:StartQuery",
        "logs:StopQuery",
      ],
      Resource: "*",
    },
  ],
};

// ---------------------------------------------------------------------------
// Actions reserved for the AdministratorAccess permission set, denied to every
// other one.
//
// Why a Deny rather than just not granting these. `engineerAccess` grants
// `Action: ["*"]` twice, gated only on Environment tags, so any action that
// accepts a request tag is reachable by tagging the request `dev`. That is how
// `organizations:CreateAccount` ended up available to the Engineers group, and
// closing that is the reason this document exists. A Deny is evaluated before
// every Allow and cannot be satisfied around with a condition, so it keeps
// holding as those Allow statements drift.
//
// Composed into each permission set's inline policy rather than attached as
// its own AWS policy. A permission set accepts exactly one inline policy, and
// the customer-managed alternative is referenced by name rather than ARN, so
// it would have to exist in every account a set is provisioned to. That breaks
// the moment the workbench account arrives.
//
// Scope, so this is not mistaken for more than it is: it constrains sessions
// taken through the permission sets it is applied to, and nothing else. It
// does not touch IAM roles or users in the account. The account-wide version
// of this control is an SCP, and SCPs have no effect on the organization's
// management account, which is where all of these sets except the workbench
// one are assigned. The workbench account is a member account, so step 9 of
// docs/workbench-account.md can put an SCP over it; this document is still
// what constrains the sessions themselves.
//
// Verified against AWS's machine-readable service reference rather than
// guessed, so the verb lists match the services' real action names.
export const adminReservedActions: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    // Writes only. Denying `organizations:*` would also remove the org reads
    // ReadOnlyAccess grants, which cost nothing to keep.
    {
      Sid: "DenyOrganizationWrites",
      Effect: "Deny",
      Action: [
        "organizations:Accept*",
        "organizations:Attach*",
        "organizations:Cancel*",
        "organizations:Close*",
        "organizations:Create*",
        "organizations:Decline*",
        "organizations:Delete*",
        "organizations:Deregister*",
        "organizations:Detach*",
        "organizations:Disable*",
        "organizations:Enable*",
        "organizations:Invite*",
        "organizations:Leave*",
        "organizations:Move*",
        "organizations:Put*",
        "organizations:Register*",
        "organizations:Remove*",
        "organizations:Tag*",
        "organizations:Terminate*",
        "organizations:Untag*",
        "organizations:Update*",
      ],
      Resource: "*",
    },
    // Identity Center administration, across all four of its namespaces.
    //
    // `sso-directory` is the one that is easy to miss, and leaving it out
    // would have made the rest of this statement close to pointless: it
    // carries its own CreateUser, DeleteUser, CreateGroup, AddMemberToGroup
    // and UpdatePassword, so the same directory mutations identitystore
    // exposes are reachable through a second prefix. Raised by Bugbot on the
    // PR that added this.
    //
    // CI manages permission sets through github-actions-pulumi-deploy, which
    // is an IAM role rather than a permission set, so none of this reaches it.
    // Sign-in and MFA enrolment are unaffected too: those happen in the
    // Identity Center portal, against the portal session, before any
    // permission set role exists to carry this policy. What is denied here is
    // calling the directory APIs as an assumed role in the account, which is
    // the thing worth reserving.
    //
    // `sso-oauth` is deliberately absent. Its three actions
    // (CreateTokenWithIAM, IntrospectTokenWithIAM, RevokeTokenWithIAM) are
    // runtime token exchange for identity-aware applications, not directory
    // administration, and denying them would break trusted identity
    // propagation for anything that adopts it later.
    {
      Sid: "DenyIdentityCenterWrites",
      Effect: "Deny",
      Action: [
        "sso:Add*",
        "sso:Associate*",
        "sso:Attach*",
        "sso:Create*",
        "sso:Delete*",
        "sso:Detach*",
        "sso:Disassociate*",
        "sso:Import*",
        "sso:Provision*",
        "sso:Put*",
        "sso:Remove*",
        "sso:Start*",
        "sso:Tag*",
        "sso:Untag*",
        "sso:Update*",
        "identitystore:Add*",
        "identitystore:Create*",
        "identitystore:Delete*",
        "identitystore:Remove*",
        "identitystore:Reserve*",
        "identitystore:Update*",
        "sso-directory:Add*",
        "sso-directory:Complete*",
        "sso-directory:Create*",
        "sso-directory:Delete*",
        "sso-directory:Disable*",
        "sso-directory:Enable*",
        "sso-directory:Import*",
        "sso-directory:Remove*",
        "sso-directory:Start*",
        "sso-directory:Update*",
        // VerifyEmail flips a directory user's email-verified state, which is
        // the same mutation class as the rest of this list. It was missed the
        // first time because the verb lists were built by filtering action
        // names on their prefix, and `Verify` reads as a query. Raised in
        // review. `VerifyEmail` is the only Verify action this namespace has
        // today; the wildcard is for consistency with the entries around it.
        "sso-directory:Verify*",
        // Named rather than wildcarded: identitystore-auth:Batch* would also
        // catch BatchGetSession, which is a read.
        "identitystore-auth:BatchDeleteSession",
      ],
      Resource: "*",
    },
    // Account-level administration. Not reachable today either — none of
    // these accept a request tag, so DevResourceCreation cannot reach them —
    // but account:CloseAccount is the single most destructive action in this
    // whole document. It closes an account and starts a 90 day suspension
    // window nobody can shorten, and it is a separate namespace from
    // organizations:CloseAccount, which deploy/components/ci-roles already
    // withholds from CI on the same reasoning.
    {
      Sid: "DenyAccountAdministration",
      Effect: "Deny",
      Action: [
        "account:Accept*",
        "account:Close*",
        "account:Delete*",
        "account:Disable*",
        "account:Enable*",
        "account:Put*",
        "account:Start*",
      ],
      Resource: "*",
    },
    // IAM principal mutation. Nothing here is reachable today, because no IAM
    // action supports a resource-tag condition key and so `DevResourceOperations`
    // can never match one. That is an accident of how IAM works rather than a
    // control anyone chose, which is exactly why it should not be relied on.
    //
    // The Create verbs are spelled out instead of wildcarded for one reason:
    // `iam:Create*` would also deny `iam:CreateServiceLinkedRole`, which AWS
    // creates implicitly the first time someone uses a service, and there is no
    // way to allow it back. Deny wins, and IAM has no condition key that
    // filters on the action name.
    //
    // `iam:Pass*` is deliberately absent. Passing an existing privileged role
    // to a resource you control is a real escalation route, but denying it
    // outright breaks ordinary work like creating a Lambda or an ECS task, and
    // constraining it properly means knowing which roles are sensitive. That is
    // its own change.
    {
      Sid: "DenyIamPrincipalWrites",
      Effect: "Deny",
      Action: [
        "iam:CreateAccessKey",
        "iam:CreateAccountAlias",
        "iam:CreateDelegationRequest",
        "iam:CreateGroup",
        "iam:CreateInstanceProfile",
        "iam:CreateLoginProfile",
        "iam:CreateOpenIDConnectProvider",
        "iam:CreatePolicy",
        "iam:CreatePolicyVersion",
        "iam:CreateRole",
        "iam:CreateSAMLProvider",
        "iam:CreateServiceSpecificCredential",
        "iam:CreateUser",
        "iam:CreateVirtualMFADevice",
        "iam:Accept*",
        "iam:Add*",
        "iam:Associate*",
        "iam:Attach*",
        "iam:Change*",
        "iam:Deactivate*",
        "iam:Delete*",
        "iam:Detach*",
        "iam:Disable*",
        "iam:Enable*",
        "iam:Put*",
        "iam:Reject*",
        "iam:Remove*",
        "iam:Reset*",
        "iam:Resync*",
        "iam:Send*",
        "iam:Set*",
        "iam:Tag*",
        "iam:Untag*",
        "iam:Update*",
        "iam:Upload*",
      ],
      Resource: "*",
    },
  ],
};
