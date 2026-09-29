import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";

import Database from "better-sqlite3";

import { DEADLINE_GRACE_SECONDS } from "../agent/run";
import type { DispatcherConfig, ToolApi } from "../types";
import {
  RESUME_NOTICE_SECONDS,
  createDispatcher,
  resumeNotice,
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
    // are permanent.
    clock += 3_600_000;
    const woken = await restarted.tick();
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
  // silently, so the thread's last message -- still true -- read as patience
  // while nothing was running. The resume was never the missing piece; saying
  // it happened was.
  it("says in the thread when it resumes an agent that has been gone a long time", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      sessionRef: "s-1",
      lastStartedAt: T0 - (RESUME_NOTICE_SECONDS + 60) * 1000,
    });

    const notices: { incidentId: string; text: string }[] = [];
    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        postNotice: async (incidentId, text) => {
          notices.push({ incidentId, text });
        },
      }),
    );
    await d.tick();

    assert.equal(notices.length, 1, "the thread is told exactly once");
    assert.equal(notices[0].incidentId, "i1");
    assert.equal(notices[0].text, resumeNotice(RESUME_NOTICE_SECONDS + 60));
    assert.match(notices[0].text, /stopped without finishing/);

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  // A deploy puts every agent back within a tick or two. Saying so each time
  // would teach people to skip the message that matters.
  it("says nothing for a resume quick enough to be a deploy", async () => {
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
    await d.tick();

    assert.deepEqual(notices, []);
    // The agent is still told, because it is the one that has to re-check.
    const directives = db.query<{ payload: string }>(
      "SELECT payload FROM pending_directive",
    );
    assert.equal(directives.length, 1);

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("launches anyway when the thread cannot be reached", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools();
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      sessionRef: "s-1",
      lastStartedAt: T0 - 3_600_000,
    });

    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        postNotice: async () => {
          throw new Error("slack is down");
        },
      }),
    );
    const result = await d.tick();

    assert.deepEqual(
      result.started.map((a) => a.incidentId),
      ["i1"],
      "a notice nobody can deliver must not cost the resume",
    );

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
});

describe("staleNotice", () => {
  it("leads with how long it has been quiet", () => {
    assert.match(staleNotice(26 * 3600, false), /for 26h\./);
    assert.match(staleNotice(45 * 60, false), /for 45m\./);
  });

  it("only claims to have un-parked when it did", () => {
    assert.match(staleNotice(86_400, true), /no longer waiting/);
    assert.equal(staleNotice(86_400, false).includes("no longer waiting"), false);
  });
});
