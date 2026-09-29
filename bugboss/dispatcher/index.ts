// The dispatcher. Design spec: bugboss/docs/architecture.md, Job 3, plus
// "The agent boundary" for the child environment.
//
// One question, every 30 seconds: does every incident that should have an
// agent have a live one? Both sides of that comparison are in this process,
// so there is nothing to reconcile. No task ARNs, no clientToken, no
// ListTasks that cannot see a finished task, no orphan sweep, no lease.
//
// Everything else here is what co-location and a wall-clock bound force: an
// allowlisted child environment, a kill backstop for the in-container deadline,
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
import { buildChildEnv, hasAwsCredentialPath } from "./env";
import type { AgentProcess, AgentSpawnContext, SpawnAgent } from "./spawn";
import { makeAlarm, makeLog } from "../logging";

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

const log = makeLog("dispatcher");

const alarm = makeAlarm("dispatcher");

/**
 * How long an agent has to have been gone before its resume is announced.
 *
 * A deploy or a container restart puts an agent back within a tick or two,
 * and saying so every time would be noise on a routine event. A gap longer
 * than this is not routine: the run was killed and nothing picked it up for
 * minutes, which is the shape of the three real runs that died at the same
 * lifecycle position and were never noticed. The resume was always automatic;
 * what was missing is that it was silent, so a thread whose last message was
 * true read as patience while nothing was happening.
 */
export const RESUME_NOTICE_SECONDS = 300;

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  maxConcurrentAgents: 15,
  tickSeconds: 30,
  // A day. An incident waits on a review, a merge and a deploy, and those
  // are measured in hours, so a half-hour ceiling killed agents mid-wait.
  agentTimeoutSeconds: 86_400,
  maxAttempts: 3,
  staleAfterSeconds: 86_400,
};

/**
 * The marker the stale sweep leaves, and the reason it is an `incident_action`
 * row rather than a column or a counter.
 *
 * It has to be persisted, because every merge to ops `main` restarts this
 * container and a sweep counted from process start would re-post on every
 * deploy. And it has to be *activity*, because the clock the sweep reads
 * already includes `incident_action`: writing the marker is what resets that
 * clock, so one sweep cannot fire twice and a swept incident cannot bounce
 * back here an hour later however quickly an agent parks it on a person
 * again. The next sweep is a full threshold away by construction, with no
 * separate suppression to keep in step with it.
 */
export const STALE_SWEPT_ACTION = "stale_swept";

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
  /** Outbound tokens a child may hold. The composition root decides. */
  childCredentials?: Record<string, string | undefined>;
  /**
   * Says something in an incident's thread. Optional, because the E2E and
   * the unit tests run a dispatcher with no Slack at all -- but absent in
   * prod it would make the one event this exists to surface silent again,
   * so the composition root passing nothing is worth noticing.
   */
  postNotice?: (incidentId: string, text: string) => Promise<void>;
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
  /** Incidents that had gone quiet too long and were handed back this tick. */
  swept: string[];
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

interface StaleRow {
  id: string;
  owner: IncidentOwner;
  lastActivityAt: number;
  /** Times this incident has been swept before. Read out of the markers. */
  sweeps: number;
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

/**
 * Every open incident, with the last moment anything at all happened on it.
 *
 * Not scoped to an owner, unlike `ELIGIBLE_SQL`, and that is the whole point:
 * `owner = 'human'` is precisely the state nothing was watching.
 *
 * "Anything" is deliberately wider than `lastStartedAt`. A reply and a
 * hand-off each move an incident without launching an agent, so a clock that
 * watched launches alone would read a running conversation as silence — and,
 * the other way round, would call an incident stale while its agent was
 * mid-run, since a run may last a day. The live-agent case is handled by the
 * `running` map rather than here, because a row cannot show it.
 *
 * `firstSignalAt` is the floor. It is NOT NULL, so a freshly opened incident
 * that nothing has touched yet still has a real age rather than reading as
 * quiet since the epoch.
 */
const STALE_SQL = `
  SELECT i.id AS id,
         i.owner AS owner,
         MAX(
           i.firstSignalAt,
           COALESCE(i.lastStartedAt, 0),
           COALESCE((SELECT MAX(r.receivedAt) FROM thread_reply r
                      WHERE r.incidentId = i.id), 0),
           COALESCE((SELECT MAX(a.at) FROM incident_action a
                      WHERE a.incidentId = i.id), 0)
         ) AS lastActivityAt,
         (SELECT COUNT(*) FROM incident_action a
           WHERE a.incidentId = i.id
             AND a.action = '${STALE_SWEPT_ACTION}') AS sweeps
    FROM incident i
   WHERE i.status NOT IN ('CLOSED', 'MERGED')
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

/** Minutes, because a gap worth announcing is never seconds. */
export const resumeNotice = (deadSeconds: number): string => {
  const minutes = Math.round(deadSeconds / 60);
  const span = minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 6) / 10}h`;
  return [
    `The agent on this incident stopped without finishing and was gone for ${span}.`,
    "Nothing was happening here in that time, whatever the last message says.",
    "I have started it again; it will re-check anything time-sensitive before it continues.",
  ].join(" ");
};

