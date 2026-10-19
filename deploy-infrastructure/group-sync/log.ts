/**
 * Structured logging for the group sync, "Observability" in
 * `docs/google-group-sync.md`.
 *
 * One JSON object per line with an `audit` field, so a CloudWatch metric filter
 * can key on `{ $.audit = "..." }` -- the `sheriff` convention
 * (`deploy-infrastructure/sheriff/handler.ts`). The events are `sync.started`,
 * `sync.completed`, `sync.aborted`, `member.added`, `member.removed`,
 * `member.skipped`, `user.created` and `removal_cap.tripped`.
 *
 * **Membership is personal data, and the logs say so by not containing it.**
 * A per-member event carries the pair id, the group id, the opaque Identity
 * Store user id and -- when a human-readable reference is genuinely needed --
 * a truncated SHA-256 of the email, never the address. `member.skipped` carries
 * the domain, not the local part, so a misconfiguration is debuggable without
 * putting addresses in CloudWatch. `sync.completed` carries counts.
 */
import { createHash } from "node:crypto";

/** The audit sink, so tests can capture lines instead of printing them. */
export type Logger = (event: string, fields: Record<string, unknown>) => void;

/** The real sink: one JSON line per event, the convention the filters read. */
export const audit: Logger = (event, fields) => {
  console.log(JSON.stringify({ audit: event, ...fields }));
};

/**
 * A stable, non-reversible reference for an email, for the one place a log
 * line needs to distinguish two members: the first 12 hex characters of the
 * SHA-256 of the lowercased address. Truncated because it is a label, not a
 * security control; not salted because it is only ever compared within this
 * job's own logs.
 */
export const emailRef = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(
    0,
    12,
  );

/** A test sink that keeps every line it is handed. */
export const memoryLogger = (): {
  log: Logger;
  events: Array<{ event: string; fields: Record<string, unknown> }>;
} => {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return {
    events,
    log: (event, fields) => {
      events.push({ event, fields });
    },
  };
};
