/**
 * Block Kit for the break-glass dry run: the request modal, the approval post,
 * and the decided post. Pure builders, so the tests can assert the dry-run
 * wording without a Slack client.
 *
 * The dry-run notice is load-bearing rather than decorative. Step 3 stops at
 * the decision, so every surface that could be read as "access granted" says
 * plainly that it is not: the approval post, the decided post and the threaded
 * outcome all carry it.
 */
import { DEFAULT_DURATION_VALUE, DURATION_OPTIONS } from "./config";
import type { Decision, RequestRecord } from "./policy";

type Block = Record<string, unknown>;

const durationOption = (value: string) => {
  const option = DURATION_OPTIONS.find((entry) => entry.value === value);
  if (!option) throw new Error(`Unknown duration option: ${value}`);
  return {
    text: { type: "plain_text", text: option.label },
    value: option.value,
  };
};

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
    text: `*Duration*\n${request.durationValue} (${Math.round(
      request.durationSeconds / 60,
    )} minutes)`,
  },
  { type: "mrkdwn", text: `*Reason*\n${request.reason}` },
  { type: "mrkdwn", text: `*Ticket*\n${request.ticket}` },
];

export const DRY_RUN_NOTICE =
  "⚠️ *Dry run (step 3):* approving records the decision only. No Identity Center membership is created and no access is granted. Step 4 wires the real grant.";

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
    elements: [{ type: "mrkdwn", text: DRY_RUN_NOTICE }],
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

/** The original post, buttons removed, showing who decided and how. */
export const buildDecidedBlocks = (
  request: RequestRecord,
  decision: Decision,
  decidedBy: string,
): Block[] => {
  const headline =
    decision === "approved"
      ? `:white_check_mark: *Break-glass request* \`${request.id}\` — *approved* by <@${decidedBy}>`
      : `:no_entry: *Break-glass request* \`${request.id}\` — *denied* by <@${decidedBy}>`;
  const context =
    decision === "approved"
      ? "⚠️ *Dry run (step 3):* the decision is recorded but no membership was created and no access was granted."
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
): string =>
  decision === "approved"
    ? `:white_check_mark: <@${decidedBy}> approved <@${request.requesterSlackId}>'s break-glass request (${request.durationValue}). *Dry run: no membership was created and no access was granted.* Step 4 wires the real grant.`
    : `:no_entry: <@${decidedBy}> denied <@${request.requesterSlackId}>'s break-glass request. No access was granted.`;
