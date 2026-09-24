import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";

import Database from "better-sqlite3";

import type { DispatcherConfig, ToolApi } from "../types";
import { createDispatcher, type DispatcherDb, type DispatcherDeps } from "./index";
import { createChildProcessSpawn, type AgentSpawnContext, type SpawnAgent } from "./spawn";

const T0 = 1_700_000_000_000;

const config = (over: Partial<DispatcherConfig> = {}): DispatcherConfig => ({
  maxConcurrentAgents: 15,
  tickSeconds: 30,
  agentTimeoutSeconds: 1800,
  maxAttempts: 3,
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
  owner?: string;
  attempts?: number;
  sessionRef?: string | null;
  firstSignalAt?: number;
  fixingAt?: number | null;
}

const insertIncident = (
  sqlite: Database.Database,
  id: string,
  over: IncidentOverrides = {},
) =>
  sqlite
    .prepare(
      `INSERT INTO incident
         (id, status, owner, firstSignalAt, attempts, sessionRef, fixingAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.status ?? "INVESTIGATING",
      over.owner ?? "agent",
      over.firstSignalAt ?? T0,
      over.attempts ?? 0,
      over.sessionRef ?? null,
      over.fixingAt ?? null,
    );

const ok = async () => ({ ok: true, directives: [] });

const makeTools = (sqlite: Database.Database) => {
  const handOffs: { incidentId: string; reason: string; brief: string }[] = [];
  const toolApiFor = (incidentId: string): ToolApi => ({
    reportRootCause: ok,
    reportImpact: ok,
    reportResolved: ok,
    reportAnalysis: ok,
    getIncident: ok,
    handOff: async ({ reason, brief }) => {
      handOffs.push({ incidentId, reason, brief });
      sqlite
        .prepare("UPDATE incident SET owner = 'human' WHERE id = ?")
        .run(incidentId);
      return { ok: true, directives: [] };
    },
  });
  return { toolApiFor, handOffs };
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
  credentials: async () => ({
    accessKeyId: "ASIA-AGENT",
    secretAccessKey: "agent-secret",
    sessionToken: "agent-session",
    expiresAt: T0 + 3_600_000,
  }),
  now: () => T0,
  ...over,
});

describe("Dispatcher.tick", () => {
  it("starts exactly one agent per eligible incident", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools(sqlite);
    insertIncident(sqlite, "i1", { status: "INVESTIGATING" });
    insertIncident(sqlite, "i2", { status: "FIXING" });
    insertIncident(sqlite, "i3", { status: "INVESTIGATING", owner: "human" });
    insertIncident(sqlite, "i4", { status: "RESOLVED" });
    insertIncident(sqlite, "i5", { status: "CLOSED" });

    const spawned: string[] = [];
    const spawn: SpawnAgent = async (ctx) => {
      spawned.push(ctx.incidentId);
    };

    const d = createDispatcher(deps({ db, spawn, toolApiFor }));
    const result = await d.tick();
    await result.settled;

    assert.deepEqual(spawned.sort(), ["i1", "i2"]);
    assert.deepEqual(result.started.map((a) => a.incidentId).sort(), ["i1", "i2"]);
    assert.equal(result.circuitOpen, false);

    const attempts = Object.fromEntries(
      db
        .query<{ id: string; attempts: number }>("SELECT id, attempts FROM incident")
        .map((r) => [r.id, r.attempts]),
    );
    assert.deepEqual(attempts, { i1: 1, i2: 1, i3: 0, i4: 0, i5: 0 });
    cleanup();
  });

  it("does not start a second agent for an incident that already has one", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools(sqlite);
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
    const { toolApiFor } = makeTools(sqlite);
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

  it("escalates instead of relaunching past maxAttempts", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, handOffs } = makeTools(sqlite);
    insertIncident(sqlite, "i1", { attempts: 3, sessionRef: "s-1" });

    const held = heldSpawn();
    const d = createDispatcher(
      deps({ db, spawn: held.spawn, toolApiFor, config: config({ maxAttempts: 3 }) }),
    );

    const first = await d.tick();
    assert.equal(held.contexts.length, 0, "no relaunch past the limit");
    assert.deepEqual(first.escalated, ["i1"]);
    assert.equal(handOffs.length, 1);
    assert.match(handOffs[0].reason, /attempts/);
    assert.match(handOffs[0].brief, /did not hand off itself/);
    assert.equal(
      db.get<{ owner: string }>("SELECT owner FROM incident WHERE id = 'i1'")?.owner,
      "human",
    );

    // Human-owned now, so the crash loop is over rather than merely slowed.
    const second = await d.tick();
    assert.deepEqual(second.escalated, []);
    assert.equal(handOffs.length, 1);
    cleanup();
  });

  it("kills a child that passes its deadline and hands off on its behalf", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor, handOffs } = makeTools(sqlite);
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
        config: config({ agentTimeoutSeconds: 60 }),
        now: () => clock,
      }),
    );

    await d.tick();
    assert.deepEqual(d.list(), [
      { incidentId: "i1", pid: 4242, startedAt: T0, phase: "INVESTIGATING" },
    ]);
    assert.equal(contexts[0].deadlineAt, T0 + 60_000);

    clock = T0 + 61_000;
    const second = await d.tick();

    assert.equal(kills, 1, "the parent is the backstop for a wedged agent");
    assert.deepEqual(second.killed, ["i1"]);
    assert.deepEqual(second.escalated, ["i1"]);
    assert.equal(handOffs.length, 1);
    assert.match(handOffs[0].reason, /deadline/);

    // Killed once, not once per tick.
    clock = T0 + 120_000;
    await d.tick();
    assert.equal(kills, 1);

    releases.forEach((r) => r());
    await d.drain();
    cleanup();
  });

  it("resumes an existing session and reports how long the agent was gone", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools(sqlite);
    insertIncident(sqlite, "i1", {
      status: "FIXING",
      attempts: 1,
      sessionRef: "s-1",
      fixingAt: T0 - 600_000,
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

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("skips resumed_after when the gap is shorter than a tick", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools(sqlite);
    insertIncident(sqlite, "i1", {
      attempts: 1,
      sessionRef: "s-1",
      firstSignalAt: T0 - 5_000,
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
  it("carries the agent role and not the container's task role", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools(sqlite);
    insertIncident(sqlite, "i1");

    const held = heldSpawn();
    const d = createDispatcher(
      deps({
        db,
        spawn: held.spawn,
        toolApiFor,
        childBaseEnv: {
          PATH: "/usr/bin",
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-role",
          AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/creds",
          AWS_ACCESS_KEY_ID: "PARENT-KEY",
        },
        childCredentials: { GITHUB_TOKEN: "ghs_agent" },
      }),
    );
    await d.tick();

    const { env } = held.contexts[0];
    assert.equal(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, undefined);
    assert.equal(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, "ASIA-AGENT");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "agent-secret");
    assert.equal(env.AWS_SESSION_TOKEN, "agent-session");
    assert.equal(env.GITHUB_TOKEN, "ghs_agent");
    assert.equal(env.BUGBOSS_TOKEN, "tok-i1");
    assert.equal(env.BUGBOSS_INCIDENT_ID, "i1");

    held.releaseAll();
    await d.drain();
    cleanup();
  });

  it("is what child_process actually gets, with nothing inherited", async () => {
    const { db, sqlite, cleanup } = makeDb();
    const { toolApiFor } = makeTools(sqlite);
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
        childBaseEnv: { PATH: "/usr/bin" },
      }),
    );
    const result = await d.tick();
    await result.settled;

    assert.ok(captured, "the child was given an explicit environment");
    assert.equal(captured.BUGBOSS_PARENT_ONLY, undefined, "nothing is inherited");
    assert.equal(captured.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, undefined);
    assert.equal(captured.AWS_ACCESS_KEY_ID, "ASIA-AGENT");
    assert.equal(captured.PATH, "/usr/bin");
    assert.equal(result.started[0].pid, 777, "the pid is tracked for the kill path");

    delete process.env.BUGBOSS_PARENT_ONLY;
    cleanup();
  });
});
