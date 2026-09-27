import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { CHOICE_ACTION_PREFIX } from "../slack/blocks";
import {
  classifySlackEvent,
  classifySlackInteraction,
  createSlackAdapter,
  isInteractionDelivery,
  type SlackConfig,
} from "./slack";
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

test("the adapter verifies before it classifies", async () => {
  const adapter = createSlackAdapter({ botUserId: BOT, now });
  await assert.rejects(
    adapter.parse(request(event())),
    /no signing secret is configured/,
  );
});

// --- classification --------------------------------------------------------

test("a url_verification handshake is surfaced with its challenge", async () => {
  const result = await classifySlackEvent(
    request({ type: "url_verification", challenge: "abc123" }),
    config,
  );
  assert.deepEqual(result, { kind: "url_verification", challenge: "abc123" });
});

test("a reply in an incident thread is an incident_reply, not a mention", async () => {
  const result = await classifySlackEvent(
    request(
      event({
        type: "message",
        text: `<@${BOT}> I am taking this one`,
        thread_ts: "1764000000.000001",
        ts: "1764000000.000200",
      }),
    ),
    { ...config, isIncidentThread: (_c, ts) => ts === "1764000000.000001" },
  );
  assert.equal(
    result.kind,
    "incident_reply",
    "inside a live incident thread people talk to the incident agent, mention or not",
  );
});

test("a reply in a thread that is not an incident falls through", async () => {
  const result = await classifySlackEvent(
    request(
      event({ thread_ts: "1764000000.000001", ts: "1764000000.000200" }),
    ),
    config,
  );
  assert.equal(result.kind, "mention");
});

test("a plain mention spawns the Slack agent, not a signal", async () => {
  const result = await classifySlackEvent(request(event()), config);
  assert.equal(result.kind, "mention");
  const signals = await createSlackAdapter(config).parse(request(event()));
  assert.deepEqual(signals, [], "a question is not a bug report");
});

test("a report verb makes a bug report", async () => {
  for (const verb of ["report", "bug", "broken", "REPORT"]) {
    const result = await classifySlackEvent(
      request(event({ text: `<@${BOT}> ${verb} Pro upgrades look broken` })),
      config,
    );
    assert.equal(result.kind, "bug_report", verb);
    assert.equal(
      result.kind === "bug_report" ? result.report : "",
      "Pro upgrades look broken",
    );
  }
});

