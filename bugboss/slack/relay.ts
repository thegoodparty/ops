// The Boss's Slack side. Design spec: bugboss/docs/architecture.md, Job 5, plus
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
import { makeAlarm, makeLog } from "../logging";
import type { SlackChoiceClick } from "./blocks";
import { bullets, link, mrkdwn, raw, splitForSlack, toMrkdwn } from "./format";

const log = makeLog("slack-relay");

/** Error level, for the failures whose only other notice is a Slack post. */
const alarm = makeAlarm("slack-relay");

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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

export const mentionPrefix = (rotationGroupId: string | null): string =>
  rotationGroupId ? `<!subteam^${rotationGroupId}> ` : "<!here> ";

/**
 * The post and the write that records its ts cannot be one transaction, so the
 * write is retried instead. Only a transient local failure is recoverable: a
 * failed snapshot halts writes for good, and those attempts fail fast.
 */
const LINK_ATTEMPTS = 3;
const LINK_RETRY_MS = 100;

/**
 * What became of a thread-ts write. `lost` means another post got there
 * first, which is fine: the incident has one thread and this post is a loose
 * message in the channel. Only `unwritable` leaves nothing pointing at one.
 */
type LinkOutcome = "linked" | "lost" | "unwritable";

/**
 * A pull request, as `<url|owner/repo#7>`. The number is what a reader is
 * looking for and a bare GitHub URL buries it, since `unfurl_links` is off.
 */
const prLink = (url: string): string => {
  const parts = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url);
  return parts ? link(url, `${parts[1]}#${parts[2]}`) : link(url);
};

/**
 * Every transition has the same three parts, which is the shape the PR
 * reviewer already uses in this channel: a bold line saying what happened, the
 * substance, then one italic line of what it means for the reader. No
 * headings, because Slack has none; no tables, for the same reason.
 *
 * The literal text here is formatting and stays unescaped. Everything
 * interpolated is escaped: a signal title comes out of an alert annotation,
 * which is a thing an attacker can write, and one `<` in it would otherwise
 * eat the rest of the message with a 200 back from Slack.
 */
