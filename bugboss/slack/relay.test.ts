import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import type { SlackChoiceClick } from "./blocks";
import {
  SlackRelay,
  earnsMention,
  mentionsBot,
  renderEvent,
  stripBotMention,
  type RelayEvent,
} from "./relay";

const BOT = "U0BUGBOSS";
const ROTATION = "S0ROTATION";
const CHANNEL = "C0DEVALERTS";

const noS3 = (): S3Client =>
  ({
    send: async (cmd: unknown) => {
      if (cmd instanceof GetObjectCommand) {
        const err = new Error("cold start");
        err.name = "NoSuchKey";
        throw err;
      }
      return {};
    },
  }) as unknown as S3Client;

const fakeSlack = () => {
  const posts: { threadTs: string | null; text: string }[] = [];
  return {
    posts,
    post: (threadTs: string | null, text: string) => {
      posts.push({ threadTs, text });
      return Promise.resolve({ ts: `ts-${posts.length}` });
    },
  };
};

let dir: string;
let db: Db;
let slack: ReturnType<typeof fakeSlack>;
let relay: SlackRelay;

/**
 * A CLOSED row needs three more columns than an open one -- its CHECKs say an
 * incident is closed only once it is resolved and written up -- and CLOSED is
 * what these tests reach for whenever they need an incident no agent will
 * ever run on again. `AGENT_RUNNING_STATUSES` is the other two-thirds of the
 * status list, so there is no open status left that means "nobody is on it".
 */
