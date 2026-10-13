/**
 * The break-glass Lambda, step 4 ("approval wired to a real grant") of
 * `docs/sheriff.md`.
 *
 * A separate Slack app and a separate function from the delegate webhook. The
 * plan is explicit about why: every delegate worker holds `DELEGATES` while
 * processing untrusted text, and function-URL auth is signature-only, so that
 * secret is enough to forge an approval. This function reads its own secret,
 * `sheriff`, and nothing else. It follows the signing and secret-reading
 * code *patterns* from `delegate/lambdas/verify.ts` and
 * `delegate/lambdas/secrets.ts` in local modules (`verify.ts`, `secrets.ts`)
 * rather than importing them, so the bundle has no dependency on the delegate
 * code or its deploy path.
 *
 * Routes, both on the one Function URL:
 *
 *   POST /breakglass     the slash command; opens the modal.
 *   POST /interactivity  `view_submission` (resolve the requester, gate on
 *                        `Engineers`, write the request, post to the channel)
 *                        and `block_actions` (Approve/Deny).
 *
 * The same function is invoked by the sweeper's EventBridge rule with a
 * `{ action: "sweep" }` event; that path assumes `sheriff-grant`, reconciles the
 * group against the tool's grant records, and returns. It does not read Slack
 * secrets and does not verify a Slack signature, because it is not a Slack
 * request.
 */
import { WebClient } from "@slack/web-api";
import type { Block, KnownBlock } from "@slack/types";

import { getSecrets } from "./secrets";
import { verifySlackWebhook } from "./verify";
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  buildApprovalBlocks,
  buildDecidedBlocks,
  buildDecisionOutcomeText,
  buildRequestModal,
} from "./blocks";
import {
  ADMINS_GROUP_ID,
  DEFAULT_APPROVAL_CHANNEL,
  MAX_REQUESTS_PER_DAY,
  RATE_TTL_SECONDS,
  REQUEST_TTL_SECONDS,
} from "./config";
import {
  assumeGrantRole,
  createAdminsMembership,
  deleteAdminsMembership,
  isEngineersMember,
  listAdminsMemberships,
  lookupIdentityStoreUserId,
} from "./identity";
import {
  decodeSlackPayload,
  durationSecondsFor,
  eligibilityErrorMessage,
  evaluateDecision,
  evaluateEligibility,
  grantExpiresAt,
  isHttpUrl,
  newRequestId,
  rateLimitExceeded,
  reconcileSweep,
  utcDate,
  type Decision,
  type GrantRecord,
  type RequestRecord,
} from "./policy";
import {
  beginActiveGrant,
  decideRequest,
  getRequest,
  incrementRateCount,
  listGrants,
  putGrant,
  putRequest,
  releaseActiveGrant,
  setGrantState,
  setRequestMessageRef,
  setRequestState,
} from "./store";

type FunctionUrlEvent = {
  rawPath: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
};

/** The EventBridge sweep invocation shares the function but not the shape. */
type SheriffEvent = FunctionUrlEvent & { action?: string };

type LambdaResponse = {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
};

// Slack's Web API types are stricter than the plain Block Kit objects the
// builders return. The builders are tested for shape; the casts are the
// boundary.
type MessageBlocks = (Block | KnownBlock)[];
type ModalView = Parameters<WebClient["views"]["open"]>[0]["view"];

const OK: LambdaResponse = { statusCode: 200, body: "ok" };
const UNAUTHORIZED: LambdaResponse = { statusCode: 401, body: "unauthorized" };

const json = (body: unknown): LambdaResponse => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const lowerCaseHeaders = (
  headers: Record<string, string> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );

/** The application audit line, one per transition. */
const audit = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ audit: event, ...fields }));
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringField = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * The modal's submitted values, in the shape `view.state.values` uses:
 * `block_id -> action_id -> element`. Returns the three fields or an error
 * keyed by block id for Slack's `response_action: "errors"`.
 */
