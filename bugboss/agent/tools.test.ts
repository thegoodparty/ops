import assert from "node:assert/strict";
import { test } from "node:test";

import type { Directive, ToolResponse } from "../types";
import type { PendingDirective } from "./tools";
import { MAX_CHOICE_OPTIONS } from "../slack/blocks";
import { THREAD_PROSE_CHARS } from "../slack/format";
import {
  CONTACT_HUMAN_MESSAGE_LIMIT,
  createContactHumanTool,
  createMonitorTool,
  HEARTBEAT_MAX_PINGS,
  directiveTimestampMillis,
  firstReplyAfter,
  insideWorkingHours,
  parseWorkingHours,
  runContactHuman,
  runMonitor,
  heartbeatMessage,
  shellProbe,
  stalledWaitBrief,
  truncateOutput,
  unansweredBrief,
  type HeartbeatDeps,
  type HumanContactPort,
  type PendingQuestion,
  type PendingWait,
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

  assert.deepEqual(result, {
    output: "MERGED\n",
    timedOut: false,
    escalation: null,
    directives: [],
  });
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
  const state = {
    pending,
    posts: [] as string[],
    options: [] as (readonly string[] | undefined)[],
    cleared: 0,
    recorded: 0,
  };
  const port: HumanContactPort = {
    getPending: async () => state.pending,
    recordPending: async (message) => {
      state.recorded += 1;
      state.pending = state.pending?.message === message
        ? state.pending
        : { message, messageTs: "", askedAt: 1_000_000 };
      return state.pending;
    },
    post: async (message, options) => {
      state.posts.push(message);
      state.options.push(options);
      if (state.pending) {
        state.pending = { ...state.pending, messageTs: `ts-${state.posts.length}` };
      }
    },
    clearPending: async () => {
      state.cleared += 1;
      state.pending = null;
    },
  };
  return { state, port };
};

/**
 * The hand-off port the harness reaches for when nobody answers. Recording,
 * because the assertion that matters is that ownership actually moved.
 */
const recordingEscalate = (
  response: { ok: boolean; error?: string; directives?: Directive[] } = { ok: true },
) => {
  const calls: { reason: string; brief: string }[] = [];
  return {
    calls,
    port: {
      handOff: async (args: { reason: string; brief: string }) => {
        calls.push(args);
        return {
          ok: response.ok,
          error: response.error,
          directives: response.directives ?? [],
        };
      },
    },
  };
};

/**
 * The non-draining read the poll makes. A batch stays readable for as long as
 * the fake is asked for it, which is the property the real route has and the
 * draining `getIncident` did not. `consumeDirective` is the one removal, so
 * a consumed directive really is gone from every later read.
 */
const directiveFeed = (...batches: Directive[][]) => {
  let index = 0;
  const reads: number[] = [];
  const consumed = new Set<number>();
  const peekDirectives = async (): Promise<PendingDirective[]> => {
    const batch = batches[Math.min(index, batches.length - 1)] ?? [];
    index += 1;
    const live = batch
      .map((directive, position) => ({ id: position + 1, directive }))
      .filter((entry) => !consumed.has(entry.id));
    reads.push(live.length);
    return live;
  };
  return {
    peekDirectives,
    consumeDirective: async (id: number) => {
      consumed.add(id);
    },
    reads,
    consumed,
  };
};

test("contact_human records the question before posting, then waits for a reply", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed(
    [],
    [{ type: "human_message", from: "U1", text: "restarted it", ts: "1000.500000" }],
  );

  const result = await runContactHuman(
    { message: "Can someone restart the worker?", timeoutSeconds: 3600 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(result, {
    reply: "restarted it",
    timedOut: false,
    directives: [],
    terminate: false,
    rejected: null,
    escalation: null,
  });
  assert.equal(state.recorded, 1);
  assert.deepEqual(state.posts, ["Can someone restart the worker?"]);
  assert.equal(state.cleared, 1);
});

test("a resumed agent resumes waiting instead of asking twice", async () => {
  const clock = fakeClock();
  // The marker the pre-restart run wrote before it posted.
  const { state, port } = fakeContact({
    message: "Can someone restart the worker?",
    messageTs: "ts-1",
    askedAt: 999_000,
  });
  const escalate = recordingEscalate();
  const api = directiveFeed([
    { type: "human_message", from: "U1", text: "done", ts: "1000.000000" },
  ]);

  const result = await runContactHuman(
    { message: "Can someone restart the worker?", timeoutSeconds: 3600 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.reply, "done");
  assert.equal(result.timedOut, false);
  assert.equal(state.posts.length, 0);
  assert.equal(state.recorded, 0);
});

test("a question nobody answers becomes a hand-off, not a longer wait", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  const result = await runContactHuman(
    { message: "anyone?", timeoutSeconds: 120 },
    {
      contact: port,
      api,
      escalate: escalate.port,
      sleep: clock.sleep,
      now: clock.now,
      pollSeconds: 30,
      minWaitSeconds: 600,
    },
  );

  assert.deepEqual(result, {
    reply: null,
    timedOut: true,
    directives: [],
    terminate: true,
    rejected: null,
    escalation: { handedOff: true, reason: "no reply in 10 minutes" },
  });
  assert.equal(escalate.calls.length, 1, "owner has to actually move to a human");
  assert.match(escalate.calls[0].brief, /What I asked/);
  assert.match(escalate.calls[0].brief, /anyone\?/);
  assert.equal(state.cleared, 1);
  assert.equal(state.pending, null);
});

test("a wait shorter than the floor is raised to it, not answered early", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  await runContactHuman(
    { message: "anyone?", timeoutSeconds: 60 },
    {
      contact: port,
      api,
      escalate: escalate.port,
      sleep: clock.sleep,
      now: clock.now,
      pollSeconds: 60,
      minWaitSeconds: 600,
    },
  );

  // Ten minutes of polling, not one: the model cannot shorten its way out of
  // the escalation by asking for a wait nobody could answer inside.
  assert.equal(api.reads.length, 11);
  assert.equal(escalate.calls[0].reason, "no reply in 10 minutes");
});

