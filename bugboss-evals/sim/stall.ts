/** What a run has done lately, kept in memory so an idle one can be ended. */
export interface Liveness {
  startedAt: number;
  lastEventAt: number;
  lastRequestAt: number | null;
}

/** Nothing from the harness and nothing from the model for `idleMs`: the system is not working. */
export const isStalled = (run: Liveness, now: number, idleMs: number): boolean =>
  now - run.lastEventAt >= idleMs && now - (run.lastRequestAt ?? run.startedAt) >= idleMs;
