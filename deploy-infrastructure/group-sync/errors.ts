/**
 * The one error a pair aborts on, for the runtime in step 3 of
 * `docs/google-group-sync.md`.
 *
 * The read adapter already has its own `SourceReadError` (step 2) so it can
 * abort without knowing anything about the handler's vocabulary. This is the
 * runtime's equivalent for the failures the adapter does not see: the
 * directory read, user creation, and a write that still fails after retries.
 * Both carry a `SyncAbortReason`, which is what the `Aborted` metric's `Reason`
 * dimension and the `sync.aborted` audit event key on.
 *
 * `detail` is for the log line only. It must never contain an email address or
 * a member list: membership is personal data and the logs say so by not
 * containing it (see "Observability" in the plan).
 */
import type { SyncAbortReason } from "./config";

export class SyncAbortError extends Error {
  readonly reason: SyncAbortReason;
  readonly detail: string;

  constructor(reason: SyncAbortReason, detail: string) {
    super(detail);
    this.name = "SyncAbortError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Narrowing helper, so a `catch` can tell the runtime's abort from a bug. */
export const isSyncAbortError = (err: unknown): err is SyncAbortError =>
  err instanceof SyncAbortError;
