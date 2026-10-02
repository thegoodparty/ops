import assert from "node:assert/strict";
import { test } from "node:test";

import type { BossInboxKind, Directive } from "../types";
import { loadPi, type Context, type InboxState, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "./harness";
import {
  BOSS_SAYS,
  createMessageBossTool,
  createMonitorTool,
  formatWaited,
  HEARTBEAT_MAX_GAP_SECONDS,
  MAX_BLOCK_SECONDS,
  heartbeatGapSeconds,
  insideWorkingHours,
  MESSAGE_BOSS_MIN_WAIT_SECONDS,
  parseWorkingHours,
  directiveText,
  localWait,
  probeOutput,
  runMessageBoss,
  runMonitor,
  shellProbe,
  waitEscalation,
  type BossInboxPort,
  type HeartbeatDeps,
  type MessageBossDeps,
  type MonitorDeps,
  type PendingQuestion,
  type PendingWait,
  type Probe,
  type QuestionMarkerPort,
  type Waiter,
} from "./tools";

const fakeClock = () => {
  let now = 1_000_000;
  let sleeps = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps += 1;
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps: () => sleeps,
  };
};

const toolText = (result: ToolExecutionResult): string => {
  const first = result.content?.[0];
  return first?.type === "text" ? String(first.text) : "";
};

/**
 * One tool call's API, faked to the parts these tools touch: the memos, and
 * the conversation's inbox, which a test fills with steers and announces with
 * `push` the way a real commit would.
 */
const fakeCall = () => {
  const memos = new Map<string, unknown>();
  let steers: string[] = [];
  let listener: ((value: InboxState) => Promise<void>) | null = null;
  const inbox = (): InboxState => ({
    items: steers.map((content, index) => ({ id: index as never, mode: "steer" as const, content })),
  });
  let watched: () => void = () => {};
  const watching = new Promise<void>((resolve) => {
    watched = resolve;
  });
  const api = {
    conversationId: 7,
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 1) return memos.get(name);
      if (!memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
    watchDoc: async () => ({
      value: inbox(),
      start: (callback: (value: InboxState) => Promise<void>) => {
        listener = callback;
        watched();
      },
      stop: async () => {
        listener = null;
      },
    }),
    snapshot: async () => undefined,
  } as unknown as ToolExecutionApi;
  return {
    api,
    memos,
    /** Resolves once a wait is watching the inbox. */
    watching,
    steer: async (text: string) => {
      steers = [...steers, text];
      await listener?.(inbox());
    },
  };
};

const call = async (
  tool: ToolRegistration,
  args: Record<string, unknown>,
  options: { api?: ToolExecutionApi; ctx?: Context } = {},
): Promise<ToolExecutionResult> =>
  tool.execute(args, options.api ?? fakeCall().api, options.ctx ?? (await loadPi()).context);

/** A monitor tool over fixed deps, waiting on the fake clock rather than the inbox. */
const monitorTool = (deps: MonitorDeps) =>
  createMonitorTool({
    resolve: async () => ({ wait: localWait(deps), ...deps }),
  });

// ---------------------------------------------------------------------------
// monitor
// ---------------------------------------------------------------------------

