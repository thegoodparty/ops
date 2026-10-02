// The dispatcher. Design spec: bugboss/docs/architecture.md, Job 3.
//
// One question, every 30 seconds: does every incident that should have an
// agent have a live one? Both sides of that comparison are in this process,
// so there is nothing to reconcile. No task ARNs, no clientToken, no
// ListTasks that cannot see a finished task, no orphan sweep, no lease.
//
// An agent is a Pi Durable conversation, reached only through `AgentRuntime`,
// so nothing here imports Pi. Everything else is what a wall-clock bound and
// a shared process force: a deadline that steers and then aborts, a relaunch
// limit, and a ceiling that is a circuit breaker rather than a scheduler.
// There is deliberately no queue and no priority order.

import { existsSync } from "node:fs";

import type Database from "better-sqlite3";

// The grace and the budget default are the agent's numbers too, so they are
// defined once, beside the budget hook, and read here.
import {
  DEADLINE_GRACE_SECONDS,
  INCIDENT_AGENT_MAX_TURNS,
  deadlineMessage,
} from "../agent/budget";
import type { ConversationId } from "../agent/harness";
import { directiveText } from "../agent/tools";
import {
  computePaths,
  DEFAULT_WORK_ROOT,
  emptyTrash,
  prepareCheckout,
  startNpmCi,
  sweepWorkspaces,
  type AgentPaths,
  type CheckoutOutcome,
} from "../agent/workspace";
import type { DispatcherConfig, IncidentStatus, ToolApi } from "../types";
import { committedLocally, writesHalted } from "../db";
import { makeAlarm, makeLog } from "../logging";

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

/** The `incident_action` written when a raised turn budget lifts a budget wait. */
export const BUDGET_RAISED_ACTION = "turn_budget_raised";

/** What the thread is told when a raised budget resumes a spent incident. */
export const budgetRaisedNotice = (max: number, used: number): string =>
  `The turn budget was raised to ${max}, so the agent is resuming with ${max - used} turns left.`;

/** What the thread is told when a Boss grant resumes a spent incident. */
export const turnsGrantedNotice = (max: number, used: number): string =>
  `Granted more turns; the agent is resuming with ${max - used} left of ${max}.`;

/**
 * The park a spent budget writes. The same words the agent's own budget hook
 * uses, because `liftRaisedBudgets` finds budget waits by them.
 */
export const turnBudgetWaitingFor = (max: number): string =>
  `a person to decide what happens next; the ${max}-turn budget is spent`;