test("a failed automatic hand-off leaves the incident with the agent, loudly", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate({
    ok: false,
    error: "could not post the hand-off brief",
  });
  const api = directiveFeed([]);

  const tool = await createContactHumanTool({
    contact: port,
    api,
    escalate: escalate.port,
    sleep: clock.sleep,
    now: clock.now,
    minWaitSeconds: 600,
  });
  const result = await tool.execute(
    "call-1",
    { message: "anyone?", timeoutSeconds: 600 } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(result.terminate, false, "nobody was told, so the agent still has it");
  const text = String(result.content[0].type === "text" && result.content[0].text);
  assert.match(text, /could not post the hand-off brief/);
  assert.match(text, /Call hand_off yourself now/);
});

test("directives collected by the escalating hand-off are handed back", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate({
    ok: true,
    directives: [{ type: "new_signals", count: 3, summary: "three more 500s" }],
  });
  const api = directiveFeed([]);

  const result = await runContactHuman(
    { message: "anyone?", timeoutSeconds: 600 },
    {
      contact: port,
      api,
      escalate: escalate.port,
      sleep: clock.sleep,
      now: clock.now,
      minWaitSeconds: 600,
    },
  );

  assert.deepEqual(result.directives, [
    { type: "new_signals", count: 3, summary: "three more 500s" },
  ]);
});

test("an ask longer than the limit is refused before anything is posted", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  const result = await runContactHuman(
    { message: "x".repeat(CONTACT_HUMAN_MESSAGE_LIMIT + 1), timeoutSeconds: 3600 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.timedOut, false);
  assert.match(String(result.rejected), /move the queries, counts and rule ids into "details"/);
  assert.deepEqual(state.posts, [], "a refused ask is not a half-posted one");
  assert.equal(state.recorded, 0);
  assert.equal(escalate.calls.length, 0);
});

test("details longer than a thread post is refused before the ask goes out", async () => {
  // The order is what makes this worth a test of its own. `details` is posted
  // after the ask and after the marker, so leaving the check to the loopback
  // route would 400 with the question already in the thread and no wait
  // started -- an ask nobody is waiting on, which is the failure this whole
  // tool is built around.
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  const result = await runContactHuman(
    {
      message: "Is the rollback safe?",
      details: "x".repeat(THREAD_PROSE_CHARS + 1),
      timeoutSeconds: 3600,
    },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.match(String(result.rejected), /details is \d+ characters/);
  assert.match(String(result.rejected), /post-mortem/);
  assert.deepEqual(state.posts, [], "the ask is not posted either");
  assert.equal(state.recorded, 0, "and no marker is left behind to resume on");
  assert.equal(escalate.calls.length, 0);
});

test("details that fit go out as their own post under the ask", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  await runContactHuman(
    {
      message: "Is the rollback safe?",
      details: "x".repeat(THREAD_PROSE_CHARS),
      timeoutSeconds: 0,
    },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(state.posts.length, 2, "the ask, then the evidence beneath it");
});

test("a resume re-posts the evidence rather than losing it silently", async () => {
  const clock = fakeClock();
  // The ask landed and set messageTs; the process died before the evidence
  // post. The marker cannot tell the two apart, and a skipped evidence post
  // has no error attached to it.
  const { state, port } = fakeContact({
    message: "can someone check #dev-alerts?",
    messageTs: "ts-1",
    askedAt: 1_000_000,
  });
  const escalate = recordingEscalate();
  const api = directiveFeed(
    [],
    [{ type: "human_message", from: "U1", text: "checked", ts: "1000.500000" }],
  );

  await runContactHuman(
    {
      message: "can someone check #dev-alerts?",
      details: "Zero 5xx over 24h (3.4M lines).",
      timeoutSeconds: 3600,
    },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(
    state.posts,
    ["Zero 5xx over 24h (3.4M lines)."],
    "the ask is not repeated; the evidence is not dropped",
  );
});

test("the escalation clock runs from the question, not from this process", async () => {
  const clock = fakeClock();
  // A marker 700 seconds old: the agent asked, the container died, and the
  // replacement replays the call. A fresh wait here would let a crash loop
  // defer the hand-off for as long as the crashes last.
  const { port } = fakeContact({
    message: "anyone?",
    messageTs: "ts-1",
    askedAt: 1_000_000 - 700_000,
  });
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  const result = await runContactHuman(
    { message: "anyone?", timeoutSeconds: 600 },
    {
      contact: port,
      api,
      escalate: escalate.port,
      sleep: clock.sleep,
      now: clock.now,
      minWaitSeconds: 600,
    },
  );

  assert.deepEqual(api.reads.length, 1, "already past the budget on the first poll");
  assert.equal(result.escalation?.reason, "no reply in 12 minutes");
});

test("a failed hand-off keeps the marker, so the next attempt does not restart the wait", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate({ ok: false, error: "Slack is down" });
  const api = directiveFeed([]);

  await runContactHuman(
    { message: "anyone?", timeoutSeconds: 600 },
    {
      contact: port,
      api,
      escalate: escalate.port,
      sleep: clock.sleep,
      now: clock.now,
      minWaitSeconds: 600,
    },
  );

  assert.equal(state.cleared, 0);
  assert.equal(state.pending?.message, "anyone?");
});

test("a stop the failed hand-off drained still stops the agent", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate({
    ok: false,
    error: "Slack is down",
    directives: [{ type: "stop", reason: "a human took it" }],
  });
  const api = directiveFeed([]);

  const result = await runContactHuman(
    { message: "anyone?", timeoutSeconds: 600 },
    {
      contact: port,
      api,
      escalate: escalate.port,
      sleep: clock.sleep,
      now: clock.now,
      minWaitSeconds: 600,
    },
  );

  assert.equal(result.terminate, true, "the incident is no longer the agent's either way");
});