test("monitor returns as soon as the command exits 0", async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const probe: Probe = async (command) => {
    calls.push(command);
    return { code: 0, output: "MERGED\n" };
  };

  const result = await runMonitor(
    { command: "gh pr view x", intervalSeconds: 30, timeoutSeconds: 3600, description: "the PR", waitingFor: "the PR" },
    { probe, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(result, { output: "MERGED\n", timedOut: false, capped: false });
  assert.equal(calls.length, 1);
  assert.equal(clock.sleeps(), 0);
});

test("monitor keeps waiting through non-zero exits and costs one call", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const probe: Probe = async () => {
    attempts += 1;
    return attempts < 4 ? { code: 1, output: "pending" } : { code: 0, output: "success" };
  };

  const result = await runMonitor(
    { command: "check", intervalSeconds: 30, timeoutSeconds: 3600, description: "a deploy", waitingFor: "a deploy" },
    { probe, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(result, { output: "success", timedOut: false, capped: false });
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
    { command: "check", intervalSeconds: 60, timeoutSeconds: 300, description: "quiet", waitingFor: "quiet" },
    { probe, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(result, { output: "still firing (6)", timedOut: true, capped: false });
  assert.equal(attempts, 6);
});

test("monitor stops when the turn is aborted", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  controller.abort();

  const result = await runMonitor(
    { command: "check", intervalSeconds: 5, timeoutSeconds: 86400, description: "anything", waitingFor: "anything" },
    { probe: async () => ({ code: 1, output: "no" }), sleep: clock.sleep, now: clock.now, signal: controller.signal },
  );

  assert.deepEqual(result, { output: "no", timedOut: true, capped: false });
});

test("monitor's description does not tell the agent to pre-summarise", async () => {
  // A cap removed from the code and left standing in the tool description is
  // the same bug one layer up: the agent reads "output is capped" and narrows
  // the probe command itself, throwing the evidence away voluntarily. So the
  // instruction and the behaviour are asserted as one thing -- the tool says
  // output comes back whole, and it does.
  const tool = await monitorTool({
    probe: async () => ({ code: 0, output: "x".repeat(200_000) }),
  });

  assert.doesNotMatch(
    tool.description,
    /output is capped/i,
    "the description promises a cap that no longer exists",
  );
  assert.match(tool.description, /whole/i);
  assert.equal(tool.outputLimits?.maxBytes, Number.MAX_SAFE_INTEGER, "the harness is told not to cut it either");

  const out = await call(tool, {
    command: "cat huge",
    intervalSeconds: 1,
    timeoutSeconds: 1,
    description: "a big log",
    waitingFor: "a big log",
  });
  const text = toolText(out);
  assert.ok(text.startsWith("Condition met: a big log\n\n"));
  assert.ok(
    text.includes("x".repeat(200_000)),
    "the description says whole and the tool must deliver whole",
  );
});

test("monitor hands back everything the probe printed", async () => {
  // What the cap used to take was the middle, and a monitor is most often
  // waiting on something whose interesting line is in the middle: the failing
  // job in a CI summary, the one pod that will not come up. Pi compacts the
  // conversation to make room now, so the evidence is not what gives way.
  const needle = "NEEDLE_IN_THE_MIDDLE";
  const output = `${"x".repeat(25_000)}${needle}${"x".repeat(25_000)}`;
  const result = await runMonitor(
    { command: "cat huge", intervalSeconds: 1, timeoutSeconds: 1, description: "a big log", waitingFor: "a big log" },
    { probe: async () => ({ code: 0, output }) },
  );

  assert.equal(result.output, output);
  assert.ok(result.output.includes(needle));
});

test("the real probe reports exit codes from the shell", async () => {
  assert.deepEqual(await shellProbe("printf ok", 5000), { code: 0, output: "ok" });
  const failure = await shellProbe("exit 3", 5000);
  assert.equal(failure.code, 3);
});

test("probeOutput trims and names an empty result", () => {
  assert.equal(probeOutput("  short  "), "short");
  assert.equal(probeOutput("   "), "(no output)");
});

test("probeOutput carries the whole output, however long", () => {
  // The bug this replaces: a 400-character head with an ellipsis, in the
  // one block of a nudge nobody authored. The answer a failing check gives
  // is at the bottom of its output, not the top, so a head is the half
  // least likely to say anything.
  const text = `${"q".repeat(5000)}\nFAILED: the thing the reader needed`;

  assert.equal(probeOutput(text), text);
});

test("a wait escalation carries the whole check output rather than a head of it", () => {
  const tail = "FAILED: the thing the reader needed";
  const text = waitEscalation({
    description: "the PR to be merged",
    awaitingHuman: "somebody has to press merge",
    waitedMs: 3_600_000,
    rung: 1,
    status: `${"q".repeat(5000)}\n${tail}`,
    nextSeconds: 7200,
  });

  assert.ok(text.includes(tail), "the end of the output is in the escalation");
  assert.ok(text.includes("q".repeat(5000)), "and so is the rest of it");
  assert.doesNotMatch(text, /…/);
  assert.doesNotMatch(text, /truncat|elided/);
});

test("formatWaited rounds to minutes and never says zero", () => {
  assert.equal(formatWaited(0), "1m");
  assert.equal(formatWaited(10 * 60_000), "10m");
  assert.equal(formatWaited(90 * 60_000), "1h 30m");
  assert.equal(formatWaited(2 * 3_600_000), "2h");
  assert.equal(formatWaited(63 * 3_600_000), "63h");
});

test("an aborted conversation ends a blocking tool, not just the turn", async () => {
  const clock = fakeClock();
  const stop = new AbortController();
  stop.abort();
  let attempts = 0;
  const tool = await monitorTool({
    probe: async () => {
      attempts += 1;
      return { code: 1, output: "still firing" };
    },
    sleep: clock.sleep,
    now: clock.now,
    signal: stop.signal,
  });

  const result = await call(tool, {
    command: "check",
    intervalSeconds: 30,
    timeoutSeconds: 86400,
    description: "quiet",
    waitingFor: "quiet",
  });

  assert.equal(attempts, 1);
  assert.equal(toolText(result), "TIMED OUT after 86400s waiting for: quiet\n\nstill firing");
});

// ---------------------------------------------------------------------------
// The inbox ends a wait
// ---------------------------------------------------------------------------

test("a steer queued for the conversation ends an hour-long monitor within milliseconds", async () => {
  const fake = fakeCall();
  const tool = await createMonitorTool({
    resolve: async () => ({ probe: async () => ({ code: 1, output: "still pending" }) }),
  });

  const started = Date.now();
  const pending = call(tool, {
    command: "check",
    intervalSeconds: 600,
    timeoutSeconds: 3000,
    description: "the merge",
    waitingFor: "the merge",
  }, { api: fake.api });
  await fake.watching;
  await fake.steer(`${BOSS_SAYS}hold off, the rollback is ours`);
  const out = await pending;

  assert.ok(Date.now() - started < 2000, "the wait returned on the steer, not on its interval");
  assert.match(toolText(out), /^STOPPED WAITING for: the merge \(interrupted\)\. A message for you arrived and is next\./);
  assert.match(toolText(out), /still pending/, "what the check last saw comes back with it");
});

test("a steer already queued when the wait starts ends it after one check", async () => {
  const fake = fakeCall();
  await fake.steer("RESUMED after 600s. Re-check anything time-sensitive before continuing.");
  let checks = 0;
  const tool = await createMonitorTool({
    resolve: async () => ({
      probe: async () => {
        checks += 1;
        return { code: 1, output: "pending" };
      },
    }),
  });

  const out = await call(tool, {
    command: "check",
    intervalSeconds: 600,
    timeoutSeconds: 3000,
    description: "a deploy",
    waitingFor: "a deploy",
  }, { api: fake.api });

  assert.equal(checks, 1);
  assert.match(toolText(out), /\(interrupted\)/);
});

test("a met condition wins over a steer that arrived in the same moment", async () => {
  const fake = fakeCall();
  await fake.steer(`${BOSS_SAYS}anything`);
  const tool = await createMonitorTool({
    resolve: async () => ({ probe: async () => ({ code: 0, output: "MERGED" }) }),
  });

  const out = await call(tool, {
    command: "check",
    intervalSeconds: 60,
    timeoutSeconds: 600,
    description: "the merge",
    waitingFor: "the merge",
  }, { api: fake.api });

  assert.match(toolText(out), /^Condition met: the merge/);
});

test("an interrupted wait on a person drops its marker, so the board stops showing it", async () => {
  const fake = fakeCall();
  let cleared = 0;
  const marker: PendingWait = { command: "check", startedAt: Date.now(), pings: 0, lastPingAt: null };
  const tool = await createMonitorTool({
    resolve: async () => ({
      probe: async () => ({ code: 1, output: "open" }),
      heartbeat: {
        marker: {
          recordWait: async () => marker,
          recordPing: async () => marker,
          clearWait: async () => {
            cleared += 1;
          },
        },
        boss: { tellBoss: async () => {}, escalationsSince: async () => ({ count: 0, lastAt: null }) },
      },
    }),
  });

  const pending = call(tool, {
    command: "check",
    intervalSeconds: 600,
    timeoutSeconds: 3000,
    description: "the merge",
    waitingFor: "the merge",
    awaitingHuman: "merge it",
  }, { api: fake.api });
  await fake.watching;
  await fake.steer(`${BOSS_SAYS}merged`);
  await pending;

  assert.equal(cleared, 1);
});

test("monitor and message_boss are replay-safe, and their results are never cut", async () => {
  const monitor = await createMonitorTool({ resolve: async () => ({}) });
  const message = await createMessageBossTool({ resolve: async () => ({}) as never });
  for (const tool of [monitor, message]) {
    assert.equal(tool.replay, "safe", tool.name);
    assert.equal(tool.outputLimits?.maxLines, Number.MAX_SAFE_INTEGER, tool.name);
  }
});

// ---------------------------------------------------------------------------
// directiveText
// ---------------------------------------------------------------------------

test("stop and merged read as the instruction to end", () => {
  assert.equal(directiveText({ type: "stop", reason: "a human took it" }), "STOP: a human took it");
  assert.equal(
    directiveText({ type: "merged", into: "inc-9" }),
    "MERGED: this incident is now part of inc-9. Stop work.",
  );
});

test("new signals read plainly, and name what was absorbed with agreement", () => {
  assert.equal(
    directiveText({ type: "new_signals", count: 2, summary: "two more 500s" }),
    "NEW SIGNALS (2): two more 500s",
  );

  const one = directiveText({ type: "new_signals", count: 3, summary: "same root cause", absorbed: ["82"] });
  assert.match(one, /NEW SIGNALS \(3\): incident 82 has been merged into yours and its signals are now yours\./);
  assert.match(one, /Why: same root cause\./);
  assert.match(one, /what that incident had already found/);

  const many = directiveText({
    type: "new_signals",
    count: 5,
    summary: "same root cause",
    absorbed: ["81", "82", "83"],
  });
  assert.match(many, /incidents 81, 82 and 83 have been merged into yours and their signals are now yours\./);
  assert.match(many, /what those incidents had already found/);
});

test("a Boss message reads as the Boss speaking, with the prefix message_boss recognises", () => {
  const directive: Directive = { type: "boss_message", text: "hold the rollback", at: 1_000 };
  assert.equal(directiveText(directive), `${BOSS_SAYS}hold the rollback`);
  assert.ok(directiveText(directive).startsWith(BOSS_SAYS));
  assert.ok(!directiveText({ type: "resumed_after", seconds: 60 }).startsWith(BOSS_SAYS));
});

// These tests follow one wait across hours of fake clock, so they lift the
// per-call cap. The cap has its own tests.
const UNCAPPED = Number.POSITIVE_INFINITY;

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
  tellFails?: boolean;
  pingFails?: boolean;
  clearFails?: boolean;
}) => {
  let marker: PendingWait | null = args.existing ?? null;
  const events: string[] = [];
  const told: { kind: BossInboxKind; text: string; at: string; pingsWhenTold: number | null }[] = [];
  let recordWaitCalls = 0;
  const labels: (string | null)[] = [];
  let pingCalls = 0;
  let clears = 0;

  const boss: BossInboxPort = {
    tellBoss: async (kind, text) => {
      events.push(`tellBoss:${kind}`);
      told.push({
        kind,
        text,
        at: new Date(args.now()).toISOString(),
        pingsWhenTold: marker?.pings ?? null,
      });
      if (args.tellFails) throw new Error("the Boss said 503");
    },
    escalationsSince: async () => ({ count: 0, lastAt: null }),
  };

  const deps: HeartbeatDeps = {
    marker: {
      recordWait: async (command, waitingFor) => {
        recordWaitCalls += 1;
        events.push("recordWait");
        labels.push(waitingFor);
        if (!marker || marker.command !== command) {
          marker = { command, startedAt: args.now(), pings: 0, lastPingAt: null };
        }
        return marker;
      },
      recordPing: async () => {
        pingCalls += 1;
        events.push("recordPing");
        if (args.pingFails) throw new Error("the Boss said 503");
        if (!marker) throw new Error("no wait is recorded");
        marker = { ...marker, pings: marker.pings + 1, lastPingAt: args.now() };
        return marker;
      },
      clearWait: async () => {
        events.push("clearWait");
        if (args.clearFails) throw new Error("the Boss said 503");
        clears += 1;
        marker = null;
      },
    },
    boss,
  };

  return {
    deps,
    events,
    told,
    marker: () => marker,
    clears: () => clears,
    pingCalls: () => pingCalls,
    recordWaitCalls: () => recordWaitCalls,
    labels,
  };
};

