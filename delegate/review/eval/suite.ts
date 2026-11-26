import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Result } from "./replay";

type Registrar = (name: string, fn: () => unknown) => unknown;
export type VitestGlobals = { describe: Registrar; it: Registrar & { concurrent: Registrar } };

interface ReplaySuite<C> {
  name: string;
  cases: readonly C[];
  id: (c: C) => string;
  out: string;
  replays: number;
  fromRun?: number;
  force?: boolean;
  canReuse: (result: Result) => boolean;
  replay: (c: C, run: number) => Promise<Result>;
  after?: (c: C, run: number, result: Result) => void;
  planOnly?: boolean;
}

export const defineReplaySuite = <C>(
  { name, cases, id, out, replays, fromRun = 1, force = false, canReuse, replay, after, planOnly }: ReplaySuite<C>,
  { describe, it }: VitestGlobals = globalThis as typeof globalThis & VitestGlobals,
): void => {
  if (!Number.isInteger(replays) || replays < 1 || !Number.isInteger(fromRun) || fromRun < 1) {
    throw new Error(`${name}: runs and first run number must be positive integers`);
  }
  let pending = 0;
  describe(name, () => {
    for (const c of cases) {
      const caseId = id(c);
      for (let run = fromRun; run < fromRun + replays; run++) {
        const path = join(out, caseId, `run-${run}.json`);
        if (!force) {
          try {
            if (canReuse(JSON.parse(readFileSync(path, "utf-8")) as Result)) continue;
          } catch (err) {
            if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
        pending++;
        if (planOnly) console.error(`  would replay ${caseId} run ${run}`);
        it.concurrent(`${caseId} run ${run}`, async () => {
          if (planOnly) return;
          const result = await replay(c, run);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify(result, null, 2));
          after?.(c, run, result);
        });
      }
    }
    console.error(`Replaying ${pending} run(s); ${cases.length * replays - pending} already had results`);
    if (pending === 0) it("every run already had a result", () => {});
  });
};

export interface ReplayRun {
  out: string;
  workDir: string;
  replays: number;
  fromRun?: number;
  force?: boolean;
  variant?: string;
  case?: string;
  split?: string;
  manifest?: string;
  casesDir?: string;
  mirrorDir?: string;
  planOnly?: boolean;
}

const RUN_ENV = "DELEGATE_EVAL_RUN";

export const readReplayRun = (): ReplayRun => {
  const raw = process.env[RUN_ENV];
  if (!raw) throw new Error("Run replay suites through review:expect or review:eval replay");
  return JSON.parse(raw) as ReplayRun;
};

export const runReplaySuite = async (file: string, run: ReplayRun, concurrency: number): Promise<void> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got ${concurrency}`);
  }
  const { startVitest } = await import("vitest/node");
  const previous = process.env[RUN_ENV];
  process.env[RUN_ENV] = JSON.stringify(run);
  try {
    const vitest = await startVitest([], {
      config: false,
      run: true,
      include: [file],
      testTimeout: 0,
      maxWorkers: 1,
      maxConcurrency: concurrency,
      globals: true,
      // Only the replay log may contain holdout names, not the GitHub step summary.
      reporters: ["default"],
    });
    try {
      const modules = vitest.state.getTestModules();
      if (process.exitCode || modules.length !== 1 || !modules[0].ok()) {
        throw new Error("Replay suite did not finish successfully");
      }
    } finally {
      await vitest.close();
    }
  } finally {
    if (previous === undefined) delete process.env[RUN_ENV];
    else process.env[RUN_ENV] = previous;
  }
};
