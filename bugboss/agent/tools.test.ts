import assert from "node:assert/strict";
import { test } from "node:test";

import type { BossInboxKind, Directive } from "../types";
import {
  bossMessageText,
  createMessageBossTool,
  createMonitorTool,
  formatWaited,
  HEARTBEAT_MAX_GAP_SECONDS,
  MAX_BLOCK_SECONDS,
  heartbeatGapSeconds,
  insideWorkingHours,
  MESSAGE_BOSS_MIN_WAIT_SECONDS,
  parseWorkingHours,
  probeOutput,
  renderDirectives,
  runMessageBoss,
  runMonitor,
  shellProbe,
  waitEscalation,
  type BossInboxPort,
  type HeartbeatDeps,
  type MessageBossDeps,
  type PendingDirective,
  type PendingQuestion,
  type PendingWait,
  type Probe,
  type QuestionMarkerPort,
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

const toolText = (result: { content: { type: string; text?: string }[] }): string => {
  const first = result.content[0];
  return first.type === "text" ? String(first.text) : "";
};

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
  const tool = await createMonitorTool({
    probe: async () => ({ code: 0, output: "x".repeat(50_000) }),
  });

  assert.doesNotMatch(
    tool.description,
    /output is capped/i,
    "the description promises a cap that no longer exists",
  );
  assert.match(tool.description, /whole/i);

  const out = await tool.execute(
    "c1",
    {
      command: "cat huge",
      intervalSeconds: 1,
      timeoutSeconds: 1,
      description: "a big log",
      waitingFor: "a big log",
    } as never,
    new AbortController().signal,
    undefined,
    {} as never,
  );
  const text = toolText(out);
  assert.ok(text.startsWith("Condition met: a big log\n\n"));
  assert.ok(
    text.includes("x".repeat(50_000)),
    "the description says whole and the tool must deliver whole",
  );
  assert.ok(!out.terminate, "a met condition is not the end of the incident");
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
  const piSignal = new AbortController().signal;
  assert.equal(piSignal.aborted, false);
  const result = await tool.execute(
    "call-1",
    { command: "check", intervalSeconds: 30, timeoutSeconds: 86400, description: "quiet", waitingFor: "quiet" } as never,
    piSignal,
    undefined,
    {} as never,
  );

  assert.equal(attempts, 1);
  assert.equal(
    toolText(result),
    "TIMED OUT after 86400s waiting for: quiet\n\nstill firing",
  );
  assert.ok(!result.terminate, "a timed-out wait leaves the incident with the agent");
});

// ---------------------------------------------------------------------------
// renderDirectives
// ---------------------------------------------------------------------------

test("no directives render as nothing", () => {
  assert.equal(renderDirectives([]), "");
});

test("stop and merged render as the instruction to end", () => {
  assert.equal(
    renderDirectives([{ type: "stop", reason: "a human took it" }]),
    "\n\nDIRECTIVES\nSTOP: a human took it",
  );
  assert.equal(
    renderDirectives([{ type: "merged", into: "inc-9" }]),
    "\n\nDIRECTIVES\nMERGED: this incident is now part of inc-9. Stop work and exit.",
  );
});

test("new signals render plainly, and name what was absorbed with agreement", () => {
  assert.equal(
    renderDirectives([{ type: "new_signals", count: 2, summary: "two more 500s" }]),
    "\n\nDIRECTIVES\nNEW SIGNALS (2): two more 500s",
  );

  const one = renderDirectives([
    { type: "new_signals", count: 3, summary: "same root cause", absorbed: ["82"] },
  ]);
  assert.match(one, /NEW SIGNALS \(3\): incident 82 has been merged into yours and its signals are now yours\./);
  assert.match(one, /Why: same root cause\./);
  assert.match(one, /what that incident had already found/);

  const many = renderDirectives([
    { type: "new_signals", count: 5, summary: "same root cause", absorbed: ["81", "82", "83"] },
  ]);
  assert.match(many, /incidents 81, 82 and 83 have been merged into yours and their signals are now yours\./);
  assert.match(many, /what those incidents had already found/);
});

