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
 * Slack requires an HTTP 200 within three seconds for `block_actions` and
 * `view_submission`. The synchronous handlers therefore do only the fast work
 * and hand the slow work to an asynchronous self-invocation of this same
 * function (`InvocationType: "Event"`):
 *
 *   POST /breakglass     the slash command; opens the modal.
 *   POST /interactivity  `view_submission`: resolve the requester, gate on
 *                        `Engineers`, write the request, then async-post the
 *                        approval message and return `clear`.
 *                        `block_actions`: check the clicker, then async-decide.
 *
 * The async events are:
 *
 *   { action: "post-request", requestId, channel }
 *   { action: "decide", requestId, decision, approverSlackId, channel, messageTs }
 *   { action: "sweep" }   the EventBridge reconciliation rule.
 *   { action: "revoke", requestId }  the step-5 expiry one-shot's revoke event.
 *
 * The async paths are idempotent: the request moves `requested -> granting`
 * with a conditional write, and the per-requester active-grant lock is claimed
 * with a conditional write, so a Slack retry or a duplicate async delivery
 * cannot double-grant.
 */
import { WebClient } from "@slack/web-api";
import type { Block, KnownBlock } from "@slack/types";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

import { getSecrets } from "./secrets";
import { verifySlackWebhook } from "./verify";
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  buildApprovalBlocks,
  buildDecidedBlocks,
  buildDecisionOutcomeText,
  buildRequestModal,
  buildRevokedBlocks,
  buildRevokeOutcomeText,
} from "./blocks";
import {
  ADMINS_GROUP_ID,
  DEFAULT_APPROVAL_CHANNEL,
  MAX_REQUESTS_PER_DAY,
  RATE_TTL_SECONDS,
  REQUEST_TTL_SECONDS,
  SWEEP_GRANTING_GRACE_MS,
} from "./config";
import {
  REGION,
  assumeGrantRole,
  createAdminsMembership,
  deleteAdminsMembership,
  isEngineersMember,
  listAdminsMemberships,
  lookupIdentityStoreUserId,
  resolveAdminsMembershipId,
} from "./identity";
import {
  createExpirySchedule,
  deleteExpirySchedule,
} from "./scheduler";
import type { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import {
  activeGrantDecision,
  decodeSlackPayload,
  durationSecondsFor,
  eligibilityErrorMessage,
  evaluateDecision,
  evaluateEligibility,
  expiryScheduleName,
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
  claimRequestPost,
  claimRevokePost,
  decideRequest,
  getActiveGrant,
  getGrant,
  getRequest,
  incrementRateCount,
  putGrant,
  putRequest,
  releaseActiveGrant,
  releaseRequestPost,
  releaseRevokePost,
  setGrantState,
  setRequestMessageRef,
  setRequestState,
  store as defaultStore,
} from "./store";

type FunctionUrlEvent = {
  rawPath: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
};

/**
 * The async self-invocations and the EventBridge sweep share the function but
 * not the Function URL shape.
 */
type AsyncEvent = {
  action: "sweep" | "post-request" | "decide" | "revoke";
  requestId?: string;
  decision?: Decision;
  approverSlackId?: string;
  channel?: string;
  messageTs?: string;
};

type SheriffEvent = FunctionUrlEvent & Partial<AsyncEvent>;

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

const lambdaClient = new LambdaClient({ region: REGION });

/**
 * Hands the slow work to a fresh asynchronous invocation of this same function.
 *
 * Event invocations retry twice on failure, and the payload is small. The
 * function name comes from the runtime, so the same code works in any account
 * without a hardcoded name.
 */
const invokeSelf = async (payload: AsyncEvent): Promise<void> => {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) throw new Error("Missing AWS_LAMBDA_FUNCTION_NAME env var");
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
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

/** The channel post, in the async handler so the 3-second ack is not blocked. */
const postApprovalMessage = async (
  slack: WebClient,
  request: RequestRecord,
  channel: string,
): Promise<void> => {
  const post = await slack.chat.postMessage({
    channel,
    text: `Break-glass request from <@${request.requesterSlackId}> (${request.durationValue})`,
    blocks: buildApprovalBlocks(request) as unknown as MessageBlocks,
  });
  if (post.ts) await setRequestMessageRef(request.id, channel, post.ts);
};

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
  // its own actionable message, and the engineer wants this feedback inline,
  // so it stays on the synchronous path even though it is the slow part. The
  // Identity Store calls go through the `sheriff-grant` role; the Lambda's own
  // role holds no `identitystore` action.
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
  // without a record behind it. The post itself is the slow Slack call, so it
  // moves to an async invocation; a failed invocation falls back to posting
  // inline rather than losing the request.
  await putRequest(request);
  const channel = process.env.APPROVAL_CHANNEL ?? DEFAULT_APPROVAL_CHANNEL;
  try {
    await invokeSelf({
      action: "post-request",
      requestId: request.id,
      channel,
    });
  } catch (err) {
    console.error("post-request invoke failed; posting inline", err);
    // Claim the post first: if the invoke actually succeeded and only its
    // response was lost, the async path has the claim and this does not double
    // post.
    const claimed = await claimRequestPost(request.id);
    if (claimed) await postApprovalMessage(slack, request, channel);
  }

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

/**
 * The async half of a submission: the channel post and its message ref.
 *
 * At-most-once: the async invocation is at-least-once, so a conditional claim
 * stops a duplicate delivery from posting a second message with live buttons.
 * A failed post clears the claim and rethrows, so Lambda's async retry can try
 * again.
 */
const handlePostRequest = async (
  event: SheriffEvent,
  slack: WebClient,
): Promise<LambdaResponse> => {
  const requestId = event.requestId;
  if (!requestId) return OK;
  const request = await getRequest(requestId);
  if (!request) return OK;
  const claimed = await claimRequestPost(requestId);
  if (!claimed) return OK;
  const channel =
    event.channel ?? process.env.APPROVAL_CHANNEL ?? DEFAULT_APPROVAL_CHANNEL;
  try {
    await postApprovalMessage(slack, request, channel);
  } catch (err) {
    try {
      await releaseRequestPost(requestId);
    } catch (releaseErr) {
      console.error("failed to clear the post claim", releaseErr);
    }
    throw err;
  }
  return OK;
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
 * The real grant path, now asynchronous. The caller has already passed
 * `evaluateDecision` and re-checked the request state.
 *
 * Order is load-bearing: the at-most-one active-grant lock is claimed first,
 * then the request is moved to `granting`, then the grant record is written in
 * `granting`, and only then is `CreateGroupMembership` called. The record
 * exists before the membership can, so a crash between the two is reconciled by
 * the sweeper rather than stranding an unrecorded membership.
 *
 * Idempotent: a Slack retry (or a duplicate async delivery) re-reads the
 * request, sees it is no longer `requested`, and returns; if it slips through,
 * the lock's conditional claim and the request's conditional move stop it. If
 * the lock is already held by *this* request, the retry is silent rather than
 * posting a confusing "already active" message.
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
  const active = await getActiveGrant(request.requesterIdentityStoreId);
  const lock = activeGrantDecision({ active, requestId });
  if (lock === "own-retry") return OK;
  if (lock === "other-active") {
    await ephemeral(
      "A grant for this user is already active. Revoke it or wait for it to expire before approving another request.",
    );
    return OK;
  }
  const claimed = await beginActiveGrant(
    request.requesterIdentityStoreId,
    requestId,
  );
  if (!claimed) {
    const after = await getActiveGrant(request.requesterIdentityStoreId);
    if (after?.requestId === requestId) return OK;
    await ephemeral(
      "A grant for this user is already active. Revoke it or wait for it to expire before approving another request.",
    );
    return OK;
  }

  const decidedAt = new Date().toISOString();
  let decided: boolean;
  try {
    decided = await decideRequest({
      id: requestId,
      decision: "approved",
      approverSlackId,
      decidedAt,
    });
  } catch (err) {
    // The lock was claimed but the request write did not land: release it, or
    // the requester is blocked by a grant that never started.
    await releaseActiveGrant(request.requesterIdentityStoreId);
    throw err;
  }
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
    scheduleName: expiryScheduleName(requestId),
    ttl: Math.floor(Date.now() / 1000) + REQUEST_TTL_SECONDS,
  };
  try {
    await putGrant(grant);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // The record already exists: a retry whose earlier response was lost.
      // Continue; the membership call and the flips below are idempotent.
    } else {
      // The grant record never landed. Move the request back to `requested` so
      // a retry can proceed (the sweeper only reconciles grant items, so a
      // request stranded in `granting` with no grant record would be stuck),
      // then release the lock in `finally`.
      try {
        await setRequestState(requestId, "requested", "granting");
      } finally {
        await releaseActiveGrant(request.requesterIdentityStoreId);
      }
      throw err;
    }
  }

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
    // Release in `finally`: a terminal grant must not leave the at-most-one
    // lock stuck if a state write fails after the grant is failed.
    try {
      await setGrantState({
        requestId,
        state: "failed",
        fromState: "granting",
      });
      await setRequestState(requestId, "failed", "granting");
    } finally {
      await releaseActiveGrant(request.requesterIdentityStoreId);
    }
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
  await setGrantState({
    requestId,
    state: "granted",
    membershipId,
    fromState: "granting",
  });
  await setRequestState(requestId, "granted", "granting");
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

  // Step 5's one-shot revocation, created after the membership and the
  // `granted` flip so a schedule never exists for a grant that never landed.
  // A failure here does not fail the grant: the membership is real and
  // time-boxed, and the sweeper is the backstop. The sweeper's recovery path
  // recreates a missing schedule, so this is a degradation, not a loss.
  try {
    await createExpirySchedule(grantedGrant);
  } catch (err) {
    console.error("failed to create the break-glass expiry schedule", err);
  }

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

  // Ack Slack now and do the grant in a fresh invocation. The sync checks
  // above are fast; the AssumeRole, membership call and posts are not.
  try {
    await invokeSelf({
      action: "decide",
      requestId,
      decision,
      approverSlackId: clickerSlackId,
      channel,
      messageTs,
    });
  } catch (err) {
    console.error("decide invoke failed", err);
    await ephemeral(
      "Could not start the decision (the async invocation failed). Try again.",
    );
  }

  return OK;
};

