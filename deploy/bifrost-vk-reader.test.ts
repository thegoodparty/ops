import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  bifrostVkReaderPolicy,
  bifrostVkReaderTrust,
  VK_READER_SESSION_NAME,
} from "./components/bifrost-vk-reader";

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const statements = bifrostVkReaderPolicy.Statement;

// The one identity store, mirrored from `utils/accounts.ts`.
const IDENTITY_STORE_ARN =
  "arn:aws:identitystore::333022194791:identitystore/d-9267e5cf96";

// The `Engineers` group: the source of truth for who may hold a key, mirrored
// from `deploy/components/identity-center.ts`.
const ENGINEERS_GROUP_ARN =
  "arn:aws:identitystore:::group/383193a0-7001-70d9-a321-ffe6d8af7378";

// The workbench account, and the two Lambda execution roles this trust admits.
// The role names are the seam between step 2 and steps 3 and 5, so they are
// pinned here as literals rather than read from a source of truth that does not
// exist yet.
const WORKBENCH_ROOT = "arn:aws:iam::024901689212:root";
const MINT_ROLE_ARN = "arn:aws:iam::024901689212:role/bifrost-vk-mint";
const JANITOR_ROLE_ARN =
  "arn:aws:iam::024901689212:role/bifrost-vk-janitor";

// Unavoidable: the looked-up user id and the returned membership id do not
// exist when the policy is written, so they are wildcards scoped to their
// resource type. See the policy comment.
const USER_ARN = "arn:aws:identitystore:::user/*";
const MEMBERSHIP_ARN = "arn:aws:identitystore:::membership/*";

describe("bifrostVkReaderTrust", () => {
  // The account root is the principal only because the two Lambdas' roles may
  // not exist when this applies; the `aws:PrincipalArn` condition is what
  // narrows it to exactly those two roles, in either account's apply order.
  it("admits only the mint and janitor Lambda roles in the workbench account", () => {
    assert.deepEqual(bifrostVkReaderTrust.Statement, [
      {
        Effect: "Allow",
        Principal: { AWS: WORKBENCH_ROOT },
        Action: "sts:AssumeRole",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": [MINT_ROLE_ARN, JANITOR_ROLE_ARN],
          },
        },
      },
    ]);
  });

  // The condition is the whole boundary: an account root alone would admit
  // every principal in the workbench account, including every role that is not
  // a Bifrost virtual-key job.
  it("narrows the account root with a principal condition on both roles", () => {
    const [statement] = bifrostVkReaderTrust.Statement;
    const principals = asList(statement.Condition.ArnEquals["aws:PrincipalArn"]);
    assert.equal(principals.length, 2);
    assert.ok(principals.includes(MINT_ROLE_ARN));
    assert.ok(principals.includes(JANITOR_ROLE_ARN));
    for (const principal of principals) {
      assert.doesNotMatch(principal, /\*/, principal);
    }
  });

  // A fixed session name so CloudTrail records every cross-account read under
  // one distinguishable name. Steps 3 and 5 must pass exactly this value.
  it("fixes the CloudTrail session name", () => {
    assert.equal(VK_READER_SESSION_NAME, "bifrost-vk-reader");
  });
});