test("the evidence is posted under the ask, as its own message", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed(
    [],
    [{ type: "human_message", from: "U1", text: "checked", ts: "1000.500000" }],
  );

  await runContactHuman(
    {
      message: "*Incident 6 — no customer impact.* Can someone check #dev-alerts?",
      details: "Zero 5xx over 24h (3.4M lines). Control test at >= 400 returns 39,305.",
      timeoutSeconds: 3600,
    },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(state.posts, [
    "*Incident 6 — no customer impact.* Can someone check #dev-alerts?",
    "Zero 5xx over 24h (3.4M lines). Control test at >= 400 returns 39,305.",
  ]);
});

test("replies older than the question are not answers to it", () => {
  const pending: PendingDirective[] = [
    { id: 1, directive: { type: "human_message", from: "U1", text: "earlier chatter", ts: "900.000000" } },
    { id: 2, directive: { type: "new_signals", count: 2, summary: "two more" } },
    { id: 3, directive: { type: "human_message", from: "U2", text: "the answer", ts: "1100.000000" } },
  ];

  const found = firstReplyAfter(pending, 1_000_000);
  assert.equal(found?.directive.text, "the answer");
  assert.equal(found?.id, 3, "the id is what lets the wait consume just this one");
  assert.equal(firstReplyAfter([pending[0]], 1_000_000), null);
});

/**
 * The wait used to end on whichever human spoke first after the question,
 * which meant two people talking to each other could answer a question that
 * was never put to them. Who a message was for is read at the Slack boundary
 * and recorded on the directive; this is the half that acts on it.
 */
test("a message people sent each other does not end the wait", () => {
  const pending: PendingDirective[] = [
    {
      id: 1,
      directive: {
        type: "human_message",
        from: "U1",
        text: "did anyone check org X?",
        ts: "1100.000000",
        addressed: "others",
      },
    },
    {
      id: 2,
      directive: {
        type: "human_message",
        from: "U2",
        text: "yes, org X bypasses it",
        ts: "1200.000000",
        addressed: "agent",
      },
    },
  ];

  const found = firstReplyAfter(pending, 1_000_000);
  assert.equal(found?.id, 2, "the first message for the agent, not the first message");
  assert.equal(
    firstReplyAfter([pending[0]], 1_000_000),
    null,
    "chatter alone leaves the agent waiting rather than answering it wrongly",
  );
});

test("a directive written before addressed existed still ends a wait", () => {
  // Rows in flight across the deploy that added the field. They meant "for
  // the agent", which was the only thing a reply could be.
  const pending: PendingDirective[] = [
    {
      id: 7,
      directive: { type: "human_message", from: "U1", text: "go ahead", ts: "1100.000000" },
    },
  ];
  assert.equal(firstReplyAfter(pending, 1_000_000)?.id, 7);
});

test("slack and millisecond timestamps both compare", () => {
  assert.equal(directiveTimestampMillis("1758700000.000200"), 1758700000000.2);
  assert.equal(directiveTimestampMillis("1758700000000"), 1758700000000);
  assert.equal(directiveTimestampMillis("2026-09-24T00:00:00.000Z"), Date.parse("2026-09-24T00:00:00.000Z"));
});

