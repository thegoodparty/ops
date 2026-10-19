/**
 * The pure half of the guards in section 6 of `docs/google-group-sync.md`.
 *
 * These are the checks that decide whether a pair may write, expressed as
 * functions over values so they can be unit-tested without credentials. The
 * handler (step 3) calls them and turns a trip into `sync.aborted`; it must
 * not re-derive the arithmetic, because the two definitions of "the cap
 * trips" drifting apart is exactly how a large removal gets through.
 */
import {
  RESERVED_TARGET_GROUP_IDS,
  type RemovalCap,
} from "./config";

/**
 * Whether the target group is one this job must never touch. The reserved
 * list is the `Admins` group today; the check is re-asserted adjacent to the
 * writes (section 6) even though step 1 of the algorithm checks it too.
 */
export const isReservedTarget = (targetGroupId: string): boolean =>
  RESERVED_TARGET_GROUP_IDS.includes(targetGroupId);

export type RemovalCapEvaluation = {
  /** True when the run must abort and apply nothing, including the adds. */
  tripped: boolean;
  removalCount: number;
  targetCount: number;
  /** The absolute bound from the config. */
  maxCount: number;
  /** `ceil(maxFraction * targetCount)`, the fraction bound. */
  fractionBound: number;
  /** The stricter of the two bounds: the most removals an apply would allow. */
  allowedRemovals: number;
};

/**
 * Evaluates the removal cap. The plan: "The cap trips when `n > maxCount` or
 * `n > ceil(maxFraction * t)`." Both are checked and the stricter wins, which
 * is the same as `n > min(maxCount, ceil(maxFraction * t))`.
 *
 * The cap trips the whole pair, not only the removals, so the caller applies
 * nothing when `tripped` is true. It is still evaluated in `dry-run` mode, so
 * the rollout review can see whether an apply would have been allowed.
 */
export const evaluateRemovalCap = (
  removalCount: number,
  targetCount: number,
  cap: RemovalCap,
): RemovalCapEvaluation => {
  const fractionBound = Math.ceil(cap.maxFraction * targetCount);
  const allowedRemovals = Math.min(cap.maxCount, fractionBound);
  return {
    tripped: removalCount > allowedRemovals,
    removalCount,
    targetCount,
    maxCount: cap.maxCount,
    fractionBound,
    allowedRemovals,
  };
};
