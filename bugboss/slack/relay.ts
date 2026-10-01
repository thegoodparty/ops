// The Boss's Slack side. Design spec: bugboss/docs/architecture.md, Job 5, plus
// "When a human gets pinged" in Layer 4.
//
// Outbound is incident status transitions and two notifications. The incident
// agent never posts free text to Slack; what it says goes to the Boss.
//
// Inbound records a message in an incident thread against its incident and
// hands it to the Boss. The agent never reads Slack: the Boss decides what it
// needs to hear and tells it with a directive.

import type { Db } from "../db";
import type { SignalOriginRef } from "../ingress/link";
import { makeAlarm, makeLog } from "../logging";
import { bullets, link, mrkdwn, raw, splitForSlack, toMrkdwn } from "./format";
import { lifecycleSteps, renderThreadHeader } from "./status";

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

/**
 * Whether the Boss already has a conversation in a thread outside any
 * incident. The same predicate ingress is given, so the two layers cannot
 * disagree about whether an untagged follow-up is the Boss's.
 */
export type BossThreadCheck = (
  channel: string,
  threadTs: string,
) => boolean | Promise<boolean>;

export interface RelayDeps {
  db: Db;
  slack: SlackPoster;
  config: RelayConfig;
  /**
   * Required: an untagged follow-up under a Boss answer is dropped without
   * it, and an optional seam nobody wires is a fix that exists only in the
   * source.
   */
  isBossThread: BossThreadCheck;
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
  | {
      type: "opened";
      incidentId: string;
      title: string;
      /** What opened it and where to read it. See `ingress/link.ts`. */
      origin: SignalOriginRef | null;
    }
  | { type: "merged"; incidentId: string; into: string; reason: string }
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
 * themselves is how a rotation gets muted. Two things earn a mention here: a
 * signal on the prod-critical allowlist, and a PR that needs merging.
 * Everything else lands in the thread unannounced, where anyone curious can
 * watch.
 *
 * An escalation earns one too and does not come through here. `escalate`
 * posts its own brief and the composition root adds the ping, because the
 * rotation snapshot it mentions is per-incident.
 */
const MENTION_EVENTS: readonly string[] = [
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
      // The thread header, as the board sweep will keep it. Not the signal:
      // the agent reads that, and people follow the link to it.
      return renderThreadHeader({
        incidentId: event.incidentId,
        title: event.title,
        lifecycle: lifecycleSteps({ status: "INVESTIGATING", mergedInto: null }),
        origin: event.origin,
        needed: null,
      });
    case "merged":
      // Both references name the word "incident", which is what the outbound
      // pass keys off to render them as links. A bare id is a number.
      return [
        mrkdwn`*Incident ${event.incidentId} merged into incident ${event.into}*`,
        toMrkdwn(event.reason),
        mrkdwn`_Follow incident ${event.into} from here._`,
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
   * A message in an incident's thread, tagged or not, already recorded. It
   * goes to the Boss with the incident as context; what it means is the
   * Boss's to read.
   */
  | {
      kind: "incident_reply";
      incidentId: string;
      channel: string;
      threadTs: string;
      ts: string;
      user: string;
      text: string;
      /** True when the message tags the Boss, which is then always answered. */
      tagged: boolean;
    }
  | {
      kind: "slack_agent";
      channel: string;
      threadTs: string;
      ts: string;
      user: string;
      text: string;
      /**
       * False for an untagged follow-up in a Boss thread. Nobody addressed
       * that one to the Boss by name, so it may be two people talking, and
       * the Boss may choose to say nothing; a tagged mention is always
       * answered.
       */
      tagged: boolean;
    };

// Slack writes a mention as `<@ID>`, or `<@ID|name>` when the client keeps
// the name it showed. Incident 100's status question came in the second form.
export const botMentionPattern = (botUserId: string): RegExp => new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g");

export const mentionsBot = (text: string, botUserId: string): boolean =>
  botMentionPattern(botUserId).test(text);

export const stripBotMention = (text: string, botUserId: string): string =>
  text.replace(botMentionPattern(botUserId), "").replace(/\s+/g, " ").trim();

const ignore = (reason: string): InboundRoute => ({ kind: "ignore", reason });

// ---------------------------------------------------------------------------

export class SlackRelay {
  private readonly db: Db;
  private readonly slack: SlackPoster;
  private readonly cfg: RelayConfig;
  private readonly isBossThread: BossThreadCheck;

  constructor(deps: RelayDeps) {
    this.db = deps.db;
    this.slack = deps.slack;
    this.cfg = deps.config;
    this.isBossThread = deps.isBossThread;
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

      // A write has to land before the post, because the link written after
      // it is what stops the thread sweep opening this thread again. With the
      // database refusing writes, posting first opened a new top-level thread
      // for this incident, and pinged the rotation, on every tick. The empty
      // write records nothing; it throws when the link would.
      await this.db.withWrite(() => undefined);
      const parts = splitForSlack(body);
      const { ts } = await this.slack.post(null, parts[0], this.cfg.channelId);
      // The rest go into the thread this post just started, which is why they
      // wait for it rather than being posted alongside.
      for (const part of parts.slice(1)) {
        await this.slack.post(ts, part, this.cfg.channelId);
      }
      const linked = await this.linkThread(event.incidentId, ts);
      // Only once this post is the thread. A `lost` link means somebody else
      // won the race and this is a loose message, so recording its text as
      // the opening would later have the header sweep write it over the
      // winner's -- chat.update replaces a message whole.
      if (linked === "linked") {
        // An origin with no url may be a permalink lookup that failed, and
        // no origin may be a signal not attached yet, so both are left for
        // the sweep to resolve rather than kept as final.
        await this.recordOpening(event.incidentId, parts[0], {
          header: parts[0],
          origin: event.origin?.url ? event.origin : undefined,
        });
      }
      if (linked === "unwritable") {
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
      // The notice alone at the top, and the transition in the thread under
      // it. The header sweep rewrites the top-level message whole on its
      // next tick, so anything else put there would be deleted.
      const { ts } = await this.slack.post(
        null,
        mrkdwn`${raw(ping)}*Incident ${event.incidentId} has no Slack thread*`,
        this.cfg.channelId,
      );
      for (const part of splitForSlack(
        [
          "_Its thread link was missing, so this message is its thread from now on._",
          "",
          body,
        ].join("\n"),
      )) {
        await this.slack.post(ts, part, this.cfg.channelId);
      }
      // Adopt this post as the thread. One recovered thread beats the loose
      // messages every later transition would otherwise add.
      const adopted = await this.linkThread(event.incidentId, ts);
      // No header and no origin recorded, so the sweep writes both.
      if (adopted === "linked") {
        await this.recordOpening(event.incidentId, "", { header: null, origin: undefined });
      }
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
   * Classify one inbound event and record it. The returned route tells the
   * caller which of the Boss's entry points answers it.
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
      if (!mentioned) return ignore("channel chatter, not addressed to us");
      if (!(await this.recordBossMessage(channel, ts))) return ignore("duplicate delivery");
      return { kind: "slack_agent", channel, threadTs: ts, ts, user, text, tagged: true };
    }

    const incident = this.incidentForThread(threadTs);
    if (!incident) {
      if (mentioned) {
        if (!(await this.recordBossMessage(channel, ts))) return ignore("duplicate delivery");
        return { kind: "slack_agent", channel, threadTs, ts, user, text, tagged: true };
      }
      // A follow-up under a Boss answer, untagged. It is the Boss's exactly
      // as a tagged one would be: people reply to whoever answered them, and
      // "Can you close incident 2?" was lost here for want of an @. Decided
      // by what the Boss has done in this thread, never by what was said.
      if (await this.isBossThread(channel, threadTs)) {
        if (!(await this.recordBossMessage(channel, ts))) return ignore("duplicate delivery");
        log("boss_thread_followup", { channel, threadTs, ts });
        return { kind: "slack_agent", channel, threadTs, ts, user, text, tagged: false };
      }
      return ignore("thread is not an incident thread");
    }

    // Recorded before the Boss reads it. The thread is the record, so a
    // message in it belongs in thread_reply whatever it turns out to mean;
    // and the insert is what collapses a Slack retry, so a delivery that
    // skipped it could run the Boss twice on one message.
    const inserted = await this.recordReply(incident.id, {
      channel,
      user,
      text,
      ts,
    });
    if (!inserted) return ignore("duplicate delivery");

    log("reply_recorded", { incidentId: incident.id, ts, mentioned });
    return {
      kind: "incident_reply",
      incidentId: incident.id,
      channel,
      threadTs,
      ts,
      user,
      text,
      tagged: mentioned,
    };
  }

  private threadTsFor(incidentId: string): string | null {
    const row = this.db.get<{ slackThreadTs: string | null }>(
      "SELECT slackThreadTs FROM incident WHERE id = ?",
      [incidentId],
    );
    return row?.slackThreadTs ?? null;
  }

  /**
   * Record what the thread's top-level message says, so the header sweep
   * only edits it when the rendered text changes, and where it links to, so
   * the sweep does not have to ask Slack for a permalink again.
   *
   * `INSERT OR IGNORE`: a re-emit that finds the thread already open never
   * gets here, but a retry that raced one must not replace the record with a
   * later message. First write wins, like the thread link itself.
   *
   * `origin` undefined leaves it for the sweep to resolve. Never fatal: a
   * lost record costs one edit, when the sweep finds nothing to compare
   * against and writes the header anyway.
   */
  private async recordOpening(
    incidentId: string,
    text: string,
    record: { header: string | null; origin: SignalOriginRef | undefined },
  ): Promise<void> {
    try {
      await this.db.withWrite((d) => {
        d.prepare(
          `INSERT OR IGNORE INTO incident_thread
             (incidentId, opening, header, originLabel, originUrl)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(incidentId, text, record.header, record.origin?.label ?? null, record.origin?.url ?? null);
      });
    } catch (err) {
      alarm("thread_opening_unrecorded", {
        incidentId,
        error: String(err),
        note: "the header sweep will rewrite this thread's top-level message once",
      });
    }
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

  private incidentForThread(threadTs: string): { id: string } | undefined {
    return this.db.get<{ id: string }>(
      "SELECT id FROM incident WHERE slackThreadTs = ?",
      [threadTs],
    );
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

  /**
   * False when Slack redelivered a message the Boss has already been handed.
   * Keyed on (channel, ts) for the same reason recordReply is: Slack retries
   * any delivery it did not see answered in three seconds, and a second run
   * of the Boss on one message either answers twice or trips the thread lock
   * into a "still working" reply nobody asked for.
   */
  private async recordBossMessage(channel: string, ts: string): Promise<boolean> {
    return this.db.withWrite((d) => {
      const res = d
        .prepare(
          "INSERT OR IGNORE INTO boss_message_seen (channel, ts, receivedAt) VALUES (?, ?, ?)",
        )
        .run(channel, ts, Date.now());
      return res.changes > 0;
    });
  }

}
