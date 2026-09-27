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
