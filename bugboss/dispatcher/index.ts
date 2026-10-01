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
  IncidentStatus,
  RunningAgent,
  ToolApi,
} from "../types";
// The child's own grace, read rather than copied: the parent's backstop is
// defined relative to it, so a change there must move this too.
import { DEADLINE_GRACE_SECONDS, INCIDENT_AGENT_MAX_TURNS } from "../agent/run";
import { emptyTrash, sweepWorkspaces } from "../agent/workspace";
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
 * How long an agent has to have been gone before its resume alarms.
 *
 * A container restart puts an agent back within a tick or two, and alarming
 * on that would be noise on a routine event. A gap longer than this means the
 * run was killed and nothing picked it up for minutes, which is the shape of
 * the three real runs that died at the same lifecycle position and were never
 * noticed. Operators need to hear about that; the thread does not, because
 * the resume is automatic and the agent is told through `resumed_after`.
 */
export const RESUME_ALARM_SECONDS = 300;

/**
 * How long an incident the dispatcher gave up on stays unrunnable.
 *
 * Long enough that a crash loop is not a busy loop, short enough that a
 * container which has come back healthy picks the work up again without
 * waiting for a person. Nothing here is a permanent verdict: the reasons the
 * dispatcher parks an incident are all "not now".
 */
export const PARK_COOLDOWN_SECONDS = 3600;

/** How long a resume waits on the session read before measuring without it. */
export const SESSION_READ_TIMEOUT_MS = 5000;

/**
 * How long an incident may go with nothing at all happening to it.
 *
 * A day, because what is being measured is a conversation between an agent, a
 * reviewer and a deploy, and a quiet morning in the middle of one is normal.
 * A whole quiet day is not: every open incident is either being worked or
 * waiting on somebody, and both of those produce something inside a day.
 */
export const STALE_AFTER_SECONDS = 86_400;

/**
 * The `incident_action` the sweep writes, which is also the only thing that
 * stops it firing again. See `sweepStale` for why those are the same row.
 */
export const STALE_SWEPT_ACTION = "stale_swept";

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  maxConcurrentAgents: 15,
  tickSeconds: 30,
  // A day. An incident waits on a review, a merge and a deploy, and those
  // are measured in hours, so a half-hour ceiling killed agents mid-wait.
  agentTimeoutSeconds: 86_400,
  // The bound that counts work rather than time, and the one a restart does
  // not refill. See INCIDENT_AGENT_MAX_TURNS in agent/run.ts for the number.
  agentMaxTurns: INCIDENT_AGENT_MAX_TURNS,
  maxAttempts: 3,
  staleAfterSeconds: STALE_AFTER_SECONDS,
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
  /** Outbound tokens a child may hold. The composition root decides. */
  childCredentials?: Record<string, string | undefined>;
  /**
   * Says something in an incident's thread. Optional, because the E2E and
   * the unit tests run a dispatcher with no Slack at all -- but absent in
   * prod it would make the one event this exists to surface silent again,
   * so the composition root passing nothing is worth noticing.
   */
  postNotice?: (incidentId: string, text: string) => Promise<void>;
  /**
   * The newest timestamp in an incident's synced session, or null. Read on a
   * resume the dispatcher did not watch exit, to learn when the agent was
   * last working. Optional for the same reason as postNotice; without it the
   * gap falls back to what the database recorded.
   */
  lastSessionEventAt?: (sessionRef: string) => Promise<number | null>;
  /** Process essentials for the child; pickBaseEnv(process.env) in prod. */
  childBaseEnv?: Record<string, string | undefined>;
  /**
   * An exit sooner than this after launch is a crash rather than a run.
   * Defaults to two ticks, the shortest gap the dispatcher can even observe.
   */
  fastFailureSeconds?: number;
  /**
   * Launches on one incident before the dispatcher gives up and escalates.
   * Defaults to three times maxAttempts, since a death slow enough to clear
   * the fast-failure counter still did some work and deserves more rope than
   * a crash loop. Counted from the last time it gave up rather than from
   * container start, because giving up parks the incident and that park
   * expires into another go.
   */
  maxLaunches?: number;
  /** How long a parked incident stays unrunnable before it is tried again. */
  parkCooldownSeconds?: number;
  /**
   * Where agents keep their workspaces, which outlive the task. Given, the
   * dispatcher deletes the ones whose incidents closed or were merged; absent,
   * as in tests that run no real agent, it leaves the filesystem alone.
   */
  workRoot?: string;
  now?: () => number;
}

