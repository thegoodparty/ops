/**
 * Pure request/decision/grant/sweep logic for the break-glass tool. No AWS and
 * no Slack here, so it is what the tests exercise directly; `handler.ts` is the
 * wiring.
 *
 * Step 4 replaces the dry-run `approved` state with the real grant path:
 * `requested -> granting -> granted -> revoked`, with `failed` as the
 * fail-closed terminal state. `docs/sheriff.md`, "States", is the authoritative
 * machine; this file is its executable form.
 */
import { randomUUID } from "node:crypto";

import {
  APPROVER_SLACK_USER_IDS,
  DURATION_OPTIONS,
  MAX_DURATION_SECONDS,
  MAX_REQUESTS_PER_DAY,
  SCHEDULE_NAME_PREFIX,
} from "./config";

/**
 * Request-item states.
 *
 * `approved` is gone: it was dry-run-only, a record that a human said yes and
 * nothing more. Approval now moves the request to `granting`, and the grant
 * item carries the membership detail.
 */
export type RequestState =
  | "requested"
  | "denied"
  | "granting"
  | "granted"
  | "revoked"
  | "failed";

/**
 * Grant-item states. A grant record is written in `granting` before the
 * membership call, so the state is never invisible, and the sweeper can
 * reconcile a partial grant.
 */
export type GrantState = "granting" | "granted" | "revoked" | "failed";

export type Decision = "approved" | "denied";

export type RequestRecord = {
  id: string;
  state: RequestState;
  requesterSlackId: string;
  requesterIdentityStoreId: string;
  /** The Slack profile email the Identity Store user was resolved from. */
  requesterEmail: string;
  reason: string;
  ticket: string;
  durationValue: string;
  durationSeconds: number;
  createdAt: string;
  /** Set after the approval post succeeds, so a decision can update it. */
  channel?: string;
  messageTs?: string;
  approverSlackId?: string;
  decidedAt?: string;
  /** DynamoDB TTL, retention only. */
  ttl?: number;
};

/**
 * The grant record. Written in `granting` before `CreateGroupMembership`, then
 * flipped to `granted` with the `membershipId` the call returned (or resolved
 * with `ListGroupMembershipsForMember` when the requester was already a
 * member).
 */
export type GrantRecord = {
  requestId: string;
  state: GrantState;
  requesterSlackId: string;
  requesterIdentityStoreId: string;
  requesterEmail: string;
  approverSlackId: string;
  /** The `Admins` group id. One membership grants admin in all three accounts. */
  groupId: string;
  reason: string;
  ticket: string;
  durationSeconds: number;
  grantedAt: string;
  expiresAt: string;
  /** Set once the membership exists; absent while the record is `granting`. */
  membershipId?: string;
  /**
   * The EventBridge Scheduler one-shot that revokes this grant at `expiresAt`
   * (step 5). Named deterministically from the request id so it is known
   * before the schedule is created and a retry addresses the same schedule.
   */
  scheduleName?: string;
  updatedAt?: string;
  /** DynamoDB TTL, retention only. */
  ttl?: number;
};

export const REQUEST_PK_PREFIX = "REQUEST#";
export const RATE_PK_PREFIX = "RATE#";
/**
 * The fixed partition every grant record shares, so the sweeper can `Query`
 * them all. A grant item's sort key carries the `GRANT#` prefix and the request
 * id.
 */
export const GRANT_PK = "GRANT";
export const GRANT_SK_PREFIX = "GRANT#";
/**
 * The per-requester active-grant lock. Its conditional write is what makes the
 * at-most-one-active-grant rule race-safe.
 */
export const ACTIVE_PK_PREFIX = "ACTIVE#";
export const RECORD_SK = "META";

export const requestPk = (id: string) => `${REQUEST_PK_PREFIX}${id}`;
export const ratePk = (slackUserId: string, date: string) =>
  `${RATE_PK_PREFIX}${slackUserId}#${date}`;
export const grantSk = (requestId: string) =>
  `${GRANT_SK_PREFIX}${requestId}`;
export const activePk = (identityStoreUserId: string) =>
  `${ACTIVE_PK_PREFIX}${identityStoreUserId}`;

export const newRequestId = () => randomUUID();

/** The rate counter is per user per UTC day. */
export const utcDate = (now: Date = new Date()) => now.toISOString().slice(0, 10);

export const durationSecondsFor = (value: string | undefined): number | null => {
  if (!value) return null;
  const option = DURATION_OPTIONS.find((entry) => entry.value === value);
  return option ? option.seconds : null;
};

export const withinDurationCap = (seconds: number): boolean =>
  seconds > 0 && seconds <= MAX_DURATION_SECONDS;

