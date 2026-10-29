import * as aws from "@pulumi/aws";
import {
  IDENTITY_STORE_ARN,
  WORKBENCH_ACCOUNT_ID,
} from "../../utils/accounts";
import type { PolicyDocument } from "./identity-center/policies";

// The management-account role the two Bifrost virtual-key Lambdas in the
// workbench account assume to answer one question: is this person in the
// `Engineers` group right now? Step 2 of `docs/bifrost-virtual-keys.md`.
//
// The mint Lambda (step 3) asks it on every mint, because a `WorkbenchAccess`
// session outlives a membership by up to 12 hours and a session that could
// re-mint would undo the janitor. The janitor (step 5) asks it on every hourly
// run, to decide which managed keys to deactivate. Both reach the directory
// through this one role rather than two, so CloudTrail has a single name for
// every cross-account read (`docs/bifrost-virtual-keys.md`, decision 6).
//
// The shape is `deploy/components/identity-group-sync-grant.ts`: the Lambdas'
// own roles get `sts:AssumeRole` on this ARN and no `identitystore` action of
// their own, and this role's inline policy is the boundary. It can read and it
// cannot write: two actions, both reads, and neither job gains `DescribeUser`
// — `ListGroupMemberships` returns user ids, and the email each job already
// holds is resolved with `GetUserId` on the `emails.value` index.
//
// The trust and the grantee ARNs are literals, which is what lets this land
// before the functions that assume it (step 2's note in the plan). Until they
// exist the role is simply unassumed; once they do, an `AssumeRole` is either
// admitted by the condition below or is an `AccessDenied`, not an apply-time
// error.

// The two workbench Lambda execution roles, created under exactly these names
// by steps 3 and 5. The names are the seam: they must stay in lockstep or the
// first `AssumeRole` is an `AccessDenied` rather than an apply-time error, the
// same way `GRANTEE_ROLE_ARN` works in `identity-group-sync-grant.ts`.
const GRANTEE_ROLE_ARNS = [
  // The mint Lambda's execution role (step 3). It assumes this role for the
  // live membership check that decision 1 adds to the mint.
  `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/bifrost-vk-mint`,
  // The janitor Lambda's execution role (step 5). It assumes this role to
  // reconcile the managed keys against the group every hour.
  `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/bifrost-vk-janitor`,
];

// The fixed session name both Lambdas must pass to `AssumeRole`, so CloudTrail
// records every read under one distinguishable name rather than
// `AWS-Reserved-Session` or a random string. It is part of this role's
// contract: steps 3 and 5 import it rather than retyping the literal. One name
// for both callers is the point of the single role, so a CloudTrail query for
// the directory read does not have to know which job made it.
export const VK_READER_SESSION_NAME = "bifrost-vk-reader";

// The `Engineers` group, mirrored from `deploy/components/identity-center.ts`.
// It is the source of truth for who may hold a key (decision 1): it is the
// group whose members hold `WorkbenchAccess`, and the one
// `engineering@goodparty.org` is mirrored into every fifteen minutes. A
// literal rather than an import because that file does not export its group
// map; `deploy/bifrost-vk-reader.test.ts` reads the file so the two cannot
// drift silently.
const ENGINEERS_GROUP_ARN =
  "arn:aws:identitystore:::group/383193a0-7001-70d9-a321-ffe6d8af7378";

// The user id is the looked-up one and does not exist when the policy is
// written, so it is a wildcard scoped to its resource type rather than `*`,
// the same reasoning as `sheriff-grant.ts` and `identity-group-sync-grant.ts`.
const USER_ARN = "arn:aws:identitystore:::user/*";

// `ListGroupMemberships` is evaluated against the membership resource it
// returns, not the group or identity store the call names. Scoping it to the
// group and identity store alone is an `AccessDenied` at the first read; that
// failure was hit in production for sheriff and again for the group-sync job,
// so the wildcard stays even though the group ARN is a literal.
const MEMBERSHIP_ARN = "arn:aws:identitystore:::membership/*";

// The workbench account root with an `aws:PrincipalArn` condition rather than
// the two Lambdas' roles as principals: this stack and `deploy-workbench/`
// apply concurrently, and IAM rejects a trust naming a role that does not exist
// yet. The condition is what narrows it to the two roles — the account root
// alone would admit every principal in the workbench account. `ArnEquals` with
// a list matches any one of them, which is why the two roles share a statement.
export const bifrostVkReaderTrust = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:root` },
      Action: "sts:AssumeRole",
      Condition: { ArnEquals: { "aws:PrincipalArn": GRANTEE_ROLE_ARNS } },
    },
  ],
};

// Two actions, one per statement so each statement's `Resource` list names only
// the resource types that action supports. `GetUserId` has no Group resource
// type, so naming the group there would be inert at best; `ListGroupMemberships`
// has no User type, so it does not name the user wildcard.
//
// Deliberately absent, and asserted by `deploy/bifrost-vk-reader.test.ts`:
// every writing action (`CreateUser`, `UpdateUser`, `DeleteUser`,
// `CreateGroup`, `UpdateGroup`, `DeleteGroup`, `CreateGroupMembership`,
// `DeleteGroupMembership`, and the rest of the namespace); `DescribeUser` and
// `DescribeGroup` (neither job reads user or group metadata — the group id is a
// static literal and the email is resolved with `GetUserId`); `ListUsers`
// (it would enumerate the whole store); `ListGroupMembershipsForMember` and
// `IsMemberInGroups` (not the read either job makes — the janitor lists the
// group and intersects on user id, decision 6); and every `sso:*`,
// `sso-directory:*` and `sso-oauth:*` action, because `sso-directory` carries
// its own membership writes, a second path to the same directory
// (`adminReservedActions` in `deploy/components/identity-center/policies.ts`).
export const bifrostVkReaderPolicy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ResolveUser",
      Effect: "Allow",
      // GetUserId is the `emails.value` lookup: the email is the session name
      // in the caller's assumed-role ARN and the key's name, and this turns it
      // into the user id the membership scan returns. Supports the
      // Identitystore and User resource types; the looked-up user is the
      // dynamic one, hence the wildcard.
      Action: ["identitystore:GetUserId"],
      Resource: [IDENTITY_STORE_ARN, USER_ARN],
    },
    {
      Sid: "ListEngineersMemberships",
      Effect: "Allow",
      // The group's memberships, every page. Supports the GroupMembership,
      // Group and Identitystore resource types, all required, which is why the
      // membership wildcard appears beside the one group ARN.
      Action: ["identitystore:ListGroupMemberships"],
      Resource: [ENGINEERS_GROUP_ARN, IDENTITY_STORE_ARN, MEMBERSHIP_ARN],
    },
  ],
};

export const createBifrostVkReader = () => {
  const tags = { Environment: "infra", Project: "bifrost-virtual-keys" };

  const role = new aws.iam.Role("bifrostVkReader", {
    name: "bifrost-vk-reader",
    description:
      "Grants the Bifrost virtual-key Lambdas in the workbench account read-only Identity Store access: GetUserId on the emails.value index and ListGroupMemberships on the Engineers group, and nothing else.",
    assumeRolePolicy: JSON.stringify(bifrostVkReaderTrust),
    tags,
  });

  new aws.iam.RolePolicy("bifrostVkReaderPolicy", {
    name: "bifrost-vk-reader",
    role: role.name,
    policy: JSON.stringify(bifrostVkReaderPolicy),
  });

  return role;
};
