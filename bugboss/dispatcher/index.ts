// The dispatcher. Design spec: docs/bugboss/design.md, Job 3, plus
// Authentication for the child environment.
//
// One question, every 30 seconds: does every incident that should have an
// agent have a live one? Both sides of that comparison are in this process,
// so there is nothing to reconcile. No task ARNs, no clientToken, no
// ListTasks that cannot see a finished task, no orphan sweep, no lease.
//
// Everything else here is what co-location and a wall-clock bound force: a
// scrubbed child environment, a kill backstop for the in-container deadline,
// a relaunch limit, and a ceiling that is a circuit breaker rather than a
// scheduler. There is deliberately no queue and no priority order.

import type Database from "better-sqlite3";

import type {
  Directive,
  DispatcherConfig,
  IncidentOwner,
  IncidentStatus,
  RunningAgent,
  ToolApi,
} from "../types";
import type { AgentCredentialProvider } from "./credentials";
import { buildChildEnv } from "./env";
import type { AgentProcess, AgentSpawnContext, SpawnAgent } from "./spawn";

export * from "./credentials";
export * from "./env";
export * from "./spawn";

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "dispatcher", event, ...data }));

const alarm = (event: string, data?: Record<string, unknown>) =>
  console.error(
    JSON.stringify({ component: "dispatcher", level: "error", event, ...data }),
  );

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  maxConcurrentAgents: 15,
  tickSeconds: 30,
  agentTimeoutSeconds: 1800,
  maxAttempts: 3,
};

/** The slice of the database layer the dispatcher uses. `Db` satisfies it. */
export interface DispatcherDb {
  query<T = unknown>(sql: string, params?: unknown[]): T[];
  get<T = unknown>(sql: string, params?: unknown[]): T | undefined;
  withWrite<T>(fn: (db: Database.Database) => T): Promise<T>;
}

export interface DispatcherDeps {
  db: DispatcherDb;
  config: DispatcherConfig;
  spawn: SpawnAgent;
  /** Chunk 4's per-incident tool API. Also the dispatcher's escalation path. */
  toolApiFor: (incidentId: string) => ToolApi;
  /** Bearer for the tool API, scoped to one incident. */
  mintToken: (incidentId: string) => string;
  /** Temporary credentials for the read-only agent role, fresh per launch. */
  credentials: AgentCredentialProvider;
  /** Outbound tokens a child may hold. The composition root decides. */
  childCredentials?: Record<string, string | undefined>;
  /** Process essentials for the child; pickBaseEnv(process.env) in prod. */
  childBaseEnv?: Record<string, string | undefined>;
  now?: () => number;
}

export interface TickResult {
  started: RunningAgent[];
  /** Incidents handed to a human this tick, by either escalation path. */
  escalated: string[];
  /** Incidents whose child was killed for passing its deadline. */
  killed: string[];
  running: number;
  /** The ceiling stopped a launch. Something is wrong; a human should look. */
  circuitOpen: boolean;
  /** Resolves when everything this tick started has exited. */
  settled: Promise<void>;
}

interface EligibleRow {
  id: string;
  status: IncidentStatus;
  sessionRef: string | null;
  attempts: number;
  fixingAt: number | null;
  firstSignalAt: number;
}

// No ORDER BY: a priority order is a scheduler, and this is not one.
const ELIGIBLE_SQL = `
  SELECT id, status, sessionRef, attempts, fixingAt, firstSignalAt
  FROM incident
  WHERE status IN ('INVESTIGATING', 'FIXING') AND owner = 'agent'
`;

interface Entry {
  incidentId: string;
  pid: number;
  startedAt: number;
  phase: string;
  deadlineAt: number;
  sessionRef: string | null;
  attempt: number;
  proc: AgentProcess | null;
  killed: boolean;
  done: Promise<void>;
}

const toRunningAgent = (e: Entry): RunningAgent => ({
  incidentId: e.incidentId,
  pid: e.pid,
  startedAt: e.startedAt,
  phase: e.phase,
});

const deadlineBrief = (e: Entry, ranSeconds: number): string =>
  [
    "Escalated by the dispatcher. The agent did not hand off itself.",
    "",
    `It passed its wall-clock deadline after ${ranSeconds}s on attempt ${e.attempt} and was killed, so it never wrote a brief.`,
    "",
    "What I believe now: whatever the agent last posted in this thread.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown. It was still working when time ran out.",
    "Side effects: check the incident for PRs it opened before it died.",
    `Full transcript: session ${e.sessionRef ?? "none written yet"}.`,
  ].join("\n");

