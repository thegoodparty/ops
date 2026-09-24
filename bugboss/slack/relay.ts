// The Boss's Slack side. Design spec: docs/bugboss/design.md, Job 5, plus
// "When a human gets pinged" in Layer 4.
//
// Outbound is incident status transitions and two notifications. The incident
// agent posts its own hypotheses, questions and PR links with its own token,
// so none of that passes through here.
//
// Inbound records thread replies against the incident they belong to, and an
// agent finds them by polling getIncident. The agent never reads Slack:
// conversations.replies is throttled to roughly one request a minute for newer
// non-Marketplace apps, and per-agent Socket Mode is not a workaround because
// Slack load-balances events across an app's connections rather than
// broadcasting them, so one agent's answer could arrive on another's socket.

import type { Db } from "../db";
import type { Directive, IncidentOwner, IncidentStatus } from "../types";

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "slack-relay", event, ...data }));

// ---------------------------------------------------------------------------
// Injected Slack
// ---------------------------------------------------------------------------

/**
 * The write half of Slack, which is all the relay needs. `channel` defaults to
 * the incident channel, so a two-argument fake satisfies this.
 */
export interface SlackPoster {
  post(
    threadTs: string | null,
    text: string,
    channel?: string,
  ): Promise<{ ts: string }>;
}

export interface RelayConfig {
  channelId: string;
  /** The app's own user id. Used to spot mentions and drop our own echoes. */
  botUserId: string;
  /**
   * Slack user-group id for the rotation, rendered as <!subteam^ID>. Null
   * falls back to <!here>, which is worse but never silently pings nobody.
   */
  rotationGroupId: string | null;
}

export interface RelayDeps {
  db: Db;
  slack: SlackPoster;
  config: RelayConfig;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * Four status transitions and two notifications. A notification does not
 * change state: "a human should look" and "a human now owns this" are
 * different things and conflating them was a mistake in earlier drafts.
 */
export type RelayEvent =
  | { type: "opened"; incidentId: string; title: string; signalCount: number }
  | { type: "merged"; incidentId: string; into: string; reason: string }
  | { type: "escalated"; incidentId: string; reason: string; brief: string }
  | {
      type: "resolved";
      incidentId: string;
      evidence: string;
      prUrls: string[];
    }
  | {
      type: "prod_critical_signal";
      incidentId: string;
      signalTitle: string;
      slug: string;
    }
  | { type: "pr_needs_merge"; incidentId: string; prUrl: string };

/**
 * At roughly 20 incidents a week, pinging the rotation for things that resolve
 * themselves is how a rotation gets muted. Exactly three things earn a
 * mention: an escalation, a signal on the prod-critical allowlist, and a PR
 * that needs merging. Everything else lands in the thread unannounced, where
 * anyone curious can watch.
 */
const MENTION_EVENTS: readonly string[] = [
  "escalated",
  "prod_critical_signal",
  "pr_needs_merge",
];

export const earnsMention = (event: RelayEvent): boolean =>
  MENTION_EVENTS.includes(event.type);

const mentionPrefix = (rotationGroupId: string | null): string =>
  rotationGroupId ? `<!subteam^${rotationGroupId}> ` : "<!here> ";

export const renderEvent = (event: RelayEvent): string => {
  switch (event.type) {
    case "opened":
      return [
        `*Incident ${event.incidentId} opened*`,
        event.title,
        `${event.signalCount} signal(s). An agent is investigating. Nobody is being paged.`,
      ].join("\n");
    case "merged":
      return [
        `*Incident ${event.incidentId} merged into ${event.into}*`,
        event.reason,
        `Follow ${event.into} from here.`,
      ].join("\n");
    case "escalated":
      return [
        `*Escalation on incident ${event.incidentId}*`,
        `Reason: ${event.reason}`,
        "",
        event.brief,
        "",
        "This incident now has a human owner and no agent is running on it.",
      ].join("\n");
    case "resolved":
      return [
        `*Incident ${event.incidentId} resolved*`,
        event.evidence,
        ...event.prUrls.map((url) => `Shipped: ${url}`),
        "Post-mortem to follow. Nothing auto-closes.",
      ].join("\n");
    case "prod_critical_signal":
      return [
        `*Prod-critical signal on incident ${event.incidentId}*`,
        `${event.signalTitle} (${event.slug})`,
        "An agent is working it. This is a heads up, not a handover.",
      ].join("\n");
    case "pr_needs_merge":
      return [
        `*A PR needs review and merge for incident ${event.incidentId}*`,
        event.prUrl,
        "Before merging: does the RCA explain the signals, does the diff match the stated cause, is the blast radius what the analysis implies, and is there a test that would have caught this?",
      ].join("\n");
  }
};

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/**
 * The Events API `event` payload, already signature-verified and unwrapped by
 * the HTTP layer. The relay takes a parsed event rather than a raw request so
 * that verification stays in one place at the edge.
 */
export interface SlackEvent {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

export type InboundRoute =
  | { kind: "ignore"; reason: string }
  /** Recorded against an incident. `interrupt` means a directive went with it. */
  | { kind: "incident_reply"; incidentId: string; interrupt: boolean }
  | {
      kind: "slack_agent";
      channel: string;
      threadTs: string;
      ts: string;
      user: string;
      text: string;
    };

/** The statuses during which the dispatcher keeps an agent on an incident. */
const AGENT_RUNNING_STATUSES: readonly IncidentStatus[] = [
  "INVESTIGATING",
  "FIXING",
  "RESOLVED",
];

export const mentionsBot = (text: string, botUserId: string): boolean =>
  text.includes(`<@${botUserId}>`);

export const stripBotMention = (text: string, botUserId: string): string =>
  text.replaceAll(`<@${botUserId}>`, "").replace(/\s+/g, " ").trim();

const ignore = (reason: string): InboundRoute => ({ kind: "ignore", reason });

// ---------------------------------------------------------------------------

export class SlackRelay {
  private readonly db: Db;
  private readonly slack: SlackPoster;
  private readonly cfg: RelayConfig;

