import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import {
  ORPHANED_AUDIT_EVENT,
  SHERIFF_ALERT_EMAIL,
  SHERIFF_GRANT_ROLE_ARN,
  SHERIFF_ROLE_NAME,
  SHERIFF_TABLE_NAME,
  SHERIFF_SECRET_NAME,
  SHERIFF_SECRET_IMPORT_ID,
  sheriffLambdaPolicy,
  sheriffLambdaTrust,
} from "./sheriff-lambda";
import {
  ADMINS_GROUP_ID,
  APPROVER_SLACK_USER_IDS,
  DURATION_OPTIONS,
  ENGINEERS_GROUP_ID,
  MAX_DURATION_SECONDS,
  MAX_REQUESTS_PER_DAY,
  SSO_PORTAL_URL,
} from "./sheriff/config";
import {
  buildApprovalBlocks,
  buildDecidedBlocks,
  buildDecisionOutcomeText,
  buildRequestModal,
} from "./sheriff/blocks";
import {
  activePk,
  decodeSlackPayload,
  durationSecondsFor,
  eligibilityErrorMessage,
  evaluateDecision,
  evaluateEligibility,
  grantExpiresAt,
  grantSk,
  isApprover,
  isHttpUrl,
  rateLimitExceeded,
  ratePk,
  reconcileSweep,
  requestPk,
  utcDate,
  withinDurationCap,
  type GrantRecord,
  type RequestRecord,
} from "./sheriff/policy";
import { readSubmittedValues } from "./sheriff/handler";
import { resolveAdminsMembershipId } from "./sheriff/identity";
import { createStore } from "./sheriff/store";
import { verifySlackWebhook } from "./sheriff/verify";

// The store resolves the table name from the environment; the fake client
// never talks to DynamoDB, but the name must exist for the commands to build.
process.env.REQUEST_TABLE = "sheriff";

const asList = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as string[]) : [String(value)];

const record = (
  overrides: Partial<RequestRecord> = {},
): RequestRecord => ({
  id: "11111111-1111-1111-1111-111111111111",
  state: "requested",
  requesterSlackId: "UREQUESTER",
  requesterIdentityStoreId: "00000000-0000-0000-0000-000000000001",
  requesterEmail: "requester@goodparty.org",
  reason: "investigating an incident",
  ticket: "https://github.com/thegoodparty/ops/issues/1",
  durationValue: "PT1H",
  durationSeconds: 3600,
  createdAt: "2026-10-12T00:00:00.000Z",
  ...overrides,
});

const grant = (overrides: Partial<GrantRecord> = {}): GrantRecord => ({
  requestId: "req-1",
  state: "granting",
  requesterSlackId: "UREQUESTER",
  requesterIdentityStoreId: "user-1",
  requesterEmail: "requester@goodparty.org",
  approverSlackId: "UAPPROVER",
  groupId: ADMINS_GROUP_ID,
  reason: "investigating an incident",
  ticket: "https://github.com/thegoodparty/ops/issues/1",
  durationSeconds: 3600,
  grantedAt: "2026-10-13T00:00:00.000Z",
  expiresAt: "2026-10-13T01:00:00.000Z",
  ...overrides,
});

const fakeStore = (send: (command: unknown) => Promise<unknown>) =>
  createStore({ send } as unknown as DynamoDBDocumentClient);

describe("sheriffLambdaTrust", () => {
  it("is assumable only by Lambda", () => {
    assert.deepEqual(sheriffLambdaTrust.Statement, [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ]);
  });
});