const attemptsBrief = (row: EligibleRow, maxAttempts: number): string =>
  [
    "Escalated by the dispatcher. The agent did not hand off itself.",
    "",
    `It has been launched ${row.attempts} times and has not reached a terminal state, so relaunching stopped at the limit of ${maxAttempts} rather than crash-looping.`,
    "",
    "What I believe now: whatever the agent last posted in this thread.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown; each attempt died before handing off.",
    "Side effects: check the incident for PRs an earlier attempt opened.",
    `Full transcript: session ${row.sessionRef ?? "none written yet"}.`,
  ].join("\n");

export class Dispatcher {
  private readonly db: DispatcherDb;
  private readonly config: DispatcherConfig;
  private readonly spawn: SpawnAgent;
  private readonly toolApiFor: (incidentId: string) => ToolApi;
  private readonly mintToken: (incidentId: string) => string;
  private readonly credentials: AgentCredentialProvider;
  private readonly childCredentials: Record<string, string | undefined>;
  private readonly childBaseEnv: Record<string, string | undefined>;
  private readonly now: () => number;

  /** The live side of the comparison. In-process, so it is simply true. */
  private readonly running = new Map<string, Entry>();
  /** When we last saw an agent exit, for the resumed_after figure. */
  private readonly lastExitAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: DispatcherDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.spawn = deps.spawn;
    this.toolApiFor = deps.toolApiFor;
    this.mintToken = deps.mintToken;
    this.credentials = deps.credentials;
    this.childCredentials = deps.childCredentials ?? {};
    this.childBaseEnv = deps.childBaseEnv ?? {};
    this.now = deps.now ?? Date.now;
  }

  start = (): void => {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        alarm("tick_failed", { error: String(err) }),
      );
    }, this.config.tickSeconds * 1000);
    this.timer.unref();
    log("started", {
      tickSeconds: this.config.tickSeconds,
      maxConcurrentAgents: this.config.maxConcurrentAgents,
    });
  };

  /**
   * Stops ticking. Children are left alone: a deploy kills the container and
   * every child with it, each losing at most its turn in progress, and the
   * first tick after boot resumes them from their sessions.
   */
  stop = (): void => {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log("stopped", { running: this.running.size });
  };

  list = (): RunningAgent[] => [...this.running.values()].map(toRunningAgent);

  /** Waits for everything currently running. For tests and shutdown. */
  drain = async (): Promise<void> => {
    await Promise.all([...this.running.values()].map((e) => e.done));
  };

  tick = async (): Promise<TickResult> => {
    const now = this.now();
    const expired = await this.enforceDeadlines(now);

    const eligible = this.db.query<EligibleRow>(ELIGIBLE_SQL);
    const started: RunningAgent[] = [];
    const escalated = [...expired.escalated];
    const settling: Promise<void>[] = [];
    let circuitOpen = false;

    for (const row of eligible) {
      const live = this.running.get(row.id);
      if (live) {
        live.phase = row.status;
        continue;
      }

      if (row.attempts >= this.config.maxAttempts) {
        const ok = await this.escalate(
          row.id,
          `${row.attempts} agent attempts without a terminal state`,
          attemptsBrief(row, this.config.maxAttempts),
        );
        if (ok) escalated.push(row.id);
        continue;
      }

      if (this.running.size >= this.config.maxConcurrentAgents) {
        circuitOpen = true;
        continue;
      }

      const entry = await this.launch(row, now);
      started.push(toRunningAgent(entry));
      settling.push(entry.done);
    }

    if (circuitOpen) {
      alarm("circuit_breaker_open", {
        running: this.running.size,
        maxConcurrentAgents: this.config.maxConcurrentAgents,
        eligible: eligible.length,
        note: "dispatch stopped at the ceiling; nothing is queued, and hitting this means something is wrong",
      });
    }

    return {
      started,
      escalated,
      killed: expired.killed,
      running: this.running.size,
      circuitOpen,
      settled: Promise.all(settling).then(() => undefined),
    };
  };

  private launch = async (row: EligibleRow, now: number): Promise<Entry> => {
    const attempt = row.attempts + 1;
    await this.db.withWrite((db) => {
      db.prepare("UPDATE incident SET attempts = attempts + 1 WHERE id = ?").run(
        row.id,
      );
    });

    if (row.sessionRef) await this.emitResumedAfter(row, now);

    const aws = await this.credentials(row.id);
    const token = this.mintToken(row.id);
    const deadlineAt = now + this.config.agentTimeoutSeconds * 1000;

    if (aws.expiresAt && aws.expiresAt < deadlineAt) {
      log("credentials_expire_before_deadline", {
        incidentId: row.id,
        expiresAt: aws.expiresAt,
        deadlineAt,
      });
    }

    const { env, stripped } = buildChildEnv({
      base: this.childBaseEnv,
      credentials: this.childCredentials,
      aws,
      incidentId: row.id,
      token,
      sessionRef: row.sessionRef,
      deadlineAt,
      attempt,
    });
    if (stripped.length > 0) {
      alarm("child_env_stripped", { incidentId: row.id, stripped });
    }

    const entry: Entry = {
      incidentId: row.id,
      pid: 0,
      startedAt: now,
      phase: row.status,
      deadlineAt,
      sessionRef: row.sessionRef,
      attempt,
      proc: null,
      killed: false,
      done: Promise.resolve(),
    };
    this.running.set(row.id, entry);

    const tools = this.toolApiFor(row.id);
    const ctx: AgentSpawnContext = {
      reportRootCause: (args) => tools.reportRootCause(args),
      reportImpact: (args) => tools.reportImpact(args),
      reportResolved: (args) => tools.reportResolved(args),
      reportAnalysis: (args) => tools.reportAnalysis(args),
      handOff: (args) => tools.handOff(args),
      getIncident: () => tools.getIncident(),
      incidentId: row.id,
      sessionRef: row.sessionRef,
      attempt,
      deadlineAt,
      token,
      env,
      register: (proc) => {
        entry.pid = proc.pid;
        entry.proc = proc;
        if (entry.killed) proc.kill();
      },
    };

    log("agent_started", {
      incidentId: row.id,
      attempt,
      resumed: row.sessionRef !== null,
      deadlineAt,
    });

    // Called synchronously so a child registers its pid before this returns.
    let run: Promise<void>;
    try {
      run = this.spawn(ctx);
    } catch (err) {
      run = Promise.reject(err);
    }

    entry.done = run
      .catch((err) => {
        alarm("agent_failed", {
          incidentId: row.id,
          attempt,
          error: String(err),
        });
      })
      .then(() => {
        if (this.running.get(row.id) === entry) this.running.delete(row.id);
        this.lastExitAt.set(row.id, this.now());
        log("agent_exited", {
          incidentId: row.id,
          attempt,
          pid: entry.pid,
          killed: entry.killed,
        });
      });

    return entry;
  };

  private enforceDeadlines = async (
    now: number,
  ): Promise<{ killed: string[]; escalated: string[] }> => {
    const killed: string[] = [];
    const escalated: string[] = [];
    for (const entry of [...this.running.values()]) {
      if (entry.killed || now < entry.deadlineAt) continue;
      entry.killed = true;
      killed.push(entry.incidentId);
      const ranSeconds = Math.round((now - entry.startedAt) / 1000);
      alarm("agent_deadline_exceeded", {
        incidentId: entry.incidentId,
        pid: entry.pid,
        ranSeconds,
      });
      entry.proc?.kill();
      const ok = await this.escalate(
        entry.incidentId,
        `wall-clock deadline of ${this.config.agentTimeoutSeconds}s expired`,
        deadlineBrief(entry, ranSeconds),
      );
      if (ok) escalated.push(entry.incidentId);
    }
    return { killed, escalated };
  };

  /**
   * Escalation and takeover are the same operation, so this is `hand_off`
   * called on the agent's behalf rather than a second path into the state
   * machine. A no-op if the agent already handed off, closed, or was merged.
   */
  private escalate = async (
    incidentId: string,
    reason: string,
    brief: string,
  ): Promise<boolean> => {
    const row = this.db.get<{ status: IncidentStatus; owner: IncidentOwner }>(
      "SELECT status, owner FROM incident WHERE id = ?",
      [incidentId],
    );
    if (!row || row.owner !== "agent") return false;
    if (row.status !== "INVESTIGATING" && row.status !== "FIXING") return false;

    try {
      await this.toolApiFor(incidentId).handOff({ reason, brief });
      log("escalated", { incidentId, reason });
      return true;
    } catch (err) {
      alarm("escalation_failed", { incidentId, reason, error: String(err) });
      return false;
    }
  };

  private emitResumedAfter = async (
    row: EligibleRow,
    now: number,
  ): Promise<void> => {
    // Precise when we watched the exit ourselves. After a container restart
    // we did not, so fall back to the incident's last transition: an upper
    // bound on the gap, which errs toward making the agent re-check.
    const since =
      this.lastExitAt.get(row.id) ?? row.fixingAt ?? row.firstSignalAt;
    const seconds = Math.max(0, Math.round((now - since) / 1000));
    if (seconds < this.config.tickSeconds) return;
    await this.emitDirective(row.id, { type: "resumed_after", seconds });
  };

  private emitDirective = async (
    incidentId: string,
    directive: Directive,
  ): Promise<void> => {
    await this.db.withWrite((db) => {
      db.prepare(
        "INSERT INTO pending_directive (incidentId, payload, createdAt) VALUES (?, ?, ?)",
      ).run(incidentId, JSON.stringify(directive), this.now());
    });
  };
}

export const createDispatcher = (deps: DispatcherDeps): Dispatcher =>
  new Dispatcher(deps);
