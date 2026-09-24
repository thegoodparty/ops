import assert from "node:assert/strict";
import { test } from "node:test";

import type { Directive, ToolResponse } from "../types";
import {
  directiveTimestampMillis,
  firstReplyAfter,
  runContactHuman,
  runMonitor,
  shellProbe,
  truncateOutput,
  type HumanContactPort,
  type PendingQuestion,
  type Probe,
} from "./tools";

const fakeClock = () => {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

test("monitor returns as soon as the command exits 0", async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const probe: Probe = async (command) => {
    calls.push(command);
    return { code: 0, output: "MERGED\n" };
  };

  const result = await runMonitor(
    { command: "gh pr view x", intervalSeconds: 30, timeoutSeconds: 3600, description: "the PR" },
    { probe, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(result, { output: "MERGED\n", timedOut: false });
  assert.equal(calls.length, 1);
});

test("monitor keeps waiting through non-zero exits and costs one call", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const probe: Probe = async () => {
    attempts += 1;
    return attempts < 4 ? { code: 1, output: "pending" } : { code: 0, output: "success" };
  };

  const result = await runMonitor(
    { command: "check", intervalSeconds: 30, timeoutSeconds: 3600, description: "a deploy" },
    { probe, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.timedOut, false);
  assert.equal(result.output, "success");
  assert.equal(attempts, 4);
});

test("monitor gives up at the deadline and returns the last output", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const probe: Probe = async () => {
    attempts += 1;
    return { code: 1, output: `still firing (${attempts})` };
  };

  const result = await runMonitor(
    { command: "check", intervalSeconds: 60, timeoutSeconds: 300, description: "quiet" },
    { probe, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.timedOut, true);
  assert.match(result.output, /still firing/);
  assert.equal(attempts, 6);
});

test("monitor stops when the turn is aborted", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  controller.abort();

  const result = await runMonitor(
    { command: "check", intervalSeconds: 5, timeoutSeconds: 86400, description: "anything" },
    { probe: async () => ({ code: 1, output: "no" }), sleep: clock.sleep, now: clock.now, signal: controller.signal },
  );

  assert.equal(result.timedOut, true);
});

test("monitor output is capped", async () => {
  const result = await runMonitor(
    { command: "cat huge", intervalSeconds: 1, timeoutSeconds: 1, description: "a big log" },
    { probe: async () => ({ code: 0, output: "x".repeat(50000) }), maxOutputChars: 1000 },
  );

  assert.ok(result.output.length < 1200);
  assert.match(result.output, /characters elided/);
});

test("the real probe reports exit codes from the shell", async () => {
  assert.deepEqual(await shellProbe("printf ok", 5000), { code: 0, output: "ok" });
  const failure = await shellProbe("exit 3", 5000);
  assert.equal(failure.code, 3);
});

test("truncateOutput leaves small output alone", () => {
  assert.equal(truncateOutput("short", 1000), "short");
});

const fakeContact = (pending: PendingQuestion | null = null) => {
  const state = { pending, posts: [] as string[], cleared: 0, recorded: 0 };
  const port: HumanContactPort = {
    getPending: async () => state.pending,
    recordPending: async (message) => {
      state.recorded += 1;
      state.pending = { message, askedAt: 1_000_000 };
      return state.pending;
    },
    post: async (message) => {
      state.posts.push(message);
    },
    clearPending: async () => {
      state.cleared += 1;
      state.pending = null;
    },
  };
  return { state, port };
};

const incidentResponses = (...batches: Directive[][]) => {
  let index = 0;
  return async (): Promise<ToolResponse<never>> => {
    const directives = batches[Math.min(index, batches.length - 1)] ?? [];
    index += 1;
    return { ok: true, directives };
  };
};

test("contact_human records the question before posting, then waits for a reply", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const getIncident = incidentResponses(
    [],
    [{ type: "human_message", from: "U1", text: "restarted it", ts: "1000.500000" }],
  );

  const result = await runContactHuman(
    { message: "Can someone restart the worker?", timeoutSeconds: 3600 },
    { contact: port, api: { getIncident }, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(result, { reply: "restarted it", timedOut: false });
  assert.equal(state.recorded, 1);
  assert.deepEqual(state.posts, ["Can someone restart the worker?"]);
  assert.equal(state.cleared, 1);
});

test("a resumed agent resumes waiting instead of asking twice", async () => {
  const clock = fakeClock();
  // The marker the pre-restart run wrote before it posted.
  const { state, port } = fakeContact({ message: "Can someone restart the worker?", askedAt: 999_000 });
  const getIncident = incidentResponses([
    { type: "human_message", from: "U1", text: "done", ts: "1000.000000" },
  ]);

  const result = await runContactHuman(
    { message: "Can someone restart the worker?", timeoutSeconds: 3600 },
    { contact: port, api: { getIncident }, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(result, { reply: "done", timedOut: false });
  assert.equal(state.posts.length, 0);
  assert.equal(state.recorded, 0);
});

test("contact_human times out and stops treating the question as outstanding", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const getIncident = incidentResponses([]);

  const result = await runContactHuman(
    { message: "anyone?", timeoutSeconds: 120 },
    { contact: port, api: { getIncident }, sleep: clock.sleep, now: clock.now, pollSeconds: 30 },
  );

  assert.deepEqual(result, { reply: null, timedOut: true });
  assert.equal(state.cleared, 1);
  assert.equal(state.pending, null);
});

test("replies older than the question are not answers to it", () => {
  const directives: Directive[] = [
    { type: "human_message", from: "U1", text: "earlier chatter", ts: "900.000000" },
    { type: "new_signals", count: 2, summary: "two more" },
    { type: "human_message", from: "U2", text: "the answer", ts: "1100.000000" },
  ];

  assert.equal(firstReplyAfter(directives, 1_000_000)?.text, "the answer");
  assert.equal(firstReplyAfter([directives[0]], 1_000_000), null);
});

test("slack and millisecond timestamps both compare", () => {
  assert.equal(directiveTimestampMillis("1758700000.000200"), 1758700000000.2);
  assert.equal(directiveTimestampMillis("1758700000000"), 1758700000000);
  assert.equal(directiveTimestampMillis("2026-09-24T00:00:00.000Z"), Date.parse("2026-09-24T00:00:00.000Z"));
});
