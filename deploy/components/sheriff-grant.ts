import * as aws from "@pulumi/aws";
import {
  IDENTITY_STORE_ARN,
  INFRASTRUCTURE_ACCOUNT_ID,
} from "../../utils/accounts";
import type { PolicyDocument } from "./identity-center/policies";

// The management-account role the break-glass Lambda (infrastructure account,
// step 4 of `docs/sheriff.md`) assumes to resolve a requester and toggle
// membership in the one `Admins` Identity Store group. It is the crown jewels
// of the plan: the Lambda's own role gets `sts:AssumeRole` on this ARN and
// nothing else in the management account, and this role's inline policy is what
// keeps "the tool can only touch the directory it names" true.
//
// The `aws:PrincipalArn` it trusts names a role that did not exist when this
// was first written, which is why the trust is the account root plus a
// condition, the `delegate-swarm-prod-read` pattern: IAM rejects a trust that
// names a role that does not exist yet.

// The sheriff Lambda execution role in the infrastructure account. It is
// created under exactly this name; the trust below is the seam, and the two
// names must stay in lockstep or the first AssumeRole is an AccessDenied, not
// an apply-time error.
const GRANTEE_ROLE_ARN = `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/sheriff`;

// The `Admins` group id, mirrored from `deploy/components/identity-center.ts`.
// A literal rather than an import because that file does not export its group
// map, and step 2 is scoped to changing one field in it. A change to the group
// there without one here is a policy that grants nothing, which
// `deploy/sheriff-grant.test.ts` pins by reading that file's literal.
const GROUP_ARN =
  "arn:aws:identitystore:::group/88c1b330-a001-707a-06ca-94e289013bf5";

// The `Engineers` group id, mirrored from
// `deploy-infrastructure/sheriff/config.ts`. The requester gate checks
// membership in this group, so `IsMemberInGroups` names it. A literal for the
// same reason as the `Admins` id above: it is a stable Identity Center id and
// there is no Pulumi resource to reference.
const ENGINEERS_GROUP_ARN =
  "arn:aws:identitystore:::group/383193a0-7001-70d9-a321-ffe6d8af7378";

// `DeleteGroupMembership` takes a `MembershipId` that does not exist when the
// policy is written, so the membership resource has to be a wildcard. It is
// scoped to the membership type, not `*`, and the call still has to name the
// one identity store.
const MEMBERSHIP_ARN = "arn:aws:identitystore:::membership/*";

// The member id is likewise unknown at policy time: `CreateGroupMembership`
// and `DeleteGroupMembership` take it as an argument, and
// `ListGroupMembershipsForMember` takes it to look one up. Scoped to the user
// type, not `*`.
const USER_ARN = "arn:aws:identitystore:::user/*";

