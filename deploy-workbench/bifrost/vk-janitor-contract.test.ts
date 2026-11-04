import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  VK_JANITOR_FUNCTION_NAME,
  VK_JANITOR_INTERVAL_MINUTES,
  VK_JANITOR_RETRY_INITIAL_MS,
  VK_JANITOR_RETRY_MAX_MS,
  VK_JANITOR_RETRY_WINDOW_SECONDS,
  VK_JANITOR_SCHEDULE_EXPRESSION,
  VK_JANITOR_TIMEOUT_SECONDS,
  assertJanitorBudget,
  janitorBudgetProblems,
  retryDelayMs,
} from "./vk-janitor-contract";

/**
 * Step 4's timing budget: the five-minute interval, the two guards on it, and
 * the backoff.
 *
 * The guards are pure functions rather than only a load-time check, which is
 * what makes the interesting case testable: a window at or below the timeout has
 * to be *refused*, not merely absent from today's constants. A test that only
 * read the constants would pass on a build where the guard had been deleted.
 */

const source = (file: string): string =>
  fs.readFileSync(path.resolve(__dirname, file), "utf8");

const PULUMI_SOURCE = source("../bifrost-vk-janitor.ts");
const HANDLER_SOURCE = source("vk-janitor-handler.ts");
const WORKFLOW_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../../.github/workflows/deploy-workbench.yml"),
  "utf8",
);