  constructor(deps: RelayDeps) {
    this.db = deps.db;
    this.slack = deps.slack;
    this.cfg = deps.config;
  }

  /**
   * Post a transition. `opened` starts the thread and records its ts on the
   * incident; everything else lands in that thread.
   */
  async emit(event: RelayEvent): Promise<string> {
    const text =
      (earnsMention(event) ? mentionPrefix(this.cfg.rotationGroupId) : "") +
      renderEvent(event);

    if (event.type === "opened") {
      const { ts } = await this.slack.post(null, text, this.cfg.channelId);
      await this.db.withWrite((d) => {
        d.prepare("UPDATE incident SET slackThreadTs = ? WHERE id = ?").run(
          ts,
          event.incidentId,
        );
      });
      log("thread_opened", { incidentId: event.incidentId, ts });
      return ts;
    }

    const row = this.db.get<{ slackThreadTs: string | null }>(
      "SELECT slackThreadTs FROM incident WHERE id = ?",
      [event.incidentId],
    );
    const threadTs = row?.slackThreadTs ?? null;
    if (!threadTs) {
      log("no_thread_posting_top_level", {
        incidentId: event.incidentId,
        type: event.type,
      });
    }
    const { ts } = await this.slack.post(threadTs, text, this.cfg.channelId);
    log("posted", {
      incidentId: event.incidentId,
      type: event.type,
      mentioned: earnsMention(event),
    });
    return ts;
  }

  /**
   * Classify one inbound event and act on it. Recording happens here; the
   * returned route tells the caller whether it still has to run the Slack
   * agent.
   */
  async handle(event: SlackEvent): Promise<InboundRoute> {
    if (event.bot_id) return ignore("bot message");
    if (event.user === this.cfg.botUserId) return ignore("our own message");
    if (event.type !== "message" && event.type !== "app_mention") {
      return ignore(`unhandled event type ${event.type}`);
    }
    if (event.subtype) return ignore(`message subtype ${event.subtype}`);

    const channel = event.channel;
    const ts = event.ts;
    const user = event.user;
    const text = event.text ?? "";
    if (!channel || !ts || !user) return ignore("incomplete event");

    const mentioned = mentionsBot(text, this.cfg.botUserId);

    // Slack delivers a threaded mention twice when the app subscribes to both
    // message.channels and app_mention. app_mention is the authoritative copy.
    if (event.type === "message" && mentioned) {
      return ignore("duplicate of app_mention");
    }

    const threadTs = event.thread_ts ?? null;
    if (!threadTs) {
      return mentioned
        ? { kind: "slack_agent", channel, threadTs: ts, ts, user, text }
        : ignore("channel chatter, not addressed to us");
    }

    const incident = this.incidentForThread(threadTs);
    if (!incident) {
      return mentioned
        ? { kind: "slack_agent", channel, threadTs, ts, user, text }
        : ignore("thread is not an incident thread");
    }

    const agentRunning =
      incident.owner === "agent" &&
      AGENT_RUNNING_STATUSES.includes(incident.status);

    if (mentioned && !agentRunning) {
      return { kind: "slack_agent", channel, threadTs, ts, user, text };
    }

    const inserted = await this.recordReply(incident.id, {
      channel,
      user,
      text,
      ts,
    });
    if (!inserted) return ignore("duplicate delivery");

    if (mentioned) {
      await this.pushDirective(incident.id, {
        type: "human_message",
        from: user,
        text,
        ts,
      });
      log("interrupt_recorded", { incidentId: incident.id, ts });
      return { kind: "incident_reply", incidentId: incident.id, interrupt: true };
    }

    log("reply_recorded", { incidentId: incident.id, ts });
    return { kind: "incident_reply", incidentId: incident.id, interrupt: false };
  }

  private incidentForThread(
    threadTs: string,
  ): { id: string; status: IncidentStatus; owner: IncidentOwner } | undefined {
    return this.db.get<{
      id: string;
      status: IncidentStatus;
      owner: IncidentOwner;
    }>("SELECT id, status, owner FROM incident WHERE slackThreadTs = ?", [
      threadTs,
    ]);
  }

  /**
   * False when Slack redelivered an event we already have. The id is derived
   * from (channel, ts) rather than generated, which is what makes the insert
   * idempotent under Slack's retries.
   */
  private async recordReply(
    incidentId: string,
    msg: { channel: string; user: string; text: string; ts: string },
  ): Promise<boolean> {
    return this.db.withWrite((d) => {
      const res = d
        .prepare(
          `INSERT OR IGNORE INTO thread_reply
             (id, incidentId, slackUserId, text, ts, receivedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${msg.channel}:${msg.ts}`,
          incidentId,
          msg.user,
          msg.text,
          msg.ts,
          Date.now(),
        );
      return res.changes > 0;
    });
  }

  private async pushDirective(
    incidentId: string,
    directive: Directive,
  ): Promise<void> {
    await this.db.withWrite((d) => {
      d.prepare(
        `INSERT INTO pending_directive (incidentId, payload, createdAt)
         VALUES (?, ?, ?)`,
      ).run(incidentId, JSON.stringify(directive), Date.now());
    });
  }
}
