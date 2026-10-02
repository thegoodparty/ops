// The one way an incident agent's tool blocks: monitor, message_boss and
// request_sql_query all wait through here.
//
// A wait ends on its condition, its timeout, the conversation's abort, or a
// steer queued for this conversation, whichever comes first. The last one is
// what makes a long wait safe to sit in. A steer is placed after the current
// tool round, so a wait that could not be cut short would hold a Boss message
// for as long as it lasted -- fifteen minutes and then a merge wait, on
// incident 94. The Boss's message, the deadline and the turn-budget warning
// are all steers, so watching the inbox is the whole interrupt: there is no
// poll and no second channel, and the message lands within milliseconds.

import type { Context, InboxState, ToolExecutionApi } from "./harness";
import { loadPi } from "./harness";

export type WaitEnd = "met" | "timeout" | "aborted" | "inbox";

export interface WaitCheck<T> {
  done: boolean;
  value: T;
}

export interface WaitOptions<T> {
  timeoutMs: number;
  intervalMs: number;
  /** Called first, then once per interval. `done` ends the wait as met. */
  check: () => Promise<WaitCheck<T>>;
  now?: () => number;
}

export interface WaitResult<T> {
  ended: WaitEnd;
  /** The last check's value; undefined only when no check had returned. */
  value: T | undefined;
  /** The text of every steer queued when the wait ended on the inbox. */
  steers: string[];
}

/** What a wait needs from its tool call. */
export type WaitApi = Pick<ToolExecutionApi, "watchDoc" | "conversationId">;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("");
};

/**
 * Steers only. A follow-up is placed when the run answers, and a write (a
 * compaction summary, a reset) at the next boundary, so ending a wait on
 * either would return at once on every call until the run ended -- a loop
 * that spends a turn per lap waiting on nothing.
 */
export const queuedSteers = (inbox: Readonly<InboxState> | null | undefined): string[] =>
  (inbox?.items ?? []).flatMap((item) => (item.mode === "steer" ? [textOf(item.content)] : []));

export const waitUntil = async <T>(
  api: WaitApi,
  ctx: Context,
  options: WaitOptions<T>,
): Promise<WaitResult<T>> => {
  const now = options.now ?? Date.now;
  const { durable } = await loadPi();
  const deadline = now() + Math.max(0, options.timeoutMs);

  let steers: string[] = [];
  let wake: (() => void) | null = null;
  const watch = await api.watchDoc(durable.InboxDoc, api.conversationId, ctx);
  const observe = (value: Readonly<InboxState> | null | undefined): void => {
    const queued = queuedSteers(value);
    if (queued.length === 0) return;
    steers = queued;
    wake?.();
  };
  observe(watch?.value);
  watch?.start(async (value) => observe(value));

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const signal = ctx.abortSignal;
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
      signal?.addEventListener("abort", done, { once: true });
    });

  let value: T | undefined;
  try {
    for (;;) {
      if (ctx.abortSignal?.aborted) return { ended: "aborted", value, steers: [] };
      const state = await options.check();
      value = state.value;
      // The condition first: a check that passed in the same moment a
      // message arrived has still happened, and saying so is the more useful
      // answer.
      if (state.done) return { ended: "met", value, steers: [] };
      if (steers.length) return { ended: "inbox", value, steers };
      if (ctx.abortSignal?.aborted) return { ended: "aborted", value, steers: [] };
      if (now() >= deadline) return { ended: "timeout", value, steers: [] };
      await pause(Math.min(Math.max(1, options.intervalMs), Math.max(0, deadline - now())));
      if (steers.length) return { ended: "inbox", value, steers };
    }
  } finally {
    wake = null;
    void watch?.stop();
  }
};