test("a boss message renders as the Boss speaking", () => {
  const directive: Directive = { type: "boss_message", text: "hold the rollback", at: 1_000 };
  assert.equal(bossMessageText(directive), "hold the rollback");
  assert.equal(
    renderDirectives([directive]),
    "\n\nDIRECTIVES\nFROM THE BOSS: hold the rollback",
  );
});

test("a legacy human_message row renders the same way a boss message does", () => {
  // Built the way a real one arrives: `JSON.parse` of a `pending_directive`
  // row written before the type was renamed. Nothing validates it on the way
  // in, so the cast is what the runtime actually sees.
  const legacy = JSON.parse(
    JSON.stringify({ type: "human_message", from: "U1", text: "go ahead", ts: "1000.500000" }),
  ) as Directive;
  assert.notEqual(legacy.type, "boss_message", "the premise: this is not the new shape");

  assert.equal(bossMessageText(legacy), "go ahead");
  assert.equal(renderDirectives([legacy]), "\n\nDIRECTIVES\nFROM THE BOSS: go ahead");
});

test("a directive that is not the Boss speaking has no boss text", () => {
  assert.equal(bossMessageText({ type: "stop", reason: "done" }), null);
  assert.equal(bossMessageText({ type: "resumed_after", seconds: 60 }), null);
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

  const tool = await createMonitorTool({
    probe: stalled,
    sleep: clock.sleep,
    now: clock.now,
    maxBlockSeconds: UNCAPPED,
    heartbeat: harness.deps,
  });
  const out = await tool.execute(
    "call-1",
    { ...PR_WAIT, intervalSeconds: 60, timeoutSeconds: 86_400 } as never,
    undefined,
    undefined,
    {} as never,
  );

  // The Boss was told and the wait then ran out on its own deadline, so what
  // the model gets back is an ordinary timeout on an incident it still holds.
  assert.equal(harness.told.length, 1);
  assert.match(toolText(out), /^TIMED OUT after 86400s waiting for: the PR to be merged/);
  assert.ok(!out.terminate);
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

type FeedEntry = { directive: Directive; at?: number };

/**
 * The Boss's side of a question, faked end to end. The inbox is a list of
 * what was told and when, and `escalationsSince` is read back from it, which
 * is the property the real one has: the ladder's memory is the inbox itself.
 *
 * The directive feed is time-based and does not drain. An entry becomes
 * visible once the clock reaches its `at`, and `consumeDirective` is the one
 * removal, so a consumed directive really is gone from every later read.
 */
const questionHarness = (args: {
  clock: { now: () => number; sleep: (ms: number) => Promise<void> };
  pending?: PendingQuestion | null;
  priorEscalations?: number[];
  escalationFails?: boolean;
  feed?: FeedEntry[];
}) => {
  const now = args.clock.now;
  let pending: PendingQuestion | null = args.pending ?? null;
  const events: string[] = [];
  const told: { kind: BossInboxKind; text: string; at: number; pendingWhenTold: PendingQuestion | null }[] = [];
  const escalationTimes = [...(args.priorEscalations ?? [])];
  const sinceCalls: number[] = [];
  let markerCalls = 0;
  const consumed = new Set<number>();
  const reads: number[] = [];
  const entries = (args.feed ?? []).map((entry, index) => ({ id: index + 1, ...entry }));

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

  const peekDirectives = async (): Promise<PendingDirective[]> => {
    reads.push(now());
    return entries
      .filter((entry) => (entry.at ?? Number.NEGATIVE_INFINITY) <= now() && !consumed.has(entry.id))
      .map(({ id, directive }) => ({ id, directive }));
  };

  const deps: MessageBossDeps = {
    marker,
    boss,
    api: {
      peekDirectives,
      consumeDirective: async (id) => {
        events.push(`consume:${id}`);
        consumed.add(id);
      },
    },
    sleep: args.clock.sleep,
    now,
    maxBlockSeconds: UNCAPPED,
  };

  return {
    deps,
    events,
    told,
    escalations: () => told.filter((call) => call.kind === "escalation"),
    sinceCalls,
    reads,
    consumed,
    peekDirectives,
    pending: () => pending,
    markerCalls: () => markerCalls,
  };
};

const boss = (text: string, at = 0): Directive => ({ type: "boss_message", text, at });

test("message_boss without wait tells the Boss once and returns at once", async () => {
  for (const wait of [undefined, false]) {
    const clock = fakeClock();
    const harness = questionHarness({ clock, feed: [{ directive: boss("never read") }] });

    const result = await runMessageBoss(
      { message: "PR #2150 is up and needs a merge.", wait },
      harness.deps,
    );

    assert.deepEqual(result, { answer: null, timedOut: false, directives: [], terminate: false });
    assert.deepEqual(
      harness.told.map(({ kind, text }) => ({ kind, text })),
      [{ kind: "message", text: "PR #2150 is up and needs a merge." }],
    );
    assert.equal(harness.markerCalls(), 0, "nothing is outstanding, so nothing is recorded");
    assert.equal(harness.reads.length, 0, "and nothing is waited for");
    assert.equal(clock.sleeps(), 0);
    assert.equal(harness.consumed.size, 0, "a Boss message sitting in the queue is left for get_incident");
  }
});

test("a question goes to the Boss before the marker is written, then waits for the answer", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [{ directive: boss("restarted it"), at: 1_000_000 + 90_000 }],
  });

  const result = await runMessageBoss(
    { message: "Can someone restart the worker?", wait: true },
    { ...harness.deps, pollSeconds: 30 },
  );

  assert.deepEqual(result, {
    answer: "restarted it",
    timedOut: false,
    directives: [],
    terminate: false,
  });
  assert.deepEqual(harness.events, [
    "getPending",
    "tellBoss:question",
    "recordPending",
    "clearPending",
    "consume:1",
  ]);
  assert.equal(harness.told[0].pendingWhenTold, null, "the marker did not exist when the Boss was asked");
  assert.deepEqual(harness.reads.length, 4, "polled at 0, 30, 60 and 90 seconds");
  assert.equal(harness.pending(), null);
});

