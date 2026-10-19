/**
 * The sync algorithm of `docs/google-group-sync.md`, step 3's runtime half.
 *
 * One function per pair, called sequentially by `handler.ts`, each in its own
 * try/catch so one pair's failure does not stop the others. The sequence is the
 * plan's, in its order:
 *
 *   1. validate the pair (the config envelope is validated before this)
 *   2. fetch the source completely or not at all (`./source`)
 *   3. resolve source emails to Identity Store users (`./identity`)
 *   4. fetch the target memberships, every page
 *   5. diff (`./diff`, pure)
 *   6. guards: reserved target, dry-run, removal cap (`./guards`, pure)
 *   7. apply in order: create users, add memberships, remove memberships
 *   8. record the run: metrics, audit events, and the heartbeat on success only
 *
 * Everything here is dependency-injected -- a `DirectoryClient`, an
 * `IdentityDirectory`, a metrics sink, a logger and a clock -- so the tests can
 * assert the property the whole job hangs on (a failed or partial source read
 * produces **no** writes at all) without reaching Google or AWS.
 *
 * The invariant behind the ordering at step 7: create, then add, then remove
 * means the group is never temporarily smaller than the union of source and
 * target, so a crash partway leaves extra access, not missing access.
 */
import {
  RESERVED_TARGET_GROUP_IDS,
  type SyncAbortReason,
  type SyncConfig,
  type SyncMode,
  type SyncPair,
} from "./config";
import { diff, type SourceMember, type TargetMembership, type Diff } from "./diff";
import { isSyncAbortError, SyncAbortError } from "./errors";
import {
  evaluateRemovalCap,
  isReservedTarget,
  type RemovalCapEvaluation,
} from "./guards";
import type { IdentityDirectory } from "./identity";
import { emailRef, type Logger } from "./log";
import { METRIC_NAMES, type Metrics } from "./metrics";
import { SourceReadError, fetchSourceMembers, type DirectoryClient } from "./source";

/**
 * A syntactically valid address. Deliberately not RFC 5322: the check is there
 * to catch a typo in a config literal, and the pair's `sourceGroupEmail` is
 * also required to resolve via `groups.get`, which is the real check.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What one pair did, for the handler's return value and the tests. */
export type PairCounts = {
  sourceMembers: number;
  targetMembers: number;
  toCreate: number;
  added: number;
  removed: number;
  failed: number;
  skipped: number;
  /** What an apply would have done; equal to `added`/`removed` outside a dry-run. */
  wouldAdd: number;
  wouldRemove: number;
};

export type PairOutcome = {
  pairId: string;
  mode: SyncMode;
  aborted: { reason: SyncAbortReason; detail: string } | null;
  counts: PairCounts;
  durationMs: number;
};

const emptyCounts = (): PairCounts => ({
  sourceMembers: 0,
  targetMembers: 0,
  toCreate: 0,
  added: 0,
  removed: 0,
  failed: 0,
  skipped: 0,
  wouldAdd: 0,
  wouldRemove: 0,
});

/**
 * The per-pair config check of step 1. Returns the problems rather than
 * throwing, so the caller can log them all in one `sync.aborted` line and move
 * on to the next pair; a pair that fails validation is skipped loudly, never
 * silently.
 */
