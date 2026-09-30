import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import { createControlServer, createEmitter } from "./run";
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

describe("control server", () => {
  const start = async (token?: string) => {
    const { generator } = recordingGenerator();
    const emitter = createEmitter({
      generator,
      alertAt: 0,
      hoursBefore: 1,
      seed: 1,
      push: counting,
    });
    const server = createControlServer(emitter, token);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, emitter, close: () => server.close() };
  };

  test("requires the bearer token when one is set", async () => {
    const { url, close } = await start("secret");
    try {
      assert.equal((await fetch(`${url}/__control/health`)).status, 401);
      const ok = await fetch(`${url}/__control/health`, {
        headers: { authorization: "Bearer secret" },
      });
      assert.equal(ok.status, 200);
    } finally {
      close();
    }
  });

  test("flips to healthy on POST /__control/state and reports it", async () => {
    const { url, emitter, close } = await start();
    try {
      const flipped = await fetch(`${url}/__control/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "healthy" }),
      });
      assert.equal(flipped.status, 200);
      assert.equal(emitter.snapshot().state, "healthy");
      const state = (await (await fetch(`${url}/__control/state`)).json()) as {
        state: string;
        switches: unknown[];
      };
      assert.equal(state.state, "healthy");
      assert.equal(state.switches.length, 1);

      const bad = await fetch(`${url}/__control/state`, {
        method: "POST",
        body: JSON.stringify({ state: "fixed" }),
      });
      assert.equal(bad.status, 400);

      await fetch(`${url}/__control/reset`, { method: "POST" });
      assert.equal(emitter.snapshot().state, "fault");
    } finally {
      close();
    }
  });
});
