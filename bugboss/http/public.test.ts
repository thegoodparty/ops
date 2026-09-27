// The ingest paths' failure behaviour. The happy paths are covered through
// the composition root; what is covered here is the half that has no caller
// left to tell: a route that throws.
//
// This is the primary ingest path, so a failure here is a dropped alert. The
// rule the whole system rests on is that nothing fails silently, and Hono's
// default error handler answers 500 without saying a word — which is what
// made this worth a file of its own.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { IngestRejected } from "./errors";
import { CHOICE_ACTION_PREFIX } from "../slack/blocks";
import type { SlackChoiceClick } from "../slack/blocks";
import type { SlackAck } from "../slack/ack";
import { createPublicApp, type PublicAppDeps } from "./public";

const SIGNING_SECRET = "test-signing-secret";

/** Captures the structured alarm lines a request produces. */
const withCapturedErrors = async <T>(
  body: () => Promise<T>,
): Promise<{ result: T; errors: string[] }> => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    errors.push(String(line));
  };
  try {
    return { result: await body(), errors };
  } finally {
    console.error = original;
  }
};

const deps = (over: Partial<PublicAppDeps> = {}): PublicAppDeps => ({
  ingestAccepted: async () => ({ settled: Promise.resolve(), recorded: 1 }),
  slackEventAccepted: async () => ({ settled: Promise.resolve() }),
  acknowledgeSlack: () => {},
  slackInteractionAccepted: async () => ({ settled: Promise.resolve() }),
  slackConfig: {},
  ...over,
});

const post = async (
  app: ReturnType<typeof createPublicApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** A delivery Slack's own verifier would accept, so the route gets past 401. */
const signedSlack = async (
  app: ReturnType<typeof createPublicApp>,
  body: unknown,
): Promise<Response> => {
  const raw = JSON.stringify(body);
  const stamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${stamp}:${raw}`, "utf8")
    .digest("hex")}`;
  return app.request("/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": stamp,
      "x-slack-signature": signature,
    },
    body: raw,
  });
};

test("alarms when the grafana ingest write fails", async () => {
  const app = createPublicApp(
    deps({
      ingestAccepted: async () => {
        throw new Error("s3 put failed");
      },
    }),
  );

  const { result: res, errors } = await withCapturedErrors(() =>
    post(app, "/grafana", { alerts: [] }),
  );

  assert.equal(res.status, 500);
  assert.equal(errors.length, 1, "a dropped alert has to leave a trace");
  const alarm = JSON.parse(errors[0]) as Record<string, unknown>;
  assert.equal(alarm.level, "error");
  assert.equal(alarm.event, "route_failed");
  assert.equal(alarm.path, "/grafana");
  assert.match(String(alarm.error), /s3 put failed/);
});

test("alarms when the slack report write fails", async () => {
  // The /slack route had no try/catch at all, so a failed write here reached
  // Hono directly. Signed properly on purpose: an unsigned body answers 401
  // long before ingest, which would make this pass without proving anything.
  let reached = false;
  const app = createPublicApp(
    deps({
      slackConfig: { signingSecret: SIGNING_SECRET },
      ingestAccepted: async () => {
        reached = true;
        throw new Error("db is read-only");
      },
    }),
  );

  const { result: res, errors } = await withCapturedErrors(() =>
    signedSlack(app, {
      type: "event_callback",
      event: {
        type: "app_mention",
        user: "U1",
        channel: "C1",
        ts: "1.0",
        text: "<@B1> report checkout is down",
      },
    }),
  );

  assert.ok(reached, "the request has to actually get as far as the write");
  assert.equal(res.status, 500, "a failed write must not read as accepted");
  assert.equal(errors.length, 1);
  const alarm = JSON.parse(errors[0]) as Record<string, unknown>;
  assert.equal(alarm.event, "route_failed");
  assert.equal(alarm.path, "/slack");
});

test("a rejected delivery answers 401 without alarming", async () => {
  // The distinction the alarm level exists for: a refused delivery is a
  // thing that happened, not a failure nobody asked for. Alarming on it
  // would teach people to ignore alarms.
  const app = createPublicApp(
    deps({
      ingestAccepted: async () => {
        throw new IngestRejected("bad signature");
      },
    }),
  );

  const { result: res, errors } = await withCapturedErrors(() =>
    post(app, "/grafana", { alerts: [] }),
  );

  assert.equal(res.status, 401);
  assert.deepEqual(errors, [], "a refused delivery is not a failure of ours");
});

test("health stays flat 200 so ECS does not replace a degraded task", async () => {
  const app = createPublicApp(deps());
  const res = await app.request("/health");
  assert.equal(res.status, 200);
});

// --- the acknowledgement ----------------------------------------------------
//
// What matters here is which deliveries earn one and where it sits relative to
// the 200, not what the reaction call itself does — that is slack/ack.test.ts.