export interface TickResult {
  started: RunningAgent[];
  /** Incidents escalated this tick, by either escalation path. */
  escalated: string[];
  /** Incidents whose child was killed for passing its deadline. */
  killed: string[];
  running: number;
  /** The ceiling stopped a launch. Something is wrong; a human should look. */
  circuitOpen: boolean;
  /**
   * Incidents that had gone quiet long enough for the sweep to say so. Not
   * all of them were made runnable: a spent turn budget is announced and left
   * waiting. See `sweepStale`.
   */
  swept: string[];
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
 * The statuses an open incident is driven through, so the statuses that must
 * have a live agent. RESOLVED belongs here: `report_analysis` is the only
 * exit from it and it is the agent's to call, so an incident whose
 * post-mortem was interrupted by a restart needs relaunching like any other.
 * Leaving it out stranded it with nothing to relaunch it.
 * `slack/relay.ts` holds the same list as AGENT_RUNNING_STATUSES.
 */
const AGENT_STATUSES: readonly IncidentStatus[] = [
  "INVESTIGATING",
  "FIXING",
  "RESOLVED",
];

// No ORDER BY: a priority order is a scheduler, and this is not one.
const ELIGIBLE_SQL = `
  SELECT i.id AS id, i.status AS status, i.sessionRef AS sessionRef,
         i.attempts AS attempts, i.lastStartedAt AS lastStartedAt,
         i.firstSignalAt AS firstSignalAt
  FROM incident i
  LEFT JOIN incident_wait w ON w.incidentId = i.id
  WHERE i.status IN (${AGENT_STATUSES.map((s) => `'${s}'`).join(", ")})
    AND (w.incidentId IS NULL OR (w.wakeAt IS NOT NULL AND w.wakeAt <= ?))
`;

interface StaleRow {
  id: string;
  status: IncidentStatus;
  /** The most recent moment anything at all touched this incident. */
  lastActivityAt: number;
  /** Sweeps already recorded, so the alarm can say this is not the first. */
  sweeps: number;
  /** SQLite has no boolean: 1 when an `incident_wait` row exists. */
  parked: number;
  /**
   * The wait's `liftsOnReply`, or NULL when there is no wait row to read it
   * from. 0 is the one value the sweep must not lift; see `sweepStale`.
   */
  liftsOnReply: number | null;
}

// Deliberately wider than `lastStartedAt`. A reply and an escalation each
// move an incident without launching an agent, so a clock watching launches
// alone reads a live conversation as silence -- and, the other way round,
// would call an incident stale while its agent was mid-run, since a run may
// last a day. `firstSignalAt` is the floor and is NOT NULL, so a freshly
// opened incident has a real age rather than reading as quiet since 1970.
//
// Parking counts, and has to. Deciding to wait is something happening, and
// without it the two mechanisms fight: an incident quiet for a day that then
// crash-loops is parked by the ceiling and swept on the very next tick,
// which deletes the wait and relaunches it straight back into the crash. The
// clock has to start when the wait started, so what the sweep answers is
// "has this wait itself gone unanswered too long" rather than "was this
// incident quiet before anyone decided to wait".
const STALE_SQL = `
  SELECT i.id AS id, i.status AS status,
         MAX(
           i.firstSignalAt,
           COALESCE(i.lastStartedAt, 0),
           COALESCE((SELECT MAX(receivedAt) FROM thread_reply
                      WHERE incidentId = i.id), 0),
           COALESCE((SELECT MAX(at) FROM incident_action
                      WHERE incidentId = i.id), 0),
           COALESCE(w.startedAt, 0)
         ) AS lastActivityAt,
         (SELECT COUNT(*) FROM incident_action
           WHERE incidentId = i.id AND action = '${STALE_SWEPT_ACTION}')
           AS sweeps,
         (w.incidentId IS NOT NULL) AS parked,
         w.liftsOnReply AS liftsOnReply
  FROM incident i
  LEFT JOIN incident_wait w ON w.incidentId = i.id
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
   * treats deadlineAt as soft, steers itself to write a brief, and
   * aborts DEADLINE_GRACE_SECONDS later; killing at deadlineAt gave it one
   * tick of that window, so every timeout escalation handed a human the
   * placeholder brief instead of the agent's.
   */
  killAt: number;
  sessionRef: string | null;
  attempt: number;
  proc: AgentProcess | null;
  killed: boolean;
  /**
   * This run has already escalated, so the deadline must not escalate over
   * the top of it.
   *
   * `owner` used to carry this without anyone naming it: the agent's own
   * `hand_off` set it to human and the dispatcher's escalate re-read it and
   * became a no-op. Deleting the column took the suppression with it, and
   * the result was two briefs on a wedged agent -- its own, then a
   * dispatcher placeholder claiming it had said nothing.
   *
   * Per-run and in memory by nature: the question is whether *this child*
   * spoke, and a restart is a new child that will write its own brief.
   */
  escalated: boolean;
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
    // Never claims the agent said nothing. The suppression below means this
    // brief should not be reachable at all once it has, but a sentence that
    // asserts something the code can check is one wrong suppression away from
    // the system contradicting itself in the thread, directly under the
    // agent's own brief.
    "Escalated by the dispatcher, which killed the agent at its deadline.",
    "",
    `It passed its wall-clock deadline after ${ranSeconds}s on attempt ${e.attempt}, did not finish in the ${DEADLINE_GRACE_SECONDS}s it was given to, and was killed.`,
    "",
    "What I believe now: whatever the agent last reported on this incident.",
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
    // Same rule as `deadlineBrief`, and this one cannot be suppressed at all:
    // `entry.escalated` lives on the run, and the run is out of `running`
    // before crash-loop detection looks. A fast-failing agent that escalates
    // in its first seconds and then dies badly would get this posted under
    // its own brief, so the sentence must not claim it said nothing.
    "Escalated by the dispatcher after a crash loop.",
    "",
    `Its last ${failures} launches each died within ${fastFailureSeconds}s of starting, which is a crash loop rather than an interrupted investigation, so relaunching stopped. Total launches to date: ${row.attempts}.`,
    "",
    "What I believe now: whatever the agent last reported on this incident.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown; each launch died before saying.",
    "Side effects: check the incident for PRs an earlier launch opened.",
    `Full transcript: session ${row.sessionRef ?? "none written yet"}.`,
  ].join("\n");

/**
 * What the sweep did with the wait it found, which is the distinction the
 * thread has to carry: being told is not the same as being relaunched.
 *
 * `held` is the case a boolean could not express. A wait that does not lift
 * on a reply is a spent turn budget, and no amount of elapsed time adds
 * turns to it, so the sweep says so and leaves the wait standing.
 */
export type StaleOutcome = "quiet" | "unparked" | "held";

/**
 * What the thread is told. Leads with the silence, because that is the part
 * nobody in the thread can see: the last message there is still true, and
 * reads as patience.
 *
 * It promises no hand-off and no change of owner, because neither exists --
 * an open incident is always an agent's, and all the sweep does is say that
 * it went quiet and, where a reply would have been the thing that moved it,
 * make it runnable again.
 *
 * The `held` arm names the two things that actually move a budget wait, and
 * both are outside the thread. It deliberately does not invite a reply: the
 * turn-budget brief the Boss was handed says replying will not restart it,
 * and a nudge here promising otherwise would make that a lie a day later.
 */
export const staleNotice = (
  quietSeconds: number,
  outcome: StaleOutcome,
): string => {
  const minutes = Math.round(quietSeconds / 60);
  const span = minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 6) / 10}h`;
  return [
    `Nothing has happened on this incident for ${span}.`,
    outcome === "unparked"
      ? "It was waiting on somebody and nobody came back, so it is no longer waiting: an agent will pick it up again and carry on from where it stopped."
      : outcome === "held"
        ? "It is still waiting, and this notice does not change that: the turn budget for this incident is spent, and time passing does not add turns. Raising BUGBOSS_MAX_TURNS or picking the work up yourself are the two things that move it."
        : "An agent still has it and will pick it up again; quiet this long usually means something is stuck rather than in progress.",
  ].join(" ");
};