test("a merged directive ends the wait rather than being swallowed by it", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([], [{ type: "merged", into: "inc-9" }]);

  const result = await runContactHuman(
    { message: "can someone merge the PR?", timeoutSeconds: 86400 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.terminate, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.reply, null);
  assert.deepEqual(result.directives, [{ type: "merged", into: "inc-9" }]);
  assert.equal(state.cleared, 1);
});

test("a stop directive ends the wait", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([{ type: "stop", reason: "a human took it" }]);

  const result = await runContactHuman(
    { message: "anyone?", timeoutSeconds: 86400 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.terminate, true);
  assert.deepEqual(result.directives, [{ type: "stop", reason: "a human took it" }]);
});

test("directives that are not the reply are handed back, not dropped", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([
    { type: "resumed_after", seconds: 420 },
    { type: "new_signals", count: 2, summary: "two more 500s" },
    { type: "human_message", from: "U1", text: "on it", ts: "1000.500000" },
  ]);

  const result = await runContactHuman(
    { message: "anyone?", timeoutSeconds: 3600 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.reply, "on it");
  assert.deepEqual(result.directives, [
    { type: "resumed_after", seconds: 420 },
    { type: "new_signals", count: 2, summary: "two more 500s" },
  ]);
});

test("a marker left by a killed run does not silence the next, different question", async () => {
  const clock = fakeClock();
  // SIGKILL mid-wait skips clearPending, so the marker outlives the question.
  const { state, port } = fakeContact({
    message: "can someone merge the PR?",
    messageTs: "ts-1",
    askedAt: 900_000,
  });
  const escalate = recordingEscalate();
  const api = directiveFeed(
    [],
    [{ type: "human_message", from: "U1", text: "rolled back", ts: "1000.500000" }],
  );

  const result = await runContactHuman(
    { message: "should I roll back the deploy?", timeoutSeconds: 3600 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(state.posts, ["should I roll back the deploy?"]);
  assert.equal(state.recorded, 1);
  assert.equal(result.reply, "rolled back");
});

test("the contact_human tool stops the agent on a terminating directive", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([{ type: "merged", into: "inc-9" }]);

  const tool = await createContactHumanTool({
    contact: port,
    api,
    escalate: escalate.port,
    sleep: clock.sleep,
    now: clock.now,
  });
  const result = await tool.execute(
    "call-1",
    { message: "anyone?", timeoutSeconds: 3600 } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(result.terminate, true);
  assert.match(
    String(result.content[0].type === "text" && result.content[0].text),
    /MERGED: this incident is now part of inc-9/,
  );
});

test("a marker whose post never landed is asked again, not waited on", async () => {
  const clock = fakeClock();
  // recordPending succeeded and post threw: the marker exists but no human
  // ever saw the question. Waiting on it is indistinguishable from being
  // ignored, and the design budgets 24 hours for that wait.
  const { state, port } = fakeContact({
    message: "can someone merge the PR?",
    messageTs: "",
    askedAt: 999_000,
  });
  const escalate = recordingEscalate();
  const api = directiveFeed(
    [],
    [{ type: "human_message", from: "U1", text: "merged", ts: "1000.500000" }],
  );

  const result = await runContactHuman(
    { message: "can someone merge the PR?", timeoutSeconds: 3600 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(state.posts, ["can someone merge the PR?"]);
  assert.equal(result.reply, "merged");
});

test("the harness deadline interrupts a blocking tool, not just the turn", async () => {
  const clock = fakeClock();
  const deadline = new AbortController();
  deadline.abort();
  let attempts = 0;

  const tool = await createMonitorTool({
    probe: async () => {
      attempts += 1;
      return { code: 1, output: "still firing" };
    },
    sleep: clock.sleep,
    now: clock.now,
    signal: deadline.signal,
  });

  // Pi passes its own signal, which is not aborted. The tool has to honour
  // both, or the soft deadline cannot reach an agent parked in a 24h wait.
  const result = await tool.execute(
    "call-1",
    { command: "check", intervalSeconds: 30, timeoutSeconds: 86400, description: "quiet" } as never,
    new AbortController().signal,
    undefined,
    {} as never,
  );

  assert.equal(attempts, 1);
  assert.match(String(result.content[0].type === "text" && result.content[0].text), /TIMED OUT/);
});

test("contact_human honours the harness deadline alongside pi's signal", async () => {
  const clock = fakeClock();
  const deadline = new AbortController();
  deadline.abort();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  const tool = await createContactHumanTool({
    contact: port,
    api,
    escalate: escalate.port,
    sleep: clock.sleep,
    now: clock.now,
    signal: deadline.signal,
  });
  const result = await tool.execute(
    "call-1",
    { message: "anyone?", timeoutSeconds: 86400 } as never,
    new AbortController().signal,
    undefined,
    {} as never,
  );

  assert.equal((result.details as { timedOut: boolean }).timedOut, true);
  assert.equal(state.cleared, 1);
  assert.deepEqual(api.reads, [0], "one poll, then the deadline ends it");
  // The run steers the model to write a real brief inside the grace window.
  // Handing off here would spend the turn that brief needs.
  assert.equal(escalate.calls.length, 0, "the deadline is its own escalation path");
});

test("the answered reply is consumed, so it cannot return as a fresh instruction", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([
    { type: "new_signals", count: 1, summary: "one more 500" },
    { type: "human_message", from: "U1", text: "yes, go ahead and restart it", ts: "1000.500000" },
  ]);

  const result = await runContactHuman(
    { message: "can I restart the worker?", timeoutSeconds: 3600 },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.reply, "yes, go ahead and restart it");
  assert.deepEqual([...api.consumed], [2], "only the reply, by id");
  assert.deepEqual(
    await api.peekDirectives(),
    [{ id: 1, directive: { type: "new_signals", count: 1, summary: "one more 500" } }],
    "get_incident still owes the agent everything else, and only that",
  );
});

// --- options are an affordance on the same ask ----------------------------

test("options travel with the ask, and free text still answers it", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed(
    [],
    // Typed, not pressed. An answer nobody offered has to land the same way.
    [{ type: "human_message", from: "U1", text: "neither, hold", ts: "1000.500000" }],
  );

  const result = await runContactHuman(
    {
      message: "Roll back, or wait?",
      details: "the migration is half applied",
      timeoutSeconds: 3600,
      options: ["Roll back", "Wait"],
    },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  // The buttons ride on the ask. `details` is its own post underneath, and
  // the thing a reader answers is the one above it.
  assert.deepEqual(state.posts, ["Roll back, or wait?", "the migration is half applied"]);
  assert.deepEqual(state.options, [["Roll back", "Wait"], undefined]);
  assert.equal(result.reply, "neither, hold", "free text still answers");
  assert.equal(result.escalation, null);
  assert.equal(state.cleared, 1, "the marker is cleared exactly as it always was");
});

test("a button nobody presses is silence, and silence still escalates", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  const result = await runContactHuman(
    {
      message: "Roll back, or wait?",
      timeoutSeconds: 60,
      options: ["Roll back", "Wait for the next deploy"],
    },
    {
      contact: port,
      api,
      escalate: escalate.port,
      sleep: clock.sleep,
      now: clock.now,
      pollSeconds: 60,
      minWaitSeconds: 600,
    },
  );

  // The floor, the deadline and the hand-off all apply unchanged. Options
  // that skipped any of them would be a way to ask without being escalatable.
  assert.equal(api.reads.length, 11, "the floor is not opted out of by offering buttons");
  assert.deepEqual(result.escalation, { handedOff: true, reason: "no reply in 10 minutes" });
  assert.equal(result.terminate, true);
  assert.equal(state.cleared, 1);
});

test("the harness brief carries what was offered, for whoever picks it up", async () => {
  const clock = fakeClock();
  const { port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  await runContactHuman(
    {
      message: "Roll back, or wait?",
      timeoutSeconds: 600,
      options: ["Roll back", "Wait for the next deploy"],
    },
    {
      contact: port,
      api,
      escalate: escalate.port,
      sleep: clock.sleep,
      now: clock.now,
      pollSeconds: 600,
      minWaitSeconds: 600,
    },
  );

  const { brief } = escalate.calls[0];
  assert.match(brief, /What I offered/);
  assert.match(brief, /• Roll back/);
  assert.match(brief, /• Wait for the next deploy/);
});

test("a question asked without options says nothing about offering any", () => {
  assert.equal(unansweredBrief("anyone?", 30).includes("What I offered"), false);
});

test("a resumed agent does not re-post a question whose buttons are already up", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact({
    message: "Roll back, or wait?",
    messageTs: "ts-1",
    askedAt: 999_000,
  });
  const escalate = recordingEscalate();
  const api = directiveFeed([
    { type: "human_message", from: "U1", text: "Roll back", ts: "1000.000000" },
  ]);

  await runContactHuman(
    {
      message: "Roll back, or wait?",
      timeoutSeconds: 3600,
      options: ["Roll back", "Wait"],
    },
    { contact: port, api, escalate: escalate.port, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(state.posts, [], "a second set of buttons would be a second question");
});

test("unusable options are refused before anything is posted", async () => {
  const clock = fakeClock();
  const { state, port } = fakeContact();
  const escalate = recordingEscalate();
  const api = directiveFeed([]);

  const tool = await createContactHumanTool({
    contact: port,
    api,
    escalate: escalate.port,
    sleep: clock.sleep,
    now: clock.now,
  });
  const result = await tool.execute(
    "call-1",
    { message: "pick", timeoutSeconds: 3600, options: ["only one"] } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.deepEqual(state.posts, [], "nothing reaches the thread");
  assert.equal(state.recorded, 0, "and no marker is left behind for it");
  assert.equal(escalate.calls.length, 0, "a refusal is not an unanswered question");
  assert.match(
    String(result.content[0].type === "text" && result.content[0].text),
    /at least two/,
  );
});


// ---------------------------------------------------------------------------
// The heartbeat on a wait that needs a person
// ---------------------------------------------------------------------------

const clockAt = (iso: string) => {
  let now = Date.parse(iso);
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
};

const heartbeatHarness = (args: {
  now: () => number;
  existing?: PendingWait;
  handOff?: ToolResponse;
  postFails?: boolean;
  pingFails?: boolean;
  clearFails?: boolean;
}) => {
  let marker: PendingWait | null = args.existing ?? null;
  const posts: string[] = [];
  const postTimes: string[] = [];
  const handOffs: { reason: string; brief: string }[] = [];
  let recordWaitCalls = 0;
  let clears = 0;

  const deps: HeartbeatDeps = {
    marker: {
      recordWait: async (command) => {
        recordWaitCalls += 1;
        if (!marker || marker.command !== command) {
          marker = { command, startedAt: args.now(), pings: 0, lastPingAt: null };
        }
        return marker;
      },
      recordPing: async () => {
        if (args.pingFails) throw new Error("the Boss said 503");
        if (!marker) throw new Error("no wait is recorded");
        marker = { ...marker, pings: marker.pings + 1, lastPingAt: args.now() };
        return marker;
      },
      clearWait: async () => {
        if (args.clearFails) throw new Error("the Boss said 503");
        clears += 1;
        marker = null;
      },
    },
    post: async (message) => {
      if (args.postFails) throw new Error("slack said no");
      posts.push(message);
      postTimes.push(new Date(args.now()).toISOString());
    },
    escalate: {
      handOff: async (payload) => {
        handOffs.push(payload);
        return args.handOff ?? { ok: true, directives: [] };
      },
    },
  };

  return {
    deps,
    posts,
    postTimes,
    handOffs,
    clears: () => clears,
    recordWaitCalls: () => recordWaitCalls,
  };
};

const stalled: Probe = async () => ({ code: 1, output: '{"state":"OPEN"}' });

const PR_WAIT = {
  command: "gh pr view 2150 --json state -q .state | grep -q MERGED",
  description: "the PR to be merged",
  awaitingHuman:
    "Merge <https://github.com/thegoodparty/omni/pull/2150|omni#2150>. I cannot merge it myself.",
};

test("a wait on a person nudges the thread once it has gone an hour inside working hours", async () => {
  // Monday, 11:00 in New York.
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 1800, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.escalation, null);
  assert.equal(harness.posts.length, 1);
  assert.match(harness.posts[0], /Still waiting on someone: the PR to be merged/);
  assert.match(harness.posts[0], /1h so far/);
  assert.match(harness.posts[0], /omni#2150/);
  // The check's own current answer, which is the only part that can have
  // changed since the ask.
  assert.match(harness.posts[0], /"state":"OPEN"/);
  assert.match(harness.posts[0], /Next nudge in 2h/);
});

test("a wait that spans a night is silent until the window opens", async () => {
  // Monday, 18:00 in New York: one hour inside the window, then fifteen out.
  const clock = clockAt("2026-09-28T22:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });

  await runMonitor(
    { ...PR_WAIT, intervalSeconds: 3600, timeoutSeconds: 72_000 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
  );

  // Not one post overnight, then one as the window opens on Tuesday and a
  // second two hours later, rather than the whole ladder at once.
  assert.deepEqual(harness.postTimes, [
    "2026-09-29T14:00:00.000Z",
    "2026-09-29T16:00:00.000Z",
  ]);
  assert.match(harness.posts[0], /16h so far/);
});

test("a resumed agent carries on waiting instead of nudging again", async () => {
  // Monday, 12:00 in New York. The wait began ninety minutes ago and was
  // nudged thirty minutes ago; the container restarted in between.
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    existing: {
      ...PR_WAIT,
      startedAt: started - 5_400_000,
      pings: 1,
      lastPingAt: started - 1_800_000,
    },
  });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 600, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
  );

  assert.equal(harness.posts.length, 0);
  assert.equal(result.timedOut, true);
  // The timeout is measured from when the wait began, not from this process,
  // so the restart did not buy another two hours.
  assert.equal(clock.now() - started, 1_800_000);
});

test("a wait with nobody to nudge posts nothing and records no marker", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });

  const result = await runMonitor(
    {
      command: "gh run list --commit abc123 -q '.[0].conclusion' | grep -q success",
      intervalSeconds: 1800,
      timeoutSeconds: 14_400,
      description: "the release train to deploy abc123",
    },
    { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
  );

  assert.equal(result.timedOut, true);
  assert.equal(harness.posts.length, 0);
  assert.equal(harness.recordWaitCalls(), 0);
});

test("the nudges run out and the incident is handed to a human", async () => {
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    existing: {
      ...PR_WAIT,
      startedAt: started - 15 * 3_600_000,
      pings: HEARTBEAT_MAX_PINGS,
      lastPingAt: started - 8 * 3_600_000,
    },
  });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 86_400 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
  );

  assert.deepEqual(result.escalation, {
    handedOff: true,
    reason: "nobody ended a 15h wait after 3 nudges",
  });
  assert.equal(harness.handOffs.length, 1);
  assert.match(harness.handOffs[0].brief, /so this is yours/);
  assert.match(harness.handOffs[0].brief, /the PR to be merged/);
  // A fourth nudge in the thread is not what a stalled wait needs; hand_off
  // is the post that reaches the rotation.
  assert.equal(harness.posts.length, 0);
  assert.equal(harness.clears(), 1);
});