/** A delivery signed well enough to get past the 401, with a bot to mention. */
const slackDeps = (
  acknowledged: SlackAck[],
  over: Partial<PublicAppDeps> = {},
): PublicAppDeps =>
  deps({
    slackConfig: { signingSecret: SIGNING_SECRET, botUserId: "B1" },
    acknowledgeSlack: (ack) => {
      acknowledged.push(ack);
    },
    ...over,
  });

test("a mention is acknowledged before the agent that answers it runs", async () => {
  // The interesting ordering: the Slack agent is a model run of up to two
  // minutes, so an ack that waited on it would be no ack at all.
  const acknowledged: SlackAck[] = [];
  const order: string[] = [];
  const app = createPublicApp(
    slackDeps(acknowledged, {
      acknowledgeSlack: (ack) => {
        order.push("ack");
        acknowledged.push(ack);
      },
      slackEventAccepted: async () => {
        order.push("work");
        return { settled: Promise.resolve() };
      },
    }),
  );

  const res = await signedSlack(app, {
    type: "event_callback",
    event: {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "1.0",
      text: "<@B1> what is open right now",
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(acknowledged, [{ kind: "mention", channel: "C1", ts: "1.0" }]);
  assert.deepEqual(order, ["ack", "work"]);
});

test("a bug report is acknowledged before the signal is written", async () => {
  const acknowledged: SlackAck[] = [];
  const order: string[] = [];
  const app = createPublicApp(
    slackDeps(acknowledged, {
      acknowledgeSlack: (ack) => {
        order.push("ack");
        acknowledged.push(ack);
      },
      ingestAccepted: async () => {
        order.push("ingest");
        return { settled: Promise.resolve(), recorded: 1 };
      },
    }),
  );

  const res = await signedSlack(app, {
    type: "event_callback",
    event: {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "2.0",
      text: "<@B1> report checkout is down",
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(acknowledged, [
    { kind: "bug_report", channel: "C1", ts: "2.0" },
  ]);
  assert.deepEqual(order, ["ack", "ingest"]);
});

test("a reply in an incident thread is acknowledged", async () => {
  // The case with the worst feedback today: contact_human is answered by a
  // plain reply, and nothing visible happens until the agent next polls.
  const acknowledged: SlackAck[] = [];
  const app = createPublicApp(
    slackDeps(acknowledged, {
      slackConfig: {
        signingSecret: SIGNING_SECRET,
        botUserId: "B1",
        isIncidentThread: () => true,
      },
    }),
  );

  const res = await signedSlack(app, {
    type: "event_callback",
    event: {
      type: "message",
      user: "U1",
      channel: "C1",
      ts: "3.1",
      thread_ts: "3.0",
      text: "yes, roll it back",
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(acknowledged, [
    { kind: "incident_reply", channel: "C1", ts: "3.1" },
  ]);
});

test("channel chatter BugBoss ignores gets no reaction", async () => {
  // An :eyes: on a message nothing will ever answer claims BugBoss is on it.
  const acknowledged: SlackAck[] = [];
  const app = createPublicApp(slackDeps(acknowledged));

  const res = await signedSlack(app, {
    type: "event_callback",
    event: {
      type: "message",
      user: "U1",
      channel: "C1",
      ts: "4.0",
      text: "anyone seen the deploy go out",
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(acknowledged, [], "nobody addressed this to BugBoss");
});

test("the url_verification handshake gets no reaction", async () => {
  // There is no message to put one on, and Slack's challenge is not a person.
  const acknowledged: SlackAck[] = [];
  const app = createPublicApp(slackDeps(acknowledged));

  const res = await signedSlack(app, {
    type: "url_verification",
    challenge: "abc123",
  });

  assert.equal(await res.text(), "abc123");
  assert.deepEqual(acknowledged, []);
});

test("a rejected delivery is never acknowledged", async () => {
  // The ack sits behind verification on purpose. In front of it, anyone who
  // can reach the ALB could make BugBoss react to any message in the channel.
  const acknowledged: SlackAck[] = [];
  const app = createPublicApp(slackDeps(acknowledged));

  const res = await app.request("/slack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "event_callback", event: {} }),
  });

  assert.equal(res.status, 401);
  assert.deepEqual(acknowledged, []);
});

test("an acknowledgement that hangs does not hold up the 200", async () => {
  // Slack retries a delivery it has not seen answered in three seconds, and a
  // retry is a second run of the same work. The `void` return type is what
  // makes this structural; this pins that the route respects it.
  const app = createPublicApp(
    deps({
      slackConfig: { signingSecret: SIGNING_SECRET, botUserId: "B1" },
      acknowledgeSlack: () => {
        // A real reactions.add against a throttled channel, near enough.
        void new Promise(() => {});
      },
    }),
  );

  const res = await signedSlack(app, {
    type: "event_callback",
    event: {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "5.0",
      text: "<@B1> status",
    },
  });

  assert.equal(res.status, 200);
});

// The body is read before anything authenticates it, because the HMAC is over
// the raw bytes. So the size bound is the only thing standing between an
// anonymous caller and the task's heap, and it has to hold before the handler
// runs rather than inside it.
test("an oversized grafana delivery is refused without being ingested", async () => {
  let ingested = 0;
  const app = createPublicApp(
    deps({
      ingestAccepted: async () => {
        ingested++;
        return { settled: Promise.resolve(), recorded: 1 };
      },
    }),
  );

  const { result: res } = await withCapturedErrors(async () =>
    app.request("/grafana", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    }),
  );

  assert.equal(res.status, 413);
  assert.equal(ingested, 0);
});

test("an oversized slack delivery is refused the same way", async () => {
  const app = createPublicApp(deps());

  const { result: res } = await withCapturedErrors(async () =>
    app.request("/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    }),
  );

  assert.equal(res.status, 413);
});

// A refused burst would silently undo the `maxAlerts: 0` the contact point is
// set to, so the refusal is an alarm rather than a log line.
test("an oversized delivery alarms rather than passing quietly", async () => {
  const app = createPublicApp(deps());

  const { errors } = await withCapturedErrors(async () =>
    app.request("/grafana", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    }),
  );

  assert.ok(
    errors.some((line) => line.includes("body_rejected")),
    `expected a body_rejected alarm, got ${JSON.stringify(errors)}`,
  );
});

test("a normal delivery is still ingested", async () => {
  let ingested = 0;
  const app = createPublicApp(
    deps({
      ingestAccepted: async () => {
        ingested++;
        return { settled: Promise.resolve(), recorded: 1 };
      },
    }),
  );

  const res = await post(app, "/grafana", { status: "firing", alerts: [] });

  assert.notEqual(res.status, 413);
  assert.equal(ingested, 1);
});

// Reading the body is the first thing both routes do, before anything
// authenticates the caller. So an anonymous client that declares a length and
// then hangs up makes the read throw. Alarming on that would let anyone bury a
// real route_failed — the backstop for a dropped alert — under any volume of
// identical lines.
const abortedBody = (): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.error(new Error("aborted"));
    },
  });

test("a caller hanging up mid-body logs rather than alarming", async () => {
  let ingested = 0;
  const app = createPublicApp(
    deps({
      ingestAccepted: async () => {
        ingested++;
        return { settled: Promise.resolve(), recorded: 1 };
      },
    }),
  );

  const { result: res, errors } = await withCapturedErrors(async () =>
    app.request("/grafana", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: abortedBody(),
      // @ts-expect-error undici requires this for a stream body; Hono's types
      // describe the standard RequestInit, which has no such field.
      duplex: "half",
    }),
  );

  assert.equal(res.status, 400);
  assert.equal(ingested, 0);
  assert.equal(
    errors.filter((line) => line.includes("route_failed")).length,
    0,
    `a client disconnect must not alarm, got ${JSON.stringify(errors)}`,
  );
});

// The blocker a reviewer caught on the first version of this fix. Classifying
// disconnects by matching the error message demoted this to a log line: the
// AWS SDK's socket failures inside db.withWrite throw the same shapes, and a
// failed write on the ingest path IS a dropped alert. Only the body read can
// raise BodyUnreadable now, so no message can be mistaken for one.
test("an S3 write failure that reads like a disconnect still alarms", async () => {
  for (const message of ["terminated", "aborted", "ECONNRESET"]) {
    const app = createPublicApp(
      deps({
        ingestAccepted: async () => {
          throw new Error(message);
        },
      }),
    );

    const { result: res, errors } = await withCapturedErrors(async () =>
      post(app, "/grafana", { status: "firing", alerts: [] }),
    );

    assert.equal(res.status, 500, `${message} should not be a client disconnect`);
    assert.ok(
      errors.some((line) => line.includes("route_failed")),
      `${message} must still alarm, got ${JSON.stringify(errors)}`,
    );
  }
});

test("a genuine route failure still alarms", async () => {
  const app = createPublicApp(
    deps({
      ingestAccepted: async () => {
        throw new Error("s3 is refusing writes");
      },
    }),
  );

  const { result: res, errors } = await withCapturedErrors(async () =>
    post(app, "/grafana", { status: "firing", alerts: [] }),
  );

  assert.equal(res.status, 500);
  assert.ok(
    errors.some((line) => line.includes("route_failed")),
    `expected a route_failed alarm, got ${JSON.stringify(errors)}`,
  );
});

// getReader() takes an exclusive lock on the body. Returning the 413 without
// cancelling holds that lock, and whatever the sender is still pushing, until
// GC — the path that enforces the limit keeping alive the resource it bounds.
test("the oversized path cancels the reader rather than abandoning it", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });

  const app = createPublicApp(deps());

  const { result: res } = await withCapturedErrors(async () =>
    app.request("/grafana", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // @ts-expect-error undici requires this for a stream body; Hono's types
      // describe the standard RequestInit, which has no such field.
      duplex: "half",
    }),
  );

  assert.equal(res.status, 413);
  assert.ok(cancelled, "the reader must be cancelled when the limit is hit");
});

// A cancel that throws must not turn a deliberate 413 into a route_failed
// alarm — that is the alarm standing for a dropped alert, handed to whoever
// sends an oversized body with an awkward stream.
test("a throwing cancel does not turn the 413 into an alarm", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() {
      throw new Error("cancel blew up");
    },
  });

  const app = createPublicApp(deps());

  const { result: res, errors } = await withCapturedErrors(async () =>
    app.request("/grafana", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // @ts-expect-error undici requires this for a stream body; Hono's types
      // describe the standard RequestInit, which has no such field.
      duplex: "half",
    }),
  );

  assert.equal(res.status, 413);
  assert.equal(
    errors.filter((line) => line.includes("route_failed")).length,
    0,
    `a throwing cancel must not alarm, got ${JSON.stringify(errors)}`,
  );
});

