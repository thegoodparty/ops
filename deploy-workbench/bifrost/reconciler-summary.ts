/**
 * What one reconciler run returns, and what a caller is allowed to conclude
 * from it.
 *
 * Step 4 of `docs/bifrost-reconciler.md`, and the contract between the Lambda
 * (`bifrost/vk-janitor-handler.ts`) and the deploy's poll
 * (`scripts/verify-convergence.ts`).
 *
 * ## Why the three states are separate
 *
 * Decision 5's argument is that a fire-and-forget invoke goes green over a
 * config that never landed, and step 6's alarm is on "runs that ran and did not
 * converge". Both are only meaningful if the reply distinguishes three things a
 * naive `InvokeFunction` reply conflates:
 *
 * - **`converged`** — the function ran and both loops found nothing left to do.
 *   This is the only state a deploy accepts.
 * - **`not-converged`** — the function ran and something did not converge: a
 *   write was refused, a read failed (an invocation the platform reports as a
 *   `FunctionError`), or a loop aborted because the group read came back empty.
 *   A deploy fails on this, and step 6's alarm counts it.
 * - **`never-ran`** — the function was never entered, because every invoke was
 *   throttled (`TooManyRequestsException`, a `429`, from the
 *   `reservedConcurrentExecutions: 1` cap colliding with a scheduled tick).
 *   Counted separately, because a pattern of them means the cadence and the
 *   deploy are fighting and the answer is a second rule, not a bigger cap.
 *
 * A throttle must never be reported as a convergence failure: it is a
 * scheduling collision, not a fact about the configuration, and a deploy that
 * goes red over one is red for a reason that has nothing to do with the change.
 *
 * ## Why this module is not in the Pulumi program or in the handler
 *
 * Both sides read it: the Lambda builds a summary, the workflow step classifies
 * one. Putting it in either would make the other import a Pulumi runtime or a
 * bundled ES module, so it is a plain module with no imports at all — and
 * therefore `reconciler-summary.test.ts` can prove the classification table
 * without AWS, a Lambda or a workflow.
 */

/** One loop's result, as the summary states it. */
export type LoopSummary = {
  /**
   * `aborted` is the empty-group case: the read succeeded and said "nobody",
   * which is a state to look at rather than a failure to retry into a
   * fleet-wide rewrite. It is a `not-converged` run from the deploy's point of
   * view, because nothing was applied.
   *
   * `not-run` is the scheduled tick's config half: decision 16 of the plan
   * bounds config convergence at a deploy, so the tick does not attempt it.
   */
  outcome: "converged" | "aborted" | "not-run";
  changed: number;
  unchanged: number;
  skipped: number;
};

export type RevocationSummary = {
  outcome: "ok" | "aborted";
  kept: number;
  deactivated: number;
  skipped: number;
};

/**
 * The run's own summary: what the function says it did.
 *
 * `outcome` is the field every caller reads. `governance`, `config` and
 * `revocation` are there so a failed run names which half failed without a
 * reader having to fetch a log line, and so the two halves are never collapsed
 * into one ambiguous count.
 */
export type ReconcilerSummary = {
  outcome: "converged" | "not-converged";
  /** Where the invocation came from, for the log line and the alarm's labels. */
  trigger: ReconcilerTrigger;
  revocation: RevocationSummary;
  governance: LoopSummary;
  config: LoopSummary;
};

/**
 * Who asked. The scheduled rule sends `{action: "reconcile"}`, the deploy sends
 * `{action: "reconcile", trigger: "deploy"}`, and anything else is `unknown`.
 *
 * It is a label, never a switch: the same work runs either way, because a
 * converged state is idempotent and a deploy that also re-converges governance
 * has done something useful rather than something surprising.
 */
export type ReconcilerTrigger = "schedule" | "deploy" | "unknown";

export const reconcilerTrigger = (event: unknown): ReconcilerTrigger => {
  if (typeof event !== "object" || event === null) return "unknown";
  const trigger = (event as Record<string, unknown>).trigger;
  return trigger === "deploy" ? "deploy" : trigger === "schedule" ? "schedule" : "unknown";
};

/**
 * The run's summary, from its parts.
 *
 * `converged` requires every loop that ran to say so. An abort is not a
 * convergence: nothing was written, so a deploy asserting `converged` would be
 * asserting something that did not happen.
 */
export const summarizeRun = (args: {
  trigger: ReconcilerTrigger;
  revocation: RevocationSummary;
  governance: LoopSummary;
  config: LoopSummary;
}): ReconcilerSummary => ({
  outcome:
    args.revocation.outcome === "ok" &&
    args.governance.outcome === "converged" &&
    configConverged(args) 
      ? "converged"
      : "not-converged",
  trigger: args.trigger,
  revocation: args.revocation,
  governance: args.governance,
  config: args.config,
});