describe("the reconciler's interval is five minutes", () => {
  it("is five minutes, and the schedule expression is derived from it", () => {
    // Decision 4, down from the hour `bifrost-virtual-keys.md` chose. Down from,
    // specifically: a value that drifted back up would put a person's override
    // behind a slower bound than the plan states.
    assert.equal(VK_JANITOR_INTERVAL_MINUTES, 5);
    assert.equal(VK_JANITOR_SCHEDULE_EXPRESSION, "rate(5 minutes)");
    // Derived, so the rule and the documented number cannot disagree.
    assert.match(
      PULUMI_SOURCE,
      /scheduleExpression:\s*VK_JANITOR_SCHEDULE_EXPRESSION/,
    );
    assert.match(
      PULUMI_SOURCE,
      /from "\.\/bifrost\/vk-janitor-contract"/,
    );
  });

  it("keeps the timeout below the interval, and at five minutes that is a real constraint", () => {
    assert.equal(VK_JANITOR_TIMEOUT_SECONDS, 120);
    assert.ok(
      VK_JANITOR_TIMEOUT_SECONDS < VK_JANITOR_INTERVAL_MINUTES * 60,
      "a run that outlives its interval overlaps the next one, and reservedConcurrentExecutions: 1 turns the overlap into a throttle",
    );
    // Half the interval spare, which is what "well below" means at this
    // cadence: 120s of work inside a 300s tick.
    assert.ok(VK_JANITOR_TIMEOUT_SECONDS <= (VK_JANITOR_INTERVAL_MINUTES * 60) / 2);
    assert.equal(
      janitorBudgetProblems({
        timeoutSeconds: VK_JANITOR_TIMEOUT_SECONDS,
        intervalMinutes: VK_JANITOR_INTERVAL_MINUTES,
        retryWindowSeconds: VK_JANITOR_RETRY_WINDOW_SECONDS,
      }).length,
      0,
      "the shipped budget must satisfy its own guards",
    );
  });

  it("refuses a timeout at or above the interval", () => {
    const problems = janitorBudgetProblems({
      timeoutSeconds: 300,
      intervalMinutes: 5,
      retryWindowSeconds: 600,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /must be below the interval/);
    assert.throws(() =>
      assertJanitorBudget({
        timeoutSeconds: 300,
        intervalMinutes: 5,
        retryWindowSeconds: 600,
      }),
    );
  });
});

describe("the deploy's retry window", () => {
  it("is pinned above the function's timeout", () => {
    assert.equal(VK_JANITOR_RETRY_WINDOW_SECONDS, 300);
    assert.ok(
      VK_JANITOR_RETRY_WINDOW_SECONDS > VK_JANITOR_TIMEOUT_SECONDS,
      "a window at or below the timeout expires while the tick the deploy is waiting behind is still legal",
    );
    // Comfortably above, not just above: the platform also takes time to
    // release the reservation, and a window equal to the timeout plus a second
    // would be a flake rather than a bound.
    assert.ok(VK_JANITOR_RETRY_WINDOW_SECONDS >= VK_JANITOR_TIMEOUT_SECONDS * 2);
  });

  it("cannot be constructed shorter than the timeout", () => {
    // The acceptance criterion, as a test of the rule rather than of today's
    // numbers: a window *equal* to the timeout is refused, and so is one below
    // it, and the message says why rather than only that.
    for (const window of [120, 119, 60, 1]) {
      const problems = janitorBudgetProblems({
        timeoutSeconds: 120,
        intervalMinutes: 5,
        retryWindowSeconds: window,
      });
      assert.equal(
        problems.length,
        1,
        `a ${window}s window against a 120s timeout must be refused`,
      );
      assert.match(problems[0], /must be above the function timeout/);
      assert.throws(() =>
        assertJanitorBudget({
          timeoutSeconds: 120,
          intervalMinutes: 5,
          retryWindowSeconds: window,
        }),
      );
    }
  });

  it("refuses a non-positive number before it compares anything", () => {
    // Zero would otherwise satisfy neither comparison in a way that says what is
    // wrong, and a negative window is a caller's bug rather than a budget.
    const problems = janitorBudgetProblems({
      timeoutSeconds: 120,
      intervalMinutes: 5,
      retryWindowSeconds: 0,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /must be positive/);
  });

  it("is what the workflow actually passes", () => {
    // A module constant nothing reads is a comment. The step passes the window
    // explicitly, and the value is the same number.
    const step = /- name: Converge the running gateway to the committed configuration([\s\S]*?)(?:\n {6}- |$)/.exec(
      WORKFLOW_SOURCE,
    );
    assert.ok(step, "the workflow has no convergence step");
    assert.match(
      step[1],
      new RegExp(
        `--retry-window-seconds ${VK_JANITOR_RETRY_WINDOW_SECONDS}`,
      ),
    );
    assert.match(step[1], /scripts\/verify-convergence\.ts/);
  });
});

describe("the backoff", () => {
  it("doubles from the initial delay and stops at the cap", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((attempt) =>
      retryDelayMs({ attempt }),
    );
    assert.deepEqual(delays, [
      VK_JANITOR_RETRY_INITIAL_MS,
      VK_JANITOR_RETRY_INITIAL_MS * 2,
      VK_JANITOR_RETRY_INITIAL_MS * 4,
      VK_JANITOR_RETRY_MAX_MS,
      VK_JANITOR_RETRY_MAX_MS,
      VK_JANITOR_RETRY_MAX_MS,
      VK_JANITOR_RETRY_MAX_MS,
    ]);
  });

  it("never returns a negative or zero delay, which would spin", () => {
    for (const attempt of [-3, -1, 0, 1, 40, 1_000]) {
      assert.ok(retryDelayMs({ attempt }) > 0);
    }
  });

  it("fits more than one retry inside the window", () => {
    // A window that only afforded one attempt would not be a retry policy. This
    // walks the real numbers: throttles return in milliseconds, so a 300s window
    // against this backoff affords many attempts.
    let spent = 0;
    let attempts = 0;
    while (spent < VK_JANITOR_RETRY_WINDOW_SECONDS * 1000) {
      spent += retryDelayMs({ attempt: attempts });
      attempts++;
    }
    assert.ok(attempts >= 5, `only ${attempts} retries fit in the window`);
  });
});

describe("the function name the deploy invokes", () => {
  it("is the literal the stack deploys", () => {
    assert.equal(VK_JANITOR_FUNCTION_NAME, "bifrost-vk-janitor");
    // The Pulumi module keeps its own name constants (the role shares the
    // string, and the reader trust names the role), so the two are pinned equal
    // here rather than derived: a rename has to touch both and this test.
    assert.match(PULUMI_SOURCE, /export const VK_JANITOR_NAME = "bifrost-vk-janitor";/);
    assert.match(
      PULUMI_SOURCE,
      /export const VK_JANITOR_FUNCTION_NAME = VK_JANITOR_NAME;/,
    );
  });

  it("is read by the handler from a parameter name, never a value", () => {
    // The one new environment entry step 4 adds, and it is a parameter's name.
    assert.match(
      HANDLER_SOURCE,
      /new GetParameterCommand\(\{ Name: requireEnv\("CONFIG_PARAMETER_NAME"\) \}\)/,
    );
  });
});
