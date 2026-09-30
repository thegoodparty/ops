import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import { WebClient } from "@slack/web-api";

import { signSlackRequest } from "./events";
import { startSlackStandin, type SlackStandin } from "./server";

const TOKEN = "xoxb-sim";
const SECRET = "sim-signing-secret";
const CHANNEL = "C0INCIDENT";

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  valid: boolean;
}

let standin: SlackStandin;
let receiver: Server;
let received: Received[] = [];
let answerStatus = 200;
let web: WebClient;

// The same check BugBoss's ingress makes. Written out here rather than
// imported, because sim/ may not reach into bugboss/.
const verify = (headers: Received["headers"], body: string) => {
  const stamp = String(headers["x-slack-request-timestamp"]);
  const expected = `v0=${createHmac("sha256", SECRET)
    .update(`v0:${stamp}:${body}`, "utf8")
    .digest("hex")}`;
  return (
    headers["x-slack-signature"] === expected &&
    Math.abs(Date.now() / 1000 - Number(stamp)) < 300
  );
};

const waitFor = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const human = async (text: string, threadTs?: string) => {
  const res = await fetch(
    `${standin.controlUrl}/__control/human-message?wait=delivered`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "U0ONCALL", channel: CHANNEL, threadTs, text }),
    },
  );
  return (await res.json()) as { ok: boolean; ts: string; error?: string };
};

before(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ headers: req.headers, body, valid: verify(req.headers, body) });
      res.writeHead(answerStatus).end("{}");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
  const receiverPort = (receiver.address() as AddressInfo).port;

  standin = await startSlackStandin({
    store: {
      channels: [CHANNEL, "C0ALERTS"],
      users: [
        { id: "U0BUGBOSS", name: "bugboss", realName: "BugBoss", isBot: true },
        { id: "U0ONCALL", name: "casey", realName: "Casey Oncall", isBot: false },
      ],
      usergroups: { S0ROTATION: ["U0ONCALL"] },
      botUserId: "U0BUGBOSS",
      botId: "B0BUGBOSS",
      teamId: "T0SIM",
      workspaceDomain: "goodparty-sim.slack.com",
    },
    botToken: TOKEN,
    events: {
      eventsUrl: `http://127.0.0.1:${receiverPort}/slack`,
      signingSecret: SECRET,
      apiAppId: "A0BUGBOSS",
      retryDelaysMs: [5, 5, 5],
    },
    port: 0,
    controlPort: 0,
    host: "127.0.0.1",
    repliesPageCap: 2,
  });
  // The same construction bugboss/slack/client.ts uses, pointed here.
  web = new WebClient(TOKEN, {
    slackApiUrl: standin.apiUrl,
    retryConfig: { retries: 0 },
  });
});

after(async () => {
  await standin.close();
  await new Promise<void>((r) => receiver.close(() => r()));
});

beforeEach(async () => {
  await fetch(`${standin.controlUrl}/__control/reset`, { method: "POST" });
  received = [];
  answerStatus = 200;
});

test("a post, a reply and an edit come back through conversations.replies across pages", async () => {
  const parent = await web.chat.postMessage({
    channel: CHANNEL,
    text: "Incident 1 opened",
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.ok(parent.ts);
  for (const n of [1, 2, 3, 4, 5]) {
    await web.chat.postMessage({ channel: CHANNEL, thread_ts: parent.ts, text: `reply ${n}` });
  }
  await web.chat.update({ channel: CHANNEL, ts: parent.ts, text: "header\nIncident 1 opened" });

  // BugBoss's loop: follow next_cursor to the end and key the parent out.
  const byTs = new Map<string, string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await web.conversations.replies({
      channel: CHANNEL,
      ts: parent.ts,
      limit: 200,
      cursor,
    });
    pages++;
    assert.equal(res.messages?.[0]?.ts, parent.ts, "every page leads with the parent");
    for (const m of res.messages ?? []) byTs.set(String(m.ts), String(m.text));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  assert.equal(pages, 3);
  assert.deepEqual([...byTs.values()], [
    "header\nIncident 1 opened",
    "reply 1",
    "reply 2",
    "reply 3",
    "reply 4",
    "reply 5",
  ]);
});

test("oldest excludes what was already read, and the parent still leads", async () => {
  const parent = await web.chat.postMessage({ channel: CHANNEL, text: "open" });
  const first = await web.chat.postMessage({ channel: CHANNEL, thread_ts: parent.ts, text: "a" });
  await web.chat.postMessage({ channel: CHANNEL, thread_ts: parent.ts, text: "b" });
  const res = await web.conversations.replies({
    channel: CHANNEL,
    ts: parent.ts!,
    oldest: first.ts,
  });
  assert.deepEqual(res.messages?.map((m) => m.text), ["open", "b"]);
});

test("a message past Slack's 40,000 characters is refused with msg_too_long, and counted", async () => {
  await assert.rejects(
    web.chat.postMessage({ channel: CHANNEL, text: "x".repeat(40_001) }),
    (err: { data?: { error?: string } }) => err.data?.error === "msg_too_long",
  );
  await web.chat.postMessage({ channel: CHANNEL, text: "x".repeat(40_000) });
  const state = standin.store.snapshot();
  assert.equal(state.refused.msgTooLong, 1);
  assert.equal(state.channels[0].messages.length, 1);
});

test("a permalink carries Slack's thread query string for a reply", async () => {
  const parent = await web.chat.postMessage({ channel: CHANNEL, text: "open" });
  const reply = await web.chat.postMessage({ channel: CHANNEL, thread_ts: parent.ts, text: "r" });
  const top = await web.chat.getPermalink({ channel: CHANNEL, message_ts: parent.ts! });
  const inner = await web.chat.getPermalink({ channel: CHANNEL, message_ts: reply.ts! });
  const digits = parent.ts!.replace(".", "");
  assert.equal(top.permalink, `https://goodparty-sim.slack.com/archives/${CHANNEL}/p${digits}`);
  assert.equal(
    inner.permalink,
    `https://goodparty-sim.slack.com/archives/${CHANNEL}/p${reply.ts!.replace(".", "")}?thread_ts=${parent.ts}&cid=${CHANNEL}`,
  );
});

test("a second identical reaction is already_reacted", async () => {
  const parent = await web.chat.postMessage({ channel: CHANNEL, text: "open" });
  await web.reactions.add({ channel: CHANNEL, timestamp: parent.ts!, name: "eyes" });
  await assert.rejects(
    web.reactions.add({ channel: CHANNEL, timestamp: parent.ts!, name: "eyes" }),
    (err: { data?: { error?: string } }) => err.data?.error === "already_reacted",
  );
});

test("the external upload flow lands the file in the thread, and a byte mismatch is refused", async () => {
  const parent = await web.chat.postMessage({ channel: CHANNEL, text: "open" });
  const content = "# Post-mortem\n\nThe pool ran dry — every request waited.";
  const body = Buffer.from(content, "utf8");
  const ticket = await web.files.getUploadURLExternal({
    filename: "incident-1.md",
    length: body.byteLength,
  });
  const put = await fetch(ticket.upload_url!, { method: "POST", body });
  assert.equal(put.status, 200);
  await web.files.completeUploadExternal({
    files: [{ id: ticket.file_id!, title: "Incident 1 closing report" }],
    channel_id: CHANNEL,
    thread_ts: parent.ts,
    initial_comment: "Closing report",
  });

  const state = standin.store.snapshot();
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].content, content);
  assert.equal(state.files[0].threadTs, parent.ts);
  assert.equal(state.files[0].title, "Incident 1 closing report");
  assert.deepEqual(state.channels[0].messages[0].replies[0].files, [ticket.file_id]);

  const short = await web.files.getUploadURLExternal({ filename: "x.md", length: 100 });
  await fetch(short.upload_url!, { method: "POST", body: Buffer.from("tiny") });
  await assert.rejects(
    web.files.completeUploadExternal({
      files: [{ id: short.file_id!, title: "x" }],
      channel_id: CHANNEL,
    }),
    (err: { data?: { error?: string } }) =>
      err.data?.error === "file_upload_size_mismatch",
  );
});