export const DEFAULT_DISPATCHER_CONFIG: DispatcherConfig = {
  maxConcurrentAgents: 15,
  tickSeconds: 30,
  // A day. An incident waits on a review, a merge and a deploy, and those
  // are measured in hours, so a half-hour ceiling killed agents mid-wait.
  agentTimeoutSeconds: 86_400,
  // The bound that counts work rather than time, and the one a restart does
  // not refill. See INCIDENT_AGENT_MAX_TURNS in agent/budget.ts for the number.
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

/**
 * Everything the dispatcher may do to an agent. The composition root
 * implements it over the harness; the dispatcher's tests implement it in
 * memory, because this seam is the dispatcher's whole contract with Pi.
 */
export interface AgentRuntime {
  createIncidentConversation(
    incidentId: string,
    a: { cwd: string; instructions: string },
  ): Promise<ConversationId>;
  submit(
    id: ConversationId,
    content: string,
    o: { requestId: string; whenBusy: "steer" | "followUp" },
  ): Promise<{ wait(): Promise<"done" | "unanswered"> }>;
  isBusy(id: ConversationId): Promise<boolean>;
  abort(id: ConversationId): Promise<void>;
  reset(id: ConversationId, handoff: string): Promise<void>;
}

/** An incident with a live agent, for `list()` and the tick's result. */
export interface RunningAgent {
  incidentId: string;
  startedAt: number;
  phase: string;
}

export interface DispatcherDeps {
  db: DispatcherDb;
  config: DispatcherConfig;
  runtime: AgentRuntime;
  /** Chunk 4's per-incident tool API. Also the dispatcher's escalation path. */
  toolApiFor: (incidentId: string) => ToolApi;
  /**
   * The system prompt a new conversation is pinned to. Called once per
   * incident, after the checkout is ready, because the prompt reads the
   * checkout's own agent docs.
   */
  composePrompt: (
    incidentId: string,
    a: { paths: AgentPaths; alertSlugs: string[] },
  ) => Promise<string>;
  /** The first input of a launch. The agent's to word; the dispatcher only picks. */
  messages: {
    kickoff: (
      incidentId: string,
      o: { resumedWithoutTranscript: boolean },
    ) => string;
    resume: (checkout: CheckoutOutcome, npmCiFailed: boolean) => string;
  };
  /**
   * Says something in an incident's thread. Optional, because the E2E and
   * the unit tests run a dispatcher with no Slack at all -- but absent in
   * prod it would make the one event this exists to surface silent again,
   * so the composition root passing nothing is worth noticing.
   */
  postNotice?: (incidentId: string, text: string) => Promise<void>;
  /**
   * A finish sooner than this after launch, without an answer, is a crash
   * rather than a run. Defaults to two ticks, the shortest gap the dispatcher
   * can even observe.
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
  /**
   * Given, a launch clones or fetches the checkout under `workRoot` and
   * restarts an interrupted `npm ci`, with `env` as the whole environment of
   * both. Absent, as in the unit tests and the E2E, no checkout is touched.
   */
  workspace?: {
    repoUrl: string;
    env: (incidentId: string) => Promise<Record<string, string>>;
  };
  now?: () => number;
}

export interface TickResult {
  started: RunningAgent[];
  /** Incidents escalated this tick, by any escalation path. */
  escalated: string[];
  /** Incidents whose run was aborted for passing its deadline and its grace. */
  aborted: string[];
  running: number;
  /** The ceiling stopped a launch. Something is wrong; a human should look. */
  circuitOpen: boolean;
  /**
   * Incidents that had gone quiet long enough for the sweep to say so. Not
   * all of them were made runnable: a spent turn budget is announced and left
   * waiting. See `sweepStale`.
   */
  swept: string[];
  /** Resolves when every run this tick started has settled. */
  settled: Promise<void>;
}

interface EligibleRow {
  id: string;
  status: IncidentStatus;
  conversationId: ConversationId | null;
  attempts: number;
  lastStartedAt: number | null;
  firstSignalAt: number;
  grantedTurns: number;
  turnsUsed: number;
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
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
  SELECT i.id AS id, i.status AS status, i.conversationId AS conversationId,
         i.attempts AS attempts, i.lastStartedAt AS lastStartedAt,
         i.firstSignalAt AS firstSignalAt, i.grantedTurns AS grantedTurns,
         i.turnsUsed AS turnsUsed, i.modelId AS modelId,
         i.tokensIn AS tokensIn, i.tokensOut AS tokensOut,
         i.cacheRead AS cacheRead, i.cacheWrite AS cacheWrite
  FROM incident i
  LEFT JOIN incident_wait w ON w.incidentId = i.id
  WHERE i.status IN (${AGENT_STATUSES.map((s) => `'${s}'`).join(", ")})
    AND (w.incidentId IS NULL OR (w.wakeAt IS NOT NULL AND w.wakeAt <= ?))
`;

interface LiveRow {
  id: string;
  status: IncidentStatus;
  conversationId: ConversationId;
  attempts: number;
  lastStartedAt: number | null;
  firstSignalAt: number;
}

// The conversations worth asking about. Every open one, and a finished one
// launched recently enough that its run may still be going: a CLOSED
// incident's agent is still writing to its workspace for a moment after
// `report_analysis`, and the deadline still has to reach a run that never
// stops. Anything launched before the window is past its hard stop already.
const LIVE_SQL = `
  SELECT id, status, conversationId, attempts, lastStartedAt, firstSignalAt
  FROM incident
  WHERE conversationId IS NOT NULL
    AND (status NOT IN ('CLOSED', 'MERGED') OR COALESCE(lastStartedAt, 0) >= ?)
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

interface Run {
  incidentId: string;
  startedAt: number;
  attempt: number;
  phase: string;
  /** Null until a first launch has created the conversation. */
  conversationId: ConversationId | null;
  /** The launch input is placed; from here `isBusy` covers the run too. */
  submitted: boolean;
  /** Aborted on purpose (its deadline, a stop, a merge), so its ending is not a failure. */
  aborted: boolean;
  done: Promise<void>;
}

const deadlineBrief = (row: LiveRow, ranSeconds: number): string =>
  [
    // Never claims the agent said nothing. The suppression below means this
    // brief should not be reachable at all once it has, but a sentence that
    // asserts something the code can check is one wrong suppression away from
    // the system contradicting itself in the thread, directly under the
    // agent's own brief.
    "Escalated by the dispatcher, which stopped the agent at its deadline.",
    "",
    `It passed its wall-clock deadline after ${ranSeconds}s on attempt ${row.attempts}, was asked to write a brief, did not finish in the ${DEADLINE_GRACE_SECONDS}s it was given to, and was stopped.`,
    "",
    "What I believe now: whatever the agent last reported on this incident.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown. It was still working when time ran out.",
    "Side effects: check the incident for PRs it opened before it stopped.",
    `Full transcript: conversation ${row.conversationId}.`,
  ].join("\n");

const crashLoopBrief = (
  row: EligibleRow,
  failures: number,
  fastFailureSeconds: number,
): string =>
  [
    // Same rule as `deadlineBrief`, and this one cannot be suppressed at all:
    // nothing records whether a run that ended spoke first. A fast-failing
    // agent that escalates in its first seconds and then dies badly would get
    // this posted under its own brief, so the sentence must not claim it said
    // nothing.
    "Escalated by the dispatcher after a crash loop.",
    "",
    `Its last ${failures} launches each ended without an answer within ${fastFailureSeconds}s of starting, which is a crash loop rather than an interrupted investigation, so relaunching stopped. Total launches to date: ${row.attempts}.`,
    "",
    "What I believe now: whatever the agent last reported on this incident.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown; each launch died before saying.",
    "Side effects: check the incident for PRs an earlier launch opened.",
    `Full transcript: conversation ${row.conversationId ?? "none created yet"}.`,
  ].join("\n");

const toRunningAgent = (r: Run): RunningAgent => ({
  incidentId: r.incidentId,
  startedAt: r.startedAt,
  phase: r.phase,
});

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
        ? "It is still waiting, and this notice does not change that: the turn budget for this incident is spent, and time passing does not add turns. Raising the turn budget, which resumes it on the next deploy, or picking the work up yourself are the two things that move it."
        : "An agent still has it and will pick it up again; quiet this long usually means something is stuck rather than in progress.",
  ].join(" ");
};

