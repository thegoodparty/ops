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