test("a hand-off that fails leaves the incident with the agent and says so", async () => {
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    handOff: { ok: false, error: "already owned by a human", directives: [] },
    existing: {
      ...PR_WAIT,
      startedAt: started - 15 * 3_600_000,
      pings: HEARTBEAT_MAX_PINGS,
      lastPingAt: started - 8 * 3_600_000,
    },
  });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 86_400 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
  );

  assert.equal(result.escalation?.handedOff, false);
  // The marker keeps its startedAt, so the next attempt escalates at once
  // rather than starting the wait over.
  assert.equal(harness.clears(), 0);

  const tool = await createMonitorTool({
    probe: stalled,
    sleep: clock.sleep,
    now: clock.now,
    heartbeat: harness.deps,
  });
  const out = await tool.execute(
    "call-1",
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 86_400 } as never,
    undefined,
    undefined,
    {} as never,
  );
  const text = String(out.content[0].type === "text" && out.content[0].text);
  assert.match(text, /Call hand_off yourself now/);
  assert.equal(out.terminate, false);
});

test("a hand-off that lands stops the agent", async () => {
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    existing: {
      ...PR_WAIT,
      startedAt: started - 15 * 3_600_000,
      pings: HEARTBEAT_MAX_PINGS,
      lastPingAt: started - 8 * 3_600_000,
    },
  });

  const tool = await createMonitorTool({
    probe: stalled,
    sleep: clock.sleep,
    now: clock.now,
    heartbeat: harness.deps,
  });
  const out = await tool.execute(
    "call-1",
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 86_400 } as never,
    undefined,
    undefined,
    {} as never,
  );
  const text = String(out.content[0].type === "text" && out.content[0].text);

  assert.match(text, /HANDED OFF/);
  assert.equal(out.terminate, true);
});

