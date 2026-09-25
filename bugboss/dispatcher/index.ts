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
// The child's own grace, read rather than copied: the parent's backstop is
// defined relative to it, so a change there must move this too.
import { DEADLINE_GRACE_SECONDS } from "../agent/run";
import type { AgentCredentialProvider } from "./credentials";
import { buildChildEnv } from "./env";
import type { AgentProcess, AgentSpawnContext, SpawnAgent } from "./spawn";
import { makeAlarm } from "../alarm";

export * from "./credentials";
export * from "./env";
export * from "./spawn";

// `tsc` rejects a renamed or moved export outright, and the image is built
// with `tsc && esbuild`, so prod cannot ship one. tsx does not typecheck,
// though, so under it a rename arrives here as `undefined`, which makes
// killAt NaN; `now < NaN` is false, so the backstop reads as already expired
// and SIGKILLs every agent on its first tick. Fail at import instead.
if (!Number.isFinite(DEADLINE_GRACE_SECONDS) || DEADLINE_GRACE_SECONDS <= 0) {
  throw new Error(
    `agent/run.ts must export DEADLINE_GRACE_SECONDS as a positive number; got ${DEADLINE_GRACE_SECONDS}. The dispatcher's kill backstop is defined relative to it.`,
  );
}

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "dispatcher", event, ...data }));

const alarm = makeAlarm("dispatcher");

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
  /**
   * An exit sooner than this after launch is a crash rather than a run.
   * Defaults to two ticks, the shortest gap the dispatcher can even observe.
   */
  fastFailureSeconds?: number;
  /**
   * Launches on one incident within a single container lifetime before the
   * dispatcher gives up and escalates. Defaults to three times maxAttempts,
   * since a death slow enough to clear the fast-failure counter still did
   * some work and deserves more rope than a crash loop.
   */
  maxLaunches?: number;
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
  lastStartedAt: number | null;
  firstSignalAt: number;
}

/**
 * The statuses the agent still owns, so the statuses that must have a live
 * one. RESOLVED belongs here: `report_analysis` is the only exit from it and
 * it is the agent's to call, so an incident whose post-mortem was interrupted
 * by a restart needs relaunching like any other. Leaving it out stranded it at
 * `owner: 'agent'` with nothing to relaunch it and no path to a human, and it
 * is invisible to the escalated-and-unclaimed digest while owner stays agent.
 * `slack/relay.ts` holds the same list as AGENT_RUNNING_STATUSES.
 */
const AGENT_STATUSES: readonly IncidentStatus[] = [
  "INVESTIGATING",
  "FIXING",
  "RESOLVED",
];

// No ORDER BY: a priority order is a scheduler, and this is not one.
const ELIGIBLE_SQL = `
  SELECT id, status, sessionRef, attempts, lastStartedAt, firstSignalAt
  FROM incident
  WHERE status IN (${AGENT_STATUSES.map((s) => `'${s}'`).join(", ")})
    AND owner = 'agent'
`;

interface Entry {
  incidentId: string;
  pid: number;
  startedAt: number;
  phase: string;
  /** What the child got as BUGBOSS_DEADLINE_AT: its own soft deadline. */
  deadlineAt: number;
  /**
   * The parent's backstop, a tick later than the child's hard stop. The child
   * treats deadlineAt as soft, steers itself to write a handoff brief, and
   * aborts DEADLINE_GRACE_SECONDS later; killing at deadlineAt gave it one
   * tick of that window, so every timeout escalation handed a human the
   * placeholder brief instead of the agent's.
   */
  killAt: number;
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
    `It passed its wall-clock deadline after ${ranSeconds}s on attempt ${e.attempt}, did not hand off in the ${DEADLINE_GRACE_SECONDS}s it was given to, and was killed, so it never wrote a brief.`,
    "",
    "What I believe now: whatever the agent last posted in this thread.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown. It was still working when time ran out.",
    "Side effects: check the incident for PRs it opened before it died.",
    `Full transcript: session ${e.sessionRef ?? "none written yet"}.`,
  ].join("\n");

