import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import { createEmitter } from "./run";
import type { TelemetryBatch, TelemetryGenerator } from "./types";

const recordingGenerator = () => {
  const calls: { from: number; to: number; state: string }[] = [];
  const generator: TelemetryGenerator = {
    backfill: ({ alertAt }) => ({
      logs: [{ ts: alertAt - 1000, labels: { a: "b" }, line: "old" }],
      samples: [],
    }),
    live: ({ from, to, state }) => {
      calls.push({ from, to, state });
      return {
        logs: [{ ts: to, labels: { state }, line: state }],
        samples: [{ ts: to, metric: "m", labels: {}, value: 1 }],
      };
    },
  };
  return { generator, calls };
};

const counting = async (batch: TelemetryBatch) => ({
  logs: batch.logs.length,
  samples: batch.samples.length,
});

describe("createEmitter", () => {
  test("emits contiguous windows from the alert time, starting in fault", async () => {
    const { generator, calls } = recordingGenerator();
    let clock = 1000;
    const emitter = createEmitter({
      generator,
      alertAt: 1000,
      hoursBefore: 1,
      seed: 3,
      push: counting,
      now: () => clock,
    });
    assert.deepEqual(await emitter.backfill(), { logs: 1, samples: 0 });
    clock = 16_000;
    await emitter.tick();
    emitter.setState("healthy");
    clock = 31_000;
    await emitter.tick();
    assert.deepEqual(calls, [
      { from: 1000, to: 16_000, state: "fault" },
      { from: 16_000, to: 31_000, state: "healthy" },
    ]);
    const snap = emitter.snapshot();
    assert.equal(snap.state, "healthy");
    assert.deepEqual(snap.emitted, { logs: 2, samples: 2 });
    assert.deepEqual(snap.switches, [{ at: 16_000, state: "healthy" }]);
    assert.equal(snap.lastEmitAt, 31_000);
  });

  test("a failed push is recorded and its window re-sent on the next tick", async () => {
    const { generator, calls } = recordingGenerator();
    let clock = 0;
    let fail = true;
    const emitter = createEmitter({
      generator,
      alertAt: 0,
      hoursBefore: 1,
      seed: 1,
      push: async (batch) => {
        if (fail) throw new Error("loki down");
        return counting(batch);
      },
      now: () => clock,
    });
    clock = 15_000;
    await emitter.tick();
    assert.deepEqual(emitter.snapshot().errors, [{ at: 15_000, error: "loki down" }]);
    fail = false;
    clock = 30_000;
    await emitter.tick();
    assert.deepEqual(calls.map((c) => [c.from, c.to]), [
      [0, 15_000],
      [0, 30_000],
    ]);
    assert.deepEqual(emitter.snapshot().emitted, { logs: 1, samples: 1 });
  });
});