test("a resumed agent resumes waiting instead of asking twice", async () => {
  const clock = fakeClock();
  const marker = { message: "Can someone restart the worker?", askedAt: 999_000 };
  const harness = questionHarness({
    clock,
    pending: marker,
    feed: [{ directive: boss("done") }],
  });
  assert.equal(harness.pending()?.message, "Can someone restart the worker?", "the premise: the marker matches");

  const result = await runMessageBoss(
    { message: "Can someone restart the worker?", wait: true },
    harness.deps,
  );

  assert.equal(result.answer, "done");
  assert.equal(harness.told.length, 0, "the question already reached the Boss once");
  assert.ok(!harness.events.includes("recordPending"));
});

test("a marker left by a killed run does not silence the next, different question", async () => {
  const clock = fakeClock();
  // SIGKILL mid-wait skips clearPending, so the marker outlives the question.
  const harness = questionHarness({
    clock,
    pending: { message: "can someone merge the PR?", askedAt: 900_000 },
    feed: [{ directive: boss("rolled back"), at: 1_000_000 + 30_000 }],
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
  assert.equal(result.answer, "rolled back");
});

test("any word from the Boss ends the wait, whenever it was written", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    pending: { message: "anyone?", askedAt: 1_000_000 },
    feed: [{ directive: boss("stand down", 1) }],
  });
  const directive = harness.deps.api;
  const before = await directive.peekDirectives();
  assert.equal(before.length, 1);
  assert.ok(
    (before[0].directive as { at: number }).at < 1_000_000,
    "the premise: the message is older than the question",
  );

  const result = await runMessageBoss({ message: "anyone?", wait: true }, harness.deps);

  assert.equal(result.answer, "stand down");
  assert.equal(result.terminate, false);
});