const stalled: Probe = async () => ({ code: 1, output: '{"state":"OPEN"}' });

const PR_WAIT = {
  command: "gh pr view 2150 --json state -q .state | grep -q MERGED",
  description: "the PR to be merged",
  waitingFor: "the PR to be merged",
  awaitingHuman:
    "Merge <https://github.com/thegoodparty/omni/pull/2150|omni#2150>. I cannot merge it myself.",
};

/**
 * Round the clock, for the tests that care about the ladder's shape rather
 * than about when a nudge is allowed to land. The window is what makes the
 * real timings readable, and it would otherwise push every rung in these
 * tests to the next morning.
 */
const ALWAYS = {
  timeZone: "UTC",
  startHour: 0,
  endHour: 24,
  days: [0, 1, 2, 3, 4, 5, 6],
};

test("a wait on a person tells the Boss once it has gone an hour inside working hours", async () => {
  // Monday, 11:00 in New York.
  const clock = clockAt("2026-09-28T15:00:00Z");
  assert.equal(insideWorkingHours(clock.now()), true, "the premise: the window is open");
  const harness = heartbeatHarness({ now: clock.now });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 1800, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  assert.deepEqual(result, { output: '{"state":"OPEN"}', timedOut: true, capped: false });
  assert.deepEqual(
    harness.told.map(({ kind, at }) => ({ kind, at })),
    [{ kind: "escalation", at: "2026-09-28T16:00:00.000Z" }],
    "one rung, an hour in, and it is an escalation to the Boss",
  );
  const text = harness.told[0].text;
  assert.match(text, /nothing has changed in 1h\./);
  assert.match(text, /This is reminder 1; the next comes in 2h/);
  assert.ok(text.includes(`Waiting for: ${PR_WAIT.description}`));
  assert.ok(text.includes(`What a person has to do: ${PR_WAIT.awaitingHuman}`));
  // The check's own current answer, which is the only part that can have
  // changed since the ask.
  assert.ok(text.includes('{"state":"OPEN"}'));
  assert.equal(harness.clears(), 1, "the timeout drops the marker");
});

test("the heartbeat has only the Boss to tell", () => {
  // The deps have no Slack port at all, so the only way a rung can leave the
  // harness is the inbox.
  const harness = heartbeatHarness({ now: () => 0 });
  assert.deepEqual(Object.keys(harness.deps).sort(), ["boss", "marker"]);
});

test("the probe output reaches the Boss whole, however long", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });
  const tail = "FAILED: the thing the reader needed";
  const output = `${"s".repeat(50_000)}\n${tail}`;

  await runMonitor(
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 120 },
    {
      probe: async () => ({ code: 1, output }),
      sleep: clock.sleep,
      now: clock.now,
      maxBlockSeconds: UNCAPPED,
      heartbeat: { ...harness.deps, workingHours: ALWAYS, firstSeconds: 60 },
    },
  );

  assert.equal(harness.told.length, 1);
  assert.ok(harness.told[0].text.includes(output));
  assert.doesNotMatch(harness.told[0].text, /truncat|elided|…/);
});