export const readSubmittedValues = (
  payload: Record<string, unknown>,
): {
  values?: {
    durationValue: string | undefined;
    reason: string | undefined;
    ticket: string | undefined;
  };
  errors?: Record<string, string>;
} => {
  const view = asRecord(payload.view);
  const values = asRecord(asRecord(view.state).values);

  const durationElement = asRecord(
    asRecord(values.duration_block).duration,
  );
  const durationValue = stringField(
    asRecord(durationElement.selected_option),
    "value",
  );
  const reason = stringField(
    asRecord(asRecord(values.reason_block).reason),
    "value",
  )?.trim();
  const ticket = stringField(
    asRecord(asRecord(values.ticket_block).ticket),
    "value",
  )?.trim();

  const errors: Record<string, string> = {};
  if (!durationValue || durationSecondsFor(durationValue) === null) {
    errors.duration_block = "Choose a duration between 1 and 4 hours.";
  }
  if (!reason) errors.reason_block = "A reason is required.";
  if (!ticket || !isHttpUrl(ticket)) {
    errors.ticket_block = "An incident or ticket link (http/https) is required.";
  }
  if (Object.keys(errors).length > 0) return { errors };

  return { values: { durationValue, reason, ticket } };
};

const handleSlashCommand = async (
  body: string,
  slack: WebClient,
): Promise<LambdaResponse> => {
  const params = new URLSearchParams(body);
  const triggerId = params.get("trigger_id");
  if (!triggerId) return OK;

  await slack.views.open({
    trigger_id: triggerId,
    view: buildRequestModal() as unknown as ModalView,
  });
  return OK;
};

/** A `view_submission` error, keyed to `reason_block` (the modal's only block). */
const submissionError = (message: string): LambdaResponse =>
  json({ response_action: "errors", errors: { reason_block: message } });

const handleViewSubmission = async (
  payload: Record<string, unknown>,
  slack: WebClient,
): Promise<LambdaResponse> => {
  const user = asRecord(payload.user);
  const requesterSlackId = stringField(user, "id");
  if (!requesterSlackId) {
    return submissionError("Could not identify the requesting Slack user.");
  }

  const parsed = readSubmittedValues(payload);
  if (parsed.errors) {
    return json({ response_action: "errors", errors: parsed.errors });
  }
  const { durationValue, reason, ticket } = parsed.values!;
  const durationSeconds = durationSecondsFor(durationValue);
  if (durationSeconds === null) {
    return json({
      response_action: "errors",
      errors: { duration_block: "Choose a duration between 1 and 4 hours." },
    });
  }

  // Step 4's request-time gate: the requester's Slack email resolves to an
  // Identity Store user, and that user must be in `Engineers`. Each miss gets
  // its own actionable message. The Identity Store calls go through the
  // `sheriff-grant` role; the Lambda's own role holds no `identitystore`
  // action.
  let slackEmail: string | undefined;
  try {
    const info = await slack.users.info({ user: requesterSlackId });
    slackEmail = info.user?.profile?.email ?? undefined;
  } catch (err) {
    console.error("users.info failed", err);
  }

  let identityStoreUserId: string | undefined;
  let engineersMember: boolean | undefined;
  if (slackEmail) {
    const client = await assumeGrantRole();
    identityStoreUserId =
      (await lookupIdentityStoreUserId(client, slackEmail)) ?? undefined;
    if (identityStoreUserId) {
      engineersMember = await isEngineersMember(client, identityStoreUserId);
    }
  }

  const eligibility = evaluateEligibility({
    slackEmail,
    identityStoreUserId,
    isEngineersMember: engineersMember,
  });
  if (!eligibility.ok) {
    return submissionError(
      eligibilityErrorMessage(eligibility.failure, eligibility.email),
    );
  }

  const today = utcDate();
  const count = await incrementRateCount(
    requesterSlackId,
    today,
    RATE_TTL_SECONDS,
  );
  if (rateLimitExceeded(count)) {
    return submissionError(
      `Rate limit reached: at most ${MAX_REQUESTS_PER_DAY} break-glass requests per user per day.`,
    );
  }

  const request: RequestRecord = {
    id: newRequestId(),
    state: "requested",
    requesterSlackId,
    requesterIdentityStoreId: eligibility.identityStoreUserId,
    requesterEmail: eligibility.email,
    reason: reason!,
    ticket: ticket!,
    durationValue: durationValue!,
    durationSeconds,
    createdAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + REQUEST_TTL_SECONDS,
  };

  // Record first, then post: the request id is never visible on a button
  // without a record behind it.
  await putRequest(request);

  const channel = process.env.APPROVAL_CHANNEL ?? DEFAULT_APPROVAL_CHANNEL;
  const post = await slack.chat.postMessage({
    channel,
    text: `Break-glass request from <@${requesterSlackId}> (${request.durationValue})`,
    blocks: buildApprovalBlocks(request) as unknown as MessageBlocks,
  });
  if (post.ts) await setRequestMessageRef(request.id, channel, post.ts);

  audit("request.created", {
    requestId: request.id,
    requester: requesterSlackId,
    requesterEmail: request.requesterEmail,
    identityStoreUserId: request.requesterIdentityStoreId,
    durationSeconds,
    reason: request.reason,
    ticket: request.ticket,
    createdAt: request.createdAt,
  });

  return json({ response_action: "clear" });
};

