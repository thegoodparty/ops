import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";

import Database from "better-sqlite3";

import { DEADLINE_GRACE_SECONDS } from "../agent/run";
import type { DispatcherConfig, ToolApi } from "../types";
import {
  RESUME_ALARM_SECONDS,
  createDispatcher,
  staleNotice,
  type DispatcherDb,
  type DispatcherDeps,
} from "./index";
import { createChildProcessSpawn, type AgentSpawnContext, type SpawnAgent } from "./spawn";

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
  sessionRef?: string | null;
  firstSignalAt?: number;
  lastStartedAt?: number | null;
}

const insertIncident = (
  sqlite: Database.Database,
  id: string,
  over: IncidentOverrides = {},
) =>
  sqlite
    .prepare(
      `INSERT INTO incident
         (id, status, firstSignalAt, attempts, sessionRef, lastStartedAt,
          resolvedAt, closedAt, postmortem, mergedInto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.status ?? "INVESTIGATING",
      over.firstSignalAt ?? T0,
      over.attempts ?? 0,
      over.sessionRef ?? null,
      over.lastStartedAt ?? null,
      // Terminal statuses carry the fields that define them. The schema
      // enforces it now, so a fixture cannot build a CLOSED incident with no
      // post-mortem, which is a state no code path can reach.
      over.status === "RESOLVED" || over.status === "CLOSED" ? T0 : null,
      over.status === "CLOSED" ? T0 : null,
      over.status === "CLOSED" ? "fixture post-mortem" : null,
      over.mergedInto ?? null,
    );

const ok = async () => ({ ok: true, directives: [] });

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
      return { ok: true, directives: [] };
    },
    park: ok,
  });
  return { toolApiFor, escalations };
};

/** Spawns that never finish until released, so "live" means something. */
const heldSpawn = () => {
  const contexts: AgentSpawnContext[] = [];
  const releases: (() => void)[] = [];
  const spawn: SpawnAgent = (ctx) => {
    contexts.push(ctx);
    return new Promise<void>((resolve) => releases.push(resolve));
  };
  return { spawn, contexts, releaseAll: () => releases.forEach((r) => r()) };
};

const deps = (
  over: Partial<DispatcherDeps> & Pick<DispatcherDeps, "db" | "spawn" | "toolApiFor">,
): DispatcherDeps => ({
  config: config(),
  mintToken: (id) => `tok-${id}`,
  // What Fargate gives the parent, and so what a launch is expected to hand
  // down. Without it every launch alarms that the child cannot reach AWS.
  childBaseEnv: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds" },
  now: () => T0,
  ...over,
});

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

    const spawned: string[] = [];
    const spawn: SpawnAgent = async (ctx) => {
      spawned.push(ctx.incidentId);
    };

    const d = createDispatcher(deps({ db, spawn, toolApiFor }));
    const result = await d.tick();
    await result.settled;

    assert.deepEqual(spawned.sort(), ["i1", "i2", "i3"]);
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

  it("resumes and escalates a RESOLVED incident, because the post-mortem is the agent's", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    // The container restarted while the agent was drafting the post-mortem.
    insertIncident(sqlite, "i1", {
      status: "RESOLVED",
      attempts: 1,
      sessionRef: "s-1",
      lastStartedAt: T0 - 600_000,
    });

    let clock = T0;
    let kills = 0;
    const releases: (() => void)[] = [];
    const contexts: AgentSpawnContext[] = [];
    const spawn: SpawnAgent = (ctx) => {
      contexts.push(ctx);
      ctx.register({ pid: 91, kill: () => { kills += 1; } });
      return new Promise<void>((resolve) => releases.push(resolve));
    };

    const d = createDispatcher(
      deps({ db, spawn, toolApiFor, config: config({ agentTimeoutSeconds: 60 }), now: () => clock }),
    );

    const first = await d.tick();
    assert.deepEqual(first.started.map((a) => a.incidentId), ["i1"]);
    assert.equal(contexts[0].sessionRef, "s-1", "resume the post-mortem, not restart it");
    assert.deepEqual(d.list().map((a) => a.phase), ["RESOLVED"]);

    // And if it wedges there, RESOLVED must still be said out loud rather
    // than going quiet: the post-mortem is the last thing anyone is waiting
    // for, and nothing else in the system would ever mention it again.
    clock = T0 + 60_000 + 211_000;
    const second = await d.tick();
    assert.equal(kills, 1);
    assert.deepEqual(second.killed, ["i1"]);
    assert.deepEqual(second.escalated, ["i1"]);
    assert.equal(escalations.length, 1);

    releases.forEach((r) => r());
    await d.drain();
    cleanup();
  });

  it("does not start a second agent for an incident that already has one", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    const held = heldSpawn();
    const d = createDispatcher(deps({ db, spawn: held.spawn, toolApiFor }));

    await d.tick();
    const second = await d.tick();

    assert.equal(held.contexts.length, 1, "one live agent, one launch");
    assert.deepEqual(second.started, []);
    assert.deepEqual(d.list().map((a) => a.incidentId), ["i1"]);
    assert.equal(
      db.get<{ attempts: number }>("SELECT attempts FROM incident WHERE id = 'i1'")
        ?.attempts,
      1,
    );

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("stops dispatching at the concurrency ceiling and says so", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    for (const id of ["i1", "i2", "i3", "i4", "i5"]) insertIncident(sqlite, id);

    const held = heldSpawn();
    const d = createDispatcher(
      deps({ db, spawn: held.spawn, toolApiFor, config: config({ maxConcurrentAgents: 2 }) }),
    );

    const first = await d.tick();
    assert.equal(first.started.length, 2);
    assert.equal(first.circuitOpen, true);
    assert.equal(held.contexts.length, 2);

    // No queue: the ceiling refuses, it does not defer. A second tick while
    // the slots are still full launches nothing.
    const second = await d.tick();
    assert.equal(second.started.length, 0);
    assert.equal(second.circuitOpen, true);
    assert.equal(held.contexts.length, 2);

    held.releaseAll();
    await d.drain();

    const third = await d.tick();
    assert.equal(third.started.length, 2, "slots freed, the next tick fills them");
    assert.equal(third.circuitOpen, true);

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("escalates a crash loop instead of relaunching forever", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let launches = 0;
    // Dies the instant it starts, and dies badly: run.ts exits non-zero and
    // the spawn wrapper turns that into a rejection. Both halves matter now
    // -- a short exit that succeeded is a deploy draining an agent, not a
    // crash, and counting it walked a rolling deploy to this escalation.
    const spawn: SpawnAgent = async () => {
      launches += 1;
      throw new Error("agent exited 1");
    };

    const d = createDispatcher(
      deps({ db, spawn, toolApiFor, config: config({ maxAttempts: 3 }) }),
    );

    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    assert.equal(launches, 3);
    assert.equal(escalations.length, 0, "the limit is a ceiling, not a trigger");

    const fourth = await d.tick();
    assert.equal(launches, 3, "no relaunch past three consecutive fast deaths");
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
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let launches = 0;
    const spawn: SpawnAgent = async () => {
      launches += 1;
      throw new Error("agent exited 1");
    };

    const d = createDispatcher(
      deps({ db, spawn, toolApiFor, config: config({ maxAttempts: 3 }) }),
    );

    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    assert.deepEqual((await d.tick()).escalated, ["i1"]);

    // Twenty more ticks is ten minutes of the incident sitting open, which is
    // the shape of the bug: a condition re-decided every tick posts the same
    // brief until somebody closes the incident.
    for (let i = 0; i < 20; i += 1) await (await d.tick()).settled;

    assert.equal(launches, 3, "no relaunch after the dispatcher gave up");
    assert.equal(escalations.length, 1, "and no second copy of the brief");
    // The incident is untouched and still open: giving up on relaunching it
    // is not a transition, and the status is the only thing eligibility reads.
    assert.equal(
      db.get<{ status: string }>("SELECT status FROM incident WHERE id = 'i1'")?.status,
      "INVESTIGATING",
    );
    cleanup();
  });

  // The rolling-deploy case. Before SIGTERM exited zero and the counter
  // required a failure, three bounces of a freshly-launched agent handed a
  // human a crash-loop brief for a deploy that worked.
  it("does not count a short clean exit as a crash", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let launches = 0;
    const spawn: SpawnAgent = async () => {
      launches += 1;
    };

    const d = createDispatcher(
      deps({ db, spawn, toolApiFor, config: config({ maxAttempts: 3 }) }),
    );

    for (let i = 0; i < 5; i += 1) await (await d.tick()).settled;

    assert.equal(launches, 5, "it keeps relaunching rather than giving up");
    assert.deepEqual(escalations, [], "and nobody is handed a crash-loop brief");
    cleanup();
  });

  it("falls back to relaunching when the crash-loop escalation fails", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let launches = 0;
    const spawn: SpawnAgent = async () => {
      launches += 1;
      throw new Error("agent exited 1");
    };

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
        spawn,
        toolApiFor: failingToolApiFor,
        config: config({ maxAttempts: 3 }),
      }),
    );

    for (let i = 0; i < 3; i += 1) await (await d.tick()).settled;
    assert.equal(launches, 3);

    const failed = await d.tick();
    assert.deepEqual(failed.escalated, [], "the escalation threw, so nobody was told");
    assert.equal(launches, 3, "this tick spends itself on the escalation");

    // An untold escalation must not stop the relaunching, because nothing
    // else is coming: the counter stayed at the ceiling before, so every
    // later tick retried the same failing call and the incident never moved.
    await (await d.tick()).settled;
    assert.equal(launches, 4, "a failed escalation falls back to relaunching");

    escalationFails = false;
    for (let i = 0; i < 2; i += 1) await (await d.tick()).settled;
    const recovered = await d.tick();
    assert.deepEqual(recovered.escalated, ["i1"], "and it can still escalate later");
    assert.equal(escalations.length, 1);

    // Only the escalation that landed ends the relaunching. Up to here every
    // failure fell back, which is why the fallback cannot be permanent.
    for (let i = 0; i < 5; i += 1) await (await d.tick()).settled;
    assert.equal(launches, 6);
    assert.equal(escalations.length, 1);
    cleanup();
  });

  it("escalates an agent that dies just past the fast-failure window", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let clock = T0;
    let launches = 0;
    const releases: (() => void)[] = [];
    const spawn: SpawnAgent = () => {
      launches += 1;
      return new Promise<void>((resolve) => releases.push(resolve));
    };

    const d = createDispatcher(
      deps({
        db,
        spawn,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        fastFailureSeconds: 60,
        maxLaunches: 3,
        now: () => clock,
      }),
    );

    // Bedrock throttling, an OOM, credentials expiring: dies at 61s every
    // time, which clears the consecutive-fast counter on every exit, so
    // nothing bounded this. It relaunched every tick for as long as the
    // incident stayed open.
    const die = async () => {
      await d.tick();
      clock += 61_000;
      releases.forEach((r) => r());
      await d.drain();
    };

    for (let i = 0; i < 3; i += 1) await die();
    assert.equal(launches, 3);
    assert.equal(escalations.length, 0, "the limit is a ceiling, not a trigger");

    const fourth = await d.tick();
    assert.equal(launches, 3, "no relaunch past the launch ceiling");
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
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let clock = T0;
    let launches = 0;
    const releases: (() => void)[] = [];
    const spawn: SpawnAgent = () => {
      launches += 1;
      return new Promise<void>((resolve) => releases.push(resolve));
    };
    const build = () =>
      createDispatcher(
        deps({
          db,
          spawn,
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
      await d.tick();
      clock += 61_000;
      releases.forEach((r) => r());
      await d.drain();
    }
    assert.deepEqual((await d.tick()).escalated, ["i1"]);
    assert.equal(launches, 2);
    assert.deepEqual((await d.tick()).started, [], "this container is done with it");
    assert.equal(escalations.length, 1, "said once, not once a tick");

    // A new container, same database. The stop is a row now rather than a
    // Set, so a restart does not undo it -- which is the point. A crash loop
    // that a deploy could clear is a crash loop that a deploy would relaunch
    // straight into.
    const restarted = build();
    assert.deepEqual(
      (await restarted.tick()).started,
      [],
      "the park outlives the process that decided it",
    );
    assert.equal(launches, 2);

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
    assert.equal(launches, 3);
    assert.equal(escalations.length, 1, "and it is not escalated straight back");

    releases.forEach((r) => r());
    await d.drain();
    await restarted.drain();
    cleanup();
  });

  it("gives a crash loop another go at the cooldown instead of paging again", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let clock = T0;
    let launches = 0;
    // Dies the instant it starts and dies badly, which is what the
    // fast-failure counter is looking for.
    const spawn: SpawnAgent = async () => {
      launches += 1;
      throw new Error("agent exited 1");
    };

    const d = createDispatcher(
      deps({
        db,
        spawn,
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
    assert.equal(launches, 3, "no relaunch past the ceiling");

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
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let clock = T0;
    let launches = 0;
    const releases: (() => void)[] = [];
    const spawn: SpawnAgent = () => {
      launches += 1;
      return new Promise<void>((resolve) => releases.push(resolve));
    };

    const d = createDispatcher(
      deps({
        db,
        spawn,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        fastFailureSeconds: 60,
        maxLaunches: 2,
        parkCooldownSeconds: 3600,
        now: () => clock,
      }),
    );

    // Dies at 61s every time: slow enough to clear the fast-failure counter
    // on each exit, so this is the launch ceiling and only it.
    for (let i = 0; i < 2; i += 1) {
      await d.tick();
      clock += 61_000;
      releases.forEach((r) => r());
      await d.drain();
    }
    assert.deepEqual((await d.tick()).escalated, ["i1"]);
    assert.equal(escalations.length, 1);
    assert.equal(launches, 2, "no relaunch past the ceiling");

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

    releases.forEach((r) => r());
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
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });
    sqlite
      .prepare(
        `INSERT INTO incident_wait
           (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES ('i1', 'a deploy to go out', ?, 1, ?)`,
      )
      .run(T0 - 1000, T0 - 2000);

    let launches = 0;
    const spawn: SpawnAgent = async () => {
      launches += 1;
      throw new Error("agent exited 1");
    };

    const d = createDispatcher(
      deps({
        db,
        spawn,
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
    assert.equal(launches, 3);
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
    assert.equal(launches, 3);
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

    const spawned: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        spawn: async (ctx) => {
          spawned.push(ctx.incidentId);
        },
        toolApiFor,
        now: () => T0,
      }),
    );

    await (await d.tick()).settled;
    assert.deepEqual(spawned, [], "parked, so nothing runs it");

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
      spawned,
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

    const spawned: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        spawn: async (ctx) => {
          spawned.push(ctx.incidentId);
        },
        toolApiFor,
        now: () => T0,
      }),
    );

    await (await d.tick()).settled;
    assert.deepEqual(spawned, [], "parked, so nothing runs it");

    // What the relay does when a reply lands, which is the whole fix: talking
    // to an incident wakes it, with no model in the path.
    sqlite.prepare("DELETE FROM incident_wait WHERE incidentId = 'i1'").run();

    await (await d.tick()).settled;
    assert.deepEqual(spawned, ["i1"]);
    cleanup();
  });

  it("does not count container restarts toward the launch ceiling", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    // Every merge to ops main restarts this container. That is routine, so it
    // must never read as an agent that cannot stay up.
    insertIncident(sqlite, "i1", { attempts: 40, sessionRef: "s-1" });

    let clock = T0;
    for (let i = 0; i < 6; i += 1) {
      const held = heldSpawn();
      const restarted = createDispatcher(
        deps({
          db,
          spawn: held.spawn,
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
    insertIncident(sqlite, "i1", { attempts: 12, sessionRef: "s-1" });

    let clock = T0;
    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        fastFailureSeconds: 60,
        now: () => clock,
      }),
    );

    for (let i = 0; i < 4; i += 1) {
      await d.tick();
      clock += 600_000;
      held.releaseAll();
      await d.drain();
    }

    assert.equal(held.contexts.length, 4, "a healthy agent is always relaunched");
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

    const held = heldSpawn();

    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        config: config({ maxAttempts: 2 }),
        mintToken: (id) => {
          if (id === "i1") throw new Error("token minting failed");
          return `tok-${id}`;
        },
      }),
    );

    await d.tick();
    assert.deepEqual(
      held.contexts.map((c) => c.incidentId),
      ["i2"],
      "i1's failure must not stall i2",
    );

    await d.tick();
    const third = await d.tick();
    assert.deepEqual(third.escalated, ["i1"], "a launch that never starts escalates");
    assert.match(escalations[0].reason, /consecutive launches died/);
    assert.deepEqual(d.list().map((a) => a.incidentId), ["i2"], "i2 ran throughout");

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("leaves the child its whole brief-writing grace before the kill", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let kills = 0;
    const contexts: AgentSpawnContext[] = [];
    const releases: (() => void)[] = [];
    const spawn: SpawnAgent = (ctx) => {
      contexts.push(ctx);
      ctx.register({ pid: 4242, kill: () => { kills += 1; } });
      return new Promise<void>((resolve) => releases.push(resolve));
    };

    let clock = T0;
    const d = createDispatcher(
      deps({
        db,
        spawn,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60, tickSeconds: 30 }),
        now: () => clock,
      }),
    );

    await d.tick();
    assert.deepEqual(d.list(), [
      { incidentId: "i1", pid: 4242, startedAt: T0, phase: "INVESTIGATING" },
    ]);
    assert.equal(
      contexts[0].deadlineAt,
      T0 + 60_000,
      "the child still gets the soft deadline, unchanged",
    );

    // Every clock below is a literal on purpose. Deriving them from the
    // imported constant would move them in lockstep with it, so changing the
    // child's grace would silently move the parent's backstop and leave this
    // green. The literals encode 180s of grace and a 30s tick, and this is
    // the assertion that says so.
    assert.equal(
      DEADLINE_GRACE_SECONDS,
      180,
      "agent/run.ts changed its grace; the clocks in this test encode 180s",
    );

    // The soft deadline is the child's to act on: it steers itself to write a
    // brief and hard-stops 180s later. A parent SIGKILL here is what
    // left every timeout escalation with an empty brief.
    clock = T0 + 61_000;
    const duringGrace = await d.tick();
    assert.equal(kills, 0, "killing at the soft deadline eats the grace window");
    assert.deepEqual(duringGrace.killed, []);
    assert.deepEqual(duringGrace.escalated, []);
    assert.equal(escalations.length, 0);

    // 1s before the child's own hard stop at 60s + 180s.
    clock = T0 + 239_000;
    const beforeHardStop = await d.tick();
    assert.equal(kills, 0, "still inside the grace the child was promised");
    assert.deepEqual(beforeHardStop.killed, []);

    // 1s past the hard stop. Still not the parent's turn: the backstop is a
    // further tick out, so a child mid-flush is not cut off.
    clock = T0 + 241_000;
    const atHardStop = await d.tick();
    assert.equal(kills, 0, "the child gets a tick to exit on its own first");
    assert.deepEqual(atHardStop.killed, []);

    // 60s + 180s grace + 30s tick + 1s. Only now, and only for an agent too
    // wedged to have used any of it.
    clock = T0 + 271_000;
    const afterGrace = await d.tick();

    assert.equal(kills, 1, "the parent is the backstop for a wedged agent");
    assert.deepEqual(afterGrace.killed, ["i1"]);
    assert.deepEqual(afterGrace.escalated, ["i1"]);
    assert.equal(escalations.length, 1);
    assert.match(escalations[0].reason, /deadline/);

    // Killed once, not once per tick.
    clock += 60_000;
    await d.tick();
    assert.equal(kills, 1);

    releases.forEach((r) => r());
    await d.drain();
    cleanup();
  });

  it("never adds its own brief on top of one the agent wrote in its grace", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    let kills = 0;
    const spawn: SpawnAgent = async (ctx) => {
      ctx.register({ pid: 55, kill: () => { kills += 1; } });
      // What the child does with the grace the soft deadline buys it. It says
      // what it knows and exits; the incident is still open afterwards,
      // because saying so was never a transition.
      await ctx.escalate({ reason: "out of time", brief: "the real brief" });
    };

    let clock = T0;
    const d = createDispatcher(
      deps({
        db,
        spawn,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await (await d.tick()).settled;

    clock = T0 + 300_000;
    const after = await d.tick();

    assert.equal(kills, 0, "it exited on its own; there is nothing to kill");
    assert.deepEqual(after.killed, []);
    assert.deepEqual(
      after.escalated,
      [],
      "the deadline brief is for an agent too wedged to write its own",
    );
    // An open incident always has an agent, so the exit is staffed again
    // rather than left: the escalation said the incident needs a person, and
    // that is not the same thing as it no longer needing an agent.
    assert.deepEqual(after.started.map((a) => a.incidentId), ["i1"]);
    assert.deepEqual(
      [...new Set(escalations.map((h) => h.brief))],
      ["the real brief"],
      "the agent's brief, never the dispatcher's placeholder",
    );
    cleanup();
  });

  it("does not add its own brief to a wedged agent that already wrote one", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1");

    // The sequence, not the outcome. The test above has the child exit after
    // escalating, so the deadline never fires on it and it passes whether or
    // not anything suppresses the second brief. The case that matters is the
    // one the deadline kill exists for: an agent wedged badly enough that it
    // uses its grace to say what it knows and then still cannot exit.
    let kills = 0;
    let released = () => {};
    const spawn: SpawnAgent = async (ctx) => {
      ctx.register({ pid: 55, kill: () => { kills += 1; } });
      await ctx.escalate({ reason: "out of time", brief: "the real brief" });
      await new Promise<void>((resolve) => {
        released = resolve;
      });
    };

    let clock = T0;
    const d = createDispatcher(
      deps({
        db,
        spawn,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await d.tick();
    // Past the soft deadline, the grace, and the tick the backstop adds.
    clock = T0 + 300_000;
    const after = await d.tick();

    assert.equal(kills, 1, "it was too wedged to exit, so it is killed");
    assert.deepEqual(after.killed, ["i1"]);
    assert.deepEqual(
      after.escalated,
      [],
      "it already spoke for itself, so the dispatcher does not speak over it",
    );
    assert.deepEqual(
      escalations.map((h) => h.brief),
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

    released();
    await d.drain();
    cleanup();
  });

  it("resumes an existing session and reports how long the agent was gone", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      sessionRef: "s-1",
      lastStartedAt: T0 - 600_000,
    });
    insertIncident(sqlite, "i2");

    const held = heldSpawn();
    const d = createDispatcher(deps({ db, spawn: held.spawn, toolApiFor }));
    await d.tick();

    const resumed = held.contexts.find((c) => c.incidentId === "i1");
    assert.equal(resumed?.sessionRef, "s-1", "resume, not restart");
    assert.equal(resumed?.attempt, 2);

    const directives = db.query<{ incidentId: string; payload: string }>(
      "SELECT incidentId, payload FROM pending_directive",
    );
    assert.equal(directives.length, 1, "only a resumed agent gets one");
    assert.equal(directives[0].incidentId, "i1");
    assert.deepEqual(JSON.parse(directives[0].payload), {
      type: "resumed_after",
      seconds: 600,
    });

    assert.equal(
      db.get<{ lastStartedAt: number }>(
        "SELECT lastStartedAt FROM incident WHERE id = 'i1'",
      )?.lastStartedAt,
      T0,
      "every launch records its own start for the next resume",
    );

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("measures the gap from lastStartedAt after a container restart", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    // The container dies mid-run: no exit is observed and no memory survives.
    const first = createDispatcher(
      deps({ db, spawn: heldSpawn().spawn, toolApiFor, now: () => T0 }),
    );
    await first.tick();

    const restarted = createDispatcher(
      deps({
        db,
        spawn: heldSpawn().spawn,
        toolApiFor,
        now: () => T0 + 420_000,
      }),
    );
    await restarted.tick();

    const directives = db.query<{ payload: string }>(
      "SELECT payload FROM pending_directive",
    );
    assert.deepEqual(JSON.parse(directives[directives.length - 1].payload), {
      type: "resumed_after",
      seconds: 420,
    });
    assert.deepEqual(escalations, [], "a restart is not a crash loop");
    cleanup();
  });

  // The three real runs that were killed were resumed automatically and
  // nobody noticed. Operators learn from the alarm and the agent from the
  // directive; the thread is not told, because the post asked nothing of
  // anyone and fired on every ordinary deploy.
  it("alarms and tells the agent, and posts nothing, when it resumes an agent gone a long time", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      sessionRef: "s-1",
      lastStartedAt: T0 - (RESUME_ALARM_SECONDS + 60) * 1000,
    });

    const notices: string[] = [];
    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        postNotice: async (_id, text) => {
          notices.push(text);
        },
      }),
    );
    let started: string[] = [];
    const alarms = await captureAlarms(async () => {
      started = (await d.tick()).started.map((a) => a.incidentId);
    });

    assert.deepEqual(started, ["i1"]);
    assert.deepEqual(notices, [], "nothing is posted to the thread");
    assert.ok(alarms.includes("agent_resumed_after_gap"));
    const directives = db
      .query<{ payload: string }>("SELECT payload FROM pending_directive")
      .map((r) => JSON.parse(r.payload));
    assert.deepEqual(directives, [
      { type: "resumed_after", seconds: RESUME_ALARM_SECONDS + 60 },
    ]);

    held.releaseAll();
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
      sessionRef: "s-1",
      lastStartedAt: T0 - 90_000,
    });

    const notices: string[] = [];
    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        postNotice: async (_id, text) => {
          notices.push(text);
        },
      }),
    );
    const alarms = await captureAlarms(async () => {
      await d.tick();
    });

    assert.deepEqual(notices, []);
    assert.ok(!alarms.includes("agent_resumed_after_gap"));
    // The agent is still told, because it is the one that has to re-check.
    const directives = db.query<{ payload: string }>(
      "SELECT payload FROM pending_directive",
    );
    assert.equal(directives.length, 1);

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("skips resumed_after when the gap is shorter than a tick", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      attempts: 1,
      sessionRef: "s-1",
      lastStartedAt: T0 - 5_000,
    });

    const held = heldSpawn();
    const d = createDispatcher(deps({ db, spawn: held.spawn, toolApiFor }));
    await d.tick();

    assert.equal(db.query("SELECT id FROM pending_directive").length, 0);
    held.releaseAll();
    await d.drain();
    cleanup();
  });

  // Prod, 2026-09-30: a deploy restarted the container and incident 10's
  // thread was told its agent had been gone 4.5h and to disregard its last
  // message. The agent had asked the Boss a question three minutes earlier.
  // 4.5h was the time since launch, which is all the old clock read.
  describe("after a restart kills an agent that was working", () => {
    const LAUNCHED_AGO_MS = 16_200_000;
    const ACTIVE_AGO_MS = 180_000;

    const restartWith = async (signals: {
      inbox: boolean;
      session: boolean;
    }) => {
      const { db, sqlite, cleanup } = makeDb();
      const { toolApiFor } = makeTools();
      insertIncident(sqlite, "i1", {
        status: "INVESTIGATING",
        attempts: 1,
        sessionRef: "sessions/incident/i1/session.jsonl",
        lastStartedAt: T0 - LAUNCHED_AGO_MS,
      });
      if (signals.inbox) {
        sqlite
          .prepare(
            "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES (?, 'question', ?, ?)",
          )
          .run("i1", "Is the 02:00 deploy yours?", T0 - ACTIVE_AGO_MS);
      }

      const notices: string[] = [];
      const held = heldSpawn();
      const d = createDispatcher(
        deps({
          db,
          spawn: held.spawn,
          toolApiFor,
          postNotice: async (_id, text) => {
            notices.push(text);
          },
          lastSessionEventAt: async () =>
            signals.session ? T0 - ACTIVE_AGO_MS : null,
        }),
      );
      const alarms = await captureAlarms(async () => {
        await d.tick();
      });
      const directives = db
        .query<{ payload: string }>("SELECT payload FROM pending_directive")
        .map((r) => JSON.parse(r.payload));

      held.releaseAll();
      await d.drain();
      cleanup();
      return { notices, alarms, directives };
    };

    it("measured from launch, the old clock, this is a gap worth alarming", async () => {
      assert.ok(LAUNCHED_AGO_MS / 1000 >= RESUME_ALARM_SECONDS);
      const { notices, alarms, directives } = await restartWith({
        inbox: false,
        session: false,
      });
      assert.ok(
        alarms.includes("agent_resumed_after_gap"),
        "with no activity to read, launch is the clock",
      );
      assert.deepEqual(notices, []);
      assert.deepEqual(directives, [
        { type: "resumed_after", seconds: LAUNCHED_AGO_MS / 1000 },
      ]);
    });

    it("does not alarm and logs the real three minutes", async () => {
      const { notices, alarms, directives } = await restartWith({
        inbox: true,
        session: true,
      });
      assert.deepEqual(notices, []);
      assert.ok(!alarms.includes("agent_resumed_after_gap"));
      assert.deepEqual(directives, [
        { type: "resumed_after", seconds: ACTIVE_AGO_MS / 1000 },
      ]);
    });

    it("reads either clock on its own", async () => {
      for (const signals of [
        { inbox: true, session: false },
        { inbox: false, session: true },
      ]) {
        const { notices, directives } = await restartWith(signals);
        assert.deepEqual(notices, [], JSON.stringify(signals));
        assert.deepEqual(directives, [
          { type: "resumed_after", seconds: ACTIVE_AGO_MS / 1000 },
        ]);
      }
    });
  });

  it("alarms and tells the agent the true gap when the agent really was idle", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      sessionRef: "sessions/incident/i1/session.jsonl",
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
    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        postNotice: async (_id, text) => {
          notices.push(text);
        },
        lastSessionEventAt: async () => T0 - 3_600_000,
      }),
    );
    const alarms = await captureAlarms(async () => {
      await d.tick();
    });

    assert.deepEqual(notices, []);
    assert.ok(alarms.includes("agent_resumed_after_gap"));
    const directives = db
      .query<{ payload: string }>("SELECT payload FROM pending_directive")
      .map((r) => JSON.parse(r.payload));
    assert.deepEqual(directives, [{ type: "resumed_after", seconds: 3600 }]);

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  // A blocking wait writes nothing while it blocks. An agent an hour into a
  // question to the Boss, or a wait on a person, looks idle by every
  // timestamp, and a deploy killing it is still just a deploy.
  describe("after a restart kills an agent inside a blocking wait", () => {
    const ASKED_AGO_MS = 3_000_000;

    const restartDuring = async (
      marker: "question" | "wait" | null,
      sessionAt: number | null = T0 - ASKED_AGO_MS - 5_000,
    ) => {
      const { db, sqlite, cleanup } = makeDb();
      const { toolApiFor } = makeTools();
      insertIncident(sqlite, "i1", {
        attempts: 1,
        sessionRef: "sessions/incident/i1/session.jsonl",
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

      // The process boots at T0 and its first tick runs a tick later.
      let clock = T0;
      const notices: string[] = [];
      const held = heldSpawn();
      const d = createDispatcher(
        deps({
          db,
          spawn: held.spawn,
          toolApiFor,
          now: () => clock,
          postNotice: async (_id, text) => {
            notices.push(text);
          },
          lastSessionEventAt: async () => {
            if (sessionAt === null) throw new Error("s3 is down");
            return sessionAt;
          },
        }),
      );
      clock = T0 + 45_000;
      const alarms = await captureAlarms(async () => {
        await d.tick();
      });
      const directives = db
        .query<{ payload: string }>("SELECT payload FROM pending_directive")
        .map((r) => JSON.parse(r.payload));

      held.releaseAll();
      await d.drain();
      cleanup();
      return { notices, alarms, directives };
    };

    it("without an open marker, the last timestamp alone reads as an hour gone", async () => {
      const { notices, alarms } = await restartDuring(null);
      assert.ok(alarms.includes("agent_resumed_after_gap"));
      assert.deepEqual(notices, []);
    });

    it("an open question or wait means it was alive until the restart", async () => {
      for (const marker of ["question", "wait"] as const) {
        const { notices, alarms, directives } = await restartDuring(marker);
        assert.deepEqual(notices, [], marker);
        assert.ok(!alarms.includes("agent_resumed_after_gap"), marker);
        assert.deepEqual(directives, [{ type: "resumed_after", seconds: 45 }], marker);
      }
    });

    // A SIGKILL mid-wait leaves its marker behind, and a resumed agent that
    // never re-enters that wait leaves it there. Its later turns are newer
    // than the marker, which is how an orphan is told from a live wait.
    it("a marker counts for nothing when the session cannot be read", async () => {
      const { notices, alarms } = await restartDuring("question", null);
      assert.ok(alarms.includes("agent_resumed_after_gap"));
      assert.ok(alarms.includes("resume_session_read_failed"));
      assert.deepEqual(notices, []);
    });

    it("an orphaned marker older than the session proves nothing", async () => {
      const { notices, alarms, directives } = await restartDuring(
        "question",
        T0 - ASKED_AGO_MS + 600_000,
      );
      assert.ok(alarms.includes("agent_resumed_after_gap"));
      assert.deepEqual(notices, []);
      assert.deepEqual(directives, [
        { type: "resumed_after", seconds: (ASKED_AGO_MS - 600_000 + 45_000) / 1000 },
      ]);
    });
  });

  it("does not let a session read that never settles hold up the tick", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      attempts: 1,
      sessionRef: "sessions/incident/i1/session.jsonl",
      lastStartedAt: T0 - 600_000,
    });

    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        lastSessionEventAt: () => new Promise<number | null>(() => {}),
      }),
    );
    const alarms = await captureAlarms(async () => {
      const result = await d.tick();
      assert.deepEqual(result.started.map((a) => a.incidentId), ["i1"]);
    });
    assert.ok(alarms.includes("resume_session_read_failed"));

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("falls back to the database when the session cannot be read", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      attempts: 1,
      sessionRef: "sessions/incident/i1/session.jsonl",
      lastStartedAt: T0 - 16_200_000,
    });
    sqlite
      .prepare(
        "INSERT INTO boss_inbox (incidentId, kind, text, createdAt) VALUES ('i1', 'message', 'PR is up', ?)",
      )
      .run(T0 - 120_000);

    const notices: string[] = [];
    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        postNotice: async (_id, text) => {
          notices.push(text);
        },
        lastSessionEventAt: async () => {
          throw new Error("s3 is down");
        },
      }),
    );
    const alarms = await captureAlarms(async () => {
      await d.tick();
    });

    assert.deepEqual(notices, []);
    assert.ok(alarms.includes("resume_session_read_failed"));
    const directives = db.query<{ payload: string }>("SELECT payload FROM pending_directive");
    assert.deepEqual(JSON.parse(directives[0].payload), {
      type: "resumed_after",
      seconds: 120,
    });

    held.releaseAll();
    await d.drain();
    cleanup();
  });
});

describe("the spawned environment", () => {
  it("carries the container credential path, and only what it was handed", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    process.env.SLACK_BOT_TOKEN = "xoxb-parent-only";

    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        childBaseEnv: {
          PATH: "/usr/bin",
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-role",
        },
        childCredentials: { GITHUB_TOKEN: "ghs_agent" },
      }),
    );
    await d.tick();

    const { env } = held.contexts[0];
    assert.equal(
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
      "/v2/credentials/task-role",
      "the child resolves the task role through the container provider",
    );
    assert.equal(
      env.SLACK_BOT_TOKEN,
      undefined,
      "the parent's own credentials are not part of the allowlist",
    );
    assert.equal(env.GITHUB_TOKEN, "ghs_agent");
    assert.equal(env.BUGBOSS_TOKEN, "tok-i1");
    assert.equal(env.BUGBOSS_INCIDENT_ID, "i1");

    held.releaseAll();
    await d.drain();
    delete process.env.SLACK_BOT_TOKEN;
    cleanup();
  });

  it("hands the child the alert slugs of its incident's signals, and no one else's", async () => {
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

    const held = heldSpawn();
    const d = createDispatcher(deps({ db, spawn: held.spawn, toolApiFor }));
    await d.tick();

    assert.equal(held.contexts[0].env.BUGBOSS_ALERT_SLUGS, '["high-cpu","route-errors-win"]');

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("is what child_process actually gets, with nothing inherited", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    process.env.BUGBOSS_PARENT_ONLY = "slack-token-shaped-thing";

    let captured: NodeJS.ProcessEnv | undefined;
    const fakeSpawn = ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      captured = opts.env;
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 777, kill: () => true });
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    }) as never;

    const d = createDispatcher(
      deps({
        db,
        toolApiFor,
        spawn: createChildProcessSpawn({
          modulePath: "/app/bugboss/agent/run.js",
          spawnFn: fakeSpawn,
        }),
        childBaseEnv: {
          PATH: "/usr/bin",
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/creds",
        },
      }),
    );
    const result = await d.tick();
    await result.settled;

    assert.ok(captured, "the child was given an explicit environment");
    assert.equal(captured.BUGBOSS_PARENT_ONLY, undefined, "nothing is inherited");
    assert.equal(captured.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, "/v2/creds");
    assert.equal(captured.PATH, "/usr/bin");
    assert.equal(result.started[0].pid, 777, "the pid is tracked for the kill path");

    delete process.env.BUGBOSS_PARENT_ONLY;
    cleanup();
  });

  it("reports a child that exits non-zero instead of calling it a clean run", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    // agent/run.ts exits 1 from its failure handler. Resolving on any exit
    // made that byte-identical to an agent that finished in good order.
    const crashingSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 778, kill: () => true });
      setImmediate(() => child.emit("exit", 1, null));
      return child;
    }) as never;

    const d = createDispatcher(
      deps({
        db,
        toolApiFor,
        spawn: createChildProcessSpawn({
          modulePath: "/app/bugboss/agent/run.js",
          spawnFn: crashingSpawn,
        }),
        childBaseEnv: { PATH: "/usr/bin" },
      }),
    );

    const events = await captureAlarms(async () => {
      await (await d.tick()).settled;
    });

    assert.ok(events.includes("agent_failed"), `no agent_failed in ${events}`);
    cleanup();
  });

  it("does not call a signalled child a clean run either", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    const signalledSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 779, kill: () => true });
      setImmediate(() => child.emit("exit", null, "SIGSEGV"));
      return child;
    }) as never;

    const d = createDispatcher(
      deps({
        db,
        toolApiFor,
        spawn: createChildProcessSpawn({
          modulePath: "/app/bugboss/agent/run.js",
          spawnFn: signalledSpawn,
        }),
        childBaseEnv: { PATH: "/usr/bin" },
      }),
    );

    const events = await captureAlarms(async () => {
      await (await d.tick()).settled;
    });

    assert.ok(events.includes("agent_failed"), `no agent_failed in ${events}`);
    cleanup();
  });

  it("alarms on a SIGKILL it did not send", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    // The kernel's OOM killer and the dispatcher's backstop send the same
    // signal, so the signal cannot be the discriminator. `entry.killed` is,
    // and it is only ever set by enforceDeadlines. An OOM inside the deadline
    // must still reach a human as an agent failure.
    const oomSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 782, kill: () => true });
      setImmediate(() => child.emit("exit", null, "SIGKILL"));
      return child;
    }) as never;

    const d = createDispatcher(
      deps({
        db,
        toolApiFor,
        spawn: createChildProcessSpawn({
          modulePath: "/app/bugboss/agent/run.js",
          spawnFn: oomSpawn,
        }),
        childBaseEnv: { PATH: "/usr/bin" },
        config: config({ agentTimeoutSeconds: 1800 }),
      }),
    );

    const events = await captureAlarms(async () => {
      await (await d.tick()).settled;
    });

    assert.ok(events.includes("agent_failed"), `no agent_failed in ${events}`);
    assert.equal(
      events.includes("agent_deadline_exceeded"),
      false,
      "it died 1800s early; the deadline had nothing to do with it",
    );
    cleanup();
  });

  it("stays quiet about a clean exit", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    const cleanSpawn = ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 780, kill: () => true });
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    }) as never;

    const d = createDispatcher(
      deps({
        db,
        toolApiFor,
        spawn: createChildProcessSpawn({
          modulePath: "/app/bugboss/agent/run.js",
          spawnFn: cleanSpawn,
        }),
        childBaseEnv: { PATH: "/usr/bin" },
      }),
    );

    const events = await captureAlarms(async () => {
      await (await d.tick()).settled;
    });

    assert.equal(events.includes("agent_failed"), false, `${events}`);
    cleanup();
  });

  it("does not call its own deadline kill an agent failure", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1");

    let clock = T0;
    const exits: (() => void)[] = [];
    const spawn: SpawnAgent = (ctx) => {
      ctx.register({
        pid: 781,
        // A SIGKILLed child exits on a signal, which is now a rejection.
        kill: () => exits.forEach((e) => e()),
      });
      return new Promise<void>((_resolve, reject) => {
        exits.push(() => reject(new Error("agent killed by SIGKILL")));
      });
    };

    const d = createDispatcher(
      deps({
        db,
        spawn,
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await d.tick();
    clock = T0 + 300_000;

    const events = await captureAlarms(async () => {
      await d.tick();
    });

    assert.ok(events.includes("agent_deadline_exceeded"), `${events}`);
    assert.equal(
      events.includes("agent_failed"),
      false,
      "the dispatcher killed it on purpose and already said why",
    );
    // The same tick staffs the incident again, and that is the point of the
    // kill: an incident too wedged to finish still needs an agent on it, and
    // the escalation beside this one is what tells a person to look. Nothing
    // here takes the incident away from the agents.
    assert.deepEqual(d.list().map((a) => a.incidentId), ["i1"]);
    assert.equal(d.list()[0].startedAt, clock, "a fresh run, not the killed one");

    exits.forEach((e) => e());
    await d.drain();
    cleanup();
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

  // The same row `turnBudgetPark` writes: a wait on a person that a reply
  // does not end, because what it is short of is turns rather than news.
  const budgetPark = (sqlite: Database.Database, id: string, at: number) =>
    sqlite
      .prepare(
        `INSERT INTO incident_wait
           (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES (?, 'a person, after the 200-turn budget ran out', NULL, 0, ?)`,
      )
      .run(id, at);

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
        spawn: async () => {},
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

    const spawned: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        spawn: async (ctx) => {
          spawned.push(ctx.incidentId);
        },
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
    assert.deepEqual(spawned, ["i1"]);
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
        spawn: async () => {},
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
        spawn: async () => {},
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
    const { spawn, releaseAll } = heldSpawn();
    // A run may last a day, so a healthy agent's own launch timestamp ages
    // past the threshold under it. Only the running map can say otherwise.
    insertIncident(sqlite, "i1", {
      status: "INVESTIGATING",
      firstSignalAt: T0 - 3 * DAY,
      lastStartedAt: T0 - 2 * DAY,
      sessionRef: "s-1",
      attempts: 1,
    });

    let clock = T0;
    const posts: string[] = [];
    const d = createDispatcher(
      deps({
        db,
        spawn,
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

    releaseAll();
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
          spawn: async () => {},
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
        spawn: async () => {},
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
        spawn: async () => {},
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
      deps({ db, spawn: async () => {}, toolApiFor, postNotice: async () => {} }),
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

    const d = createDispatcher(deps({ db, spawn: async () => {}, toolApiFor }));
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

    const spawned: string[] = [];
    const posts: Array<[string, string]> = [];
    const d = createDispatcher(
      deps({
        db,
        spawn: async (ctx) => {
          spawned.push(ctx.incidentId);
        },
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
    assert.deepEqual(spawned, ["i1"]);
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

    const spawned: string[] = [];
    const posts: string[] = [];
    let clock = T0;
    const d = createDispatcher(
      deps({
        db,
        spawn: async (ctx) => {
          spawned.push(ctx.incidentId);
        },
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

    assert.deepEqual(spawned, [], "nothing ever relaunched it");
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
    assert.match(held, /BUGBOSS_MAX_TURNS/);
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

    const held = heldSpawn();
    const d = createDispatcher(deps({ db, spawn: held.spawn, toolApiFor, workRoot: root }));
    await d.tick();

    assert.ok(existsSync(join(root, "i1", "omni", "uncommitted.ts")));
    assert.ok(existsSync(join(root, "i2", "omni", "uncommitted.ts")));
    assert.ok(!existsSync(join(root, "i4")), "a closed incident's workspace is deleted");
    assert.ok(!existsSync(join(root, "i5")), "a merged incident's workspace is deleted");
    // No row is not evidence the incident is over: a database restored short
    // would otherwise take every live workspace with it.
    assert.ok(existsSync(join(root, "no-such-incident")));
    assert.ok(await trashEmptied(root), "the deleted trees are removed from disk, not just moved");

    held.releaseAll();
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

    const held = heldSpawn();
    const d = createDispatcher(deps({ db, spawn: held.spawn, toolApiFor, workRoot: root }));
    await d.tick();
    sqlite
      .prepare("UPDATE incident SET status = 'CLOSED', closedAt = ?, postmortem = 'pm' WHERE id = 'i1'")
      .run(T0);
    await d.tick();
    assert.ok(existsSync(join(root, "i1", "omni", "uncommitted.ts")), "its agent is still writing to it");

    held.releaseAll();
    await d.drain();
    await d.tick();
    assert.ok(!existsSync(join(root, "i1")));
    assert.ok(await trashEmptied(root));

    rmSync(root, { recursive: true, force: true });
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
        ? Promise.reject(new Error("writes halted: RequestTimeTooSkewed"))
        : db.withWrite(fn),
  });

  // Incident 93 on 2026-10-01. Every launch write failed, so every launch
  // was a fast failure, so every third tick met the crash-loop ceiling and
  // posted, and the park after the post failed, so nothing stopped the next
  // round. Two minutes apart, for five hours.
  it("replays the incident 93 storm and posts nothing", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "93", { sessionRef: "s-1" });

    const d = createDispatcher(
      deps({
        db: refusing(db, () => true),
        spawn: async () => {
          throw new Error("unreachable: the launch write fails first");
        },
        toolApiFor,
        config: config({ maxAttempts: 3 }),
      }),
    );

    await captureAlarms(async () => {
      for (let tick = 0; tick < 40; tick += 1) {
        await d.tick().then((r) => r.settled).catch(() => undefined);
      }
    });

    assert.equal(escalations.length, 0, "a park that cannot be written posts nothing");
    cleanup();
  });

  it("keeps its count when the park fails, so the escalation goes out once writes return", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let halted = false;
    let launches = 0;
    const d = createDispatcher(
      deps({
        db: refusing(db, () => halted),
        spawn: async () => {
          launches += 1;
          throw new Error("agent exited 1");
        },
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

    assert.equal(launches, 3, "no relaunch spent rebuilding a count it already had");
    assert.deepEqual(recovered.escalated, ["i1"]);
    assert.equal(escalations.length, 1);
    cleanup();
  });

  it("parks before it posts a crash loop", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    const parkedAtPost: boolean[] = [];
    const toolApiFor = (incidentId: string): ToolApi => ({
      ...makeTools().toolApiFor(incidentId),
      escalate: async ({ reason, brief }) => {
        parkedAtPost.push(
          db.get("SELECT 1 FROM incident_wait WHERE incidentId = ?", [incidentId]) !== undefined,
        );
        escalations.push({ incidentId, reason, brief });
        return { ok: true, directives: [] };
      },
    });

    const d = createDispatcher(
      deps({
        db,
        spawn: async () => {
          throw new Error("agent exited 1");
        },
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
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let clock = T0;
    const releases: (() => void)[] = [];
    const parkedAtPost: boolean[] = [];
    const toolApiFor = (incidentId: string): ToolApi => ({
      ...makeTools().toolApiFor(incidentId),
      escalate: async () => {
        parkedAtPost.push(
          db.get("SELECT 1 FROM incident_wait WHERE incidentId = ?", [incidentId]) !== undefined,
        );
        // What the tool API answers when its post fails: a refusal, not a throw.
        return { ok: false, error: "could not post the escalation", directives: [] };
      },
    });

    const d = createDispatcher(
      deps({
        db,
        spawn: () => new Promise<void>((resolve) => releases.push(resolve)),
        toolApiFor,
        config: config({ maxAttempts: 3 }),
        fastFailureSeconds: 60,
        maxLaunches: 3,
        now: () => clock,
      }),
    );

    const alarms = await captureAlarms(async () => {
      for (let i = 0; i < 3; i += 1) {
        await d.tick();
        clock += 61_000;
        releases.forEach((r) => r());
        await d.drain();
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
    releases.forEach((r) => r());
    await d.drain();
    cleanup();
  });

  it("does not post a deadline escalation while writes fail", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, escalations } = makeTools();
    insertIncident(sqlite, "i1", { sessionRef: "s-1" });

    let clock = T0;
    let halted = false;
    const releases: (() => void)[] = [];
    const d = createDispatcher(
      deps({
        db: refusing(db, () => halted),
        spawn: (ctx) => {
          ctx.register({ pid: 1, kill: () => releases.forEach((r) => r()) });
          return new Promise<void>((resolve) => releases.push(resolve));
        },
        toolApiFor,
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await d.tick();
    halted = true;
    clock = T0 + 60_000 + (DEADLINE_GRACE_SECONDS + 1) * 1000;
    const alarms = await captureAlarms(async () => {
      for (let tick = 0; tick < 5; tick += 1) {
        await d.tick().catch(() => undefined);
        clock += 30_000;
      }
    });

    assert.equal(escalations.length, 0);
    assert.ok(alarms.includes("deadline_escalation_unrecorded"));
    await d.drain();
    cleanup();
  });
});
