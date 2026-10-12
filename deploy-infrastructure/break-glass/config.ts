/**
 * Policy inputs for the break-glass dry run, step 3 ("the Lambda, dry") of
 * `docs/break-glass.md`.
 *
 * Two of these are deliberately hard-coded in the tool's code rather than
 * resources in AWS, and both change only by a reviewed PR:
 *
 * - **The approver list.** "Approval policy" settles this: no Identity Store
 *   approver group and no Slack mirror. One approver per request, and the
 *   approver must not be the requester.
 * - **The Slack-user-id to Identity Store-user-id map for the requester.**
 *   Open question 3 was settled by the engineer in favour of this map, as the
 *   deliberate temporary option, with a refactor planned. Because the mapping
 *   is maintained here, the `break-glass-grant` role needs no directory read
 *   at all; see `deploy/components/break-glass-grant.ts`, which step 3 does
 *   not change.
 *
 * PLACEHOLDERS. No real Slack user ids or Identity Store user ids were
 * available when this landed, so both maps hold an obvious placeholder. A real
 * rollout replaces them in a reviewed PR. The approver placeholder means every
 * click currently gets the "not an approver" ephemeral, which is the honest
 * dry-run behaviour, and every requester is rejected at submission with the
 * "not mapped" error.
 */

/** The hardcoded approver list. One approver per request. */
export const APPROVER_SLACK_USER_IDS: readonly string[] = [
  // PLACEHOLDER: replace with real Slack user ids before enabling.
  "U0000000000",
];

/**
 * Slack user id -> Identity Store user id.
 *
 * PLACEHOLDER: replace with the real mapping before enabling. The plan's open
 * question 3 settled on this map as the temporary mechanism; it is read only
 * to stamp the requester's Identity Store id on the request record so step 4
 * can call `CreateGroupMembership` without a directory read.
 */
export const SLACK_TO_IDENTITY_STORE_USER_ID: Readonly<
  Record<string, string>
> = {
  // PLACEHOLDER: replace with real Slack and Identity Store user ids.
  U0000000000: "00000000-0000-0000-0000-000000000000",
};

/** Where the request and every outcome are posted. No DMs. */
export const DEFAULT_APPROVAL_CHANNEL = "#devs-only";

/**
 * Duration cap, settled in review (open question 5): default `PT1H`, max
 * `PT4H`. The modal's select is bounded to exactly these options, and the
 * handler re-checks the chosen value against `MAX_DURATION_SECONDS` so a
 * hand-crafted submission cannot exceed it.
 */
export const MAX_DURATION_SECONDS = 4 * 60 * 60;

export const DEFAULT_DURATION_VALUE = "PT1H";

export const DURATION_OPTIONS: readonly {
  value: string;
  label: string;
  seconds: number;
}[] = [
  { value: "PT1H", label: "1 hour", seconds: 60 * 60 },
  { value: "PT2H", label: "2 hours", seconds: 2 * 60 * 60 },
  { value: "PT3H", label: "3 hours", seconds: 3 * 60 * 60 },
  { value: "PT4H", label: "4 hours (maximum)", seconds: 4 * 60 * 60 },
];

/**
 * The per-user cap on requests per day. The exact number is an open question
 * in the plan ("Rate limit"); 5/day is the placeholder the dry flow enforces,
 * it is one line to change, and the PR body calls it out.
 */
export const MAX_REQUESTS_PER_DAY = 5;

/**
 * DynamoDB TTL, retention only. It never ends a grant (`docs/break-glass.md`,
 * "States"): revocation is the scheduler plus the sweeper in step 4/5. 90 days
 * keeps the application audit readable for a quarter without a second store.
 */
export const REQUEST_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Rate counters are short-lived: they only need to outlive the UTC day they
 * count. Two days of slack covers clock skew across a day boundary.
 */
export const RATE_TTL_SECONDS = 2 * 24 * 60 * 60;
