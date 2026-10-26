import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateService,
  formatServiceEvents,
  waitForSteadyState,
} from "./scripts/verify-service";

/**
 * The post-apply health check.
 *
 * The 2026-10-26 outage was not just a bad task definition: the deploy run
 * reported success while the service sat at running 0 / desired 1. This check
 * turns that into a red run. Its decision function is pure, and the poll is
 * driven by an injected clock, so the timeout case is tested without waiting.
 */

const deployment = (rolloutState: string, overrides: Record<string, unknown> = {}) => ({
  id: "ecs-svc/123",
  status: "PRIMARY",
  rolloutState,
  ...overrides,
});

const service = (overrides: Record<string, unknown> = {}) => ({
  status: "ACTIVE",
  desiredCount: 1,
  runningCount: 1,
  pendingCount: 0,
  deployments: [deployment("COMPLETED")],
  events: [],
  ...overrides,
});

describe("evaluateService", () => {
  it("is ready only when the service is running its desired count with no rollout in progress", () => {
    const result = evaluateService(service());

    assert.equal(result.state, "ready");
    assert.match(result.reason, /running 1\/1/);
  });

  it("waits while the replacement task is not running yet", () => {
    const result = evaluateService(
      service({
        runningCount: 0,
        pendingCount: 1,
        deployments: [deployment("IN_PROGRESS")],
      }),
    );

    assert.equal(result.state, "waiting");
    assert.match(result.reason, /running 0\/1/);
  });

  it("fails immediately when a deployment's rolloutState is FAILED", () => {
    const result = evaluateService(
      service({
        runningCount: 0,
        deployments: [deployment("FAILED")],
      }),
    );

    assert.equal(result.state, "failed");
    assert.match(result.reason, /FAILED/);
  });
});

describe("waitForSteadyState", () => {
  it("returns as soon as the service reaches steady state", async () => {
    let polls = 0;
    const result = await waitForSteadyState({
      describe: () => {
        polls += 1;
        return service();
      },
      timeoutMs: 30_000,
      intervalMs: 10_000,
    });

    assert.equal(result.ok, true);
    assert.equal(polls, 1);
  });

  it("times out with the service's events when steady state is never reached", async () => {
    let now = 0;
    let polls = 0;
    const result = await waitForSteadyState({
      describe: () => {
        polls += 1;
        return service({
          runningCount: 0,
          pendingCount: 1,
          deployments: [deployment("IN_PROGRESS")],
          events: [{ createdAt: "2026-10-26T13:23:00Z", message: "drained" }],
        });
      },
      timeoutMs: 30_000,
      intervalMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.ok(polls >= 2);
    assert.match(result.reason, /timed out/i);
    assert.ok(result.service);
    assert.match(formatServiceEvents(result.service), /drained/);
  });

  it("stops on a failed rollout instead of waiting for the timeout", async () => {
    let sleeps = 0;
    const result = await waitForSteadyState({
      describe: () =>
        service({
          runningCount: 0,
          deployments: [deployment("FAILED")],
          events: [{ createdAt: "2026-10-26T13:23:00Z", message: "TaskFailedToStart" }],
        }),
      timeoutMs: 600_000,
      intervalMs: 10_000,
      sleep: async () => {
        sleeps += 1;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, false);
    assert.equal(sleeps, 0);
    assert.match(result.reason, /FAILED/);
    assert.match(formatServiceEvents(result.service), /TaskFailedToStart/);
  });
});

describe("formatServiceEvents", () => {
  it("prints recent events newest first with their timestamps", () => {
    const text = formatServiceEvents(
      service({
        events: [
          {
            createdAt: "2026-10-26T13:25:00Z",
            message: "(service bifrost) has stopped 1 running tasks",
          },
          {
            createdAt: "2026-10-26T13:23:00Z",
            message: "(service bifrost) is unable to consistently start tasks",
          },
        ],
      }),
    );

    assert.match(text, /2026-10-26T13:25:00Z/);
    assert.match(text, /stopped 1 running tasks/);
    assert.match(text, /2026-10-26T13:23:00Z/);
    assert.ok(
      text.indexOf("13:25:00") < text.indexOf("13:23:00"),
      "events should be printed newest first",
    );
  });
});
