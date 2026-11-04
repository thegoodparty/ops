import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideInvokeAttempt,
  parseReconcilerSummary,
  pollOutcome,
  reconcilerTrigger,
  summarizeRun,
  type ReconcilerSummary,
} from "./reconciler-summary";

/**
 * The contract between one reconciler run and whatever reads its result.
 *
 * The three acceptance-relevant rules the plan's step 4 names, each a test:
 *
 * 1. A throttle is **not** a convergence failure. It is a retry, and only an
 *    exhausted window turns it into `never-ran`.
 * 2. A run that ran and did not converge fails: a `FunctionError`, a summary
 *    whose `outcome` is `not-converged`, or no readable summary at all.
 * 3. The three states stay distinguishable, which is what step 6's alarm needs:
 *    a run that ran and converged, a run that ran and did not, and a run that
 *    never happened.
 */

const loop = (outcome: "converged" | "aborted" = "converged") => ({
  outcome,
  changed: 0,
  unchanged: 1,
  skipped: 0,
});

const summary = (
  overrides: Partial<ReconcilerSummary> = {},
): ReconcilerSummary => ({
  outcome: "converged",
  trigger: "deploy",
  revocation: { outcome: "ok", kept: 1, deactivated: 0, skipped: 0 },
  governance: loop(),
  config: loop(),
  ...overrides,
});

describe("a throttled invoke", () => {
  it("is a retry, never a failed convergence", () => {
    // The acceptance criterion, directly: the 429 from the
    // `reservedConcurrentExecutions: 1` cap colliding with a scheduled tick.
    const decision = decideInvokeAttempt({ kind: "throttled" });
    assert.equal(decision.kind, "retry");
    assert.match(
      (decision as { reason: string }).reason,
      /throttled/,
    );
  });

  it("is named as a throttle, so a run log reading the reason can tell the two apart", () => {
    const decision = decideInvokeAttempt({
      kind: "throttled",
      message: "TooManyRequestsException",
    });
    assert.equal(decision.kind, "retry");
    assert.match((decision as { reason: string }).reason, /TooManyRequestsException/);
  });

  it("becomes never-ran only when the window expires with nothing else", () => {
    const decisions = [
      decideInvokeAttempt({ kind: "throttled" }),
      decideInvokeAttempt({ kind: "throttled" }),
      decideInvokeAttempt({ kind: "throttled" }),
    ];
    const outcome = pollOutcome({ decisions, windowExpired: true });

    assert.equal(outcome.kind, "never-ran");
    assert.equal(
      (outcome as { attempts: number }).attempts,
      3,
      "a never-ran outcome reports how many throttles it took, which is the number that says the cadence and the deploy are fighting",
    );
    assert.match((outcome as { reason: string }).reason, /throttled/);
  });

  it("is superseded by a later converged run inside the window", () => {
    const decisions = [
      decideInvokeAttempt({ kind: "throttled" }),
      decideInvokeAttempt({ kind: "ok", payload: summary() }),
    ];
    const outcome = pollOutcome({ decisions, windowExpired: true });

    assert.equal(outcome.kind, "converged");
    assert.equal(
      (outcome as { summary: ReconcilerSummary }).summary.trigger,
      "deploy",
    );
  });
});

