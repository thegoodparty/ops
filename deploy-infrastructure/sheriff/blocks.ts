/**
 * Block Kit for the break-glass tool: the request modal, the approval post, the
 * decided post and the threaded outcome. Pure builders, so the tests can assert
 * the copy without a Slack client.
 *
 * Step 4 removes the dry-run notices. The approval post now shows the resolved
 * requester email so the approver can confirm the identity, and the granted
 * outcome carries the SSO portal link and the session caveat: a revoke removes
 * the membership but does not end a session that is already open.
 */
import {
  DEFAULT_DURATION_VALUE,
  DURATION_OPTIONS,
  SESSION_DURATION_SECONDS,
  SSO_PORTAL_URL,
} from "./config";
import type { Decision, GrantRecord, RequestRecord } from "./policy";

type Block = Record<string, unknown>;

const durationOption = (value: string) => {
  const option = DURATION_OPTIONS.find((entry) => entry.value === value);
  if (!option) throw new Error(`Unknown duration option: ${value}`);
  return {
    text: { type: "plain_text", text: option.label },
    value: option.value,
  };
};

const minutes = (seconds: number) => Math.round(seconds / 60);

export const REQUEST_MODAL_CALLBACK_ID = "breakglass_request";
export const APPROVE_ACTION_ID = "breakglass_approve";
export const DENY_ACTION_ID = "breakglass_deny";

/**
 * The `/breakglass` modal: duration (bounded select), required reason, required
 * incident/ticket link. Deliberately no account field: escalation is global by
 * design (open question 4, settled).
 */
export const buildRequestModal = (): Block => ({
  type: "modal",
  callback_id: REQUEST_MODAL_CALLBACK_ID,
  title: { type: "plain_text", text: "Break-glass request" },
  submit: { type: "plain_text", text: "Request" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "input",
      block_id: "duration_block",
      label: { type: "plain_text", text: "Duration" },
      element: {
        type: "static_select",
        action_id: "duration",
        initial_option: durationOption(DEFAULT_DURATION_VALUE),
        options: DURATION_OPTIONS.map((entry) => durationOption(entry.value)),
      },
    },
    {
      type: "input",
      block_id: "reason_block",
      label: { type: "plain_text", text: "Reason" },
      element: {
        type: "plain_text_input",
        action_id: "reason",
        multiline: true,
        max_length: 1000,
        placeholder: {
          type: "plain_text",
          text: "What do you need admin for?",
        },
      },
    },
    {
      type: "input",
      block_id: "ticket_block",
      label: { type: "plain_text", text: "Incident or ticket link" },
      element: {
        type: "plain_text_input",
        action_id: "ticket",
        placeholder: {
          type: "plain_text",
          text: "https://github.com/thegoodparty/ops/issues/...",
        },
      },
    },
  ],
});

const requestFields = (request: RequestRecord) => [
  {
    type: "mrkdwn",
    text: `*Requester*\n<@${request.requesterSlackId}>`,
  },
  {
    type: "mrkdwn",
    // The resolved Identity Store identity, so the approver can confirm the
    // person the grant will actually land on.
    text: `*Email*\n${request.requesterEmail}`,
  },
  {
    type: "mrkdwn",
    text: `*Duration*\n${request.durationValue} (${minutes(
      request.durationSeconds,
    )} minutes)`,
  },
  { type: "mrkdwn", text: `*Reason*\n${request.reason}` },
  { type: "mrkdwn", text: `*Ticket*\n${request.ticket}` },
];

/** The SSO portal link and the honest session caveat, shared by both surfaces. */
const grantContext = (grant: GrantRecord): string =>
  `:white_check_mark: Access granted: *AdministratorAccess* via the \`Admins\` group until ${grant.expiresAt}.\n` +
  `Sign out and back in at the SSO portal to see the role: ${SSO_PORTAL_URL}\n` +
  `The grant window is ${minutes(grant.durationSeconds)} minutes. Removing the membership does not end a session that is already open, so if you are already signed in you keep the role until that session expires (up to ${minutes(
    SESSION_DURATION_SECONDS,
  )} minutes more). The honest worst case is roughly twice the requested duration.`;