test("a Slack failure costs the nudge, not the wait", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now, postFails: true });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 1800, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
  );

  assert.equal(result.timedOut, true);
  assert.equal(harness.posts.length, 0);
});

test("working hours are a window in one zone, and a weekend is outside it", () => {
  assert.equal(insideWorkingHours(Date.parse("2026-09-28T15:00:00Z")), true);
  assert.equal(insideWorkingHours(Date.parse("2026-09-28T13:00:00Z")), false);
  // The end hour is exclusive: 19:00 in New York is already out.
  assert.equal(insideWorkingHours(Date.parse("2026-09-28T23:00:00Z")), false);
  assert.equal(insideWorkingHours(Date.parse("2026-09-26T16:00:00Z")), false);
});

test("working hours follow the zone through a DST change", () => {
  // Eastern is UTC-4 in September and UTC-5 in November, so the same UTC
  // instant is inside the window in one and outside it in the other.
  assert.equal(insideWorkingHours(Date.parse("2026-09-28T14:00:00Z")), true);
  assert.equal(insideWorkingHours(Date.parse("2026-11-02T14:00:00Z")), false);
  assert.equal(insideWorkingHours(Date.parse("2026-11-02T15:00:00Z")), true);
});

test("a working-hours spec is parsed, and a malformed one throws", () => {
  assert.deepEqual(parseWorkingHours("America/Los_Angeles:9-17"), {
    timeZone: "America/Los_Angeles",
    startHour: 9,
    endHour: 17,
    days: [1, 2, 3, 4, 5],
  });
  assert.deepEqual(parseWorkingHours("UTC:0-24:0,6").days, [0, 6]);

  assert.throws(() => parseWorkingHours("America/New_York"), /must look like/);
  assert.throws(() => parseWorkingHours("America/New_York:19-10"), /start<end/);
  assert.throws(() => parseWorkingHours("Mars/Olympus:10-19"), /IANA zone/);
  assert.throws(() => parseWorkingHours("UTC:10-19:9"), /days must be 0-6/);
});

