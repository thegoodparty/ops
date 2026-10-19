/**
 * The configuration schema and the reserved-target guard for the Google
 * Workspace -> IAM Identity Center group sync, step 2 of
 * `docs/google-group-sync.md`.
 *
 * The schema is copied from "Configuration" in that plan, deliberately as
 * types rather than an interface: the plan writes it as a `type`, and the
 * object literals the engineer fills in are `SyncPair`s. The one constant
 * here is the denylist that keeps the job off a group `sheriff` manages; the
 * `SyncPair[]` list itself lands with the SSM parameter in step 3, because a
 * pair is not authorized until its target group ARN is in the management-
 * account grant (`deploy/components/identity-group-sync-grant.ts`) and the
 * plan leaves the first real pair open (open question 7).
 *
 * Nothing in this file touches AWS or Google. It is imported by the pure
 * guards and by the read adapter so the reasons a pair aborts are one list,
 * not a string typed three times.
 */

/** `dry-run` computes and logs the diff and applies nothing. */
export type SyncMode = "dry-run" | "apply";

/**
 * Blast-radius cap. The run refuses to remove when either bound is exceeded.
 * Both are checked; the stricter wins (see `evaluateRemovalCap`).
 */
export type RemovalCap = {
  /** Absolute removals per run. */
  maxCount: number;
  /** 0..1 of the current target membership. */
  maxFraction: number;
};

export type SyncPair = {
  /** Stable id. The config key, the metric dimension and the log field. */
  id: string;
  /** The Google group whose `type == USER` members are the source of truth. */
  sourceGroupEmail: string;
  /**
   * The Identity Store group that mirrors it. Owned elsewhere; never created
   * here.
   */
  targetGroupId: string;
  mode: SyncMode;
  removalCap: RemovalCap;
  /**
   * Emails or domains (`@goodparty.org`) eligible to be provisioned into the
   * target. A member outside the list is logged and skipped.
   */
  allowlist: string[];
  /** Page on more than this many removals in one run; 0 pages on any. */
  removalAlertThreshold: number;
};

export type SyncConfig = {
  /**
   * The poll interval the heartbeat alarm is sized against, in seconds. A
   * multiple of 60 (CloudWatch's alarm period floor); the Lambda's timeout is
   * set below it so a run cannot overlap the next.
   */
  pollIntervalSeconds: number;
  pairs: SyncPair[];
};

/**
 * The groups this job must never target. `sheriff` grants time-boxed access
 * by adding `Admins` memberships (`docs/sheriff.md`); a strict mirror over
 * `Admins` would revert every grant on its next poll. A new sheriff-managed
 * group has to be added here in the same PR that teaches sheriff about it.
 *
 * The `Admins` literal is mirrored from `deploy/components/identity-center.ts`
 * and pinned by a test in `deploy-infrastructure/group-sync.test.ts`, the way
 * `deploy/sheriff-grant.test.ts` pins it, so the two cannot drift silently.
 */
export const RESERVED_TARGET_GROUP_IDS: readonly string[] = [
  "88c1b330-a001-707a-06ca-94e289013bf5", // Admins
];

/**
 * The reasons a pair aborts with `sync.aborted`. One union so the read
 * adapter, the guards and (in step 3) the handler agree on the vocabulary the
 * `Aborted` metric and the audit log key on.
 */
export type SyncAbortReason =
  | "invalid-config"
  | "reserved-target"
  | "source-read-failed"
  | "domain-wide-membership"
  | "ambiguous-user"
  | "removal-cap";