/**
 * One `InvokeFunction` attempt, as the caller saw it.
 *
 * `throttled` is the `429` the platform returns before the function runs at
 * all. `function-error` is a `200` whose headers carry `FunctionError`: the
 * function ran and threw, which is a convergence failure and not a throttle.
 * `ok` is a run that returned a value, which still has to be read.
 */
export type InvokeAttempt =
  | { kind: "throttled"; message?: string }
  | { kind: "function-error"; message?: string }
  | { kind: "ok"; payload: unknown };

export type ReconcilerDecision =
  /** The function ran and converged. The deploy may go green. */
  | { kind: "converged"; summary: ReconcilerSummary }
  /** The function ran and did not converge. The deploy fails. */
  | { kind: "not-converged"; reason: string; summary?: ReconcilerSummary }
  /** The function was not entered. Retry inside the window. */
  | { kind: "retry"; reason: string };

/**
 * Whether the config half satisfies the run.
 *
 * A `not-run` config half is fine for a scheduled tick, because decision 16 makes
 * the deploy the trigger that owns config convergence. It is **not** fine for a
 * deploy: a deploy that asked for the config half and did not get it is a run
 * that did not converge, and going green there would be the fire-and-forget bug
 * with the trigger written down.
 */
const configConverged = (args: {
  trigger: ReconcilerTrigger;
  config: LoopSummary;
}): boolean =>
  args.config.outcome === "converged" ||
  (args.config.outcome === "not-run" && args.trigger !== "deploy");

/** A summary if the value looks like one, otherwise `undefined`. */
export const parseReconcilerSummary = (
  payload: unknown,
): ReconcilerSummary | undefined => {
  const value =
    typeof payload === "string"
      ? (() => {
          try {
            return JSON.parse(payload) as unknown;
          } catch {
            return undefined;
          }
        })()
      : payload;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  return candidate.outcome === "converged" || candidate.outcome === "not-converged"
    ? (candidate as ReconcilerSummary)
    : undefined;
};

/**
 * What one attempt means. The whole classification table, in one pure function,
 * so the 429-is-not-a-failure rule is a test rather than a comment.
 */
export const decideInvokeAttempt = (
  attempt: InvokeAttempt,
): ReconcilerDecision => {
  if (attempt.kind === "throttled") {
    // The one case that must never read as a convergence failure. The caller
    // retries, and only the exhausted window makes it `never-ran`.
    return {
      kind: "retry",
      reason: `the invoke was throttled (${attempt.message ?? "TooManyRequestsException"}); a scheduled tick holds the function's single concurrency reservation`,
    };
  }

  if (attempt.kind === "function-error") {
    return {
      kind: "not-converged",
      reason: `the run threw (${attempt.message ?? "FunctionError"})`,
    };
  }

  const summary = parseReconcilerSummary(attempt.payload);
  if (!summary) {
    // A run that returned nothing readable did not say it converged, and going
    // green on an empty reply is the fire-and-forget bug with one more step.
    return {
      kind: "not-converged",
      reason: "the run returned no summary, so it cannot be read as converged",
    };
  }
  if (summary.outcome !== "converged") {
    const aborted = summary.governance.outcome === "aborted"
      ? " (the governance loop aborted: the group read returned nobody)"
      : "";
    return {
      kind: "not-converged",
      reason: `the run reported ${summary.outcome}${aborted}`,
      summary,
    };
  }
  return { kind: "converged", summary };
};

/**
 * The outcome of the whole retry loop: either a decision, or `never-ran` when
 * the window expired with nothing but throttles.
 *
 * Separate from `decideInvokeAttempt` because the distinction is about the
 * caller's budget rather than about one attempt, and the deploy's log has to say
 * "never ran" in exactly the case where saying "did not converge" would be a
 * lie about what the function did.
 */
export type PollOutcome =
  | { kind: "converged"; summary: ReconcilerSummary }
  | { kind: "not-converged"; reason: string; summary?: ReconcilerSummary }
  | { kind: "never-ran"; reason: string; attempts: number };

export const pollOutcome = (args: {
  decisions: readonly ReconcilerDecision[];
  windowExpired: boolean;
}): PollOutcome => {
  const decided = args.decisions.find((entry) => entry.kind !== "retry");
  if (decided && decided.kind === "converged") {
    return { kind: "converged", summary: decided.summary };
  }
  if (decided && decided.kind === "not-converged") {
    return {
      kind: "not-converged",
      reason: decided.reason,
      ...(decided.summary ? { summary: decided.summary } : {}),
    };
  }
  if (!args.windowExpired) {
    // The caller asked too early: not a verdict, and never silently green.
    return {
      kind: "never-ran",
      reason: "the retry window has not expired, so nothing has been decided yet",
      attempts: args.decisions.length,
    };
  }
  const last = args.decisions.at(-1);
  return {
    kind: "never-ran",
    reason: `every one of ${args.decisions.length} attempt(s) was throttled and the window expired${
      last && last.kind === "retry" ? `: ${last.reason}` : ""
    }`,
    attempts: args.decisions.length,
  };
};