/**
 * What the sweep says. Two things, plainly: how long this has been silent,
 * and what is about to happen about it. The silence is the finding, so it
 * leads — a person reading their own thread has no way to tell a day of
 * quiet deliberation from a day of nothing running at all, which is the
 * whole reason these incidents went unnoticed.
 */
export const staleNotice = (
  quietSeconds: number,
  handedBack: boolean,
  sweep: number,
): string => {
  const hours = Math.round(quietSeconds / 3600);
  const span = hours < 48 ? `${hours}h` : `${Math.round(hours / 2.4) / 10}d`;
  return [
    `Nothing has happened on this incident for ${span}: no agent ran, nobody replied, and its status did not move.`,
    handedBack
      ? "It was owned by a person, which takes it out of the list agents are dispatched from, so I have handed it back to an agent. One will pick it up within a tick."
      : "An agent owns it and one will be started on it within a tick.",
    sweep > 1
      ? `That is ${sweep} times now. If this is genuinely waiting on something, say it is yours and I will stop moving it.`
      : "If you are on this and do not want an agent touching it, say it is yours and I will stop it.",
  ].join(" ");
};

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
  private readonly childCredentials: Record<string, string | undefined>;
  private readonly childBaseEnv: Record<string, string | undefined>;
  private readonly postNotice: ((incidentId: string, text: string) => Promise<void>) | null;
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
    this.childCredentials = deps.childCredentials ?? {};
    this.childBaseEnv = deps.childBaseEnv ?? {};
    this.postNotice = deps.postNotice ?? null;
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
   * Serialized against itself. A tick awaits an S3 PUT before it records a
   * launch in `running`, so an overlapping tick would read the same row as
   * unclaimed and start a second child. Two children on one
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

    const swept = await this.sweepStale(this.now());

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
      swept,
      running: this.running.size,
      circuitOpen,
      settled: Promise.all(settling).then(() => undefined),
    };
  };

  /**
   * Nothing sits silent for a day.
   *
   * Every other watch this process keeps is reached through `owner = 'agent'`.
   * `ELIGIBLE_SQL` asks whether every incident that should have an agent has
   * a live one and defines "should" as that column, so an incident a person
   * owns is not late — it is not in the question. `agent_resumed_after_gap`
   * fires on a relaunch, which needs the same column. The `pending_wait`
   * nudge needs a live agent parked on `monitor(awaitingHuman)`. An incident
   * a person took, or was escalated to and never answered, is outside all
   * three, and seven open incidents reached 8 to 32 hours of total silence
   * there — each with somebody replying into a thread no agent was reading.
   *
   * So this asks the one question none of those do: has anything happened
   * here lately. It runs after the launch loop rather than before it, so an
   * incident this tick already relaunched is in `running` and is not also
   * reported quiet by the row it left behind.
   */
  private sweepStale = async (now: number): Promise<string[]> => {
    const staleMs = this.config.staleAfterSeconds * 1000;
    // Off, rather than everything-is-stale. `Number(undefined)` is NaN and a
    // misread env var could be either, and the failure mode of getting this
    // wrong is a post in every open thread at once.
    if (!Number.isFinite(staleMs) || staleMs <= 0) return [];

    const swept: string[] = [];
    for (const row of this.db.query<StaleRow>(STALE_SQL)) {
      // Work in progress the row cannot show: a run may last a day, so a
      // live agent's own launch timestamp ages past the threshold under it.
      if (this.running.has(row.id)) continue;
      const quietMs = now - row.lastActivityAt;
      if (quietMs < staleMs) continue;
      const quietSeconds = Math.round(quietMs / 1000);

      let handedBack: boolean;
      try {
        handedBack = await this.db.withWrite((db) => {
          // The marker goes in whatever the flip does. It is what stops this
          // firing again next tick, and an incident already at
          // `owner: 'agent'` still went quiet and still earns being told.
          db.prepare(
            `INSERT INTO incident_action
               (incidentId, actorKind, actorId, action, reason, at)
             VALUES (?, 'boss', NULL, ?, ?, ?)`,
          ).run(
            row.id,
            STALE_SWEPT_ACTION,
            `nothing happened for ${Math.round(quietSeconds / 3600)}h`,
            now,
          );
          return (
            db
              .prepare(
                `UPDATE incident SET owner = 'agent'
                   WHERE id = ? AND owner = 'human'
                     AND status NOT IN ('CLOSED', 'MERGED')`,
              )
              .run(row.id).changes > 0
          );
        });
      } catch (err) {
        alarm("stale_sweep_failed", {
          incidentId: row.id,
          quietSeconds,
          error: String(err),
          note: "the incident is still stuck and nobody was told; the next tick tries again",
        });
        continue;
      }

      swept.push(row.id);
      // Before the post, and committed before it, on the same rule the
      // closing report and `contact_human` follow: a container that dies
      // between the two stays quiet rather than saying it twice. The
      // hand-back is the part that actually recovers the incident, so it
      // must not be lost to a Slack call that failed.
      alarm("incident_stale", {
        incidentId: row.id,
        quietSeconds,
        owner: row.owner,
        handedBack,
        sweep: row.sweeps + 1,
        note: "no agent ran, no reply arrived and the status did not move for longer than the threshold",
      });

      if (!this.postNotice) {
        alarm("stale_notice_undeliverable", {
          incidentId: row.id,
          quietSeconds,
          note: "no thread poster is wired in, so nobody watching this incident was told it had stopped",
        });
        continue;
      }
      await this.postNotice(
        row.id,
        staleNotice(quietSeconds, handedBack, row.sweeps + 1),
      ).catch((err: unknown) =>
        alarm("stale_notice_failed", {
          incidentId: row.id,
          error: String(err),
        }),
      );
    }

    return swept;
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

    const token = this.mintToken(row.id);
    const deadlineAt = now + this.config.agentTimeoutSeconds * 1000;

    const env = buildChildEnv({
      base: this.childBaseEnv,
      credentials: this.childCredentials,
      incidentId: row.id,
      token,
      sessionRef: row.sessionRef,
      deadlineAt,
      attempt,
    });
    // The child resolves AWS through the container credential provider, so
    // the allowlist in env.ts has to carry that path. Dropping a name from
    // it would cost the agent Bedrock and surface a turn later as a model
    // call failing, with nothing pointing back at the environment.
    if (!hasAwsCredentialPath(env)) {
      alarm("child_has_no_aws_credentials", {
        incidentId: row.id,
        note: "no AWS credential path reached the child; it cannot call Bedrock",
      });
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
      searchIncidents: (args) => tools.searchIncidents(args),
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

    // Set by the catch below, and read by the then after it. A crash loop is
    // made of crashes: an exit code of zero inside the window is a short run,
    // not a failing one, and counting it was what let a rolling deploy walk
    // a freshly-launched incident to a crash-loop escalation in three
    // bounces. SIGTERM exits zero for exactly this reason.
    let failed = false;
    entry.done = run
      .catch((err) => {
        failed = true;
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

        // A crash loop dies quickly after starting *and* dies badly. A
        // deploy-killed agent was either running fine for a while or shut
        // down in good order; neither should escalate.
        const ranMs = exitedAt - entry.startedAt;
        const fast = !entry.killed && failed && ranMs < this.fastFailureMs;
        const failures = fast ? (this.fastFailures.get(row.id) ?? 0) + 1 : 0;
        if (fast) this.fastFailures.set(row.id, failures);
        else this.fastFailures.delete(row.id);

        log("agent_exited", {
          incidentId: row.id,
          attempt,
          pid: entry.pid,
          killed: entry.killed,
          failed,
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
    if (seconds < RESUME_NOTICE_SECONDS) return;

    // Loud on both channels, because they answer different questions. The
    // alarm is how an operator learns agents are dying; the thread is how the
    // person watching this one incident learns that the quiet they were
    // reading as progress was an agent that had not existed for an hour.
    alarm("agent_resumed_after_gap", {
      incidentId: row.id,
      deadSeconds: seconds,
      attempts: row.attempts,
      status: row.status,
      note: "the previous run stopped without finishing and nothing ran this incident in the meantime",
    });
    if (!this.postNotice) {
      alarm("resume_notice_undeliverable", {
        incidentId: row.id,
        deadSeconds: seconds,
        note: "no thread poster is wired in, so nobody watching this incident was told",
      });
      return;
    }
    await this.postNotice(row.id, resumeNotice(seconds)).catch((err: unknown) =>
      alarm("resume_notice_failed", { incidentId: row.id, error: String(err) }),
    );
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
