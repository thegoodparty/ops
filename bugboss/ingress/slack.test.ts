import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { classifySlackEvent, type SlackConfig } from "./slack";
import type { IncomingRequest } from "../types";

const SECRET = "slack-signing-secret";
const BOT = "U0BUGBOSS";
const NOW = 1_764_000_000_000;
const now = () => NOW;

const sign = (body: string, stamp: string, secret = SECRET) =>
  `v0=${createHmac("sha256", secret)
    .update(`v0:${stamp}:${body}`, "utf8")
    .digest("hex")}`;

const request = (
  body: unknown,
  overrides: {
    stamp?: string;
    signature?: string;
    headers?: Record<string, string>;
  } = {},
): IncomingRequest => {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const stamp = overrides.stamp ?? String(Math.floor(NOW / 1000));
  return {
    rawBody,
    headers: {
      "x-slack-signature": overrides.signature ?? sign(rawBody, stamp),
      "x-slack-request-timestamp": stamp,
      ...overrides.headers,
    },
  };
};

const config: SlackConfig = { signingSecret: SECRET, botUserId: BOT, now };

const event = (overrides: Record<string, unknown> = {}) => ({
  type: "event_callback",
  event: {
    type: "app_mention",
    user: "U0HUMAN",
    channel: "C0BUGS",
    ts: "1764000000.000100",
    text: `<@${BOT}> what is open right now`,
    ...overrides,
  },
});

// --- verification: this is the part that must fail closed -----------------

test("rejects every delivery when no signing secret is configured", async () => {
  await assert.rejects(
    classifySlackEvent(request(event()), { botUserId: BOT, now }),
    /no signing secret is configured/,
  );
});

test("accepts a correctly signed delivery", async () => {
  const result = await classifySlackEvent(request(event()), config);
  assert.equal(result.kind, "mention");
});

test("rejects a signature made with the wrong secret", async () => {
  const body = JSON.stringify(event());
  const stamp = String(Math.floor(NOW / 1000));
  await assert.rejects(
    classifySlackEvent(
      request(body, { stamp, signature: sign(body, stamp, "wrong") }),
      config,
    ),
    /signature mismatch/,
  );
});

test("rejects a tampered body under a valid signature", async () => {
  const original = JSON.stringify(event());
  const stamp = String(Math.floor(NOW / 1000));
  const signature = sign(original, stamp);
  const tampered = JSON.stringify(
    event({ user: "U0SOMEONE_ELSE", text: `<@${BOT}> report everything is broken` }),
  );
  await assert.rejects(
    classifySlackEvent(request(tampered, { stamp, signature }), config),
    /signature mismatch/,
  );
});

test("rejects a bare hex digest without the v0 prefix", async () => {
  const body = JSON.stringify(event());
  const stamp = String(Math.floor(NOW / 1000));
  const bare = createHmac("sha256", SECRET)
    .update(`v0:${stamp}:${body}`, "utf8")
    .digest("hex");
  await assert.rejects(
    classifySlackEvent(request(body, { stamp, signature: bare }), config),
    /signature mismatch/,
  );
});

