/**
 * Policy inputs for the break-glass tool, step 4 ("approval wired to a real
 * grant") of `docs/sheriff.md`.
 *
 * The approver list is deliberately hard-coded in the tool's code rather than a
 * resource in AWS; it changes only by a reviewed PR. "Approval policy" settles
 * this: no Identity Store approver group and no Slack mirror. One approver per
 * request, and the approver must not be the requester.
 *
 * The requester mapping is no longer hard-coded. Open question 3 was settled by
 * the engineer in favour of resolving the requester at request time from their
 * Slack email (`users.info` -> `identitystore:GetUserId` on
 * `emails.value`), gated on membership in the `Engineers` Identity Store group.
 * That is why the `sheriff-grant` role's inline policy now carries
 * `GetUserId` and `IsMemberInGroups`; see `deploy/components/sheriff-grant.ts`.
 *
 * The list is deliberately short and hard-coded: changed only by a reviewed PR,
 * per "Approval policy" in `docs/sheriff.md`.
 */
import { IDENTITY_STORE_ID } from "../../utils/accounts";

/**
 * The hardcoded approver list. One approver per request, and the approver must
 * not be the requester.
 *
 * `U0BMU0DPS9Y` is Jeff Jagoda (`jeff@goodparty.org`), the engineer. He is
 * deliberately the only approver for now; adding another is a reviewed PR.
 */
export const APPROVER_SLACK_USER_IDS: readonly string[] = ["U0BMU0DPS9Y"];

/**
 * The `Admins` Identity Store group id, mirrored from
 * `deploy/components/identity-center.ts`. It is the group a grant adds the
 * requester to. A literal rather than an import because that file does not
 * export its group map; `deploy/sheriff-grant.test.ts` reads the literal in
 * that file so the two cannot drift silently.
 */
export const ADMINS_GROUP_ID = "88c1b330-a001-707a-06ca-94e289013bf5";

/**
 * The `Engineers` Identity Store group id. Step 4's requester gate: only a
 * member of this group may submit a break-glass request, checked at request
 * time so an ineligible requester gets immediate feedback rather than a request
 * that can never be granted.
 */
export const ENGINEERS_GROUP_ID = "383193a0-7001-70d9-a321-ffe6d8af7378";

/**
 * The default AWS access portal URL, derived from the identity store id.
 *
 * Identity Center shows this URL in the console and it is the address a user
 * signs in to. The built-in directory's portal URL is
 * `https://<identity-store-id>.awsapps.com/start`; a customized URL would
 * differ, and if this organization has one this constant is the one line to
 * change. The Slack grant copy links it and tells the user to sign out and back
 * in, because a membership change is not visible in an already-open session.
 */
export const SSO_PORTAL_URL = `https://${IDENTITY_STORE_ID}.awsapps.com/start`;

/** Where the request and every outcome are posted. No DMs. */
export const DEFAULT_APPROVAL_CHANNEL = "#sensitive-access-requests";

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
 * The per-user cap on requests per day. 20/day is the value the flow currently
 * enforces; whether it is final is still open in the plan ("Rate limit"), and
 * it is one line to change.
 */
export const MAX_REQUESTS_PER_DAY = 20;

/**
 * DynamoDB TTL, retention only. It never ends a grant (`docs/sheriff.md`,
 * "States"): revocation is the sweeper in step 4 and the one-shot scheduler in
 * step 5. 90 days keeps the application audit readable for a quarter without a
 * second store.
 */
export const REQUEST_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Rate counters are short-lived: they only need to outlive the UTC day they
 * count. Two days of slack covers clock skew across a day boundary.
 */
export const RATE_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * How long a `granting` record is left alone by the sweeper before it is
 * reconciled. The approve path is a cross-account AssumeRole, one
 * `CreateGroupMembership` and a few DynamoDB writes, which completes in
 * seconds; five minutes is comfortably longer, and the sweeper runs every five
 * minutes anyway. Without this, a sweep that observes the record between
 * `putGrant` and the membership write would mark it `failed` while the
 * membership lands afterwards, stranding an untracked standing admin.
 */
export const SWEEP_GRANTING_GRACE_MS = 5 * 60 * 1000;

/**
 * The permission set's session duration, in the Slack copy only.
 *
 * `deploy/components/identity-center.ts` shortens the `administrator` set to
 * `PT1H`. A revoke removes the membership but does not end a session that is
 * already open, so the honest worst case is the requested duration plus the
 * remaining session. The copy says "up to 1 hour more" rather than implying a
 * hard cutoff; this constant is that 1 hour, named so the copy and the
 * permission set can be reconciled by a reader.
 */
export const SESSION_DURATION_SECONDS = 60 * 60;