const crashLoopBrief = (
  row: EligibleRow,
  failures: number,
  fastFailureSeconds: number,
): string =>
  [
    "Escalated by the dispatcher. The agent did not hand off itself.",
    "",
    `Its last ${failures} launches each died within ${fastFailureSeconds}s of starting, which is a crash loop rather than an interrupted investigation, so relaunching stopped. Total launches to date: ${row.attempts}.`,
    "",
    "What I believe now: whatever the agent last posted in this thread.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown; each launch died before handing off.",
    "Side effects: check the incident for PRs an earlier launch opened.",
    `Full transcript: session ${row.sessionRef ?? "none written yet"}.`,
  ].join("\n");

const stalledBrief = (row: EligibleRow, launches: number): string =>
  [
    "Escalated by the dispatcher. The agent did not hand off itself.",
    "",
    `It has been launched ${launches} times on this incident since this container came up and has finished none of them, while dying slowly enough each time to not look like a crash loop. Something is ending the run just past the point where relaunching looks reasonable: throttling, memory, credentials expiring, or a session it cannot replay. Total launches to date, this container and every earlier one: ${row.attempts}.`,
    "",
    "What I believe now: whatever the agent last posted in this thread.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown; no launch got far enough to hand off.",
    "Side effects: check the incident for PRs an earlier launch opened.",
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
  private readonly fastFailureMs: number;
  private readonly maxLaunches: number;
  private readonly now: () => number;

  /** The live side of the comparison. In-process, so it is simply true. */
  private readonly running = new Map<string, Entry>();
  /** When we last saw an agent exit, for the resumed_after figure. */
  private readonly lastExitAt = new Map<string, number>();
  /**
   * Launches that died almost immediately, in a row. Deliberately not
   * persisted: a container that came back up healthy is not evidence that
   * the agent is crashing, and a crash-looping container is ECS service
   * health's alarm rather than this counter's.
   */
  private readonly fastFailures = new Map<string, number>();
  /**
   * Launches per incident, total rather than consecutive, and in memory for
   * the same reason as fastFailures: a restart is not evidence about the
   * agent. `maxAttempts` bounds only deaths fast enough to look like a crash
   * loop, and every exit slower than that *clears* that counter, so an agent
   * dying just past the window — throttling, OOM, credentials expiring, a 400
   * on a replay it cannot get through — was relaunched every tick for as long
   * as the incident stayed open. The persisted `attempts` column cannot do
   * this job: it counts container restarts too, and those are routine.
   */
  private readonly launches = new Map<string, number>();
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
    this.fastFailureMs =
      (deps.fastFailureSeconds ?? deps.config.tickSeconds * 2) * 1000;
    this.maxLaunches = deps.maxLaunches ?? deps.config.maxAttempts * 3;
    this.now = deps.now ?? Date.now;
  }

  start = (): void => {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        alarm("tick_failed", { error: String(err) }),
      );
    }, this.config.tickSeconds * 1000);
    // The overlap guard lives in tick() itself, not here: dispatchOnce is
    // public and runs the same body against a live interval.
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

  /**
   * Serialized against itself. A tick awaits an S3 PUT and an STS call before
   * it records a launch in `running`, so an overlapping tick would read the
   * same row as unclaimed and start a second child. Two children on one
   * incident both hold valid tokens and both whole-file PUT the same session
   * transcript, so they overwrite each other's turns. The single-writer
   * guarantee the whole resume design rests on is this map, and the map is
   * only authoritative if ticks cannot interleave.
   */
  tick = async (): Promise<TickResult> => {
    const mine = this.ticking.then(() => this.runTick());
    this.ticking = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  };

  private ticking: Promise<void> = Promise.resolve();

  private runTick = async (): Promise<TickResult> => {
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

      const failures = this.fastFailures.get(row.id) ?? 0;
      if (failures >= this.config.maxAttempts) {
        const ok = await this.escalate(
          row.id,
          `${failures} consecutive launches died within ${this.fastFailureMs / 1000}s`,
          crashLoopBrief(row, failures, this.fastFailureMs / 1000),
        );
        // Cleared either way. A successful escalation flipped the incident to
        // a human, and if they hand it back the agent earns a fresh three
        // launches rather than being re-escalated on the first tick. A failed
        // one must fall back to relaunching: keeping the counter at the
        // ceiling retried the same failing escalation every tick for as long
        // as the incident stayed open, which never resolved and never said so.
        this.fastFailures.delete(row.id);
        if (ok) escalated.push(row.id);
        else
          alarm("crash_loop_escalation_failed", {
            incidentId: row.id,
            failures,
            note: "nobody was told; relaunching instead of retrying the escalation",
          });
        continue;
      }

      const launches = this.launches.get(row.id) ?? 0;
      if (launches >= this.maxLaunches) {
        const ok = await this.escalate(
          row.id,
          `${launches} launches on this incident without finishing one`,
          stalledBrief(row, launches),
        );
        // Cleared on the same rule as fastFailures, and here it is what keeps
        // hand-back working: a human replying in the thread flips owner back
        // to agent, and a ceiling that outlived the escalation would bounce
        // the incident straight back at them on the next tick.
        this.launches.delete(row.id);
        if (ok) escalated.push(row.id);
        else
          alarm("stalled_escalation_failed", {
            incidentId: row.id,
            launches,
            note: "nobody was told; relaunching instead of retrying the escalation",
          });
        continue;
      }

      if (this.running.size >= this.config.maxConcurrentAgents) {
        circuitOpen = true;
        continue;
      }

      // One incident's bad launch must not stall the rest of the tick. A
      // launch that never started is a fast failure by definition, so a
      // persistent one escalates rather than retrying every 30s forever.
      let entry: Entry;
      try {
        entry = await this.launch(row, now);
      } catch (err) {
        const failures = (this.fastFailures.get(row.id) ?? 0) + 1;
        this.fastFailures.set(row.id, failures);
        alarm("launch_failed", {
          incidentId: row.id,
          error: String(err),
          consecutiveFastFailures: failures,
        });
        continue;
      }
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
      db.prepare(
        "UPDATE incident SET attempts = attempts + 1, lastStartedAt = ? WHERE id = ?",
      ).run(now, row.id);
    });
    this.launches.set(row.id, (this.launches.get(row.id) ?? 0) + 1);

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
      killAt:
        deadlineAt +
        (DEADLINE_GRACE_SECONDS + this.config.tickSeconds) * 1000,
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
      killAt: entry.killAt,
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
        // A child the dispatcher killed exits on a signal, which is a
        // rejection now. That is not an agent failure and it already alarmed
        // as agent_deadline_exceeded, so it would be the same event twice
        // under a name that points at the wrong component.
        if (entry.killed) return;
        alarm("agent_failed", {
          incidentId: row.id,
          attempt,
          error: String(err),
        });
      })
      .then(() => {
        if (this.running.get(row.id) === entry) this.running.delete(row.id);
        const exitedAt = this.now();
        this.lastExitAt.set(row.id, exitedAt);

        // A crash loop dies quickly after starting; a deploy-killed agent was
        // running fine for a while. Only the first should ever escalate.
        const ranMs = exitedAt - entry.startedAt;
        const fast = !entry.killed && ranMs < this.fastFailureMs;
        const failures = fast ? (this.fastFailures.get(row.id) ?? 0) + 1 : 0;
        if (fast) this.fastFailures.set(row.id, failures);
        else this.fastFailures.delete(row.id);

        log("agent_exited", {
          incidentId: row.id,
          attempt,
          pid: entry.pid,
          killed: entry.killed,
          ranSeconds: Math.round(ranMs / 1000),
          consecutiveFastFailures: failures,
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
      if (entry.killed || now < entry.killAt) continue;
      entry.killed = true;
      killed.push(entry.incidentId);
      const ranSeconds = Math.round((now - entry.startedAt) / 1000);
      alarm("agent_deadline_exceeded", {
        incidentId: entry.incidentId,
        pid: entry.pid,
        ranSeconds,
        deadlineAt: entry.deadlineAt,
        graceSeconds: DEADLINE_GRACE_SECONDS,
      });
      // Kill first, then escalate: an agent that used its grace already called
      // hand_off, and escalate re-reads owner, so the placeholder brief is
      // suppressed rather than racing the real one.
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
    if (!AGENT_STATUSES.includes(row.status)) return false;

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
    // Exact when we watched the exit ourselves. After a container restart we
    // did not, and a SIGKILLed process writes no exit time, so the best
    // available is when that run started: still an upper bound, but bounded
    // by the agent's own lifecycle rather than by the incident's age.
    const since =
      this.lastExitAt.get(row.id) ?? row.lastStartedAt ?? row.firstSignalAt;
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
