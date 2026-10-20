import * as aws from "@pulumi/aws";
import {
  IDENTITY_STORE_ARN,
  INFRASTRUCTURE_ACCOUNT_ID,
} from "../../utils/accounts";
import type { PolicyDocument } from "./identity-center/policies";

// The management-account role the identity-group-sync Lambda (infrastructure
// account, step 3 of `docs/google-group-sync.md`) assumes to mirror a Google
// Workspace group into an Identity Center group. It is the same cross-account
// pattern as `sheriff-grant.ts`: the Lambda's own role gets `sts:AssumeRole`
// on this ARN and no `identitystore` action of its own, and this role's inline
// policy is the boundary that keeps "the job can only touch the directory it
// names" true.
//
// Step 1 of the plan is this role and its policy only. There is no Lambda, no
// schedule and no Google credential here; the trust and the action list are
// what the plan's test asserts.

// The identity-group-sync Lambda execution role in the infrastructure account.
// It is created under exactly this name; the trust below is the seam, and the
// two names must stay in lockstep or the first AssumeRole is an AccessDenied,
// not an apply-time error.
const GRANTEE_ROLE_ARN = `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/identity-group-sync`;

// The fixed session name the Lambda must pass to AssumeRole, so CloudTrail
// records every assume under one distinguishable name rather than
// `AWS-Reserved-Session` or a random string. Declared here because it is part
// of this role's contract; step 3 imports it rather than retyping the literal.
export const GRANT_SESSION_NAME = "identity-group-sync";

// The target Identity Center group ARNs this grant may mutate. This is the
// single place to edit when a pair is added, per "Adding a pair" in
// `docs/google-group-sync.md`: the assumed role scopes the three membership
// actions to the target group ARN, so a new pair is not authorized until its
// group ARN appears here.
//
// The first entry is provisional. The plan leaves the first real pair open
// (open question 7), so this uses the plan's worked example, the `Engineers`
// group recorded in `deploy/components/identity-center.ts`. Replace it when
// the engineer names the real first target.
//
// The form is `arn:aws:identitystore:::group/<group-id>`: Identity Store
// group, user and membership ARNs carry no account, region or identity store
// id, and only the identity store ARN does. This is the form
// `deploy/components/sheriff-grant.ts` uses and the form the Identity Store API
// returns (AWS SDK `GetGroupId`/`GetUserId` examples).
const TARGET_GROUP_ARNS = [
  "arn:aws:identitystore:::group/383193a0-7001-70d9-a321-ffe6d8af7378",
  // The `Approvers` group, the target of the `approvers-google` pair in
  // `deploy-infrastructure/group-sync/config.ts`. Its id is a placeholder
  // there too: neither file can know the id until the group exists, because
  // every Identity Center group in this repo is created out of band. Replace
  // both occurrences together, and see the comment on `APPROVERS_GROUP_ID` in
  // that config for what happens if this applies first (the pair fails closed
  // on its target read; nothing is written).
  "arn:aws:identitystore:::group/PENDING_APPROVERS_GROUP_ID",
];

// The user id and the returned membership id do not exist when the policy is
// written, so those two resources are wildcards scoped to their resource type
// rather than `*`, the same reasoning as `sheriff-grant.ts`.
const USER_ARN = "arn:aws:identitystore:::user/*";
const MEMBERSHIP_ARN = "arn:aws:identitystore:::membership/*";

