/**
 * The break-glass Lambda, step 3 ("the Lambda, dry") of `docs/break-glass.md`.
 *
 * A separate Slack app and a separate function from the delegate webhook. The
 * plan is explicit about why: every delegate worker holds `DELEGATES` while
 * processing untrusted text, and function-URL auth is signature-only, so that
 * secret is enough to forge an approval. This function reads its own secret,
 * `break-glass`, and nothing else. It follows the signing and secret-reading
 * code *patterns* from `delegate/lambdas/verify.ts` and
 * `delegate/lambdas/secrets.ts` in local modules (`verify.ts`, `secrets.ts`)
 * rather than importing them, so the bundle has no dependency on the delegate
 * code or its deploy path.
 *
 * Routes, both on the one Function URL:
 *
 *   POST /breakglass     the slash command; opens the modal.
 *   POST /interactivity  `view_submission` (write the request, post to the
 *                        channel) and `block_actions` (Approve/Deny).
 *
 * Step 3 stops at the decision: it writes `approved` or `denied` and posts the
 * result, but it never calls `CreateGroupMembership` and never writes a
 * `granting`/`granted` record. Every surface says so.
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
  DEFAULT_APPROVAL_CHANNEL,
  MAX_REQUESTS_PER_DAY,
  RATE_TTL_SECONDS,
  REQUEST_TTL_SECONDS,
  SLACK_TO_IDENTITY_STORE_USER_ID,
} from "./config";
import {
  decodeSlackPayload,
  durationSecondsFor,
  evaluateDecision,
  isHttpUrl,
  newRequestId,
  rateLimitExceeded,
  utcDate,
  type Decision,
  type RequestRecord,
} from "./policy";
import {
  decideRequest,
  getRequest,
  incrementRateCount,
  putRequest,
  readRateCount,
  setRequestMessageRef,
} from "./store";

type FunctionUrlEvent = {
  rawPath: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
};

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

const handleViewSubmission = async (
  payload: Record<string, unknown>,
  slack: WebClient,
): Promise<LambdaResponse> => {
  const user = asRecord(payload.user);
  const requesterSlackId = stringField(user, "id");
  if (!requesterSlackId) {
    return json({
      response_action: "errors",
      errors: { reason_block: "Could not identify the requesting Slack user." },
    });
  }

  // Open question 3, settled: a hardcoded Slack -> Identity Store map. A
  // requester not in it cannot be granted anything in step 4, so the dry flow
  // rejects the submission now rather than recording an unmappable request.
  const requesterIdentityStoreId =
    SLACK_TO_IDENTITY_STORE_USER_ID[requesterSlackId];
  if (!requesterIdentityStoreId) {
    return json({
      response_action: "errors",
      errors: {
        reason_block:
          "Your Slack account is not mapped to an Identity Store user. Ask an engineer to add you to the break-glass map.",
      },
    });
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

  const today = utcDate();
  const count = await incrementRateCount(
    requesterSlackId,
    today,
    RATE_TTL_SECONDS,
  );
  if (rateLimitExceeded(count)) {
    return json({
      response_action: "errors",
      errors: {
        reason_block: `Rate limit reached: at most ${MAX_REQUESTS_PER_DAY} break-glass requests per user per day.`,
      },
    });
  }

  const request: RequestRecord = {
    id: newRequestId(),
    state: "requested",
    requesterSlackId,
    requesterIdentityStoreId,
    reason: reason!,
    ticket: ticket!,
    durationValue: durationValue!,
    durationSeconds,
    createdAt: new Date().toISOString(),
    dryRun: true,
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
    durationSeconds,
    dryRun: true,
  });

  return json({ response_action: "clear" });
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

  // The per-user rate limit, re-checked at the decision as the plan lists it.
  // The request's own submission already incremented today's counter, so this
  // only rejects when the requester is over the cap, not at it.
  const count = await readRateCount(request.requesterSlackId, utcDate());
  if (rateLimitExceeded(count)) {
    await ephemeral(
      `Rate limit exceeded: at most ${MAX_REQUESTS_PER_DAY} break-glass requests per user per day.`,
    );
    return OK;
  }

  const decision: Decision | null =
    actionId === APPROVE_ACTION_ID
      ? "approved"
      : actionId === DENY_ACTION_ID
        ? "denied"
        : null;
  if (!decision) return OK;

  const decidedAt = new Date().toISOString();
  const decided = await decideRequest({
    id: requestId,
    decision,
    approverSlackId: clickerSlackId,
    decidedAt,
  });
  if (!decided) {
    await ephemeral("That request was already decided.");
    return OK;
  }

  const decidedRequest: RequestRecord = {
    ...request,
    state: decision,
    approverSlackId: clickerSlackId,
    decidedAt,
    dryRun: true,
  };

  if (messageTs) {
    await slack.chat.update({
      channel,
      ts: messageTs,
      text: `Break-glass request ${decision}`,
      blocks: buildDecidedBlocks(
        decidedRequest,
        decision,
        clickerSlackId,
      ) as unknown as MessageBlocks,
    });
  }
  await slack.chat.postMessage({
    channel,
    ...(messageTs ? { thread_ts: messageTs } : {}),
    text: buildDecisionOutcomeText(decidedRequest, decision, clickerSlackId),
  });

  audit(`request.${decision}`, {
    requestId,
    requester: request.requesterSlackId,
    approver: clickerSlackId,
    durationSeconds: request.durationSeconds,
    dryRun: true,
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

export const handler = async (
  event: FunctionUrlEvent,
): Promise<LambdaResponse> => {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  const headers = lowerCaseHeaders(event.headers);

  const secrets = await getSecrets();
  const signingSecret = secrets["SLACK_SIGNING_SECRET"];
  const botToken = secrets["SLACK_BOT_TOKEN"];
  if (!signingSecret || !botToken) {
    throw new Error(
      "The break-glass secret must hold SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN",
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