// --- interactivity shares the event path, not a new one --------------------

const CLICK_PAYLOAD = {
  type: "block_actions",
  user: { id: "U0HUMAN" },
  channel: { id: "C1" },
  message: { ts: "2.0", thread_ts: "1.0" },
  actions: [
    { action_id: `${CHOICE_ACTION_PREFIX}0`, value: "Roll back", action_ts: "3.0" },
  ],
};

/** A press, encoded the way Slack encodes one: a form body, not JSON. */
const pressed = (
  app: ReturnType<typeof createPublicApp>,
  payload: unknown = CLICK_PAYLOAD,
  signWith = SIGNING_SECRET,
) => {
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const stamp = String(Math.floor(Date.now() / 1000));
  return app.request("/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": stamp,
      "x-slack-signature": `v0=${createHmac("sha256", signWith)
        .update(`v0:${stamp}:${raw}`, "utf8")
        .digest("hex")}`,
    },
    body: raw,
  });
};

test("a signed press reaches the relay down the same path as an event", async () => {
  const clicks: SlackChoiceClick[] = [];
  const app = createPublicApp(
    deps({
      slackConfig: { signingSecret: SIGNING_SECRET },
      slackInteractionAccepted: async (click) => {
        clicks.push(click);
        return { settled: Promise.resolve() };
      },
    }),
  );

  const res = await pressed(app);

  assert.equal(res.status, 200);
  // A JSON body here is read by Slack as a replacement for the message that
  // was clicked, which would delete the question out from under the thread.
  assert.equal(await res.text(), "");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].choice, "Roll back");
  assert.equal(clicks[0].messageTs, "2.0");
});