export const validatePair = (
  pair: unknown,
  seenIds: ReadonlySet<string> = new Set(),
): string[] => {
  const problems: string[] = [];
  if (typeof pair !== "object" || pair === null) return ["pair is not an object"];
  const candidate = pair as Partial<SyncPair>;

  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    problems.push("id is missing");
  } else if (seenIds.has(candidate.id)) {
    problems.push(`id ${candidate.id} is duplicated`);
  }

  if (
    typeof candidate.sourceGroupEmail !== "string" ||
    !EMAIL_PATTERN.test(candidate.sourceGroupEmail.trim())
  ) {
    problems.push("sourceGroupEmail is not a valid address");
  }

  if (candidate.mode !== "dry-run" && candidate.mode !== "apply") {
    problems.push(`mode ${JSON.stringify(candidate.mode)} is not dry-run or apply`);
  }

  if (
    typeof candidate.targetGroupId !== "string" ||
    !candidate.targetGroupId.trim()
  ) {
    problems.push("targetGroupId is missing");
  }
  // The reserved-target check is deliberately not here: a pair naming `Admins`
  // is well-formed config, and the plan pins the abort reason to
  // `reserved-target` rather than `invalid-config`. `runSync` checks it before
  // validation, and `runPair` re-asserts it adjacent to the writes.

  const cap = candidate.removalCap;
  if (typeof cap !== "object" || cap === null) {
    problems.push("removalCap is missing");
  } else {
    if (!Number.isInteger(cap.maxCount) || cap.maxCount < 0) {
      problems.push("removalCap.maxCount must be a non-negative integer");
    }
    if (
      typeof cap.maxFraction !== "number" ||
      !Number.isFinite(cap.maxFraction) ||
      cap.maxFraction < 0 ||
      cap.maxFraction > 1
    ) {
      problems.push("removalCap.maxFraction must be between 0 and 1");
    }
  }

  if (
    !Array.isArray(candidate.allowlist) ||
    candidate.allowlist.length === 0 ||
    candidate.allowlist.some(
      (entry) => typeof entry !== "string" || !entry.trim(),
    )
  ) {
    problems.push("allowlist must be a non-empty list of addresses or domains");
  }

  if (
    !Number.isInteger(candidate.removalAlertThreshold) ||
    (candidate.removalAlertThreshold ?? -1) < 0
  ) {
    problems.push("removalAlertThreshold must be a non-negative integer");
  }

  return problems;
};

/**
 * Parses the SSM parameter's value. Only the envelope is checked here; the
 * pairs are validated one at a time by `runSync` so a single bad pair cannot
 * take the whole invocation down with it.
 *
 * `pollIntervalSeconds` is checked against the plan's rule -- a multiple of 60
 * (CloudWatch's alarm period floor) -- because the alarms' periods are derived
 * from it, and an interval CloudWatch cannot express would be an apply-time
 * surprise rather than a runtime one.
 */
export const parseSyncConfig = (raw: string): SyncConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyncAbortError("invalid-config", "config is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SyncAbortError("invalid-config", "config is not an object");
  }
  const config = parsed as Partial<SyncConfig>;
  const interval = config.pollIntervalSeconds;
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval <= 0 ||
    interval % 60 !== 0
  ) {
    throw new SyncAbortError(
      "invalid-config",
      "pollIntervalSeconds must be a positive multiple of 60",
    );
  }
  if (!Array.isArray(config.pairs)) {
    throw new SyncAbortError("invalid-config", "pairs is not a list");
  }
  return { pollIntervalSeconds: interval, pairs: config.pairs };
};

/** Everything a single pair needs, injected so the tests can fake it. */
export type PairDeps = {
  directory: DirectoryClient;
  identity: IdentityDirectory;
  metrics: Metrics;
  log: Logger;
  now: () => number;
};

const errorDetail = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Runs one pair. Never throws: every failure becomes an abort in the returned
 * outcome, because the caller's loop has other pairs to get to.
 */