test("a legacy human_message ends the wait as the Boss's answer", async () => {
  const clock = fakeClock();
  const legacy = JSON.parse(
    JSON.stringify({ type: "human_message", from: "U1", text: "go ahead", ts: "1000.500000" }),
  ) as Directive;
  assert.notEqual(legacy.type, "boss_message", "the premise: this is the old shape");
  const harness = questionHarness({ clock, feed: [{ directive: legacy }] });

  const result = await runMessageBoss({ message: "may I restart it?", wait: true }, harness.deps);

  assert.equal(result.answer, "go ahead");
  assert.deepEqual([...harness.consumed], [1]);
  assert.deepEqual(result.directives, []);
});

test("several Boss messages are one answer, and all of them are consumed", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [
      { directive: boss("yes, roll it back") },
      { directive: { type: "resumed_after", seconds: 420 } },
      { directive: boss("and tell me when it is done") },
    ],
  });

  const result = await runMessageBoss({ message: "roll back?", wait: true }, harness.deps);

  assert.equal(result.answer, "yes, roll it back\n\nand tell me when it is done");
  assert.deepEqual([...harness.consumed].sort(), [1, 3]);
  assert.deepEqual(
    await harness.peekDirectives(),
    [{ id: 2, directive: { type: "resumed_after", seconds: 420 } }],
    "get_incident would otherwise deliver the second half as a fresh instruction",
  );
});

test("the marker is cleared before the answer is consumed", async () => {
  const clock = fakeClock();
  const harness = questionHarness({ clock, feed: [{ directive: boss("a") }, { directive: boss("b") }] });

  await runMessageBoss({ message: "?", wait: true }, harness.deps);

  const clearAt = harness.events.indexOf("clearPending");
  assert.ok(clearAt >= 0);
  assert.deepEqual(harness.events.slice(clearAt), ["clearPending", "consume:1", "consume:2"]);
});

test("directives that are not the answer are handed back and left in the queue", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [
      { directive: { type: "resumed_after", seconds: 420 } },
      { directive: { type: "new_signals", count: 2, summary: "two more 500s" } },
      { directive: boss("on it") },
    ],
  });

  const result = await runMessageBoss({ message: "anyone?", wait: true }, harness.deps);

  assert.equal(result.answer, "on it");
  assert.deepEqual(result.directives, [
    { type: "resumed_after", seconds: 420 },
    { type: "new_signals", count: 2, summary: "two more 500s" },
  ]);
  assert.deepEqual([...harness.consumed], [3], "only the answer, by id");
  assert.deepEqual((await harness.peekDirectives()).map((entry) => entry.id), [1, 2]);
});

test("directives other than an answer or an end do not end the wait", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [
      { directive: { type: "new_signals", count: 1, summary: "one more" }, at: 1_000_000 },
      { directive: boss("ok"), at: 1_000_000 + 120_000 },
    ],
  });

  const result = await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 30 },
  );

  assert.equal(harness.reads.length, 5, "the new signals were seen on four polls and did not end it");
  assert.equal(result.answer, "ok");
  assert.deepEqual(result.directives, [{ type: "new_signals", count: 1, summary: "one more" }]);
});

test("a stop ends the wait and the run", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [{ directive: { type: "stop", reason: "a human took it" }, at: 1_000_000 + 60_000 }],
  });

  const result = await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 30 },
  );

  assert.ok(harness.events.includes("recordPending"), "the premise: a question was outstanding");
  assert.deepEqual(result, {
    answer: null,
    timedOut: false,
    directives: [{ type: "stop", reason: "a human took it" }],
    terminate: true,
  });
  assert.equal(harness.pending(), null);
  assert.equal(harness.consumed.size, 0, "a stop is get_incident's to deliver, not the wait's to eat");
});