export const renderEvent = (event: RelayEvent): string => {
  switch (event.type) {
    case "opened":
      return [
        mrkdwn`*Incident ${event.incidentId} opened*`,
        mrkdwn`${event.title}`,
        mrkdwn`_${event.signalCount} signal${event.signalCount === 1 ? "" : "s"} · an agent is investigating · nobody is being paged_`,
      ].join("\n");
    case "merged":
      return [
        mrkdwn`*Incident ${event.incidentId} merged into ${event.into}*`,
        toMrkdwn(event.reason),
        mrkdwn`_Follow ${event.into} from here._`,
      ].join("\n");
    case "escalated":
      return [
        mrkdwn`*Escalation on incident ${event.incidentId}* · ${event.reason}`,
        "",
        toMrkdwn(event.brief),
        "",
        "_This incident now has a human owner and no agent is running on it._",
      ].join("\n");
    case "resolved":
      return [
        mrkdwn`*Incident ${event.incidentId} resolved*`,
        toMrkdwn(event.evidence),
        ...(event.prUrls.length
          ? [bullets(event.prUrls.map((url) => `Shipped: ${prLink(url)}`))]
          : []),
        "_Post-mortem to follow. Nothing auto-closes._",
      ].join("\n");
    case "prod_critical_signal":
      return [
        mrkdwn`*Prod-critical signal on incident ${event.incidentId}*`,
        mrkdwn`${event.signalTitle} (\`${event.slug}\`)`,
        "_An agent is working it. This is a heads up, not a handover._",
      ].join("\n");
    case "pr_needs_merge":
      return [
        mrkdwn`*A PR needs review and merge for incident ${event.incidentId}*`,
        prLink(event.prUrl),
        "Before merging:",
        bullets([
          "Does the RCA explain the signals?",
          "Does the diff match the stated cause?",
          "Is the blast radius what the analysis implies?",
          "Is there a test that would have caught this?",
        ]),
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
  /**
   * A message in an incident's thread, already recorded and already pushed to
   * the agent as a directive. What it *means* -- an answer, a question, or the
   * incident changing hands -- is a model call the caller makes off the Slack
   * ack, so everything that read needs travels on the route.
   *
   * The relay does not write `owner` and cannot: the whole flip lives in the
   * composition root, guarded in the statement.
   */
  | {
      kind: "incident_reply";
      incidentId: string;
      /** The message tagged the bot, so a directive interrupts as well. */
      interrupt: boolean;
      /** Who has the incident right now. Context for reading the message. */
      owner: IncidentOwner;
      /** False when no agent is on it, so a mention is a question for Job 6. */
      agentRunning: boolean;
      channel: string;
      threadTs: string;
      ts: string;
      user: string;
      text: string;
    }
  | {
      kind: "slack_agent";
      channel: string;
      threadTs: string;
      ts: string;
      user: string;
      text: string;
    };

/**
 * What a button press did. `answered` is the only one that moved anything;
 * the other two are a press that arrived too late or second, and each still
 * earns a line in the thread, because a button that does nothing and says
 * nothing is indistinguishable from a broken one.
 */
export type ChoiceRoute =
  | { kind: "ignore"; reason: string }
  | {
      kind: "answered";
      incidentId: string;
      choice: string;
      slackUserId: string;
    }
  | { kind: "stale"; incidentId: string; slackUserId: string }
  | { kind: "duplicate"; incidentId: string; slackUserId: string };

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
    const body = renderEvent(event);
    const ping = mentionPrefix(this.cfg.rotationGroupId);

    if (event.type === "opened") {
      // Posting and linking are two steps, so re-emitting has to find the
      // thread it already opened rather than start a second one.
      const open = this.threadTsFor(event.incidentId);
      if (open) {
        log("thread_already_open", { incidentId: event.incidentId, ts: open });
        return open;
      }

      const parts = splitForSlack(body);
      const { ts } = await this.slack.post(null, parts[0], this.cfg.channelId);
      // The rest go into the thread this post just started, which is why they
      // wait for it rather than being posted alongside.
      for (const part of parts.slice(1)) {
        await this.slack.post(ts, part, this.cfg.channelId);
      }
      if ((await this.linkThread(event.incidentId, ts)) === "unwritable") {
        // The thread exists and nothing points at it, so the rest of this
        // incident will not land here. Said in the thread, which is where
        // anyone following this incident is looking.
        await this.slack.post(
          ts,
          [
            mrkdwn`${raw(ping)}*Incident ${event.incidentId} is not linked to this thread*`,
            "_Recording this thread on the incident failed, so its later updates will not land here. The error is in the BugBoss logs._",
          ].join("\n"),
          this.cfg.channelId,
        );
      }
      log("thread_opened", { incidentId: event.incidentId, ts });
      return ts;
    }

    const threadTs = this.threadTsFor(event.incidentId);
    if (!threadTs) {
      // Slack accepts a thread-less post, so the alternative to saying this
      // out loud is an incident scattered across the channel as loose
      // messages that nothing marks as related. It pings the rotation for the
      // same reason a prod-critical signal does: nothing else will notice.
      alarm("thread_link_broken", {
        incidentId: event.incidentId,
        type: event.type,
      });
      const orphan = splitForSlack(
        [
          mrkdwn`${raw(ping)}*Incident ${event.incidentId} has no Slack thread*`,
          "_Its thread link is missing, so this is posting at the top level and the rest of the incident will follow it here._",
          "",
          body,
        ].join("\n"),
      );
      const { ts } = await this.slack.post(null, orphan[0], this.cfg.channelId);
      for (const part of orphan.slice(1)) {
        await this.slack.post(ts, part, this.cfg.channelId);
      }
      // Adopt this post as the thread. One recovered thread beats the loose
      // messages every later transition would otherwise add.
      const adopted = await this.linkThread(event.incidentId, ts);
      log("posted_top_level", {
        incidentId: event.incidentId,
        type: event.type,
        adopted,
      });
      return ts;
    }

    let first: string | null = null;
    for (const part of splitForSlack((earnsMention(event) ? ping : "") + body)) {
      const posted = await this.slack.post(threadTs, part, this.cfg.channelId);
      first = first ?? posted.ts;
    }
    if (first === null) throw new Error("splitForSlack produced nothing to post");
    const ts = first;
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

    // Slack only delivers app_mention when the app was tagged, so the event
    // type is a mention on its own. Resting this on the literal `<@id>` alone
    // made the whole mention path depend on botUserId being configured, and
    // an optional field nobody sets is a fix that only exists in the source.
    const mentioned =
      event.type === "app_mention" || mentionsBot(text, this.cfg.botUserId);

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

    // Recorded before anything decides what it meant, including a mention
    // this incident has no agent for. Two reasons. The thread is the record,
    // so a message in it belongs in thread_reply whoever ends up answering;
    // and the insert is what collapses a Slack retry, so a delivery that used
    // to skip it could run the Slack agent twice on one question.
    const inserted = await this.recordReply(incident.id, {
      channel,
      user,
      text,
      ts,
    });
    if (!inserted) return ignore("duplicate delivery");

    // Handing it to the agent is the caller's, because whether it is an
    // answer, a handover or two people talking to each other is a model call
    // and this has to be back inside Slack's three seconds.
    log(mentioned ? "interrupt_recorded" : "reply_recorded", {
      incidentId: incident.id,
      ts,
    });
    return {
      kind: "incident_reply",
      incidentId: incident.id,
      interrupt: mentioned,
      owner: incident.owner,
      agentRunning,
      channel,
      threadTs,
      ts,
      user,
      text,
    };
  }

  /**
   * One press of a button on a question. It is recorded and delivered exactly
   * as a typed reply is — a `thread_reply` row and a `human_message` directive
   * carrying the label the agent wrote — so `contact_human` cannot tell the
   * two apart and free text stays the answer of record.
   *
   * Anyone in the channel may press. Both guards that keeps honest are in the
   * statement rather than around it, like every other transition here:
   *
   *   EXISTS — `pending_question` holds the one question the agent is waiting
   *   on. A marker for a different message means this question has already
   *   been answered or has timed out, and delivering a press against it would
   *   file "Roll back" as the answer to whatever is being asked now.
   *
   *   The derived id — one question takes one answer, however many people
   *   press, and however many times Slack redelivers.
   */
  async handleChoice(click: SlackChoiceClick): Promise<ChoiceRoute> {
    const incident = this.incidentForThread(click.threadTs);
    if (!incident) {
      return { kind: "ignore", reason: "thread is not an incident thread" };
    }

    // Both writes are one transaction because they are one act. The reply row
    // is what the thread shows and the directive is the only thing the agent
    // waits on, so a press that commits the first and loses the second leaves
    // an incident that looks answered and is not acting on the answer, with
    // nothing downstream to reconcile it. `withWrite` wraps the callback in a
    // SQLite transaction, so a throw here rolls the reply back with it.
    const recorded = await this.db.withWrite((d) => {
      const inserted =
        d
          .prepare(
            `INSERT OR IGNORE INTO thread_reply
               (id, incidentId, slackUserId, text, ts, receivedAt)
             SELECT ?, ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM pending_question
                 WHERE incidentId = ? AND messageTs = ?
              )`,
          )
          .run(
            `${click.channel}:${click.messageTs}:choice`,
            incident.id,
            click.user,
            click.choice,
            click.actionTs,
            Date.now(),
            incident.id,
            click.messageTs,
          ).changes > 0;
      if (!inserted) return false;

      // Pressing an agent's own button is addressed to it by construction, so
      // unlike a typed reply there is nothing here for a model to read and this
      // stays inside the relay's write rather than moving to the composition
      // root with the rest of the directive push.
      d.prepare(
        `INSERT INTO pending_directive (incidentId, payload, createdAt)
         VALUES (?, ?, ?)`,
      ).run(
        incident.id,
        JSON.stringify({
          type: "human_message",
          from: click.user,
          text: click.choice,
          ts: click.actionTs,
          addressed: "agent",
        } satisfies Directive),
        Date.now(),
      );
      return true;
    });

    if (!recorded) {
      const outstanding = this.db.get<{ messageTs: string }>(
        "SELECT messageTs FROM pending_question WHERE incidentId = ?",
        [incident.id],
      );
      const kind =
        outstanding?.messageTs === click.messageTs ? "duplicate" : "stale";
      log(`choice_${kind}`, {
        incidentId: incident.id,
        user: click.user,
        messageTs: click.messageTs,
      });
      return { kind, incidentId: incident.id, slackUserId: click.user };
    }

    log("choice_recorded", {
      incidentId: incident.id,
      user: click.user,
      ts: click.actionTs,
    });
    return {
      kind: "answered",
      incidentId: incident.id,
      choice: click.choice,
      slackUserId: click.user,
    };
  }

  private threadTsFor(incidentId: string): string | null {
    const row = this.db.get<{ slackThreadTs: string | null }>(
      "SELECT slackThreadTs FROM incident WHERE id = ?",
      [incidentId],
    );
    return row?.slackThreadTs ?? null;
  }

  private async linkThread(
    incidentId: string,
    ts: string,
  ): Promise<LinkOutcome> {
    for (let attempt = 1; attempt <= LINK_ATTEMPTS; attempt++) {
      try {
        // Guarded on NULL so two transitions racing an absent link cannot
        // each adopt their own post and split one incident across two
        // threads. First write wins; the loser leaves a loose message.
        const won = await this.db.withWrite(
          (d) =>
            d
              .prepare(
                "UPDATE incident SET slackThreadTs = ? WHERE id = ? AND slackThreadTs IS NULL",
              )
              .run(ts, incidentId).changes > 0,
        );
        if (won) return "linked";

        const held = this.threadTsFor(incidentId);
        // A commit whose snapshot threw afterwards: the row already carries
        // this ts, so the retry matched nothing and the link is fine.
        if (held === ts) return "linked";
        if (!held) {
          alarm("thread_link_no_incident", { incidentId, ts });
          return "unwritable";
        }
        alarm("thread_link_lost", { incidentId, ts, held });
        return "lost";
      } catch (err) {
        alarm("thread_link_write_failed", {
          incidentId,
          ts,
          attempt,
          error: String(err),
        });
        if (attempt < LINK_ATTEMPTS) await sleep(LINK_RETRY_MS * attempt);
      }
    }
    return "unwritable";
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

}
