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
