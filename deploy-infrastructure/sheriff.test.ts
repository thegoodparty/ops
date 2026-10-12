import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  SHERIFF_ROLE_NAME,
  SHERIFF_TABLE_NAME,
  SHERIFF_SECRET_NAME,
  sheriffLambdaPolicy,
  sheriffLambdaTrust,
} from "./sheriff-lambda";
import {
  APPROVER_SLACK_USER_IDS,
  DURATION_OPTIONS,
  MAX_DURATION_SECONDS,
  MAX_REQUESTS_PER_DAY,
  SLACK_TO_IDENTITY_STORE_USER_ID,
} from "./sheriff/config";
import {
  buildApprovalBlocks,
  buildDecidedBlocks,
  buildDecisionOutcomeText,
  buildRequestModal,
} from "./sheriff/blocks";
import {
  decodeSlackPayload,
  durationSecondsFor,
  evaluateDecision,
  isApprover,
  isHttpUrl,
  rateLimitExceeded,
  ratePk,
  requestPk,
  utcDate,
  withinDurationCap,
  type RequestRecord,
} from "./sheriff/policy";
import { readSubmittedValues } from "./sheriff/handler";
import { verifySlackWebhook } from "./sheriff/verify";

const asList = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as string[]) : [String(value)];

const record = (
  overrides: Partial<RequestRecord> = {},
): RequestRecord => ({
  id: "11111111-1111-1111-1111-111111111111",
  state: "requested",
  requesterSlackId: "UREQUESTER",
  requesterIdentityStoreId: "00000000-0000-0000-0000-000000000001",
  reason: "investigating an incident",
  ticket: "https://github.com/thegoodparty/ops/issues/1",
  durationValue: "PT1H",
  durationSeconds: 3600,
  createdAt: "2026-10-12T00:00:00.000Z",
  dryRun: true,
  ...overrides,
});

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

  it("allows exactly the dry flow's actions", () => {
    assert.deepEqual([...actions].sort(), [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "secretsmanager:GetSecretValue",
    ]);
  });

  // Step 4 wires the grant. If either of these shows up early, the dry run is
  // no longer dry and the plan's ordering (definitions merge and apply before
  // the consumer) has been skipped.
  it("holds no sts:AssumeRole and no identitystore permission yet", () => {
    for (const action of actions) {
      assert.doesNotMatch(action, /^sts:/, action);
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
        assert.ok(
          resource.includes("394495727159"),
          `${statement.Sid} is not scoped to the infrastructure account`,
        );
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

  it("names the one request table", () => {
    const tableStatement = sheriffLambdaPolicy.Statement.find(
      (s) => s.Sid === "RequestTable",
    );
    assert.ok(tableStatement);
    assert.equal(
      asList(tableStatement.Resource)[0],
      `arn:aws:dynamodb:us-west-2:394495727159:table/${SHERIFF_TABLE_NAME}`,
    );
  });
});

describe("sheriff role name", () => {
  // `deploy/components/sheriff-grant.ts` trusts exactly
  // arn:aws:iam::394495727159:role/sheriff. The execution role must carry
  // that name or step 4's first AssumeRole fails as a trust problem.
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

describe("break-glass config", () => {
  it("has an approver list and a Slack -> Identity Store map", () => {
    assert.ok(APPROVER_SLACK_USER_IDS.length > 0);
    assert.ok(Object.keys(SLACK_TO_IDENTITY_STORE_USER_ID).length > 0);
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
  it("is visibly dry and binds both buttons to the request id", () => {
    const request = record();
    const blocks = buildApprovalBlocks(request);
    const serialized = JSON.stringify(blocks);
    assert.match(serialized, /Dry run \(step 3\)/);
    assert.match(serialized, /No Identity Center membership is created/);

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
  it("drops the buttons and keeps the dry-run notice on approval", () => {
    const request = record();
    const blocks = buildDecidedBlocks(request, "approved", "UAPPROVER");
    const serialized = JSON.stringify(blocks);
    assert.ok(!serialized.includes("breakglass_approve"));
    assert.match(serialized, /approved/);
    assert.match(serialized, /Dry run \(step 3\)/);

    const outcome = buildDecisionOutcomeText(
      request,
      "approved",
      "UAPPROVER",
    );
    assert.match(outcome, /Dry run: no membership was created/);
  });

  it("does not claim a dry run on a denial", () => {
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
  it("prefixes request and rate items distinctly", () => {
    assert.equal(requestPk("abc"), "REQUEST#abc");
    assert.equal(ratePk("U1", "2026-10-12"), "RATE#U1#2026-10-12");
  });

  it("buckets the rate counter by UTC day", () => {
    assert.equal(utcDate(new Date("2026-10-12T23:59:59Z")), "2026-10-12");
    assert.equal(utcDate(new Date("2026-10-13T00:00:01Z")), "2026-10-13");
  });
});