export const runPair = async (
  pair: SyncPair,
  deps: PairDeps & { overrideRemovalCap?: boolean },
): Promise<PairOutcome> => {
  const { directory, identity, metrics, log, now } = deps;
  const startedAt = now();
  const counts = emptyCounts();
  let aborted: PairOutcome["aborted"] = null;
  let cap: RemovalCapEvaluation | null = null;
  /** Whether the run got as far as the diff, so the counts mean something. */
  let reachedDiff = false;

  log("sync.started", {
    pairId: pair.id,
    groupId: pair.targetGroupId,
    sourceGroupEmail: pair.sourceGroupEmail,
    mode: pair.mode,
  });

  try {
    // Step 6's reserved-target guard, asserted again at step 1 of the single
    // pair so a hand-written SSM value cannot reach the writes below.
    if (isReservedTarget(pair.targetGroupId)) {
      throw new SyncAbortError(
        "reserved-target",
        `group ${pair.targetGroupId} is managed by sheriff and is never a sync target`,
      );
    }

    // Step 2: completely or not at all. A throw here means the pair applies
    // nothing, and the fake in the tests asserts that no write call follows.
    const source = await fetchSourceMembers({
      client: directory,
      groupEmail: pair.sourceGroupEmail,
      allowlist: pair.allowlist,
    });
    counts.skipped = source.skipped.length;
    for (const skipped of source.skipped) {
      log("member.skipped", {
        pairId: pair.id,
        groupId: pair.targetGroupId,
        memberType: skipped.type,
        reason: skipped.reason,
        // Domain only: the plan's logging rule is that membership is personal
        // data and the logs say so by not containing it.
        domain: skipped.domain,
      });
    }

    // Step 3: resolve each source email to a user id, null meaning "create it".
    const sourceMembers: SourceMember[] = [];
    for (const email of source.emails) {
      const userId = await identity.resolveUserId(email);
      sourceMembers.push({ email, userId });
    }

    // Step 4: the whole target, paginated.
    const target: TargetMembership[] = await identity.listMemberships();

    // Step 5: the pure diff.
    const result: Diff = diff(sourceMembers, target);
    reachedDiff = true;
    counts.sourceMembers = sourceMembers.length;
    counts.targetMembers = target.length;
    counts.toCreate = result.toCreate.length;
    counts.wouldAdd = result.add.length;
    counts.wouldRemove = result.remove.length;

    // Step 6: the removal cap, evaluated in both modes so the rollout review
    // can see whether an apply would have been allowed.
    cap = evaluateRemovalCap(result.remove.length, target.length, pair.removalCap);
    if (cap.tripped) {
      log("removal_cap.tripped", {
        pairId: pair.id,
        groupId: pair.targetGroupId,
        removalCount: cap.removalCount,
        targetCount: cap.targetCount,
        maxCount: cap.maxCount,
        fractionBound: cap.fractionBound,
        allowedRemovals: cap.allowedRemovals,
        overridden: Boolean(deps.overrideRemovalCap),
        dryRun: pair.mode === "dry-run",
      });
      // The cap trips the whole pair, not just the removals: a large removal
      // means the source is not what we think it is, and the safe action is to
      // change nothing, including the adds.
      if (pair.mode !== "dry-run" && !deps.overrideRemovalCap) {
        throw new SyncAbortError(
          "removal-cap",
          `${cap.removalCount} removals exceeds the allowed ${cap.allowedRemovals} of ${cap.targetCount}`,
        );
      }
    }

    // Dry-run: log the diff and apply nothing. The would-be counts go in the
    // log and in `wouldAdd`/`wouldRemove`; `Added`/`Removed` stay zero because
    // nothing happened, and the removals alarm must not page on a rehearsal.
    if (pair.mode === "dry-run") {
      return finish();
    }

    // Step 6 again, adjacent to the writes it protects.
    if (isReservedTarget(pair.targetGroupId)) {
      throw new SyncAbortError(
        "reserved-target",
        `group ${pair.targetGroupId} is managed by sheriff and is never a sync target`,
      );
    }

    // Step 7, in the plan's order: create, add, remove.
    const userIds = new Map<string, string>();
    for (const member of sourceMembers) {
      if (member.userId) userIds.set(member.email, member.userId);
    }

    for (const email of result.toCreate) {
      try {
        // `createUser` re-resolves immediately before creating, and treats a
        // conflict-plus-resolve as success (see ./identity).
        const userId = await identity.createUser(email);
        userIds.set(email, userId);
        log("user.created", {
          pairId: pair.id,
          groupId: pair.targetGroupId,
          userId,
          emailRef: emailRef(email),
        });
      } catch (err) {
        counts.failed += 1;
        log("member.skipped", {
          pairId: pair.id,
          groupId: pair.targetGroupId,
          memberType: "USER",
          reason: "create-failed",
          domain: email.split("@")[1] ?? "",
          error: errorDetail(err),
        });
        // An ambiguous user is not a per-member failure to retry: it means the
        // store holds an email this job cannot address, and continuing could
        // duplicate a person. Abort the pair.
        if (isSyncAbortError(err) && err.reason === "ambiguous-user") throw err;
      }
    }

    for (const member of result.add) {
      const userId = member.userId ?? userIds.get(member.email);
      if (!userId) continue; // The create failed and was already counted.
      try {
        await identity.addMembership(userId);
        counts.added += 1;
        log("member.added", {
          pairId: pair.id,
          groupId: pair.targetGroupId,
          userId,
        });
      } catch (err) {
        counts.failed += 1;
        log("member.skipped", {
          pairId: pair.id,
          groupId: pair.targetGroupId,
          memberType: "USER",
          reason: "add-failed",
          userId,
          error: errorDetail(err),
        });
      }
    }

    for (const membership of result.remove) {
      try {
        await identity.removeMembership(membership.membershipId);
        counts.removed += 1;
        log("member.removed", {
          pairId: pair.id,
          groupId: pair.targetGroupId,
          userId: membership.userId,
        });
      } catch (err) {
        counts.failed += 1;
        log("member.skipped", {
          pairId: pair.id,
          groupId: pair.targetGroupId,
          memberType: "USER",
          reason: "remove-failed",
          userId: membership.userId,
          error: errorDetail(err),
        });
      }
    }

    if (counts.failed > 0) {
      // The group is not the strict mirror the goal asks for, so the run is
      // not a success and must not emit the heartbeat. Every step is
      // idempotent, so the next interval's full retry converges.
      throw new SyncAbortError(
        "apply-failed",
        `${counts.failed} writes failed after retries`,
      );
    }

    return finish();
  } catch (err) {
    aborted = isSyncAbortError(err)
      ? { reason: err.reason, detail: err.detail }
      : err instanceof SourceReadError
        ? { reason: err.reason, detail: err.message }
        : { reason: "apply-failed", detail: errorDetail(err) };
    return finish();
  }

  function finish(): PairOutcome {
    const durationMs = Math.max(0, now() - startedAt);
    const outcome: PairOutcome = {
      pairId: pair.id,
      mode: pair.mode,
      aborted,
      counts,
      durationMs,
    };

    const values: Parameters<Metrics["put"]>[1] = [];
    if (reachedDiff) {
      values.push(
        { name: METRIC_NAMES.sourceMemberCount, value: counts.sourceMembers },
        { name: METRIC_NAMES.targetMemberCount, value: counts.targetMembers },
        { name: METRIC_NAMES.toCreate, value: counts.toCreate },
        { name: METRIC_NAMES.added, value: counts.added },
        { name: METRIC_NAMES.removed, value: counts.removed },
        { name: METRIC_NAMES.failed, value: counts.failed },
        { name: METRIC_NAMES.skipped, value: counts.skipped },
      );
    }
    if (cap?.tripped) {
      values.push({ name: METRIC_NAMES.removalCapTripped, value: 1 });
    }
    if (aborted) {
      values.push({
        name: METRIC_NAMES.aborted,
        value: 1,
        dimensions: { Reason: aborted.reason },
      });
    } else {
      // The heartbeat. Absent on an abort, which is what the dead-man's alarm
      // is for.
      values.push({ name: METRIC_NAMES.success, value: 1 });
    }
    values.push({
      name: METRIC_NAMES.runDurationMs,
      value: durationMs,
      unit: "Milliseconds",
    });
    metrics.put(pair.id, values);

    if (aborted) {
      log("sync.aborted", {
        pairId: pair.id,
        groupId: pair.targetGroupId,
        reason: aborted.reason,
        detail: aborted.detail,
        mode: pair.mode,
        ...counts,
        durationMs,
      });
    } else {
      log("sync.completed", {
        pairId: pair.id,
        groupId: pair.targetGroupId,
        mode: pair.mode,
        removalCapTripped: Boolean(cap?.tripped),
        overridden: Boolean(deps.overrideRemovalCap),
        ...counts,
        durationMs,
      });
    }
    return outcome;
  }
};