test("a Boss failure while counting a nudge costs the nudge, not the wait", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now, pingFails: true });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 1800, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
  );

  assert.equal(result.timedOut, true);
  // Nothing is posted when the count did not move: retried every interval
  // with no backoff to advance, the nudge would be the spam.
  assert.equal(harness.posts.length, 0);
});

test("a Boss failure while dropping the marker does not lose a wait that just ended", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now, clearFails: true });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 7200 },
    {
      probe: async () => ({ code: 0, output: "MERGED" }),
      sleep: clock.sleep,
      now: clock.now,
      heartbeat: harness.deps,
    },
  );

  assert.equal(result.timedOut, false);
  assert.equal(result.output, "MERGED");
});

test("recording the wait is the one marker call that is allowed to fail loudly", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });
  harness.deps.marker.recordWait = async () => {
    throw new Error("the Boss said 503");
  };

  // Nothing has been waited on yet, so the model gets an error and reissues
  // the call. Swallowing it would start a day-long wait with no marker and no
  // heartbeat, which is the behaviour this whole file exists to end.
  await assert.rejects(
    runMonitor(
      { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 7200 },
      { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: harness.deps },
    ),
    /503/,
  );
});

test("the hand-off brief counts the nudges that were actually sent", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });

  await runMonitor(
    { ...PR_WAIT, intervalSeconds: 1800, timeoutSeconds: 86_400 },
    {
      probe: stalled,
      sleep: clock.sleep,
      now: clock.now,
      heartbeat: { ...harness.deps, maxPings: 1 },
    },
  );

  assert.equal(harness.posts.length, 1);
  assert.match(harness.handOffs[0].brief, /across 1 nudges/);
});