test("a wait that spans a night is silent until the window opens", async () => {
  // Monday, 18:00 in New York: one hour inside the window, then fifteen out.
  const clock = clockAt("2026-09-28T22:00:00Z");
  assert.equal(insideWorkingHours(clock.now()), true, "the premise: the wait starts inside");
  assert.equal(
    insideWorkingHours(Date.parse("2026-09-28T23:00:00Z")),
    false,
    "and the hour it becomes due is already outside",
  );
  const harness = heartbeatHarness({ now: clock.now });

  await runMonitor(
    { ...PR_WAIT, intervalSeconds: 3600, timeoutSeconds: 72_000 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  // Not one rung overnight, then one as the window opens on Tuesday and a
  // second two hours later, rather than the whole ladder at once.
  assert.deepEqual(
    harness.told.map((call) => call.at),
    ["2026-09-29T14:00:00.000Z", "2026-09-29T16:00:00.000Z"],
  );
  assert.match(harness.told[0].text, /nothing has changed in 16h\./);
});

test("the working-hours window gates every rung, not only the first", async () => {
  // Saturday, all day, with a wait long past due.
  const clock = clockAt("2026-09-26T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    existing: { ...PR_WAIT, startedAt: started - 10 * 3_600_000, pings: 0, lastPingAt: null },
  });
  assert.equal(insideWorkingHours(started), false, "the premise: a weekend is outside");

  await runMonitor(
    { ...PR_WAIT, intervalSeconds: 600, timeoutSeconds: 12 * 3_600_000 / 1000 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  assert.equal(harness.told.length, 0);
  assert.equal(harness.pingCalls(), 0, "and nothing was counted either");
});

test("a resumed agent carries on waiting instead of telling the Boss again", async () => {
  // Monday, 12:00 in New York. The wait began ninety minutes ago and the Boss
  // was told thirty minutes ago; the container restarted in between.
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    existing: {
      command: PR_WAIT.command,
      startedAt: started - 5_400_000,
      pings: 1,
      lastPingAt: started - 1_800_000,
    },
  });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 600, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  assert.equal(harness.recordWaitCalls(), 1);
  assert.deepEqual(harness.labels, [PR_WAIT.waitingFor], "the label reaches the marker the board reads");
  assert.equal(harness.told.length, 0);
  assert.equal(result.timedOut, true);
  // The timeout is measured from when the wait began, not from this process,
  // so the restart did not buy another two hours.
  assert.equal(clock.now() - started, 1_800_000);
});

test("a stale marker for a different command does not silence the next wait", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    existing: {
      command: "gh pr view 9999 --json state",
      startedAt: started - 50 * 3_600_000,
      pings: 7,
      lastPingAt: started - 60_000,
    },
  });

  await runMonitor(
    { ...PR_WAIT, intervalSeconds: 1800, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  assert.deepEqual(harness.told.map((call) => call.at), ["2026-09-28T16:00:00.000Z"]);
  assert.match(harness.told[0].text, /This is reminder 1;/);
});

test("a wait with nobody to remind tells the Boss nothing and records no marker", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });

  const result = await runMonitor(
    {
      command: "gh run list --commit abc123 -q '.[0].conclusion' | grep -q success",
      intervalSeconds: 1800,
      timeoutSeconds: 14_400,
      description: "the release train to deploy abc123",
      waitingFor: "the release train to deploy abc123",
    },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  assert.equal(result.timedOut, true);
  assert.ok(clock.now() - Date.parse("2026-09-28T15:00:00Z") >= 3_600_000, "the premise: an hour passed");
  assert.equal(harness.told.length, 0);
  assert.equal(harness.recordWaitCalls(), 0);
  assert.equal(harness.pingCalls(), 0);
});

test("a blank awaitingHuman is the same as none", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });

  await runMonitor(
    { ...PR_WAIT, awaitingHuman: "   ", intervalSeconds: 1800, timeoutSeconds: 14_400 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  assert.equal(harness.told.length, 0);
  assert.equal(harness.recordWaitCalls(), 0);
});

test("the ladder doubles and then holds at the ceiling", async () => {
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({ now: clock.now });

  await runMonitor(
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 3600 },
    {
      probe: stalled,
      sleep: clock.sleep,
      now: clock.now,
      maxBlockSeconds: UNCAPPED,
      heartbeat: { ...harness.deps, workingHours: ALWAYS, firstSeconds: 60, maxGapSeconds: 600 },
    },
  );

  assert.equal(harness.marker(), null, "the timeout dropped the marker");
  const offsets = harness.told.map((call) => (Date.parse(call.at) - started) / 1000);
  // Gaps 60, 120, 240, 480, then 600 for as long as the wait lasts.
  assert.deepEqual(offsets, [60, 180, 420, 900, 1500, 2100, 2700, 3300]);
  assert.ok(harness.told.every((call) => call.kind === "escalation"));
  assert.deepEqual(
    harness.told.map((call) => /This is reminder (\d+);/.exec(call.text)?.[1]),
    ["1", "2", "3", "4", "5", "6", "7", "8"],
  );
  assert.match(harness.told[0].text, /the next comes in 2m/);
  assert.match(harness.told[4].text, /the next comes in 10m/);
});

test("the ladder never ends the wait, for as long as the wait lasts", async () => {
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    existing: {
      command: PR_WAIT.command,
      startedAt: started - 15 * 3_600_000,
      pings: 2,
      lastPingAt: started - 8 * 3_600_000,
    },
  });

  // Three days of wall clock on a wait that nobody ever ends. Terminating
  // here is what stranded incidents: the wait ended, the incident moved to a
  // person, and nothing in the system could reach it again.
  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 3 * 86_400 },
    {
      probe: stalled,
      sleep: clock.sleep,
      now: clock.now,
      maxBlockSeconds: UNCAPPED,
      heartbeat: { ...harness.deps, workingHours: ALWAYS },
    },
  );

  assert.equal(result.timedOut, true);
  // 8h, then 16h, then a day and a day: the gap doubles and then stops, and
  // the elapsed figure keeps climbing from the wait's original start, which
  // is the marker surviving each rung rather than being dropped by it.
  assert.deepEqual(
    harness.told.map((call) => /nothing has changed in ([^.]+)\./.exec(call.text)?.[1]),
    ["15h", "23h", "39h", "63h"],
  );
  assert.equal(harness.clears(), 1, "dropped once, by the timeout that ended the wait");
});

test("the gap doubles to a day and then stops doubling", () => {
  // A wait can legitimately run for days, and left doubling the eighth rung
  // would be a fortnight after the seventh -- which reads as having given up.
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((pings) => heartbeatGapSeconds(pings)),
    [3_600, 7_200, 14_400, 28_800, 57_600, 86_400, 86_400],
  );
  assert.equal(
    heartbeatGapSeconds(50),
    HEARTBEAT_MAX_GAP_SECONDS,
    "2**50 hours is still a day; nothing open goes quiet for longer than that",
  );
  assert.equal(heartbeatGapSeconds(3, 600, 1800), 1800);
});