const stalledBrief = (row: EligibleRow, launches: number): string =>
  [
    // As above: nothing here knows whether the run spoke before it stopped.
    "Escalated by the dispatcher after too many launches without a finish.",
    "",
    `It has been launched ${launches} times on this incident and has finished none of them, while dying slowly enough each time to not look like a crash loop. Something is ending the run just past the point where relaunching looks reasonable: throttling, memory, credentials expiring, or a transcript it cannot replay. Total launches to date, this container and every earlier one: ${row.attempts}.`,
    "",
    "What I believe now: whatever the agent last reported on this incident.",
    "What I ruled out: not recorded.",
    "What I was about to do: unknown; no launch got far enough to say.",
    "Side effects: check the incident for PRs an earlier launch opened.",
    `Full transcript: conversation ${row.conversationId ?? "none created yet"}.`,
  ].join("\n");

/**
 * The brief for an incident whose budget was already spent when its turn to
 * launch came: a park that never landed, or a budget a restart's reconcile
 * found spent. Nothing is launched, because the first request of a launch
 * rewrites the whole context into the cache and incident 80 spent $4.04 on
 * one `get_incident` that way.
 */
const spentBudgetBrief = (row: EligibleRow, max: number): string =>
  [
    "Escalated by the dispatcher, which found the turn budget already spent at launch.",
    "",
    `This incident has used ${row.turnsUsed} of the ${max} turns it gets, counted across every launch, so no agent was started on it.`,
    `Spend so far: ${row.turnsUsed} turns on ${row.modelId ?? "an unrecorded model"}, ${row.tokensIn} tokens in, ${row.tokensOut} out, ${row.cacheRead} cache read, ${row.cacheWrite} cache write.`,
    "",
    "What I believe now: whatever the agent last reported on this incident.",
    "What I ruled out: not recorded.",
    "What I was about to do: nothing on this launch; the budget was gone before it started.",
    "Side effects: check the incident for PRs an earlier launch opened.",
    "",
    // Deliberately not "reply and it will carry on": a budget wait is not
    // lifted by a reply, so the two things named are the two that move it.
    `The ${max}-turn budget for this incident is spent, so neither a reply in the thread nor a message to me will restart it. To continue the work, somebody has to raise the turn budget, or grant this incident more turns, or pick it up themselves.`,
  ].join("\n");

export class Dispatcher {
  private readonly db: DispatcherDb;
  private readonly config: DispatcherConfig;
  private readonly runtime: AgentRuntime;
  private readonly toolApiFor: (incidentId: string) => ToolApi;
  private readonly composePrompt: DispatcherDeps["composePrompt"];
  private readonly messages: DispatcherDeps["messages"];
  private readonly postNotice: ((incidentId: string, text: string) => Promise<void>) | null;
  private readonly fastFailureMs: number;
  private readonly maxLaunches: number;
  private readonly parkCooldownMs: number;
  private readonly staleAfterSeconds: number;
  private readonly workRoot: string | null;
  private readonly workspace: DispatcherDeps["workspace"] | null;
  /** The delete in flight, so two ticks never race one `rm` over the same tree. */
  private emptying: Promise<void> | null = null;
  /** Logged once each rather than every tick. */
  private readonly orphanWorkspaces = new Set<string>();
  private readonly now: () => number;
  /** When this process began dispatching, the nearest clock to the last restart. */
  private readonly bootedAt: number;

  /**
   * Launches this process made, from the attempts write until the run
   * settles. It covers the minutes of git before the conversation is busy,
   * which `isBusy` cannot see, so the next tick does not launch twice.
   */
  private readonly runs = new Map<string, Run>();
  /**
   * The live side of the comparison as of this tick: every run above plus
   * every conversation the harness says is busy, which after a restart is
   * every run the harness resumed.
   */
  private alive = new Map<string, RunningAgent>();
  /** When we last saw a run settle, for the resumed_after figure. */
  private readonly lastExitAt = new Map<string, number>();
  /**
   * Launches that ended without an answer almost immediately, in a row.
   * Deliberately not persisted: a container that came back up healthy is not
   * evidence that the agent is crashing, and a crash-looping container is ECS
   * service health's alarm rather than this counter's.
   */
  private readonly fastFailures = new Map<string, number>();
  /**
   * Launches per incident, total rather than consecutive, and in memory for
   * the same reason as fastFailures: a restart is not evidence about the
   * agent. `maxAttempts` bounds only deaths fast enough to look like a crash
   * loop, and every ending slower than that *clears* that counter, so an agent
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

  /**
   * Deadline escalations a failing write held back, by incident. In memory,
   * like the run they describe: the abort already happened, and this is only
   * the post still owed for it. Retried at the top of every tick.
   */
  private readonly owedDeadlines = new Map<string, { reason: string; brief: string }>();
  /** Soft-deadline steers sent and hard stops made, by incident and attempt. */
  private readonly steered = new Set<string>();
  private readonly stopped = new Set<string>();
  /**
   * When the agent on an incident last escalated with its own brief, so the
   * deadline does not post a placeholder over it. Compared against the run's
   * `lastStartedAt`, which makes it per run without a run to hang it on.
   */
  private readonly escalatedAt = new Map<string, number>();
  /** The boot-time `resumed_after` steer has been sent. */
  private resumeSteered = false;