test("a merged directive ends the wait rather than being swallowed by it", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [{ directive: { type: "merged", into: "inc-9" }, at: 1_000_000 + 30_000 }],
  });

  const result = await runMessageBoss(
    { message: "can someone merge the PR?", wait: true },
    { ...harness.deps, pollSeconds: 30 },
  );

  assert.equal(harness.reads.length, 2);
  assert.equal(result.terminate, true);
  assert.equal(result.answer, null);
  assert.deepEqual(result.directives, [{ type: "merged", into: "inc-9" }]);
  assert.equal(harness.pending(), null);
});

test("a wait shorter than the floor is raised to it, not escalated early", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({
    clock,
    feed: [{ directive: boss("here"), at: start + 900_000 }],
  });

  await runMessageBoss(
    { message: "anyone?", wait: true, seconds: 60 },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  // Ten minutes, not one: the model cannot shorten its way out of the
  // escalation by asking for a wait nobody could answer inside.
  assert.deepEqual(
    harness.escalations().map((call) => (call.at - start) / 1000),
    [600],
  );
  assert.ok(harness.reads.some((at) => at - start === 60_000), "the premise: the requested minute was polled through");
});

test("the default floor is MESSAGE_BOSS_MIN_WAIT_SECONDS", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({
    clock,
    feed: [{ directive: boss("here"), at: start + (MESSAGE_BOSS_MIN_WAIT_SECONDS + 60) * 1000 }],
  });

  await runMessageBoss(
    { message: "anyone?", wait: true, seconds: 5 },
    { ...harness.deps, pollSeconds: 60 },
  );

  assert.deepEqual(
    harness.escalations().map((call) => (call.at - start) / 1000),
    [MESSAGE_BOSS_MIN_WAIT_SECONDS],
  );
});

test("a longer requested wait is honoured", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({
    clock,
    feed: [{ directive: boss("here"), at: start + 3_000_000 }],
  });

  await runMessageBoss(
    { message: "anyone?", wait: true, seconds: 2400 },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  assert.deepEqual(harness.escalations().map((call) => (call.at - start) / 1000), [2400]);
});

test("the escalation clock runs from the question, not from this process", async () => {
  const clock = fakeClock();
  const start = clock.now();
  // A marker 700 seconds old: the agent asked, the container died, and the
  // replacement replays the call. A fresh wait here would let a crash loop
  // defer the escalation for as long as the crashes last.
  const harness = questionHarness({
    clock,
    pending: { message: "anyone?", askedAt: start - 700_000 },
    feed: [{ directive: boss("here"), at: start + 60_000 }],
  });

  await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  assert.equal(harness.told.filter((call) => call.kind === "question").length, 0, "the premise: this is a resume");
  assert.deepEqual(
    harness.escalations().map((call) => call.at - start),
    [0],
    "already past the budget on the first poll",
  );
  assert.deepEqual(harness.sinceCalls, [start - 700_000], "the inbox is read from when it was asked");
  assert.match(harness.escalations()[0].text, /in 12m and I am still blocked/);
});

test("an unanswered question escalates with the question whole, and the wait carries on", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const question = `${"q".repeat(20_000)}\nWhich of the two rollbacks is safe?`;
  const harness = questionHarness({
    clock,
    feed: [{ directive: boss("the second one"), at: start + 900_000 }],
  });

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
  assert.ok(
    harness.reads.some((at) => at > escalations[0].at),
    "polling went on after the escalation",
  );
  assert.deepEqual(result, {
    answer: "the second one",
    timedOut: false,
    directives: [],
    terminate: false,
  });
});