/** The async half of a click: re-check, then deny or grant. */
const handleDecide = async (
  event: SheriffEvent,
  slack: WebClient,
): Promise<LambdaResponse> => {
  const { requestId, decision, approverSlackId, channel, messageTs } = event;
  if (!requestId || !decision || !approverSlackId || !channel) return OK;

  const ephemeral = (text: string) =>
    slack.chat.postEphemeral({ channel, user: approverSlackId, text });

  const request = await getRequest(requestId);
  if (!request) return OK;

  // Idempotency: a retry finds the request already moved and stops silently.
  const check = evaluateDecision({ request, clickerSlackId: approverSlackId });
  if (!check.ok) return OK;

  if (decision === "approved") {
    return handleApprove(
      { request, requestId, approverSlackId, channel, messageTs },
      slack,
    );
  }

  const decidedAt = new Date().toISOString();
  const decided = await decideRequest({
    id: requestId,
    decision: "denied",
    approverSlackId,
    decidedAt,
  });
  if (!decided) return OK;

  const decidedRequest: RequestRecord = {
    ...request,
    state: "denied",
    approverSlackId,
    decidedAt,
  };
  await updateDecidedMessage(slack, {
    channel,
    messageTs,
    request: decidedRequest,
    decision: "denied",
    decidedBy: approverSlackId,
  });
  await slack.chat.postMessage({
    channel,
    ...(messageTs ? { thread_ts: messageTs } : {}),
    text: buildDecisionOutcomeText(decidedRequest, "denied", approverSlackId),
  });

  audit("request.denied", {
    requestId,
    requester: request.requesterSlackId,
    requesterEmail: request.requesterEmail,
    approver: approverSlackId,
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
 * Step 5's one-shot scheduler is the normal revoke path; this periodic sweep
 * is the backstop for a failed schedule or a grant path that stopped partway.
 * Every expired grant is revoked here on the next pass. It scans `Admins` and
 * the tool's grant records, and:
 *
 * - a `granting` record younger than the grace window is left alone, because
 *   the async approve path may still be running;
 * - a `granting` record past the grace window with no member is `failed`, no
 *   alarm;
 * - a `granting` record with a member gets its `membershipId` backfilled and is
 *   flipped to `granted` (and revoked if already expired);
 * - an expired `granted` record is revoked and marked `revoked`;
 * - a member with no active grant record is left alone and logged
 *   `membership.unmanaged` informationally, because that is the only shape a
 *   pre-existing standing member can take;
 * - only a revoke that fails for an expired grant is `membership.orphaned` and
 *   pages.
 *
 * Every state transition is conditional on the state the plan saw, so a record
 * the approve path moved mid-sweep is not clobbered.
 */
/**
 * The idempotent revoke core shared by the sweeper and the scheduler's revoke
 * action.
 *
 * `DeleteGroupMembership` is the same call the sweeper already makes, and
 * `identity.ts` already treats `ResourceNotFoundException` as success. This
 * function deletes the membership, conditionally flips the grant and its
 * request to `revoked`, releases the at-most-one lock and deletes the expiry
 * schedule. It returns whether this call applied the terminal transition;
 * callers audit only when it did, so two revokers cannot both emit
 * `grant.revoked`.
 *
 * The membership delete is outside the `try`: if it fails, nothing is released
 * and the schedule stays, so the scheduler can retry and the sweeper can
 * alarm. Once the membership is gone, the `finally` releases the lock and
 * removes the schedule even if a state write fails, because a terminal grant
 * must not leave either stuck.
 */
export type RevokeGrantDeps = {
  store: typeof defaultStore;
  deleteAdminsMembership: typeof deleteAdminsMembership;
  deleteExpirySchedule: typeof deleteExpirySchedule;
};

export const revokeGrant = async (args: {
  client: IdentitystoreClient;
  grant: GrantRecord;
  membershipId: string;
  deps?: Partial<RevokeGrantDeps>;
}): Promise<boolean> => {
  const revokeStore = args.deps?.store ?? defaultStore;
  const deleteMembership =
    args.deps?.deleteAdminsMembership ?? deleteAdminsMembership;
  const removeSchedule =
    args.deps?.deleteExpirySchedule ?? deleteExpirySchedule;

  await deleteMembership(args.client, args.membershipId);

  let applied = false;
  try {
    applied = await revokeStore.setGrantState({
      requestId: args.grant.requestId,
      state: "revoked",
      membershipId: args.membershipId,
      fromState: ["granting", "granted", "failed"],
    });
    if (applied) {
      await revokeStore.setRequestState(
        args.grant.requestId,
        "revoked",
        ["granting", "granted", "failed"],
      );
    }
  } finally {
    await revokeStore.releaseActiveGrant(args.grant.requesterIdentityStoreId);
    await removeSchedule(args.grant);
  }
  return applied;
};

/**
 * The sweeper's collaborators, injectable so the imperative paths (the
 * `finally` lock release, the revoke-failure alarm) are testable without AWS.
 * Production calls `handleSweep()` and gets the real store and role.
 */
export type SweepDeps = {
  store: typeof defaultStore;
  assumeGrantRole: typeof assumeGrantRole;
  listAdminsMemberships: typeof listAdminsMemberships;
  deleteAdminsMembership: typeof deleteAdminsMembership;
  createExpirySchedule: typeof createExpirySchedule;
  deleteExpirySchedule: typeof deleteExpirySchedule;
};

export const handleSweep = async (
  deps?: Partial<SweepDeps>,
): Promise<LambdaResponse> => {
  const sweepStore = deps?.store ?? defaultStore;
  const assume = deps?.assumeGrantRole ?? assumeGrantRole;
  const listMemberships = deps?.listAdminsMemberships ?? listAdminsMemberships;
  const deleteMembership =
    deps?.deleteAdminsMembership ?? deleteAdminsMembership;
  const createSchedule = deps?.createExpirySchedule ?? createExpirySchedule;
  const removeSchedule = deps?.deleteExpirySchedule ?? deleteExpirySchedule;

  const client = await assume();
  const [memberships, grants] = await Promise.all([
    listMemberships(client),
    sweepStore.listGrants(),
  ]);

  const now = Date.now();
  const plan = reconcileSweep({
    now,
    grants,
    memberships,
    grantingGraceMs: SWEEP_GRANTING_GRACE_MS,
  });

  for (const grant of plan.failed) {
    const applied = await sweepStore.setGrantState({
      requestId: grant.requestId,
      state: "failed",
      fromState: "granting",
    });
    if (!applied) continue;
    // Release in `finally` so a failed request-state write cannot leave the
    // lock stuck.
    try {
      await sweepStore.setRequestState(grant.requestId, "failed", "granting");
    } finally {
      await sweepStore.releaseActiveGrant(grant.requesterIdentityStoreId);
    }
    // A `granting` record normally never has a schedule (it is created only
    // after the `granted` flip), but delete one if a future ordering change
    // leaves it, so a terminal grant never leaves a schedule behind. A
    // schedule-delete failure is logged rather than aborting the sweep.
    try {
      await removeSchedule(grant);
    } catch (err) {
      console.error(
        "failed to delete the expiry schedule for a failed grant",
        err,
      );
    }
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
    const applied = await sweepStore.setGrantState({
      requestId: grant.requestId,
      state: "granted",
      membershipId,
      fromState: "granting",
    });
    if (!applied) continue;
    await sweepStore.setRequestState(grant.requestId, "granted", "granting");
    // The approve path creates the schedule after the `granted` flip; a crash
    // between the two leaves a live grant with no schedule. Recreate it here,
    // idempotently, unless the grant is already expired (then the revoke below
    // handles it). This is what makes the sweeper recover a partial grant path
    // rather than only backstop it.
    if (Date.parse(grant.expiresAt) > now) {
      try {
        await createSchedule(grant);
      } catch (err) {
        console.error(
          "failed to create the expiry schedule during sweep",
          err,
        );
      }
    }
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
      const applied = await revokeGrant({
        client,
        grant,
        membershipId,
        deps: {
          store: sweepStore,
          deleteAdminsMembership: deleteMembership,
          deleteExpirySchedule: removeSchedule,
        },
      });
      // Only when the transition actually applied: a concurrent revoker that
      // already moved the record must not emit a second `grant.revoked`.
      if (applied) {
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
      }
    } catch (err) {
      // The revoke failed or the state is stuck: this is the orphan the alarm
      // exists for. A normal sweep-and-revoke never reaches here. The lock
      // stays claimed on purpose: the membership still exists, so a second
      // grant for this requester must stay blocked.
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

/**
 * The scheduler's revoke action, invoked by the one-shot expiry schedule with
 * `{ action: "revoke", requestId }`.
 *
 * It reuses the sweeper's idempotent path: `DeleteGroupMembership` by the
 * stored `MembershipId`, `ResourceNotFoundException` treated as success, and
 * `ListGroupMembershipsForMember` to resolve the membership of a `granting`
 * record the approve path never finished. On success it flips the grant to
 * `revoked`, deletes the schedule and posts the outcome to the approval
 * channel. On a failure other than "already gone" it audits the orphan and
 * rethrows, so the schedule's retry policy and DLQ apply; the sweeper is the
 * backstop and will alarm too.
 *
 * Idempotent: a double revoke (scheduler and sweeper) deletes the membership
 * once and the losing state transition is a no-op, and the revoke post is
 * claimed with a conditional write, so exactly one revoker posts. A retry after
 * a failed post finds the grant already `revoked` and posts without revoking
 * again.
 */
export type RevokeDeps = {
  store: typeof defaultStore;
  assumeGrantRole: typeof assumeGrantRole;
  resolveAdminsMembershipId: typeof resolveAdminsMembershipId;
  deleteAdminsMembership: typeof deleteAdminsMembership;
  deleteExpirySchedule: typeof deleteExpirySchedule;
};

const postRevokeOutcome = async (
  slack: WebClient,
  grant: GrantRecord,
  request: RequestRecord | undefined,
): Promise<void> => {
  const revokedAt = new Date().toISOString();
  const channel =
    request?.channel ??
    process.env.APPROVAL_CHANNEL ??
    DEFAULT_APPROVAL_CHANNEL;
  await slack.chat.postMessage({
    channel,
    ...(request?.messageTs ? { thread_ts: request.messageTs } : {}),
    text: buildRevokeOutcomeText(grant, revokedAt),
    blocks: buildRevokedBlocks(grant, revokedAt) as unknown as MessageBlocks,
  });
};

export const handleRevoke = async (
  event: SheriffEvent,
  slack: WebClient,
  deps?: Partial<RevokeDeps>,
): Promise<LambdaResponse> => {
  const revokeStore = deps?.store ?? defaultStore;
  const assume = deps?.assumeGrantRole ?? assumeGrantRole;
  const resolveMembership =
    deps?.resolveAdminsMembershipId ?? resolveAdminsMembershipId;
  const deleteMembership =
    deps?.deleteAdminsMembership ?? deleteAdminsMembership;
  const removeSchedule = deps?.deleteExpirySchedule ?? deleteExpirySchedule;

  const requestId = event.requestId;
  if (!requestId) return OK;

  const [grant, request] = await Promise.all([
    revokeStore.getGrant(requestId),
    revokeStore.getRequest(requestId),
  ]);
  if (!grant) return OK;

  // The revoke post is claimed separately from the state transition, so a
  // sweeper that won the transition does not silence the channel, and a retry
  // after a failed post can still post.
  const notify = async (): Promise<void> => {
    const claimed = await revokeStore.claimRevokePost(requestId);
    if (!claimed) return;
    try {
      await postRevokeOutcome(slack, grant, request ?? undefined);
    } catch (err) {
      await revokeStore.releaseRevokePost(requestId);
      throw err;
    }
  };

  if (grant.state === "revoked") {
    // The sweeper won the transition, or this is the retry after the post
    // failed. The membership is already gone; make sure no schedule is left
    // (a sweeper that won the transition may have failed to delete it) and
    // post if this grant has not been posted. A schedule-delete failure must
    // not block the post, and the one-shot's own DELETE cleans it up anyway.
    try {
      await removeSchedule(grant);
    } catch (err) {
      console.error(
        "failed to delete the expiry schedule on revoke retry",
        err,
      );
    }
    await notify();
    return OK;
  }

  const client = await assume();
  const membershipId =
    grant.membershipId ??
    (await resolveMembership(client, grant.requesterIdentityStoreId)) ??
    undefined;

  if (!membershipId) {
    // The grant never completed: no membership exists, so there is nothing to
    // revoke. Fail it closed, the same way the sweeper's `granting`-with-no-
    // member case does, and drop the schedule.
    const applied = await revokeStore.setGrantState({
      requestId,
      state: "failed",
      fromState: "granting",
    });
    if (applied) {
      try {
        await revokeStore.setRequestState(requestId, "failed", "granting");
      } finally {
        await revokeStore.releaseActiveGrant(grant.requesterIdentityStoreId);
      }
      await removeSchedule(grant);
      audit("grant.failed", {
        requestId,
        requester: grant.requesterSlackId,
        requesterEmail: grant.requesterEmail,
        approver: grant.approverSlackId,
        group: grant.groupId,
        reason: grant.reason,
        ticket: grant.ticket,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
        source: "schedule",
      });
    }
    return OK;
  }

  let applied: boolean;
  try {
    applied = await revokeGrant({
      client,
      grant,
      membershipId,
      deps: {
        store: revokeStore,
        deleteAdminsMembership: deleteMembership,
        deleteExpirySchedule: removeSchedule,
      },
    });
  } catch (err) {
    // A revoke that fails for a reason other than "already gone" is the
    // orphan the alarm exists for. Rethrow so the schedule retries and, after
    // its attempts, dead-letters; the sweeper will alarm as well.
    console.error("break-glass scheduled revoke failed", err);
    audit("membership.orphaned", {
      requestId,
      requester: grant.requesterSlackId,
      requesterEmail: grant.requesterEmail,
      approver: grant.approverSlackId,
      group: grant.groupId,
      membershipId,
      reason: grant.reason,
      ticket: grant.ticket,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
      source: "schedule",
    });
    throw err;
  }

  if (applied) {
    audit("grant.revoked", {
      requestId,
      requester: grant.requesterSlackId,
      requesterEmail: grant.requesterEmail,
      approver: grant.approverSlackId,
      group: grant.groupId,
      membershipId,
      reason: grant.reason,
      ticket: grant.ticket,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
      source: "schedule",
    });
  }
  await notify();
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

  const secrets = await getSecrets();
  const signingSecret = secrets["SLACK_SIGNING_SECRET"];
  const botToken = secrets["SLACK_BOT_TOKEN"];
  if (!signingSecret || !botToken) {
    throw new Error(
      "The sheriff secret must hold SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN",
    );
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  const headers = lowerCaseHeaders(event.headers);

  // The async self-invocations and the scheduler's revoke event carry no Slack
  // signature; the two HTTP routes do, and are verified before anything
  // happens.
  const isAsync =
    event.action === "post-request" ||
    event.action === "decide" ||
    event.action === "revoke";
  if (
    !isAsync &&
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
    if (event.action === "post-request") {
      return await handlePostRequest(event, slack);
    }
    if (event.action === "decide") {
      return await handleDecide(event, slack);
    }
    if (event.action === "revoke") {
      return await handleRevoke(event, slack);
    }

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
    // An async invocation only retries on a thrown error, timeout or crash;
    // returning 500 would look like success and silently drop the work. The
    // HTTP routes still answer 500.
    if (isAsync) throw err;
    return { statusCode: 500, body: "internal error" };
  }
};