// The account root with a `PrincipalArn` condition rather than the Lambda's
// role as the principal: this stack and the infrastructure stack apply
// concurrently, and IAM rejects a trust naming a role that does not exist yet.
// The condition is what narrows it to the one role.
export const sheriffGrantTrust = {
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

// Six actions, each the narrowest resource list that authorizes the call.
//
// `identitystore:CreateGroupMembership` is the grant and
// `identitystore:DeleteGroupMembership` is the revoke.
// `identitystore:ListGroupMemberships` is the sweeper's full-group scan, and
// `identitystore:ListGroupMembershipsForMember` resolves the `MembershipId` of
// a pre-existing member when `CreateGroupMembership` returns
// `ConflictException`, and of a `granting` record the sweeper recovers.
//
// `identitystore:GetUserId` resolves the requester from their Slack email
// (open question 3, settled by the engineer in favour of email mapping), and
// `identitystore:IsMemberInGroups` is the `Engineers` gate. Both were absent in
// step 3, when the requester mapping was a maintained table and the tool did no
// directory read at all; the policy is no longer "unchanged from step 2".
//
// Deliberately absent, per "The tool's own privilege" in `docs/sheriff.md`:
// every `sso:*`, `sso-directory:*` and `sso-oauth:*` action (the
// `adminReservedActions` note records that `sso-directory` carries its own
// `AddMemberToGroup`, a second path to the same directory mutation), plus
// `identitystore:DescribeGroup`, `identitystore:ListUsers` and
// `identitystore:DescribeUser`. No described operation reads group or user
// metadata: the group ids are static literals, so there is no runtime
// group-existence check, and `ListUsers` would enumerate the whole identity
// store, which the plan's rule does not allow.
//
// Two of the resource forms are wildcards and they are unavoidable: the
// requester's user id and the returned membership id do not exist when the
// policy is written, so a policy that named them would deny the tool's own
// calls. The accepted answer for this exact problem (AWS re:Post, "How to
// limit access to specific Identity Center groups") lists all four resource
// forms for that reason. This is the doc's "names the one group and the one
// identity store, not `*`" applied as narrowly as the API allows: the groups
// and identity store are literals, and the user and membership wildcards are
// scoped to their resource types rather than left as `*`.
//
// The actions are split one per statement so each statement's `Resource` list
// contains only types the action supports: `ListGroupMembershipsForMember` has
// no Group resource type, so it cannot name the group ARN, and `GetUserId` has
// no Group resource type either, so it names only the identity store and the
// user.
export const sheriffGrantPolicy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ResolveRequester",
      Effect: "Allow",
      // GetUserId supports the Identitystore and User resource types; the
      // looked-up user is the dynamic one, hence the wildcard.
      Action: ["identitystore:GetUserId"],
      Resource: [IDENTITY_STORE_ARN, USER_ARN],
    },
    {
      Sid: "RequesterIsEngineer",
      Effect: "Allow",
      // IsMemberInGroups supports Group, GroupMembership, Identitystore and
      // User. Only the `Engineers` group is ever queried, so the group ARN is
      // that one, not `Admins`.
      Action: ["identitystore:IsMemberInGroups"],
      Resource: [
        ENGINEERS_GROUP_ARN,
        IDENTITY_STORE_ARN,
        USER_ARN,
        MEMBERSHIP_ARN,
      ],
    },
    {
      Sid: "GrantMembership",
      Effect: "Allow",
      // CreateGroupMembership supports the Group, Identitystore and User
      // resource types; it does not support GroupMembership, which is why the
      // membership wildcard is absent here and this is not folded into the
      // revoke statement below.
      Action: ["identitystore:CreateGroupMembership"],
      Resource: [GROUP_ARN, IDENTITY_STORE_ARN, USER_ARN],
    },
    {
      Sid: "RevokeMembership",
      Effect: "Allow",
      // DeleteGroupMembership supports Group, GroupMembership, Identitystore
      // and User, and the API passes the identity store, the membership id and
      // the member id. All four appear here. The group ARN is kept because AWS
      // lists Group as a supported type for this action and omitting it risks
      // an evaluation that does not match.
      Action: ["identitystore:DeleteGroupMembership"],
      Resource: [GROUP_ARN, IDENTITY_STORE_ARN, USER_ARN, MEMBERSHIP_ARN],
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
      // No Group resource type for this action, so the identity store and the
      // user are the scope. The user id is dynamic, hence the wildcard.
      Action: ["identitystore:ListGroupMembershipsForMember"],
      Resource: [IDENTITY_STORE_ARN, USER_ARN],
    },
  ],
};

export const createSheriffGrant = () => {
  const tags = { Environment: "infra", Project: "sheriff" };

  const role = new aws.iam.Role("sheriffGrant", {
    name: "sheriff-grant",
    description:
      "Grants and revokes membership in the Admins Identity Store group for the sheriff Lambda in the infrastructure account.",
    assumeRolePolicy: JSON.stringify(sheriffGrantTrust),
    tags,
  });

  new aws.iam.RolePolicy("sheriffGrantPolicy", {
    name: "sheriff-grant",
    role: role.name,
    policy: JSON.stringify(sheriffGrantPolicy),
  });

  return role;
};
