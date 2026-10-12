/**
 * Pure request/decision logic for the break-glass dry run. No AWS and no Slack
 * here, so it is what the tests exercise directly; `handler.ts` is the wiring.
 *
 * Step 3 stops at the decision. The record written on approval is `approved`,
 * not `granting`: it records that a human said yes and nothing more. Step 4
 * replaces that transition with `granting` -> `granted` and the
 * `CreateGroupMembership` call. `docs/break-glass.md`, "States", is the
 * authoritative machine.
 */
import { randomUUID } from "node:crypto";

import {
  APPROVER_SLACK_USER_IDS,
  DURATION_OPTIONS,
  MAX_DURATION_SECONDS,
  MAX_REQUESTS_PER_DAY,
} from "./config";

/**
 * `approved` is dry-run-only. It exists so the decision is a recorded state
 * rather than a mutable flag on `requested`; step 4 stops writing it and
 * starts writing `granting`/`granted`.
 */
export type RequestState = "requested" | "approved" | "denied";

export type Decision = "approved" | "denied";

export type RequestRecord = {
  id: string;
  state: RequestState;
  requesterSlackId: string;
  requesterIdentityStoreId: string;
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
  /** Always true in step 3; the dry run is the point. */
  dryRun?: boolean;
  /** DynamoDB TTL, retention only. */
  ttl?: number;
};

export const REQUEST_PK_PREFIX = "REQUEST#";
export const RATE_PK_PREFIX = "RATE#";
export const RECORD_SK = "META";

export const requestPk = (id: string) => `${REQUEST_PK_PREFIX}${id}`;
export const ratePk = (slackUserId: string, date: string) =>
  `${RATE_PK_PREFIX}${slackUserId}#${date}`;

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
 * step 4; there is no grant here to guard.
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