test("rejects a signature over the body alone", async () => {
  const body = JSON.stringify(event());
  const stamp = String(Math.floor(NOW / 1000));
  const bodyOnly = `v0=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
  await assert.rejects(
    classifySlackEvent(request(body, { stamp, signature: bodyOnly }), config),
    /signature mismatch/,
  );
});

test("rejects a signature of a different length without throwing", async () => {
  await assert.rejects(
    classifySlackEvent(request(event(), { signature: "v0=short" }), config),
    /signature mismatch/,
  );
});

test("rejects missing signature and timestamp headers", async () => {
  const a = request(event());
  delete a.headers["x-slack-signature"];
  await assert.rejects(classifySlackEvent(a, config), /missing signature header/);

  const b = request(event());
  delete b.headers["x-slack-request-timestamp"];
  await assert.rejects(classifySlackEvent(b, config), /missing timestamp header/);
});

test("rejects a replayed delivery outside the window", async () => {
  const stamp = String(Math.floor(NOW / 1000) - 600);
  const body = JSON.stringify(event());
  await assert.rejects(
    classifySlackEvent(request(body, { stamp, signature: sign(body, stamp) }), config),
    /outside the replay window/,
  );
});

test("rejects a non-numeric timestamp", async () => {
  const body = JSON.stringify(event());
  await assert.rejects(
    classifySlackEvent(
      request(body, { stamp: "soon", signature: sign(body, "soon") }),
      config,
    ),
    /timestamp header is not a number/,
  );
});

test("header names are matched case-insensitively", async () => {
  const body = JSON.stringify(event());
  const stamp = String(Math.floor(NOW / 1000));
  const result = await classifySlackEvent(
    {
      rawBody: body,
      headers: {
        "X-Slack-Signature": sign(body, stamp),
        "X-Slack-Request-Timestamp": stamp,
      },
    },
    config,
  );
  assert.equal(result.kind, "mention");
});

// --- classification --------------------------------------------------------

test("a url_verification handshake is surfaced with its challenge", async () => {
  const result = await classifySlackEvent(
    request({ type: "url_verification", challenge: "abc123" }),
    config,
  );
  assert.deepEqual(result, { kind: "url_verification", challenge: "abc123" });
});

/**
 * The one thing `ignored` must never swallow. An untagged reply in an
 * incident's thread is the documented way to answer a waiting agent, and the
 * HTTP layer decides whether a delivery earns its :eyes: by excluding
 * `ignored` -- so calling this one ignored is how somebody answers an agent,
 * sees no acknowledgement, and cannot tell whether it landed.
 *
 * It is also not a reading of the message: which thread it is in is a
 * `slackThreadTs` lookup, which is why this survives in a layer that no
 * longer interprets anything.
 */
test("an untagged reply in an incident thread is not ignored", async () => {
  for (const text of [
    "yes, org X bypasses the Stripe webhook",
    "back to you",
    "no idea, I was afk",
  ]) {
    const result = await classifySlackEvent(
      request(
        event({
          type: "message",
          text,
          thread_ts: "1764000000.000001",
          ts: "1764000000.000200",
        }),
      ),
      { ...config, isIncidentThread: (_c, ts) => ts === "1764000000.000001" },
    );
    assert.equal(result.kind, "incident_reply", text);
  }
});

test("a tagged reply in an incident thread is that incident's, not a new question", async () => {
  const result = await classifySlackEvent(
    request(
      event({
        text: `<@${BOT}> what did you rule out?`,
        thread_ts: "1764000000.000001",
        ts: "1764000000.000200",
      }),
    ),
    { ...config, isIncidentThread: (_c, ts) => ts === "1764000000.000001" },
  );
  assert.equal(
    result.kind,
    "incident_reply",
    "the same order the relay routes in: the thread wins over the tag",
  );
});

test("a threaded mention in a thread we do not own is a mention", async () => {
  const result = await classifySlackEvent(
    request(
      event({ thread_ts: "1764000000.000001", ts: "1764000000.000200" }),
    ),
    config,
  );
  assert.equal(result.kind, "mention");
});

/**
 * The old contract here was that the first word had to be "report", "bug" or
 * "broken". It is gone: this layer does not read the words a person chose, so
 * a report and a question look identical until a model reads them, which
 * happens off the ack in the composition root.
 */
test("every mention classifies the same, whatever it says", async () => {
  for (const text of [
    `<@${BOT}> what is open right now`,
    `<@${BOT}> report Pro upgrades look broken`,
    `<@${BOT}> Pro upgrades are failing for everyone on Safari`,
    `<@${BOT}> ugh the dashboard is 500ing again`,
    `<@${BOT}> report`,
  ]) {
    const result = await classifySlackEvent(request(event({ text })), config);
    assert.equal(result.kind, "mention", text);
    assert.equal(
      result.kind === "mention" ? result.message.text : "",
      text.replace(`<@${BOT}>`, "").trim(),
      "the mention markup is stripped and the sentence is passed on whole",
    );
  }
});

test("bot messages are ignored so the Boss does not ingest itself", async () => {
  for (const overrides of [{ bot_id: "B0BUGBOSS" }, { subtype: "bot_message" }]) {
    const result = await classifySlackEvent(request(event(overrides)), config);
    assert.equal(result.kind, "ignored");
  }
  const self = await classifySlackEvent(request(event({ user: BOT })), config);
  assert.equal(self.kind, "ignored");
});

test("a message that does not address bugboss is ignored", async () => {
  const result = await classifySlackEvent(
    request(event({ type: "message", text: "anyone seen the deploy go out?" })),
    config,
  );
  assert.equal(result.kind, "ignored");
});

test("an edited or deleted message carries no new report", async () => {
  const result = await classifySlackEvent(
    request(event({ type: "message", subtype: "message_changed" })),
    config,
  );
  assert.equal(result.kind, "ignored");
});

test("a retry is classified but flagged", async () => {
  const result = await classifySlackEvent(
    request(event(), { headers: { "x-slack-retry-num": "2" } }),
    config,
  );
  assert.equal(result.kind, "mention");
  assert.equal(result.kind === "mention" && result.message.retry, true);
});

test("an unreadable body throws rather than defaulting", async () => {
  const stamp = String(Math.floor(NOW / 1000));
  await assert.rejects(
    classifySlackEvent(
      request("not json", { stamp, signature: sign("not json", stamp) }),
      config,
    ),
    /body was not JSON/,
  );
});
