import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import Database from "better-sqlite3";

import type { ConversationId } from "../agent/harness";
import type { DispatcherConfig, ToolApi } from "../types";
import { DEADLINE_GRACE_SECONDS } from "../agent/budget";
import {
  RESUME_ALARM_SECONDS,
  createDispatcher,
  staleNotice,
  turnBudgetWaitingFor,
  type AgentRuntime,
  type Dispatcher,
  type DispatcherDb,
  type DispatcherDeps,
} from "./index";

const T0 = 1_700_000_000_000;

const config = (over: Partial<DispatcherConfig> = {}): DispatcherConfig => ({
  maxConcurrentAgents: 15,
  tickSeconds: 30,
  agentTimeoutSeconds: 1800,
  agentMaxTurns: 200,
  maxAttempts: 3,
  staleAfterSeconds: 86_400,
  ...over,
});

const makeDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "bugboss-dispatcher-"));
  const sqlite = new Database(join(dir, "test.db"));
  sqlite.exec(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));

  const db: DispatcherDb = {
    query<T>(sql: string, params: unknown[] = []): T[] {
      return sqlite.prepare(sql).all(...(params as never[])) as T[];
    },
    get<T>(sql: string, params: unknown[] = []): T | undefined {
      return sqlite.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    withWrite<T>(fn: (d: Database.Database) => T): Promise<T> {
      return Promise.resolve(sqlite.transaction(fn)(sqlite));
    },
  };

  const cleanup = () => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { db, sqlite, cleanup };
};

interface IncidentOverrides {
  status?: string;
  mergedInto?: string;
  attempts?: number;
  conversationId?: number | null;
  firstSignalAt?: number;
  lastStartedAt?: number | null;
  turnsUsed?: number;
  grantedTurns?: number;
}

