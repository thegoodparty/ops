import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCacheable } from "./cache";
import type { Result } from "./replay";

// Which (case, run) pairs a replay still has to execute, decided in one place
// so the two vitest suites and the two hand-rolled loops they replaced cannot
// drift. Leaving this in each loop is what let `review:eval replay` reuse an
// errored result while `review:expect` retried it.
//
// A pair is skipped only when a reusable result is already on disk: no error,
// and a review that came back complete. An errored run, and a review that
// gave up, are replayed, so a transient failure never becomes the answer a
// case is scored on.

export interface PlannedReplay<T> {
  readonly item: T;
  readonly id: string;
  readonly run: number;
  // Where the replay writes its result: <out>/<id>/run-<n>.json.
  readonly resultPath: string;
}

export interface ReusedReplay<T> {
  readonly item: T;
  readonly run: number;
  readonly result: Result;
}

export interface ReplayPlan<T> {
  readonly pending: PlannedReplay<T>[];
  readonly reused: ReusedReplay<T>[];
}

export interface PlanOptions<T> {
  out: string;
  // Replays per case, each written to <out>/<id>/run-<n>.json.
  replays: number;
  // First run number. A rerun after a gate numbers its runs after the first
  // pass's, so it adds runs instead of retrying the ones already scored.
  fromRun?: number;
  // Replay even when a reusable result is on disk.
  force?: boolean;
  id: (item: T) => string;
  // Reads a result file, or undefined when it is absent or unreadable.
  // Injectable so the plan can be tested without touching the disk; defaults
  // to the filesystem the replays write to.
  read?: (path: string) => string | undefined;
}

const readResultFile = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, "utf-8") : undefined;

export const reusableResult = (raw: string): Result | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const result = parsed as Result;
  return isCacheable(result) ? result : undefined;
};

export const planReplays = <T>(items: readonly T[], opts: PlanOptions<T>): ReplayPlan<T> => {
  const { out, replays, fromRun = 1, force = false, id, read = readResultFile } = opts;
  if (!Number.isInteger(replays) || replays < 1) {
    throw new Error(`replays must be a positive integer, got ${replays}`);
  }
  if (!Number.isInteger(fromRun) || fromRun < 1) {
    throw new Error(`from-run must be a positive integer, got ${fromRun}`);
  }

  const pending: PlannedReplay<T>[] = [];
  const reused: ReusedReplay<T>[] = [];
  for (const item of items) {
    const caseId = id(item);
    for (let i = 0; i < replays; i++) {
      const run = fromRun + i;
      const resultPath = join(out, caseId, `run-${run}.json`);
      if (!force) {
        const raw = read(resultPath);
        const result = raw === undefined ? undefined : reusableResult(raw);
        if (result !== undefined) {
          reused.push({ item, run, result });
          continue;
        }
      }
      pending.push({ item, id: caseId, run, resultPath });
    }
  }
  return { pending, reused };
};
