import * as aws from "@pulumi/aws";
import {
  IDENTITY_STORE_ARN,
  INFRASTRUCTURE_ACCOUNT_ID,
} from "../../utils/accounts";
import type { PolicyDocument } from "./identity-center/policies";

// The management-account role the break-glass Lambda (infrastructure account,
// step 3 of `docs/break-glass.md`) assumes to toggle membership in the one
// `Admins` Identity Store group. It is the crown jewels of the plan: the
// Lambda's own role gets `sts:AssumeRole` on this ARN and nothing else in the
// management account, and this role's inline policy is what keeps "the tool
// can only toggle membership in the one Admins group" true.
//
// Definitions only in step 2: nothing assumes this role yet, and the
// `aws:PrincipalArn` it trusts names a role that does not exist until step 3.
// That is why the trust is the account root plus a condition, the
// `delegate-swarm-prod-read` pattern: IAM rejects a trust that names a role
// that does not exist yet.

// The future break-glass Lambda execution role in the infrastructure account.
// Step 3 creates it under exactly this name; the trust below is the seam, and
// renaming the role without this constant is an AccessDenied at the first
// grant, not an apply-time error.
const GRANTEE_ROLE_ARN = `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/break-glass`;

// The `Admins` group id, mirrored from `deploy/components/identity-center.ts`.
// A literal rather than an import because that file does not export its group
// map, and step 2 is scoped to changing one field in it. A change to the group
// there without one here is a policy that grants nothing, which
// `deploy/break-glass-grant.test.ts` pins by reading that file's literal.
const GROUP_ARN =
  "arn:aws:identitystore:::group/88c1b330-a001-707a-06ca-94e289013bf5";

// `DeleteGroupMembership` takes a `MembershipId` that does not exist when the
// policy is written, so the membership resource has to be a wildcard. It is
// scoped to the membership type, not `*`, and the call still has to name the
// one identity store.
const MEMBERSHIP_ARN = "arn:aws:identitystore:::membership/*";

// The account root with a `PrincipalArn` condition rather than the Lambda's
// role as the principal: this stack and the infrastructure stack apply
// concurrently, and IAM rejects a trust naming a role that does not exist yet.
// The condition is what narrows it to the one role.
export const breakGlassGrantTrust = {
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

// Four actions, each the narrowest resource list that authorizes the call.
//
// `identitystore:CreateGroupMembership` is the grant and
// `identitystore:DeleteGroupMembership` is the revoke.
// `identitystore:ListGroupMemberships` is the sweeper's full-group scan, and
// `identitystore:ListGroupMembershipsForMember` resolves the `MembershipId` of
// a pre-existing member when `CreateGroupMembership` returns
// `ConflictException`, and of a `granting` record the sweeper recovers.
//
// Deliberately absent, per "The tool's own privilege" in `docs/break-glass.md`:
// every `sso:*`, `sso-directory:*` and `sso-oauth:*` action (the
// `adminReservedActions` note records that `sso-directory` carries its own
// `AddMemberToGroup`, a second path to the same directory mutation), plus
// `identitystore:DescribeGroup`, `identitystore:ListUsers` and
// `identitystore:DescribeUser`. No described operation reads group or user
// metadata: the `Admins` group id is a static literal, so there is no runtime
// group-existence check, and `ListUsers` would enumerate the whole identity
// store, which the plan's rule does not allow. `identitystore:GetUserId` is
// also absent until open question 3 settles whether the requester mapping is a
// maintained table or an API lookup.
//
// The actions are split one per statement so each statement's `Resource` list
// contains only types the action supports: `ListGroupMembershipsForMember` has
// no Group resource type, so it cannot name the group ARN.
export const breakGlassGrantPolicy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "GrantMembership",
      Effect: "Allow",
      // CreateGroupMembership supports the Group and Identitystore resource
      // types; it does not support GroupMembership, which is why this is not
      // folded into the revoke statement below.
      Action: ["identitystore:CreateGroupMembership"],
      Resource: [GROUP_ARN, IDENTITY_STORE_ARN],
    },
    {
      Sid: "RevokeMembership",
      Effect: "Allow",
      // DeleteGroupMembership supports Group, GroupMembership, Identitystore
      // and User. The group ARN is kept even though the API takes only the
      // identity store and membership, because AWS lists Group as a supported
      // type for this action and omitting it risks an evaluation that does not
      // match.
      Action: ["identitystore:DeleteGroupMembership"],
      Resource: [GROUP_ARN, MEMBERSHIP_ARN, IDENTITY_STORE_ARN],
    },
    {
      Sid: "ListGroupMemberships",
      Effect: "Allow",
      Action: ["identitystore:ListGroupMemberships"],
      Resource: [GROUP_ARN, IDENTITY_STORE_ARN],
    },
    {
      Sid: "ListMembershipsForMember",
      Effect: "Allow",
      // No Group resource type for this action. The user resource is the
      // member id, which is dynamic and unknown at policy time; the doc scopes
      // this to the one identity store rather than granting `user/*`.
      Action: ["identitystore:ListGroupMembershipsForMember"],
      Resource: [IDENTITY_STORE_ARN],
    },
  ],
};

export const createBreakGlassGrant = () => {
  const tags = { Environment: "infra", Project: "break-glass" };

  const role = new aws.iam.Role("breakGlassGrant", {
    name: "break-glass-grant",
    description:
      "Grants and revokes membership in the Admins Identity Store group for the break-glass Lambda in the infrastructure account.",
    assumeRolePolicy: JSON.stringify(breakGlassGrantTrust),
    tags,
  });

  new aws.iam.RolePolicy("breakGlassGrantPolicy", {
    name: "break-glass-grant",
    role: role.name,
    policy: JSON.stringify(breakGlassGrantPolicy),
  });

  return role;
};
