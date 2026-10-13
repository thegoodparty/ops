import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  sheriffGrantPolicy,
  sheriffGrantTrust,
} from "./components/sheriff-grant";

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const statements = sheriffGrantPolicy.Statement;

// The one group id `deploy/components/identity-center.ts` records for Admins.
const ADMINS_GROUP_ARN =
  "arn:aws:identitystore:::group/88c1b330-a001-707a-06ca-94e289013bf5";

// The Engineers group the requester gate checks. Mirrored from
// `deploy-infrastructure/sheriff/config.ts`.
const ENGINEERS_GROUP_ARN =
  "arn:aws:identitystore:::group/383193a0-7001-70d9-a321-ffe6d8af7378";

const IDENTITY_STORE_ARN =
  "arn:aws:identitystore::333022194791:identitystore/d-9267e5cf96";

// Unavoidable: the requester's user id and the returned membership id do not
// exist when the policy is written, so they are wildcards scoped to their
// resource type. See the policy comment.
const USER_ARN = "arn:aws:identitystore:::user/*";
const MEMBERSHIP_ARN = "arn:aws:identitystore:::membership/*";

describe("sheriffGrantTrust", () => {
  // The account root is the principal only because the Lambda's role may not
  // exist when this applies; the condition is what narrows it to that role.
  it("admits only the sheriff Lambda role in the infrastructure account", () => {
    assert.deepEqual(sheriffGrantTrust.Statement, [
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::394495727159:root" },
        Action: "sts:AssumeRole",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": "arn:aws:iam::394495727159:role/sheriff",
          },
        },
      },
    ]);
  });
});

describe("sheriffGrantPolicy", () => {
  const ALLOWED = [
    "identitystore:CreateGroupMembership",
    "identitystore:DeleteGroupMembership",
    "identitystore:GetUserId",
    "identitystore:IsMemberInGroups",
    "identitystore:ListGroupMemberships",
    "identitystore:ListGroupMembershipsForMember",
  ];

  const allActions = statements.flatMap((s) => asList(s.Action));
  const allResources = statements.flatMap((s) => asList(s.Resource));

  it("allows exactly the six directory actions", () => {
    assert.deepEqual([...allActions].sort(), [...ALLOWED].sort());
  });

  // A regression can also take the shape of a widened prefix, which the exact
  // list above would catch only once, so pin the namespace too.
  it("stays inside the identitystore namespace", () => {
    for (const action of allActions) {
      assert.match(action, /^identitystore:/, action);
    }
  });

  // Every prefix and action the plan names as deliberately absent. `sso-directory`
  // matters most: `adminReservedActions` records that it carries its own
  // `AddMemberToGroup`, so allowing it would be a second path to the same
  // directory mutation. The regex must not reject `GetUserId`, which is now
  // allowed; it forbids `Describe*` and `ListUsers` specifically.
  it("grants no forbidden prefix or action", () => {
    for (const action of allActions) {
      assert.doesNotMatch(action, /^(sso|sso-directory|sso-oauth):/, action);
      assert.doesNotMatch(action, /(Describe|ListUsers)/, action);
    }
    for (const forbidden of [
      "identitystore:DescribeGroup",
      "identitystore:ListUsers",
      "identitystore:DescribeUser",
    ]) {
      assert.ok(!allActions.includes(forbidden), forbidden);
    }
    // The one `User`-containing action that is deliberately allowed, so the
    // regex above is not accidentally over-broad.
    assert.ok(allActions.includes("identitystore:GetUserId"));
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

  it("names the Admins and Engineers groups, the one identity store and the two unavoidable wildcards", () => {
    assert.ok(allResources.includes(ADMINS_GROUP_ARN));
    assert.ok(allResources.includes(ENGINEERS_GROUP_ARN));
    assert.ok(allResources.includes(IDENTITY_STORE_ARN));
    assert.ok(allResources.includes(USER_ARN));
    assert.ok(allResources.includes(MEMBERSHIP_ARN));
  });

  // The exact scope per action, from the accepted answer for this problem: the
  // user and membership ids do not exist at apply time, so those two are
  // wildcards scoped to their type, and everything else is a literal. The two
  // new actions name the identity store and the user; `IsMemberInGroups` also
  // names the `Engineers` group it queries.
  it("scopes each action to the narrowest set that authorizes it", () => {
    const bySid = Object.fromEntries(
      statements.map((s) => [s.Sid, [...asList(s.Resource)].sort()]),
    );
    assert.deepEqual(bySid.ResolveRequester, [
      IDENTITY_STORE_ARN,
      USER_ARN,
    ].sort());
    assert.deepEqual(bySid.RequesterIsEngineer, [
      ENGINEERS_GROUP_ARN,
      IDENTITY_STORE_ARN,
      USER_ARN,
      MEMBERSHIP_ARN,
    ].sort());
    assert.deepEqual(bySid.GrantMembership, [
      ADMINS_GROUP_ARN,
      IDENTITY_STORE_ARN,
      USER_ARN,
    ].sort());
    assert.deepEqual(bySid.RevokeMembership, [
      ADMINS_GROUP_ARN,
      IDENTITY_STORE_ARN,
      USER_ARN,
      MEMBERSHIP_ARN,
    ].sort());
    assert.deepEqual(bySid.ListGroupMemberships, [
      ADMINS_GROUP_ARN,
      IDENTITY_STORE_ARN,
    ].sort());
    assert.deepEqual(bySid.ListMembershipsForMember, [
      IDENTITY_STORE_ARN,
      USER_ARN,
    ].sort());
  });

  // The group id is a literal duplicated from identity-center.ts because step
  // 2 does not add an export there. Read the source so the two cannot drift
  // silently: a change to the Admins group in either file fails this.
  it("mirrors the Admins group id in identity-center.ts", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "components/identity-center.ts"),
      "utf8",
    );
    assert.match(source, /Admins: "88c1b330-a001-707a-06ca-94e289013bf5"/);
    assert.ok(allResources.includes(ADMINS_GROUP_ARN));
  });

  // The Engineers gate reads its group id from the runtime config. Read the
  // source so the policy and the gate cannot drift.
  it("mirrors the Engineers group id in the sheriff config", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../deploy-infrastructure/sheriff/config.ts"),
      "utf8",
    );
    assert.match(
      source,
      /ENGINEERS_GROUP_ID = "383193a0-7001-70d9-a321-ffe6d8af7378"/,
    );
    assert.ok(allResources.includes(ENGINEERS_GROUP_ARN));
  });
});