/**
 * Runs every configured pair, sequentially.
 *
 * An `override` naming a pair restricts the invocation to that pair; the
 * override is an invocation payload rather than a config field, so it cannot
 * be left on by accident, and it needs `lambda:InvokeFunction` on the
 * function (the plan's "Override"). It is recorded in the audit log with the
 * counts it let through; CloudTrail holds the operator's identity.
 */
export const runSync = async (options: {
  config: SyncConfig;
  directory: DirectoryClient;
  identityFor: (pair: SyncPair) => IdentityDirectory;
  metrics: Metrics;
  log: Logger;
  now: () => number;
  override?: { pairId?: string; overrideRemovalCap?: boolean };
}): Promise<PairOutcome[]> => {
  const { config, metrics, log, now } = options;
  const outcomes: PairOutcome[] = [];
  const seen = new Set<string>();

  /**
   * Records a pair that never ran: its own `Aborted` metric, one audit line,
   * and an outcome the caller can assert on. Shared by the reserved-target and
   * invalid-config paths so they cannot drift in what they record.
   */
  const recordAbort = (
    pairId: string,
    mode: SyncMode,
    reason: SyncAbortReason,
    detail: string,
  ): void => {
    log("sync.aborted", { pairId, reason, detail });
    metrics.put(pairId, [
      { name: METRIC_NAMES.aborted, value: 1, dimensions: { Reason: reason } },
    ]);
    outcomes.push({
      pairId,
      mode,
      aborted: { reason, detail },
      counts: emptyCounts(),
      durationMs: 0,
    });
  };

  for (const pair of config.pairs) {
    const pairId = typeof pair?.id === "string" ? pair.id : "(missing)";
    if (options.override?.pairId && options.override.pairId !== pairId) {
      continue;
    }

    const mode = (pair?.mode ?? "dry-run") as SyncMode;

    // The reserved-target invariant, before anything reads the source. A pair
    // naming `Admins` is a valid-looking config entry, so it aborts with
    // `reserved-target` rather than the `invalid-config` a malformed pair gets.
    if (
      typeof pair?.targetGroupId === "string" &&
      isReservedTarget(pair.targetGroupId)
    ) {
      recordAbort(
        pairId,
        mode,
        "reserved-target",
        `group ${pair.targetGroupId} is managed by sheriff and is never a sync target`,
      );
      if (typeof pair?.id === "string") seen.add(pair.id);
      continue;
    }

    const problems = validatePair(pair, seen);
    if (typeof pair?.id === "string") seen.add(pair.id);
    if (problems.length > 0) {
      // A bad pair is skipped loudly, and the next pair still runs.
      recordAbort(pairId, mode, "invalid-config", problems.join("; "));
      continue;
    }

    outcomes.push(
      await runPair(pair, {
        directory: options.directory,
        identity: options.identityFor(pair),
        metrics,
        log,
        now,
        overrideRemovalCap:
          options.override?.pairId === pair.id &&
          options.override?.overrideRemovalCap === true,
      }),
    );
  }

  return outcomes;
};

/**
 * The reserved-target list, re-exported so `handler.ts`'s comments and the
 * tests can name one import for "the list the handler re-asserts" rather than
 * reaching into the config module from three places.
 */
export { RESERVED_TARGET_GROUP_IDS };