test("the ping is counted before the Boss is told", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now });

  await runMonitor(
    { ...PR_WAIT, intervalSeconds: 1800, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  assert.deepEqual(harness.events, ["recordWait", "recordPing", "tellBoss:escalation", "clearWait"]);
  assert.equal(harness.told[0].pingsWhenTold, 1, "the marker had already moved when the Boss heard");
});

test("a Boss inbox failure costs the rung, not the wait, and is not retried in place", async () => {
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({ now: clock.now, tellFails: true });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 600 },
    {
      probe: stalled,
      sleep: clock.sleep,
      now: clock.now,
      maxBlockSeconds: UNCAPPED,
      heartbeat: { ...harness.deps, workingHours: ALWAYS, firstSeconds: 60 },
    },
  );

  assert.ok(harness.told.length > 0, "the premise: the Boss was tried, and it threw");
  // Three rungs at 60, 180 and 420 seconds, not one every minute: the count
  // moved before each send, so a failure advances the ladder like a success.
  assert.deepEqual(
    harness.told.map((call) => (Date.parse(call.at) - started) / 1000),
    [60, 180, 420],
  );
  assert.equal(result.timedOut, true, "an undelivered rung ends no wait");
  assert.equal(clock.now() - started, 600_000, "the wait ran to its own deadline");
  assert.equal(harness.clears(), 1);
});

test("a Boss failure while counting a rung costs the rung, not the wait", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const harness = heartbeatHarness({ now: clock.now, pingFails: true });

  const result = await runMonitor(
    { ...PR_WAIT, intervalSeconds: 1800, timeoutSeconds: 7200 },
    { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
  );

  assert.ok(harness.pingCalls() > 0, "the premise: a rung came due and counting it failed");
  assert.equal(result.timedOut, true);
  // Nothing is sent when the count did not move: retried every interval
  // with no backoff to advance, the rung would be the spam.
  assert.equal(harness.told.length, 0);
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
      maxBlockSeconds: UNCAPPED,
      heartbeat: harness.deps,
    },
  );

  assert.ok(harness.events.includes("clearWait"), "the premise: the clear was tried");
  assert.deepEqual(result, { output: "MERGED", timedOut: false, capped: false });
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
      { probe: stalled, sleep: clock.sleep, now: clock.now, maxBlockSeconds: UNCAPPED, heartbeat: harness.deps },
    ),
    /503/,
  );
});

test("a monitor rung that tells the Boss does not stop the agent", async () => {
  const clock = clockAt("2026-09-28T16:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({
    now: clock.now,
    existing: {
      command: PR_WAIT.command,
      startedAt: started - 15 * 3_600_000,
      pings: 2,
      lastPingAt: started - 8 * 3_600_000,
    },
  });

  const tool = await monitorTool({
    probe: stalled,
    sleep: clock.sleep,
    now: clock.now,
    maxBlockSeconds: UNCAPPED,
    heartbeat: harness.deps,
  });
  const out = await call(tool, { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 86_400 });

  // The Boss was told and the wait then ran out on its own deadline, so what
  // the model gets back is an ordinary timeout on an incident it still holds.
  assert.equal(harness.told.length, 1);
  assert.match(toolText(out), /^TIMED OUT after 86400s waiting for: the PR to be merged/);
  assert.equal(out.control, undefined, "nothing asks the run to end");
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

// ---------------------------------------------------------------------------
// message_boss
// ---------------------------------------------------------------------------

type FeedEntry = { steer: string; at?: number };

/**
 * The Boss's side of a question, faked end to end. The inbox is a list of
 * what was told and when, and `escalationsSince` is read back from it, which
 * is the property the real one has: the ladder's memory is the inbox itself.
 *
 * The feed is the conversation's inbox, by time: a steer becomes visible once
 * the clock reaches its `at`, and the wait reads it between checks, the way
 * `waitUntil` sees a steer committed while it sleeps.
 */
const questionHarness = (args: {
  clock: { now: () => number; sleep: (ms: number) => Promise<void> };
  pending?: PendingQuestion | null;
  priorEscalations?: number[];
  escalationFails?: boolean;
  feed?: FeedEntry[];
  signal?: AbortSignal;
}) => {
  const now = args.clock.now;
  let pending: PendingQuestion | null = args.pending ?? null;
  const events: string[] = [];
  const told: { kind: BossInboxKind; text: string; at: number; pendingWhenTold: PendingQuestion | null }[] = [];
  const escalationTimes = [...(args.priorEscalations ?? [])];
  const sinceCalls: number[] = [];
  let markerCalls = 0;
  const reads: number[] = [];
  const feed = args.feed ?? [];

  const marker: QuestionMarkerPort = {
    getPending: async () => {
      markerCalls += 1;
      events.push("getPending");
      return pending;
    },
    recordPending: async (message) => {
      markerCalls += 1;
      events.push("recordPending");
      pending = { message, askedAt: now() };
      return pending;
    },
    clearPending: async () => {
      markerCalls += 1;
      events.push("clearPending");
      pending = null;
    },
  };

  const boss: BossInboxPort = {
    tellBoss: async (kind, text) => {
      events.push(`tellBoss:${kind}`);
      told.push({ kind, text, at: now(), pendingWhenTold: pending });
      if (kind === "escalation") {
        if (args.escalationFails) throw new Error("the Boss said 503");
        escalationTimes.push(now());
      }
    },
    escalationsSince: async (since) => {
      sinceCalls.push(since);
      const hits = escalationTimes.filter((at) => at >= since);
      return { count: hits.length, lastAt: hits.length ? Math.max(...hits) : null };
    },
  };

  const visible = (): string[] => {
    reads.push(now());
    return feed.filter((entry) => (entry.at ?? Number.NEGATIVE_INFINITY) <= now()).map((entry) => entry.steer);
  };

  // The same order as `waitUntil`: a steer already queued is seen after the
  // first check, and one that lands during a pause ends the wait as soon as
  // the pause does, before the next check runs.
  const wait: Waiter = async (options) => {
    const deadline = now() + options.timeoutMs;
    let value;
    let steers = visible();
    for (;;) {
      if (args.signal?.aborted) return { ended: "aborted", value, steers: [] };
      const state = await options.check();
      value = state.value;
      if (state.done) return { ended: "met", value, steers: [] };
      if (steers.length) return { ended: "inbox", value, steers };
      if (now() >= deadline) return { ended: "timeout", value, steers: [] };
      await args.clock.sleep(Math.min(options.intervalMs, Math.max(0, deadline - now())));
      steers = visible();
      if (steers.length) return { ended: "inbox", value, steers };
    }
  };

  const deps: MessageBossDeps = {
    marker,
    boss,
    wait,
    now,
    maxBlockSeconds: UNCAPPED,
  };

  return {
    deps,
    events,
    told,
    escalations: () => told.filter((entry) => entry.kind === "escalation"),
    sinceCalls,
    reads,
    pending: () => pending,
    markerCalls: () => markerCalls,
  };
};

const boss = (text: string): string => directiveText({ type: "boss_message", text, at: 0 });

test("message_boss without wait tells the Boss once and returns at once", async () => {
  for (const wait of [undefined, false]) {
    const clock = fakeClock();
    const harness = questionHarness({ clock, feed: [{ steer: boss("never read") }] });

    const result = await runMessageBoss(
      { message: "PR #2150 is up and needs a merge.", wait },
      harness.deps,
    );

    assert.deepEqual(result, { answered: false, timedOut: false });
    assert.deepEqual(
      harness.told.map(({ kind, text }) => ({ kind, text })),
      [{ kind: "message", text: "PR #2150 is up and needs a merge." }],
    );
    assert.equal(harness.markerCalls(), 0, "nothing is outstanding, so nothing is recorded");
    assert.equal(harness.reads.length, 0, "and nothing is waited for");
    assert.equal(clock.sleeps(), 0);
  }
});

test("a question goes to the Boss before the marker is written, then waits for the answer", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [{ steer: boss("restarted it"), at: 1_000_000 + 90_000 }],
  });

  const result = await runMessageBoss(
    { message: "Can someone restart the worker?", wait: true },
    { ...harness.deps, pollSeconds: 30 },
  );

  assert.deepEqual(result, { answered: true, timedOut: false });
  assert.deepEqual(harness.events, ["getPending", "tellBoss:question", "recordPending", "clearPending"]);
  assert.equal(harness.told[0].pendingWhenTold, null, "the marker did not exist when the Boss was asked");
  assert.deepEqual(harness.reads.length, 4, "looked at 0, 30, 60 and 90 seconds");
  assert.equal(harness.pending(), null);
});