/** Replaces the original post's buttons with the decided copy. */
const updateDecidedMessage = async (
  slack: WebClient,
  args: {
    channel: string;
    messageTs: string | undefined;
    request: RequestRecord;
    decision: Decision;
    decidedBy: string;
    grant?: GrantRecord;
  },
): Promise<void> => {
  if (!args.messageTs) return;
  await slack.chat.update({
    channel: args.channel,
    ts: args.messageTs,
    text: `Break-glass request ${args.decision}`,
    blocks: buildDecidedBlocks(
      args.request,
      args.decision,
      args.decidedBy,
      args.grant,
    ) as unknown as MessageBlocks,
  });
};

/**
 * The real grant path. The caller has already passed `evaluateDecision`.
 *
 * Order is load-bearing: the at-most-one active-grant lock is claimed first,
 * then the request is moved to `granting`, then the grant record is written in
 * `granting`, and only then is `CreateGroupMembership` called. The record
 * exists before the membership can, so a crash between the two is reconciled by
 * the sweeper rather than stranding an unrecorded membership.
 */
const handleApprove = async (
  args: {
    request: RequestRecord;
    requestId: string;
    approverSlackId: string;
    channel: string;
    messageTs: string | undefined;
  },
  slack: WebClient,
): Promise<LambdaResponse> => {
  const { request, requestId, approverSlackId, channel, messageTs } = args;
  const ephemeral = (text: string) =>
    slack.chat.postEphemeral({ channel, user: approverSlackId, text });

  // Race-safe at-most-one-active-grant guard. A read-then-write would let two
  // concurrent approvals both pass; this is a conditional write, so it cannot.
  const claimed = await beginActiveGrant(
    request.requesterIdentityStoreId,
    requestId,
  );
  if (!claimed) {
    await ephemeral(
      "A grant for this user is already active. Revoke it or wait for it to expire before approving another request.",
    );
    return OK;
  }

  const decidedAt = new Date().toISOString();
  const decided = await decideRequest({
    id: requestId,
    decision: "approved",
    approverSlackId,
    decidedAt,
  });
  if (!decided) {
    await releaseActiveGrant(request.requesterIdentityStoreId);
    await ephemeral("That request was already decided.");
    return OK;
  }

  audit("request.approved", {
    requestId,
    requester: request.requesterSlackId,
    requesterEmail: request.requesterEmail,
    approver: approverSlackId,
    group: ADMINS_GROUP_ID,
    reason: request.reason,
    ticket: request.ticket,
    durationSeconds: request.durationSeconds,
    decidedAt,
  });

  const grantedAt = new Date().toISOString();
  const grant: GrantRecord = {
    requestId,
    state: "granting",
    requesterSlackId: request.requesterSlackId,
    requesterIdentityStoreId: request.requesterIdentityStoreId,
    requesterEmail: request.requesterEmail,
    approverSlackId,
    groupId: ADMINS_GROUP_ID,
    reason: request.reason,
    ticket: request.ticket,
    durationSeconds: request.durationSeconds,
    grantedAt,
    expiresAt: grantExpiresAt(grantedAt, request.durationSeconds),
    ttl: Math.floor(Date.now() / 1000) + REQUEST_TTL_SECONDS,
  };
  await putGrant(grant);

  let membershipId: string;
  try {
    const client = await assumeGrantRole();
    membershipId = await createAdminsMembership(
      client,
      request.requesterIdentityStoreId,
    );
  } catch (err) {
    console.error("break-glass grant failed", err);
    const failedGrant: GrantRecord = { ...grant, state: "failed" };
    await setGrantState({ requestId, state: "failed" });
    await setRequestState(requestId, "failed");
    await releaseActiveGrant(request.requesterIdentityStoreId);
    await updateDecidedMessage(slack, {
      channel,
      messageTs,
      request,
      decision: "approved",
      decidedBy: approverSlackId,
      grant: failedGrant,
    });
    await slack.chat.postMessage({
      channel,
      ...(messageTs ? { thread_ts: messageTs } : {}),
      text: buildDecisionOutcomeText(
        request,
        "approved",
        approverSlackId,
        failedGrant,
      ),
    });
    audit("grant.failed", {
      requestId,
      requester: request.requesterSlackId,
      requesterEmail: request.requesterEmail,
      approver: approverSlackId,
      group: ADMINS_GROUP_ID,
      reason: request.reason,
      ticket: request.ticket,
      grantedAt,
      expiresAt: grant.expiresAt,
    });
    return OK;
  }

  const grantedGrant: GrantRecord = {
    ...grant,
    state: "granted",
    membershipId,
  };
  await setGrantState({ requestId, state: "granted", membershipId });
  await setRequestState(requestId, "granted");
  await updateDecidedMessage(slack, {
    channel,
    messageTs,
    request,
    decision: "approved",
    decidedBy: approverSlackId,
    grant: grantedGrant,
  });
  await slack.chat.postMessage({
    channel,
    ...(messageTs ? { thread_ts: messageTs } : {}),
    text: buildDecisionOutcomeText(
      request,
      "approved",
      approverSlackId,
      grantedGrant,
    ),
  });

  // Informational, not paging: the durable record of the grant. The loud alarm
  // is on `membership.orphaned`.
  audit("grant.created", {
    requestId,
    requester: request.requesterSlackId,
    requesterEmail: request.requesterEmail,
    approver: approverSlackId,
    group: ADMINS_GROUP_ID,
    membershipId,
    reason: request.reason,
    ticket: request.ticket,
    grantedAt,
    expiresAt: grant.expiresAt,
  });

  return OK;
};

