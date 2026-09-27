import assert from "node:assert/strict";
import { test } from "node:test";

import type { Directive } from "../types";
import type { PendingDirective } from "./tools";
import {
  CONTACT_HUMAN_MESSAGE_LIMIT,
  createContactHumanTool,
  createMonitorTool,
  directiveTimestampMillis,
  firstReplyAfter,
  runContactHuman,
  runMonitor,
  shellProbe,
  truncateOutput,
  unansweredBrief,
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