test("an unsigned press is refused, and never reaches the relay", async () => {
  let reached = false;
  const app = createPublicApp(
    deps({
      slackConfig: { signingSecret: SIGNING_SECRET },
      slackInteractionAccepted: async () => {
        reached = true;
        return { settled: Promise.resolve() };
      },
    }),
  );

  const res = await pressed(app, CLICK_PAYLOAD, "not-the-signing-secret");

  assert.equal(res.status, 401);
  assert.equal(reached, false, "an open endpoint would let anyone answer an agent");
});

test("an interaction that is not ours is ignored, and the event path is untouched", async () => {
  let reached = false;
  const app = createPublicApp(
    deps({
      slackConfig: { signingSecret: SIGNING_SECRET },
      slackInteractionAccepted: async () => {
        reached = true;
        return { settled: Promise.resolve() };
      },
    }),
  );

  const res = await pressed(app, {
    ...CLICK_PAYLOAD,
    actions: [{ action_id: "someone_elses", value: "x", action_ts: "3.0" }],
  });

  assert.equal(res.status, 200);
  assert.equal(reached, false);
});

test("a JSON event is still routed as an event", async () => {
  let events = 0;
  let clicks = 0;
  const app = createPublicApp(
    deps({
      slackConfig: { signingSecret: SIGNING_SECRET },
      slackEventAccepted: async () => {
        events += 1;
        return { settled: Promise.resolve() };
      },
      slackInteractionAccepted: async () => {
        clicks += 1;
        return { settled: Promise.resolve() };
      },
    }),
  );

  await signedSlack(app, {
    type: "event_callback",
    event: { type: "message", user: "U1", channel: "C1", ts: "1.0", text: "roll it back" },
  });

  assert.equal(events, 1, "free text answers by the path it always did");
  assert.equal(clicks, 0);
});
