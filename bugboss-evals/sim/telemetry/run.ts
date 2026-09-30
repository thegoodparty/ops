import type { PushCounts } from "./load";
import type { TelemetryBatch, TelemetryGenerator } from "./types";

export type EmitterState = "fault" | "healthy";

export interface EmitterSnapshot {
  state: EmitterState;
  backfilled: PushCounts | null;
  emitted: PushCounts;
  switches: { at: number; state: EmitterState }[];
  lastEmitAt: number | null;
  errors: { at: number; error: string }[];
}

export interface Emitter {
  backfill(): Promise<PushCounts>;
  tick(): Promise<void>;
  setState(state: EmitterState): void;
  snapshot(): EmitterSnapshot;
}

export const createEmitter = (options: {
  generator: TelemetryGenerator;
  alertAt: number;
  hoursBefore: number;
  seed: number;
  push: (batch: TelemetryBatch) => Promise<PushCounts>;
  now?: () => number;
}): Emitter => {
  const now = options.now ?? Date.now;
  let state: EmitterState = "fault";
  let backfilled: PushCounts | null = null;
  let emitted: PushCounts = { logs: 0, samples: 0 };
  const switches: { at: number; state: EmitterState }[] = [];
  const errors: { at: number; error: string }[] = [];
  let lastEmitAt: number | null = null;
  // Live data starts where the backfill ends, so there is no gap and no overlap.
  let lastTo = options.alertAt;
  let ticking = false;

  return {
    backfill: async () => {
      const counts = await options.push(
        options.generator.backfill({
          alertAt: options.alertAt,
          hoursBefore: options.hoursBefore,
          seed: options.seed,
        }),
      );
      backfilled = counts;
      return counts;
    },
    tick: async () => {
      if (ticking) return;
      ticking = true;
      const to = now();
      try {
        if (to <= lastTo) return;
        const counts = await options.push(
          options.generator.live({
            from: lastTo,
            to,
            state,
            seed: options.seed,
          }),
        );
        // Advanced only on success, so a failed window is re-sent next tick.
        lastTo = to;
        lastEmitAt = to;
        emitted = {
          logs: emitted.logs + counts.logs,
          samples: emitted.samples + counts.samples,
        };
      } catch (error) {
        errors.push({
          at: to,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        ticking = false;
      }
    },
    setState: (next) => {
      if (next === state) return;
      state = next;
      switches.push({ at: now(), state: next });
    },
    snapshot: () => ({
      state,
      backfilled,
      emitted: { ...emitted },
      switches: [...switches],
      lastEmitAt,
      errors: [...errors],
    }),
  };
};
