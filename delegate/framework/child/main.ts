import { createInterface } from "node:readline";
import type { ChildEvent, ChildResult, ChildSpec, ParentResponse } from "../protocol";
import { ChildSpecSchema, parseParentResponse } from "../protocol";
import { runChild } from "./run";

// The spawned entry: a spec on stdin, then one response per request; a stream of
// events on stdout, ending with the result.
//
// A separate file from `run.ts` so `run.ts` stays importable in-process — the
// tests call `runChild` with a mock provider, and a module that ran its entry on
// import would make that impossible.
//
// **The process exits when it has said what it came to say.** The reader on stdin
// stays open for subagent responses, so the event loop would otherwise never
// drain and the parent would wait forever on a `close` that cannot come. That is
// not a hang a deadline is needed for: the answer is complete when the `result`
// event is written, so the process ends there.

const emit = (event: ChildEvent) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const main = async (): Promise<void> => {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  const first = await iterator.next();
  if (first.done === true) throw new Error("no spec on stdin");
  const spec = ChildSpecSchema.parse(JSON.parse(first.value)) as ChildSpec;

  // The parent aborts by killing this process, so this is only the graceful
  // path: it asked, and it is still reading.
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());

  // Requests are answered in order. A subagent's tool call awaits its own answer,
  // so two cannot overlap — which matches the synchronous `Task` this replaces:
  // `pr-reviewer`'s prompt spawns its specialists in one message and waits for
  // all of them, and a subagent that ran in the background published reviews on
  // partial results.
  const waiters = new Map<number, (response: ParentResponse) => void>();
  void (async () => {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      const response = parseParentResponse(line);
      if (response === undefined) continue;
      waiters.get(response.id)?.(response);
      waiters.delete(response.id);
    }
  })();

  const askSubagent = (request: { id: number; name: string; prompt: string }) =>
    new Promise<ParentResponse>((resolve) => {
      waiters.set(request.id, resolve);
      emit({ type: "request", ...request });
    });

  let result: ChildResult;
  try {
    result = await runChild(spec, { signal: controller.signal, onStep: emit, onRequest: askSubagent as never });
  } catch (err) {
    // `runChild` turns every model failure into a `ChildFailure`; this catches
    // only a bug in this file or in the tool set, and reports it the same way so
    // the parent still gets a result rather than a bare exit code.
    result = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      errorName: "ChildCrash",
      repairable: false,
      steps: 0,
      toolCalls: [],
      messages: spec.messages,
    };
  }
  emit({ type: "result", result });
  lines.close();
  // `exitCode` rather than `exit()`: stdout is flushed on a normal exit, and the
  // open reader no longer keeps the loop alive because the interface is closed and
  // stdin is no longer reading. Where that is not enough, the explicit call below
  // is what guarantees the parent's `close` fires.
  process.stdout.write("", () => {
    process.exit(0);
  });
};

main().catch((err: unknown) => {
  // A crash before the model call: on stderr and a non-zero exit, which
  // `spawnChild` turns into a failed run rather than a hang.
  process.stderr.write(`child failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