test("an unanswered question re-escalates on a doubling gap read from the inbox", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({
    clock,
    feed: [{ directive: boss("finally"), at: start + 10_000_000 }],
  });

  await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  // 600s to the first, then gaps of 1200, 2400 and 4800.
  assert.deepEqual(
    harness.escalations().map((call) => (call.at - start) / 1000),
    [600, 1800, 4200, 9000],
  );
  assert.ok(harness.escalations().every((call) => call.pendingWhenTold !== null));
});

test("the re-escalation gap stops at the ceiling", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const harness = questionHarness({
    clock,
    feed: [{ directive: boss("finally"), at: start + 7_000_000 }],
  });

  await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600, maxGapSeconds: 1800 },
  );

  // 600, then gaps of 1200, 1800, 1800, 1800.
  assert.deepEqual(
    harness.escalations().map((call) => (call.at - start) / 1000),
    [600, 1800, 3600, 5400],
  );
});

test("a restart that finds a recent escalation does not escalate again at once", async () => {
  const run = async (priorEscalations: number[]) => {
    const clock = fakeClock();
    const start = clock.now();
    const harness = questionHarness({
      clock,
      pending: { message: "anyone?", askedAt: start - 700_000 },
      priorEscalations,
      feed: [{ directive: boss("here"), at: start + 1_000_000 }],
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
  assert.deepEqual(control.harness.escalations().map((call) => call.at - control.start), [0]);

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
    feed: [{ directive: boss("here"), at: start + 720_000 }],
  });

  const result = await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, pollSeconds: 60, minWaitSeconds: 600 },
  );

  assert.ok(harness.escalations().length > 0, "the premise: the escalation was tried and threw");
  assert.equal(result.answer, "here");
  assert.equal(result.timedOut, false);
});

test("the harness deadline clears the marker and ends the wait without escalating", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const deadline = new AbortController();
  deadline.abort();
  // Long past its escalation point, so an escalation here would be due.
  const harness = questionHarness({
    clock,
    pending: { message: "anyone?", askedAt: start - 7_200_000 },
    feed: [{ directive: { type: "new_signals", count: 1, summary: "one more" } }],
  });
  assert.ok(harness.pending(), "the premise: a question is outstanding");

  const result = await runMessageBoss(
    { message: "anyone?", wait: true },
    { ...harness.deps, minWaitSeconds: 600, signal: deadline.signal },
  );

  assert.deepEqual(result, {
    answer: null,
    timedOut: true,
    directives: [{ type: "new_signals", count: 1, summary: "one more" }],
    terminate: false,
  });
  assert.equal(harness.pending(), null);
  // The run steers the model to write a real brief inside the grace window.
  // Escalating here would spend the turn that brief needs.
  assert.equal(harness.escalations().length, 0);
  assert.equal(harness.reads.length, 1);
});

