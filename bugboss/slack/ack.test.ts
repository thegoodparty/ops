// What the acknowledgement does when Slack refuses it.
//
// The happy path is one line and would be the easy thing to cover alone. The
// cases worth a file are the three refusals: a scope that was added to the
// manifest and never installed, an ordinary duplicate, and anything else. Two
// of those must alarm and one must not, and getting that backwards either
// hides a dead ack or teaches people to ignore alarms.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ACK_EMOJI, createSlackAck, type SlackReactor } from "./ack";

interface Captured {
  logs: Record<string, unknown>[];
  alarms: Record<string, unknown>[];
}

/**
 * Runs the ack and waits for its detached promise to settle. Two microtask
 * turns, because the handler hangs off a `.then().catch()` on the caller's.
 */
const run = async (
  slack: SlackReactor,
  ack: { kind: string; channel: string; ts: string } = {
    kind: "mention",
    channel: "C1",
    ts: "1.0",
  },
): Promise<Captured> => {
  const captured: Captured = { logs: [], alarms: [] };
  const log = console.log;
  const error = console.error;
  console.log = (line: unknown) => {
    captured.logs.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  console.error = (line: unknown) => {
    captured.alarms.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  try {
    const returned = createSlackAck(slack)(ack);
    assert.equal(
      returned,
      undefined,
      "the ack must not hand the caller something to await",
    );
    await Promise.resolve();
    await Promise.resolve();
    return captured;
  } finally {
    console.log = log;
    console.error = error;
  }
};

/** Slack's SDK shape: the code that matters is on `.data.error`. */
const platformError = (code: string): Error =>
  Object.assign(new Error(`An API error occurred: ${code}`), {
    data: { ok: false, error: code },
  });

test("reacts with eyes on the message that arrived", async () => {
  const calls: { channel: string; ts: string; name: string }[] = [];
  const captured = await run({
    react: (channel, ts, name) => {
      calls.push({ channel, ts, name });
      return Promise.resolve();
    },
  });

  assert.deepEqual(calls, [{ channel: "C1", ts: "1.0", name: ACK_EMOJI }]);
  assert.deepEqual(captured.alarms, []);
  assert.equal(captured.logs.length, 1);
  assert.equal(captured.logs[0].event, "acknowledged");
  assert.equal(captured.logs[0].kind, "mention");
});

test("a missing scope alarms rather than disappearing", async () => {
  // The scope is in slack-app-manifest.yaml and does nothing until someone
  // reinstalls the app. Swallowed, that would look exactly like a BugBoss
  // that is working: the answer still posts, just with no sign it is coming.
  const captured = await run({
    react: () => Promise.reject(platformError("missing_scope")),
  });

  assert.deepEqual(captured.logs, []);
  assert.equal(captured.alarms.length, 1);
  assert.equal(captured.alarms[0].level, "error");
  assert.equal(captured.alarms[0].event, "ack_failed");
  assert.equal(captured.alarms[0].error, "missing_scope");
  assert.equal(captured.alarms[0].ts, "1.0");
});

test("already_reacted logs, because it is the outcome we wanted", async () => {
  // A Slack retry and the two copies of a threaded mention both land here.
  // Alarming on the ordinary case is how a rotation learns to ignore alarms.
  const captured = await run({
    react: () => Promise.reject(platformError("already_reacted")),
  });

  assert.deepEqual(captured.alarms, []);
  assert.equal(captured.logs.length, 1);
  assert.equal(captured.logs[0].event, "already_acknowledged");
});

test("an error with no Slack code still alarms, with what it had", async () => {
  // A socket hangup or the deadline in index.ts carries no `.data.error`,
  // so the fallback has to be the error itself and not an empty field.
  const captured = await run({
    react: () => Promise.reject(new Error("slack reactions.add exceeded 10000ms")),
  });

  assert.deepEqual(captured.logs, []);
  assert.equal(captured.alarms.length, 1);
  assert.equal(captured.alarms[0].event, "ack_failed");
  assert.match(String(captured.alarms[0].error), /exceeded 10000ms/);
});

test("a reactor that throws synchronously does not reach the caller", async () => {
  // `void slack.react(...)` only catches a rejected promise. A client that
  // throws on the way in would otherwise propagate into the request handler
  // and turn a working answer into a 500.
  const captured = await run({
    react: () => {
      throw new Error("client not configured");
    },
  });

  assert.equal(captured.alarms.length, 1);
  assert.equal(captured.alarms[0].event, "ack_failed");
  assert.match(String(captured.alarms[0].error), /client not configured/);
});

test("a reaction that never answers leaves the caller free", async () => {
  // The bound in production is the ten-second deadline the composition root
  // wraps every Slack call in. What this pins is the shape underneath it:
  // nothing waits, and nothing is claimed until Slack answers.
  const captured = await run({ react: () => new Promise(() => {}) });

  assert.deepEqual(captured.logs, []);
  assert.deepEqual(captured.alarms, []);
});