describe("sheriffLambdaPolicy", () => {
  const actions = sheriffLambdaPolicy.Statement.flatMap((s) =>
    asList(s.Action),
  );

  it("allows exactly the step-4 actions", () => {
    assert.deepEqual([...actions].sort(), [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "secretsmanager:GetSecretValue",
      "sts:AssumeRole",
    ]);
  });

  // Step 4 wires the grant through `sheriff-grant`. The Lambda may assume
  // exactly that one role and holds no directory action of its own.
  it("assumes exactly the one sheriff-grant role", () => {
    const assume = sheriffLambdaPolicy.Statement.find(
      (s) => s.Sid === "AssumeSheriffGrant",
    );
    assert.ok(assume);
    assert.equal(assume.Action, "sts:AssumeRole");
    assert.deepEqual(asList(assume.Resource), [SHERIFF_GRANT_ROLE_ARN]);
    assert.equal(
      SHERIFF_GRANT_ROLE_ARN,
      "arn:aws:iam::333022194791:role/sheriff-grant",
    );
  });

  it("holds no identitystore, sso or sso-directory permission directly", () => {
    for (const action of actions) {
      assert.doesNotMatch(action, /^identitystore:/, action);
      assert.doesNotMatch(action, /^sso/, action);
    }
  });

  it("scopes every resource and never uses a bare wildcard", () => {
    for (const statement of sheriffLambdaPolicy.Statement) {
      const resources = asList(statement.Resource);
      assert.ok(resources.length > 0, `${statement.Sid} has no Resource`);
      for (const resource of resources) {
        assert.notEqual(resource, "*", `${statement.Sid} has a bare *`);
        assert.match(resource, /^arn:aws:/, resource);
        if (statement.Sid === "AssumeSheriffGrant") {
          // The one cross-account reach is the management-account grant role.
          assert.equal(resource, SHERIFF_GRANT_ROLE_ARN);
        } else {
          assert.ok(
            resource.includes("394495727159"),
            `${statement.Sid} is not scoped to the infrastructure account`,
          );
        }
      }
    }
  });

  it("reads only its own secret, not DELEGATES", () => {
    const secretStatement = sheriffLambdaPolicy.Statement.find(
      (s) => s.Sid === "ReadOwnSecret",
    );
    assert.ok(secretStatement);
    assert.match(asList(secretStatement.Resource)[0], /:secret:sheriff-\*/);
    assert.ok(!JSON.stringify(sheriffLambdaPolicy).includes("DELEGATES"));
  });

  it("names the one request table and queries it for the sweeper", () => {
    const tableStatement = sheriffLambdaPolicy.Statement.find(
      (s) => s.Sid === "RequestTable",
    );
    assert.ok(tableStatement);
    assert.equal(
      asList(tableStatement.Resource)[0],
      `arn:aws:dynamodb:us-west-2:394495727159:table/${SHERIFF_TABLE_NAME}`,
    );
    assert.ok(asList(tableStatement.Action).includes("dynamodb:Query"));
  });
});

