// The Events API and interactivity, as Slack sends them: signed with the
// signing secret, retried when not answered in three seconds, and numbered
// on retry. BugBoss verifies these on its public `/slack` route, so a sender
// that signs wrong fails exactly the way a forged request would.

import { createHmac, randomUUID } from "node:crypto";

import type { EventDelivery, StoredMessage } from "./state";

export const signSlackRequest = (
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string =>
  `v0=${createHmac("sha256", secret)
    .update(`v0:${timestampSeconds}:${rawBody}`, "utf8")
    .digest("hex")}`;

export interface EventSenderConfig {
  /** BugBoss's public events route, e.g. http://bugboss:3000/slack. */
  eventsUrl: string;
  /** Where interactivity payloads go. BugBoss has no such route today. */
  interactivityUrl?: string;
  signingSecret: string;
  teamId: string;
  apiAppId: string;
  botUserId: string;
  /** Slack's own answer window before it retries. */
  ackTimeoutMs?: number;
  /** Waits before each retry. Slack's are about 1s, 1m and 5m. */
  retryDelaysMs?: number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  record: (delivery: EventDelivery) => void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createEventSender = (config: EventSenderConfig) => {
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? defaultSleep;
  const ackTimeoutMs = config.ackTimeoutMs ?? 3_000;
  const retryDelaysMs = config.retryDelaysMs ?? [1_000, 60_000, 300_000];

  const deliver = async (
    url: string,
    body: string,
    contentType: string,
    eventId: string,
    eventType: string,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]);
      const stamp = Math.floor(now() / 1000);
      const headers: Record<string, string> = {
        "content-type": contentType,
        "x-slack-request-timestamp": String(stamp),
        "x-slack-signature": signSlackRequest(config.signingSecret, stamp, body),
      };
      if (attempt > 0) {
        headers["x-slack-retry-num"] = String(attempt);
        headers["x-slack-retry-reason"] = "http_timeout";
      }
      let status: number | null = null;
      let error: string | null = null;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(ackTimeoutMs),
        });
        status = res.status;
        await res.arrayBuffer();
      } catch (err) {
        error = String(err);
      }
      config.record({ at: now(), eventId, eventType, attempt, status, error });
      if (status !== null && status >= 200 && status < 300) return true;
    }
    return false;
  };

  const sendEvent = (event: Record<string, unknown>): Promise<boolean> => {
    const eventId = `Ev${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const body = JSON.stringify({
      token: "sim-verification-token",
      team_id: config.teamId,
      api_app_id: config.apiAppId,
      event,
      type: "event_callback",
      event_id: eventId,
      event_time: Math.floor(now() / 1000),
      authorizations: [
        {
          team_id: config.teamId,
          user_id: config.botUserId,
          is_bot: true,
        },
      ],
    });
    return deliver(
      config.eventsUrl,
      body,
      "application/json",
      eventId,
      String(event.type),
    );
  };

  const messageEvent = (m: StoredMessage): Record<string, unknown> => {
    const event: Record<string, unknown> = {
      type: "message",
      channel: m.channel,
      user: m.user,
      text: m.text,
      ts: m.ts,
      event_ts: m.ts,
      channel_type: "channel",
    };
    if (m.threadTs) event.thread_ts = m.threadTs;
    if (m.botId) {
      event.bot_id = m.botId;
    }
    return event;
  };

  return {
    /**
     * What `message.channels` and `app_mention` subscribers receive for one
     * new message. A message that tags the bot arrives twice, once as each,
     * because that is what Slack does and BugBoss has to collapse it.
     */
    messagePosted: async (m: StoredMessage): Promise<void> => {
      await sendEvent(messageEvent(m));
      if (!m.botId && m.text.includes(`<@${config.botUserId}>`)) {
        await sendEvent({ ...messageEvent(m), type: "app_mention" });
      }
    },
    messageChanged: async (m: StoredMessage): Promise<void> => {
      await sendEvent({
        type: "message",
        subtype: "message_changed",
        channel: m.channel,
        ts: m.ts,
        event_ts: m.ts,
        channel_type: "channel",
        message: messageEvent(m),
      });
    },
    urlVerification: async (): Promise<string | null> => {
      const challenge = randomUUID();
      const body = JSON.stringify({
        token: "sim-verification-token",
        challenge,
        type: "url_verification",
      });
      const stamp = Math.floor(now() / 1000);
      const res = await fetch(config.eventsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(stamp),
          "x-slack-signature": signSlackRequest(
            config.signingSecret,
            stamp,
            body,
          ),
        },
        body,
      });
      const text = await res.text();
      return text === challenge ? challenge : null;
    },
    /**
     * A block action or view submission, form-encoded under `payload` as
     * Slack sends it. Nothing in BugBoss takes interactivity today; this is
     * here so a scenario can prove a button press is refused or handled.
     */
    interaction: async (payload: Record<string, unknown>): Promise<boolean> => {
      if (!config.interactivityUrl) {
        throw new Error("no interactivity url is configured");
      }
      const body = new URLSearchParams({
        payload: JSON.stringify(payload),
      }).toString();
      return deliver(
        config.interactivityUrl,
        body,
        "application/x-www-form-urlencoded",
        `In${randomUUID().slice(0, 8)}`,
        String(payload.type ?? "interaction"),
      );
    },
  };
};

export type EventSender = ReturnType<typeof createEventSender>;