  private timer: NodeJS.Timeout | null = null;

  constructor(deps: DispatcherDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.runtime = deps.runtime;
    this.toolApiFor = deps.toolApiFor;
    this.composePrompt = deps.composePrompt;
    this.messages = deps.messages;
    this.postNotice = deps.postNotice ?? null;
    this.fastFailureMs =
      (deps.fastFailureSeconds ?? deps.config.tickSeconds * 2) * 1000;
    this.maxLaunches = deps.maxLaunches ?? deps.config.maxAttempts * 3;
    this.parkCooldownMs = (deps.parkCooldownSeconds ?? PARK_COOLDOWN_SECONDS) * 1000;
    this.staleAfterSeconds =
      deps.config.staleAfterSeconds ?? STALE_AFTER_SECONDS;
    this.workRoot = deps.workRoot ?? null;
    this.workspace = deps.workspace ?? null;
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
   * Stops ticking. Runs are left alone: they live in the harness, a deploy
   * stops them where they are, and `harness.resume()` picks each one up at
   * boot.
   */
  stop = (): void => {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log("stopped", { running: this.alive.size });
  };

  list = (): RunningAgent[] => [...this.alive.values()];

  /**
   * Record that the agent on this incident escalated with its own brief, so
   * the deadline does not post a placeholder brief over the top of it.
   *
   * The agent's escalate tool reaches the Boss's inbox without the
   * dispatcher in the call, so whatever records that escalation tells us.
   */
  noteEscalated = (incidentId: string): void => {
    this.escalatedAt.set(incidentId, this.now());
  };

  /**
   * Record that something other than the deadline is about to abort this
   * incident's run on purpose -- a Boss stop, a merge -- so its unanswered
   * ending is not counted toward the crash-loop ceiling or alarmed as a
   * failure.
   */
  noteStopped = (incidentId: string): void => {
    const run = this.runs.get(incidentId);
    if (run) run.aborted = true;
  };

  /** Waits for every run this process launched. For tests and shutdown. */
  drain = async (): Promise<void> => {
    await Promise.all([...this.runs.values()].map((r) => r.done));
  };

  /**
   * Serialized against itself. A tick awaits writes and harness reads before
   * it records a launch in `runs`, so an overlapping tick would read the same
   * row as unclaimed and submit a second launch into the same conversation.
   * The map is only authoritative if ticks cannot interleave.
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
    const live = await this.readLive(now);
    const expired = await this.enforceDeadlines(live, now);
    if (!this.resumeSteered) {
      this.resumeSteered = true;
      await this.steerResumed(live, now);
    }
    this.alive = new Map(
      [...live.values()].map((row) => [
        row.id,
        {
          incidentId: row.id,
          startedAt: this.runs.get(row.id)?.startedAt ?? row.lastStartedAt ?? row.firstSignalAt,
          phase: row.status,
        },
      ]),
    );
    for (const run of this.runs.values()) {
      if (!this.alive.has(run.incidentId)) this.alive.set(run.incidentId, toRunningAgent(run));
    }
    // Before the launch loop, so a workspace is out of the way before
    // anything could start into it.
    await this.sweepWorkspaces();
    // Before the eligibility read, so an incident it lifts launches this tick.
    await this.liftRaisedBudgets(now);

    const eligible = this.db.query<EligibleRow>(ELIGIBLE_SQL, [now]);
    const started: RunningAgent[] = [];
    const escalated = [...expired.escalated];
    const settling: Promise<void>[] = [];
    let circuitOpen = false;

    for (const row of eligible) {
      const running = this.alive.get(row.id);
      if (running) {
        running.phase = row.status;
        continue;
      }

      // Before any launch, because a launch on a spent budget pays for the
      // turn it is not allowed: the first request rewrites the whole context.
      const maxTurns = this.config.agentMaxTurns + row.grantedTurns;
      if (row.turnsUsed >= maxTurns) {
        if (await this.holdSpentBudget(row, maxTurns, now)) escalated.push(row.id);
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
          // Still parked and still untold, so the count stays at the ceiling
          // and the escalation is tried again when the park lifts.
          if (!(await this.unpark(row.id))) this.fastFailures.set(row.id, failures);
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
          if (!(await this.unpark(row.id))) this.launches.set(row.id, launches);
          alarm("stalled_escalation_failed", {
            incidentId: row.id,
            launches,
            note: "nobody was told; relaunching instead of retrying the escalation",
          });
        }
        continue;
      }

      if (this.alive.size >= this.config.maxConcurrentAgents) {
        circuitOpen = true;
        continue;
      }

      // One incident's bad launch must not stall the rest of the tick.
      let run: Run;
      try {
        run = await this.launch(row, now);
      } catch (err) {
        // A launch the database refused is not the agent crashing. Counted,
        // a halt of three ticks met the crash-loop ceiling on every open
        // incident, and the rotation was paged for each once writes came back.
        if (writesHalted(err)) {
          log("launch_deferred", { incidentId: row.id, error: String(err) });
          continue;
        }
        const failures = (this.fastFailures.get(row.id) ?? 0) + 1;
        this.fastFailures.set(row.id, failures);
        alarm("launch_failed", {
          incidentId: row.id,
          error: String(err),
          consecutiveFastFailures: failures,
        });
        continue;
      }
      this.alive.set(row.id, toRunningAgent(run));
      started.push(toRunningAgent(run));
      settling.push(run.done);
    }

    if (circuitOpen) {
      alarm("circuit_breaker_open", {
        running: this.alive.size,
        maxConcurrentAgents: this.config.maxConcurrentAgents,
        eligible: eligible.length,
        note: "dispatch stopped at the ceiling; nothing is queued, and hitting this means something is wrong",
      });
    }

    // After the launch loop on purpose: an incident this tick relaunched is
    // in `this.alive` by the time the sweep looks, so it is skipped rather
    // than reported quiet on the strength of the row it left behind.
    const swept = await this.sweepStale(now);

    return {
      started,
      escalated,
      aborted: expired.aborted,
      running: this.alive.size,
      circuitOpen,
      swept,
      settled: Promise.all(settling).then(() => undefined),
    };
  };

  /**
   * Which incidents have a live agent. A run this process launched is live
   * by the map; anything else is live when the harness says its conversation
   * is busy, which is how a run the harness resumed after a deploy is seen at
   * all. A read that fails counts as busy: a second launch into a running
   * conversation is the worse mistake, and the alarm says the read is broken.
   */
  private readLive = async (now: number): Promise<Map<string, LiveRow>> => {
    const window = (this.config.agentTimeoutSeconds + DEADLINE_GRACE_SECONDS + this.config.tickSeconds) * 1000;
    const live = new Map<string, LiveRow>();
    for (const row of this.db.query<LiveRow>(LIVE_SQL, [now - window])) {
      if (this.runs.has(row.id)) {
        live.set(row.id, row);
        continue;
      }
      try {
        if (await this.runtime.isBusy(row.conversationId)) live.set(row.id, row);
      } catch (err) {
        alarm("busy_check_failed", {
          incidentId: row.id,
          conversationId: row.conversationId,
          error: String(err),
          note: "counted as busy, so it is not launched again until the read works",
        });
        live.set(row.id, row);
      }
    }
    return live;
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
          if (this.alive.has(incidentId)) return false;
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
      // past the threshold underneath it, and no row says the run is still
      // going. Only the harness can, and this map is its answer this tick.
      if (this.alive.has(row.id)) continue;

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

  /**
   * Resume incidents parked on a turn budget that has since been raised,
   * by a new configured max or by a Boss `grant_turns` on that incident.
   *
   * A budget wait is the one park nothing else lifts: not a reply, not the
   * cooldown, not the stale sweep. That is right while the budget stands, and
   * wrong once it rises above what the incident spent, because then it has
   * turns again and the park is holding back work it could do.
   *
   * Turns are read from `incident.turnsUsed`, not from the wait's text,
   * because a launch can overrun the budget it parked on (incident 80 sat at
   * 270 of 200), and a wait the new budget still does not cover must stay
   * held. It is a column, so it is read every tick.
   *
   * Lift and marker commit before the post, so a failed post never leaves a
   * notice for a lift that did not happen. The delete is guarded on the wait
   * it read, so a wait rewritten in between is left alone.
   */
  private liftRaisedBudgets = async (now: number): Promise<void> => {
    const rows = this.db.query<{
      id: string;
      used: number;
      startedAt: number;
      grantedTurns: number;
    }>(
      `SELECT i.id AS id, i.turnsUsed AS used, w.startedAt AS startedAt,
              i.grantedTurns AS grantedTurns
       FROM incident i
       JOIN incident_wait w ON w.incidentId = i.id
       WHERE i.status IN (${AGENT_STATUSES.map((s) => `'${s}'`).join(", ")})
         AND w.liftsOnReply = 0
         AND w.waitingFor LIKE '%-turn budget%'`,
    );
    for (const row of rows) {
      const max = this.config.agentMaxTurns + row.grantedTurns;
      if (this.alive.has(row.id) || row.used >= max) continue;

      let lifted: boolean;
      try {
        lifted = await this.db.withWrite((db) => {
          const deleted = db
            .prepare(
              "DELETE FROM incident_wait WHERE incidentId = ? AND liftsOnReply = 0 AND startedAt = ?",
            )
            .run(row.id, row.startedAt);
          if (deleted.changes !== 1) return false;
          db.prepare(
            `INSERT INTO incident_action (incidentId, actorKind, actorId, action, reason, at)
             VALUES (?, 'boss', NULL, ?, ?, ?)`,
          ).run(
            row.id,
            BUDGET_RAISED_ACTION,
            `turn budget raised to ${max} with ${row.used} turns used`,
            now,
          );
          return true;
        });
      } catch (err) {
        alarm("budget_lift_failed", { incidentId: row.id, error: String(err) });
        continue;
      }
      if (!lifted) continue;

      log("turn_budget_raised", { incidentId: row.id, used: row.used, max, granted: row.grantedTurns });
      if (!this.postNotice) {
        alarm("budget_notice_undeliverable", {
          incidentId: row.id,
          note: "no thread poster is wired in, so nobody watching this incident was told it resumed",
        });
        continue;
      }
      const notice =
        row.grantedTurns > 0
          ? turnsGrantedNotice(max, row.used)
          : budgetRaisedNotice(max, row.used);
      await this.postNotice(row.id, notice).catch((err: unknown) =>
        alarm("budget_notice_failed", { incidentId: row.id, error: String(err) }),
      );
    }
  };

  /**
   * Park and announce an incident whose budget was spent before its launch.
   * The same park the agent's own budget hook writes, so a reply does not
   * lift it and a raised budget or a grant does. Park first, then the post,
   * as at the ceilings; unlike them, a failed post keeps the park, because
   * relaunching a spent budget only spends nothing and stops again.
   */
  private holdSpentBudget = async (
    row: EligibleRow,
    max: number,
    now: number,
  ): Promise<boolean> => {
    try {
      await this.db.withWrite((db) => {
        db.prepare(
          `INSERT INTO incident_wait
             (incidentId, waitingFor, wakeAt, liftsOnReply, startedAt)
           VALUES (?, ?, NULL, 0, ?)
           ON CONFLICT(incidentId) DO UPDATE SET
             waitingFor = excluded.waitingFor,
             wakeAt = excluded.wakeAt,
             liftsOnReply = excluded.liftsOnReply,
             startedAt = excluded.startedAt`,
        ).run(row.id, turnBudgetWaitingFor(max), now);
      });
    } catch (err) {
      if (!committedLocally(err)) {
        alarm("turn_budget_escalation_unrecorded", {
          incidentId: row.id,
          error: String(err),
          note: "the park could not be written, so the escalation was not posted; it is tried again next tick",
        });
        return false;
      }
    }
    log("turn_budget_spent_at_launch", { incidentId: row.id, used: row.turnsUsed, max });
    const ok = await this.escalate(
      row.id,
      `the ${max}-turn budget was spent before launch`,
      spentBudgetBrief(row, max),
    );
    if (!ok) {
      alarm("turn_budget_escalation_failed", {
        incidentId: row.id,
        note: "parked on its spent budget with nobody told; the stale sweep announces it within a day",
      });
    }
    return ok;
  };

  /**
   * Record the launch, then start it in the background. Only the attempts
   * write is awaited here: the checkout is minutes of git, and the tick is
   * serialized, so a launch that blocked it would hold up every other.
   */
  private launch = async (row: EligibleRow, now: number): Promise<Run> => {
    const attempt = row.attempts + 1;
    await this.db.withWrite((db) => {
      db.prepare(
        "UPDATE incident SET attempts = attempts + 1, lastStartedAt = ? WHERE id = ?",
      ).run(now, row.id);
    });
    this.launches.set(row.id, (this.launches.get(row.id) ?? 0) + 1);

    const run: Run = {
      incidentId: row.id,
      startedAt: now,
      attempt,
      phase: row.status,
      conversationId: row.conversationId,
      submitted: false,
      aborted: false,
      done: Promise.resolve(),
    };
    this.runs.set(row.id, run);
    log("agent_started", {
      incidentId: row.id,
      attempt,
      resumed: row.conversationId !== null,
      deadlineAt: now + this.config.agentTimeoutSeconds * 1000,
    });
    run.done = this.settle(row, run);
    return run;
  };

  private settle = async (row: EligibleRow, run: Run): Promise<void> => {
    let outcome: "done" | "unanswered";
    try {
      outcome = await this.startRun(row, run);
    } catch (err) {
      if (!run.submitted) {
        if (this.runs.get(row.id) === run) this.runs.delete(row.id);
        if (writesHalted(err)) {
          log("launch_deferred", { incidentId: row.id, error: String(err) });
          return;
        }
        // A launch that never started is a fast failure by definition, so a
        // persistent one escalates rather than retrying every 30s forever.
        const failures = (this.fastFailures.get(row.id) ?? 0) + 1;
        this.fastFailures.set(row.id, failures);
        alarm("launch_failed", {
          incidentId: row.id,
          attempt: run.attempt,
          error: String(err),
          consecutiveFastFailures: failures,
        });
        return;
      }
      alarm("agent_wait_failed", { incidentId: row.id, attempt: run.attempt, error: String(err) });
      outcome = "unanswered";
    }

    if (this.runs.get(row.id) === run) this.runs.delete(row.id);
    const endedAt = this.now();
    this.lastExitAt.set(row.id, endedAt);

    // A crash loop ends quickly after starting *and* ends badly. A run that
    // answered was a short run, not a failing one, and a run the dispatcher
    // aborted at its deadline already alarmed under its own name.
    const ranMs = endedAt - run.startedAt;
    const failed = outcome === "unanswered" && !run.aborted;
    if (failed) {
      alarm("agent_failed", {
        incidentId: row.id,
        attempt: run.attempt,
        ranSeconds: Math.round(ranMs / 1000),
        note: "the run ended without answering",
      });
    }
    const fast = failed && ranMs < this.fastFailureMs;
    const failures = fast ? (this.fastFailures.get(row.id) ?? 0) + 1 : 0;
    if (fast) this.fastFailures.set(row.id, failures);
    else this.fastFailures.delete(row.id);

    log("agent_exited", {
      incidentId: row.id,
      attempt: run.attempt,
      outcome,
      aborted: run.aborted,
      ranSeconds: Math.round(ranMs / 1000),
      consecutiveFastFailures: failures,
    });
  };

  /**
   * The background half of a launch: the checkout, the conversation on a
   * first launch, then the input. Resolves with how the run ended.
   */
  private startRun = async (
    row: EligibleRow,
    run: Run,
  ): Promise<"done" | "unanswered"> => {
    const paths = computePaths(this.workRoot ?? DEFAULT_WORK_ROOT, row.id);
    let checkout: CheckoutOutcome = "reused";
    if (this.workspace) {
      const env = await this.workspace.env(row.id);
      checkout = await prepareCheckout(this.workspace.repoUrl, paths.checkout, env);
      // A log means an install was started in this workspace before, and the
      // task it ran in may have died mid-way. Picking it up here is what stops
      // a FIXING agent waiting on a done marker that nothing is going to write.
      if (checkout !== "cloned" && existsSync(paths.npmCiLog)) startNpmCi(paths, env);
    }

    let conversationId = row.conversationId;
    let content: string;
    if (conversationId === null) {
      const alertSlugs = this.db
        .query<{ slug: string }>(
          "SELECT DISTINCT json_extract(labels, '$.alert_slug') AS slug FROM signal WHERE incidentId = ? AND json_extract(labels, '$.alert_slug') IS NOT NULL ORDER BY slug",
          [row.id],
        )
        .map((r) => String(r.slug));
      const instructions = await this.composePrompt(row.id, { paths, alertSlugs });
      const created = await this.runtime.createIncidentConversation(row.id, {
        cwd: paths.checkout,
        instructions,
      });
      try {
        await this.db.withWrite((db) => {
          db.prepare("UPDATE incident SET conversationId = ? WHERE id = ?").run(created, row.id);
        });
      } catch (err) {
        if (!committedLocally(err)) throw err;
      }
      conversationId = created;
      // An incident that was launched before and has no conversation is one
      // from before the harness: its transcript is a JSONL file nothing reads.
      content = this.messages.kickoff(row.id, { resumedWithoutTranscript: row.attempts > 0 });
    } else {
      const gap = this.resumeGap(row, run.startedAt);
      content = [
        this.messages.resume(checkout, existsSync(paths.npmCiFailed)),
        ...(gap === null ? [] : [directiveText({ type: "resumed_after", seconds: gap })]),
      ].join("\n\n");
    }
    run.conversationId = conversationId;

    const submission = await this.runtime.submit(conversationId, content, {
      requestId: `incident:${row.id}:launch:${run.attempt}`,
      whenBusy: "followUp",
    });
    run.submitted = true;
    return submission.wait();
  };

  /**
   * The two deadline layers, over every live run, read off the row so a run
   * the harness resumed after a deploy is bounded too. At `lastStartedAt +
   * agentTimeoutSeconds` the run is steered to write its brief; at
   * `DEADLINE_GRACE_SECONDS` past that it is aborted, which also kills any
   * subprocess its bash is in. Steering and aborting at once was what left
   * every timeout escalation with an empty brief.
   */
  private enforceDeadlines = async (
    live: Map<string, LiveRow>,
    now: number,
  ): Promise<{ aborted: string[]; escalated: string[] }> => {
    const aborted: string[] = [];
    const escalated: string[] = [];
    for (const [incidentId, owed] of [...this.owedDeadlines]) {
      try {
        await this.db.withWrite(() => undefined);
      } catch {
        break;
      }
      this.owedDeadlines.delete(incidentId);
      if (await this.escalate(incidentId, owed.reason, owed.brief)) escalated.push(incidentId);
    }
    for (const row of [...live.values()]) {
      if (row.lastStartedAt === null) continue;
      const run = this.runs.get(row.id);
      if (run && !run.submitted) continue;
      const key = `${row.id}:${row.attempts}`;
      const deadlineAt = row.lastStartedAt + this.config.agentTimeoutSeconds * 1000;
      if (now < deadlineAt) continue;

      if (now < deadlineAt + DEADLINE_GRACE_SECONDS * 1000) {
        if (this.steered.has(key)) continue;
        this.steered.add(key);
        try {
          await this.runtime.submit(row.conversationId, deadlineMessage(DEADLINE_GRACE_SECONDS), {
            requestId: `incident:${row.id}:deadline:${row.attempts}`,
            whenBusy: "steer",
          });
          log("deadline_steered", { incidentId: row.id, deadlineAt });
        } catch (err) {
          this.steered.delete(key);
          alarm("deadline_steer_failed", { incidentId: row.id, error: String(err) });
        }
        continue;
      }

      if (this.stopped.has(key)) continue;
      this.stopped.add(key);
      const ranSeconds = Math.round((now - row.lastStartedAt) / 1000);
      alarm("agent_deadline_exceeded", {
        incidentId: row.id,
        ranSeconds,
        deadlineAt,
        graceSeconds: DEADLINE_GRACE_SECONDS,
      });
      try {
        if (run) run.aborted = true;
        await this.runtime.abort(row.conversationId);
        aborted.push(row.id);
        if (run && this.runs.get(row.id) === run) this.runs.delete(row.id);
        live.delete(row.id);
      } catch (err) {
        alarm("agent_abort_failed", { incidentId: row.id, error: String(err) });
      }

      // An agent that used its grace to escalate has already put a better
      // brief in the thread and already reached the rotation. Posting the
      // placeholder on top of it is the system saying the same thing twice,
      // the second time worse.
      if ((this.escalatedAt.get(row.id) ?? -Infinity) >= row.lastStartedAt) {
        log("deadline_brief_suppressed", {
          incidentId: row.id,
          ranSeconds,
          note: "the agent escalated during its grace window, so its own brief stands",
        });
        continue;
      }

      // Nothing here records the escalation, since `stopped` above already
      // makes it once per run. The empty write is a gate instead: it lands
      // only when the database can, so a halted one posts nothing, which is
      // the rule every other dispatcher escalation keeps.
      const reason = `wall-clock deadline of ${this.config.agentTimeoutSeconds}s expired`;
      const brief = deadlineBrief(row, ranSeconds);
      try {
        await this.db.withWrite(() => undefined);
      } catch (err) {
        this.owedDeadlines.set(row.id, { reason, brief });
        alarm("deadline_escalation_unrecorded", {
          incidentId: row.id,
          error: String(err),
          note: "writes are failing, so the deadline escalation waits; it is posted on the first tick a write lands",
        });
        continue;
      }
      if (await this.escalate(row.id, reason, brief)) escalated.push(row.id);
    }
    return { aborted, escalated };
  };

  /**
   * Tell every run the harness resumed at boot how long it was gone. The
   * agent is the one that has to re-check what moved while it was down, and
   * a steer reaches it mid-turn, inside a wait if need be.
   */
  private steerResumed = async (live: Map<string, LiveRow>, now: number): Promise<void> => {
    for (const row of live.values()) {
      if (this.runs.has(row.id)) continue;
      const seconds = Math.max(0, Math.round((now - this.lastAliveAt(row)) / 1000));
      if (seconds < this.config.tickSeconds) continue;
      try {
        await this.runtime.submit(
          row.conversationId,
          directiveText({ type: "resumed_after", seconds }),
          { requestId: `incident:${row.id}:resumed:${this.bootedAt}`, whenBusy: "steer" },
        );
      } catch (err) {
        alarm("resume_steer_failed", { incidentId: row.id, error: String(err) });
      }
      this.reportResume(row, seconds, "last_activity");
    }
  };

  /**
   * How long a relaunched agent was gone, or null when it was under a tick.
   * Exact when this process saw the last run settle; otherwise from the last
   * thing the agent is known to have done.
   */
  private resumeGap = (row: EligibleRow, now: number): number | null => {
    const endedAt = this.lastExitAt.get(row.id);
    const since = endedAt ?? this.lastAliveAt(row);
    const seconds = Math.max(0, Math.round((now - since) / 1000));
    if (seconds < this.config.tickSeconds) return null;
    this.reportResume(row, seconds, endedAt === undefined ? "last_activity" : "exit");
    return seconds;
  };

  private reportResume = (
    row: { id: string; attempts: number; status: IncidentStatus },
    seconds: number,
    measuredFrom: "last_activity" | "exit",
  ): void => {
    if (seconds < RESUME_ALARM_SECONDS) {
      // The normal path: every merge to ops main restarts this container and
      // every live agent with it.
      log("agent_resumed", { incidentId: row.id, gapSeconds: seconds, measuredFrom });
      return;
    }
    alarm("agent_resumed_after_gap", {
      incidentId: row.id,
      deadSeconds: seconds,
      measuredFrom,
      attempts: row.attempts,
      status: row.status,
      note: "the previous run stopped without finishing and nothing was heard from it for this long before the resume",
    });
  };

  /**
   * The last moment the agent on this incident is known to have been alive.
   *
   * The blocking tools make a turn last as long as the wait, so the rows the
   * agent writes as it runs are the clock: a question or message to the Boss,
   * a wait on a person and its reminders, and anything it did through the
   * tool API. Launch is only the floor. Measuring from it is what told every
   * thread on every deploy that an agent working minutes earlier had been
   * gone for hours.
   *
   * Human rows are left out on purpose. A reply in the thread says a person
   * was there, not that the agent was.
   *
   * An open wait marker is stronger than any timestamp. Both are deleted when
   * the wait ends, and a wait writes nothing while it blocks, so its question
   * can be an hour old on an agent that was alive until the restart. It
   * counts as alive up to when this process started.
   */
  private lastAliveAt = (row: {
    id: string;
    lastStartedAt: number | null;
    firstSignalAt: number;
  }): number => {
    const open =
      this.db.get<{ open: number }>(
        `SELECT (EXISTS (SELECT 1 FROM pending_question WHERE incidentId = ?)
                 OR EXISTS (SELECT 1 FROM pending_wait WHERE incidentId = ?)) AS open`,
        [row.id, row.id],
      )?.open === 1;
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
    return Math.max(
      recorded,
      open ? this.bootedAt : 0,
      row.lastStartedAt ?? row.firstSignalAt,
    );
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
      // Committed here and waiting on the upload: the next tick reads the
      // park, so the post that follows still goes out only once.
      if (!committedLocally(err)) {
        alarm("park_failed", { incidentId, error: String(err) });
        return false;
      }
    }
    log("parked", { incidentId, waitingFor, wakeAt: now + this.parkCooldownMs });
    return true;
  };

  /** Takes back a park whose escalation never reached anyone. */
  private unpark = async (incidentId: string): Promise<boolean> => {
    try {
      await this.db.withWrite((db) => {
        db.prepare("DELETE FROM incident_wait WHERE incidentId = ?").run(incidentId);
      });
      return true;
    } catch (err) {
      if (committedLocally(err)) return true;
      alarm("unpark_failed", {
        incidentId,
        error: String(err),
        note: "parked with nobody told; the cooldown, a reply or the stale sweep lifts it, and the escalation is tried again then",
      });
      return false;
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
}

export const createDispatcher = (deps: DispatcherDeps): Dispatcher =>
  new Dispatcher(deps);
