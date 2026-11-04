import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  VK_JANITOR_RETRY_WINDOW_SECONDS,
  VK_JANITOR_TIMEOUT_SECONDS,
} from "./bifrost/vk-janitor-contract";
import type { ReconcilerSummary } from "./bifrost/reconciler-summary";
import {
  formatFailure,
  isFunctionError,
  isThrottle,
  pollForConvergence,
} from "./scripts/verify-convergence";

/**
 * The deploy's poll: the retry-on-throttle rule, driven by an injected clock and
 * an injected invoke so none of it needs AWS or a wait.
 *
 * The acceptance criterion it covers is the third one from the plan: "a tick
 * that is already running when the deploy invokes does not fail the run
 * (throttle -> retry, not failure)". `verify-service.test.ts` is the closest
 * precedent and this follows its shape.
 */

const summary = (
  overrides: Partial<ReconcilerSummary> = {},
): ReconcilerSummary => ({
  outcome: "converged",
  trigger: "deploy",
  revocation: { outcome: "ok", kept: 1, deactivated: 0, skipped: 0 },
  governance: { outcome: "converged", changed: 0, unchanged: 2, skipped: 0 },
  config: { outcome: "converged", changed: 1, unchanged: 0, skipped: 2 },
  ...overrides,
});

describe("pollForConvergence", () => {
  it("returns as soon as the run converges", async () => {
    let invokes = 0;
    const { outcome } = await pollForConvergence({
      invoke: () => {
        invokes += 1;
        return { kind: "ok", payload: JSON.stringify(summary()) };
      },
      retryWindowMs: 300_000,
    });

    assert.equal(outcome.kind, "converged");
    assert.equal(invokes, 1);
  });

  it("retries a throttle and converges on the next attempt, without failing", async () => {
    // The third acceptance criterion. A tick holds the reservation; the deploy's
    // invoke is throttled; the retry gets through. Nothing here fails.
    let now = 0;
    let invokes = 0;
    const sleeps: number[] = [];
    const { outcome, decisions } = await pollForConvergence({
      invoke: () => {
        invokes += 1;
        return invokes === 1
          ? { kind: "throttled", message: "TooManyRequestsException" }
          : { kind: "ok", payload: JSON.stringify(summary()) };
      },
      retryWindowMs: 300_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    assert.equal(outcome.kind, "converged");
    assert.equal(invokes, 2);
    assert.equal(decisions[0].kind, "retry");
    // Backoff is real, and it is bounded: the first wait is the initial delay.
    assert.deepEqual(sleeps, [2_000]);
  });

  it("reports never-ran when every attempt inside the window is throttled", async () => {
    let now = 0;
    let invokes = 0;
    const { outcome, decisions } = await pollForConvergence({
      invoke: () => {
        invokes += 1;
        return { kind: "throttled" };
      },
      retryWindowMs: 30_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    assert.equal(outcome.kind, "never-ran");
    assert.ok(invokes > 1, "a throttle is retried, not failed");
    assert.equal(decisions.length, invokes);
    assert.match((outcome as { reason: string }).reason, /throttled/);
  });

  it("fails on a run that did not converge, and does not retry it", async () => {
    let invokes = 0;
    const { outcome } = await pollForConvergence({
      invoke: () => {
        invokes += 1;
        return {
          kind: "ok",
          payload: JSON.stringify(summary({ outcome: "not-converged" })),
        };
      },
      retryWindowMs: 300_000,
    });

    assert.equal(outcome.kind, "not-converged");
    assert.equal(invokes, 1, "a convergence failure is not a scheduling collision");
  });

  it("fails on a FunctionError without retrying", async () => {
    const { outcome } = await pollForConvergence({
      invoke: () => ({ kind: "function-error", message: "Unhandled exception" }),
      retryWindowMs: 300_000,
    });

    assert.equal(outcome.kind, "not-converged");
  });

  it("does not start an attempt the window cannot finish", async () => {
    // The window bounds the whole thing: a sleep that would cross the deadline
    // ends the poll rather than being taken and reported later.
    let now = 0;
    const { outcome } = await pollForConvergence({
      invoke: () => ({ kind: "throttled" }),
      retryWindowMs: 3_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      initialDelayMs: 2_000,
      maxDelayMs: 2_000,
    });

    assert.equal(outcome.kind, "never-ran");
    assert.ok(
      now < 3_000,
      `the poll must not sleep past its own window, spent ${now}ms of 3000ms`,
    );
  });

  it("does not spin: every sleep is a positive backoff", async () => {
    const sleeps: number[] = [];
    await pollForConvergence({
      invoke: () => ({ kind: "throttled" }),
      retryWindowMs: 120_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: (() => {
        let now = 0;
        return () => {
          now += sleeps.at(-1) ?? 0;
          return now;
        };
      })(),
    });

    assert.ok(sleeps.length > 0);
    assert.ok(sleeps.every((ms) => ms > 0));
  });
});

describe("the reply classification", () => {
  it("reads the CLI's response metadata for a FunctionError", () => {
    // `aws lambda invoke` writes `{"StatusCode":200,"FunctionError":"Unhandled"}`
    // to stdout and the payload to a file, so the marker is in stdout and a
    // script that read only the payload would go green on a run that threw.
    assert.equal(isFunctionError('{"StatusCode":200,"FunctionError":"Unhandled"}'), true);
    assert.equal(isFunctionError('{"StatusCode":200}'), false);
    assert.equal(isFunctionError("An error occurred (ResourceNotFoundException)"), false);
  });

  it("recognises the throttle, and only the throttle", () => {
    assert.equal(
      isThrottle("An error occurred (TooManyRequestsException) when calling the Invoke operation: Rate Exceeded."),
      true,
    );
    assert.equal(
      isThrottle("An error occurred (ResourceNotFoundException) when calling the Invoke operation"),
      false,
    );
    assert.equal(
      isThrottle("An error occurred (AccessDeniedException) when calling the Invoke operation"),
      false,
    );
  });
});

describe("the failure message", () => {
  it("tells never-ran apart from did-not-converge", () => {
    const neverRan = formatFailure({
      kind: "never-ran",
      reason: "every one of 3 attempt(s) was throttled",
      attempts: 3,
    });
    const didNotConverge = formatFailure({
      kind: "not-converged",
      reason: "the run reported not-converged",
      summary: summary({ outcome: "not-converged" }),
    });

    assert.match(neverRan, /never ran/);
    assert.match(didNotConverge, /did not converge/);
    assert.notEqual(neverRan, didNotConverge);
  });

  it("names the counts on success, so the log says what changed", () => {
    const message = formatFailure({ kind: "converged", summary: summary() });
    assert.match(message, /converged/);
    assert.match(message, /config changed 1/);
    assert.match(message, /governance changed 0/);
  });
});

describe("the retry window the script uses", () => {
  it("is above the function timeout, by the contract module's own guard", () => {
    assert.ok(VK_JANITOR_RETRY_WINDOW_SECONDS > VK_JANITOR_TIMEOUT_SECONDS);
  });

  it("is documented in its own source as the reason it exists", () => {
    // A window is only safe to raise or lower if the reader is told what it has
    // to outlast. The constant's doc comment and the module's header both say
    // it; this pins that the script references the timeout rather than a
    // literal.
    const source = fs.readFileSync(
      path.resolve(__dirname, "scripts/verify-convergence.ts"),
      "utf8",
    );
    assert.match(source, /VK_JANITOR_TIMEOUT_SECONDS/);
    assert.match(source, /--invocation-type/);
    assert.match(source, /RequestResponse/);
    assert.ok(
      !/["']Event["']/.test(source),
      "an Event invoke returns before the work does and is green on a failed convergence",
    );
  });

  it("is a step in the workflow, after the service check and before Bedrock", () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, "../.github/workflows/deploy-workbench.yml"),
      "utf8",
    );
    const converge = workflow.indexOf(
      "- name: Converge the running gateway to the committed configuration",
    );
    assert.notEqual(converge, -1, "no convergence step");

    const service = workflow.indexOf(
      "- name: Verify the service returned to a steady state",
    );
    const bedrock = workflow.indexOf("- name: Enable Bedrock models");
    assert.ok(service !== -1 && bedrock !== -1);
    assert.ok(
      converge > service,
      "a reconciler invoked against a task that has not come back up converges the wrong process",
    );
    assert.ok(
      converge < bedrock,
      "a failed convergence must stop the run before it mutates the account further",
    );
  });
});
