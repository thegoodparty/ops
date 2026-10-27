import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  ConflictException,
  ResourceNotFoundException,
} from "@aws-sdk/client-identitystore";
import {
  ConflictException as SchedulerConflictException,
  ResourceNotFoundException as SchedulerResourceNotFoundException,
} from "@aws-sdk/client-scheduler";
import type { SchedulerClient } from "@aws-sdk/client-scheduler";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import {
  ORPHANED_AUDIT_EVENT,
  SHERIFF_ALERT_EMAIL,
  SHERIFF_FUNCTION_ARN,
  SHERIFF_GRANT_ROLE_ARN,
  SHERIFF_ROLE_NAME,
  SHERIFF_SCHEDULER_DLQ_ARN,
  SHERIFF_SCHEDULER_DLQ_NAME,
  SHERIFF_SCHEDULER_ROLE_ARN,
  SHERIFF_SCHEDULER_ROLE_NAME,
  SHERIFF_SCHEDULE_ARN_PREFIX,
  SHERIFF_SCHEDULE_GROUP,
  SHERIFF_SCHEDULE_GROUP_ARN,
  SHERIFF_TABLE_NAME,
  SHERIFF_SECRET_NAME,
  SHERIFF_SECRET_IMPORT_ID,
  sheriffLambdaPolicy,
  sheriffLambdaTrust,
  sheriffSchedulerPolicy,
  sheriffSchedulerTrust,
} from "./sheriff-lambda";
import {
  ADMINS_GROUP_ID,
  APPROVERS_GROUP_ID,
  DURATION_OPTIONS,
  ENGINEERS_GROUP_ID,
  MAX_DURATION_SECONDS,
  MAX_REQUESTS_PER_DAY,
  SCHEDULE_MAX_EVENT_AGE_SECONDS,
  SCHEDULE_MAX_RETRY_ATTEMPTS,
  SSO_PORTAL_URL,
  SWEEP_GRANTING_GRACE_MS,
} from "./sheriff/config";
import {
  buildApprovalBlocks,
  buildDecidedBlocks,
  buildDecisionOutcomeText,
  buildRequestModal,
  buildRevokedBlocks,
  buildRevokeOutcomeText,
} from "./sheriff/blocks";
import {
  activeGrantDecision,
  activePk,
  approverErrorMessage,
  decodeSlackPayload,
  durationSecondsFor,
  eligibilityErrorMessage,
  evaluateApprover,
  evaluateApproverLookup,
  evaluateDecision,
  evaluateEligibility,
  expiryScheduleName,
  grantExpiresAt,
  grantSk,
  scheduleAtExpression,
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
import {
  handleRevoke,
  handleSweep,
  readSubmittedValues,
  revokeGrant,
} from "./sheriff/handler";
import { createScheduler } from "./sheriff/scheduler";
import {
  createAdminsMembership,
  lookupApprover,
  resolveAdminsMembershipId,
} from "./sheriff/identity";
import { createStore } from "./sheriff/store";
import { verifySlackWebhook } from "./sheriff/verify";

// The store resolves the table name from the environment; the fake client
// never talks to DynamoDB, but the name must exist for the commands to build.
process.env.REQUEST_TABLE = "sheriff";
// The scheduler reads its target from the environment; the fake client never
// talks to EventBridge Scheduler, but the names must exist for the commands to
// build. The values mirror what `sheriff-lambda.ts` sets on the function.
process.env.SCHEDULE_GROUP = SHERIFF_SCHEDULE_GROUP;
process.env.SCHEDULE_ROLE_ARN = SHERIFF_SCHEDULER_ROLE_ARN;
process.env.SCHEDULE_DLQ_ARN = SHERIFF_SCHEDULER_DLQ_ARN;
process.env.FUNCTION_ARN = SHERIFF_FUNCTION_ARN;

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

  it("allows exactly the step-5 actions", () => {
    assert.deepEqual([...actions].sort(), [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "iam:PassRole",
      "lambda:InvokeFunction",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "scheduler:CreateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
      "secretsmanager:GetSecretValue",
      "sts:AssumeRole",
    ]);
  });

  it("scopes scheduler management to the one schedule group", () => {
    const scheduler = sheriffLambdaPolicy.Statement.find(
      (s) => s.Sid === "ManageExpirySchedules",
    );
    assert.ok(scheduler);
    assert.deepEqual(asList(scheduler.Action).sort(), [
      "scheduler:CreateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
    ]);
    assert.deepEqual(asList(scheduler.Resource), [
      `${SHERIFF_SCHEDULE_ARN_PREFIX}*`,
    ]);
    // Never the default group and never a bare `*`.
    assert.ok(!asList(scheduler.Resource).includes("*"));
    assert.doesNotMatch(
      String(asList(scheduler.Resource)[0]),
      /schedule\/default/,
    );
  });

  it("passes only the one scheduler role, only to the scheduler service", () => {
    const passRole = sheriffLambdaPolicy.Statement.find(
      (s) => s.Sid === "PassSchedulerRole",
    );
    assert.ok(passRole);
    assert.equal(passRole.Action, "iam:PassRole");
    assert.deepEqual(asList(passRole.Resource), [SHERIFF_SCHEDULER_ROLE_ARN]);
    assert.deepEqual(passRole.Condition, {
      StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
    });
  });

  it("self-invokes only its own function", () => {
    const self = sheriffLambdaPolicy.Statement.find(
      (s) => s.Sid === "SelfInvoke",
    );
    assert.ok(self);
    assert.equal(self.Action, "lambda:InvokeFunction");
    assert.equal(
      asList(self.Resource)[0],
      "arn:aws:lambda:us-west-2:394495727159:function:sheriff",
    );
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

describe("scheduled revocation infrastructure", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "sheriff-lambda.ts"),
    "utf8",
  );

  it("trusts only the scheduler service for this account and schedule group", () => {
    const statement = sheriffSchedulerTrust.Statement[0];
    assert.deepEqual(statement.Principal, {
      Service: "scheduler.amazonaws.com",
    });
    assert.equal(statement.Action, "sts:AssumeRole");
    // `aws:SourceArn` must be the schedule group ARN, not a schedule ARN or a
    // name prefix: Scheduler presents the group ARN at AssumeRole time.
    assert.deepEqual(statement.Condition, {
      StringEquals: {
        "aws:SourceAccount": "394495727159",
        "aws:SourceArn": SHERIFF_SCHEDULE_GROUP_ARN,
      },
    });
    assert.match(SHERIFF_SCHEDULE_GROUP_ARN, /:schedule-group\/sheriff$/);
  });

  it("lets the execution role invoke only the one function and write only the one DLQ", () => {
    const statements = sheriffSchedulerPolicy.Statement;
    assert.deepEqual(
      statements.map((s) => s.Sid).sort(),
      ["DeadLetterQueue", "InvokeSheriff"],
    );
    const invoke = statements.find((s) => s.Sid === "InvokeSheriff");
    assert.equal(invoke?.Action, "lambda:InvokeFunction");
    assert.deepEqual(asList(invoke?.Resource), [SHERIFF_FUNCTION_ARN]);
    const dlq = statements.find((s) => s.Sid === "DeadLetterQueue");
    assert.equal(dlq?.Action, "sqs:SendMessage");
    assert.deepEqual(asList(dlq?.Resource), [SHERIFF_SCHEDULER_DLQ_ARN]);
  });

  it("names the group, role and DLQ consistently", () => {
    assert.equal(SHERIFF_SCHEDULE_GROUP, "sheriff");
    assert.equal(SHERIFF_SCHEDULER_ROLE_NAME, "sheriff-scheduler");
    assert.equal(SHERIFF_SCHEDULER_DLQ_NAME, "sheriff-scheduler-dlq");
    assert.equal(
      SHERIFF_SCHEDULER_ROLE_ARN,
      "arn:aws:iam::394495727159:role/sheriff-scheduler",
    );
    assert.equal(
      SHERIFF_SCHEDULER_DLQ_ARN,
      "arn:aws:sqs:us-west-2:394495727159:sheriff-scheduler-dlq",
    );
  });

  it("creates the group, DLQ, execution role and env wiring in Pulumi", () => {
    assert.match(source, /aws\.scheduler\.ScheduleGroup/);
    assert.match(source, /aws\.sqs\.Queue/);
    assert.match(source, /sheriffSchedulerTrust/);
    assert.match(source, /sheriffSchedulerPolicy/);
    assert.match(source, /SCHEDULE_GROUP: SHERIFF_SCHEDULE_GROUP/);
    assert.match(source, /SCHEDULE_ROLE_ARN: SHERIFF_SCHEDULER_ROLE_ARN/);
    assert.match(source, /SCHEDULE_DLQ_ARN: SHERIFF_SCHEDULER_DLQ_ARN/);
    assert.match(source, /FUNCTION_ARN: SHERIFF_FUNCTION_ARN/);
  });
});