test("a resumed agent resumes waiting instead of asking twice", async () => {
  const clock = fakeClock();
  const marker = { message: "Can someone restart the worker?", askedAt: 999_000 };
  const harness = questionHarness({ clock, pending: marker, feed: [{ steer: boss("done") }] });
  assert.equal(harness.pending()?.message, "Can someone restart the worker?", "the premise: the marker matches");

  const result = await runMessageBoss(
    { message: "Can someone restart the worker?", wait: true },
    harness.deps,
  );

  assert.equal(result.answered, true);
  assert.equal(harness.told.length, 0, "the question already reached the Boss once");
  assert.ok(!harness.events.includes("recordPending"));
});

test("a marker left by a run that died does not silence the next, different question", async () => {
  const clock = fakeClock();
  // A wait that died with its process never cleared its marker.
  const harness = questionHarness({
    clock,
    pending: { message: "can someone merge the PR?", askedAt: 900_000 },
    feed: [{ steer: boss("rolled back"), at: 1_000_000 + 30_000 }],
  });
  assert.equal(harness.pending()?.message, "can someone merge the PR?", "the premise: a stale marker");

  const result = await runMessageBoss(
    { message: "should I roll back the deploy?", wait: true },
    { ...harness.deps, pollSeconds: 30 },
  );

  assert.deepEqual(
    harness.told.map(({ kind, text }) => ({ kind, text })),
    [{ kind: "question", text: "should I roll back the deploy?" }],
  );
  assert.ok(harness.events.includes("recordPending"));
  assert.equal(result.answered, true);
});

test("several Boss messages are one answer", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [
      { steer: boss("yes, roll it back") },
      { steer: directiveText({ type: "resumed_after", seconds: 420 }) },
      { steer: boss("and tell me when it is done") },
    ],
  });

  const result = await runMessageBoss({ message: "roll back?", wait: true }, harness.deps);

  assert.deepEqual(result, { answered: true, timedOut: false });
  assert.equal(harness.pending(), null);
});

test("a steer that is not the Boss ends the wait without answering it", async () => {
  // The deadline, the turn budget, new signals: all of them have to reach the
  // model now, and none of them is the answer, so the question stays open.
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [{ steer: directiveText({ type: "new_signals", count: 1, summary: "one more" }), at: 1_000_000 + 60_000 }],
  });

  const result = await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 30 },
  );

  assert.deepEqual(result, { answered: false, timedOut: false, interrupted: true });
  assert.notEqual(harness.pending(), null, "the question is still outstanding, so calling again resumes it");
});

test("a wait shorter than the floor is raised to it, not escalated early", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({ clock, feed: [{ steer: boss("here"), at: start + 900_000 }] });

  await runMessageBoss(
    { message: "anyone?", wait: true, seconds: 60 },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  // Ten minutes, not one: the model cannot shorten its way out of the
  // escalation by asking for a wait nobody could answer inside.
  assert.deepEqual(harness.escalations().map((entry) => (entry.at - start) / 1000), [600]);
  assert.ok(harness.reads.some((at) => at - start === 60_000), "the premise: the requested minute was polled through");
});

test("the default floor is MESSAGE_BOSS_MIN_WAIT_SECONDS", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({
    clock,
    feed: [{ steer: boss("here"), at: start + (MESSAGE_BOSS_MIN_WAIT_SECONDS + 60) * 1000 }],
  });

  await runMessageBoss({ message: "anyone?", wait: true, seconds: 5 }, { ...harness.deps, pollSeconds: 60 });

  assert.deepEqual(
    harness.escalations().map((entry) => (entry.at - start) / 1000),
    [MESSAGE_BOSS_MIN_WAIT_SECONDS],
  );
});

test("a longer requested wait is honoured", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({ clock, feed: [{ steer: boss("here"), at: start + 3_000_000 }] });

  await runMessageBoss(
    { message: "anyone?", wait: true, seconds: 2400 },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  assert.deepEqual(harness.escalations().map((entry) => (entry.at - start) / 1000), [2400]);
});

test("the escalation clock runs from the question, not from this call", async () => {
  const clock = fakeClock();
  const start = clock.now();
  // A marker 700 seconds old: the agent asked, the container died, and the
  // call runs again. A fresh wait here would let a crash loop defer the
  // escalation for as long as the crashes last.
  const harness = questionHarness({
    clock,
    pending: { message: "anyone?", askedAt: start - 700_000 },
    feed: [{ steer: boss("here"), at: start + 60_000 }],
  });

  await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  assert.equal(harness.told.filter((entry) => entry.kind === "question").length, 0, "the premise: this is a resume");
  assert.deepEqual(harness.escalations().map((entry) => entry.at - start), [0], "already past the budget on the first poll");
  assert.deepEqual(harness.sinceCalls, [start - 700_000], "the inbox is read from when it was asked");
  assert.match(harness.escalations()[0].text, /in 12m and I am still blocked/);
});