const handleBlockActions = async (
  payload: Record<string, unknown>,
  slack: WebClient,
): Promise<LambdaResponse> => {
  const action = asRecord((payload.actions as unknown[] | undefined)?.[0]);
  const actionId = stringField(action, "action_id");
  const requestId = stringField(action, "value");
  const clickerSlackId = stringField(asRecord(payload.user), "id");
  const channel = stringField(asRecord(payload.channel), "id");
  const messageTs = stringField(asRecord(payload.message), "ts");

  if (!requestId || !clickerSlackId || !channel) return OK;

  const ephemeral = (text: string) =>
    slack.chat.postEphemeral({ channel, user: clickerSlackId, text });

  const request = await getRequest(requestId);
  if (!request) {
    await ephemeral("That break-glass request no longer exists.");
    return OK;
  }

  const check = evaluateDecision({ request, clickerSlackId });
  if (!check.ok) {
    await ephemeral(check.reason);
    return OK;
  }

  // No rate-limit re-check here. The per-user cap is enforced at submission
  // (`incrementRateCount` + `rateLimitExceeded` in `handleViewSubmission`),
  // which is the only point that can accept a request, so every `requested`
  // record already sits at or under the cap. Re-reading the live counter here
  // would be a false positive: the counter deliberately keeps counting past
  // the cap so a burst is visible, and a single rejected over-cap submission
  // would otherwise block approval of every valid request the user queued that
  // day. The decision-time guard is the at-most-one-active-grant rule.

  const decision: Decision | null =
    actionId === APPROVE_ACTION_ID
      ? "approved"
      : actionId === DENY_ACTION_ID
        ? "denied"
        : null;
  if (!decision) return OK;

  if (decision === "approved") {
    return handleApprove(
      { request, requestId, approverSlackId: clickerSlackId, channel, messageTs },
      slack,
    );
  }

  const decidedAt = new Date().toISOString();
  const decided = await decideRequest({
    id: requestId,
    decision: "denied",
    approverSlackId: clickerSlackId,
    decidedAt,
  });
  if (!decided) {
    await ephemeral("That request was already decided.");
    return OK;
  }

  const decidedRequest: RequestRecord = {
    ...request,
    state: "denied",
    approverSlackId: clickerSlackId,
    decidedAt,
  };
  await updateDecidedMessage(slack, {
    channel,
    messageTs,
    request: decidedRequest,
    decision: "denied",
    decidedBy: clickerSlackId,
  });
  await slack.chat.postMessage({
    channel,
    ...(messageTs ? { thread_ts: messageTs } : {}),
    text: buildDecisionOutcomeText(decidedRequest, "denied", clickerSlackId),
  });

  audit("request.denied", {
    requestId,
    requester: request.requesterSlackId,
    requesterEmail: request.requesterEmail,
    approver: clickerSlackId,
    reason: request.reason,
    ticket: request.ticket,
    decidedAt,
  });

  return OK;
};

