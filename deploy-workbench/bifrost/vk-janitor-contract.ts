/**
 * The reconciler's contract with the outside world: how often it runs, how long
 * a run may take, how long the deploy keeps retrying a throttled invoke, and
 * what one invocation returns.
 *
 * Step 4 of `docs/bifrost-reconciler.md`, and it is one module because these
 * four things are one decision each about a number another file has to agree
 * with. It is a plain module with no `@pulumi/aws`, no `fetch` and no AWS SDK: the
 * Pulumi program (`deploy-workbench/bifrost-vk-janitor.ts`), the Lambda's
 * summary (`bifrost/reconciler-summary.ts` has the classification, which
 * imports this for nothing) and the deploy's poll
 * (`deploy-workbench/scripts/verify-convergence.ts`) all read the same numbers,
 * and a Pulumi runtime in a workflow step or an SDK client in a unit test would
 * be the cost of splitting them. The Pulumi module imports and re-exports them,
 * so `VK_JANITOR_TIMEOUT_SECONDS` is still the one name for the number
 * everywhere, `bifrost-vk-janitor.test.ts` included.
 *
 * ## Why the interval is five minutes
 *
 * Open item 3 of `bifrost-virtual-keys.md` chose an hour for a revocation sweep
 * and said it was a design choice rather than a measurement. The reconciler
 * changes what the interval is for: decision 4 of the reconciler plan makes it
 * the bound on how long a person's governance override can sit unapplied, and
 * that is a number worth being small. Revocation at five minutes instead of
 * sixty costs a group read and a key list per tick and cannot take access away
 * from anyone who is still a member, so the faster cadence is harmless in the
 * direction that matters. It is also the answer to the argument for the hour —
 * that a job running often enough to page on pages for a bad reason — which the
 * alarm on three consecutive convergence failures (step 6) answers better than a
 * slower rule does.
 *
 * ## The three guards, and what each one is for
 *
 * The first was already here and its meaning changes with the interval. At an
 * hour, `timeout < interval` was nearly vacuous: a two-minute run overrunning its
 * hour was impossible in any way that mattered. At five minutes the same
 * statement is a real constraint, because `reservedConcurrentExecutions: 1`
 * means a run that outlives its interval does not just overlap the next one, it
 * makes every overlapping tick arrive as a throttle. So the guard is checked at
 * load, where a test catches a careless edit, and the number it protects (120s
 * against 300s) leaves a run the whole of its two-minute budget and still half
 * the interval spare.
 *
 * The second is new, and it exists because the deploy's invoke can collide with
 * a tick. A capped function has no queue: an invoke that arrives while a tick is
 * running is throttled rather than delayed, so the deploy retries for a window
 * that has to outlast the tick it is waiting behind. "Outlast the tick" is
 * `VK_JANITOR_TIMEOUT_SECONDS`, because a tick cannot hold the reservation
 * longer than its own timeout. A window at or below that number is a deploy that
 * gives up while the run it is waiting for is still legal, which reads as a
 * convergence failure and is not one. The guard refuses it at load, and
 * `vk-janitor-contract.test.ts` proves the refusal by calling the guard with the
 * bad number.
 *
 * The third is the positive-number check, which is not decoration: a negative or
 * zero window would otherwise satisfy neither comparison in a way that says what
 * is wrong.
 */

/**
 * The function's deployed name, which the deploy's invoke has to agree with.
 *
 * Here rather than only in the Pulumi module because the deploy's poll names the
 * function by this string and `scripts/verify-convergence.ts` cannot import a
 * Pulumi program. `bifrost-vk-janitor.ts` keeps its own `VK_JANITOR_NAME` and
 * `VK_JANITOR_FUNCTION_NAME` as the role and function names, and
 * `bifrost-vk-janitor.test.ts` asserts the two literals are equal: the
 * duplication is one string in two files pinned by a test, which is the shape
 * this repo already uses for the reader role's name and the discovery DNS name.
 */
export const VK_JANITOR_FUNCTION_NAME = "bifrost-vk-janitor";

/**
 * The shell the schedule runs on, kept below the interval so two runs do not
 * overlap by design. The work is a group read, a paged key list, at most one
 * `PUT` per managed key, and (since step 4) the config half's reads and writes;
 * two minutes is far more than that needs, and the ordering against the interval
 * is the point.
 */
export const VK_JANITOR_TIMEOUT_SECONDS = 120;

/** Decision 4: five minutes, down from the hour `bifrost-virtual-keys.md` chose. */
export const VK_JANITOR_INTERVAL_MINUTES = 5;

/**
 * Derived, so the rule and the documented number cannot disagree. The same
 * `rate()` expression the rule had; only the interval moved.
 */