test("an unanswered question escalates with the question whole, and the wait carries on", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const question = `${"q".repeat(20_000)}\nWhich of the two rollbacks is safe?`;
  const harness = questionHarness({ clock, feed: [{ steer: boss("the second one"), at: start + 900_000 }] });

  const result = await runMessageBoss(
    { message: question, wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  const escalations = harness.escalations();
  assert.equal(escalations.length, 1);
  assert.ok(escalations[0].pendingWhenTold, "the question was still outstanding when it escalated");
  assert.ok(escalations[0].text.includes(question), "the question goes to the Boss whole");
  assert.match(escalations[0].text, /Nobody has answered my question in 10m/);
  assert.doesNotMatch(escalations[0].text, /truncat|elided|…/);
  assert.ok(harness.reads.some((at) => at > escalations[0].at), "polling went on after the escalation");
  assert.deepEqual(result, { answered: true, timedOut: false });
});

test("an unanswered question re-escalates on a doubling gap read from the inbox", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({ clock, feed: [{ steer: boss("finally"), at: start + 10_000_000 }] });

  await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  // 600s to the first, then gaps of 1200, 2400 and 4800.
  assert.deepEqual(harness.escalations().map((entry) => (entry.at - start) / 1000), [600, 1800, 4200, 9000]);
  assert.ok(harness.escalations().every((entry) => entry.pendingWhenTold !== null));
});

test("the re-escalation gap stops at the ceiling", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({ clock, feed: [{ steer: boss("finally"), at: start + 7_000_000 }] });

  await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600, maxGapSeconds: 1800 },
  );

  // 600, then gaps of 1200, 1800, 1800, 1800.
  assert.deepEqual(harness.escalations().map((entry) => (entry.at - start) / 1000), [600, 1800, 3600, 5400]);
});

test("a restart that finds a recent escalation does not escalate again at once", async () => {
  const run = async (priorEscalations: number[]) => {
    const clock = fakeClock();
    const start = clock.now();
    const harness = questionHarness({
      clock,
      pending: { message: "anyone?", askedAt: start - 700_000 },
      priorEscalations,
      feed: [{ steer: boss("here"), at: start + 1_000_000 }],
    });
    await runMessageBoss(
      { message: "anyone?", wait: true },
      { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
    );
    return { start, harness };
  };

  // Without the earlier escalation this resume is past its deadline and
  // escalates on the first poll, which is what makes the case below mean
  // something.
  const control = await run([]);
  assert.deepEqual(control.harness.escalations().map((entry) => entry.at - control.start), [0]);

  // One went up 100 seconds ago, before the restart. The next is owed 1200
  // seconds after it, which is past the answer.
  const resumed = await run([1_000_000 - 100_000]);
  assert.deepEqual(resumed.harness.sinceCalls[0], resumed.start - 700_000);
  assert.equal(resumed.harness.escalations().length, 0);
});

test("a failed escalation costs the escalation, not the wait", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({
    clock,
    escalationFails: true,
    feed: [{ steer: boss("here"), at: start + 720_000 }],
  });

  const result = await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  assert.ok(harness.escalations().length > 0, "the premise: the escalation was tried and threw");
  assert.deepEqual(result, { answered: true, timedOut: false });
});

test("an aborted run clears the marker and ends the wait without escalating", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const stop = new AbortController();
  stop.abort();
  // Long past its escalation point, so an escalation here would be due. An
  // abort is a stop or the hard deadline, which have their own path to the
  // Boss, and escalating here would spend the turn a brief needs.
  const harness = questionHarness({
    clock,
    pending: { message: "anyone?", askedAt: start - 7_200_000 },
    signal: stop.signal,
  });
  assert.ok(harness.pending(), "the premise: a question is outstanding");

  const result = await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, minWaitSeconds: 600 },
  );

  assert.deepEqual(result, { answered: false, timedOut: true });
  assert.equal(harness.pending(), null);
  assert.equal(harness.escalations().length, 0);
});

test("the message_boss tool says the message was sent, once, even when it runs again", async () => {
  const clock = fakeClock();
  const harness = questionHarness({ clock });
  const tool = await createMessageBossTool({ resolve: async () => harness.deps });
  const fake = fakeCall();

  assert.equal(toolText(await call(tool, { message: "PR is up" }, { api: fake.api })), "Sent to the Boss.");
  // The same call rerun after a crash: the memo says it already went.
  assert.equal(toolText(await call(tool, { message: "PR is up" }, { api: fake.api })), "Sent to the Boss.");
  assert.equal(harness.told.length, 1);
});

test("the message_boss tool says the Boss answered, and does not repeat the answer", async () => {
  const clock = fakeClock();
  const harness = questionHarness({ clock, feed: [{ steer: boss("yes, restart it") }] });
  const tool = await createMessageBossTool({ resolve: async () => harness.deps });

  const out = await call(tool, { message: "can I restart the worker?", wait: true });

  assert.equal(toolText(out), "The Boss answered. Its message is the next one you read.");
  assert.doesNotMatch(toolText(out), /yes, restart it/, "the steer delivers it; saying it twice reads as two instructions");
});