const grantFailedContext = (): string =>
  `:x: The approval was recorded but the grant failed, so no access was granted. The failure is logged. If it persists, ask an engineer to check the \`sheriff-grant\` role and the Identity Center directory.`;

/** The approval post, with Approve/Deny bound to the request id. */
export const buildApprovalBlocks = (request: RequestRecord): Block[] => [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:rotating_light: *Break-glass request* \`${request.id}\``,
    },
  },
  { type: "section", fields: requestFields(request) },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Approving grants `AdministratorAccess` in all three accounts (via `Admins`) until the requested duration ends.",
      },
    ],
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: APPROVE_ACTION_ID,
        style: "primary",
        text: { type: "plain_text", text: "Approve" },
        value: request.id,
      },
      {
        type: "button",
        action_id: DENY_ACTION_ID,
        style: "danger",
        text: { type: "plain_text", text: "Deny" },
        value: request.id,
      },
    ],
  },
];

/**
 * The original post, buttons removed, showing who decided and how. For an
 * approval, `grant` carries the outcome: a `granted` record shows the SSO link
 * and caveat, a `failed` record shows the failure and no access.
 */
export const buildDecidedBlocks = (
  request: RequestRecord,
  decision: Decision,
  decidedBy: string,
  grant?: GrantRecord,
): Block[] => {
  const headline =
    decision === "approved"
      ? `:white_check_mark: *Break-glass request* \`${request.id}\` — *approved* by <@${decidedBy}>`
      : `:no_entry: *Break-glass request* \`${request.id}\` — *denied* by <@${decidedBy}>`;
  const context =
    decision === "approved"
      ? grant && grant.state === "granted"
        ? grantContext(grant)
        : grant && grant.state === "failed"
          ? grantFailedContext()
          : "The approval is recorded; the grant is in progress."
      : "No access was granted.";
  return [
    { type: "section", text: { type: "mrkdwn", text: headline } },
    { type: "section", fields: requestFields(request) },
    { type: "context", elements: [{ type: "mrkdwn", text: context }] },
  ];
};

/** The threaded outcome, so the channel keeps both the request and the result. */
export const buildDecisionOutcomeText = (
  request: RequestRecord,
  decision: Decision,
  decidedBy: string,
  grant?: GrantRecord,
): string => {
  if (decision === "denied") {
    return `:no_entry: <@${decidedBy}> denied <@${request.requesterSlackId}>'s break-glass request. No access was granted.`;
  }
  if (grant && grant.state === "failed") {
    return `:x: <@${decidedBy}> approved <@${request.requesterSlackId}>'s break-glass request, but the grant failed. No access was granted.`;
  }
  if (grant && grant.state === "granted") {
    return `:white_check_mark: <@${decidedBy}> approved <@${request.requesterSlackId}>'s break-glass request. *AdministratorAccess* is granted until ${grant.expiresAt}. Sign out and back in at ${SSO_PORTAL_URL} to see the role; an already-open session can keep it up to ${minutes(
      SESSION_DURATION_SECONDS,
    )} minutes longer.`;
  }
  return `:white_check_mark: <@${decidedBy}> approved <@${request.requesterSlackId}>'s break-glass request (${request.durationValue}).`;
};

/**
 * The revoke outcome, posted to the approval channel when the grant ends. The
 * membership is gone, but a session that was already open keeps the role until
 * it expires, so the same honest caveat as the grant copy applies.
 */
export const buildRevokedBlocks = (
  grant: GrantRecord,
  revokedAt: string,
): Block[] => [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `:lock: *Break-glass access revoked* for <@${grant.requesterSlackId}> ` +
        `(request \`${grant.requestId}\`) at ${revokedAt}.\n` +
        "`AdministratorAccess` via the `Admins` group is removed. " +
        `A session that was already open can keep the role until it expires (up to ${minutes(
          SESSION_DURATION_SECONDS,
        )} minutes more).`,
    },
  },
];

/** The notification text for the revoke post, for clients that do not render blocks. */
export const buildRevokeOutcomeText = (
  grant: GrantRecord,
  revokedAt: string,
): string =>
  `:lock: Break-glass access for <@${grant.requesterSlackId}> (request \`${grant.requestId}\`) was revoked at ${revokedAt}. ` +
  "`AdministratorAccess` via the `Admins` group is removed.";