export const VK_JANITOR_SCHEDULE_EXPRESSION = `rate(${VK_JANITOR_INTERVAL_MINUTES} minutes)`;

/**
 * How long the deploy keeps retrying a **throttled** invoke before it calls the
 * run "never ran".
 *
 * Sized above the timeout because that is the only thing it has to outlast: a
 * tick holds the function's single concurrency reservation for at most
 * `VK_JANITOR_TIMEOUT_SECONDS`, so a window longer than that cannot expire while
 * the collision is still legitimate. 300s against a 120s timeout is two and a
 * half times the worst case, which also covers the time the platform takes to
 * release the reservation, and it fits the deploy job's own budget beside the
 * service check's 600s (`deploy-workflow-order.test.ts` pins that sum against
 * the job's `timeout-minutes`).
 *
 * It is a *retry* window, not a run deadline: every attempt inside it is a
 * throttle, which returns in milliseconds. One successful invoke is one run of
 * up to `VK_JANITOR_TIMEOUT_SECONDS`.
 */
export const VK_JANITOR_RETRY_WINDOW_SECONDS = 300;

/**
 * The first backoff between throttled invokes, doubling to the cap below. A
 * collision is a tick finishing, so the first retry can be soon; the cap keeps a
 * long one from turning into a handful of slow probes.
 */
export const VK_JANITOR_RETRY_INITIAL_MS = 2_000;
export const VK_JANITOR_RETRY_MAX_MS = 15_000;

export type JanitorBudget = {
  readonly timeoutSeconds: number;
  readonly intervalMinutes: number;
  readonly retryWindowSeconds: number;
};

/**
 * What is wrong with a budget, in the words a failed load or a failed test
 * needs. Returned rather than thrown so the guard below and a test share one
 * statement of the rules.
 */
export const janitorBudgetProblems = (budget: JanitorBudget): string[] => {
  const problems: string[] = [];
  const { timeoutSeconds, intervalMinutes, retryWindowSeconds } = budget;

  if (!(timeoutSeconds > 0) || !(intervalMinutes > 0) || !(retryWindowSeconds > 0)) {
    problems.push(
      `every janitor budget number must be positive, got timeout ${timeoutSeconds}s, interval ${intervalMinutes}m, retry window ${retryWindowSeconds}s`,
    );
    return problems;
  }

  if (timeoutSeconds >= intervalMinutes * 60) {
    problems.push(
      `janitor timeout ${timeoutSeconds}s must be below the interval ${intervalMinutes}m: a run that outlives its interval overlaps the next one, and reservedConcurrentExecutions: 1 turns that overlap into a dropped invocation`,
    );
  }

  // The one this step adds. A window at or below the timeout expires while the
  // run the deploy is waiting behind is still inside its own legal runtime, so
  // a legitimate collision would be reported as a failed convergence.
  if (retryWindowSeconds <= timeoutSeconds) {
    problems.push(
      `the deploy's retry window ${retryWindowSeconds}s must be above the function timeout ${timeoutSeconds}s, or a throttled invoke that is waiting behind a legal run expires and the deploy reports a convergence failure that did not happen`,
    );
  }

  return problems;
};

/**
 * Fail at load on a budget that cannot hold, the way the timeout/interval check
 * always has: a Pulumi program that will not synthesize and a test that catches
 * it, rather than an apply that quietly schedules something impossible.
 */
export const assertJanitorBudget = (budget: JanitorBudget): void => {
  const problems = janitorBudgetProblems(budget);
  if (problems.length > 0) {
    throw new Error(`the reconciler's timing budget cannot hold: ${problems.join("; ")}`);
  }
};

assertJanitorBudget({
  timeoutSeconds: VK_JANITOR_TIMEOUT_SECONDS,
  intervalMinutes: VK_JANITOR_INTERVAL_MINUTES,
  retryWindowSeconds: VK_JANITOR_RETRY_WINDOW_SECONDS,
});

/**
 * The wait before retry number `attempt` (0 for the first retry): the initial
 * delay doubled per attempt, capped.
 *
 * Pure and exported because the backoff is a decision worth a test: a throttled
 * invoke must be retried, and the retries must not be able to spin, since each
 * one is an AWS call in a workflow step.
 */
export const retryDelayMs = (args: {
  attempt: number;
  initialMs?: number;
  maxMs?: number;
}): number => {
  const initial = args.initialMs ?? VK_JANITOR_RETRY_INITIAL_MS;
  const cap = args.maxMs ?? VK_JANITOR_RETRY_MAX_MS;
  if (args.attempt <= 0) return Math.min(initial, cap);
  return Math.min(initial * 2 ** args.attempt, cap);
};
