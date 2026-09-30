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
    d.prepare("DELETE FROM incident_thread").run();
    d.prepare("DELETE FROM incident").run();
  });
  slack = fakeSlack();
  relay = new SlackRelay({
    db,
    slack,
    config: { channelId: CHANNEL, botUserId: BOT, rotationGroupId: ROTATION },
  isBossThread: () => false,
  });
});

// ---------------------------------------------------------------------------

describe("the mention policy", () => {
  const ordinary: RelayEvent[] = [
    { type: "opened", incidentId: "inc-1", title: "500s on /campaigns", signalCount: 1, body: "", origin: null },
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
    isBossThread: () => false,
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
      body: "",
      origin: null,
    });
    assert.ok(text.includes("500s parsing &lt;Config&gt; for a &amp; b"), text);
    assert.ok(text.endsWith("nobody is being paged_"), text);
  });

  test("the opening message carries the report whole, not a title of it", () => {
    // Incident 83 opened on "...I heard about 502s Can you op\u2026" -- the
    // report cut at 120 characters, mid-word, in the message announcing the
    // incident. The thread is where the report lives; the short form is the
    // header above it, which carries the summary the agent writes.
    const report =
      "voter density queries are failing in prod, and they have for a while. " +
      "I heard about 502s. Can you open an incident and work out whether it is " +
      "the pool or the warehouse?";

    const text = renderEvent({
      type: "opened",
      incidentId: "inc-83",
      title: report,
      body: report,
      signalCount: 1,
      origin: null,
    });

    assert.ok(text.includes(report), "the whole report is in the message");
    assert.doesNotMatch(text, /\u2026/);
    // And it is said once: the body already opens on the title.
    assert.equal(text.split("voter density").length, 2);
  });

  test("a body that does not open on the title keeps both", () => {
    // An alert with no summary annotation takes its title from the rule
    // name, and the body has no other line for it.
    const text = renderEvent({
      type: "opened",
      incidentId: "inc-1",
      title: "GpApiPoolSaturation",
      body: "connections in use 24 of 25\nalert: https://goodparty.grafana.net/x",
      signalCount: 1,
      origin: null,
    });

    assert.ok(text.includes("GpApiPoolSaturation"));
    assert.ok(text.includes("connections in use 24 of 25"));
  });

  test("the trailer links what opened the incident rather than only counting it", () => {
    const text = renderEvent({
      type: "opened",
      incidentId: "inc-1",
      title: "t",
      body: "t",
      signalCount: 1,
      origin: {
        label: "a Grafana alert",
        url: "https://goodparty.grafana.net/alerting/grafana/abc/view",
      },
    });

    assert.ok(
      text.includes(
        "<https://goodparty.grafana.net/alerting/grafana/abc/view|a Grafana alert>",
      ),
      text,
    );
    assert.ok(text.includes("_1 signal \u00b7 <https"), text);
  });

  test("a signal with no link still says what kind of thing it was", () => {
    // "1 signal" on its own told a reader nothing about what they were
    // looking at. The label costs nothing and is most of the value, so a
    // missing permalink loses the link and not the sentence.
    const text = renderEvent({
      type: "opened",
      incidentId: "inc-1",
      title: "t",
      body: "t",
      signalCount: 2,
      origin: { label: "a Slack report", url: null },
    });

    assert.ok(text.includes("_2 signals \u00b7 a Slack report \u00b7"), text);
    assert.ok(!text.includes("<"), "nothing is half a link");
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
        body: "",
        origin: null,
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

  test("a pull request on BUGBOSS_GITHUB_URL's host is linked by its number, and github.com is the default", () => {
    const render = (prUrl: string) => renderEvent({ type: "pr_needs_merge", incidentId: "inc-1", prUrl });
    const saved = process.env.BUGBOSS_GITHUB_URL;
    try {
      delete process.env.BUGBOSS_GITHUB_URL;
      assert.ok(render("https://github.com/thegoodparty/omni/pull/2").includes("<https://github.com/thegoodparty/omni/pull/2|thegoodparty/omni#2>"));
      assert.ok(render("https://github/thegoodparty/omni/pull/3").includes("<https://github/thegoodparty/omni/pull/3>"));

      process.env.BUGBOSS_GITHUB_URL = "https://github";
      assert.ok(render("https://github/thegoodparty/omni/pull/3").includes("<https://github/thegoodparty/omni/pull/3|thegoodparty/omni#3>"));
    } finally {
      if (saved === undefined) delete process.env.BUGBOSS_GITHUB_URL;
      else process.env.BUGBOSS_GITHUB_URL = saved;
    }
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
      body: "",
      origin: null,
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
      body: "",
      origin: null,
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
      body: "",
      origin: null,
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
    return relay.emit({
      type: "opened",
      incidentId: id,
      title: id,
      signalCount: 1,
      body: "",
      origin: null,
    });
  };

  /**
   * A reply used to lift a wait here, upstream of anything that read it. It
   * goes to the Boss now, and the Boss messaging the agent is what wakes a
   * parked incident (`pushDirective`), so chatter no longer costs a launch.
   */
  test("a reply leaves a parked incident parked", async () => {
    const thread = await openThread("inc-1");
    await db.withWrite((d) =>
      d
        .prepare(
          `INSERT INTO incident_wait
             (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
           VALUES (?, 'somebody to merge the PR', NULL, 1, ?)`,
        )
        .run("inc-1", Date.now()),
    );

    const route = await relay.handle({
      type: "message",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: "merged it",
      ts: "1700.5",
      thread_ts: thread,
    });

    assert.equal(route.kind, "incident_reply", "the premise: the reply was taken");
    assert.equal(
      db.query("SELECT incidentId FROM incident_wait WHERE incidentId = 'inc-1'").length,
      1,
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
    assert.equal(route.incidentId, "inc-1");
    const replies = db.query<{ text: string; slackUserId: string }>(
      "SELECT text, slackUserId FROM thread_reply WHERE incidentId = 'inc-1'",
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0].slackUserId, "U0HUMAN");

    // Handing it to the Boss is the caller's, off Slack's three seconds.
    // Covered end to end in test/e2e.test.ts.
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

  test("a tagged reply routes exactly as an untagged one does", async () => {
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
      channel: CHANNEL,
      threadTs: thread,
      ts: "1700.2",
      user: "U0HUMAN",
      text: `<@${BOT}> stop, this is expected`,
    });
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

  /**
   * "Can you close incident 2?", untagged, under a Boss answer that began
   * with a channel-level mention. It was dropped here as chatter. The route
   * turns on whether the Boss has a conversation in that thread, and the
   * predicate is handed the thread and never the text.
   */
  test("an untagged follow-up in a Boss conversation thread goes to the Boss", async () => {
    const asked: string[][] = [];
    const followUp = {
      type: "message",
      channel: CHANNEL,
      user: "U0HUMAN",
      text: "Can you close incident 2?",
      ts: "1800.2",
      thread_ts: "1800.1",
    };

    const blind = new SlackRelay({
      db,
      slack,
      config: { channelId: CHANNEL, botUserId: BOT, rotationGroupId: ROTATION },
      isBossThread: () => false,
    });
    assert.equal((await blind.handle(followUp)).kind, "ignore", "premise: dropped without the check");

    const routed = new SlackRelay({
      db,
      slack,
      config: { channelId: CHANNEL, botUserId: BOT, rotationGroupId: ROTATION },
      isBossThread: (...args: string[]) => {
        asked.push(args);
        return Promise.resolve(args[1] === "1800.1");
      },
    });
    const route = await routed.handle(followUp);
    assert.equal(route.kind, "slack_agent");
    if (route.kind !== "slack_agent") return;
    assert.equal(route.threadTs, "1800.1", "answered in the same thread");
    assert.equal(route.text, "Can you close incident 2?");
    assert.deepEqual(asked, [[CHANNEL, "1800.1"]], "decided from the thread alone");

    assert.equal(
      (await routed.handle({ ...followUp, ts: "1900.2", thread_ts: "1900.1" })).kind,
      "ignore",
      "the same words in another thread are chatter",
    );
    assert.equal(
      (await routed.handle({ ...followUp, ts: "1800.3", thread_ts: undefined })).kind,
      "ignore",
      "top-level chatter never asks the thread check",
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
      body: "",
      origin: null,
    });
    const second = await relay.emit({
      type: "opened",
      incidentId: "inc-1",
      title: "t",
      signalCount: 1,
      body: "",
      origin: null,
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
    isBossThread: () => false,
    });

    const errors = await captureErrors(() =>
      halted.emit({
        type: "opened",
        incidentId: "inc-1",
        title: "t",
        signalCount: 1,
        body: "",
        origin: null,
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
    return relay.emit({
      type: "opened",
      incidentId: id,
      title: id,
      signalCount: 1,
      body: "",
      origin: null,
    });
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
   * Nothing here looks at the words. The relay records the message and hands
   * it up whole; what it asks for is the Boss's to read.
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

  test("a reply is recorded before anything reads it, and pushes nothing", async () => {
    const thread = await openThread("inc-1");
    const route = await reply(thread, "I've got this one from here");

    assert.equal(route.kind, "incident_reply");
    assert.equal(db.query("SELECT id FROM thread_reply").length, 1);
    assert.equal(
      db.query("SELECT id FROM pending_directive").length,
      0,
      "the relay records; what the sentence meant is the Boss's to read",
    );
  });

  test("a reply on an incident that is over still belongs to it", async () => {
    const thread = await openThread("inc-9", "CLOSED");
    const route = await reply(thread, "what did you rule out?");

    assert.equal(route.kind, "incident_reply");
    if (route.kind !== "incident_reply") return;
    assert.equal(route.incidentId, "inc-9");
    assert.equal(
      db.query("SELECT id FROM thread_reply WHERE incidentId = 'inc-9'").length,
      1,
      "recorded either way: the thread is the record",
    );
  });

  /**
   * A retry of a mention on an incident that is over must collapse too, or
   * the Boss runs twice on one question.
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