test("usergroups and users answer from config, and a wrong token is invalid_auth", async () => {
  const group = await web.usergroups.users.list({ usergroup: "S0ROTATION" });
  assert.deepEqual(group.users, ["U0ONCALL"]);
  const user = await web.users.info({ user: "U0ONCALL" });
  assert.equal(user.user?.real_name, "Casey Oncall");
  const stranger = new WebClient("xoxb-wrong", {
    slackApiUrl: standin.apiUrl,
    retryConfig: { retries: 0 },
  });
  await assert.rejects(
    stranger.chat.postMessage({ channel: CHANNEL, text: "hi" }),
    (err: { data?: { error?: string } }) => err.data?.error === "invalid_auth",
  );
  await assert.rejects(
    web.chat.postMessage({ channel: "C0NOWHERE", text: "hi" }),
    (err: { data?: { error?: string } }) => err.data?.error === "channel_not_found",
  );
});

test("a person's reply reaches BugBoss as a signed message event, and a mention arrives twice", async () => {
  const parent = await web.chat.postMessage({ channel: CHANNEL, text: "open" });
  await waitFor(() => received.length === 1, "the bot echo");
  const echo = JSON.parse(received[0].body);
  assert.equal(echo.event.bot_id, "B0BUGBOSS");

  received = [];
  const plain = await human("the pool is 25 per task, I checked", parent.ts);
  assert.equal(plain.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].valid, true);
  const event = JSON.parse(received[0].body);
  assert.equal(event.type, "event_callback");
  assert.equal(event.event.type, "message");
  assert.equal(event.event.user, "U0ONCALL");
  assert.equal(event.event.thread_ts, parent.ts);
  assert.equal(event.event.bot_id, undefined);

  received = [];
  await human("<@U0BUGBOSS> please merge 3 into this one", parent.ts);
  assert.deepEqual(
    received.map((r) => JSON.parse(r.body).event.type),
    ["message", "app_mention"],
  );
  assert.ok(received.every((r) => r.valid));
});

test("an event nobody acknowledges is retried with Slack's retry headers", async () => {
  answerStatus = 500;
  await human("anyone?");
  const mine = received.filter((r) => JSON.parse(r.body).event?.user === "U0ONCALL");
  assert.equal(mine.length, 4);
  assert.deepEqual(
    mine.map((r) => r.headers["x-slack-retry-num"]),
    [undefined, "1", "2", "3"],
  );
  assert.equal(standin.store.snapshot().deliveries.length, 4);
});

test("the control port is the only way to post as a person", async () => {
  const bad = await fetch(`${standin.controlUrl}/__control/human-message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "U0BUGBOSS", channel: CHANNEL, text: "hi" }),
  });
  assert.equal(bad.status, 400);
  const onApi = await fetch(`${standin.apiUrl.replace(/\/api\/$/, "")}/__control/state`);
  assert.equal(onApi.status, 404);
});

test("signSlackRequest matches Slack's documented v0 example", () => {
  // From Slack's "Verifying requests" guide.
  const body =
    "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
  assert.equal(
    signSlackRequest("8f742231b10e8888abcd99yyyzzz85a5", 1531420618, body),
    "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
  );
});
