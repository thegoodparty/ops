import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChildEvent, ChildRequest, ChildResult, ChildSpec, ChildStepEvent, ParentResponse } from "../protocol";
import { parseChildEvent } from "../protocol";

// Spawning the child, which is where the credential boundary actually is.
//
// `env` is the whole point: the child gets exactly what the caller passes and
// nothing else, so `agentEnv()`'s allowlist is the only way a key reaches the
// model call. Passing `process.env` here would undo the guard this design rests
// on — a read tool in the child can only escape the checkout through a guard bug,
// but `/proc/self/environ` is its own environ and needs no bug at all.
//
// `execArgv` is inherited from the parent because it is *not* `process.env`: under
// `tsx` (every test run, and `npm test` is a big part of what this repo does) the
// child entry is still TypeScript and needs the same loader flags; under the
// worker image the parent is compiled JS and there are none.

/** How the child is executed: compiled JS in the worker image, TypeScript under `tsx` in a test. */
export type ChildCommand = { file: string; execArgv: string[] };

/**
 * The entry file, resolved next to this one.
 *
 * Two layouts matter and each gets its own extension: the compiled worker image
 * has `main.js` beside `spawn.js`, and every test run (and `npm test`) is `tsx`
 * over the source tree, where the file on disk is `main.ts`. Resolving the wrong
 * one is not a load failure the parent can see — `node` exits 1 with "cannot find
 * module" and the run reports whatever stderr said — so it is resolved here, once,
 * by asking the filesystem.
 */
export const childEntry = (): string => {
  const js = join(__dirname, "main.js");
  return existsSync(js) ? js : join(__dirname, "main.ts");
};

/**
 * The node flags the child needs. The test runner's own flags are filtered: a
 * child that started a second test runner would hang rather than answer.
 */
export const childExecArgv = (parentExecArgv: readonly string[] = process.execArgv): string[] =>
  parentExecArgv.filter(
    (arg) => !arg.startsWith("--test") && !arg.startsWith("--watch") && !arg.startsWith("--inspect"),
  );

export type SpawnOptions = {
  /** The allowlisted environment. Never `process.env`. */
  env?: Record<string, string | undefined>;
  /** Kill the child when this fires: the parent's spend cap, step cap or deadline. */
  signal?: AbortSignal;
  /** A wall-clock backstop of the child's own, in ms. */
  timeoutMs?: number;
  /** Emitted as each step lands, so the parent can price it while the run continues. */
  onStep?: (event: ChildStepEvent) => void;
  /**
   * A subagent request from the child. The parent answers it (by running its own
   * `runAgent`) and the answer goes back on the child's stdin.
   */
  onRequest?: (request: ChildRequest) => Promise<ParentResponse>;
  /** Overridden by a test; production resolves it from `__dirname`. */
  command?: ChildCommand;
};

/**
 * Run one child and return its result.
 *
 * A process-level failure — a crash, a non-zero exit, a kill, unparseable output
 * — becomes a `ChildResult` with `ok: false` rather than a rejected promise: a run
 * that died still has to become a failed review with a reason, never an unhandled
 * rejection inside `runAgent`.
 */
export const spawnChild = (spec: ChildSpec, options: SpawnOptions = {}): Promise<ChildResult> =>
  new Promise((resolve) => {
    const command = options.command ?? { file: childEntry(), execArgv: childExecArgv() };
    const child = spawn(process.execPath, [...command.execArgv, command.file], {
      env: (options.env ?? {}) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderr: Buffer[] = [];
    let buffered = "";
    let settled = false;
    let result: ChildResult | undefined;
    let requests = 0;
    /** Requests still being answered: the child's exit is only an error when none are in flight. */
    let pending = 0;

    const finish = (outcome: ChildResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const fail = (error: string, errorName: string, extra: Partial<ChildResult> = {}) =>
      finish({
        ok: false,
        error,
        errorName,
        repairable: false,
        steps: 0,
        toolCalls: [],
        messages: [],
        ...extra,
      } as ChildResult);

    const onAbort = () => {
      child.kill("SIGTERM");
      fail("Run aborted", "Aborted");
    };

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGTERM");
            fail(`Child exceeded ${options.timeoutMs}ms`, "Timeout");
          }, options.timeoutMs);
    timer?.unref();

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const handleLine = (line: string) => {
      const event: ChildEvent | undefined = parseChildEvent(line);
      if (event === undefined) return;
      switch (event.type) {
        case "step":
          options.onStep?.(event);
          return;
        case "result":
          result = event.result;
          return;
        case "request": {
          requests += 1;
          pending += 1;
          const request = event;
          const answer = options.onRequest;
          void (answer === undefined
            ? Promise.resolve<ParentResponse>({
                type: "response",
                id: request.id,
                ok: false,
                error: "this run cannot spawn subagents",
              })
            : answer(request)
          )
            .then((response) => {
              if (settled) return;
              child.stdin.write(`${JSON.stringify(response)}\n`);
            })
            .catch((err: unknown) => {
              child.stdin.write(
                `${JSON.stringify({
                  type: "response",
                  id: request.id,
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                })}\n`,
              );
            })
            .finally(() => {
              pending -= 1;
            });
          return;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf-8");
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        handleLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => fail(`Could not start the agent process: ${err.message}`, "SpawnError"));

    child.on("close", (code, signal) => {
      // A trailing line with no newline is still an event.
      if (buffered.trim() !== "") handleLine(buffered);
      if (result !== undefined) {
        finish(result);
        return;
      }
      const err = Buffer.concat(stderr).toString("utf-8").trim();
      fail(
        `The agent process exited (${signal ?? `code ${code}`}) without an answer` +
          (requests > 0 ? ` after ${requests} subagent request(s)` : "") +
          (err === "" ? "" : `: ${err.slice(0, 500)}`),
        "ChildExited",
        { messages: spec.messages },
      );
    });

    // The child can exit before reading its spec; the `close` handler reports
    // that, so a broken pipe here is not its own failure.
    child.stdin.on("error", () => undefined);
    child.stdin.write(`${JSON.stringify(spec)}\n`);
  });