const insertIncident = (
  sqlite: Database.Database,
  id: string,
  over: IncidentOverrides = {},
) =>
  sqlite
    .prepare(
      `INSERT INTO incident
         (id, status, firstSignalAt, attempts, conversationId, lastStartedAt,
          turnsUsed, grantedTurns, resolvedAt, closedAt, postmortem, mergedInto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.status ?? "INVESTIGATING",
      over.firstSignalAt ?? T0,
      over.attempts ?? 0,
      over.conversationId ?? null,
      over.lastStartedAt ?? null,
      over.turnsUsed ?? 0,
      over.grantedTurns ?? 0,
      // Terminal statuses carry the fields that define them. The schema
      // enforces it now, so a fixture cannot build a CLOSED incident with no
      // post-mortem, which is a state no code path can reach.
      over.status === "RESOLVED" || over.status === "CLOSED" ? T0 : null,
      over.status === "CLOSED" ? T0 : null,
      over.status === "CLOSED" ? "fixture post-mortem" : null,
      over.mergedInto ?? null,
    );

const ok = async () => ({ ok: true });

/** The dispatcher's alarms are structured stderr, so that is the assertion. */
const captureAlarms = async (fn: () => Promise<void>): Promise<string[]> => {
  const original = console.error;
  const events: string[] = [];
  console.error = (line: unknown) => {
    try {
      events.push(JSON.parse(String(line)).event);
    } catch {
      original(line);
    }
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return events;
};

/**
 * The escalation path, recording only. `escalate` writes nothing: it posts a
 * brief and mentions the rotation, and the incident carries on being driven
 * by an agent. So the fake's whole job is to say that the call was made and
 * what it said -- there is no state change left to simulate.
 */
const makeTools = () => {
  const escalations: { incidentId: string; reason: string; brief: string }[] = [];
  const toolApiFor = (incidentId: string): ToolApi => ({
    reportRootCause: ok,
    proposeMerge: ok,
    setSummary: ok,
    reportImpact: ok,
    reportResolved: ok,
    reportAnalysis: ok,
    getIncident: ok,
    searchIncidents: ok,
    trackTimelineEvent: ok,
    escalate: async ({ reason, brief }) => {
      escalations.push({ incidentId, reason, brief });
      return { ok: true };
    },
    park: ok,
  });
  return { toolApiFor, escalations };
};

type Outcome = "done" | "unanswered";

interface Submitted {
  incidentId: string;
  conversationId: ConversationId;
  content: string;
  requestId: string;
  whenBusy: "steer" | "followUp";
}

/**
 * The harness, in memory. The dispatcher's whole contract with Pi is this
 * seam, so a fake of it is the real boundary rather than a mock of one.
 *
 * A launch input (`followUp`) makes the conversation busy until the test
 * finishes it, or until `settle` does so on the spot. A steer is recorded and
 * changes nothing. `abort` ends the run unanswered, as the harness does.
 */
const fakeRuntime = (opts: {
  settle?: (s: Submitted) => Outcome | "hold";
  onSubmit?: (s: Submitted) => void | Promise<void>;
  create?: (incidentId: string) => void;
} = {}) => {
  let next = 1;
  const owner = new Map<number, string>();
  const created: { incidentId: string; cwd: string; instructions: string }[] = [];
  const submits: Submitted[] = [];
  const pending = new Map<number, (o: Outcome) => void>();
  const aborts: string[] = [];

  const finish = (id: number, outcome: Outcome = "done") => {
    const resolve = pending.get(id);
    pending.delete(id);
    resolve?.(outcome);
  };

  const runtime: AgentRuntime = {
    createIncidentConversation: async (incidentId, a) => {
      opts.create?.(incidentId);
      created.push({ incidentId, ...a });
      const id = (100 + next++) as ConversationId;
      owner.set(id, incidentId);
      return id;
    },
    submit: async (id, content, o) => {
      const s: Submitted = {
        incidentId: owner.get(id) ?? `conversation ${id}`,
        conversationId: id,
        content,
        requestId: o.requestId,
        whenBusy: o.whenBusy,
      };
      submits.push(s);
      if (o.whenBusy === "steer") return { wait: async () => "done" as const };
      const result = new Promise<Outcome>((resolve) => pending.set(id, resolve));
      await opts.onSubmit?.(s);
      const verdict = opts.settle?.(s) ?? "hold";
      if (verdict !== "hold") finish(id, verdict);
      return { wait: () => result };
    },
    isBusy: async (id) => pending.has(id),
    abort: async (id) => {
      aborts.push(owner.get(id) ?? `conversation ${id}`);
      finish(id, "unanswered");
    },
    reset: async () => {},
  };

  return {
    runtime,
    created,
    submits,
    aborts,
    launches: () => submits.filter((s) => s.whenBusy === "followUp"),
    steers: () => submits.filter((s) => s.whenBusy === "steer"),
    /** A conversation a deploy left running, which `harness.resume()` picked up. */
    hold: (id: number, incidentId: string) => {
      owner.set(id, incidentId);
      pending.set(id, () => {});
    },
    finish,
    finishAll: (outcome: Outcome = "done") => {
      for (const id of [...pending.keys()]) finish(id, outcome);
    },
    /** The runs ended while no dispatcher was watching, as a restart leaves them. */
    idleAll: () => pending.clear(),
  };
};

const deps = (
  over: Partial<DispatcherDeps> & Pick<DispatcherDeps, "db" | "runtime" | "toolApiFor">,
): DispatcherDeps => ({
  config: config(),
  composePrompt: async (incidentId) => `prompt for ${incidentId}`,
  messages: {
    kickoff: (incidentId, o) =>
      `kickoff ${incidentId}${o.resumedWithoutTranscript ? " without transcript" : ""}`,
    resume: (checkout, npmCiFailed) => `resume ${checkout}${npmCiFailed ? " npm ci failed" : ""}`,
  },
  now: () => T0,
  ...over,
});

const resumedSeconds = (content: string): number | null => {
  const match = /RESUMED after (\d+)s/.exec(content);
  return match ? Number(match[1]) : null;
};

/** Lets every background launch run up to its first real wait. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("Dispatcher.tick", () => {
  // Status is the whole of eligibility now. Nothing marks an open incident as
  // somebody else's: an agent drives every one of them, and the only rows
  // that get no agent are the two that are over.
  it("starts exactly one agent per open incident, and none for a terminal one", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", { status: "INVESTIGATING" });
    insertIncident(sqlite, "i2", { status: "FIXING" });
    // RESOLVED is an agent status: report_analysis is the only exit from it
    // and it is the agent's to call, so a RESOLVED incident still needs one.
    insertIncident(sqlite, "i3", { status: "RESOLVED" });
    // CLOSED has a post-mortem and MERGED has an incident that absorbed it.
    // Both are finished, and finished is the only reason to leave a row
    // without an agent.
    insertIncident(sqlite, "i4", { status: "CLOSED" });
    insertIncident(sqlite, "i5", { status: "MERGED", mergedInto: "i1" });

    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor }));
    const result = await d.tick();
    await result.settled;

    assert.deepEqual(rt.launches().map((s) => s.incidentId).sort(), ["i1", "i2", "i3"]);
    assert.deepEqual(
      result.started.map((a) => a.incidentId).sort(),
      ["i1", "i2", "i3"],
    );
    assert.equal(result.circuitOpen, false);

    const attempts = Object.fromEntries(
      db
        .query<{ id: string; attempts: number }>("SELECT id, attempts FROM incident")
        .map((r) => [r.id, r.attempts]),
    );
    assert.deepEqual(attempts, { i1: 1, i2: 1, i3: 1, i4: 0, i5: 0 });
    cleanup();
  });

  it("creates the conversation on the first launch, pins the prompt to it, and reuses it after", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor, now: () => clock }));

    await (await d.tick()).settled;
    assert.deepEqual(rt.created, [
      { incidentId: "i1", cwd: "/work/i1/omni", instructions: "prompt for i1" },
    ]);
    const stored = db.get<{ conversationId: number }>(
      "SELECT conversationId FROM incident WHERE id = 'i1'",
    )?.conversationId;
    assert.equal(stored, rt.launches()[0].conversationId, "the id lands on the row");
    assert.equal(rt.launches()[0].content, "kickoff i1");
    assert.equal(rt.launches()[0].requestId, "incident:i1:launch:1");

    // It answered and the incident is still open, which is what a child exit
    // used to mean: the next tick relaunches into the same conversation.
    clock += 600_000;
    await (await d.tick()).settled;
    assert.equal(rt.created.length, 1, "one conversation per incident, ever");
    assert.equal(rt.launches()[1].conversationId, stored);
    assert.equal(rt.launches()[1].requestId, "incident:i1:launch:2");
    assert.match(rt.launches()[1].content, /^resume reused/);
    cleanup();
  });

  // The cutover. Every incident open at the first boot on the harness has a
  // launch behind it and no conversation, so its transcript is a JSONL file
  // nothing reads any more, and the kickoff has to say so.
  it("tells an incident from before the harness that its transcript is gone", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", { attempts: 3, lastStartedAt: T0 - 600_000 });
    insertIncident(sqlite, "i2");

    const rt = fakeRuntime();
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor }));
    await d.tick();

    const content = Object.fromEntries(rt.launches().map((s) => [s.incidentId, s.content]));
    assert.deepEqual(content, { i1: "kickoff i1 without transcript", i2: "kickoff i2" });
    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("hands the prompt the alert slugs of its incident's signals, and no one else's", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");
    insertIncident(sqlite, "i2", { status: "CLOSED" });
    const signal = sqlite.prepare(
      `INSERT INTO signal (id, source, sourceId, kind, title, body, labels, openedAt, incidentId)
       VALUES (?, 'grafana', ?, 'alert', 't', 'b', ?, ?, ?)`,
    );
    signal.run("s1", "f1", JSON.stringify({ alert_slug: "route-errors-win" }), T0, "i1");
    signal.run("s2", "f2", JSON.stringify({ alert_slug: "high-cpu" }), T0, "i1");
    signal.run("s3", "f3", JSON.stringify({ alert_slug: "high-cpu" }), T0, "i1");
    signal.run("s4", "f4", JSON.stringify({}), T0, "i1");
    signal.run("s5", "f5", JSON.stringify({ alert_slug: "someone-elses" }), T0, "i2");

    const seen: string[][] = [];
    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        composePrompt: async (_id, a) => {
          seen.push(a.alertSlugs);
          return "prompt";
        },
      }),
    );
    await (await d.tick()).settled;

    assert.deepEqual(seen, [["high-cpu", "route-errors-win"]]);
    cleanup();
  });

  // The checkout is minutes of git and runs in the background, so for those
  // minutes the conversation is not busy yet and only the dispatcher's own
  // record of the launch stops the next tick submitting a second one.
  it("does not launch again while a launch is still preparing", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    let ready = () => {};
    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        composePrompt: () =>
          new Promise<string>((resolve) => {
            ready = () => resolve("prompt");
          }),
      }),
    );

    const first = await d.tick();
    const second = await d.tick();
    assert.deepEqual(first.started.map((a) => a.incidentId), ["i1"]);
    assert.deepEqual(second.started, [], "still preparing is still live");
    assert.deepEqual(d.list().map((a) => a.incidentId), ["i1"]);

    ready();
    await first.settled;
    assert.equal(rt.created.length, 1);
    assert.equal(rt.launches().length, 1);
    cleanup();
  });

  it("resumes and escalates a RESOLVED incident, because the post-mortem is the agent's", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    // The container restarted while the agent was drafting the post-mortem,
    // and its run had ended by the time the harness came back.
    insertIncident(sqlite, "i1", {
      status: "RESOLVED",
      attempts: 1,
      conversationId: 7,
      lastStartedAt: T0 - 600_000,
    });

    let clock = T0;
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ agentTimeoutSeconds: 60 }), now: () => clock }),
    );

    const first = await d.tick();
    assert.deepEqual(first.started.map((a) => a.incidentId), ["i1"]);
    assert.equal(rt.created.length, 0, "resume the post-mortem, not restart it");
    assert.equal(rt.launches()[0].conversationId, 7);
    assert.deepEqual(d.list().map((a) => a.phase), ["RESOLVED"]);

    // And if it wedges there, RESOLVED must still be said out loud rather
    // than going quiet: the post-mortem is the last thing anyone is waiting
    // for, and nothing else in the system would ever mention it again.
    clock = T0 + 60_000 + 181_000;
    const second = await d.tick();
    assert.equal(rt.aborts.length, 1);
    assert.deepEqual(second.aborted, ["i1"]);
    assert.deepEqual(second.escalated, ["i1"]);
    assert.equal(escalations.length, 1);

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("does not start a second agent for an incident that already has one", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    const rt = fakeRuntime();
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor }));

    await d.tick();
    await flush();
    const second = await d.tick();

    assert.equal(rt.launches().length, 1, "one live agent, one launch");
    assert.deepEqual(second.started, []);
    assert.deepEqual(d.list().map((a) => a.incidentId), ["i1"]);
    assert.equal(
      db.get<{ attempts: number }>("SELECT attempts FROM incident WHERE id = 'i1'")
        ?.attempts,
      1,
    );

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  // A deploy stops the process, not the run: `harness.resume()` picks it up
  // at boot, so a fresh dispatcher has to see it as live without having
  // launched it.
  it("treats a conversation the harness resumed as live, and counts it against the ceiling", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", { conversationId: 7, attempts: 1, lastStartedAt: T0 - 60_000 });
    insertIncident(sqlite, "i2");

    const rt = fakeRuntime();
    rt.hold(7, "i1");
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ maxConcurrentAgents: 1 }) }),
    );
    const result = await d.tick();

    assert.deepEqual(result.started, [], "i1 is still running, and it fills the only slot");
    assert.equal(result.circuitOpen, true);
    assert.deepEqual(d.list().map((a) => a.incidentId), ["i1"]);
    assert.equal(rt.launches().length, 0);
    cleanup();
  });

  it("counts a conversation it cannot read as live, and says the read is broken", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", { conversationId: 7, attempts: 1, lastStartedAt: T0 - 60_000 });

    const rt = fakeRuntime();
    const runtime: AgentRuntime = {
      ...rt.runtime,
      isBusy: async () => {
        throw new Error("harness.sqlite is locked");
      },
    };
    const d = createDispatcher(deps({ db, runtime, toolApiFor }));
    let started: string[] = [];
    const alarms = await captureAlarms(async () => {
      started = (await d.tick()).started.map((a) => a.incidentId);
    });

    assert.deepEqual(started, [], "a second launch into a running conversation is the worse mistake");
    assert.ok(alarms.includes("busy_check_failed"));
    cleanup();
  });

  it("stops dispatching at the concurrency ceiling and says so", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    for (const id of ["i1", "i2", "i3", "i4", "i5"]) insertIncident(sqlite, id);

    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ maxConcurrentAgents: 2 }) }),
    );

    const first = await d.tick();
    assert.equal(first.started.length, 2);
    assert.equal(first.circuitOpen, true);

    // No queue: the ceiling refuses, it does not defer. A second tick while
    // the slots are still full launches nothing.
    const second = await d.tick();
    assert.equal(second.started.length, 0);
    assert.equal(second.circuitOpen, true);
    assert.equal(rt.launches().length, 2);

    rt.finishAll();
    await d.drain();

    const third = await d.tick();
    assert.equal(third.started.length, 2, "slots freed, the next tick fills them");
    assert.equal(third.circuitOpen, true);

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("escalates a crash loop instead of relaunching forever", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    // Ends the instant it starts, and ends without an answer. Both halves
    // matter -- a short run that answered is a deploy draining an agent, not
    // a crash, and counting it walked a rolling deploy to this escalation.
    const rt = fakeRuntime({ settle: () => "unanswered" });
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ maxAttempts: 3 }) }),
    );

    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    assert.equal(rt.launches().length, 3);
    assert.equal(escalations.length, 0, "the limit is a ceiling, not a trigger");

    const fourth = await d.tick();
    assert.equal(rt.launches().length, 3, "no relaunch past three consecutive fast deaths");
    assert.deepEqual(fourth.escalated, ["i1"]);
    assert.match(escalations[0].reason, /consecutive launches died/);
    assert.match(escalations[0].brief, /crash loop/);

    // Said once, then left alone. The dispatcher records the incident as one
    // it has given up relaunching, which is what stops both the relaunch and
    // a second copy of the same brief every thirty seconds.
    const fifth = await d.tick();
    assert.deepEqual(fifth.escalated, [], "given up on, so the loop is over");
    cleanup();
  });

  // The half `owner = 'human'` used to do for free. That write took the row
  // out of the eligibility query, which stopped the relaunch, and made the
  // second escalation a no-op. Nothing writes ownership any more -- an open
  // incident is always an agent's -- so the dispatcher has to remember, and
  // this is the test that says it does.
  it("gives up on a crash loop once, and then says nothing further", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    const rt = fakeRuntime({ settle: () => "unanswered" });
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ maxAttempts: 3 }) }),
    );

    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    assert.deepEqual((await d.tick()).escalated, ["i1"]);

    // Twenty more ticks is ten minutes of the incident sitting open, which is
    // the shape of the bug: a condition re-decided every tick posts the same
    // brief until somebody closes the incident.
    for (let i = 0; i < 20; i += 1) await (await d.tick()).settled;

    assert.equal(rt.launches().length, 3, "no relaunch after the dispatcher gave up");
    assert.equal(escalations.length, 1, "and no second copy of the brief");
    // The incident is untouched and still open: giving up on relaunching it
    // is not a transition, and the status is the only thing eligibility reads.
    assert.equal(
      db.get<{ status: string }>("SELECT status FROM incident WHERE id = 'i1'")?.status,
      "INVESTIGATING",
    );
    cleanup();
  });

  // The rolling-deploy case: three bounces of a freshly-launched agent once
  // handed a human a crash-loop brief for a deploy that worked.
  it("does not count a short run that answered as a crash", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ maxAttempts: 3 }) }),
    );

    for (let i = 0; i < 5; i += 1) await (await d.tick()).settled;

    assert.equal(rt.launches().length, 5, "it keeps relaunching rather than giving up");
    assert.deepEqual(escalations, [], "and nobody is handed a crash-loop brief");
    cleanup();
  });

  // A Boss stop_agent aborts the run the dispatcher launched, and the run
  // settles unanswered a moment after it started: the shape of a crash.
  it("does not count a run the Boss stopped as a crash", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    const rt = fakeRuntime({
      settle: () => {
        d.noteStopped("i1");
        return "unanswered";
      },
    });
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ maxAttempts: 3 }) }),
    );

    for (let i = 0; i < 5; i += 1) await (await d.tick()).settled;

    assert.equal(rt.launches().length, 5, "every stop is followed by a fresh run");
    assert.deepEqual(escalations, [], "and nobody is handed a crash-loop brief");
    cleanup();
  });

  it("falls back to relaunching when the crash-loop escalation fails", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    const rt = fakeRuntime({ settle: () => "unanswered" });
    let escalationFails = true;
    const failingToolApiFor = (incidentId: string): ToolApi => ({
      ...toolApiFor(incidentId),
      escalate: async (args) => {
        if (escalationFails) throw new Error("Slack is down");
        return toolApiFor(incidentId).escalate(args);
      },
    });

    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor: failingToolApiFor,
        config: config({ maxAttempts: 3 }),
      }),
    );
    const launches = () => rt.launches().length;

    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    assert.equal(launches(), 3);

    const failed = await d.tick();
    assert.deepEqual(failed.escalated, [], "the escalation threw, so nobody was told");
    assert.equal(launches(), 3, "this tick spends itself on the escalation");

    // An untold escalation must not stop the relaunching, because nothing
    // else is coming: the counter stayed at the ceiling before, so every
    // later tick retried the same failing call and the incident never moved.
    await (await d.tick()).settled;
    assert.equal(launches(), 4, "a failed escalation falls back to relaunching");

    escalationFails = false;
    for (let i = 0; i < 2; i += 1) await (await d.tick()).settled;
    const recovered = await d.tick();
    assert.deepEqual(recovered.escalated, ["i1"], "and it can still escalate later");
    assert.equal(escalations.length, 1);

    // Only the escalation that landed ends the relaunching. Up to here every
    // failure fell back, which is why the fallback cannot be permanent.
    for (let i = 0; i < 5; i += 1) await (await d.tick()).settled;
    assert.equal(launches(), 6);
    assert.equal(escalations.length, 1);
    cleanup();
  });

  it("escalates an agent that dies just past the fast-failure window", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        fastFailureSeconds: 60,
        maxLaunches: 3,
        now: () => clock,
      }),
    );

    // Bedrock throttling, an OOM, credentials expiring: dies at 61s every
    // time, which clears the consecutive-fast counter on every ending, so
    // nothing bounded this. It relaunched every tick for as long as the
    // incident stayed open.
    const die = async () => {
      const result = await d.tick();
      clock += 61_000;
      await flush();
      rt.finishAll("unanswered");
      await result.settled;
    };

    for (let i = 0; i < 3; i += 1) await die();
    assert.equal(rt.launches().length, 3);
    assert.equal(escalations.length, 0, "the limit is a ceiling, not a trigger");

    const fourth = await d.tick();
    assert.equal(rt.launches().length, 3, "no relaunch past the launch ceiling");
    assert.deepEqual(fourth.escalated, ["i1"]);
    assert.match(escalations[0].reason, /launches/);
    assert.match(escalations[0].brief, /has finished none of them/);
    cleanup();
  });

  // Why the give-up set is in memory rather than a column. Every merge to
  // ops `main` restarts this container, and a persisted quarantine is one a
  // deploy could not clear -- an incident open, nobody looking at it, and no
  // agent allowed near it, which is the hole this whole change removes.
  it("keeps an incident it gave up on parked across a restart, and wakes it on the cooldown", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const rt = fakeRuntime();
    const build = () =>
      createDispatcher(
        deps({
          db,
          runtime: rt.runtime,
          toolApiFor,
          config: config({ maxAttempts: 3 }),
          fastFailureSeconds: 60,
          maxLaunches: 2,
          parkCooldownSeconds: 3600,
          now: () => clock,
        }),
      );

    const d = build();
    for (let i = 0; i < 2; i += 1) {
      const result = await d.tick();
      clock += 61_000;
      await flush();
      rt.finishAll("unanswered");
      await result.settled;
    }
    assert.deepEqual((await d.tick()).escalated, ["i1"]);
    assert.equal(rt.launches().length, 2);
    assert.deepEqual((await d.tick()).started, [], "this container is done with it");
    assert.equal(escalations.length, 1, "said once, not once a tick");

    // A new container, same database. The stop is a row rather than a Set,
    // so a restart does not undo it -- which is the point. A crash loop that
    // a deploy could clear is a crash loop that a deploy would relaunch
    // straight into.
    const restarted = build();
    assert.deepEqual(
      (await restarted.tick()).started,
      [],
      "the park outlives the process that decided it",
    );
    assert.equal(rt.launches().length, 2);

    // The cooldown is what lifts it, because none of the reasons it parked
    // are permanent -- and it has to lift on the container that gave up, not
    // only on a fresh one. Ticking `restarted` here would prove nothing about
    // that: it has never launched anything, so its counters are empty either
    // way and it cannot tell a dispatcher that cleared its count at the
    // ceiling from one that left it there. `d` is the one that parked this.
    clock += 3_600_000;
    const woken = await d.tick();
    assert.deepEqual(
      woken.started.map((a) => a.incidentId),
      ["i1"],
      "not now is not the same as not ever",
    );
    assert.equal(escalations.length, 1, "and it is not escalated straight back");

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("gives a crash loop another go at the cooldown instead of paging again", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const rt = fakeRuntime({ settle: () => "unanswered" });
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        maxLaunches: 99,
        parkCooldownSeconds: 3600,
        now: () => clock,
      }),
    );

    // Three instant deaths: a crash loop, which escalates and parks.
    // `maxLaunches` is held out of the way so this exercises the fast-failure
    // path and only it.
    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    const gaveUp = await d.tick();
    await gaveUp.settled;
    assert.deepEqual(gaveUp.escalated, ["i1"]);
    assert.equal(escalations.length, 1);
    assert.equal(rt.launches().length, 3, "no relaunch past the ceiling");

    // Nothing for the whole cooldown, on the same container.
    const during = await d.tick();
    await during.settled;
    assert.deepEqual(during.started, []);
    assert.equal(escalations.length, 1, "said once, not once a tick");

    // The cooldown expires into the retry `park` promises. A count left at
    // the ceiling would meet the incident here instead and page the rotation
    // a second time for the same three launches -- then park, expire, and do
    // it again every hour for as long as the container lives.
    clock += 3_600_000;
    const woken = await d.tick();
    await woken.settled;
    assert.deepEqual(
      woken.started.map((a) => a.incidentId),
      ["i1"],
      "not now is not the same as not ever",
    );
    assert.equal(escalations.length, 1, "and nobody was paged twice for it");
    await d.drain();
    cleanup();
  });

  // The `maxLaunches` twin of the test above. Both ceilings clear their
  // counter at the park and each needs its own test: covering one and
  // trusting the other is how the uncovered one comes back, and the property
  // here is invisible unless one dispatcher instance crosses the cooldown.
  it("gives a stalled incident another go at the cooldown instead of paging again", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        fastFailureSeconds: 60,
        maxLaunches: 2,
        parkCooldownSeconds: 3600,
        now: () => clock,
      }),
    );

    // Dies at 61s every time: slow enough to clear the fast-failure counter
    // on each ending, so this is the launch ceiling and only it.
    for (let i = 0; i < 2; i += 1) {
      const result = await d.tick();
      clock += 61_000;
      await flush();
      rt.finishAll("unanswered");
      await result.settled;
    }
    assert.deepEqual((await d.tick()).escalated, ["i1"]);
    assert.equal(escalations.length, 1);
    assert.equal(rt.launches().length, 2, "no relaunch past the ceiling");

    assert.deepEqual((await d.tick()).started, [], "parked for the cooldown");
    assert.equal(escalations.length, 1, "said once, not once a tick");

    // Same instance across the boundary. A count left at the ceiling meets
    // the incident here and pages a second time for the same two launches,
    // then parks and does it again every hour for the container's life.
    clock += 3_600_000;
    const woken = await d.tick();
    assert.deepEqual(
      woken.started.map((a) => a.incidentId),
      ["i1"],
      "the cooldown owes it another go",
    );
    assert.equal(escalations.length, 1, "and nobody was paged twice for it");

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  // `park` is an upsert, and the conflict branch is the reachable half: an
  // agent parks itself on a deploy with a wake time, the wake passes, the
  // incident is eligible again, and a crash loop then drives it to the
  // ceiling while the agent's own row is still sitting there. The dispatcher
  // has to replace that row rather than fail quietly against it -- a stale
  // wake in the past is not a stop, so DO NOTHING here would mean the park
  // does not park and the incident is relaunched instead of cooling down.
  it("parks over a wait whose wake time has already passed", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");
    sqlite
      .prepare(
        `INSERT INTO incident_wait
           (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES ('i1', 'a deploy to go out', ?, 1, ?)`,
      )
      .run(T0 - 1000, T0 - 2000);

    const rt = fakeRuntime({ settle: () => "unanswered" });
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        maxLaunches: 99,
        parkCooldownSeconds: 3600,
        now: () => T0,
      }),
    );

    // The expired wake is what makes it eligible at all, so these launches
    // are the proof the conflict branch is reachable rather than theoretical.
    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    assert.equal(rt.launches().length, 3);
    assert.deepEqual((await d.tick()).escalated, ["i1"]);
    assert.equal(escalations.length, 1);

    const wait = db.get<{ waitingFor: string; wakeAt: number | null }>(
      "SELECT waitingFor, wakeAt FROM incident_wait WHERE incidentId = 'i1'",
    );
    assert.match(wait?.waitingFor ?? "", /died within/, "the agent's wait was replaced");
    assert.equal(
      wait?.wakeAt,
      T0 + 3_600_000,
      "and it carries the dispatcher's cooldown, not the wake that had already passed",
    );

    assert.deepEqual(
      (await d.tick()).started,
      [],
      "which is what makes the park a stop rather than a row nobody replaced",
    );
    assert.equal(rt.launches().length, 3);
    cleanup();
  });

  it("leaves a wait a reply cannot end alone, however much the thread talks", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");
    // A run out of turns. A reply adds none, so waking on one relaunches an
    // agent that stops again on its first turn and escalates again -- which
    // is how every comment on a thread became a page for the rotation.
    sqlite
      .prepare(
        `INSERT INTO incident_wait
           (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES ('i1', 'a fresh turn budget', NULL, 0, ?)`,
      )
      .run(T0);

    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor, now: () => T0 }));

    await (await d.tick()).settled;
    assert.deepEqual(rt.launches(), [], "parked, so nothing runs it");

    // What the relay does on every reply. Three of them, because the failure
    // was per-comment: each one woke it and each wake paged.
    const reply = () =>
      sqlite
        .prepare(
          "DELETE FROM incident_wait WHERE incidentId = 'i1' AND liftsOnReply = 1",
        )
        .run();
    reply();
    reply();
    reply();

    assert.equal(
      db.query("SELECT incidentId FROM incident_wait WHERE incidentId = 'i1'")
        .length,
      1,
      "a reply is not news about a turn budget, so the wait stands",
    );

    await (await d.tick()).settled;
    assert.deepEqual(
      rt.launches(),
      [],
      "and nothing relaunched it into the wall it just hit",
    );
    cleanup();
  });

  it("wakes a parked incident the moment somebody replies in its thread", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");
    // Parked with a cooldown a long way off, so a wake here can only have
    // come from the reply.
    sqlite
      .prepare(
        `INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, startedAt)
         VALUES ('i1', 'somebody to look', ?, ?)`,
      )
      .run(T0 + 86_400_000, T0);

    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor, now: () => T0 }));

    await (await d.tick()).settled;
    assert.deepEqual(rt.launches(), [], "parked, so nothing runs it");

    // What the relay does when a reply lands, which is the whole fix: talking
    // to an incident wakes it, with no model in the path.
    sqlite.prepare("DELETE FROM incident_wait WHERE incidentId = 'i1'").run();

    await (await d.tick()).settled;
    assert.deepEqual(rt.launches().map((s) => s.incidentId), ["i1"]);
    cleanup();
  });

  it("does not count container restarts toward the launch ceiling", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    // Every merge to ops main restarts this container. That is routine, so it
    // must never read as an agent that cannot stay up.
    insertIncident(sqlite, "i1", { attempts: 40 });

    let clock = T0;
    const rt = fakeRuntime();
    for (let i = 0; i < 6; i += 1) {
      const restarted = createDispatcher(
        deps({
          db,
          runtime: rt.runtime,
          toolApiFor,
          config: config({ maxAttempts: 3 }),
          fastFailureSeconds: 60,
          maxLaunches: 2,
          now: () => clock,
        }),
      );
      const result = await restarted.tick();
      assert.deepEqual(
        result.started.map((a) => a.incidentId),
        ["i1"],
        `restart ${i} must still staff the incident`,
      );
      await flush();
      // The run ended while the container was down, so nobody saw it end.
      rt.idleAll();
      clock += 900_000;
    }

    assert.deepEqual(escalations, [], "46 launches, none of them the agent's fault");
    cleanup();
  });

  it("treats an interrupted agent as interrupted, not as crashing", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    // A high total: every merge to ops main restarts this container, and a
    // long incident collects launches that way.
    insertIncident(sqlite, "i1", { attempts: 12 });

    let clock = T0;
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        fastFailureSeconds: 60,
        now: () => clock,
      }),
    );

    for (let i = 0; i < 4; i += 1) {
      const result = await d.tick();
      clock += 600_000;
      await flush();
      rt.finishAll("unanswered");
      await result.settled;
    }

    assert.equal(rt.launches().length, 4, "a healthy agent is always relaunched");
    assert.deepEqual(escalations, [], "attempts alone must never escalate");
    assert.equal(
      db.get<{ attempts: number }>("SELECT attempts FROM incident WHERE id = 'i1'")
        ?.attempts,
      16,
      "attempts stays a running total, purely informational",
    );
    cleanup();
  });

  it("keeps ticking when one incident fails to launch", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");
    insertIncident(sqlite, "i2");

    const rt = fakeRuntime({
      create: (incidentId) => {
        if (incidentId === "i1") throw new Error("harness refused the conversation");
      },
    });
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ maxAttempts: 2 }) }),
    );

    await d.tick();
    await flush();
    assert.deepEqual(
      rt.launches().map((s) => s.incidentId),
      ["i2"],
      "i1's failure must not stall i2",
    );

    await d.tick();
    await flush();
    const third = await d.tick();
    assert.deepEqual(third.escalated, ["i1"], "a launch that never starts escalates");
    assert.match(escalations[0].reason, /consecutive launches died/);
    assert.deepEqual(d.list().map((a) => a.incidentId), ["i2"], "i2 ran throughout");

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("steers at the soft deadline, and gives the agent its whole grace before the abort", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60, tickSeconds: 30 }),
        now: () => clock,
      }),
    );

    await d.tick();
    await flush();
    assert.deepEqual(d.list(), [{ incidentId: "i1", startedAt: T0, phase: "INVESTIGATING" }]);

    // Every clock below is a literal on purpose. Deriving them from the
    // constant would move them in lockstep with it, so changing the grace
    // would silently move the abort and leave this green. The literals encode
    // 180s of grace, and this is the assertion that says so.
    assert.equal(
      DEADLINE_GRACE_SECONDS,
      180,
      "the grace changed; the clocks in this test encode 180s",
    );

    // The soft deadline asks the agent for its brief. An abort here is what
    // left every timeout escalation with an empty brief.
    clock = T0 + 61_000;
    const atSoft = await d.tick();
    assert.equal(rt.aborts.length, 0, "aborting at the soft deadline eats the grace window");
    assert.deepEqual(atSoft.aborted, []);
    assert.deepEqual(atSoft.escalated, []);
    assert.deepEqual(
      rt.steers().map((s) => [s.requestId, s.conversationId]),
      [["incident:i1:deadline:1", rt.launches()[0].conversationId]],
    );
    assert.match(rt.steers()[0].content, /deadline has expired/);
    assert.match(rt.steers()[0].content, /180 seconds/);

    // 1s before the end of the grace. Still the agent's, and steered once.
    clock = T0 + 239_000;
    const beforeAbort = await d.tick();
    assert.equal(rt.aborts.length, 0, "still inside the grace the agent was promised");
    assert.deepEqual(beforeAbort.aborted, []);
    assert.equal(rt.steers().length, 1, "one steer, not one a tick");

    // 60s + 180s + 1s. Only now, and only for an agent too wedged to have
    // used any of it.
    clock = T0 + 241_000;
    const afterGrace = await d.tick();
    assert.equal(rt.aborts.length, 1, "the abort is the backstop for a wedged agent");
    assert.deepEqual(afterGrace.aborted, ["i1"]);
    assert.deepEqual(afterGrace.escalated, ["i1"]);
    assert.equal(escalations.length, 1);
    assert.match(escalations[0].reason, /deadline/);

    // Aborted once, not once per tick.
    clock += 60_000;
    await d.tick();
    assert.equal(rt.aborts.length, 1);

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("aborts a run the harness resumed once it passes the deadline its launch set", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    // Launched before the deploy, resumed by the harness after it, and never
    // launched by this process. The deadline lives on the row, so it still
    // reaches it.
    insertIncident(sqlite, "i1", { conversationId: 7, attempts: 1, lastStartedAt: T0 - 300_000 });

    const rt = fakeRuntime();
    rt.hold(7, "i1");
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ agentTimeoutSeconds: 60 }) }),
    );
    const result = await d.tick();

    assert.deepEqual(result.aborted, ["i1"]);
    assert.equal(escalations.length, 1);
    assert.match(escalations[0].brief, /conversation 7/);
    cleanup();
  });

  it("never adds its own brief on top of one the agent wrote in its grace", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let d: Dispatcher | null = null;
    // What the agent does with the grace the soft deadline buys it. It says
    // what it knows and ends its run; the incident is still open afterwards,
    // because saying so was never a transition.
    const rt = fakeRuntime({
      onSubmit: async (s) => {
        if (s.requestId !== "incident:i1:launch:1") return;
        await toolApiFor("i1").escalate({ reason: "out of time", brief: "the real brief" });
        d?.noteEscalated("i1");
      },
      settle: () => "done",
    });

    let clock = T0;
    d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await (await d.tick()).settled;

    clock = T0 + 300_000;
    const after = await d.tick();

    assert.equal(rt.aborts.length, 0, "it ended on its own; there is nothing to abort");
    assert.deepEqual(after.aborted, []);
    assert.deepEqual(
      after.escalated,
      [],
      "the deadline brief is for an agent too wedged to write its own",
    );
    // An open incident always has an agent, so the ending is staffed again
    // rather than left: the escalation said the incident needs a person, and
    // that is not the same thing as it no longer needing an agent.
    assert.deepEqual(after.started.map((a) => a.incidentId), ["i1"]);
    assert.deepEqual(
      [...new Set(escalations.map((h) => h.brief))],
      ["the real brief"],
      "the agent's brief, never the dispatcher's placeholder",
    );
    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("does not add its own brief to a wedged agent that already wrote one", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    // The sequence, not the outcome. The test above has the run end after
    // escalating, so the deadline never fires on it and it passes whether or
    // not anything suppresses the second brief. The case that matters is the
    // one the abort exists for: an agent wedged badly enough that it uses its
    // grace to say what it knows and then still does not stop.
    let d: Dispatcher | null = null;
    const rt = fakeRuntime({
      onSubmit: async () => {
        await toolApiFor("i1").escalate({ reason: "out of time", brief: "the real brief" });
        d?.noteEscalated("i1");
      },
    });

    let clock = T0;
    d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await d.tick();
    await flush();
    // Past the soft deadline and the grace.
    clock = T0 + 300_000;
    const after = await d.tick();

    assert.equal(rt.aborts.length, 1, "it was too wedged to stop, so it is aborted");
    assert.deepEqual(after.aborted, ["i1"]);
    assert.deepEqual(
      after.escalated,
      [],
      "it already spoke for itself, so the dispatcher does not speak over it",
    );
    assert.deepEqual(
      [...new Set(escalations.map((h) => h.brief))],
      ["the real brief"],
      "one brief, the agent's",
    );
    // And nothing claims it stayed silent, which is the half that would be
    // worse than redundant: a placeholder posted under the agent's own brief
    // is the system contradicting itself in front of whoever reads the thread.
    assert.equal(
      escalations.some((h) => /did not say anything/.test(h.brief)),
      false,
    );

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("does not call its own deadline abort an agent failure, and staffs the incident again", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await d.tick();
    await flush();
    clock = T0 + 300_000;

    const events = await captureAlarms(async () => {
      await d.tick();
      await flush();
    });

    assert.ok(events.includes("agent_deadline_exceeded"), `${events}`);
    assert.equal(
      events.includes("agent_failed"),
      false,
      "the dispatcher aborted it on purpose and already said why",
    );
    // The same tick staffs the incident again, and that is the point of the
    // abort: an incident too wedged to finish still needs an agent on it, and
    // the escalation beside this one is what tells a person to look. Nothing
    // here takes the incident away from the agents.
    assert.deepEqual(d.list().map((a) => a.incidentId), ["i1"]);
    assert.equal(d.list()[0].startedAt, clock, "a fresh run, not the aborted one");

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("reports a run that ends without answering instead of calling it a clean run", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    const rt = fakeRuntime({ settle: () => "unanswered" });
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor }));
    const events = await captureAlarms(async () => {
      await (await d.tick()).settled;
    });

    assert.ok(events.includes("agent_failed"), `no agent_failed in ${events}`);
    cleanup();
  });

  it("stays quiet about a run that answered", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor }));
    const events = await captureAlarms(async () => {
      await (await d.tick()).settled;
    });

    assert.equal(events.includes("agent_failed"), false, `${events}`);
    cleanup();
  });

  // Turns are work done, so a budget spent before a launch stays spent, and
  // the first request of a launch rewrites the whole context into the cache:
  // incident 80 came back at 266 of 200 and spent $4.04 on one get_incident.
  it("does not launch an incident whose budget is already spent, and parks it on the budget", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { conversationId: 7, attempts: 4, turnsUsed: 300 });
    insertIncident(sqlite, "i2", { conversationId: 8, attempts: 4, turnsUsed: 299 });

    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, config: config({ agentMaxTurns: 300 }) }),
    );
    const first = await d.tick();
    await first.settled;

    assert.deepEqual(rt.launches().map((s) => s.incidentId), ["conversation 8"], "one turn left is a launch");
    assert.deepEqual(first.escalated, ["i1"]);
    assert.match(escalations[0].brief, /already spent/);
    assert.equal(/did not say|said nothing/.test(escalations[0].brief), false);
    const wait = db.get<{ waitingFor: string; liftsOnReply: number; wakeAt: number | null }>(
      "SELECT waitingFor, liftsOnReply, wakeAt FROM incident_wait WHERE incidentId = 'i1'",
    );
    assert.deepEqual(wait, {
      waitingFor: turnBudgetWaitingFor(300),
      liftsOnReply: 0,
      wakeAt: null,
    });

    await (await d.tick()).settled;
    assert.equal(rt.launches().filter((s) => s.conversationId === 7).length, 0, "and nothing relaunches it");
    assert.equal(escalations.length, 1);
    cleanup();
  });

  it("resumes an existing conversation and tells the agent how long it was gone", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      conversationId: 7,
      lastStartedAt: T0 - 600_000,
    });
    insertIncident(sqlite, "i2");

    const rt = fakeRuntime();
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor }));
    await d.tick();
    await flush();

    const resumed = rt.launches().find((s) => s.conversationId === 7);
    assert.ok(resumed, "resume, not restart");
    assert.equal(resumed.requestId, "incident:i1:launch:2");
    assert.match(resumed.content, /^resume reused/);
    assert.equal(resumedSeconds(resumed.content), 600);
    const fresh = rt.launches().find((s) => s.incidentId === "i2");
    assert.equal(resumedSeconds(fresh?.content ?? ""), null, "only a resumed agent is told");

    assert.equal(
      db.get<{ lastStartedAt: number }>(
        "SELECT lastStartedAt FROM incident WHERE id = 'i1'",
      )?.lastStartedAt,
      T0,
      "every launch records its own start for the next resume",
    );

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  // A deploy no longer relaunches anything: the harness resumes the run where
  // it stopped. The agent still has to re-check what moved while it was down,
  // so the first tick after boot steers it with the gap.
  it("steers a run the harness resumed at boot with how long it was gone", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    const rt = fakeRuntime();
    const first = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor, now: () => T0 }));
    await first.tick();
    await flush();
    const conversationId = rt.launches()[0].conversationId;

    const restarted = createDispatcher(
      deps({ db, runtime: rt.runtime, toolApiFor, now: () => T0 + 420_000 }),
    );
    const result = await restarted.tick();
    await restarted.tick();

    assert.deepEqual(result.started, [], "still running, so nothing is launched");
    assert.equal(rt.launches().length, 1);
    assert.deepEqual(
      rt.steers().map((s) => [s.conversationId, resumedSeconds(s.content), s.requestId]),
      [[conversationId, 420, `incident:i1:resumed:${T0 + 420_000}`]],
      "once, at boot",
    );
    assert.deepEqual(escalations, [], "a restart is not a crash loop");
    cleanup();
  });

  // The three real runs that were killed were resumed automatically and
  // nobody noticed. Operators learn from the alarm and the agent from the
  // resume text; the thread is not told, because the post asked nothing of
  // anyone and fired on every ordinary deploy.
  it("alarms and tells the agent, and posts nothing, when it resumes an agent gone a long time", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      conversationId: 7,
      lastStartedAt: T0 - (RESUME_ALARM_SECONDS + 60) * 1000,
    });

    const notices: string[] = [];
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        postNotice: async (_id, text) => {
          notices.push(text);
        },
      }),
    );
    let started: string[] = [];
    const alarms = await captureAlarms(async () => {
      started = (await d.tick()).started.map((a) => a.incidentId);
      await flush();
    });

    assert.deepEqual(started, ["i1"]);
    assert.deepEqual(notices, [], "nothing is posted to the thread");
    assert.ok(alarms.includes("agent_resumed_after_gap"));
    assert.equal(resumedSeconds(rt.launches()[0].content), RESUME_ALARM_SECONDS + 60);

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  // A restart puts every agent back within a tick or two, which is routine
  // and not worth an alarm.
  it("stays quiet for a resume quick enough to be a restart", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      conversationId: 7,
      lastStartedAt: T0 - 90_000,
    });

    const notices: string[] = [];
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        postNotice: async (_id, text) => {
          notices.push(text);
        },
      }),
    );
    const alarms = await captureAlarms(async () => {
      await d.tick();
      await flush();
    });

    assert.deepEqual(notices, []);
    assert.ok(!alarms.includes("agent_resumed_after_gap"));
    // The agent is still told, because it is the one that has to re-check.
    assert.equal(resumedSeconds(rt.launches()[0].content), 90);

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("skips resumed_after when the gap is shorter than a tick", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      attempts: 1,
      conversationId: 7,
      lastStartedAt: T0 - 5_000,
    });

    const rt = fakeRuntime();
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor }));
    await d.tick();
    await flush();

    assert.equal(resumedSeconds(rt.launches()[0].content), null);
    rt.finishAll();
    await d.drain();
    cleanup();
  });

  // Prod, 2026-09-30: a deploy restarted the container and incident 10's
  // thread was told its agent had been gone 4.5h and to disregard its last
  // message. The agent had asked the Boss a question three minutes earlier.
  // 4.5h was the time since launch, which is all the old clock read.
  describe("after a restart stops an agent that was working", () => {
    const LAUNCHED_AGO_MS = 16_200_000;
    const ACTIVE_AGO_MS = 180_000;

    const restartWith = async (inbox: boolean) => {
      const { db, sqlite, cleanup } = makeDb();
      const { toolApiFor } = makeTools();
      insertIncident(sqlite, "i1", {
        status: "INVESTIGATING",
        attempts: 1,
        conversationId: 7,
        lastStartedAt: T0 - LAUNCHED_AGO_MS,
      });
      if (inbox) {
        sqlite
          .prepare(
            "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES (?, 'question', ?, ?)",
          )
          .run("i1", "Is the 02:00 deploy yours?", T0 - ACTIVE_AGO_MS);
      }

      const notices: string[] = [];
      const rt = fakeRuntime();
      rt.hold(7, "i1");
      const d = createDispatcher(
        deps({
          db,
          runtime: rt.runtime,
          toolApiFor,
          config: config({ agentTimeoutSeconds: 86_400 }),
          postNotice: async (_id, text) => {
            notices.push(text);
          },
        }),
      );
      const alarms = await captureAlarms(async () => {
        await d.tick();
      });
      const gaps = rt.steers().map((s) => resumedSeconds(s.content));
      cleanup();
      return { notices, alarms, gaps };
    };

    it("with nothing else to read, launch is the clock, and that gap alarms", async () => {
      assert.ok(LAUNCHED_AGO_MS / 1000 >= RESUME_ALARM_SECONDS);
      const { notices, alarms, gaps } = await restartWith(false);
      assert.ok(alarms.includes("agent_resumed_after_gap"));
      assert.deepEqual(notices, []);
      assert.deepEqual(gaps, [LAUNCHED_AGO_MS / 1000]);
    });

    it("does not alarm and reports the real three minutes", async () => {
      const { notices, alarms, gaps } = await restartWith(true);
      assert.deepEqual(notices, []);
      assert.ok(!alarms.includes("agent_resumed_after_gap"));
      assert.deepEqual(gaps, [ACTIVE_AGO_MS / 1000]);
    });
  });

  it("alarms and tells the agent the true gap when the agent really was idle", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      conversationId: 7,
      lastStartedAt: T0 - 7_200_000,
    });
    sqlite
      .prepare(
        "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES (?, 'message', ?, ?)",
      )
      .run("i1", "PR is up", T0 - 3_900_000);
    // A reply is a person, not the agent, and must not read as activity.
    sqlite
      .prepare(
        "INSERT INTO thread_reply (id, incidentId, slackUserId, text, ts, receivedAt) VALUES ('r1', 'i1', 'U1', 'any news?', '1.0', ?)",
      )
      .run(T0 - 60_000);

    const notices: string[] = [];
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        postNotice: async (_id, text) => {
          notices.push(text);
        },
      }),
    );
    const alarms = await captureAlarms(async () => {
      await d.tick();
      await flush();
    });

    assert.deepEqual(notices, []);
    assert.ok(alarms.includes("agent_resumed_after_gap"));
    assert.equal(resumedSeconds(rt.launches()[0].content), 3900);

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  // A blocking wait writes nothing while it blocks. An agent an hour into a
  // question to the Boss, or a wait on a person, looks idle by every
  // timestamp, and a deploy stopping it is still just a deploy.
  describe("after a restart stops an agent inside a blocking wait", () => {
    const ASKED_AGO_MS = 3_000_000;

    const restartDuring = async (marker: "question" | "wait" | null) => {
      const { db, sqlite, cleanup } = makeDb();
      const { toolApiFor } = makeTools();
      insertIncident(sqlite, "i1", {
        attempts: 1,
        conversationId: 7,
        lastStartedAt: T0 - 16_200_000,
      });
      sqlite
        .prepare(
          "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES ('i1', 'question', 'Can I merge #12?', ?)",
        )
        .run(T0 - ASKED_AGO_MS);
      if (marker === "question") {
        sqlite
          .prepare(
            "INSERT INTO pending_question (incidentId, messageTs, askedAt, message) VALUES ('i1', '', ?, 'Can I merge #12?')",
          )
          .run(T0 - ASKED_AGO_MS);
      }
      if (marker === "wait") {
        sqlite
          .prepare(
            "INSERT INTO pending_wait (incidentId, command, startedAt, pings, lastPingAt) VALUES ('i1', 'gh pr view 12', ?, 0, NULL)",
          )
          .run(T0 - ASKED_AGO_MS);
      }

      // The process boots at T0 and its first tick runs a little later.
      let clock = T0;
      const notices: string[] = [];
      const rt = fakeRuntime();
      rt.hold(7, "i1");
      const d = createDispatcher(
        deps({
          db,
          runtime: rt.runtime,
          toolApiFor,
          config: config({ agentTimeoutSeconds: 86_400 }),
          now: () => clock,
          postNotice: async (_id, text) => {
            notices.push(text);
          },
        }),
      );
      clock = T0 + 45_000;
      const alarms = await captureAlarms(async () => {
        await d.tick();
      });
      const gaps = rt.steers().map((s) => resumedSeconds(s.content));
      cleanup();
      return { notices, alarms, gaps };
    };

    it("without an open marker, the last timestamp alone reads as an hour gone", async () => {
      const { notices, alarms } = await restartDuring(null);
      assert.ok(alarms.includes("agent_resumed_after_gap"));
      assert.deepEqual(notices, []);
    });

    it("an open question or wait means it was alive until the restart", async () => {
      for (const marker of ["question", "wait"] as const) {
        const { notices, alarms, gaps } = await restartDuring(marker);
        assert.deepEqual(notices, [], marker);
        assert.ok(!alarms.includes("agent_resumed_after_gap"), marker);
        assert.deepEqual(gaps, [45], marker);
      }
    });
  });
});

/**
 * The backstop. Every other watch in this process is reached by an incident
 * being runnable; the two that are not -- one parked on a person who never
 * came back, one whose agent stopped for a reason nothing recorded -- are
 * exactly the shapes that went quiet for a day and a half in production.
 */
describe("what the dispatcher's own briefs may claim", () => {
  it("never says the agent stayed silent, in any of them", () => {
    // Three briefs, one rule. Only the deadline one can be suppressed when
    // the agent has already spoken: `entry.escalated` lives on the run, and
    // the crash-loop and stalled paths fire after the run has left
    // `this.running`, so neither of them can know. A sentence asserting
    // something the code cannot check is the system contradicting itself in
    // the thread, directly under the agent's own brief.
    //
    // Read off the source because that is where the claim would reappear: a
    // fourth brief added later gets caught here rather than in production.
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    const offenders = (
      src.match(/"[^"\n]*(did not say|said nothing|never said|stayed silent)[^"\n]*"/g) ?? []
    ).filter((line) => !line.includes("//"));
    assert.deepEqual(
      offenders,
      [],
      "a dispatcher brief is claiming a silence it cannot verify",
    );
  });
});

describe("Dispatcher stale sweep", () => {
  const DAY = 86_400_000;

  const park = (sqlite: Database.Database, id: string, at: number) =>
    sqlite
      .prepare(
        `INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, startedAt)
         VALUES (?, 'a person', NULL, ?)`,
      )
      .run(id, at);

  // The same row a spent budget writes: a wait on a person that a reply
  // does not end, because what it is short of is turns rather than news. The
  // turns are spent too, or the raised-budget lift would take the wait away.
  const budgetPark = (sqlite: Database.Database, id: string, at: number) => {
    sqlite.prepare("UPDATE incident SET turnsUsed = 200 WHERE id = ?").run(id);
    sqlite
      .prepare(
        `INSERT INTO incident_wait
           (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES (?, ?, NULL, 0, ?)`,
      )
      .run(id, turnBudgetWaitingFor(200), at);
  };

  const waits = (db: DispatcherDb, id: string) =>
    db.query("SELECT incidentId FROM incident_wait WHERE incidentId = ?", [id])
      .length;

  const reply = (sqlite: Database.Database, id: string, at: number) =>
    sqlite
      .prepare(
        `INSERT INTO thread_reply (id, incidentId, slackUserId, text, ts, receivedAt)
         VALUES (?, ?, 'U-swain', 'any update?', ?, ?)`,
      )
      .run(`c:${id}:${at}`, id, String(at), at);

  const sweeps = (db: DispatcherDb, id: string) =>
    db.query(
      "SELECT id FROM incident_action WHERE incidentId = ? AND action = 'stale_swept'",
      [id],
    ).length;

  it("sweeps a quiet incident once, and not again on the next tick", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
    });
    // Parked, because the sweep only ever reaches an incident the dispatcher
    // cannot run: anything runnable was launched moments earlier in this same
    // tick and is therefore being addressed, not going unaddressed.
    park(sqlite, "i1", T0 - 2 * DAY);

    const posts: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        runtime: fakeRuntime({ settle: () => "done" }).runtime,
        toolApiFor,
        postNotice: async (_id, text) => {
          posts.push(text);
        },
      }),
    );

    const first = await d.tick();
    await first.settled;
    assert.deepEqual(first.swept, ["i1"]);
    assert.equal(posts.length, 1);
    assert.match(posts[0], /Nothing has happened on this incident for 48h/);

    // The marker it just wrote is itself activity, so the clock it reads has
    // moved. Nothing else suppresses this.
    const second = await d.tick();
    await second.settled;
    assert.deepEqual(second.swept, []);
    assert.equal(posts.length, 1);
    assert.equal(sweeps(db, "i1"), 1);
    cleanup();
  });

  it("un-parks the incident it sweeps, so the next tick runs it", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
    });
    // Parked with no wake time: only a reply or this sweep can lift it, which
    // is the shape that could otherwise wait forever.
    park(sqlite, "i1", T0 - 2 * DAY);

    const rt = fakeRuntime({ settle: () => "done" });
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        postNotice: async () => {},
      }),
    );

    const first = await d.tick();
    await first.settled;
    assert.deepEqual(first.started, [], "parked, so this tick leaves it alone");
    assert.deepEqual(first.swept, ["i1"]);
    assert.equal(
      db.query("SELECT incidentId FROM incident_wait WHERE incidentId = 'i1'")
        .length,
      0,
      "a wait nobody answered for a day stops being a reason to wait",
    );

    const second = await d.tick();
    await second.settled;
    assert.deepEqual(rt.launches().map((l) => l.incidentId), ["i1"]);
    cleanup();
  });

  it("counts a fresh park as activity, so the sweep cannot undo it immediately", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    // Quiet for two days and only just parked. Without the park in the
    // activity clock the two mechanisms fight: this is swept on the very next
    // tick, the wait is deleted, and the incident is relaunched straight back
    // into whatever the ceiling parked it for.
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
    });
    park(sqlite, "i1", T0);

    const posts: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        runtime: fakeRuntime({ settle: () => "done" }).runtime,
        toolApiFor,
        postNotice: async (_id, text) => {
          posts.push(text);
        },
      }),
    );

    const result = await d.tick();
    await result.settled;
    assert.deepEqual(result.swept, [], "deciding to wait is something happening");
    assert.equal(posts.length, 0);
    assert.equal(
      db.query("SELECT incidentId FROM incident_wait WHERE incidentId = 'i1'")
        .length,
      1,
      "the wait survives the tick that would otherwise have lifted it",
    );
    cleanup();
  });

  it("counts a reply as activity, so a live conversation is never stale", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      firstSignalAt: T0 - 4 * DAY,
      lastStartedAt: T0 - 3 * DAY,
    });
    park(sqlite, "i1", T0 - 3 * DAY);
    reply(sqlite, "i1", T0 - 3600_000);

    const posts: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        runtime: fakeRuntime({ settle: () => "done" }).runtime,
        toolApiFor,
        postNotice: async (_id, text) => {
          posts.push(text);
        },
      }),
    );

    const result = await d.tick();
    await result.settled;
    assert.deepEqual(result.swept, []);
    assert.equal(posts.length, 0);
    cleanup();
  });

  it("never sweeps an incident whose agent is still running", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    const rt = fakeRuntime();
    // A run may last a day, so a healthy agent's own launch timestamp ages
    // past the threshold under it. Only the harness can say otherwise.
    insertIncident(sqlite, "i1", {
      status: "INVESTIGATING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
      conversationId: 7,
      attempts: 1,
    });

    let clock = T0;
    const posts: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 3 * 86_400 }),
        now: () => clock,
        postNotice: async (_id, text) => {
          posts.push(text);
        },
      }),
    );

    await d.tick();
    clock = T0 + 60_000;
    const result = await d.tick();
    assert.deepEqual(result.swept, []);
    assert.deepEqual(
      posts.filter((t) => t.includes("Nothing has happened")),
      [],
    );

    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("does not re-post after a container restart", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
    });
    park(sqlite, "i1", T0 - 2 * DAY);

    let clock = T0;
    const posts: string[] = [];
    const build = () =>
      createDispatcher(
        deps({
          db,
          runtime: fakeRuntime({ settle: () => "done" }).runtime,
          toolApiFor,
          now: () => clock,
          postNotice: async (_id, text) => {
            posts.push(text);
          },
        }),
      );

    await (await build().tick()).settled;
    assert.equal(posts.length, 1);

    // Every merge to ops main restarts this container. A sweep counted from
    // process start would make each deploy a notification.
    clock = T0 + 60_000;
    const after = await build().tick();
    await after.settled;
    assert.deepEqual(after.swept, []);
    assert.equal(posts.length, 1);
    cleanup();
  });

  it("does not sweep again an hour after something parks it back", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
    });
    park(sqlite, "i1", T0 - 2 * DAY);

    let clock = T0;
    const posts: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        runtime: fakeRuntime({ settle: () => "done" }).runtime,
        toolApiFor,
        now: () => clock,
        postNotice: async (_id, text) => {
          posts.push(text);
        },
      }),
    );

    await (await d.tick()).settled;
    assert.equal(posts.length, 1);

    // The agent it woke parks straight back. Nothing about that earns a
    // second notification inside the threshold.
    park(sqlite, "i1", clock);
    clock = T0 + 3600_000;
    const after = await d.tick();
    await after.settled;
    assert.deepEqual(after.swept, []);
    assert.equal(posts.length, 1);
    cleanup();
  });

  it("is off at a threshold of zero rather than sweeping everything", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", { status: "FIXING", firstSignalAt: T0 - 5 * DAY });
    insertIncident(sqlite, "i2", {
      status: "INVESTIGATING",
      firstSignalAt: T0 - 5 * DAY,
    });

    const posts: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        runtime: fakeRuntime({ settle: () => "done" }).runtime,
        toolApiFor,
        config: config({ staleAfterSeconds: 0 }),
        postNotice: async (_id, text) => {
          posts.push(text);
        },
      }),
    );

    const result = await d.tick();
    await result.settled;
    assert.deepEqual(result.swept, []);
    assert.equal(posts.length, 0);
    cleanup();
  });

  it("never touches a closed or merged incident", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", { status: "FIXING", firstSignalAt: T0 - 5 * DAY });
    park(sqlite, "i1", T0 - 5 * DAY);
    insertIncident(sqlite, "i2", {
      status: "CLOSED",
      firstSignalAt: T0 - 5 * DAY,
    });
    insertIncident(sqlite, "i3", {
      status: "MERGED",
      mergedInto: "i1",
      firstSignalAt: T0 - 5 * DAY,
    });

    const d = createDispatcher(
      deps({ db, runtime: fakeRuntime({ settle: () => "done" }).runtime, toolApiFor, postNotice: async () => {} }),
    );
    const result = await d.tick();
    await result.settled;
    assert.deepEqual(result.swept, ["i1"]);
    cleanup();
  });

  it("un-parks and says nobody was told when no poster is wired in", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
    });
    park(sqlite, "i1", T0 - 2 * DAY);

    const d = createDispatcher(deps({ db, runtime: fakeRuntime({ settle: () => "done" }).runtime, toolApiFor }));
    const events = await captureAlarms(async () => {
      const result = await d.tick();
      await result.settled;
      // The un-park still happens. It is the half that recovers the incident
      // and it does not depend on anyone reading a thread.
      assert.deepEqual(result.swept, ["i1"]);
    });

    assert.ok(events.includes("incident_stale"), `${events}`);
    assert.ok(events.includes("stale_notice_undeliverable"), `${events}`);
    assert.equal(
      db.query("SELECT incidentId FROM incident_wait WHERE incidentId = 'i1'")
        .length,
      0,
    );
    cleanup();
  });

  it("lifts the wait on a person and leaves the spent budget waiting", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    // Two incidents, equally quiet, one tick. The only difference between
    // them is `liftsOnReply`, so a sweep that reads it sends them different
    // ways and a sweep that does not sends them both the same way. Asserting
    // the pair rather than the budget one alone is what makes this fail if
    // the sweep is simply switched off for everything.
    for (const id of ["i1", "i2"]) {
      insertIncident(sqlite, id, {
        status: "FIXING",
        firstSignalAt: T0 - 3 * DAY,
        lastStartedAt: T0 - 2 * DAY,
      });
    }
    park(sqlite, "i1", T0 - 2 * DAY);
    budgetPark(sqlite, "i2", T0 - 2 * DAY);

    const rt = fakeRuntime({ settle: () => "done" });
    const posts: Array<[string, string]> = [];
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        postNotice: async (id, text) => {
          posts.push([id, text]);
        },
      }),
    );

    const first = await d.tick();
    await first.settled;

    // Both are announced. Being out of budget for a day is not a reason for
    // nobody to hear about it; it is a reason not to relaunch it.
    assert.deepEqual(first.swept.sort(), ["i1", "i2"]);
    assert.equal(posts.length, 2);
    assert.equal(waits(db, "i1"), 0, "nobody came back, so it stops waiting");
    assert.equal(
      waits(db, "i2"),
      1,
      "a day passing adds no turns, so the budget wait still stands",
    );

    const [, heldText] = posts.find(([id]) => id === "i2") ?? ["", ""];
    assert.match(heldText, /turn budget for this incident is spent/);
    assert.equal(heldText.includes("no longer waiting"), false, heldText);

    // The half that matters: the next tick runs the one that was waiting on a
    // person and does not touch the one that is out of turns. Relaunching i2
    // would exhaust it before its first turn, escalate, and page -- every
    // day, which is the loop `liftsOnReply` was added to end.
    const second = await d.tick();
    await second.settled;
    assert.deepEqual(rt.launches().map((l) => l.incidentId), ["i1"]);
    cleanup();
  });

  it("does not relaunch a spent budget on any later tick either", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
    });
    budgetPark(sqlite, "i1", T0 - 2 * DAY);

    const rt = fakeRuntime({ settle: () => "done" });
    const posts: string[] = [];
    let clock = T0;
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        postNotice: async (_id, text) => {
          posts.push(text);
        },
        now: () => clock,
      }),
    );

    // Three days of ticks a day apart. The marker the sweep writes is itself
    // activity, so it says this once a day rather than once a tick -- and
    // each of those days would have been a relaunch, a re-exhaustion and a
    // page under a sweep that deleted the row.
    for (let day = 0; day < 3; day += 1) {
      const result = await d.tick();
      await result.settled;
      clock += DAY;
    }

    assert.deepEqual(rt.launches(), [], "nothing ever relaunched it");
    assert.equal(waits(db, "i1"), 1, "the wait outlived every sweep");
    assert.equal(sweeps(db, "i1"), 3, "and was still said out loud each day");
    assert.equal(posts.length, 3);
    cleanup();
  });
});

describe("staleNotice", () => {
  it("leads with how long it has been quiet", () => {
    assert.match(staleNotice(26 * 3600, "quiet"), /for 26h\./);
    assert.match(staleNotice(45 * 60, "quiet"), /for 45m\./);
  });

  it("only claims to have un-parked when it did", () => {
    assert.match(staleNotice(86_400, "unparked"), /no longer waiting/);
    assert.equal(
      staleNotice(86_400, "quiet").includes("no longer waiting"),
      false,
    );
    assert.equal(
      staleNotice(86_400, "held").includes("no longer waiting"),
      false,
    );
  });

  it("tells a held incident what actually moves it, and does not ask for a reply", () => {
    const held = staleNotice(86_400, "held");
    assert.match(held, /still waiting/);
    assert.match(held, /turn budget for this incident is spent/);
    assert.match(held, /Raising the turn budget, which resumes it on the next deploy/);
    // The agent's closing brief already said replying will not restart it.
    // A nudge inviting one a day later would make that brief a lie.
    assert.equal(/\breply\b|\breplying\b/i.test(held), false, held);
  });
});

describe("Dispatcher workspace sweep", () => {
  const workspace = (root: string, id: string) => {
    mkdirSync(join(root, id, "omni"), { recursive: true });
    writeFileSync(join(root, id, "omni", "uncommitted.ts"), "work in progress");
  };

  const trashEmptied = async (root: string) => {
    for (let i = 0; i < 100 && existsSync(join(root, ".trash")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !existsSync(join(root, ".trash"));
  };

  it("deletes a workspace once its incident is closed or merged, and keeps every other", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    const root = mkdtempSync(join(tmpdir(), "bugboss-work-"));
    insertIncident(sqlite, "i1", { status: "FIXING" });
    insertIncident(sqlite, "i2", { status: "RESOLVED" });
    insertIncident(sqlite, "i4", { status: "CLOSED" });
    insertIncident(sqlite, "i5", { status: "MERGED", mergedInto: "i1" });
    for (const id of ["i1", "i2", "i4", "i5", "no-such-incident"]) workspace(root, id);

    const rt = fakeRuntime();
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor, workRoot: root }));
    await d.tick();

    assert.ok(existsSync(join(root, "i1", "omni", "uncommitted.ts")));
    assert.ok(existsSync(join(root, "i2", "omni", "uncommitted.ts")));
    assert.ok(!existsSync(join(root, "i4")), "a closed incident's workspace is deleted");
    assert.ok(!existsSync(join(root, "i5")), "a merged incident's workspace is deleted");
    // No row is not evidence the incident is over: a database restored short
    // would otherwise take every live workspace with it.
    assert.ok(existsSync(join(root, "no-such-incident")));
    assert.ok(await trashEmptied(root), "the deleted trees are removed from disk, not just moved");

    rt.finishAll();
    await d.drain();
    rmSync(root, { recursive: true, force: true });
    cleanup();
  });

  it("keeps a closed incident's workspace until its agent has exited", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    const root = mkdtempSync(join(tmpdir(), "bugboss-work-"));
    insertIncident(sqlite, "i1", { status: "RESOLVED" });
    workspace(root, "i1");

    const rt = fakeRuntime();
    const d = createDispatcher(deps({ db, runtime: rt.runtime, toolApiFor, workRoot: root }));
    await d.tick();
    await flush();
    sqlite
      .prepare("UPDATE incident SET status = 'CLOSED', closedAt = ?, postmortem = 'pm' WHERE id = 'i1'")
      .run(T0);
    await d.tick();
    assert.ok(existsSync(join(root, "i1", "omni", "uncommitted.ts")), "its agent is still writing to it");

    rt.finishAll();
    await d.drain();
    await d.tick();
    assert.ok(!existsSync(join(root, "i1")));
    assert.ok(await trashEmptied(root));

    rmSync(root, { recursive: true, force: true });
    cleanup();
  });
});

describe("Dispatcher raised turn budget", () => {
  const budgetWait = (sqlite: Database.Database, id: string, max: number) =>
    sqlite
      .prepare(
        `INSERT INTO incident_wait
           (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES (?, ?, NULL, 0, ?)`,
      )
      .run(id, turnBudgetWaitingFor(max), T0 - 1000);

  const waits = (db: DispatcherDb, id: string) =>
    db.query("SELECT incidentId FROM incident_wait WHERE incidentId = ?", [id]).length;

  const setup = () => {
    const made = makeDb();
    const { toolApiFor } = makeTools();
    const rt = fakeRuntime({ settle: () => "done" });
    const posts: { incidentId: string; text: string }[] = [];
    const d = createDispatcher(
      deps({
        db: made.db,
        config: config({ agentMaxTurns: 300 }),
        runtime: rt.runtime,
        toolApiFor,
        postNotice: async (incidentId, text) => {
          posts.push({ incidentId, text });
        },
      }),
    );
    const launched = () => rt.launches().map((l) => l.incidentId);
    return { ...made, d, launched, posts };
  };

  it("lifts a wait parked on a 200 budget once the max is 300, and says so once", async () => {
    const { db, sqlite, cleanup, d, launched, posts } = setup();
    insertIncident(sqlite, "i1", { status: "FIXING", turnsUsed: 200 });
    budgetWait(sqlite, "i1", 200);

    await (await d.tick()).settled;
    await (await d.tick()).settled;

    assert.equal(waits(db, "i1"), 0);
    assert.ok(launched().includes("i1"), "the incident is runnable again");
    assert.deepEqual(posts, [
      {
        incidentId: "i1",
        text: "The turn budget was raised to 300, so the agent is resuming with 100 turns left.",
      },
    ]);
    assert.equal(
      db.query(
        "SELECT id FROM incident_action WHERE incidentId = 'i1' AND action = 'turn_budget_raised'",
      ).length,
      1,
    );
    cleanup();
  });

  it("records the lift before posting, so a failed post loses nothing", async () => {
    const made = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(made.sqlite, "i1", { status: "FIXING", turnsUsed: 270 });
    budgetWait(made.sqlite, "i1", 200);
    let waitAtPost = -1;
    const d = createDispatcher(
      deps({
        db: made.db,
        config: config({ agentMaxTurns: 300 }),
        runtime: fakeRuntime({ settle: () => "done" }).runtime,
        toolApiFor,
        postNotice: async () => {
          waitAtPost = waits(made.db, "i1");
          throw new Error("slack down");
        },
      }),
    );

    const alarms = await captureAlarms(async () => {
      await (await d.tick()).settled;
    });

    assert.equal(waitAtPost, 0, "the wait was gone before the post was attempted");
    assert.ok(alarms.includes("budget_notice_failed"));
    made.cleanup();
  });

  it("holds a spent wait whose used turns still reach the max", async () => {
    const { db, sqlite, cleanup, d, launched, posts } = setup();
    insertIncident(sqlite, "i1", { status: "FIXING", turnsUsed: 300 });
    // A launch can overrun the budget it parked on: incident 80 sat at 270
    // of 200, which the wait's text alone would have read as 200.
    insertIncident(sqlite, "i2", { status: "INVESTIGATING", turnsUsed: 320 });
    budgetWait(sqlite, "i1", 300);
    budgetWait(sqlite, "i2", 200);

    await (await d.tick()).settled;

    assert.equal(waits(db, "i1"), 1);
    assert.equal(waits(db, "i2"), 1);
    assert.deepEqual(launched(), []);
    assert.deepEqual(posts, []);
    cleanup();
  });

  it("resumes a spent incident on the tick after a grant, and says so once", async () => {
    const { db, sqlite, cleanup, d, launched, posts } = setup();
    insertIncident(sqlite, "i1", { status: "FIXING", turnsUsed: 300 });
    budgetWait(sqlite, "i1", 300);

    await (await d.tick()).settled;
    assert.deepEqual(launched(), [], "premise: spent at 300 of 300, it is held");

    // What the Boss's grant_turns writes. The dispatcher reads nothing else.
    sqlite.prepare("UPDATE incident SET grantedTurns = grantedTurns + 50 WHERE id = 'i1'").run();

    await (await d.tick()).settled;
    await (await d.tick()).settled;

    assert.equal(waits(db, "i1"), 0);
    assert.ok(launched().includes("i1"), "budget plus grant is over what it used");
    assert.deepEqual(
      posts.map((p) => p.text),
      ["Granted more turns; the agent is resuming with 50 left of 350."],
    );
    cleanup();
  });

  it("leaves closed incidents and waits on anything else alone", async () => {
    const { db, sqlite, cleanup, d, launched, posts } = setup();
    insertIncident(sqlite, "i1", { status: "CLOSED", turnsUsed: 200 });
    insertIncident(sqlite, "i2", { status: "FIXING", turnsUsed: 10 });
    budgetWait(sqlite, "i1", 200);
    sqlite
      .prepare(
        `INSERT INTO incident_wait (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES ('i2', 'a person to approve the PR', NULL, 0, ?)`,
      )
      .run(T0 - 1000);

    await (await d.tick()).settled;

    assert.equal(waits(db, "i1"), 1);
    assert.equal(waits(db, "i2"), 1);
    assert.deepEqual(launched(), []);
    assert.deepEqual(posts, []);
    cleanup();
  });
});

describe("Dispatcher escalations while writes fail", () => {
  // Reads work and every write throws, which is what a halted Db does.
  const refusing = (db: DispatcherDb, failing: () => boolean): DispatcherDb => ({
    query: (sql, params) => db.query(sql, params),
    get: (sql, params) => db.get(sql, params),
    withWrite: (fn) =>
      failing()
        ? Promise.reject(
            Object.assign(new Error("writes halted: RequestTimeTooSkewed"), { writesHalted: true }),
          )
        : db.withWrite(fn),
  });

  // Incident 93 on 2026-10-01. Every launch write failed, so every launch
  // was a fast failure, so every third tick met the crash-loop ceiling and
  // posted, and the park after the post failed, so nothing stopped the next
  // round. Two minutes apart, for five hours.
  it("replays the incident 93 storm and posts nothing", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "93");

    const rt = fakeRuntime({ settle: () => "unanswered" });
    const d = createDispatcher(
      deps({
        db: refusing(db, () => true),
        runtime: rt.runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
      }),
    );

    await captureAlarms(async () => {
      for (let tick = 0; tick < 40; tick += 1) {
        await d.tick().then((r) => r.settled).catch(() => undefined);
      }
    });

    assert.equal(rt.launches().length, 0, "the launch write fails first");
    assert.equal(escalations.length, 0, "a park that cannot be written posts nothing");
    cleanup();
  });

  it("keeps its count when the park fails, so the escalation goes out once writes return", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let halted = false;
    const rt = fakeRuntime({ settle: () => "unanswered" });
    const d = createDispatcher(
      deps({
        db: refusing(db, () => halted),
        runtime: rt.runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
      }),
    );

    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    halted = true;
    await captureAlarms(async () => {
      await d.tick().then((r) => r.settled).catch(() => undefined);
    });
    halted = false;
    const recovered = await d.tick();

    assert.equal(rt.launches().length, 3, "no relaunch spent rebuilding a count it already had");
    assert.deepEqual(recovered.escalated, ["i1"]);
    assert.equal(escalations.length, 1);
    cleanup();
  });

  it("parks before it posts a crash loop", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { escalations } = makeTools();
    insertIncident(sqlite, "i1");

    const parkedAtPost: boolean[] = [];
    const toolApiFor = (incidentId: string): ToolApi => ({
      ...makeTools().toolApiFor(incidentId),
      escalate: async ({ reason, brief }) => {
        parkedAtPost.push(
          db.get("SELECT 1 FROM incident_wait WHERE incidentId = ?", [incidentId]) !== undefined,
        );
        escalations.push({ incidentId, reason, brief });
        return { ok: true };
      },
    });

    const d = createDispatcher(
      deps({
        db,
        runtime: fakeRuntime({ settle: () => "unanswered" }).runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
      }),
    );
    for (let i = 0; i < 4; i += 1) await (await d.tick()).settled;

    assert.deepEqual(parkedAtPost, [true], "the park was committed when the post went out");
    cleanup();
  });

  it("parks before it posts a launch ceiling, and takes the park back when the post fails", async () => {
    const { db, sqlite, cleanup } = makeDb();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const parkedAtPost: boolean[] = [];
    const toolApiFor = (incidentId: string): ToolApi => ({
      ...makeTools().toolApiFor(incidentId),
      escalate: async () => {
        parkedAtPost.push(
          db.get("SELECT 1 FROM incident_wait WHERE incidentId = ?", [incidentId]) !== undefined,
        );
        // What the tool API answers when its post fails: a refusal, not a throw.
        return { ok: false, error: "could not post the escalation" };
      },
    });

    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db,
        runtime: rt.runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        fastFailureSeconds: 60,
        maxLaunches: 3,
        now: () => clock,
      }),
    );

    const alarms = await captureAlarms(async () => {
      for (let i = 0; i < 3; i += 1) {
        const result = await d.tick();
        clock += 61_000;
        await flush();
        rt.finishAll("unanswered");
        await result.settled;
      }
      await d.tick();
    });

    assert.deepEqual(parkedAtPost, [true]);
    assert.equal(
      db.get("SELECT 1 FROM incident_wait WHERE incidentId = 'i1'"),
      undefined,
      "nobody was told, so it relaunches rather than sitting parked",
    );
    assert.ok(alarms.includes("stalled_escalation_failed"));
    rt.finishAll();
    await d.drain();
    cleanup();
  });

  it("keeps its count when the post fails and the park cannot be taken back", async () => {
    const { db, sqlite, cleanup } = makeDb();
    insertIncident(sqlite, "i1");

    let halted = false;
    let posts = 0;
    let refuse = true;
    const toolApiFor = (incidentId: string): ToolApi => ({
      ...makeTools().toolApiFor(incidentId),
      escalate: async () => {
        posts += 1;
        if (refuse) {
          // The post fails, and so does every write after the park.
          halted = true;
          return { ok: false, error: "could not post the escalation" };
        }
        return { ok: true };
      },
    });
    const d = createDispatcher(
      deps({
        db: refusing(db, () => halted),
        runtime: fakeRuntime({ settle: () => "unanswered" }).runtime,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        parkCooldownSeconds: 60,
      }),
    );

    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    await captureAlarms(async () => {
      await d.tick().then((r) => r.settled);
    });
    assert.equal(posts, 1);
    assert.ok(db.get("SELECT 1 FROM incident_wait WHERE incidentId = 'i1'"), "stuck parked");

    halted = false;
    refuse = false;
    sqlite.prepare("DELETE FROM incident_wait WHERE incidentId = 'i1'").run();
    const lifted = await d.tick();

    assert.deepEqual(lifted.escalated, ["i1"], "the ceiling is still met, so it is said once the park lifts");
    cleanup();
  });

  it("does not post a deadline escalation while writes fail", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    let halted = false;
    const rt = fakeRuntime();
    const d = createDispatcher(
      deps({
        db: refusing(db, () => halted),
        runtime: rt.runtime,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await d.tick();
    await flush();
    halted = true;
    clock = T0 + 60_000 + (DEADLINE_GRACE_SECONDS + 1) * 1000;
    const alarms = await captureAlarms(async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        await d.tick().catch(() => undefined);
        clock += 30_000;
      }
    });

    assert.equal(rt.aborts.length, 1, "the abort writes nothing, so it still happens");
    assert.equal(escalations.length, 0);
    assert.ok(alarms.includes("deadline_escalation_unrecorded"));

    // Owed, not dropped: the first tick a write lands posts it, once.
    halted = false;
    await d.tick();
    await d.tick();
    assert.equal(escalations.length, 1);
    assert.match(escalations[0].reason, /deadline/);
    rt.finishAll();
    await d.drain();
    cleanup();
  });
});

describe("the dispatcher's imports", () => {
  it("reach Pi only through the AgentRuntime seam", () => {
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    assert.equal(/from "@earendil-works\//.test(src), false, "no Pi package import");
    assert.equal(
      /^import \{[^}]*\} from "\.\.\/agent\/harness"/m.test(src),
      false,
      "types only from the harness module, so nothing of Pi loads with the dispatcher",
    );
  });
});