// A brief the harness writes has nobody to refuse it to: the model is not in
// the loop by the time either of these is composed, and `hand_off` now
// rejects a brief past the thread budget. So the worst case each of them can
// produce has to fit, and these are the tests that keep that true instead of
// merely written down in a comment.

test("the harness's nudge fits the thread budget at its worst", () => {
  // The nudge is the one harness-composed thread post that carries two of the
  // model's own fields *and* the status block, so it is the tightest of the
  // three and the one that would fail first. A refused nudge is dropped on
  // purpose -- losing a day-long wait to a 503 is the worse trade -- which
  // means an over-long one produces an incident that waits all day, nudges
  // nobody, and then hands off claiming it nudged three times.
  // Absurd inputs on purpose. The margin here is not a constant: the elision
  // marker `truncateOutput` adds names how much it dropped, so it grows with
  // the input, and `formatWaited` grows with the wait. A bound checked only
  // at plausible sizes is a bound that holds until somebody waits longer.
  const nudge = heartbeatMessage({
    description: "d".repeat(100_000_000),
    awaitingHuman: "a".repeat(100_000_000),
    waitedMs: Number.MAX_SAFE_INTEGER,
    status: "s".repeat(100_000_000),
    // The hand-off sentence is the longer of the two tails.
    nextSeconds: null,
  });

  assert.ok(
    nudge.length <= THREAD_PROSE_CHARS,
    `a maximal nudge is ${nudge.length} characters against a budget of ${THREAD_PROSE_CHARS}`,
  );
  assert.match(nudge, /characters elided/);
});

test("an ordinary nudge is left exactly as written", () => {
  // The clamp must be invisible on every real nudge: an elision marker on a
  // one-line wait would send a reader looking for text that never existed.
  const nudge = heartbeatMessage({
    description: "the preview deploy for PR 42",
    awaitingHuman: "someone needs to merge it",
    waitedMs: 3_600_000,
    status: "pending",
    nextSeconds: 1_800,
  });

  assert.ok(nudge.includes("the preview deploy for PR 42"));
  assert.ok(nudge.includes("someone needs to merge it"));
  assert.doesNotMatch(nudge, /elided/);
});

test("the harness's unanswered brief fits the thread budget at its worst", () => {
  // The question is already capped by the tool, so this is its true maximum;
  // the minute count is not capped anywhere, so it gets an absurd one.
  const brief = unansweredBrief(
    "q".repeat(CONTACT_HUMAN_MESSAGE_LIMIT),
    999_999_999,
    Array.from({ length: MAX_CHOICE_OPTIONS }, (_, i) => `${i}`.padEnd(75, "o")),
  );

  assert.ok(
    brief.length <= THREAD_PROSE_CHARS,
    `a maximal brief is ${brief.length} characters against a budget of ${THREAD_PROSE_CHARS}`,
  );
  // The question is echoed, not reproduced: it is already in the thread
  // directly above, verbatim, so the elision costs the reader nothing and is
  // marked where it happens.
  assert.match(brief, /characters elided/);
  assert.ok(brief.includes("What I offered"), "the buttons a reader saw survive");
});

test("the harness's stalled-wait brief fits the thread budget at its worst", () => {
  // Absurd inputs, for the same reason as the nudge above: the elision marker
  // grows with what it elided and `formatWaited` grows with the wait, so a
  // bound checked at plausible sizes is a bound that holds until it does not.
  const brief = stalledWaitBrief({
    description: "d".repeat(100_000_000),
    awaitingHuman: "a".repeat(100_000_000),
    waitedMs: Number.MAX_SAFE_INTEGER,
    status: "s".repeat(100_000_000),
    nudges: 999_999,
  });

  assert.ok(
    brief.length <= THREAD_PROSE_CHARS,
    `a maximal brief is ${brief.length} characters against a budget of ${THREAD_PROSE_CHARS}`,
  );
  assert.match(brief, /characters elided/);
});

test("a short harness brief is left exactly as written", () => {
  // The clamp must not be visible on the normal path, which is every real
  // one: a reader seeing an elision marker on a two-line brief would go
  // looking for text that was never there.
  const brief = unansweredBrief("Is the rollback safe?", 30);

  assert.ok(brief.includes("Is the rollback safe?"));
  assert.doesNotMatch(brief, /elided/);
});