describe("a run that did not converge", () => {
  it("fails on a summary whose outcome is not converged", () => {
    const decision = decideInvokeAttempt({
      kind: "ok",
      payload: summary({ outcome: "not-converged" }),
    });
    assert.equal(decision.kind, "not-converged");
  });

  it("fails on an empty or unreadable reply", () => {
    // Going green on a reply nobody could read is the fire-and-forget bug with
    // one more step.
    for (const payload of [undefined, "", "not json", {}, { outcome: "ok" }]) {
      const decision = decideInvokeAttempt({ kind: "ok", payload });
      assert.equal(
        decision.kind,
        "not-converged",
        `a payload of ${JSON.stringify(payload)} must not read as converged`,
      );
      assert.match((decision as { reason: string }).reason, /no summary/);
    }
  });

  it("fails on a FunctionError, which is a run that threw", () => {
    const decision = decideInvokeAttempt({
      kind: "function-error",
      message: '{"errorType":"JanitorFailure","errorMessage":"gateway-unavailable"}',
    });
    assert.equal(decision.kind, "not-converged");
    assert.match((decision as { reason: string }).reason, /threw/);
  });

  it("reads a string payload, which is what the CLI writes to a file", () => {
    assert.equal(
      parseReconcilerSummary(JSON.stringify(summary()))?.outcome,
      "converged",
    );
    assert.equal(parseReconcilerSummary("not json"), undefined);
    assert.equal(parseReconcilerSummary(null), undefined);
  });

  it("reads the summary one level down, which is what the Lambda returns", () => {
    // The function's reply is a `JanitorRun` -- `{ revocation, governance,
    // config, summary }` (`vk-janitor-handler.ts`) -- so `outcome` sits under
    // `summary`. A parser that read only the top level said "the run returned no
    // summary" for every successful run, and the converge step failed on every
    // deploy. `vk-janitor-handler.test.ts` drives the real return value through
    // this; this case pins the shape at the unit level.
    const wrapped = {
      revocation: { outcome: "ok", kept: 1, deactivated: 0, skipped: 0 },
      governance: { outcome: "converged", changed: 0, unchanged: 2, skipped: 0 },
      config: { outcome: "converged", changed: 1, unchanged: 0, skipped: 2 },
      summary: summary(),
    };

    assert.equal(
      decideInvokeAttempt({ kind: "ok", payload: JSON.stringify(wrapped) }).kind,
      "converged",
    );
    // The counts come through too, not just the verdict: the poll's failure
    // message reads them.
    assert.equal(parseReconcilerSummary(wrapped)?.config.skipped, 0);
    assert.equal(parseReconcilerSummary(wrapped)?.trigger, "deploy");
  });

  it("keeps failing closed on a reply that is neither shape", () => {
    // The unwrap must not become a way for anything to read as converged. An
    // object with an `outcome` but no loops would be a summary the poll then
    // dereferences, which would come out as "could not complete" rather than as
    // the unreadable reply it is; and an object with neither an `outcome` nor a
    // summary is still no summary.
    for (const payload of [
      { summary: {} },
      { summary: { outcome: "converged" } },
      { outcome: "converged" },
      { summary: { outcome: "converged", revocation: {} } },
      { summary: "converged" },
    ]) {
      assert.equal(
        parseReconcilerSummary(payload),
        undefined,
        `${JSON.stringify(payload)} must not parse as a summary`,
      );
      assert.equal(
        decideInvokeAttempt({ kind: "ok", payload: JSON.stringify(payload) }).kind,
        "not-converged",
      );
    }
  });

  it("stops the poll on the first non-retry decision", () => {
    const decisions = [
      decideInvokeAttempt({ kind: "throttled" }),
      decideInvokeAttempt({ kind: "ok", payload: summary({ outcome: "not-converged" }) }),
      // A later attempt would be ignored by a real loop; the outcome must be the
      // first verdict rather than the last attempt's shape.
      decideInvokeAttempt({ kind: "ok", payload: summary() }),
    ];
    const outcome = pollOutcome({ decisions, windowExpired: true });
    assert.equal(outcome.kind, "not-converged");
  });
});

describe("the summary", () => {
  it("is converged only when every loop says so", () => {
    assert.equal(summarizeRun({
      trigger: "deploy",
      revocation: summary().revocation,
      governance: loop(),
      config: loop(),
    }).outcome, "converged");

    // An aborted governance loop wrote nothing, so a deploy asserting converged
    // would be asserting something that did not happen.
    assert.equal(summarizeRun({
      trigger: "schedule",
      revocation: summary().revocation,
      governance: loop("aborted"),
      config: loop(),
    }).outcome, "not-converged");

    assert.equal(summarizeRun({
      trigger: "schedule",
      revocation: { outcome: "aborted", kept: 0, deactivated: 0, skipped: 0 },
      governance: loop(),
      config: loop(),
    }).outcome, "not-converged");
  });

  it("accepts a config half that did not run on a tick, and only on a tick", () => {
    // Decision 16: a deploy owns config convergence, so a tick's `not-run` is
    // correct. A deploy that got `not-run` back asked for the half and did not
    // get it, which is a run that did not converge -- going green there would be
    // the fire-and-forget bug written down.
    const scheduled = summarizeRun({
      trigger: "schedule",
      revocation: summary().revocation,
      governance: loop(),
      config: { outcome: "not-run", changed: 0, unchanged: 0, skipped: 0 },
    });
    assert.equal(scheduled.outcome, "converged");
    assert.equal(scheduled.config.outcome, "not-run");

    const deployed = summarizeRun({
      trigger: "deploy",
      revocation: summary().revocation,
      governance: loop(),
      config: { outcome: "not-run", changed: 0, unchanged: 0, skipped: 0 },
    });
    assert.equal(deployed.outcome, "not-converged");
  });

  it("keeps the three loops' counts apart", () => {
    // The plan's reason for not folding them into one: "deactivated: 0" has to
    // mean one thing.
    const run = summarizeRun({
      trigger: "deploy",
      revocation: { outcome: "ok", kept: 3, deactivated: 1, skipped: 0 },
      governance: { outcome: "converged", changed: 2, unchanged: 4, skipped: 1 },
      config: { outcome: "converged", changed: 0, unchanged: 5, skipped: 2 },
    });

    assert.deepEqual(run.revocation, {
      outcome: "ok",
      kept: 3,
      deactivated: 1,
      skipped: 0,
    });
    assert.equal(run.governance.changed, 2);
    assert.equal(run.config.changed, 0);
  });

  it("names the trigger, and never depends on it for what runs", () => {
    assert.equal(reconcilerTrigger({ action: "reconcile", trigger: "schedule" }), "schedule");
    assert.equal(reconcilerTrigger({ action: "reconcile", trigger: "deploy" }), "deploy");
    // The rule EventBridge sends before this step, and anything else: a label,
    // not a switch.
    assert.equal(reconcilerTrigger({ action: "reconcile" }), "unknown");
    assert.equal(reconcilerTrigger(null), "unknown");
    assert.equal(reconcilerTrigger("nonsense"), "unknown");
  });
});