test("a report verb with nothing after it is ignored", async () => {
  const result = await classifySlackEvent(
    request(event({ text: `<@${BOT}> report` })),
    config,
  );
  assert.equal(result.kind, "ignored");
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

// --- the signal a report produces -----------------------------------------

test("a Slack bug report becomes a human signal with its stakeholder", async () => {
  const [signal] = await createSlackAdapter(config).parse(
    request(
      event({
        text: `<@${BOT}> report Pro upgrades look broken`,
        thread_ts: "1764000000.000001",
        ts: "1764000000.000200",
      }),
    ),
  );

  assert.equal(signal.source, "human");
  assert.equal(signal.kind, "bug_report");
  assert.equal(signal.reportedBy, "U0HUMAN");
  assert.equal(signal.title, "Pro upgrades look broken");
  assert.equal(signal.sourceId, "slack:C0BUGS:1764000000.000200");
  assert.equal(signal.labels.never_suppress, "true");
  assert.equal(signal.labels.resolution_policy, "verification");
  assert.equal(signal.labels.slack_channel, "C0BUGS");
  assert.equal(signal.labels.slack_thread_ts, "1764000000.000001");
});

test("a Slack retry of the same report dedups", async () => {
  const adapter = createSlackAdapter(config);
  const body = event({ text: `<@${BOT}> report broken thing` });
  const [first] = await adapter.parse(request(body));
  const [second] = await adapter.parse(
    request(body, { headers: { "x-slack-retry-num": "1" } }),
  );
  assert.equal(adapter.dedupKey(first), adapter.dedupKey(second));
  assert.match(adapter.dedupKey(first), /^human:slack:/);
});

test("a Slack adapter pre-fetches nothing", async () => {
  const adapter = createSlackAdapter(config);
  assert.deepEqual(await adapter.prefetchEvidence({} as never), []);
});

// --- interactions: a different encoding, the same signature scheme ---------

const CLICK = {
  type: "block_actions",
  user: { id: "U0HUMAN" },
  channel: { id: "C0BUGS" },
  message: { ts: "1764000000.000300", thread_ts: "1764000000.000001" },
  actions: [
    {
      action_id: `${CHOICE_ACTION_PREFIX}0`,
      value: "Roll back",
      action_ts: "1764000000.000400",
    },
  ],
};

/** How Slack actually delivers one: a form body, not JSON. */
const interaction = (
  payload: unknown,
  overrides: { signature?: string; stamp?: string } = {},
): IncomingRequest => {
  const rawBody = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  const stamp = overrides.stamp ?? String(Math.floor(NOW / 1000));
  return {
    rawBody,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": overrides.signature ?? sign(rawBody, stamp),
      "x-slack-request-timestamp": stamp,
    },
  };
};

test("an interaction is told from an event by its content type alone", () => {
  assert.equal(isInteractionDelivery(interaction(CLICK)), true);
  assert.equal(isInteractionDelivery(request(event())), false);
});

test("rejects a click whose signature was made with the wrong secret", () => {
  const req = interaction(CLICK);
  const stamp = req.headers["x-slack-request-timestamp"];
  assert.throws(
    () =>
      classifySlackInteraction(
        interaction(CLICK, { signature: sign(req.rawBody, stamp, "not-the-secret") }),
        config,
      ),
    /signature mismatch/,
  );
});

test("rejects a click signed over a different body", () => {
  // The whole point of signing the raw body: swapping the answer after the
  // fact has to fail, because the form encoding is what was signed.
  const honest = interaction(CLICK);
  const tampered = {
    ...honest,
    rawBody: honest.rawBody.replace("Roll+back", "Drop+the+database"),
  };
  assert.throws(() => classifySlackInteraction(tampered, config), /signature mismatch/);
});

test("rejects a replayed click", () => {
  const stale = String(Math.floor(NOW / 1000) - 600);
  assert.throws(
    () => classifySlackInteraction(interaction(CLICK, { stamp: stale }), config),
    /replay window/,
  );
});

test("rejects every click when no signing secret is configured", () => {
  assert.throws(
    () => classifySlackInteraction(interaction(CLICK), { botUserId: BOT, now }),
    /no signing secret is configured/,
  );
});

test("a verified click carries the label, the question and who pressed it", () => {
  const result = classifySlackInteraction(interaction(CLICK), config);
  assert.equal(result.kind, "choice");
  assert.deepEqual(result.kind === "choice" ? result.click : null, {
    channel: "C0BUGS",
    user: "U0HUMAN",
    messageTs: "1764000000.000300",
    threadTs: "1764000000.000001",
    choice: "Roll back",
    actionTs: "1764000000.000400",
  });
});

test("a button that is not ours is ignored, not guessed at", () => {
  const foreign = {
    ...CLICK,
    actions: [{ action_id: "someone_elses_button", value: "x", action_ts: "1.0" }],
  };
  const result = classifySlackInteraction(interaction(foreign), config);
  assert.deepEqual(result, { kind: "ignored", reason: "not a bugboss choice button" });
});

test("anything but a button press is ignored", () => {
  const submission = { ...CLICK, type: "view_submission" };
  const result = classifySlackInteraction(interaction(submission), config);
  assert.equal(result.kind, "ignored");
});

test("a verified but incomplete payload is ignored rather than half-read", () => {
  const headless = { ...CLICK, message: {} };
  const result = classifySlackInteraction(interaction(headless), config);
  assert.deepEqual(result, { kind: "ignored", reason: "incomplete interaction" });
});

test("a form body with no payload field is a rejected delivery, not an empty one", () => {
  const stamp = String(Math.floor(NOW / 1000));
  assert.throws(
    () =>
      classifySlackInteraction(
        {
          rawBody: "nothing=here",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-signature": sign("nothing=here", stamp),
            "x-slack-request-timestamp": stamp,
          },
        },
        config,
      ),
    /no payload field/,
  );
});