export const isApprover = (slackUserId: string): boolean =>
  APPROVER_SLACK_USER_IDS.includes(slackUserId);

export const rateLimitExceeded = (count: number): boolean =>
  count > MAX_REQUESTS_PER_DAY;

export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** `grantedAt` plus the requested duration, as an ISO timestamp. */
export const grantExpiresAt = (
  grantedAt: string,
  durationSeconds: number,
): string =>
  new Date(Date.parse(grantedAt) + durationSeconds * 1000).toISOString();

/**
 * The deterministic EventBridge Scheduler name for a grant's expiry one-shot.
 * Deterministic so the grant record can carry it from the moment it is written,
 * before the schedule exists, and so a retry or a sweep recovery addresses the
 * same schedule rather than creating a second one.
 */
export const expiryScheduleName = (requestId: string): string =>
  `${SCHEDULE_NAME_PREFIX}${requestId}`;

/**
 * EventBridge Scheduler's one-shot `at()` expression for a grant's expiry.
 *
 * The form is `at(yyyy-mm-ddThh:mm:ss)` evaluated in the schedule's timezone;
 * the create call sets that to UTC. The ISO milliseconds and trailing `Z` are
 * not accepted, so they are stripped rather than passed through.
 */
export const scheduleAtExpression = (iso: string): string =>
  `at(${new Date(iso).toISOString().replace(/\.\d{3}Z$/, "")})`;

/**
 * Slack sends interactivity as `application/x-www-form-urlencoded` with a
 * single `payload=<json>` field, unlike the delegate events route which parses
 * a JSON body. This is the decode the plan calls out.
 */