test("the message_boss tool says the message was sent, and does not end the run", async () => {
  const clock = fakeClock();
  const harness = questionHarness({ clock });
  const tool = await createMessageBossTool(harness.deps);

  const out = await tool.execute(
    "call-1",
    { message: "PR is up" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(toolText(out), "Sent to the Boss.");
  assert.equal(out.terminate, false);
  assert.equal(harness.told.length, 1);
});

test("the message_boss tool hands back the answer and renders what else arrived", async () => {
  const clock = fakeClock();
  const harness = questionHarness({
    clock,
    feed: [
      { directive: { type: "new_signals", count: 2, summary: "two more 500s" } },
      { directive: boss("yes, restart it") },
    ],
  });
  const tool = await createMessageBossTool(harness.deps);

  const out = await tool.execute(
    "call-1",
    { message: "can I restart the worker?", wait: true } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(
    toolText(out),
    "The Boss answered: yes, restart it\n\nDIRECTIVES\nNEW SIGNALS (2): two more 500s",
  );
  assert.equal(out.terminate, false);
});

test("the message_boss tool stops the agent on a terminating directive", async () => {
  const clock = fakeClock();
  const harness = questionHarness({ clock, feed: [{ directive: { type: "merged", into: "inc-9" } }] });
  const tool = await createMessageBossTool(harness.deps);

  const out = await tool.execute(
    "call-1",
    { message: "anyone?", wait: true } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(out.terminate, true);
  assert.equal(
    toolText(out),
    "The wait ended on a directive rather than an answer.\n\nDIRECTIVES\nMERGED: this incident is now part of inc-9. Stop work and exit.",
  );
});

test("message_boss honours the harness deadline alongside pi's signal", async () => {
  const clock = fakeClock();
  const deadline = new AbortController();
  deadline.abort();
  const harness = questionHarness({ clock });
  const tool = await createMessageBossTool({ ...harness.deps, signal: deadline.signal });

  const piSignal = new AbortController().signal;
  assert.equal(piSignal.aborted, false);
  const out = await tool.execute(
    "call-1",
    { message: "anyone?", wait: true } as never,
    piSignal,
    undefined,
    {} as never,
  );

  assert.equal(toolText(out), "Your deadline ended this wait. Escalate now, with a brief.");
  assert.equal((out.details as { timedOut: boolean }).timedOut, true);
  assert.equal(out.terminate, false);
  assert.ok(harness.events.includes("recordPending"), "the premise: the question was outstanding");
  assert.equal(harness.pending(), null);
  assert.equal(harness.escalations().length, 0, "the deadline is its own escalation path");
});

test("a replayed monitor call from before waitingFor existed still resumes", async () => {
  let probes = 0;
  const tool = await createMonitorTool({
    probe: async () => {
      probes += 1;
      return { code: 0, output: "" };
    },
  });
  assert.ok(
    (tool.parameters as { required?: string[] }).required?.includes("waitingFor"),
    "the premise: the model is required to give one",
  );
  const out = await tool.execute(
    "c1",
    { command: "true", intervalSeconds: 1, timeoutSeconds: 1, description: "x" } as never,
    new AbortController().signal,
    undefined,
    {} as never,
  );
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
  const tool = await createMonitorTool({ probe: stalled, sleep: clock.sleep, now: clock.now });

  const out = await tool.execute(
    "call-1",
    { command: "check", intervalSeconds: 300, timeoutSeconds: 14_400, description: "the ratio to settle", waitingFor: "the ratio to settle" } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.ok(clock.now() - started <= MAX_BLOCK_SECONDS * 1000, "waited no longer than the cap");
  assert.equal(clock.now() - started, MAX_BLOCK_SECONDS * 1000, "and did not give up early either");
  assert.equal((out.details as { timedOut: boolean }).timedOut, false, "a capped wait has not timed out");
  const text = toolText(out);
  assert.match(text, /^STILL WAITING for: the ratio to settle\./);
  assert.match(text, /capped at 3300s of the 14400s you asked for/);
  assert.match(text, /call monitor again with the same arguments/);
  assert.doesNotMatch(text, /TIMED OUT/);
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
  const tool = await createMessageBossTool({ ...harness.deps, maxBlockSeconds: MAX_BLOCK_SECONDS });

  const out = await tool.execute(
    "call-1",
    { message: "Can someone merge omni#2192?", wait: true, seconds: 86_400 } as never,
    undefined,
    undefined,
    {} as never,
  );

  assert.ok(clock.now() - started <= MAX_BLOCK_SECONDS * 1000);
  assert.match(toolText(out), /^No answer yet\. This call was capped at 3300s/);
  assert.match(toolText(out), /call message_boss again with the same message and wait: true/);
  assert.equal((out.details as { timedOut: boolean }).timedOut, false);
  assert.notEqual(harness.pending(), null, "the question is still outstanding");

  await tool.execute(
    "call-2",
    { message: "Can someone merge omni#2192?", wait: true, seconds: 86_400 } as never,
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(
    harness.told.filter((call) => call.kind === "question").length,
    1,
    "re-arming does not ask the Boss twice",
  );
});
