import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { Db } from "../db";
import {
  SlackRelay,
  earnsMention,
  mentionsBot,
  ownershipClaim,
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

const seedIncident = (id: string, status = "INVESTIGATING", owner = "agent") =>
  db.withWrite((d) => {
    d.prepare(
      "INSERT INTO incident (id, status, owner, firstSignalAt) VALUES (?, ?, ?, ?)",
    ).run(id, status, owner, Date.now());
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
    d.prepare("DELETE FROM thread_reply").run();
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
    { type: "escalated", incidentId: "inc-1", reason: "deadline", brief: "what I ruled out" },
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

  test("exactly three things earn a mention", () => {
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

  test("an escalation pings the rotation group", async () => {
    await seedIncident("inc-1");
    await relay.emit(ordinary[0]);
    await relay.emit(earns[0]);
    assert.match(slack.posts[1].text, new RegExp(`^<!subteam\\^${ROTATION}> `));
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
    await r.emit(earns[2]);
    assert.match(solo.posts[1].text, /^<!here> /);
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
  const openThread = async (id: string, status = "INVESTIGATING", owner = "agent") => {
    await seedIncident(id, status, owner);
    return relay.emit({ type: "opened", incidentId: id, title: id, signalCount: 1 });
  };

  test("an untagged reply answers the agent waiting on it", async () => {
    const thread = await openThread("inc-1");
    const route = await relay.handle({
      type: "message",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: "yes, org X bypasses the Stripe webhook",
      ts: "1700.1",
      thread_ts: thread,
    });

    assert.deepEqual(
      route,
      { kind: "incident_reply", incidentId: "inc-1", interrupt: false },
      "answering is not interrupting",
    );
    const replies = db.query<{ text: string; slackUserId: string }>(
      "SELECT text, slackUserId FROM thread_reply WHERE incidentId = 'inc-1'",
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0].slackUserId, "U0HUMAN");

    // contact_human waits on directives alone, so no directive means the
    // agent blocks until it times out and escalates over an answer it has.
    const [directive] = db.query<{ payload: string }>(
      "SELECT payload FROM pending_directive WHERE incidentId = 'inc-1'",
    );
    assert.deepEqual(JSON.parse(directive.payload), {
      type: "human_message",
      from: "U0HUMAN",
      text: "yes, org X bypasses the Stripe webhook",
      ts: "1700.1",
    });
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
    assert.equal(db.query("SELECT id FROM thread_reply").length, 1);
    assert.equal(
      db.query("SELECT id FROM pending_directive").length,
      1,
      "and the agent is told once, not twice",
    );
  });

  test("a mention interrupts a working agent with a directive", async () => {
    const thread = await openThread("inc-1");
    const route = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> stop, this is expected`,
      ts: "1700.2",
      thread_ts: thread,
    });

    assert.deepEqual(route, {
      kind: "incident_reply",
      incidentId: "inc-1",
      interrupt: true,
    });
    const [directive] = db.query<{ payload: string }>(
      "SELECT payload FROM pending_directive WHERE incidentId = 'inc-1'",
    );
    assert.deepEqual(JSON.parse(directive.payload), {
      type: "human_message",
      from: "U0HUMAN",
      text: `<@${BOT}> stop, this is expected`,
      ts: "1700.2",
    });
  });

  test("a mention in a thread with no agent running goes to the Slack agent", async () => {
    const thread = await openThread("inc-9", "INVESTIGATING", "human");
    const route = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> what did the agent rule out?`,
      ts: "1700.3",
      thread_ts: thread,
    });

    assert.equal(route.kind, "slack_agent");
    assert.equal(
      db.query("SELECT id FROM pending_directive").length,
      0,
      "there is no agent to interrupt",
    );
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
    assert.equal(db.query("SELECT id FROM pending_directive").length, 1);
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
          type: "escalated",
          incidentId: "inc-1",
          reason: "deadline",
          brief: "what I ruled out",
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
      type: "escalated",
      incidentId: "inc-1",
      reason: "deadline",
      brief: "what I ruled out",
    });
    assert.equal(
      slack.posts[1].threadTs,
      "ts-1",
      "one recovered thread beats a channel of loose messages",
    );
  });
});

// ---------------------------------------------------------------------------

describe("claiming an incident", () => {
  const openThread = async (id: string, status = "INVESTIGATING", owner = "agent") => {
    await seedIncident(id, status, owner);
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

  test("the claim words are matched whole, not found inside a sentence", () => {
    assert.equal(ownershipClaim("mine", BOT), "take_over");
    assert.equal(ownershipClaim("  Mine.  ", BOT), "take_over");
    assert.equal(ownershipClaim(`<@${BOT}> mine`, BOT), "take_over");
    assert.equal(ownershipClaim("back to you", BOT), "hand_back");
    assert.equal(ownershipClaim("Back to you!", BOT), "hand_back");

    for (const said of [
      "not mine",
      "that one is mine to fix",
      "mine looks fine, yours does not",
      "handing this back to you once CI is green",
      "",
    ]) {
      assert.equal(ownershipClaim(said, BOT), null, said);
    }
  });

  test("an untagged claim is routed as a claim and still reaches the agent", async () => {
    const thread = await openThread("inc-1");
    const route = await reply(thread, "mine");

    assert.deepEqual(route, {
      kind: "ownership_claim",
      incidentId: "inc-1",
      claim: "take_over",
      slackUserId: "U0HUMAN",
      ts: "1700.1",
    });
    assert.equal(db.query("SELECT id FROM thread_reply").length, 1);
    assert.equal(
      db.query("SELECT id FROM pending_directive").length,
      1,
      "a claim is still an answer the agent is owed",
    );
  });

  test("the relay does not flip owner itself", async () => {
    const thread = await openThread("inc-1");
    await reply(thread, "mine");

    const row = db.get<{ owner: string }>(
      "SELECT owner FROM incident WHERE id = 'inc-1'",
    );
    assert.equal(row?.owner, "agent", "the write belongs to the tool API");
  });

  test("handing it back is its own claim", async () => {
    const thread = await openThread("inc-1", "INVESTIGATING", "human");
    const route = await reply(thread, "back to you");

    assert.equal(route.kind, "ownership_claim");
    if (route.kind !== "ownership_claim") return;
    assert.equal(route.claim, "hand_back");
  });

  test("a tagged claim is a claim, not a question for the read-only agent", async () => {
    const thread = await openThread("inc-9", "INVESTIGATING", "human");
    const route = await relay.handle({
      type: "app_mention",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: `<@${BOT}> mine`,
      ts: "1700.2",
      thread_ts: thread,
    });

    assert.equal(
      route.kind,
      "ownership_claim",
      "the Slack agent would answer that it cannot take ownership",
    );
  });

  test("a reply that only mentions a claim word stays an ordinary reply", async () => {
    const thread = await openThread("inc-1");
    const route = await reply(thread, "not mine, the webhook is upstream");

    assert.deepEqual(route, {
      kind: "incident_reply",
      incidentId: "inc-1",
      interrupt: false,
    });
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
