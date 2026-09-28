// The :eyes: a delivery gets the moment it is verified, before any of the work
// behind it starts. Design spec: bugboss/docs/architecture.md, Job 5 and Job 6.
//
// Slack's three-second ack is answered by the HTTP layer and seen by nobody.
// What a person in the channel sees is the post that follows, and that is
// seconds away for a bug report and up to two minutes away for a mention. For
// that whole window a Boss that is working and a Boss that never received the
// message look exactly the same, and the second one is the likelier guess. The
// reaction is the only thing that separates them.

import { makeAlarm, makeLog } from "../logging";

const log = makeLog("slack-ack");

/** Error level, because a missing ack is invisible in every other way. */
const alarm = makeAlarm("slack-ack");

export const ACK_EMOJI = "eyes";

/** The write half of reactions. Nothing here ever removes one. */
export interface SlackReactor {
  react(channel: string, ts: string, name: string): Promise<void>;
}

export interface SlackAck {
  /** The classification that earned it, for the log line. */
  kind: string;
  channel: string;
  ts: string;
}

/**
 * Slack's word for "that reaction is already there". Two ordinary things land
 * here: a retried delivery, and the two copies Slack sends of a mention inside
 * a thread when an app subscribes to both `message.channels` and `app_mention`.
 * Both mean the reaction is on the message, which is the outcome we wanted.
 */
const ALREADY_REACTED = "already_reacted";

/**
 * @slack/web-api raises a WebAPIPlatformError carrying Slack's own error
 * string. That string is the difference between `already_reacted` and
 * `missing_scope`, so it is worth digging out rather than stringifying the
 * whole error and matching on it.
 */
const slackErrorCode = (err: unknown): string | null => {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === "string" ? data.error : null;
};

/**
 * Acknowledge one delivery.
 *
 * Returns `void`, not a promise, and that is the contract rather than an
 * oversight: Slack retries any delivery it has not seen answered in three
 * seconds, and a retry is a second run of the same work. A caller that cannot
 * await this cannot put it in front of the 200.
 *
 * Nothing it does can fail the message either. The answer still posts without
 * a reaction; what is lost is only the signal that it is coming. But it is not
 * lost quietly — `missing_scope` from an app that was never reinstalled would
 * otherwise look identical to a BugBoss that is working fine.
 */
export const createSlackAck =
  (slack: SlackReactor) =>
  ({ kind, channel, ts }: SlackAck): void => {
    const failed = (err: unknown): void => {
      const code = slackErrorCode(err);
      if (code === ALREADY_REACTED) {
        log("already_acknowledged", { kind, channel, ts });
        return;
      }
      alarm("ack_failed", { kind, channel, ts, error: code ?? String(err) });
    };

    // try/catch as well as the rejection handler: a client that throws on the
    // way in rather than returning a rejected promise would otherwise reach
    // the route, and Hono would turn an answer that was about to post into a
    // 500 that makes Slack retry the whole delivery.
    try {
      void slack
        .react(channel, ts, ACK_EMOJI)
        .then(() => log("acknowledged", { kind, channel, ts }), failed);
    } catch (err) {
      failed(err);
    }
  };