test("the message_boss tool, interrupted by something else, says how to keep waiting", async () => {
  const clock = fakeClock();
  const harness = questionHarness({ clock, feed: [{ steer: "Your wall-clock deadline has expired." }] });
  const tool = await createMessageBossTool({ resolve: async () => harness.deps });

  const out = await call(tool, { message: "anyone?", wait: true });

  assert.match(toolText(out), /^Stopped waiting for the Boss's answer \(interrupted\)/);
  assert.match(toolText(out), /call message_boss again with the same message and wait: true/);
});

test("a blocked merge ask is not sent, and the judge's spend is the tool's", async () => {
  const clock = fakeClock();
  const harness = questionHarness({ clock });
  const usage = {
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };
  const tool = await createMessageBossTool({
    resolve: async () => ({ ...harness.deps, checkIn: async () => ({ blocked: "NOT MET: no green CI", usage }) }),
  });

  const out = await call(tool, { message: "please merge omni#1" });

  assert.equal(toolText(out), "Not sent to the Boss. NOT MET: no green CI");
  assert.deepEqual(out.usage, usage);
  assert.equal(harness.told.length, 0);
});

test("a passed check-in is not judged again when the call runs again", async () => {
  const clock = fakeClock();
  const harness = questionHarness({ clock });
  let judged = 0;
  const tool = await createMessageBossTool({
    resolve: async () => ({
      ...harness.deps,
      checkIn: async () => {
        judged += 1;
        return { blocked: null, usage: undefined };
      },
    }),
  });
  const fake = fakeCall();

  await call(tool, { message: "please merge omni#1" }, { api: fake.api });
  await call(tool, { message: "please merge omni#1" }, { api: fake.api });

  assert.equal(judged, 1, "the judgement is a paid model call, and a rerun resumes past it");
});

test("a monitor call recorded before waitingFor existed still runs", async () => {
  let probes = 0;
  const tool = await monitorTool({
    probe: async () => {
      probes += 1;
      return { code: 0, output: "" };
    },
  });
  assert.ok(
    (tool.parameters as { required?: string[] }).required?.includes("waitingFor"),
    "the premise: the model is required to give one",
  );
  const out = await call(tool, { command: "true", intervalSeconds: 1, timeoutSeconds: 1, description: "x" });
  assert.doesNotMatch(toolText(out), /^Rejected/);
  assert.equal(probes, 1, "the recorded wait ran its check");
});

// ---------------------------------------------------------------------------
// The per-call cap under the prompt cache TTL
// ---------------------------------------------------------------------------

test("a monitor asked for four hours returns inside the cache TTL and says it was capped", async () => {
  assert.ok(MAX_BLOCK_SECONDS < 3600, "the premise: the cap is under the one-hour cache TTL");
  const clock = fakeClock();
  const started = clock.now();
  const tool = await monitorTool({ probe: stalled, sleep: clock.sleep, now: clock.now });

  const out = await call(tool, {
    command: "check",
    intervalSeconds: 300,
    timeoutSeconds: 14_400,
    description: "the ratio to settle",
    waitingFor: "the ratio to settle",
  });

  assert.ok(clock.now() - started <= MAX_BLOCK_SECONDS * 1000, "waited no longer than the cap");
  assert.equal(clock.now() - started, MAX_BLOCK_SECONDS * 1000, "and did not give up early either");
  assert.equal((out.details as { timedOut: boolean }).timedOut, false, "a capped wait has not timed out");
  const text = toolText(out);
  assert.match(text, /^STILL WAITING for: the ratio to settle\./);
  assert.match(text, /capped at 3300s of the 14400s you asked for/);
  assert.match(text, /call monitor again with timeoutSeconds: 11100, which is what is left/);
  assert.doesNotMatch(text, /TIMED OUT/);
});

test("a capped wait with no marker carries the rest of its timeout, so re-arming still ends", async () => {
  const clock = fakeClock();
  const started = clock.now();
  const deps = { probe: stalled, sleep: clock.sleep, now: clock.now };
  let timeoutSeconds = 7200;
  const results = [];
  for (let call = 0; call < 5; call += 1) {
    const result = await runMonitor(
      { command: "check", intervalSeconds: 300, timeoutSeconds, description: "the deploy", waitingFor: "the deploy" },
      deps,
    );
    results.push(result);
    if (!result.capped) break;
    timeoutSeconds = result.remainingSeconds ?? assert.fail("a capped wait with no marker says what is left");
  }

  assert.deepEqual(results.map((r) => [r.capped, r.timedOut]), [[true, false], [true, false], [false, true]]);
  assert.equal(clock.now() - started, 7200 * 1000, "the two-hour wait ends at two hours, across the re-arms");
});

test("a wait shorter than the cap still times out as asked", async () => {
  const clock = fakeClock();
  const result = await runMonitor(
    { command: "check", intervalSeconds: 60, timeoutSeconds: 900, description: "npm ci", waitingFor: "npm ci" },
    { probe: stalled, sleep: clock.sleep, now: clock.now },
  );

  assert.deepEqual(result, { output: '{"state":"OPEN"}', timedOut: true, capped: false });
});

test("a capped wait on a person keeps its marker, so the re-armed call still reminds at an hour", async () => {
  const clock = clockAt("2026-09-28T15:00:00Z");
  const started = clock.now();
  const harness = heartbeatHarness({ now: clock.now });
  const deps = { probe: stalled, sleep: clock.sleep, now: clock.now, heartbeat: { ...harness.deps, workingHours: ALWAYS } };
  const args = { ...PR_WAIT, intervalSeconds: 300, timeoutSeconds: 86_400 };

  const first = await runMonitor(args, deps);
  assert.equal(first.capped, true);
  assert.equal(first.remainingSeconds, undefined, "the marker resumes the clock, so the same arguments are right");
  assert.equal(harness.clears(), 0, "a capped wait is not over, so the marker stays");
  assert.equal(harness.told.length, 0, "55 minutes in, no reminder is due yet");

  const second = await runMonitor(args, deps);
  assert.equal(second.capped, true);
  assert.equal(harness.recordWaitCalls(), 2);
  assert.deepEqual(
    harness.told.map((call) => (Date.parse(call.at) - started) / 1000),
    [3600],
    "the first reminder lands an hour after the wait began, across the re-arm",
  );
});

test("a question with no answer returns at the cap and keeps its marker", async () => {
  const clock = fakeClock();
  const started = clock.now();
  const harness = questionHarness({ clock });
  const tool = await createMessageBossTool({
    resolve: async () => ({ ...harness.deps, maxBlockSeconds: MAX_BLOCK_SECONDS }),
  });

  const out = await call(tool, { message: "Can someone merge omni#2192?", wait: true, seconds: 86_400 });

  assert.ok(clock.now() - started <= MAX_BLOCK_SECONDS * 1000);
  assert.match(toolText(out), /^No answer yet\. This call was capped at 3300s/);
  assert.match(toolText(out), /call message_boss again with the same message and wait: true/);
  assert.equal((out.details as { timedOut: boolean }).timedOut, false);
  assert.notEqual(harness.pending(), null, "the question is still outstanding");

  await call(tool, { message: "Can someone merge omni#2192?", wait: true, seconds: 86_400 });
  assert.equal(
    harness.told.filter((entry) => entry.kind === "question").length,
    1,
    "re-arming does not ask the Boss twice",
  );
});

test("a question whose escalation falls on the cap is still waiting, not timed out", async () => {
  // `seconds` is when the Boss is told, not when the wait ends, so an
  // escalation and the cap landing together leave the question outstanding.
  const clock = fakeClock();
  const harness = questionHarness({ clock });

  const result = await runMessageBoss(
    { message: "Can someone merge omni#2192?", wait: true, seconds: MAX_BLOCK_SECONDS },
    { ...harness.deps, maxBlockSeconds: MAX_BLOCK_SECONDS },
  );

  assert.equal(harness.escalations().length, 1, "the Boss was told at `seconds`");
  assert.equal(result.capped, true);
  assert.equal(result.timedOut, false);
  assert.notEqual(harness.pending(), null, "and the question is still outstanding");
});