const stalledBrief = (row: EligibleRow, launches: number): string =>
  [
    // As above: no live entry by the time this fires, so nothing here knows
    // whether the run spoke before it stopped.
    "Escalated by the dispatcher after too many launches without a finish.",
    "",
    `It has been launched ${launches} times on this incident and has finished none of them, while dying slowly enough each time to not look like a crash loop. Something is ending the run just past the point where relaunching looks reasonable: throttling, memory, credentials expiring, or a session it cannot replay. Total launches to date, this container and every earlier one: ${row.attempts}.`,
    "",
    "What I believe now: whatever the agent last reported on this incident.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown; no launch got far enough to say.",
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
  private readonly lastSessionEventAt: ((sessionRef: string) => Promise<number | null>) | null;
  private readonly fastFailureMs: number;
  private readonly maxLaunches: number;
  private readonly parkCooldownMs: number;
  private readonly staleAfterSeconds: number;
  private readonly workRoot: string | null;
  /** The delete in flight, so two ticks never race one `rm` over the same tree. */
  private emptying: Promise<void> | null = null;
  /** Logged once each rather than every tick. */
  private readonly orphanWorkspaces = new Set<string>();
  private readonly now: () => number;
  /** When this process began dispatching, the nearest clock to the last restart. */
  private readonly bootedAt: number;

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
   *
   * Cleared when the ceiling is reached and acted on, not just at restart.
   * What replaces it is a park, and a park expires; a count that outlived it
   * would meet the incident again at the cooldown and escalate it a second
   * time on the strength of launches it had already been paged for.
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
    this.lastSessionEventAt = deps.lastSessionEventAt ?? null;
    this.fastFailureMs =
      (deps.fastFailureSeconds ?? deps.config.tickSeconds * 2) * 1000;
    this.maxLaunches = deps.maxLaunches ?? deps.config.maxAttempts * 3;
    this.parkCooldownMs = (deps.parkCooldownSeconds ?? PARK_COOLDOWN_SECONDS) * 1000;
    this.staleAfterSeconds =
      deps.config.staleAfterSeconds ?? STALE_AFTER_SECONDS;
    this.workRoot = deps.workRoot ?? null;
    this.now = deps.now ?? Date.now;
    this.bootedAt = this.now();
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

  /**
   * Record that the agent on this incident escalated, so the deadline does
   * not post a placeholder brief over the top of the one it just wrote.
   *
   * Needed because the spawn context is not the path a real child takes. In
   * process -- the E2E, the unit tests -- the child calls the context's
   * `escalate` and the dispatcher sees it directly. A real child is a
   * separate process calling the loopback API, which records its escalation
   * in the Boss's inbox without the dispatcher in the call at all. So the
   * loopback's inbox route tells us.
   *
   * A no-op for an incident with no live run, which is the honest answer:
   * there is no placeholder pending for one, and nothing to suppress.
   */
  noteEscalated = (incidentId: string): void => {
    const entry = this.running.get(incidentId);
    if (entry) entry.escalated = true;
  };

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
    // Before the launch loop, so a workspace is out of the way before
    // anything could start into it.
    await this.sweepWorkspaces();

    const eligible = this.db.query<EligibleRow>(ELIGIBLE_SQL, [now]);
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
        // The counter goes either way, because past this point it can only be
        // wrong. The park the told path falls back to *expires*: leaving the
        // count at the ceiling means the cooldown lifts the wait into a
        // dispatcher that still believes it has given up, so the incident
        // re-enters the eligible set, this branch fires again on a stale
        // count, and the rotation is paged once an hour with nothing having
        // happened in between -- a second page for a first crash loop. That
        // is also what makes the cooldown a lie: `park` promises another go
        // and the counter silently withholds it. A loop that is still a loop
        // refills this from real launches and escalates again, which is a
        // page that has earned itself.
        this.fastFailures.delete(row.id);
        const reason = `${failures} launches in a row died within ${this.fastFailureMs / 1000}s`;
        // Park first and committed, then the post. The park is what stops
        // the next tick deciding this again, so a post ahead of it repeats
        // for as long as writes fail: on 2026-10-01 a halted database
        // reposted this escalation, and paged the rotation, every two minutes
        // for five hours. A park that cannot be written says nothing.
        // Put back, so the ceiling is met again next tick rather than after
        // another full set of crashes.
        if (!(await this.park(row.id, reason, now))) {
          this.fastFailures.set(row.id, failures);
          alarm("crash_loop_escalation_unrecorded", {
            incidentId: row.id,
            failures,
            note: "the park could not be written, so the escalation was not posted; it is tried again next tick",
          });
          continue;
        }
        const ok = await this.escalate(
          row.id,
          `${failures} consecutive launches died within ${this.fastFailureMs / 1000}s`,
          crashLoopBrief(row, failures, this.fastFailureMs / 1000),
        );
        // A told escalation stops the relaunching; an untold one must fall
        // back to it, so the park comes off again. Keeping it, or the counter
        // at the ceiling, retried the same failing escalation for as long as
        // the incident stayed open, which never resolved and never said so.
        if (ok) {
          escalated.push(row.id);
        } else {
          await this.unpark(row.id);
          alarm("crash_loop_escalation_failed", {
            incidentId: row.id,
            failures,
            note: "nobody was told; relaunching instead of retrying the escalation",
          });
        }
        continue;
      }

      const launches = this.launches.get(row.id) ?? 0;
      if (launches >= this.maxLaunches) {
        // Same rule as fastFailures above, and the same expiring park, so
        // the same clear: a count left at the ceiling turns the cooldown into
        // an hourly page instead of the retry it promises. Park before the
        // post, for the same reason too.
        this.launches.delete(row.id);
        const reason = `${launches} launches on this incident without finishing one`;
        if (!(await this.park(row.id, reason, now))) {
          this.launches.set(row.id, launches);
          alarm("stalled_escalation_unrecorded", {
            incidentId: row.id,
            launches,
            note: "the park could not be written, so the escalation was not posted; it is tried again next tick",
          });
          continue;
        }
        const ok = await this.escalate(row.id, reason, stalledBrief(row, launches));
        if (ok) {
          escalated.push(row.id);
        } else {
          await this.unpark(row.id);
          alarm("stalled_escalation_failed", {
            incidentId: row.id,
            launches,
            note: "nobody was told; relaunching instead of retrying the escalation",
          });
        }
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

    // After the launch loop on purpose: an incident this tick relaunched is
    // in `this.running` by the time the sweep looks, so it is skipped rather
    // than reported quiet on the strength of the row it left behind.
    const swept = await this.sweepStale(now);

    return {
      started,
      escalated,
      killed: expired.killed,
      running: this.running.size,
      circuitOpen,
      swept,
      settled: Promise.all(settling).then(() => undefined),
    };
  };

  /**
   * Delete the workspaces nothing will relaunch into. Every tick rather than
   * on an exit, so the first tick after boot is also the sweep of what the
   * last task left, and an incident closed while it had no live agent is
   * collected too.
   *
   * Only a row that says CLOSED or MERGED makes a workspace removable. A
   * directory with no row at all is kept and logged: the database is restored
   * from a snapshot at boot, and one that came back short would otherwise
   * delete every workspace this mount exists to keep.
   */
  private sweepWorkspaces = async (): Promise<void> => {
    const workRoot = this.workRoot;
    if (!workRoot) return;
    const status = new Map(
      this.db
        .query<{ id: string; status: IncidentStatus }>("SELECT id, status FROM incident")
        .map((row) => [row.id, row.status]),
    );
    try {
      const swept = await sweepWorkspaces({
        workRoot,
        removable: (incidentId) => {
          if (this.running.has(incidentId)) return false;
          const current = status.get(incidentId);
          if (current === undefined) {
            if (!this.orphanWorkspaces.has(incidentId)) {
              this.orphanWorkspaces.add(incidentId);
              log("workspace_without_incident", { incidentId });
            }
            return false;
          }
          return current === "CLOSED" || current === "MERGED";
        },
        now: this.now,
      });
      for (const incidentId of swept) log("workspace_deleted", { incidentId });
    } catch (err) {
      alarm("workspace_sweep_failed", { error: String(err) });
      return;
    }
    if (this.emptying) return;
    this.emptying = emptyTrash(workRoot)
      .catch((err) => alarm("workspace_delete_failed", { error: String(err) }))
      .finally(() => {
        this.emptying = null;
      });
  };

  /**
   * Notice that an incident has gone unaddressed, say so once, and -- where
   * the thing it is waiting for is a person -- make it runnable again.
   *
   * Nothing else here asks whether anything is still happening. Every other
   * guard watches a run -- a deadline, a crash loop, a launch ceiling -- and
   * an incident with no run at all is invisible to all of them. `park` makes
   * that state reachable on purpose: a wait with a NULL `wakeAt` is lifted by
   * a reply that may never come, so an incident can sit blocked on a person
   * indefinitely with nobody noticing. This is the thing that notices.
   */
  private sweepStale = async (now: number): Promise<string[]> => {
    // Off rather than everything. A threshold that is not a positive number
    // has to disable the sweep explicitly: a typo in BUGBOSS_STALE_HOURS
    // makes it NaN, every comparison against NaN is false, and the cost of
    // reading that as "everything is stale" is a post in every open thread
    // at once.
    if (!Number.isFinite(this.staleAfterSeconds) || this.staleAfterSeconds <= 0) {
      return [];
    }

    const swept: string[] = [];
    for (const row of this.db.query<StaleRow>(STALE_SQL)) {
      // Which means, in practice, that this only ever reaches an incident the
      // dispatcher cannot run: a parked one, or one the ceiling keeps
      // skipping. Anything runnable was launched moments ago by the loop
      // above and is in this map, so it is being addressed rather than going
      // unaddressed. That is the right scope -- "nothing is happening here"
      // is only true when nothing can.
      //
      // A run may last a day, so a live agent's own launch timestamp ages
      // past the threshold underneath it, and no row anywhere says the
      // process is still alive. This map is the only thing that can.
      if (this.running.has(row.id)) continue;

      const quietSeconds = Math.round((now - row.lastActivityAt) / 1000);
      if (quietSeconds < this.staleAfterSeconds) continue;

      const parked = row.parked === 1;

      // Announce either way; lift only a wait that a reply would have lifted.
      //
      // `liftsOnReply = 0` is a spent turn budget, and a day going by adds no
      // turns to it. Deleting that row makes the incident eligible again, so
      // the next tick launches an agent that is over budget before its first
      // turn: it exhausts, parks, escalates, pages -- and then the marker
      // this sweep just wrote ages out and the whole thing repeats tomorrow.
      // That is the loop `liftsOnReply` exists to end, rebuilt on a 24-hour
      // timer instead of on every comment in the thread, and it would make
      // the closing brief's "replying here will not restart it" false by a
      // second route. Announcing it is not a consolation for waking it: the
      // relaunch is what costs the turns and pages the rotation.
      //
      // Silence is the failure on the other side, though, so the
      // announcement stays unconditional. An incident out of budget and
      // untouched for a day is exactly what nobody should be unaware of, and
      // a wait that nothing lifts would otherwise be a permanent park with no
      // one watching it. Told, not relaunched.
      const outcome: StaleOutcome = !parked
        ? "quiet"
        : row.liftsOnReply === 0
          ? "held"
          : "unparked";

      // The marker is also activity, and that is the whole trick. The clock
      // above reads `incident_action`, so writing this row resets the clock
      // the sweep itself reads. One mechanism buys all three things this
      // needs: it fires once rather than every tick, it survives a container
      // restart -- every merge to ops main restarts this container, and a
      // sweep counted from process start would re-post on every deploy --
      // and it cannot ping-pong if something parks the incident straight
      // back. A separate suppression flag would be a second thing to keep in
      // step with the first, for nothing.
      //
      // Marker first and committed, then the post, on the precedent
      // `report/index.ts` sets: a container that dies between the two stays
      // quiet rather than saying it twice, and the un-park is the half that
      // actually recovers the incident, so it must not be lost to a Slack
      // call that fails.
      await this.db.withWrite((db) => {
        db.prepare(
          `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
           VALUES (?, 'boss', NULL, ?, ?, ?)`,
        ).run(
          row.id,
          STALE_SWEPT_ACTION,
          `nothing happened on this incident for ${quietSeconds}s`,
          now,
        );
        if (outcome === "unparked") {
          db.prepare("DELETE FROM incident_wait WHERE incidentId = ?").run(
            row.id,
          );
        }
      });
      swept.push(row.id);

      alarm("incident_stale", {
        incidentId: row.id,
        status: row.status,
        quietSeconds,
        parked,
        outcome,
        sweeps: row.sweeps + 1,
        note:
          outcome === "held"
            ? "nothing has touched this incident in a long time and its turn budget is spent; it was announced and left waiting, because relaunching it would only exhaust it again"
            : "nothing has touched this incident in a long time; it is runnable again",
      });

      if (!this.postNotice) {
        alarm("stale_notice_undeliverable", {
          incidentId: row.id,
          quietSeconds,
          note: "no thread poster is wired in, so nobody watching this incident was told",
        });
        continue;
      }
      await this.postNotice(row.id, staleNotice(quietSeconds, outcome)).catch(
        (err: unknown) =>
          alarm("stale_notice_failed", { incidentId: row.id, error: String(err) }),
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
    const alertSlugs = this.db
      .query<{ slug: string }>(
        "SELECT DISTINCT json_extract(labels, '$.alert_slug') AS slug FROM signal WHERE incidentId = ? AND json_extract(labels, '$.alert_slug') IS NOT NULL ORDER BY slug",
        [row.id],
      )
      .map((r) => String(r.slug));

    const env = buildChildEnv({
      base: this.childBaseEnv,
      credentials: this.childCredentials,
      incidentId: row.id,
      token,
      sessionRef: row.sessionRef,
      deadlineAt,
      maxTurns: this.config.agentMaxTurns,
      attempt,
      alertSlugs,
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
      escalated: false,
      done: Promise.resolve(),
    };
    this.running.set(row.id, entry);

    const tools = this.toolApiFor(row.id);
    const ctx: AgentSpawnContext = {
      reportRootCause: (args) => tools.reportRootCause(args),
      setSummary: (args) => tools.setSummary(args),
      reportImpact: (args) => tools.reportImpact(args),
      reportResolved: (args) => tools.reportResolved(args),
      reportAnalysis: (args) => tools.reportAnalysis(args),
      escalate: async (args) => {
        const response = await tools.escalate(args);
        if (response.ok) entry.escalated = true;
        return response;
      },
      park: (args) => tools.park(args),
      getIncident: (args) => tools.getIncident(args),
      proposeMerge: (args) => tools.proposeMerge(args),
      searchIncidents: (args) => tools.searchIncidents(args),
      trackTimelineEvent: (args) => tools.trackTimelineEvent(args),
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
      entry.proc?.kill();

      // An agent that used its grace to escalate has already put a better
      // brief in the thread and already reached the rotation. Posting the
      // placeholder on top of it is the system saying the same thing twice,
      // the second time worse.
      if (entry.escalated) {
        log("deadline_brief_suppressed", {
          incidentId: entry.incidentId,
          ranSeconds,
          note: "the agent escalated during its grace window, so its own brief stands",
        });
        continue;
      }

      // Nothing here records the escalation, since `entry.killed` above
      // already makes it once per run. The empty write is a gate instead:
      // it lands only when the database can, so a halted one posts nothing,
      // which is the rule every other dispatcher escalation keeps.
      try {
        await this.db.withWrite(() => undefined);
      } catch (err) {
        alarm("deadline_escalation_unrecorded", {
          incidentId: entry.incidentId,
          error: String(err),
          note: "writes are failing, so the deadline escalation was not posted",
        });
        continue;
      }
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
   * Say, loudly, that this incident needs a person to look -- and change
   * nothing about who is driving it, because an agent always is.
   *
   * Still `escalate` called on the agent's behalf rather than a second path
   * into the state machine, exactly as it was when the call was named
   * `hand_off`. What changed is underneath: that tool's real effect was the
   * ownership write, which took the incident out of the query above and left
   * no agent able to reach it. All that is left is the half that was always
   * the point, the post that reaches the rotation.
   *
   * A no-op on an incident that closed or was merged while this was being
   * decided. The `owner` check that used to sit here also made it idempotent;
   * nothing replaces that, and nothing needs to -- each caller fires once per
   * condition, and a duplicate is now a second Slack post rather than a
   * second transition.
   */
  private escalate = async (
    incidentId: string,
    reason: string,
    brief: string,
  ): Promise<boolean> => {
    const row = this.db.get<{ status: IncidentStatus }>(
      "SELECT status FROM incident WHERE id = ?",
      [incidentId],
    );
    if (!row) return false;
    if (!AGENT_STATUSES.includes(row.status)) return false;

    try {
      // A refusal is an answer, not a throw: the tool API rejects with ok
      // false when the post failed, and that is nobody told.
      const response = await this.toolApiFor(incidentId).escalate({ reason, brief });
      if (!response.ok) {
        alarm("escalation_failed", { incidentId, reason, error: response.error });
        return false;
      }
      log("escalated", { incidentId, reason });
      return true;
    } catch (err) {
      alarm("escalation_failed", { incidentId, reason, error: String(err) });
      return false;
    }
  };

  /**
   * Stop relaunching this incident until something changes.
   *
   * The half of `owner = 'human'` that was doing real work. Without it an
   * agent that stops driving is relaunched on the next tick, lands straight
   * back in whatever stopped it, and exits again -- a hot loop posting an
   * escalation every thirty seconds. It is not ownership and not a hand-off:
   * the agent still has this incident, it simply has nothing it can do yet.
   *
   * The wake is a cooldown rather than never, because none of the reasons
   * this fires are permanent -- a crash loop and a launch ceiling both say
   * "not now" rather than "not ever", and a container that comes back healthy
   * should get another go without needing a person. A reply in the thread
   * lifts it sooner, and the stale sweep lifts one nobody answered at all.
   */
  private park = async (
    incidentId: string,
    waitingFor: string,
    now: number,
  ): Promise<boolean> => {
    try {
      await this.writePark(incidentId, waitingFor, now);
    } catch (err) {
      alarm("park_failed", { incidentId, error: String(err) });
      return false;
    }
    log("parked", { incidentId, waitingFor, wakeAt: now + this.parkCooldownMs });
    return true;
  };

  /** Takes back a park whose escalation never reached anyone. */
  private unpark = async (incidentId: string): Promise<void> => {
    try {
      await this.db.withWrite((db) => {
        db.prepare("DELETE FROM incident_wait WHERE incidentId = ?").run(incidentId);
      });
    } catch (err) {
      alarm("unpark_failed", {
        incidentId,
        error: String(err),
        note: "parked with nobody told; the cooldown, a reply or the stale sweep lifts it",
      });
    }
  };

  private writePark = async (
    incidentId: string,
    waitingFor: string,
    now: number,
  ): Promise<void> => {
    await this.db.withWrite((db) => {
      db.prepare(
        // liftsOnReply stays 1. What the dispatcher parks for -- a crash
        // loop, a launch ceiling -- is a guess about the world rather than a
        // fact about the run, and somebody replying to say they fixed the
        // thing is exactly the kind of news that changes it. The cost of
        // being wrong is one relaunch.
        `INSERT INTO incident_wait
           (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(incidentId) DO UPDATE SET
           waitingFor = excluded.waitingFor,
           wakeAt = excluded.wakeAt,
           liftsOnReply = excluded.liftsOnReply,
           startedAt = excluded.startedAt`,
      ).run(incidentId, waitingFor, now + this.parkCooldownMs, now);
    });
  };

  /**
   * The last moment the agent on this incident is known to have been alive.
   *
   * The session is the primary clock: the agent writes it and it is synced
   * after every turn, so it tracks the agent working rather than anything
   * else touching the incident. It cannot see inside a turn, and the blocking
   * tools make a turn last as long as the wait, so the rows those tools write
   * as they run count too: a question or message to the Boss, a wait on a
   * person and its reminders, and anything the agent did through the tool
   * API. Launch is only the floor. Measuring from it is what told every
   * thread on every deploy that an agent working minutes earlier had been
   * gone for hours.
   *
   * Human rows are left out on purpose. A reply in the thread says a person
   * was there, not that the agent was.
   *
   * An open wait marker can be stronger than any timestamp. Both are deleted
   * when the wait ends, and a wait writes nothing while it blocks, so its
   * question can be an hour old on an agent that was alive until the
   * restart. It counts as alive up to when this process started, but only
   * when the wait is the last thing the agent did: a marker older than the
   * session's last entry is an orphan from a wait a SIGKILL interrupted
   * earlier, and the agent has since moved on, so it proves nothing.
   */
  private lastAliveAt = async (row: EligibleRow): Promise<number> => {
    const markerAt =
      this.db.get<{ at: number | null }>(
        // SQLite's two-argument MAX is NULL if either side is, so each side is
        // zeroed and a result of zero means no marker at all.
        `SELECT NULLIF(MAX(
           COALESCE((SELECT askedAt FROM pending_question
                      WHERE incidentId = ?), 0),
           COALESCE((SELECT MAX(startedAt, COALESCE(lastPingAt, 0))
                      FROM pending_wait WHERE incidentId = ?), 0)
         ), 0) AS at`,
        [row.id, row.id],
      )?.at ?? null;
    const recorded =
      this.db.get<{ at: number }>(
        `SELECT MAX(
           COALESCE((SELECT MAX(createdAt) FROM boss_inbox
                      WHERE incidentId = ?), 0),
           COALESCE((SELECT MAX(at) FROM incident_action
                      WHERE incidentId = ? AND actorKind = 'agent'), 0),
           COALESCE((SELECT MAX(askedAt) FROM pending_question
                      WHERE incidentId = ?), 0),
           COALESCE((SELECT MAX(startedAt, COALESCE(lastPingAt, 0))
                      FROM pending_wait WHERE incidentId = ?), 0)
         ) AS at`,
        [row.id, row.id, row.id, row.id],
      )?.at ?? 0;

    let session: number | null = null;
    if (this.lastSessionEventAt && row.sessionRef) {
      try {
        // Bounded because ticks are serialized: a GetObject that never
        // settles would stop every relaunch behind it.
        let timer: NodeJS.Timeout | undefined;
        session = await Promise.race([
          this.lastSessionEventAt(row.sessionRef),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`session read took over ${SESSION_READ_TIMEOUT_MS}ms`)),
              SESSION_READ_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(timer));
      } catch (err: unknown) {
        alarm("resume_session_read_failed", {
          incidentId: row.id,
          sessionRef: row.sessionRef,
          error: String(err),
          note: "the gap is measured from the database alone, so it may read longer than it was",
        });
      }
    }

    return Math.max(
      recorded,
      session ?? 0,
      // No session, no way to tell a live wait from an orphan, and hiding a
      // real gap is worse than reporting a false one the alarm above explains.
      markerAt !== null && session !== null && markerAt >= session
        ? this.bootedAt
        : 0,
      row.lastStartedAt ?? row.firstSignalAt,
    );
  };

  private emitResumedAfter = async (
    row: EligibleRow,
    now: number,
  ): Promise<void> => {
    // Exact when we watched the exit ourselves. After a container restart we
    // did not, and a SIGKILLed process writes no exit time, so the gap runs
    // from the last thing the agent is known to have done.
    const exitedAt = this.lastExitAt.get(row.id);
    const since = exitedAt ?? (await this.lastAliveAt(row));
    const seconds = Math.max(0, Math.round((now - since) / 1000));
    if (seconds < this.config.tickSeconds) return;
    await this.emitDirective(row.id, { type: "resumed_after", seconds });
    if (seconds < RESUME_ALARM_SECONDS) {
      // The normal path: every merge to ops main restarts this container and
      // every live agent with it.
      log("agent_resumed", {
        incidentId: row.id,
        gapSeconds: seconds,
        measuredFrom: exitedAt === undefined ? "last_activity" : "exit",
      });
      return;
    }

    alarm("agent_resumed_after_gap", {
      incidentId: row.id,
      deadSeconds: seconds,
      measuredFrom: exitedAt === undefined ? "last_activity" : "exit",
      attempts: row.attempts,
      status: row.status,
      note: "the previous run stopped without finishing and nothing was heard from it for this long before the relaunch",
    });
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