const handleInteractivity = async (
  body: string,
  slack: WebClient,
): Promise<LambdaResponse> => {
  const payload = decodeSlackPayload(body);
  if (!payload) return OK;

  switch (stringField(payload, "type")) {
    case "view_submission":
      return handleViewSubmission(payload, slack);
    case "block_actions":
      return handleBlockActions(payload, slack);
    default:
      return OK;
  }
};

/**
 * The reconciliation sweeper, invoked by the EventBridge rule with
 * `{ action: "sweep" }`.
 *
 * Step 4 has no one-shot scheduler (that is step 5), so this is the revoke
 * path: every expired grant is revoked here. It scans `Admins` and the tool's
 * grant records, and:
 *
 * - a `granting` record with no member is `failed`, no alarm;
 * - a `granting` record with a member gets its `membershipId` backfilled and is
 *   flipped to `granted` (and revoked if already expired);
 * - an expired `granted` record is revoked and marked `revoked`;
 * - a member with no active grant record is left alone and logged
 *   `membership.unmanaged` informationally, because that is the only shape a
 *   pre-existing standing member can take;
 * - only a revoke that fails for an expired grant is `membership.orphaned` and
 *   pages.
 */
export const handleSweep = async (): Promise<LambdaResponse> => {
  const client = await assumeGrantRole();
  const [memberships, grants] = await Promise.all([
    listAdminsMemberships(client),
    listGrants(),
  ]);

  const plan = reconcileSweep({
    now: Date.now(),
    grants,
    memberships,
  });

  for (const grant of plan.failed) {
    await setGrantState({ requestId: grant.requestId, state: "failed" });
    await setRequestState(grant.requestId, "failed");
    await releaseActiveGrant(grant.requesterIdentityStoreId);
    audit("grant.failed", {
      requestId: grant.requestId,
      requester: grant.requesterSlackId,
      requesterEmail: grant.requesterEmail,
      approver: grant.approverSlackId,
      group: grant.groupId,
      reason: grant.reason,
      ticket: grant.ticket,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
      source: "sweep",
    });
  }

  for (const { grant, membershipId } of plan.granted) {
    await setGrantState({
      requestId: grant.requestId,
      state: "granted",
      membershipId,
    });
    await setRequestState(grant.requestId, "granted");
    audit("grant.created", {
      requestId: grant.requestId,
      requester: grant.requesterSlackId,
      requesterEmail: grant.requesterEmail,
      approver: grant.approverSlackId,
      group: grant.groupId,
      membershipId,
      reason: grant.reason,
      ticket: grant.ticket,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
      recovered: true,
      source: "sweep",
    });
  }

  for (const { grant, membershipId } of plan.revoke) {
    try {
      await deleteAdminsMembership(client, membershipId);
      await setGrantState({
        requestId: grant.requestId,
        state: "revoked",
        membershipId,
      });
      await setRequestState(grant.requestId, "revoked");
      await releaseActiveGrant(grant.requesterIdentityStoreId);
      audit("grant.revoked", {
        requestId: grant.requestId,
        requester: grant.requesterSlackId,
        requesterEmail: grant.requesterEmail,
        approver: grant.approverSlackId,
        group: grant.groupId,
        membershipId,
        reason: grant.reason,
        ticket: grant.ticket,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
        source: "sweep",
      });
    } catch (err) {
      // The revoke failed or the state is stuck: this is the orphan the alarm
      // exists for. A normal sweep-and-revoke never reaches here.
      console.error("break-glass revoke failed", err);
      audit("membership.orphaned", {
        requestId: grant.requestId,
        requester: grant.requesterSlackId,
        requesterEmail: grant.requesterEmail,
        approver: grant.approverSlackId,
        group: grant.groupId,
        membershipId,
        reason: grant.reason,
        ticket: grant.ticket,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
        source: "sweep",
      });
    }
  }

  for (const member of plan.unmanaged) {
    // Informational only: a pre-existing `Admins` member has no grant record,
    // and the sweeper never removes a membership it did not grant.
    audit("membership.unmanaged", {
      userId: member.userId,
      membershipId: member.membershipId,
      group: ADMINS_GROUP_ID,
      source: "sweep",
    });
  }

  return OK;
};