// The account root with an `aws:PrincipalArn` condition rather than the
// Lambda's role as the principal: this stack and the infrastructure stack
// apply concurrently, and IAM rejects a trust naming a role that does not
// exist yet. The condition is what narrows it to the one role.
export const identityGroupSyncGrantTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:root` },
      Action: "sts:AssumeRole",
      Condition: { ArnEquals: { "aws:PrincipalArn": GRANTEE_ROLE_ARN } },
    },
  ],
};

// Five actions, one per statement so each statement's `Resource` list names
// only the resource types that action supports. `ResolveUser` and
// `CreateMissingUser` cannot name the group; `AddMembership` cannot name the
// membership wildcard.
//
// Deliberately absent, per "IAM" in `docs/google-group-sync.md`, and asserted
// by `deploy/identity-group-sync-grant.test.ts`: `DeleteUser` (the executable
// form of non-goal 1), `UpdateUser`, `DescribeUser` and `ListUsers` (no
// described operation reads user metadata, and `ListUsers` would enumerate the
// whole store); `CreateGroup`, `DeleteGroup`, `UpdateGroup` and `DescribeGroup`
// (group existence is not this job's business, non-goal 7); every `sso:*`,
// `sso-directory:*` and `sso-oauth:*` action (`sso-directory` carries its own
// `AddMemberToGroup`, a second path to the same directory mutation, per
// `adminReservedActions` in `deploy/components/identity-center/policies.ts`);
// and `IsMemberInGroups` and `ListGroupMembershipsForMember` (sheriff's
// requester gate and a per-member lookup this job does not make).
export const identityGroupSyncGrantPolicy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ResolveUser",
      Effect: "Allow",
      // GetUserId supports the Identitystore and User resource types; the
      // looked-up user is the dynamic one, hence the wildcard.
      Action: ["identitystore:GetUserId"],
      Resource: [IDENTITY_STORE_ARN, USER_ARN],
    },
    {
      Sid: "CreateMissingUser",
      Effect: "Allow",
      // CreateUser supports the Identitystore resource type only. Nothing is
      // SCIM-provisioned today, so the job creates the user objects it needs
      // (non-goal 3); it never deletes them.
      Action: ["identitystore:CreateUser"],
      Resource: [IDENTITY_STORE_ARN],
    },
    {
      Sid: "AddMembership",
      Effect: "Allow",
      // CreateGroupMembership supports Group, Identitystore and User; it does
      // not support GroupMembership, which is why the membership wildcard is
      // absent here and this is not folded into RemoveMembership.
      Action: ["identitystore:CreateGroupMembership"],
      Resource: [...TARGET_GROUP_ARNS, IDENTITY_STORE_ARN, USER_ARN],
    },
    {
      Sid: "RemoveMembership",
      Effect: "Allow",
      // DeleteGroupMembership supports Group, GroupMembership, Identitystore
      // and User, and the API passes the identity store, the membership id and
      // the member id, so all four appear here.
      Action: ["identitystore:DeleteGroupMembership"],
      Resource: [
        ...TARGET_GROUP_ARNS,
        IDENTITY_STORE_ARN,
        USER_ARN,
        MEMBERSHIP_ARN,
      ],
    },
    {
      Sid: "ListMemberships",
      Effect: "Allow",
      // ListGroupMemberships supports GroupMembership, Group and
      // Identitystore. The full-group scan is evaluated against the membership
      // type, which is why the group ARN alone is not enough.
      Action: ["identitystore:ListGroupMemberships"],
      Resource: [...TARGET_GROUP_ARNS, IDENTITY_STORE_ARN, MEMBERSHIP_ARN],
    },
  ],
};

export const createIdentityGroupSyncGrant = () => {
  const tags = { Environment: "infra", Project: "identity-group-sync" };

  const role = new aws.iam.Role("identityGroupSyncGrant", {
    name: "identity-group-sync-grant",
    description:
      "Grants the identity-group-sync Lambda in the infrastructure account scoped Identity Store access to mirror a Google Workspace group into the configured Identity Center group.",
    assumeRolePolicy: JSON.stringify(identityGroupSyncGrantTrust),
    tags,
  });

  new aws.iam.RolePolicy("identityGroupSyncGrantPolicy", {
    name: "identity-group-sync-grant",
    role: role.name,
    policy: JSON.stringify(identityGroupSyncGrantPolicy),
  });

  return role;
};