describe("bifrostVkReaderPolicy", () => {
  const ALLOWED = [
    "identitystore:GetUserId",
    "identitystore:ListGroupMemberships",
  ];

  const allActions = statements.flatMap((s) => asList(s.Action));
  const allResources = statements.flatMap((s) => asList(s.Resource));

  // The plan's "two actions and no writing". Anything else is a widening, and
  // an exact comparison is the only thing that catches a third one creeping in
  // beside the two.
  it("allows exactly the two read actions", () => {
    assert.deepEqual([...allActions].sort(), [...ALLOWED].sort());
  });

  // A regression can also take the shape of a wildcard or a namespace prefix,
  // which the exact list above would catch only once, so pin the shape too.
  it("stays inside the identitystore namespace with no action wildcard", () => {
    for (const action of allActions) {
      assert.match(action, /^identitystore:/, action);
      assert.doesNotMatch(action, /\*/, action);
    }
  });

  // Every action the plan names as deliberately absent. The writing ones are
  // the point of "it may read and must not write": any of these would let a
  // job that exists to answer "is this person in the group" change the answer.
  it("grants no write action", () => {
    for (const forbidden of [
      "identitystore:CreateUser",
      "identitystore:UpdateUser",
      "identitystore:DeleteUser",
      "identitystore:CreateGroup",
      "identitystore:UpdateGroup",
      "identitystore:DeleteGroup",
      "identitystore:CreateGroupMembership",
      "identitystore:DeleteGroupMembership",
    ]) {
      assert.ok(!allActions.includes(forbidden), forbidden);
    }
  });

  // Broadening reads are the other half: the plan says no `DescribeUser`, and
  // an enumeration or a second membership lookup is a wider grant than the two
  // reads either job makes.
  it("grants no broader read than the two the jobs make", () => {
    for (const forbidden of [
      "identitystore:DescribeUser",
      "identitystore:DescribeGroup",
      "identitystore:DescribeGroupMembership",
      "identitystore:DescribeIdentityStore",
      "identitystore:ListUsers",
      "identitystore:ListGroups",
      "identitystore:ListGroupMembershipsForMember",
      "identitystore:IsMemberInGroups",
      "identitystore:GetGroupId",
      "identitystore:GetGroupMembershipId",
    ]) {
      assert.ok(!allActions.includes(forbidden), forbidden);
    }
  });

  // The `sso` family matters most: `adminReservedActions` records that
  // `sso-directory` carries its own `AddMemberToGroup`, a second path to the
  // same directory mutation.
  it("grants no sso, sso-directory or sso-oauth action", () => {
    for (const action of allActions) {
      assert.doesNotMatch(action, /^(sso|sso-directory|sso-oauth):/, action);
    }
  });

  // A deny or a `NotAction` in a policy a reader is told is "two allows" would
  // be a boundary nobody checked.
  it("is two allows and nothing else", () => {
    for (const statement of statements) {
      assert.equal(statement.Effect, "Allow", statement.Sid);
      assert.equal(statement.NotAction, undefined, statement.Sid);
      assert.equal(statement.NotResource, undefined, statement.Sid);
    }
  });

  it("scopes every resource, with no bare wildcard", () => {
    for (const statement of statements) {
      const resources = asList(statement.Resource);
      assert.ok(resources.length > 0, `${statement.Sid} has no Resource`);
      for (const resource of resources) {
        assert.notEqual(resource, "*", `${statement.Sid} has a bare *`);
        assert.match(resource, /^arn:aws:identitystore:/, resource);
      }
    }
  });

  it("names the Engineers group, the one identity store and the two unavoidable wildcards", () => {
    assert.ok(allResources.includes(ENGINEERS_GROUP_ARN));
    assert.ok(allResources.includes(IDENTITY_STORE_ARN));
    assert.ok(allResources.includes(USER_ARN));
    assert.ok(allResources.includes(MEMBERSHIP_ARN));
  });

  // The exact scope per action: the user and membership ids do not exist at
  // apply time, so those two are wildcards scoped to their type, and
  // everything else is a literal. Each statement names exactly the resource
  // types the Service Authorization Reference marks required for its action.
  it("scopes each action to the narrowest set that authorizes it", () => {
    const bySid = Object.fromEntries(
      statements.map((s) => [s.Sid, [...asList(s.Resource)].sort()]),
    );
    assert.deepEqual(bySid.ResolveUser, [IDENTITY_STORE_ARN, USER_ARN].sort());
    assert.deepEqual(bySid.ListEngineersMemberships, [
      ENGINEERS_GROUP_ARN,
      IDENTITY_STORE_ARN,
      MEMBERSHIP_ARN,
    ].sort());
  });

  // `GetUserId` has no Group resource type, so naming the group there would be
  // inert at best and hides which group is actually reachable.
  it("names the Engineers group only on the listing action", () => {
    const bySid = Object.fromEntries(
      statements.map((s) => [s.Sid, asList(s.Resource)]),
    );
    assert.ok(bySid.ListEngineersMemberships.includes(ENGINEERS_GROUP_ARN));
    assert.ok(!bySid.ResolveUser.includes(ENGINEERS_GROUP_ARN));
  });

  // Regression: the listing action is evaluated against the group-membership
  // resource, not the group or identity store the call names, so a policy that
  // scopes it to the group and identity store alone is an `AccessDenied` at the
  // first read. The same failure was hit in production for sheriff.
  it("keeps the membership resource on the listing action", () => {
    const listing = statements.find(
      (s) => s.Sid === "ListEngineersMemberships",
    );
    assert.ok(listing);
    assert.ok(asList(listing.Resource).includes(MEMBERSHIP_ARN));
  });

  // The group id is a literal duplicated from identity-center.ts because the
  // group is created out of band. Read the source so the two cannot drift
  // silently: a change to the Engineers group in either file fails this.
  it("mirrors the Engineers group id in identity-center.ts", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "components/identity-center.ts"),
      "utf8",
    );
    assert.match(source, /Engineers: "383193a0-7001-70d9-a321-ffe6d8af7378"/);
    assert.ok(allResources.includes(ENGINEERS_GROUP_ARN));
  });
});
