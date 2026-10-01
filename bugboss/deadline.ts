// Every outbound call gets a deadline from here. Node's fetch and the AWS and
// Slack SDKs default to none, and a call that never answers looks exactly like
// a quiet week: on 2026-10-01 an S3 snapshot PUT and a Bedrock stream each
// froze their caller with nothing thrown. `deadline.test.ts` refuses a new
// call site that skips this.

export const DEADLINES = {
  /** One Slack Web API request. Retries are the SDK's policy and stack on top. */
  slackRequest: 20_000,
  /** One S3 call on the Slack agent's transcript store: small JSON objects. */
  slackStore: 20_000,
  /** The S3 snapshot PUT after every write, set by #221. */
  dbSnapshotPut: 20_000,
  /** The boot-time GET of the whole database snapshot, headers and body. */
  dbRestore: 60_000,
  /** One GitHub REST or GraphQL request from the agent. */
  github: 30_000,
  /** The Boss forwarding an agent's request to the SQL sidecar. */
  sqlRunner: 90_000,
  /** One agent call to the Boss's loopback tool API. */
  toolApi: 180_000,
} as const;

export type DeadlineName = keyof typeof DEADLINES;

export const deadline = (name: DeadlineName, ms: number = DEADLINES[name]): AbortSignal =>
  AbortSignal.timeout(ms);

/**
 * The same signal as a rejection, for a body read. An SDK resolves `send()` on
 * the headers, and a body that stalls after them is the same hang.
 */
export const beforeDeadline = async <T>(signal: AbortSignal, work: Promise<T>): Promise<T> => {
  let onAbort = (): void => {};
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