export const decodeSlackPayload = (
  body: string,
): Record<string, unknown> | null => {
  const raw = new URLSearchParams(body).get("payload");
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

export type DecisionCheck = { ok: true } | { ok: false; reason: string };

/**
 * The approval checks that make sense without a grant: the clicker is on the
 * hardcoded approver list, the clicker is not the requester, the request has
 * not already been decided, and the requested duration is within the cap.
 *
 * The at-most-one-active-grant guard and the `CreateGroupMembership` path are
 * in the handler; there is no grant here to guard.
 */
export const evaluateDecision = (args: {
  request: Pick<
    RequestRecord,
    "state" | "requesterSlackId" | "durationSeconds"
  >;
  clickerSlackId: string;
}): DecisionCheck => {
  if (!isApprover(args.clickerSlackId)) {
    return { ok: false, reason: "You are not an approver for break-glass requests." };
  }
  if (args.clickerSlackId === args.request.requesterSlackId) {
    return {
      ok: false,
      reason: "You cannot decide your own break-glass request.",
    };
  }
  if (args.request.state !== "requested") {
    return {
      ok: false,
      reason: `This request is already ${args.request.state}.`,
    };
  }
  if (!withinDurationCap(args.request.durationSeconds)) {
    return {
      ok: false,
      reason: "The requested duration exceeds the PT4H cap.",
    };
  }
  return { ok: true };
};

/**
 * The three ways a requester can fail the step-4 eligibility gate. Each gets
 * its own message so the requester knows what to fix; all three are keyed to
 * `reason_block`, the only block `view_submission` errors can address for this
 * modal.
 */
export type EligibilityFailure =
  | "no-slack-email"
  | "no-identity-user"
  | "not-engineer";

export const eligibilityErrorMessage = (
  failure: EligibilityFailure,
  email?: string,
): string => {
  switch (failure) {
    case "no-slack-email":
      return "Slack did not return an email address for your account. Add an email to your Slack profile (and ask an engineer to confirm the app's users:read.email scope), then try again.";
    case "no-identity-user":
      return `No AWS Identity Center user matches ${email ?? "your Slack email"}. Ask an engineer to create or check your Identity Center account.`;
    case "not-engineer":
      return `Your Identity Center account (${email ?? "your email"}) is not a member of the Engineers group, which is required to request break-glass access. Ask an engineer to add you.`;
  }
};

export type EligibilityResult =
  | { ok: true; email: string; identityStoreUserId: string }
  | { ok: false; failure: EligibilityFailure; email?: string };

/**
 * Pure form of the request-time gate. The handler does the Slack and Identity
 * Store calls and passes their results here, so the three failure modes are
 * testable without AWS or Slack. Evaluation order is the order the messages
 * imply: no email, then no user, then not an engineer.
 */
export const evaluateEligibility = (args: {
  slackEmail: string | null | undefined;
  identityStoreUserId: string | null | undefined;
  isEngineersMember: boolean | null | undefined;
}): EligibilityResult => {
  const email = args.slackEmail?.trim();
  if (!email) return { ok: false, failure: "no-slack-email" };
  if (!args.identityStoreUserId) {
    return { ok: false, failure: "no-identity-user", email };
  }
  if (args.isEngineersMember !== true) {
    return { ok: false, failure: "not-engineer", email };
  }
  return { ok: true, email, identityStoreUserId: args.identityStoreUserId };
};

/**
 * The reconciliation sweeper's plan, computed purely from the group's current
 * memberships and the tool's grant records. `handler.ts` executes it; the
 * tests assert each case without AWS.
 */
export type SweepPlan = {
  /** `granting` records whose member is absent: the grant never completed. */
  failed: GrantRecord[];
  /** `granting` records whose member is present: backfill and flip to granted. */
  granted: { grant: GrantRecord; membershipId: string }[];
  /** Expired grants to revoke. */
  revoke: { grant: GrantRecord; membershipId: string }[];
  /** Members with no active grant record: left alone, logged informationally. */
  unmanaged: { userId: string; membershipId: string }[];
};

/**
 * Decide what the sweeper should do. Never removes a membership the tool has no
 * active grant record for, so pre-existing `Admins` members are untouched.
 *
 * A `granting` record younger than `grantingGraceMs` is left alone: the approve
 * path may still be running, and failing it now would strand a membership that
 * lands after the sweep. Once it is old enough, a `granting` record past expiry
 * that still has a member is first flipped to `granted` (so its `membershipId`
 * is recorded) and then revoked; whether that revoke succeeds is an AWS call
 * the handler makes, and only a failed revoke is an orphan.
 */
export const reconcileSweep = (args: {
  /** Epoch milliseconds. */
  now: number;
  grants: GrantRecord[];
  memberships: { userId: string; membershipId: string }[];
  /** How long a `granting` record is treated as in-flight. */
  grantingGraceMs: number;
}): SweepPlan => {
  const byUser = new Map(
    args.memberships.map((member) => [member.userId, member.membershipId]),
  );
  const activeUsers = new Set<string>();
  const plan: SweepPlan = {
    failed: [],
    granted: [],
    revoke: [],
    unmanaged: [],
  };

  for (const grant of args.grants) {
    if (grant.state === "granting") {
      // In-flight: the approve path cannot have finished yet, so do not judge
      // it. A record that is genuinely stuck ages past this and is reconciled
      // on a later sweep.
      if (args.now - Date.parse(grant.grantedAt) < args.grantingGraceMs) {
        activeUsers.add(grant.requesterIdentityStoreId);
        continue;
      }
      const membershipId = byUser.get(grant.requesterIdentityStoreId);
      if (!membershipId) {
        // The grant path stopped before the membership existed. No access, no
        // alarm.
        plan.failed.push(grant);
        continue;
      }
      activeUsers.add(grant.requesterIdentityStoreId);
      plan.granted.push({ grant, membershipId });
      if (Date.parse(grant.expiresAt) <= args.now) {
        plan.revoke.push({ grant, membershipId });
      }
    } else if (grant.state === "granted") {
      activeUsers.add(grant.requesterIdentityStoreId);
      const membershipId =
        grant.membershipId ?? byUser.get(grant.requesterIdentityStoreId);
      if (membershipId && Date.parse(grant.expiresAt) <= args.now) {
        plan.revoke.push({ grant, membershipId });
      }
    } else if (grant.state === "failed") {
      // A failed grant whose member is present is untracked access: the
      // membership write succeeded but the record could not resolve it (for
      // example, both the member-scoped and group listings lagged the write).
      // Revoke it; a failed revoke is an orphan and alarms.
      const membershipId = byUser.get(grant.requesterIdentityStoreId);
      if (membershipId) {
        activeUsers.add(grant.requesterIdentityStoreId);
        plan.revoke.push({ grant, membershipId });
      }
    }
  }

  for (const member of args.memberships) {
    if (!activeUsers.has(member.userId)) {
      plan.unmanaged.push(member);
    }
  }

  return plan;
};

/**
 * What an async approval should do about the per-requester active-grant lock.
 *
 * Slack retries a timed-out `block_actions`, so the same approve can be
 * delivered twice. The lock's conditional write already prevents a double
 * grant; this distinguishes our own retry from a genuinely different active
 * grant, so the retry is silent rather than posting a confusing "already
 * active" message. Pure so the tests cover it without AWS.
 */
export const activeGrantDecision = (args: {
  active: { requestId?: string; state?: string } | null;
  requestId: string;
}): "proceed" | "own-retry" | "other-active" => {
  if (args.active?.state === "active" && args.active.requestId) {
    return args.active.requestId === args.requestId
      ? "own-retry"
      : "other-active";
  }
  return "proceed";
};
