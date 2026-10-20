/**
 * The configuration schema and the reserved-target guard for the Google
 * Workspace -> IAM Identity Center group sync, step 2 of
 * `docs/google-group-sync.md`.
 *
 * The schema is copied from "Configuration" in that plan, deliberately as
 * types rather than an interface: the plan writes it as a `type`, and the
 * object literals below are `SyncPair`s. The denylist that keeps the job off
 * a group `sheriff` manages lives here too, and so does the pair list itself,
 * which landed with the SSM parameter in step 3: a pair is not authorized
 * until its target group ARN is in the management-account grant
 * (`deploy/components/identity-group-sync-grant.ts`), so the two are reviewed
 * together.
 *
 * Nothing in this file touches AWS or Google. It is imported by the pure
 * guards, by the read adapter and by the Lambda's bundle so the reasons a
 * pair aborts are one list, not a string typed three times, and so the
 * reserved-target list the handler re-asserts is the same one the config is
 * validated against.
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
  | "removal-cap"
  // Added in step 3, because the plan's list stopped at the guards and the
  // runtime needs a reason for the two failures it can also hit: a failed
  // directory read (AssumeRole, `GetUserId`, `ListGroupMemberships`) and a
  // write that still failed after the throttling retries. Both abort the pair
  // and neither is safe to fold into another reason, because the alarm's
  // `Reason` dimension is how an operator tells "the source is unreadable"
  // from "the directory is unreadable" without opening the log group.
  | "identity-read-failed"
  | "apply-failed";

/**
 * The poll interval, in seconds. **Placeholder** (open question 5): the plan
 * fixes the shape -- an interval in the config, a multiple of 60, with the
 * Lambda's timeout below it -- and leaves the number open until the first
 * group's size is known. Fifteen minutes is the placeholder, and changing it
 * is this one line: the EventBridge rule, the alarm periods and the function
 * timeout are all derived from it.
 */
export const POLL_INTERVAL_SECONDS = 15 * 60;

/**
 * The `Approvers` Identity Center group's id, added for the `approvers-google`
 * pair below: the `Engineering Admin` Workspace group
 * (`eng-admin@goodparty.org`) mirrors it.
 *
 * A literal for the same reason the `Engineers` id is one: it is a stable
 * Identity Center id recorded from the group as it exists in AWS. The group was
 * created out of band, in the console, and stays that way -- group existence is
 * not this job's business (non-goal 7 in `docs/google-group-sync.md`), so this
 * change deliberately adds no Pulumi resource for it. If that is ever revisited
 * and the group is brought under Pulumi, this becomes an `Output` and nothing
 * else changes.
 *
 * The id is also named as an ARN in `TARGET_GROUP_ARNS`
 * (`deploy/components/identity-group-sync-grant.ts`), which is "Adding a pair"
 * step 2: without it the assumed role is not authorized for the group's
 * memberships.
 */
const APPROVERS_GROUP_ID = "e841e310-0051-7062-2ea4-9905d12f345e";

/**
 * The first real pair, resolved by the engineer in step 3 (open question 7):
 * the `engineering@goodparty.org` Workspace group mirrors the `Engineers`
 * Identity Center group, whose id and ARN are already in the merged grant
 * (`deploy/components/identity-group-sync-grant.ts`).
 *
 * `id` is the config key, the CloudWatch dimension and the log field, so it is
 * stable and does not follow the source group's exact spelling; the source is
 * `engineering@` (the Workspace group's name) and the target is `Engineers`
 * (the Identity Center group's name).
 *
 * `mode` is `apply`, the reviewed change of "Rollout" step 4. The pair shipped
 * `dry-run` first, and the dry run against the real group that was reviewed
 * before this flip reported 9 source members, 11 target members, 2 removals, 0
 * additions and `removalCapTripped: false`, so the first apply is that same
 * removal and nothing else. `runPair` returns before any write unless the mode
 * is `apply`, which is why the mode is the whole change.
 *
 * The second entry is the `Engineering Admin` Workspace group
 * (`eng-admin@goodparty.org`) mirroring the `Approvers` Identity Center group,
 * as a parallel sync: same id shape (`<target>-google`), same cap, same alert
 * threshold, same allowlist. It ships `dry-run` because that is "Adding a pair"
 * step 4 -- every pair starts there, and a reviewed dry-run diff is what
 * justifies flipping it to `apply`, exactly as the first pair did in PR #351.
 * The flip is a separate reviewed change; nothing here writes until it lands.
 *
 * The cap and alert threshold are the plan's defaults (`maxCount: 5`,
 * `maxFraction: 0.1`, `removalAlertThreshold: 0`), still placeholders for the
 * same reason as the interval. The allowlist is the organization's domain, as
 * the plan's worked example writes it: a source member outside it is skipped
 * and, because the mirror is strict, removed from the target if present, so it
 * must be a superset of intended membership.
 */
export const SYNC_PAIRS: readonly SyncPair[] = [
  {
    id: "engineers-google",
    sourceGroupEmail: "engineering@goodparty.org",
    targetGroupId: "383193a0-7001-70d9-a321-ffe6d8af7378", // Engineers
    mode: "apply",
    removalCap: { maxCount: 5, maxFraction: 0.1 },
    allowlist: ["@goodparty.org"],
    removalAlertThreshold: 0,
  },
  {
    id: "approvers-google",
    sourceGroupEmail: "eng-admin@goodparty.org",
    targetGroupId: APPROVERS_GROUP_ID, // Approvers
    mode: "dry-run",
    removalCap: { maxCount: 5, maxFraction: 0.1 },
    allowlist: ["@goodparty.org"],
    removalAlertThreshold: 0,
  },
];

/**
 * What Pulumi writes to `/identity-group-sync/pairs` and the Lambda reads at
 * each run. `pairs` is a copy so the exported array is not aliased into the
 * parameter's JSON by a consumer that mutates it.
 */
export const SYNC_CONFIG: SyncConfig = {
  pollIntervalSeconds: POLL_INTERVAL_SECONDS,
  pairs: [...SYNC_PAIRS],
};
