import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  GRANT_SESSION_NAME,
  identityGroupSyncGrantPolicy,
  identityGroupSyncGrantTrust,
} from "./components/identity-group-sync-grant";

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const statements = identityGroupSyncGrantPolicy.Statement;

// The one identity store, mirrored from `utils/accounts.ts`.
const IDENTITY_STORE_ARN =
  "arn:aws:identitystore::333022194791:identitystore/d-9267e5cf96";

// The provisional first target: the `Engineers` group id recorded in
// `deploy/components/identity-center.ts`.
const ENGINEERS_GROUP_ARN =
  "arn:aws:identitystore:::group/383193a0-7001-70d9-a321-ffe6d8af7378";

// The second target: `Approvers`, the `approvers-google` pair's group. Its id
// is still the placeholder `deploy-infrastructure/group-sync/config.ts`
// declares, because the group is created out of band and does not exist yet;
// the two literals are pinned here for the same reason as `Admins` above, so
// that replacing one without the other fails rather than grants nothing.
const APPROVERS_GROUP_ARN =
  "arn:aws:identitystore:::group/PENDING_APPROVERS_GROUP_ID";

// Unavoidable: the looked-up user id and the returned membership id do not
// exist when the policy is written, so they are wildcards scoped to their
// resource type. See the policy comment.
const USER_ARN = "arn:aws:identitystore:::user/*";
const MEMBERSHIP_ARN = "arn:aws:identitystore:::membership/*";

describe("identityGroupSyncGrantTrust", () => {
  // The account root is the principal only because the Lambda's role may not
  // exist when this applies; the condition is what narrows it to that role.
  it("admits only the identity-group-sync Lambda role in the infrastructure account", () => {
    assert.deepEqual(identityGroupSyncGrantTrust.Statement, [
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::394495727159:root" },
        Action: "sts:AssumeRole",
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn":
              "arn:aws:iam::394495727159:role/identity-group-sync",
          },
        },
      },
    ]);
  });

  // A fixed session name so CloudTrail records every assume under one
  // distinguishable name. Step 3's Lambda must pass exactly this value.
  it("fixes the CloudTrail session name", () => {
    assert.equal(GRANT_SESSION_NAME, "identity-group-sync");
  });
});

describe("identityGroupSyncGrantPolicy", () => {
  const ALLOWED = [
    "identitystore:CreateGroupMembership",
    "identitystore:CreateUser",
    "identitystore:DeleteGroupMembership",
    "identitystore:GetUserId",
    "identitystore:ListGroupMemberships",
  ];

  const allActions = statements.flatMap((s) => asList(s.Action));
  const allResources = statements.flatMap((s) => asList(s.Resource));

  it("allows exactly the five directory actions", () => {
    assert.deepEqual([...allActions].sort(), [...ALLOWED].sort());
  });

  // A regression can also take the shape of a widened prefix, which the exact
  // list above would catch only once, so pin the namespace too.
  it("stays inside the identitystore namespace", () => {
    for (const action of allActions) {
      assert.match(action, /^identitystore:/, action);
    }
  });

  // Every action and prefix the plan names as deliberately absent. The `sso`
  // family matters most: `adminReservedActions` records that `sso-directory`
  // carries its own `AddMemberToGroup`, a second path to the same directory
  // mutation.
  it("grants none of the deliberately absent actions", () => {
    for (const forbidden of [
      "identitystore:DeleteUser",
      "identitystore:UpdateUser",
      "identitystore:DescribeUser",
      "identitystore:ListUsers",
      "identitystore:CreateGroup",
      "identitystore:DeleteGroup",
      "identitystore:UpdateGroup",
      "identitystore:DescribeGroup",
      "identitystore:IsMemberInGroups",
      "identitystore:ListGroupMembershipsForMember",
    ]) {
      assert.ok(!allActions.includes(forbidden), forbidden);
    }
  });

  it("grants no sso, sso-directory or sso-oauth action", () => {
    for (const action of allActions) {
      assert.doesNotMatch(action, /^(sso|sso-directory|sso-oauth):/, action);
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

  it("names the target group, the one identity store and the two unavoidable wildcards", () => {
    assert.ok(allResources.includes(ENGINEERS_GROUP_ARN));
    assert.ok(allResources.includes(APPROVERS_GROUP_ARN));
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
    assert.deepEqual(bySid.CreateMissingUser, [IDENTITY_STORE_ARN].sort());
    assert.deepEqual(bySid.AddMembership, [
      ENGINEERS_GROUP_ARN,
      APPROVERS_GROUP_ARN,
      IDENTITY_STORE_ARN,
      USER_ARN,
    ].sort());
    assert.deepEqual(bySid.RemoveMembership, [
      ENGINEERS_GROUP_ARN,
      APPROVERS_GROUP_ARN,
      IDENTITY_STORE_ARN,
      USER_ARN,
      MEMBERSHIP_ARN,
    ].sort());
    assert.deepEqual(bySid.ListMemberships, [
      ENGINEERS_GROUP_ARN,
      APPROVERS_GROUP_ARN,
      IDENTITY_STORE_ARN,
      MEMBERSHIP_ARN,
    ].sort());
  });

  // The group resource is the point of "Adding a pair": only the three
  // membership actions can name it, and a new pair is not authorized until its
  // ARN is added to all three. `GetUserId` and `CreateUser` have no Group
  // resource type, so naming the group there would be inert at best.
  it("names the target group only on the three membership actions", () => {
    const bySid = Object.fromEntries(
      statements.map((s) => [s.Sid, asList(s.Resource)]),
    );
    for (const sid of ["AddMembership", "RemoveMembership", "ListMemberships"]) {
      for (const arn of [ENGINEERS_GROUP_ARN, APPROVERS_GROUP_ARN]) {
        assert.ok(bySid[sid].includes(arn), `${sid} must name ${arn}`);
      }
    }
    assert.ok(!bySid.ResolveUser.includes(ENGINEERS_GROUP_ARN));
    assert.ok(!bySid.CreateMissingUser.includes(ENGINEERS_GROUP_ARN));
  });

  // Regression: the listing action is evaluated against the group-membership
  // resource, not the group or identity store the call names, so a policy that
  // scopes it to the group and identity store alone is an AccessDenied at the
  // first sweep. The same failure was hit in production for sheriff.
  it("keeps the membership resource on the listing action", () => {
    const listing = statements.find((s) => s.Sid === "ListMemberships");
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