const seedIncident = (id: string, status = "INVESTIGATING") =>
  db.withWrite((d) => {
    const at = Date.now();
    const closed = status === "CLOSED";
    d.prepare(
      `INSERT INTO incident
         (id, status, firstSignalAt, resolvedAt, closedAt, postmortem)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      status,
      at,
      status === "RESOLVED" || closed ? at : null,
      closed ? at : null,
      closed ? "written up" : null,
    );
  });

/** Reads hit the real database; every write fails the way a halted Db does. */
const writeFailingDb = (): Db =>
  ({
    get: (sql: string, params: unknown[] = []) => db.get(sql, params),
    query: (sql: string, params: unknown[] = []) => db.query(sql, params),
    withWrite: () => Promise.reject(new Error("writes halted: s3 unreachable")),
  }) as unknown as Db;

/** The error log is the one notice that does not go through Slack. */
const captureErrors = async (fn: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bugboss-relay-"));
  db = await Db.open({
    path: join(dir, "relay.db"),
    bucket: "bugboss-test",
    key: "state/db",
    s3: noS3(),
  });
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.withWrite((d) => {
    d.prepare("DELETE FROM pending_directive").run();
    d.prepare("DELETE FROM pending_question").run();
    d.prepare("DELETE FROM thread_reply").run();
    d.prepare("DELETE FROM incident_wait").run();
    d.prepare("DELETE FROM signal").run();
    d.prepare("DELETE FROM incident").run();
  });
  slack = fakeSlack();
  relay = new SlackRelay({
    db,
    slack,
    config: { channelId: CHANNEL, botUserId: BOT, rotationGroupId: ROTATION },
  });
});

// ---------------------------------------------------------------------------

describe("the mention policy", () => {
  const ordinary: RelayEvent[] = [
    { type: "opened", incidentId: "inc-1", title: "500s on /campaigns", signalCount: 1 },
    { type: "merged", incidentId: "inc-1", into: "inc-2", reason: "same cause" },
    {
      type: "resolved",
      incidentId: "inc-1",
      evidence: "two clean runs after deploy",
      prUrls: ["https://github.com/thegoodparty/omni/pull/1"],
    },
  ];

  const earns: RelayEvent[] = [
    {
      type: "prod_critical_signal",
      incidentId: "inc-1",
      signalTitle: "checkout down",
      slug: "payments-5xx",
    },
    {
      type: "pr_needs_merge",
      incidentId: "inc-1",
      prUrl: "https://github.com/thegoodparty/omni/pull/2",
    },
  ];

  test("ordinary transitions do not earn a mention", () => {
    for (const event of ordinary) {
      assert.equal(earnsMention(event), false, `${event.type} must not ping`);
    }
  });

  test("exactly two things earn a mention", () => {
    for (const event of earns) {
      assert.equal(earnsMention(event), true, `${event.type} must ping`);
    }
  });

  test("no rendered transition smuggles a ping into its body", () => {
    for (const event of [...ordinary, ...earns]) {
      const text = renderEvent(event);
      assert.doesNotMatch(text, /<!here>|<!channel>|<!subteam\^/, event.type);
    }
  });

  test("an ordinary transition posts with no ping token at all", async () => {
    await seedIncident("inc-1");
    await relay.emit(ordinary[0]);
    await relay.emit(ordinary[1]);
    await relay.emit(ordinary[2]);
    for (const post of slack.posts) {
      assert.doesNotMatch(post.text, /<!here>|<!channel>|<!subteam\^/);
    }
  });

  test("a prod-critical signal pings the rotation group", async () => {
    await seedIncident("inc-1");
    await relay.emit(ordinary[0]);
    await relay.emit(earns[0]);
    assert.match(slack.posts[1].text, new RegExp(`^<!subteam\\^${ROTATION}> `));
  });

  /**
   * The ping is prepended before the split, so it rides the first message.
   * A rotation that has to open a part 2 to discover it was paged is a
   * rotation that stops opening either. A signal title comes out of an alert
   * annotation, which is why one long enough to split is a real case.
   */
  test("a split message that earns a ping carries it on the first part only", async () => {
    await seedIncident("inc-1");
    await relay.emit(ordinary[0]);
    await relay.emit({
      type: "prod_critical_signal",
      incidentId: "inc-1",
      signalTitle: Array.from(
        { length: 400 },
        (_, i) => `checkout step ${i} is down`,
      ).join(", "),
      slug: "payments-5xx",
    });

    const posted = slack.posts.slice(1);
    assert.ok(posted.length > 1, `expected a split, got ${posted.length}`);
    assert.match(posted[0].text, new RegExp(`^<!subteam\\^${ROTATION}> `));
    for (const part of posted.slice(1)) {
      assert.doesNotMatch(part.text, /<!subteam\^/, "once, not on every part");
    }
  });

  test("with no rotation group configured it falls back to here, never to silence", async () => {
    const solo = fakeSlack();
    const r = new SlackRelay({
      db,
      slack: solo,
      config: { channelId: CHANNEL, botUserId: BOT, rotationGroupId: null },
    });
    await seedIncident("inc-1");
    await r.emit(ordinary[0]);
    await r.emit(earns[1]);
    assert.match(solo.posts[1].text, /^<!here> /);
  });
});

// ---------------------------------------------------------------------------

describe("what a transition looks like in Slack", () => {
  test("a signal title out of an alert annotation cannot eat the message", () => {
    const text = renderEvent({
      type: "opened",
      incidentId: "inc-1",
      title: "500s parsing <Config> for a & b",
      signalCount: 2,
    });
    assert.ok(text.includes("500s parsing &lt;Config&gt; for a &amp; b"), text);
    assert.ok(text.endsWith("nobody is being paged_"), text);
  });

  test("a slug is code, and a count agrees with its noun", () => {
    assert.ok(
      renderEvent({
        type: "prod_critical_signal",
        incidentId: "inc-1",
        signalTitle: "checkout down",
        slug: "payments-5xx",
      }).includes("(`payments-5xx`)"),
    );
    assert.ok(
      renderEvent({
        type: "opened",
        incidentId: "inc-1",
        title: "t",
        signalCount: 1,
      }).includes("_1 signal ·"),
    );
  });

  test("a pull request is linked by its number, not by a bare url", () => {
    const text = renderEvent({
      type: "pr_needs_merge",
      incidentId: "inc-1",
      prUrl: "https://github.com/thegoodparty/omni/pull/2",
    });
    assert.ok(
      text.includes("<https://github.com/thegoodparty/omni/pull/2|thegoodparty/omni#2>"),
      text,
    );
    assert.ok(text.includes("• Does the RCA explain the signals?"), text);
  });

  test("a url that is not a GitHub pull request still links", () => {
    assert.ok(
      renderEvent({
        type: "pr_needs_merge",
        incidentId: "inc-1",
        prUrl: "https://gitlab.test/x/-/merge_requests/9",
      }).includes("<https://gitlab.test/x/-/merge_requests/9>"),
    );
  });

  test("agent prose written as Markdown arrives as mrkdwn", () => {
    const text = renderEvent({
      type: "resolved",
      incidentId: "inc-1",
      evidence: "## What I ruled out\n- **the cache**, see [the run](https://ci.test/7)",
      prUrls: [],
    });
    assert.ok(text.includes("*What I ruled out*"), text);
    assert.ok(text.includes("• *the cache*, see <https://ci.test/7|the run>"), text);
    assert.doesNotMatch(text, /\*\*|^## /m);
  });

  test("agent prose cannot page the rotation on the agent's own say-so", () => {
    const text = renderEvent({
      type: "resolved",
      incidentId: "inc-1",
      evidence: "<!subteam^S0ROTATION> someone look",
      prUrls: [],
    });
    assert.doesNotMatch(text, /<!here>|<!channel>|<!subteam\^/);
  });

  test("a body longer than one message becomes several, not a truncation", async () => {
    await seedIncident("inc-1");
    await relay.emit({
      type: "opened",
      incidentId: "inc-1",
      title: "t",
      signalCount: 1,
    });
    const evidence = Array.from(
      { length: 400 },
      (_, i) => `- ruled out ${i}`,
    ).join("\n");
    await relay.emit({
      type: "resolved",
      incidentId: "inc-1",
      evidence,
      prUrls: [],
    });

    const posted = slack.posts.slice(1);
    assert.ok(posted.length > 1, `expected a split, got ${posted.length}`);
    assert.ok(posted.every((p) => p.threadTs !== null), "every part lands in the thread");
    assert.ok(
      posted.map((p) => p.text).join("").includes("ruled out 399"),
      "the tail is not dropped",
    );
  });
});

// ---------------------------------------------------------------------------

describe("threading", () => {
  test("opened starts the thread and records its ts on the incident", async () => {
    await seedIncident("inc-1");
    const ts = await relay.emit({
      type: "opened",
      incidentId: "inc-1",
      title: "500s on /campaigns",
      signalCount: 2,
    });

    assert.equal(slack.posts[0].threadTs, null, "the opener is top level");
    const row = db.get<{ slackThreadTs: string | null }>(
      "SELECT slackThreadTs FROM incident WHERE id = 'inc-1'",
    );
    assert.equal(row?.slackThreadTs, ts);
  });

  test("later transitions land in that thread", async () => {
    await seedIncident("inc-1");
    const ts = await relay.emit({
      type: "opened",
      incidentId: "inc-1",
      title: "t",
      signalCount: 1,
    });
    await relay.emit({
      type: "resolved",
      incidentId: "inc-1",
      evidence: "quiet for an hour",
      prUrls: [],
    });
    assert.equal(slack.posts[1].threadTs, ts);
  });
});

// ---------------------------------------------------------------------------

describe("inbound", () => {
  const openThread = async (id: string, status = "INVESTIGATING") => {
    await seedIncident(id, status);
    return relay.emit({ type: "opened", incidentId: id, title: id, signalCount: 1 });
  };

  /**
   * The delete that wakes a parked incident lives here, upstream of anything
   * that reads what the message said. These two drive it through the real
   * relay rather than restating its SQL, because a test that restates the
   * statement cannot notice the statement changing -- which is exactly what
   * happened: the dispatcher-side version of this passed with the condition
   * removed from this file.
   */
  const park = (id: string, liftsOnReply: 0 | 1, waitingFor: string) =>
    db.withWrite((d) =>
      d
        .prepare(
          `INSERT INTO incident_wait
             (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
           VALUES (?, ?, NULL, ?, ?)`,
        )
        .run(id, waitingFor, liftsOnReply, Date.now()),
    );

  const stillParked = (id: string) =>
    db.query("SELECT incidentId FROM incident_wait WHERE incidentId = ?", [id])
      .length === 1;

  test("a reply lifts a wait on a person", async () => {
    const thread = await openThread("inc-1");
    await park("inc-1", 1, "somebody to merge the PR");

    await relay.handle({
      type: "message",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: "merged it",
      ts: "1700.5",
      thread_ts: thread,
    });

    assert.equal(
      stillParked("inc-1"),
      false,
      "talking to an incident wakes it, with no model in the path",
    );
  });

  test("a reply does not lift a wait it cannot end", async () => {
    const thread = await openThread("inc-1");
    await park("inc-1", 0, "a fresh turn budget");

    // Three, because the failure was per-comment: each reply woke the
    // incident, the relaunched agent stopped on its first turn and
    // escalated, and the rotation was paged again.
    for (const ts of ["1700.6", "1700.7", "1700.8"]) {
      await relay.handle({
        type: "message",
        channel: CHANNEL,
        user: "U0HUMAN",
        text: "any progress?",
        ts,
        thread_ts: thread,
      });
    }

    assert.equal(
      stillParked("inc-1"),
      true,
      "a reply adds no turns, so it is not news about this wait",
    );
    // Still recorded and still delivered: what it loses is the power to
    // relaunch, not its place on the record.
    assert.equal(
      db.query("SELECT id FROM thread_reply WHERE incidentId = 'inc-1'").length,
      3,
    );
  });

  test("an untagged reply is recorded against the incident", async () => {
    const thread = await openThread("inc-1");
    const route = await relay.handle({
      type: "message",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: "yes, org X bypasses the Stripe webhook",
      ts: "1700.1",
      thread_ts: thread,
    });

    assert.equal(route.kind, "incident_reply");
    if (route.kind !== "incident_reply") return;
    assert.equal(route.interrupt, false, "answering is not interrupting");
    assert.equal(route.incidentId, "inc-1");
    const replies = db.query<{ text: string; slackUserId: string }>(
      "SELECT text, slackUserId FROM thread_reply WHERE incidentId = 'inc-1'",
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0].slackUserId, "U0HUMAN");

    // Handing it to the agent is the caller's, because whether it answers
    // the agent or is two people talking to each other is a model call and
    // this has to be back inside Slack's three seconds. Covered end to end in
    // test/e2e.test.ts.
    assert.equal(
      db.query("SELECT id FROM pending_directive").length,
      0,
      "the relay records; it does not decide what a message meant",
    );
    assert.equal(route.text, "yes, org X bypasses the Stripe webhook");
  });

  test("Slack redelivering the same event does not double-record it", async () => {
    const thread = await openThread("inc-1");
    const event = {
      type: "message",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: "still broken",
      ts: "1700.1",
      thread_ts: thread,
    };
    await relay.handle(event);
    const second = await relay.handle(event);

    assert.equal(second.kind, "ignore");
    assert.equal(
      db.query("SELECT id FROM thread_reply").length,
      1,
      "the insert is what a Slack retry collapses onto, so the caller reads it once",
    );
  });

  test("a mention is marked as an interrupt on the route", async () => {
    const thread = await openThread("inc-1");
    const route = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> stop, this is expected`,
      ts: "1700.2",
      thread_ts: thread,
    });

    assert.equal(route.kind, "incident_reply");
    if (route.kind !== "incident_reply") return;
    assert.equal(route.interrupt, true);
    assert.equal(route.incidentId, "inc-1");
    assert.equal(route.text, `<@${BOT}> stop, this is expected`);
  });

  test("a mention in a thread with no agent running says so on the route", async () => {
    const thread = await openThread("inc-9", "CLOSED");
    const route = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> what did the agent rule out?`,
      ts: "1700.3",
      thread_ts: thread,
    });

    // The relay does not decide that this is a question for the Slack agent
    // rather than something for the incident's own agent -- that is the
    // caller's, off the ack -- so it hands up the two facts that decide it.
    assert.equal(route.kind, "incident_reply");
    if (route.kind !== "incident_reply") return;
    assert.equal(route.interrupt, true, "it was addressed to us");
    assert.equal(route.agentRunning, false, "and there is no agent to interrupt");
  });

  test("a channel-level mention opens a new Slack agent thread on itself", async () => {
    const route = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> what is open right now?`,
      ts: "1700.4",
    });

    assert.equal(route.kind, "slack_agent");
    if (route.kind !== "slack_agent") return;
    assert.equal(route.threadTs, "1700.4");
    assert.equal(route.ts, "1700.4");
  });

  test("chatter we are not part of is ignored", async () => {
    const thread = await openThread("inc-1");
    assert.equal(
      (await relay.handle({
        type: "message",
        channel: CHANNEL,
        user: "U0HUMAN",
        text: "anyone else seeing this?",
        ts: "1700.5",
      })).kind,
      "ignore",
      "a top-level message with no mention",
    );
    assert.equal(
      (await relay.handle({
        type: "message",
        channel: CHANNEL,
        user: "U0HUMAN",
        text: "unrelated thread",
        ts: "1700.6",
        thread_ts: "9999.0",
      })).kind,
      "ignore",
      "a reply in a thread that is not an incident thread",
    );
    assert.equal(
      (await relay.handle({
        type: "message",
        channel: CHANNEL,
        bot_id: "B0SELF",
        text: "Incident inc-1 opened",
        ts: "1700.7",
        thread_ts: thread,
      })).kind,
      "ignore",
      "our own posts must not loop back in",
    );
  });

  test("a threaded mention arriving twice is only handled once", async () => {
    const thread = await openThread("inc-1");
    const shared = {
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> status?`,
      ts: "1700.8",
      thread_ts: thread,
    };
    await relay.handle({ ...shared, type: "app_mention" });
    const dupe = await relay.handle({ ...shared, type: "message" });

    assert.equal(dupe.kind, "ignore");
    assert.equal(db.query("SELECT id FROM thread_reply").length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("a broken thread link", () => {
  const resolved: RelayEvent = {
    type: "resolved",
    incidentId: "inc-1",
    evidence: "quiet for an hour",
    prUrls: [],
  };

  test("re-emitting opened returns the thread it already opened", async () => {
    await seedIncident("inc-1");
    const first = await relay.emit({
      type: "opened",
      incidentId: "inc-1",
      title: "t",
      signalCount: 1,
    });
    const second = await relay.emit({
      type: "opened",
      incidentId: "inc-1",
      title: "t",
      signalCount: 1,
    });

    assert.equal(second, first);
    assert.equal(slack.posts.length, 1, "one thread, not two");
  });

  test("a link write that keeps failing is announced, not just logged", async () => {
    await seedIncident("inc-1");
    const halted = new SlackRelay({
      db: writeFailingDb(),
      slack,
      config: { channelId: CHANNEL, botUserId: BOT, rotationGroupId: ROTATION },
    });

    const errors = await captureErrors(() =>
      halted.emit({
        type: "opened",
        incidentId: "inc-1",
        title: "t",
        signalCount: 1,
      }),
    );

    assert.equal(slack.posts.length, 2, "the opener, then the warning");
    assert.equal(slack.posts[1].threadTs, "ts-1", "in the thread it opened");
    assert.match(slack.posts[1].text, new RegExp(`^<!subteam\\^${ROTATION}> `));
    assert.ok(
      errors.some((line) => line.includes("thread_link_write_failed")),
      "and the write failure reaches the error log",
    );
  });

  test("a transition with no thread pings the rotation instead of drifting loose", async () => {
    await seedIncident("inc-1");
    const errors = await captureErrors(() => relay.emit(resolved));

    assert.equal(slack.posts.length, 1);
    assert.equal(slack.posts[0].threadTs, null, "there is no thread to use");
    assert.match(slack.posts[0].text, new RegExp(`^<!subteam\\^${ROTATION}> `));
    assert.match(slack.posts[0].text, /quiet for an hour/, "the news still gets out");
    assert.ok(
      errors.some((line) => line.includes("thread_link_broken")),
      "a human-visible ping and an error, not an info log",
    );
  });

  test("two transitions racing an absent link adopt once, not twice", async () => {
    await seedIncident("inc-1");
    await captureErrors(() =>
      Promise.all([
        relay.emit(resolved),
        relay.emit({
          type: "prod_critical_signal",
          incidentId: "inc-1",
          signalTitle: "checkout down",
          slug: "payments-5xx",
        }),
      ]),
    );

    assert.equal(slack.posts.length, 2, "both posts are already out");
    const row = db.get<{ slackThreadTs: string | null }>(
      "SELECT slackThreadTs FROM incident WHERE id = 'inc-1'",
    );
    assert.equal(row?.slackThreadTs, "ts-1", "the first write wins the row");

    await relay.emit({
      type: "merged",
      incidentId: "inc-1",
      into: "inc-2",
      reason: "same cause",
    });
    assert.equal(
      slack.posts[2].threadTs,
      "ts-1",
      "one thread from here, not two competing ones",
    );
  });

  test("the top-level fallback adopts itself as the thread", async () => {
    await seedIncident("inc-1");
    await captureErrors(() => relay.emit(resolved));

    const row = db.get<{ slackThreadTs: string | null }>(
      "SELECT slackThreadTs FROM incident WHERE id = 'inc-1'",
    );
    assert.equal(row?.slackThreadTs, "ts-1");
    await relay.emit({
      type: "merged",
      incidentId: "inc-1",
      into: "inc-2",
      reason: "same cause",
    });
    assert.equal(
      slack.posts[1].threadTs,
      "ts-1",
      "one recovered thread beats a channel of loose messages",
    );
  });
});

// ---------------------------------------------------------------------------

describe("a message in an incident thread", () => {
  const openThread = async (id: string, status = "INVESTIGATING") => {
    await seedIncident(id, status);
    return relay.emit({ type: "opened", incidentId: id, title: id, signalCount: 1 });
  };

  const reply = (thread: string, text: string, ts = "1700.1") =>
    relay.handle({
      type: "message",
      channel: CHANNEL,
      user: "U0HUMAN",
      text,
      ts,
      thread_ts: thread,
    });

  /**
   * The relay used to decide this itself, by requiring the whole normalized
   * message to equal "mine" or "back to you". That made "ok back to you" and
   * "handing this back" do nothing at all, silently. It now records the
   * message and hands it up with the context a model needs to read it, and
   * nothing here looks at the words.
   */
  test("every message routes the same way, whatever it says", async () => {
    const thread = await openThread("inc-1");
    for (const said of [
      "mine",
      "ok back to you",
      "not mine, the webhook is upstream",
      "handing this back once CI is green",
    ]) {
      const route = await reply(thread, said, `1700.${said.length}`);
      assert.equal(route.kind, "incident_reply", said);
      if (route.kind !== "incident_reply") return;
      assert.equal(route.text, said, "the sentence travels whole, unnormalized");
      assert.equal(route.incidentId, "inc-1");
      assert.equal(route.user, "U0HUMAN");
      assert.equal(route.threadTs, thread);
      assert.equal(route.channel, CHANNEL);
    }
  });

  /**
   * "I've got this one from here" is the sentence the relay used to act on by
   * itself, and it acts on nothing now: an agent drives every open incident,
   * so this is a message for the agent like any other. All the relay owes it
   * is the row and the route.
   */
  test("a reply is recorded and owed to the agent before anything reads it", async () => {
    const thread = await openThread("inc-1");
    const route = await reply(thread, "I've got this one from here");

    assert.equal(route.kind, "incident_reply");
    if (route.kind !== "incident_reply") return;
    assert.equal(route.interrupt, false);
    assert.equal(route.agentRunning, true);
    assert.equal(db.query("SELECT id FROM thread_reply").length, 1);
    assert.equal(
      db.query("SELECT id FROM pending_directive").length,
      0,
      "the relay records; what the sentence meant is the caller's to read",
    );
  });

  /**
   * Whether an agent is coming travels with the message, because it is what
   * decides who answers: past the agent statuses nothing is polling for
   * directives, so a reply here is a question for the Slack agent instead.
   */
  test("whether an agent is on it travels with the message", async () => {
    const thread = await openThread("inc-9", "CLOSED");
    const route = await reply(thread, "what did you rule out?");

    assert.equal(route.kind, "incident_reply");
    if (route.kind !== "incident_reply") return;
    assert.equal(route.agentRunning, false);
    assert.equal(
      db.query("SELECT id FROM thread_reply WHERE incidentId = 'inc-9'").length,
      1,
      "recorded either way: the thread is the record",
    );
  });

  test("a mention is marked as one so it interrupts as well as answers", async () => {
    const thread = await openThread("inc-1");
    const route = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> what have you tried`,
      ts: "1700.2",
      thread_ts: thread,
    });

    assert.equal(route.kind, "incident_reply");
    if (route.kind !== "incident_reply") return;
    assert.equal(route.interrupt, true);
    assert.equal(route.agentRunning, true);
  });

  /**
   * The old code returned before the insert for this one case, so Slack's
   * retry of a mention in a thread with no agent ran the Slack agent twice
   * on one question.
   */
  test("a mention with no agent on the incident is recorded, so a retry collapses", async () => {
    const thread = await openThread("inc-9", "CLOSED");
    const first = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> what happened here`,
      ts: "1700.3",
      thread_ts: thread,
    });
    assert.equal(first.kind, "incident_reply");

    const retry = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> what happened here`,
      ts: "1700.3",
      thread_ts: thread,
    });
    assert.deepEqual(retry, { kind: "ignore", reason: "duplicate delivery" });
    assert.equal(db.query("SELECT id FROM thread_reply").length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("mention text helpers", () => {
  test("mentionsBot only matches the real user id", () => {
    assert.equal(mentionsBot(`hi <@${BOT}>`, BOT), true);
    assert.equal(mentionsBot("hi @bugboss", BOT), false);
    assert.equal(mentionsBot("hi <@U0SOMEONE>", BOT), false);
  });

  test("stripBotMention leaves the question", () => {
    assert.equal(
      stripBotMention(`<@${BOT}>  what is open   right now?`, BOT),
      "what is open right now?",
    );
  });
});

// ---------------------------------------------------------------------------

describe("a button press", () => {
  const QUESTION_TS = "1800.5";

  const askWithButtons = async (incidentId: string, status = "INVESTIGATING") => {
    await seedIncident(incidentId, status);
    const thread = await relay.emit({
      type: "opened",
      incidentId,
      title: incidentId,
      signalCount: 1,
    });
    await db.withWrite((d) => {
      d.prepare(
        "INSERT INTO pending_question (incidentId, messageTs, askedAt, message) VALUES (?, ?, ?, ?)",
      ).run(incidentId, QUESTION_TS, Date.now(), "Roll back, or wait?");
    });
    return thread;
  };

  const press = (thread: string, over: Partial<SlackChoiceClick> = {}) =>
    relay.handleChoice({
      channel: CHANNEL,
      user: "U0HUMAN",
      messageTs: QUESTION_TS,
      threadTs: thread,
      choice: "Roll back",
      actionTs: "1800.9",
      ...over,
    });

  test("is recorded and delivered exactly as a typed reply is", async () => {
    const thread = await askWithButtons("inc-1");
    const route = await press(thread);

    assert.deepEqual(route, {
      kind: "answered",
      incidentId: "inc-1",
      choice: "Roll back",
      slackUserId: "U0HUMAN",
      reader: "agent",
    });

    const replies = db.query<{ text: string; slackUserId: string }>(
      "SELECT text, slackUserId FROM thread_reply WHERE incidentId = 'inc-1'",
    );
    assert.deepEqual(replies, [{ text: "Roll back", slackUserId: "U0HUMAN" }]);

    // The agent waits on directives alone, and this is the one it reads. A
    // press it cannot tell from prose is the whole contract.
    const [directive] = db.query<{ payload: string }>(
      "SELECT payload FROM pending_directive WHERE incidentId = 'inc-1'",
    );
    assert.deepEqual(JSON.parse(directive.payload), {
      type: "human_message",
      from: "U0HUMAN",
      text: "Roll back",
      ts: "1800.9",
      // Pressing the agent's own button is addressed to it by construction,
      // so this is the one human_message nothing has to read first.
      addressed: "agent",
    });
  });

  test("anyone in the channel may press, but a question takes one answer", async () => {
    const thread = await askWithButtons("inc-1");
    await press(thread);
    const second = await press(thread, {
      user: "U0OTHER",
      choice: "Wait for the next deploy",
      actionTs: "1801.0",
    });

    assert.deepEqual(second, {
      kind: "duplicate",
      incidentId: "inc-1",
      slackUserId: "U0OTHER",
      reader: "agent",
      // The answer that won, so the thread can name it rather than only tell
      // the second presser that theirs was not it.
      recorded: { choice: "Roll back", slackUserId: "U0HUMAN" },
    });
    assert.equal(
      db.query("SELECT id FROM pending_directive WHERE incidentId = 'inc-1'").length,
      1,
      "the second press delivers nothing",
    );
  });

  test("a press on a question the agent has moved past changes nothing", async () => {
    const thread = await askWithButtons("inc-1");
    // What contact_human does once it has an answer, or once it times out.
    await db.withWrite((d) => {
      d.prepare("DELETE FROM pending_question WHERE incidentId = ?").run("inc-1");
    });

    const route = await press(thread);

    assert.deepEqual(route, {
      kind: "stale",
      incidentId: "inc-1",
      slackUserId: "U0HUMAN",
      reader: "agent",
    });
    assert.equal(
      db.query("SELECT id FROM thread_reply WHERE incidentId = 'inc-1'").length,
      0,
    );
    assert.equal(
      db.query("SELECT id FROM pending_directive WHERE incidentId = 'inc-1'").length,
      0,
      "a stale label must not be filed as the answer to whatever is asked now",
    );
  });

  test("a press quoting an older question is stale, not an answer to this one", async () => {
    const thread = await askWithButtons("inc-1");
    const route = await press(thread, { messageTs: "1700.1" });
    assert.equal(route.kind, "stale");
  });

  /**
   * The press that started this: recorded, acknowledged, and read by nobody.
   * `pending_question` outlives the agent that wrote it -- clearPending does
   * not run when a child is killed mid-wait -- so the EXISTS guard says yes
   * on an incident nothing will ever launch on again, and the directive sits
   * there. The route has to carry that, or the thread thanks somebody for an
   * answer no agent is coming for.
   */
  test("a press on an incident that is over is told nothing will run on it again", async () => {
    const thread = await askWithButtons("inc-5", "CLOSED");
    const route = await press(thread);

    assert.deepEqual(route, {
      kind: "answered",
      incidentId: "inc-5",
      choice: "Roll back",
      slackUserId: "U0HUMAN",
      reader: "closed",
    });
    // Still recorded, and still the same row a typed reply writes. Nothing
    // about the equivalence changes; what changes is what the thread says.
    assert.equal(
      db.query("SELECT id FROM pending_directive WHERE incidentId = 'inc-5'")
        .length,
      1,
    );
  });

  test("a stale press on an incident that is over carries that too", async () => {
    const thread = await askWithButtons("inc-4", "CLOSED");
    await db.withWrite((d) => {
      d.prepare("DELETE FROM pending_question WHERE incidentId = ?").run("inc-4");
    });
    const route = await press(thread);
    assert.deepEqual(route, {
      kind: "stale",
      incidentId: "inc-4",
      slackUserId: "U0HUMAN",
      reader: "closed",
    });
  });

  test("a press in a thread that is not an incident is ignored", async () => {
    await askWithButtons("inc-1");
    const route = await press("9999.9");
    assert.deepEqual(route, {
      kind: "ignore",
      reason: "thread is not an incident thread",
    });
  });

  test("typing the answer still works while the buttons are up", async () => {
    const thread = await askWithButtons("inc-1");
    const route = await relay.handle({
      type: "message",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: "neither — the deploy is already out, just verify it",
      ts: "1800.8",
      thread_ts: thread,
    });

    assert.deepEqual(route, {
      kind: "incident_reply",
      incidentId: "inc-1",
      interrupt: false,
      agentRunning: true,
      channel: CHANNEL,
      threadTs: thread,
      ts: "1800.8",
      user: "U0HUMAN",
      text: "neither — the deploy is already out, just verify it",
    });
    // A typed reply's directive is the composition root's to write, once the
    // intent read says who it was for. The relay's half is the record, and
    // that is what this can see.
    const replies = db.query<{ text: string }>(
      "SELECT text FROM thread_reply WHERE incidentId = 'inc-1'",
    );
    assert.deepEqual(
      replies,
      [{ text: "neither — the deploy is already out, just verify it" }],
      "an answer nobody offered as a button is recorded unchanged",
    );
  });

  test("a crash after the reply row leaves neither the reply nor the directive", async () => {
    const thread = await askWithButtons("inc-1");

    // The seam this covers is the one a press used to be split across: the
    // reply row and the directive were two `withWrite` calls, so a failure
    // between them committed the first and lost the second. Renaming the
    // directive table makes that second statement throw exactly where a
    // crash would land, without stubbing anything the relay reaches through.
    await db.withWrite((d) => {
      d.exec("ALTER TABLE pending_directive RENAME TO pending_directive_gone");
    });

    await assert.rejects(() => press(thread), /pending_directive/);

    const orphaned = db.query(
      "SELECT text FROM thread_reply WHERE incidentId = 'inc-1'",
    );
    assert.deepEqual(
      orphaned,
      [],
      "a reply recorded without its directive is an incident that looks answered and is not acting on the answer",
    );

    await db.withWrite((d) => {
      d.exec("ALTER TABLE pending_directive_gone RENAME TO pending_directive");
    });

    // Nothing was committed, so the question is still answerable. That is
    // the recovery the split version did not have: there, the press was
    // already filed and the button would only ever report a duplicate.
    const retried = await press(thread);
    assert.equal(retried.kind, "answered");
    assert.equal(
      db.query("SELECT 1 FROM pending_directive WHERE incidentId = 'inc-1'")
        .length,
      1,
    );
  });
});