describe("break-glass config", () => {
  it("pins the Approvers decision-time gate group", () => {
    assert.equal(APPROVERS_GROUP_ID, "e841e310-0051-7062-2ea4-9905d12f345e");
  });

  // The Approvers id is a literal duplicated from the group-sync config, which
  // owns the `approvers-google` pair. Read that source so the two cannot drift
  // silently, the way the sheriff-grant test pins the Admins id. A change to
  // the synced group in either file fails this.
  it("mirrors the Approvers group id in the group-sync config", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "group-sync/config.ts"),
      "utf8",
    );
    assert.match(
      source,
      /APPROVERS_GROUP_ID = "e841e310-0051-7062-2ea4-9905d12f345e"/,
    );
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

  it("keeps the sweeper grace window comfortably longer than the grant path", () => {
    // The async approve path is a few seconds; five minutes means a sweep can
    // never fail a grant that is still running.
    assert.equal(SWEEP_GRANTING_GRACE_MS, 5 * 60 * 1000);
  });
});

describe("async ack path", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "sheriff/handler.ts"),
    "utf8",
  );

  it("self-invokes asynchronously and routes the async actions", () => {
    assert.match(source, /InvocationType: "Event"/);
    assert.match(source, /event\.action === "post-request"/);
    assert.match(source, /event\.action === "decide"/);
  });

  it("does not require a Slack signature on the async events", () => {
    assert.match(source, /const isAsync =/);
    assert.match(source, /event\.action === "post-request"/);
    assert.match(source, /event\.action === "decide"/);
    assert.match(source, /event\.action === "revoke"/);
    assert.match(source, /if \(\s*!isAsync &&/);
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

describe("expiry schedule naming", () => {
  it("names the schedule deterministically from the request id", () => {
    assert.equal(expiryScheduleName("abc"), "sheriff-abc");
  });

  it("formats the one-shot at() expression in UTC without milliseconds", () => {
    // EventBridge Scheduler's at() form is at(yyyy-mm-ddThh:mm:ss); the ISO
    // milliseconds and trailing Z are rejected.
    assert.equal(
      scheduleAtExpression("2026-10-13T21:00:00.000Z"),
      "at(2026-10-13T21:00:00)",
    );
  });
});

describe("approvers", () => {
  const base = {
    slackEmail: "approver@goodparty.org",
    identityStoreUserId: "user-approver",
    isApproversMember: true,
  };

  it("accepts a live Approvers member with a resolvable Identity Center user", () => {
    assert.deepEqual(evaluateApprover(base), {
      ok: true,
      email: "approver@goodparty.org",
      identityStoreUserId: "user-approver",
    });
  });

  it("refuses a clicker who is not in the Approvers group", () => {
    const result = evaluateApprover({ ...base, isApproversMember: false });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "not-approver");
    assert.match(
      approverErrorMessage("not-approver", "approver@goodparty.org"),
      /Approvers group/,
    );
  });

  it("refuses when Slack has no email, with its own message", () => {
    const result = evaluateApprover({ ...base, slackEmail: undefined });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "no-slack-email");
    assert.match(approverErrorMessage("no-slack-email"), /email address/);
  });

  it("refuses when no Identity Center user matches the email, naming it", () => {
    const result = evaluateApprover({
      ...base,
      identityStoreUserId: undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "no-identity-user");
    assert.match(
      approverErrorMessage("no-identity-user", "approver@goodparty.org"),
      /approver@goodparty\.org/,
    );
  });

  it("fails closed and explicitly when Identity Store cannot answer", () => {
    // Even a resolved member is refused if the live check errored: an outage
    // must never read as an approval.
    const result = evaluateApprover({ ...base, identityStoreError: true });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "identity-store-error");
    assert.match(
      approverErrorMessage("identity-store-error"),
      /no access was granted/i,
    );
  });

  it("treats a missing membership result as not an approver", () => {
    const result = evaluateApprover({
      ...base,
      isApproversMember: undefined,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "not-approver");
  });

  it("gives the four failure modes distinct messages", () => {
    const messages = [
      approverErrorMessage("no-slack-email"),
      approverErrorMessage("no-identity-user", "a@b.c"),
      approverErrorMessage("not-approver", "a@b.c"),
      approverErrorMessage("identity-store-error"),
    ];
    assert.equal(new Set(messages).size, 4);
    for (const message of messages) {
      assert.match(message, /refused|not a member/);
    }
  });
});

describe("lookupApprover", () => {
  const fakeClient = (send: (command: any) => Promise<unknown>) =>
    ({ send }) as any;

  it("returns member with the resolved user id", async () => {
    const client = fakeClient(async (command) => {
      if (command.constructor.name === "GetUserIdCommand") {
        return { UserId: "user-1" };
      }
      return {
        Results: [{ GroupId: APPROVERS_GROUP_ID, MembershipExists: true }],
      };
    });
    assert.deepEqual(await lookupApprover(client, "a@goodparty.org"), {
      status: "member",
      identityStoreUserId: "user-1",
    });
  });

  it("returns not-member when the group check is false", async () => {
    const client = fakeClient(async (command) => {
      if (command.constructor.name === "GetUserIdCommand") {
        return { UserId: "user-1" };
      }
      return {
        Results: [{ GroupId: APPROVERS_GROUP_ID, MembershipExists: false }],
      };
    });
    assert.deepEqual(await lookupApprover(client, "a@goodparty.org"), {
      status: "not-member",
      identityStoreUserId: "user-1",
    });
  });

  it("returns no-user when GetUserId finds nothing", async () => {
    const client = fakeClient(async () => {
      throw new ResourceNotFoundException({ message: "missing", $metadata: {} });
    });
    assert.deepEqual(await lookupApprover(client, "a@goodparty.org"), {
      status: "no-user",
    });
  });

  it("returns error on an Identity Store failure instead of throwing", async () => {
    const client = fakeClient(async () => {
      throw new Error("throttled");
    });
    assert.deepEqual(await lookupApprover(client, "a@goodparty.org"), {
      status: "error",
    });
  });
});

describe("evaluateApproverLookup", () => {
  // The handler's mapping from the live lookup onto the gate. The error case is
  // the one a reviewer caught: an Identity Store failure must not read as
  // "no user", even though both refuse the decision.
  it("maps a member lookup to an allow", () => {
    assert.deepEqual(
      evaluateApproverLookup({
        slackEmail: "approver@goodparty.org",
        lookup: { status: "member", identityStoreUserId: "user-1" },
      }),
      {
        ok: true,
        email: "approver@goodparty.org",
        identityStoreUserId: "user-1",
      },
    );
  });

  it("maps not-member, no-user and error to their own failures", () => {
    const base = { slackEmail: "approver@goodparty.org" };
    const failures = [
      evaluateApproverLookup({
        ...base,
        lookup: { status: "not-member", identityStoreUserId: "user-1" },
      }),
      evaluateApproverLookup({ ...base, lookup: { status: "no-user" } }),
      evaluateApproverLookup({ ...base, lookup: { status: "error" } }),
    ].map((result) => (result.ok ? "" : result.failure));
    assert.deepEqual(failures, [
      "not-approver",
      "no-identity-user",
      "identity-store-error",
    ]);
  });

  it("treats an Identity Store error as an outage, not a missing user", () => {
    const result = evaluateApproverLookup({
      slackEmail: "approver@goodparty.org",
      lookup: { status: "error" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "identity-store-error");
  });

  it("treats a failed AssumeRole (null lookup) as an outage too", () => {
    const result = evaluateApproverLookup({
      slackEmail: "approver@goodparty.org",
      lookup: null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "identity-store-error");
  });

  it("reports no email before it reports an outage", () => {
    const result = evaluateApproverLookup({ slackEmail: undefined, lookup: null });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.failure, "no-slack-email");
  });
});

describe("evaluateDecision", () => {
  const approver = "UAPPROVER";

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

  it("treats a request already in the grant path as decided (async idempotency)", () => {
    // A Slack retry or a duplicate async delivery re-runs this check and must
    // stop rather than start a second grant.
    const result = evaluateDecision({
      request: record({ state: "granting" }),
      clickerSlackId: approver,
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /already granting/);
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
  const noGrace = { now, grantingGraceMs: 0 };

  it("marks a granting record failed when the member is absent", () => {
    const plan = reconcileSweep({
      ...noGrace,
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
      ...noGrace,
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
      ...noGrace,
      grants: [grant({ state: "granting" })],
      memberships: members,
    });
    assert.equal(plan.granted.length, 1);
    assert.deepEqual(plan.revoke.map((r) => r.membershipId), ["m-1"]);
  });

  it("leaves a granting record inside the grace window alone", () => {
    // The approve path may still be running; failing it now would strand the
    // membership that lands afterwards.
    const inFlight = grant({
      state: "granting",
      grantedAt: new Date(now - 30 * 1000).toISOString(),
    });
    const plan = reconcileSweep({
      now,
      grantingGraceMs: 5 * 60 * 1000,
      grants: [inFlight],
      memberships: [],
    });
    assert.equal(plan.failed.length, 0);
    assert.equal(plan.granted.length, 0);
    assert.equal(plan.revoke.length, 0);
    // The requester is still "active", so a present member is not unmanaged.
    assert.equal(plan.unmanaged.length, 0);
  });

  it("reconciles a granting record once it is older than the grace window", () => {
    const stale = grant({
      state: "granting",
      grantedAt: new Date(now - 10 * 60 * 1000).toISOString(),
    });
    const plan = reconcileSweep({
      now,
      grantingGraceMs: 5 * 60 * 1000,
      grants: [stale],
      memberships: [],
    });
    assert.deepEqual(plan.failed.map((g) => g.requestId), ["req-1"]);
  });

  it("leaves an unexpired granted record alone", () => {
    const plan = reconcileSweep({
      ...noGrace,
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
      ...noGrace,
      grants: [grant({ state: "granted", membershipId: "m-1" })],
      memberships: members,
    });
    assert.deepEqual(plan.revoke.map((r) => r.membershipId), ["m-1"]);
  });

  it("logs an unmanaged membership that no active grant explains", () => {
    const plan = reconcileSweep({
      ...noGrace,
      grants: [],
      memberships: [{ userId: "standing-admin", membershipId: "m-9" }],
    });
    assert.deepEqual(plan.unmanaged, [
      { userId: "standing-admin", membershipId: "m-9" },
    ]);
  });

  it("revokes a failed record whose member is present (untracked access)", () => {
    const plan = reconcileSweep({
      ...noGrace,
      grants: [grant({ state: "failed" })],
      memberships: members,
    });
    assert.deepEqual(plan.revoke.map((r) => r.membershipId), ["m-1"]);
    // It is managed (being revoked), not unmanaged.
    assert.equal(plan.unmanaged.length, 0);
  });

  it("does not treat a revoked record's member as managed", () => {
    const plan = reconcileSweep({
      ...noGrace,
      grants: [grant({ state: "revoked", membershipId: "m-1" })],
      memberships: members,
    });
    assert.equal(plan.revoke.length, 0);
    assert.deepEqual(plan.unmanaged, members);
  });
});

describe("handleSweep imperative paths", () => {
  const sweepDeps = (args: {
    grants: GrantRecord[];
    memberships?: { userId: string; membershipId: string }[];
    setRequestState?: (
      id: string,
      state: string,
      from?: string | string[],
    ) => Promise<boolean>;
    setGrantState?: (stateArgs: { state: string }) => Promise<boolean>;
    deleteMembership?: (client: unknown, id: string) => Promise<boolean>;
    calls?: string[];
  }) => {
    const calls = args.calls ?? [];
    const store = {
      listGrants: async () => args.grants,
      setGrantState: async (stateArgs: { state: string }) => {
        if (args.setGrantState) return args.setGrantState(stateArgs);
        calls.push(`setGrantState:${stateArgs.state}`);
        return true;
      },
      setRequestState: async (
        id: string,
        state: string,
        from?: string | string[],
      ) => {
        if (args.setRequestState) return args.setRequestState(id, state, from);
        calls.push(`setRequestState:${state}`);
        return true;
      },
      releaseActiveGrant: async (id: string) => {
        calls.push(`releaseActiveGrant:${id}`);
      },
    };
    return {
      store: store as any,
      assumeGrantRole: (async () => ({})) as any,
      listAdminsMemberships: (async () => args.memberships ?? []) as any,
      deleteAdminsMembership: (args.deleteMembership ??
        (async () => true)) as any,
      createExpirySchedule: (async (grant: GrantRecord) => {
        calls.push(`createExpirySchedule:${grant.requestId}`);
        return grant.scheduleName ?? `sheriff-${grant.requestId}`;
      }) as any,
      deleteExpirySchedule: (async (grant: GrantRecord) => {
        calls.push(`deleteExpirySchedule:${grant.requestId}`);
      }) as any,
      calls,
    };
  };

  const oldGranting = () =>
    grant({
      state: "granting",
      grantedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

  it("releases the lock even when the request-state write throws", async () => {
    const calls: string[] = [];
    const deps = sweepDeps({
      grants: [oldGranting()],
      memberships: [],
      setRequestState: async () => {
        throw new Error("dynamo");
      },
      calls,
    });
    await assert.rejects(() => handleSweep(deps));
    assert.ok(calls.includes("releaseActiveGrant:user-1"));
  });

  it("revokes and releases the lock on a successful revoke", async () => {
    const calls: string[] = [];
    const deps = sweepDeps({
      grants: [
        grant({
          state: "granted",
          membershipId: "m-1",
          expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
        }),
      ],
      memberships: [{ userId: "user-1", membershipId: "m-1" }],
      calls,
    });
    await handleSweep(deps);
    assert.ok(calls.includes("setGrantState:revoked"));
    assert.ok(calls.includes("releaseActiveGrant:user-1"));
  });

  it("keeps the lock and skips the revoke write when the revoke fails", async () => {
    const calls: string[] = [];
    const deps = sweepDeps({
      grants: [
        grant({
          state: "granted",
          membershipId: "m-1",
          expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
        }),
      ],
      memberships: [{ userId: "user-1", membershipId: "m-1" }],
      deleteMembership: async () => {
        throw new Error("access denied");
      },
      calls,
    });
    await handleSweep(deps);
    assert.ok(!calls.includes("setGrantState:revoked"));
    assert.ok(!calls.includes("releaseActiveGrant:user-1"));
  });

  it("revokes a failed grant whose member is still present", async () => {
    const calls: string[] = [];
    const deps = sweepDeps({
      grants: [grant({ state: "failed" })],
      memberships: [{ userId: "user-1", membershipId: "m-1" }],
      calls,
    });
    await handleSweep(deps);
    assert.ok(calls.includes("setGrantState:revoked"));
    assert.ok(calls.includes("releaseActiveGrant:user-1"));
  });

  it("skips the rest of the failed transition when the conditional write is a no-op", async () => {
    // A concurrent sweep moved the record; this sweep must not clobber it and
    // must not release the lock.
    const calls: string[] = [];
    const deps = sweepDeps({
      grants: [oldGranting()],
      memberships: [],
      setGrantState: async () => false,
      calls,
    });
    await handleSweep(deps);
    assert.ok(!calls.some((call) => call.startsWith("setRequestState")));
    assert.ok(!calls.includes("releaseActiveGrant:user-1"));
  });

  it("skips the request write on a revoke no-op but still releases the lock", async () => {
    // The membership was deleted, so the lock must be released even though a
    // concurrent sweep already moved the record and the state write was a
    // no-op.
    const calls: string[] = [];
    const deps = sweepDeps({
      grants: [
        grant({
          state: "granted",
          membershipId: "m-1",
          expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
        }),
      ],
      memberships: [{ userId: "user-1", membershipId: "m-1" }],
      setGrantState: async () => false,
      calls,
    });
    await handleSweep(deps);
    assert.ok(!calls.some((call) => call.startsWith("setRequestState")));
    assert.ok(calls.includes("releaseActiveGrant:user-1"));
  });
});

describe("activeGrantDecision", () => {
  it("proceeds when there is no active lock", () => {
    assert.equal(
      activeGrantDecision({ active: null, requestId: "req-1" }),
      "proceed",
    );
  });

  it("treats the same request's lock as our own retry", () => {
    // Slack retries a timed-out click; the second async delivery must be
    // silent, not post a confusing "already active" message.
    assert.equal(
      activeGrantDecision({
        active: { state: "active", requestId: "req-1" },
        requestId: "req-1",
      }),
      "own-retry",
    );
  });

  it("blocks a different request while a grant is active", () => {
    assert.equal(
      activeGrantDecision({
        active: { state: "active", requestId: "req-other" },
        requestId: "req-1",
      }),
      "other-active",
    );
  });

  it("proceeds when the lock was released", () => {
    assert.equal(
      activeGrantDecision({
        active: { state: "released", requestId: "req-other" },
        requestId: "req-1",
      }),
      "proceed",
    );
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
    const applied = await store.setGrantState({
      requestId: "req-1",
      state: "granted",
      membershipId: "m-1",
    });
    assert.equal(applied, true);
    assert.match(String(captured?.input?.UpdateExpression), /membershipId/);
    assert.equal(
      captured?.input?.ExpressionAttributeValues?.[":membershipId"],
      "m-1",
    );
  });

  it("conditions the grant transition on the state the plan saw", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    await store.setGrantState({
      requestId: "req-1",
      state: "failed",
      fromState: "granting",
    });
    assert.equal(
      captured?.input?.ConditionExpression,
      "#state IN (:from0)",
    );
    assert.equal(captured?.input?.ExpressionAttributeValues?.[":from0"], "granting");
  });

  it("reports a skipped grant transition when the state moved", async () => {
    const store = fakeStore(async () => {
      throw new ConditionalCheckFailedException({
        message: "conditional",
        $metadata: {},
      });
    });
    assert.equal(
      await store.setGrantState({
        requestId: "req-1",
        state: "failed",
        fromState: "granting",
      }),
      false,
    );
  });

  it("conditions the request transition too", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    const applied = await store.setRequestState("req-1", "revoked", [
      "granting",
      "granted",
    ]);
    assert.equal(applied, true);
    assert.equal(
      captured?.input?.ConditionExpression,
      "#state IN (:from0, :from1)",
    );
  });
});

const fakeScheduler = (send: (command: any) => Promise<unknown>) =>
  createScheduler({ send } as unknown as SchedulerClient);

describe("expiry schedule client", () => {
  it("creates a one-shot at the grant's expiry with retries and a DLQ", async () => {
    const commands: Array<{ constructor: { name: string }; input: any }> = [];
    const scheduler = fakeScheduler(async (command) => {
      commands.push(command as never);
      if (command.constructor.name === "GetScheduleCommand") {
        throw new SchedulerResourceNotFoundException({
          message: "missing",
          Message: "missing",
          $metadata: {},
        });
      }
      return {};
    });
    const name = await scheduler.createExpirySchedule(
      grant({
        scheduleName: "sheriff-req-1",
        expiresAt: "2026-10-13T21:00:00.000Z",
      }),
    );
    assert.equal(name, "sheriff-req-1");
    const create = commands.find((c) => c.constructor.name === "CreateScheduleCommand");
    assert.ok(create);
    assert.equal(create.input.Name, "sheriff-req-1");
    assert.equal(create.input.GroupName, "sheriff");
    assert.equal(create.input.ScheduleExpression, "at(2026-10-13T21:00:00)");
    assert.equal(create.input.ScheduleExpressionTimezone, "UTC");
    assert.equal(create.input.FlexibleTimeWindow.Mode, "OFF");
    assert.equal(create.input.ActionAfterCompletion, "DELETE");
    assert.equal(create.input.Target.Arn, SHERIFF_FUNCTION_ARN);
    assert.equal(create.input.Target.RoleArn, SHERIFF_SCHEDULER_ROLE_ARN);
    assert.deepEqual(JSON.parse(create.input.Target.Input), {
      action: "revoke",
      requestId: "req-1",
    });
    assert.deepEqual(create.input.Target.RetryPolicy, {
      MaximumEventAgeInSeconds: SCHEDULE_MAX_EVENT_AGE_SECONDS,
      MaximumRetryAttempts: SCHEDULE_MAX_RETRY_ATTEMPTS,
    });
    assert.deepEqual(create.input.Target.DeadLetterConfig, {
      Arn: SHERIFF_SCHEDULER_DLQ_ARN,
    });
  });

  it("does not create a schedule that already exists", async () => {
    const commands: string[] = [];
    const scheduler = fakeScheduler(async (command) => {
      commands.push(command.constructor.name);
      return {};
    });
    await scheduler.createExpirySchedule(
      grant({ scheduleName: "sheriff-req-1" }),
    );
    assert.deepEqual(commands, ["GetScheduleCommand"]);
  });

  it("tolerates a concurrent create that won the race", async () => {
    const scheduler = fakeScheduler(async (command) => {
      if (command.constructor.name === "GetScheduleCommand") {
        throw new SchedulerResourceNotFoundException({
          message: "missing",
          Message: "missing",
          $metadata: {},
        });
      }
      throw new SchedulerConflictException({
        message: "exists",
        Message: "exists",
        $metadata: {},
      });
    });
    const name = await scheduler.createExpirySchedule(
      grant({ scheduleName: "sheriff-req-1" }),
    );
    assert.equal(name, "sheriff-req-1");
  });

  it("deletes the schedule and treats already-gone as success", async () => {
    let deleted = false;
    const scheduler = fakeScheduler(async (command) => {
      if (command.constructor.name === "DeleteScheduleCommand") {
        deleted = true;
        throw new SchedulerResourceNotFoundException({
          message: "missing",
          Message: "missing",
          $metadata: {},
        });
      }
      return {};
    });
    await scheduler.deleteExpirySchedule(
      grant({ scheduleName: "sheriff-req-1" }),
    );
    assert.equal(deleted, true);
  });
});

describe("revoke store", () => {
  it("reads a grant by request id", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return { Item: { pk: "GRANT", sk: grantSk("req-1"), ...grant() } };
    });
    const result = await store.getGrant("req-1");
    assert.equal(captured?.input?.Key.pk, "GRANT");
    assert.equal(captured?.input?.Key.sk, grantSk("req-1"));
    assert.equal(result?.requestId, "req-1");
  });

  it("claims the revoke post with a conditional write on the grant item", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    assert.equal(await store.claimRevokePost("req-1"), true);
    assert.equal(captured?.input?.Key.pk, "GRANT");
    assert.match(
      String(captured?.input?.ConditionExpression),
      /attribute_not_exists/,
    );
  });

  it("reports a duplicate revoke post as already claimed", async () => {
    const store = fakeStore(async () => {
      throw new ConditionalCheckFailedException({
        message: "conditional",
        $metadata: {},
      });
    });
    assert.equal(await store.claimRevokePost("req-1"), false);
  });

  it("clears the revoke post claim after a failed post", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    await store.releaseRevokePost("req-1");
    assert.match(String(captured?.input?.UpdateExpression), /REMOVE/);
  });
});

describe("revokeGrant", () => {
  it("releases the lock and deletes the schedule even when the transition was a no-op", async () => {
    const calls: string[] = [];
    const store = {
      setGrantState: async () => false,
      setRequestState: async () => true,
      releaseActiveGrant: async (id: string) => calls.push(`release:${id}`),
    };
    const applied = await revokeGrant({
      client: {} as never,
      grant: grant({
        state: "granted",
        membershipId: "m-1",
        scheduleName: "sheriff-req-1",
      }),
      membershipId: "m-1",
      deps: {
        store: store as never,
        deleteAdminsMembership: async () => true,
        deleteExpirySchedule: async () => {
          calls.push("deleteSchedule");
        },
      },
    });
    assert.equal(applied, false);
    assert.ok(calls.includes("release:user-1"));
    assert.ok(calls.includes("deleteSchedule"));
  });

  it("does not release the lock or delete the schedule when the membership delete fails", async () => {
    const calls: string[] = [];
    const store = {
      setGrantState: async () => {
        calls.push("setGrantState");
        return true;
      },
      setRequestState: async () => true,
      releaseActiveGrant: async (id: string) => calls.push(`release:${id}`),
    };
    await assert.rejects(() =>
      revokeGrant({
        client: {} as never,
        grant: grant({ state: "granted", membershipId: "m-1" }),
        membershipId: "m-1",
        deps: {
          store: store as never,
          deleteAdminsMembership: async () => {
            throw new Error("access denied");
          },
          deleteExpirySchedule: async () => {
            calls.push("deleteSchedule");
          },
        },
      }),
    );
    assert.deepEqual(calls, []);
  });
});

const revokeDeps = (args: {
  grant: GrantRecord | null;
  request?: RequestRecord | null;
  resolve?: (client: unknown, userId: string) => Promise<string | null>;
  deleteMembership?: (client: unknown, id: string) => Promise<boolean>;
  claim?: () => Promise<boolean>;
  calls?: string[];
}) => {
  const calls = args.calls ?? [];
  const store = {
    getGrant: async () => args.grant,
    getRequest: async () => args.request ?? null,
    claimRevokePost: async () => {
      calls.push("claimRevokePost");
      return args.claim ? await args.claim() : true;
    },
    releaseRevokePost: async () => calls.push("releaseRevokePost"),
    setGrantState: async (stateArgs: { state: string }) => {
      calls.push(`setGrantState:${stateArgs.state}`);
      return true;
    },
    setRequestState: async (_id: string, state: string) => {
      calls.push(`setRequestState:${state}`);
      return true;
    },
    releaseActiveGrant: async (id: string) => {
      calls.push(`releaseActiveGrant:${id}`);
    },
  };
  return {
    store: store as never,
    assumeGrantRole: (async () => ({})) as never,
    resolveAdminsMembershipId: (args.resolve ??
      (async () => null)) as never,
    deleteAdminsMembership: (args.deleteMembership ??
      (async () => true)) as never,
    deleteExpirySchedule: (async () => {
      calls.push("deleteExpirySchedule");
    }) as never,
    calls,
  };
};

const fakeSlack = (posts: unknown[]) =>
  ({
    chat: {
      postMessage: async (message: unknown) => {
        posts.push(message);
        return { ok: true };
      },
    },
  }) as never;

describe("handleRevoke", () => {
  const activeGrant = () =>
    grant({
      state: "granted",
      membershipId: "m-1",
      scheduleName: "sheriff-req-1",
    });

  it("revokes, deletes the schedule and posts once", async () => {
    const posts: unknown[] = [];
    const calls: string[] = [];
    const deps = revokeDeps({ grant: activeGrant(), request: record(), calls });
    await handleRevoke(
      { action: "revoke", requestId: "req-1" } as never,
      fakeSlack(posts),
      deps,
    );
    assert.ok(calls.includes("setGrantState:revoked"));
    assert.ok(calls.includes("claimRevokePost"));
    assert.ok(calls.includes("deleteExpirySchedule"));
    assert.equal(posts.length, 1);
    assert.match(JSON.stringify(posts[0]), /revoked/);
  });

  it("does not revoke or post again when the grant is already revoked and notified", async () => {
    const posts: unknown[] = [];
    const calls: string[] = [];
    const deps = revokeDeps({
      grant: grant({ state: "revoked", membershipId: "m-1" }),
      request: record(),
      claim: async () => false,
      calls,
    });
    await handleRevoke(
      { action: "revoke", requestId: "req-1" } as never,
      fakeSlack(posts),
      deps,
    );
    assert.ok(!calls.includes("setGrantState:revoked"));
    assert.equal(posts.length, 0);
  });

  it("posts on a retry after a failed post, when the grant is already revoked", async () => {
    const posts: unknown[] = [];
    const calls: string[] = [];
    const deps = revokeDeps({
      grant: grant({ state: "revoked", membershipId: "m-1" }),
      request: record(),
      calls,
    });
    await handleRevoke(
      { action: "revoke", requestId: "req-1" } as never,
      fakeSlack(posts),
      deps,
    );
    assert.equal(posts.length, 1);
    assert.ok(calls.includes("claimRevokePost"));
  });

  it("resolves the membership for a granting record before revoking", async () => {
    const posts: unknown[] = [];
    const calls: string[] = [];
    let deleted: string | undefined;
    const deps = revokeDeps({
      grant: grant({
        state: "granting",
        membershipId: undefined,
        scheduleName: "sheriff-req-1",
      }),
      request: record(),
      resolve: async () => "m-resolved",
      deleteMembership: async (_client, id) => {
        deleted = id;
        return true;
      },
      calls,
    });
    await handleRevoke(
      { action: "revoke", requestId: "req-1" } as never,
      fakeSlack(posts),
      deps,
    );
    assert.equal(deleted, "m-resolved");
    assert.ok(calls.includes("setGrantState:revoked"));
  });

  it("fails a granting record with no membership and drops the schedule", async () => {
    const posts: unknown[] = [];
    const calls: string[] = [];
    const deps = revokeDeps({
      grant: grant({ state: "granting", membershipId: undefined }),
      request: record(),
      resolve: async () => null,
      calls,
    });
    await handleRevoke(
      { action: "revoke", requestId: "req-1" } as never,
      fakeSlack(posts),
      deps,
    );
    assert.ok(calls.includes("setGrantState:failed"));
    assert.ok(calls.includes("releaseActiveGrant:user-1"));
    assert.ok(calls.includes("deleteExpirySchedule"));
    assert.equal(posts.length, 0);
  });

  it("rethrows a failed revoke so the schedule retries and dead-letters", async () => {
    const posts: unknown[] = [];
    const deps = revokeDeps({
      grant: activeGrant(),
      request: record(),
      deleteMembership: async () => {
        throw new Error("access denied");
      },
    });
    await assert.rejects(() =>
      handleRevoke(
        { action: "revoke", requestId: "req-1" } as never,
        fakeSlack(posts),
        deps,
      ),
    );
    assert.equal(posts.length, 0);
  });
});

describe("approval post claim", () => {
  it("claims the post only once", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    assert.equal(await store.claimRequestPost("req-1"), true);
    assert.match(
      String(captured?.input?.ConditionExpression),
      /attribute_not_exists/,
    );
  });

  it("reports a duplicate delivery as already claimed", async () => {
    const store = fakeStore(async () => {
      throw new ConditionalCheckFailedException({
        message: "conditional",
        $metadata: {},
      });
    });
    assert.equal(await store.claimRequestPost("req-1"), false);
  });

  it("clears the claim after a failed post so a retry can post", async () => {
    let captured: { input?: any } | undefined;
    const store = fakeStore(async (command) => {
      captured = command as { input?: any };
      return {};
    });
    await store.releaseRequestPost("req-1");
    assert.match(String(captured?.input?.UpdateExpression), /REMOVE/);
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

  it("recovers from ConflictException via the member listing", async () => {
    // CreateGroupMembership conflicts, then the member listing resolves the
    // existing Admins membership in one call.
    const responses = [
      () => {
        throw new ConflictException({ message: "exists", $metadata: {} });
      },
      () => ({
        GroupMemberships: [
          { GroupId: ADMINS_GROUP_ID, MembershipId: "m-admins" },
        ],
      }),
    ];
    let call = 0;
    const client = { send: async () => responses[call++]() } as any;
    assert.equal(await createAdminsMembership(client, "user-1"), "m-admins");
    assert.equal(call, 2);
  });

  it("falls back to the group listing when the member listing lags", async () => {
    const responses = [
      () => {
        throw new ConflictException({ message: "exists", $metadata: {} });
      },
      () => ({ GroupMemberships: [] }),
      () => ({
        GroupMemberships: [
          {
            GroupId: ADMINS_GROUP_ID,
            MemberId: { UserId: "user-1" },
            MembershipId: "m-from-group",
          },
        ],
      }),
    ];
    let call = 0;
    const client = { send: async () => responses[call++]() } as any;
    assert.equal(
      await createAdminsMembership(client, "user-1"),
      "m-from-group",
    );
    assert.equal(call, 3);
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

describe("revoke post", () => {
  it("names the requester and request and repeats the session caveat", () => {
    const revoked = grant({ state: "revoked", membershipId: "m-1" });
    const blocks = buildRevokedBlocks(revoked, "2026-10-13T01:00:00.000Z");
    const serialized = JSON.stringify(blocks);
    assert.match(serialized, /revoked/);
    assert.match(serialized, /UREQUESTER/);
    assert.match(serialized, /req-1/);
    assert.match(serialized, /already open/);
    const text = buildRevokeOutcomeText(revoked, "2026-10-13T01:00:00.000Z");
    assert.match(text, /AdministratorAccess/);
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