export const handler = async (
  event: SheriffEvent,
): Promise<LambdaResponse> => {
  // The EventBridge sweep invocation is not a Slack request: no signature, no
  // secret, no Slack client.
  if (event.action === "sweep") {
    return handleSweep();
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  const headers = lowerCaseHeaders(event.headers);

  const secrets = await getSecrets();
  const signingSecret = secrets["SLACK_SIGNING_SECRET"];
  const botToken = secrets["SLACK_BOT_TOKEN"];
  if (!signingSecret || !botToken) {
    throw new Error(
      "The sheriff secret must hold SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN",
    );
  }

  if (
    !verifySlackWebhook(
      body,
      headers["x-slack-request-timestamp"],
      headers["x-slack-signature"],
      signingSecret,
    )
  ) {
    return UNAUTHORIZED;
  }

  const slack = new WebClient(botToken);

  try {
    switch (event.rawPath) {
      case "/breakglass":
        return await handleSlashCommand(body, slack);
      case "/interactivity":
        return await handleInteractivity(body, slack);
      default:
        return {
          statusCode: 404,
          body: `Unknown path: ${event.rawPath}. Available: /breakglass, /interactivity`,
        };
    }
  } catch (err) {
    console.error("break-glass handler error", err);
    return { statusCode: 500, body: "internal error" };
  }
};