describe("sheriff role name", () => {
  // `deploy/components/sheriff-grant.ts` trusts exactly
  // arn:aws:iam::394495727159:role/sheriff. The execution role must carry
  // that name or the first AssumeRole fails as a trust problem.
  it("is the role the grant trust names", () => {
    assert.equal(SHERIFF_ROLE_NAME, "sheriff");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../deploy/components/sheriff-grant.ts"),
      "utf8",
    );
    assert.match(source, /:role\/sheriff`/);
  });

  it("pins the app-scoped secret name", () => {
    assert.equal(SHERIFF_SECRET_NAME, "sheriff");
  });

  it("names the table after the app, sharing the secret's name", () => {
    // The secret holds the `@sheriff` Slack app's credentials and the table
    // holds the break-glass workflow's request records. Both are now named
    // `sheriff`; that is deliberate, and safe because Secrets Manager and
    // DynamoDB are separate namespaces.
    assert.equal(SHERIFF_TABLE_NAME, "sheriff");
    assert.equal(SHERIFF_SECRET_NAME, SHERIFF_TABLE_NAME);
  });
});

describe("sheriff secret adoption", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "sheriff-lambda.ts"),
    "utf8",
  );

  it("imports the secret by its partial ARN, not the bare name", () => {
    // The provider's importer parses the id as an ARN, so the bare name would
    // fail. The partial ARN omits the six random characters Secrets Manager
    // appends, which do not exist until the secret does; AWS resolves it to
    // the one secret with this name.
    assert.equal(
      SHERIFF_SECRET_IMPORT_ID,
      `arn:aws:secretsmanager:us-west-2:394495727159:secret:${SHERIFF_SECRET_NAME}`,
    );
    const secretBlock = source.slice(
      source.indexOf("new aws.secretsmanager.Secret("),
      source.indexOf("new aws.dynamodb.Table("),
    );
    assert.match(secretBlock, /import:\s*SHERIFF_SECRET_IMPORT_ID/);
    assert.doesNotMatch(secretBlock, /protect:\s*true/);
  });

  it("keeps protect on the request table", () => {
    // The table is the application audit record; a casual `pulumi destroy`
    // must not take it. The secret is deliberately not protected, because
    // Pulumi owns its full lifecycle.
    const tableBlock = source.slice(
      source.indexOf("new aws.dynamodb.Table("),
      source.indexOf("new aws.cloudwatch.LogGroup("),
    );
    assert.match(tableBlock, /protect:\s*true/);
  });
});

describe("sweeper and alarm infrastructure", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "sheriff-lambda.ts"),
    "utf8",
  );

  it("triggers the sweep on a periodic EventBridge rule with the sweep marker", () => {
    assert.match(source, /aws\.cloudwatch\.EventRule/);
    assert.match(source, /scheduleExpression: "rate\(5 minutes\)"/);
    assert.match(source, /action: "sweep"/);
    assert.match(source, /aws\.lambda\.Permission/);
    assert.match(source, /principal: "events\.amazonaws\.com"/);
  });

  it("alarms only on the orphaned audit event", () => {
    assert.equal(ORPHANED_AUDIT_EVENT, "membership.orphaned");
    assert.match(source, /ORPHANED_AUDIT_EVENT/);
    assert.match(source, /aws\.cloudwatch\.LogMetricFilter/);
    assert.match(source, /aws\.cloudwatch\.MetricAlarm/);
    assert.match(source, /alarmActions: \[alertTopic\.arn\]/);
    assert.match(source, /treatMissingData: "notBreaching"/);
    assert.equal(SHERIFF_ALERT_EMAIL, "aws-infrastructure@goodparty.org");
  });

  it("lets CloudWatch publish the alarm to the SNS topic", () => {
    assert.match(source, /aws\.sns\.TopicPolicy/);
    assert.match(source, /cloudwatch\.amazonaws\.com/);
    assert.match(source, /aws:SourceAccount/);
  });
});

describe("break-glass config", () => {
  it("has the engineer as the only approver", () => {
    assert.deepEqual([...APPROVER_SLACK_USER_IDS], ["U0BMU0DPS9Y"]);
  });

  it("pins the Engineers gate group and the Admins grant group", () => {
    assert.equal(ENGINEERS_GROUP_ID, "383193a0-7001-70d9-a321-ffe6d8af7378");
    assert.equal(ADMINS_GROUP_ID, "88c1b330-a001-707a-06ca-94e289013bf5");
  });

  it("derives the SSO portal URL from the identity store id", () => {
    assert.equal(SSO_PORTAL_URL, "https://d-9267e5cf96.awsapps.com/start");
  });

  it("bounds the modal to PT1H..PT4H", () => {
    assert.deepEqual(
      DURATION_OPTIONS.map((o) => o.value),
      ["PT1H", "PT2H", "PT3H", "PT4H"],
    );
    assert.equal(MAX_DURATION_SECONDS, 4 * 60 * 60);
  });
});

describe("duration", () => {
  it("maps the bounded values to seconds", () => {
    assert.equal(durationSecondsFor("PT1H"), 3600);
    assert.equal(durationSecondsFor("PT4H"), 14400);
  });

  it("rejects anything outside the bounded set", () => {
    assert.equal(durationSecondsFor("PT8H"), null);
    assert.equal(durationSecondsFor(undefined), null);
    assert.equal(durationSecondsFor("nonsense"), null);
  });

  it("caps at PT4H and rejects non-positive values", () => {
    assert.equal(withinDurationCap(3600), true);
    assert.equal(withinDurationCap(MAX_DURATION_SECONDS), true);
    assert.equal(withinDurationCap(MAX_DURATION_SECONDS + 1), false);
    assert.equal(withinDurationCap(0), false);
  });

  it("computes the expiry as granted-at plus the requested duration", () => {
    assert.equal(
      grantExpiresAt("2026-10-13T00:00:00.000Z", 3600),
      "2026-10-13T01:00:00.000Z",
    );
  });
});

describe("approvers", () => {
  it("accepts only the hardcoded list", () => {
    assert.equal(isApprover(APPROVER_SLACK_USER_IDS[0]), true);
    assert.equal(isApprover("USOMEONEELSE"), false);
  });
});

describe("evaluateDecision", () => {
  const approver = APPROVER_SLACK_USER_IDS[0];

  it("refuses a clicker who is not an approver", () => {
    const result = evaluateDecision({
      request: record(),
      clickerSlackId: "UNOTANAPPROVER",
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /not an approver/);
  });

  it("refuses the requester even if they are an approver", () => {
    const result = evaluateDecision({
      request: record({ requesterSlackId: approver }),
      clickerSlackId: approver,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /your own/);
  });

  it("refuses an already-decided request", () => {
    const result = evaluateDecision({
      request: record({ state: "denied" }),
      clickerSlackId: approver,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /already denied/);
  });

  it("refuses an over-cap duration", () => {
    const result = evaluateDecision({
      request: record({ durationSeconds: MAX_DURATION_SECONDS + 1 }),
      clickerSlackId: approver,
    });
    assert.equal(result.ok, false);
  });

  it("accepts a valid approver on an undecided, in-cap request", () => {
    assert.deepEqual(
      evaluateDecision({ request: record(), clickerSlackId: approver }),
      { ok: true },
    );
  });
});

describe("requester eligibility gate", () => {
  const base = {
    slackEmail: "engineer@goodparty.org",
    identityStoreUserId: "user-1",
    isEngineersMember: true,
  };

  it("accepts an engineer with a resolvable Identity Center user", () => {
    assert.deepEqual(evaluateEligibility(base), {
      ok: true,
      email: "engineer@goodparty.org",
      identityStoreUserId: "user-1",
    });
  });

  it("fails when Slack has no email, with its own message", () => {
    const result = evaluateEligibility({ ...base, slackEmail: undefined });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "no-slack-email");
    assert.match(eligibilityErrorMessage("no-slack-email"), /email address/);
  });

  it("fails when no Identity Center user matches the email, naming it", () => {
    const result = evaluateEligibility({
      ...base,
      identityStoreUserId: undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "no-identity-user");
    assert.match(
      eligibilityErrorMessage("no-identity-user", "engineer@goodparty.org"),
      /engineer@goodparty\.org/,
    );
  });

  it("fails when the user is not an Engineers member, with its own message", () => {
    const result = evaluateEligibility({ ...base, isEngineersMember: false });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "not-engineer");
    assert.match(
      eligibilityErrorMessage("not-engineer", "engineer@goodparty.org"),
      /Engineers group/,
    );
  });

  it("treats a missing membership result as not eligible", () => {
    const result = evaluateEligibility({
      ...base,
      isEngineersMember: undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "not-engineer");
  });

  it("gives the three failure modes distinct messages", () => {
    const messages = [
      eligibilityErrorMessage("no-slack-email"),
      eligibilityErrorMessage("no-identity-user", "a@b.c"),
      eligibilityErrorMessage("not-engineer", "a@b.c"),
    ];
    assert.equal(new Set(messages).size, 3);
  });
});

describe("reconcileSweep", () => {
  const now = Date.parse("2026-10-13T02:00:00.000Z");
  const members = [{ userId: "user-1", membershipId: "m-1" }];

  it("marks a granting record failed when the member is absent", () => {
    const plan = reconcileSweep({
      now,
      grants: [grant({ state: "granting" })],
      memberships: [],
    });
    assert.deepEqual(plan.failed.map((g) => g.requestId), ["req-1"]);
    assert.equal(plan.granted.length, 0);
    assert.equal(plan.revoke.length, 0);
    assert.equal(plan.unmanaged.length, 0);
  });

  it("backfills and grants a granting record with a present member", () => {
    const plan = reconcileSweep({
      now,
      grants: [
        grant({ state: "granting", expiresAt: "2026-10-13T03:00:00.000Z" }),
      ],
      memberships: members,
    });
    assert.deepEqual(plan.granted, [
      { grant: plan.granted[0].grant, membershipId: "m-1" },
    ]);
    assert.equal(plan.revoke.length, 0);
  });

  it("grants and then revokes an expired granting record with a present member", () => {
    const plan = reconcileSweep({
      now,
      grants: [grant({ state: "granting" })],
      memberships: members,
    });
    assert.equal(plan.granted.length, 1);
    assert.deepEqual(plan.revoke.map((r) => r.membershipId), ["m-1"]);
  });

  it("leaves an unexpired granted record alone", () => {
    const plan = reconcileSweep({
      now,
      grants: [
        grant({
          state: "granted",
          membershipId: "m-1",
          expiresAt: "2026-10-13T03:00:00.000Z",
        }),
      ],
      memberships: members,
    });
    assert.equal(plan.revoke.length, 0);
    assert.equal(plan.failed.length, 0);
    assert.equal(plan.unmanaged.length, 0);
  });

  it("revokes an expired granted record", () => {
    const plan = reconcileSweep({
      now,
      grants: [grant({ state: "granted", membershipId: "m-1" })],
      memberships: members,
    });
    assert.deepEqual(plan.revoke.map((r) => r.membershipId), ["m-1"]);
  });

  it("logs an unmanaged membership that no active grant explains", () => {
    const plan = reconcileSweep({
      now,
      grants: [],
      memberships: [{ userId: "standing-admin", membershipId: "m-9" }],
    });
    assert.deepEqual(plan.unmanaged, [
      { userId: "standing-admin", membershipId: "m-9" },
    ]);
  });

  it("does not treat a revoked record's member as managed", () => {
    const plan = reconcileSweep({
      now,
      grants: [grant({ state: "revoked", membershipId: "m-1" })],
      memberships: members,
    });
    assert.equal(plan.revoke.length, 0);
    assert.deepEqual(plan.unmanaged, members);
  });
});

describe("grant store", () => {
  it("claims the active-grant lock with attribute_not_exists", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    const claimed = await store.beginActiveGrant("user-1", "req-1");
    assert.equal(claimed, true);
    assert.equal(captured?.input?.Key.pk, activePk("user-1"));
    assert.match(
      String(captured?.input?.ConditionExpression),
      /attribute_not_exists\(pk\)/,
    );
  });

  it("reports a failed claim when the condition fails", async () => {
    const store = fakeStore(async () => {
      throw new ConditionalCheckFailedException({
        message: "conditional",
        $metadata: {},
      });
    });
    assert.equal(await store.beginActiveGrant("user-1", "req-1"), false);
  });

  it("releases the lock, tolerating an already-released one", async () => {
    const store = fakeStore(async () => {
      throw new ConditionalCheckFailedException({
        message: "conditional",
        $metadata: {},
      });
    });
    await store.releaseActiveGrant("user-1");
  });

  it("writes the grant record under the fixed GRANT partition", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    await store.putGrant(grant());
    assert.equal(captured?.input?.Item?.pk, "GRANT");
    assert.equal(captured?.input?.Item?.sk, grantSk("req-1"));
    assert.equal(captured?.input?.Item?.state, "granting");
    assert.equal(
      captured?.input?.ConditionExpression,
      "attribute_not_exists(pk)",
    );
  });

  it("queries every grant record by the fixed partition", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return { Items: [{ pk: "GRANT", sk: grantSk("req-1"), ...grant() }] };
    });
    const grants = await store.listGrants();
    assert.equal(captured?.input?.ExpressionAttributeValues?.[":pk"], "GRANT");
    assert.equal(grants.length, 1);
    assert.equal(grants[0].requestId, "req-1");
  });

  it("records the membershipId when flipping to granted", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    await store.setGrantState({
      requestId: "req-1",
      state: "granted",
      membershipId: "m-1",
    });
    assert.match(String(captured?.input?.UpdateExpression), /membershipId/);
    assert.equal(
      captured?.input?.ExpressionAttributeValues?.[":membershipId"],
      "m-1",
    );
  });
});

describe("resolveAdminsMembershipId", () => {
  it("finds the Admins membership on a later page", async () => {
    // A user in many groups can have their Admins membership past the first
    // page; the ConflictException recovery path must paginate or it fails the
    // grant closed for exactly the users most likely to be standing admins.
    const pages = [
      {
        GroupMemberships: [{ GroupId: "other", MembershipId: "m-other" }],
        NextToken: "t1",
      },
      {
        GroupMemberships: [
          { GroupId: ADMINS_GROUP_ID, MembershipId: "m-admins" },
        ],
      },
    ];
    let call = 0;
    const client = { send: async () => pages[call++] } as any;
    assert.equal(await resolveAdminsMembershipId(client, "user-1"), "m-admins");
    assert.equal(call, 2);
  });

  it("returns null when the user is not an Admins member", async () => {
    const client = {
      send: async () => ({ GroupMemberships: [] }),
    } as any;
    assert.equal(await resolveAdminsMembershipId(client, "user-1"), null);
  });
});

describe("rate limit", () => {
  it("allows up to the cap and rejects beyond it", () => {
    assert.equal(rateLimitExceeded(MAX_REQUESTS_PER_DAY), false);
    assert.equal(rateLimitExceeded(MAX_REQUESTS_PER_DAY + 1), true);
  });
});

describe("payload decoding", () => {
  it("decodes application/x-www-form-urlencoded payload=<json>", () => {
    const payload = { type: "block_actions", user: { id: "U1" } };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    assert.deepEqual(decodeSlackPayload(body), payload);
  });

  it("returns null for a missing or malformed payload", () => {
    assert.equal(decodeSlackPayload("token=x"), null);
    assert.equal(decodeSlackPayload("payload=not-json"), null);
    assert.equal(decodeSlackPayload("payload=[1,2,3]"), null);
  });

  it("accepts an https ticket link and rejects anything else", () => {
    assert.equal(isHttpUrl("https://github.com/x/y/issues/1"), true);
    assert.equal(isHttpUrl("http://example.com"), true);
    assert.equal(isHttpUrl("not-a-url"), false);
    assert.equal(isHttpUrl("javascript:alert(1)"), false);
  });
});

describe("modal", () => {
  const modal = buildRequestModal();
  const blocks = modal.blocks as Array<Record<string, unknown>>;

  it("asks for duration, reason and ticket and nothing else", () => {
    const blockIds = blocks.map((b) => b.block_id);
    assert.deepEqual(blockIds, [
      "duration_block",
      "reason_block",
      "ticket_block",
    ]);
    // No account field: escalation is global by design.
    assert.ok(!JSON.stringify(modal).toLowerCase().includes("account"));
  });

  it("defaults the duration to PT1H and offers only the capped values", () => {
    const duration = blocks[0].element as Record<string, unknown>;
    assert.equal(
      (duration.initial_option as Record<string, unknown>).value,
      "PT1H",
    );
    const options = duration.options as Array<Record<string, unknown>>;
    assert.deepEqual(
      options.map((o) => o.value),
      ["PT1H", "PT2H", "PT3H", "PT4H"],
    );
  });
});

describe("approval post", () => {
  it("shows the requester email and binds both buttons to the request id", () => {
    const request = record();
    const blocks = buildApprovalBlocks(request);
    const serialized = JSON.stringify(blocks);
    assert.match(serialized, /requester@goodparty\.org/);
    assert.ok(!serialized.includes("Dry run"));

    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
      actions.elements.map((e) => e.action_id),
      ["breakglass_approve", "breakglass_deny"],
    );
    for (const element of actions.elements) {
      assert.equal(element.value, request.id);
    }
  });
});

describe("decided post", () => {
  it("shows the SSO link and the session caveat on a granted approval", () => {
    const request = record();
    const granted = grant({ state: "granted", membershipId: "m-1" });
    const blocks = buildDecidedBlocks(request, "approved", "UAPPROVER", granted);
    const serialized = JSON.stringify(blocks);
    assert.ok(!serialized.includes("breakglass_approve"));
    assert.match(serialized, /approved/);
    assert.match(serialized, /awsapps\.com\/start/);
    assert.match(serialized, /already open/);
    assert.ok(!serialized.includes("Dry run"));

    const outcome = buildDecisionOutcomeText(
      request,
      "approved",
      "UAPPROVER",
      granted,
    );
    assert.match(outcome, /AdministratorAccess/);
    assert.match(outcome, /awsapps\.com\/start/);
  });

  it("says no access when the grant failed", () => {
    const failed = grant({ state: "failed" });
    const blocks = buildDecidedBlocks(
      record(),
      "approved",
      "UAPPROVER",
      failed,
    );
    assert.match(JSON.stringify(blocks), /grant failed/);
    const outcome = buildDecisionOutcomeText(
      record(),
      "approved",
      "UAPPROVER",
      failed,
    );
    assert.match(outcome, /No access was granted/);
  });

  it("does not claim a grant on a denial", () => {
    const blocks = buildDecidedBlocks(record(), "denied", "UAPPROVER");
    assert.match(JSON.stringify(blocks), /No access was granted/);
    const outcome = buildDecisionOutcomeText(
      record(),
      "denied",
      "UAPPROVER",
    );
    assert.match(outcome, /denied/);
    assert.match(outcome, /No access was granted/);
  });
});

describe("readSubmittedValues", () => {
  const submission = (overrides: Record<string, unknown> = {}) => ({
    type: "view_submission",
    user: { id: "UREQUESTER" },
    view: {
      state: {
        values: {
          duration_block: {
            duration: { selected_option: { value: "PT2H" } },
          },
          reason_block: { reason: { value: "  investigating  " } },
          ticket_block: {
            ticket: { value: "https://github.com/thegoodparty/ops/issues/2" },
          },
          ...overrides,
        },
      },
    },
  });

  it("extracts and trims the three fields", () => {
    const parsed = readSubmittedValues(submission());
    assert.deepEqual(parsed.values, {
      durationValue: "PT2H",
      reason: "investigating",
      ticket: "https://github.com/thegoodparty/ops/issues/2",
    });
  });

  it("returns block-keyed errors for a missing reason or bad ticket", () => {
    const parsed = readSubmittedValues(
      submission({
        reason_block: { reason: { value: "   " } },
        ticket_block: { ticket: { value: "nope" } },
      }),
    );
    assert.ok(parsed.errors);
    assert.ok(parsed.errors.reason_block);
    assert.ok(parsed.errors.ticket_block);
  });

  it("returns a duration error for an unbounded value", () => {
    const parsed = readSubmittedValues(
      submission({
        duration_block: { duration: { selected_option: { value: "PT8H" } } },
      }),
    );
    assert.ok(parsed.errors?.duration_block);
  });
});

describe("slack signature verification", () => {
  const secret = "test-signing-secret";
  const body = "payload=%7B%7D";
  const now = () => String(Math.floor(Date.now() / 1000));
  const sign = (timestamp: string, payload: string) =>
    `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${payload}`)
      .digest("hex")}`;

  it("accepts a signature it can reproduce", () => {
    const timestamp = now();
    assert.equal(
      verifySlackWebhook(body, timestamp, sign(timestamp, body), secret),
      true,
    );
  });

  it("rejects a wrong secret, a stale timestamp and missing headers", () => {
    const timestamp = now();
    assert.equal(
      verifySlackWebhook(body, timestamp, sign(timestamp, body), "wrong"),
      false,
    );
    const stale = String(Number(timestamp) - 60 * 6);
    assert.equal(
      verifySlackWebhook(body, stale, sign(stale, body), secret),
      false,
    );
    assert.equal(
      verifySlackWebhook(body, undefined, sign(timestamp, body), secret),
      false,
    );
    assert.equal(verifySlackWebhook(body, timestamp, undefined, secret), false);
  });
});

describe("keys and dates", () => {
  it("prefixes request, rate, grant and active items distinctly", () => {
    assert.equal(requestPk("abc"), "REQUEST#abc");
    assert.equal(ratePk("U1", "2026-10-12"), "RATE#U1#2026-10-12");
    assert.equal(grantSk("abc"), "GRANT#abc");
    assert.equal(activePk("user-1"), "ACTIVE#user-1");
  });

  it("buckets the rate counter by UTC day", () => {
    assert.equal(utcDate(new Date("2026-10-12T23:59:59Z")), "2026-10-12");
    assert.equal(utcDate(new Date("2026-10-13T00:00:01Z")), "2026-10-13");
  });
});
