// The contract every BugBoss component is built against. Owned by Phase 0 of
// the build plan; nothing in Phase 1 edits this file.
//
// Design spec: bugboss/docs/architecture.md

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Where the work is, and the only thing that says it. An open incident is
 * always driven by an agent; a person is something it can be waiting on,
 * never something it can be given to.
 *
 * RESOLVED means no users will be impacted any more and no further alerts
 * should occur, confirmed by evidence rather than asserted. That bar is what
 * makes a post-resolution signal unambiguous evidence of a premature close.
 * CLOSED means the post-mortem exists and the metrics are populated.
 */
export type IncidentStatus =
  | "INVESTIGATING"
  | "FIXING"
  | "RESOLVED"
  | "CLOSED"
  | "MERGED";

/**
 * Anything telling us something is wrong. `source` is a free string, not a
 * union, so a new source is an adapter rather than a type change. The dedup
 * key is (source, sourceId).
 */
export interface Signal {
  id: string;
  source: string;
  sourceId: string;
  kind: "alert" | "error" | "bug_report" | "regression";
  title: string;
  body: string;
  labels: Record<string, string>;
  /** Who filed it: a Slack user id. Null for machine sources. */
  reportedBy: string | null;
  openedAt: number;
  closedAt: number | null;
  incidentId: string | null;
  /** Set when an agent's root cause accounts for this signal. */
  explained: boolean;
  /**
   * What triage spent placing this signal, summed over every request the
   * decision took, including a request that failed. Accumulated rather than
   * replaced: a re-delivery of a signal nothing ever placed is triaged again,
   * and both attempts were paid for.
   *
   * Tokens and a modelId, never a dollar figure -- see `db/schema.sql`.
   */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  modelCalls: number;
  modelId: string | null;
}

/** One hit from `searchIncidents`. Produced by `db/search.ts`. */
export interface IncidentMatch {
  incidentId: string;
  status: string;
  rootCause: string | null;
  resolvedAt: number | null;
  /** Where the query hit in the post-mortem, with matched terms bracketed. */
  excerpt: string;
}

export interface Incident {
  id: string;
  status: IncidentStatus;
  slackThreadTs: string | null;

  /**
   * What this incident is, in a few words, kept current by the agent.
   *
   * The only field that says what the incident *is* rather than what was
   * concluded about it. Null until an agent writes one, which is what the
   * first-signal title falls back to.
   */
  summary: string | null;

  rootCause: string | null;
  prUrls: string[];
  postmortem: string | null;
  usersImpacted: number | null;
  impactQuery: string | null;

  /** When impact began. A lower bound: the earliest bad event the agent saw. */
  impactStartedAt: number | null;
  firstSignalAt: number;
  fixingAt: number | null;
  resolvedAt: number | null;
  closedAt: number | null;

  /** Slack user ids on the rotation when this opened. Null if none configured. */
  rotationAtOpen: string[] | null;

  /** Set when correlation absorbs this incident into another. */
  mergedInto: string | null;
  /** Set when this reopens ground a RESOLVED incident claimed. */
  recurrenceOf: string | null;

  resolvedEvidence: string | null;
  /** JSON `RecurrenceAnalysis`. Required to close an incident that recurred. */
  recurrenceAnalysis: string | null;
  /**
   * JSON `PostmortemSections`, the structured write-up `report_analysis`
   * takes. Null for an incident closed before it existed or closed by the
   * Boss; those render `postmortem` as written.
   */
  postmortemSections: string | null;

  sessionRef: string | null;
  /** When the current or most recent launch started. Survives a restart. */
  lastStartedAt: number | null;
  /** Total launches, informational. Escalation gates on fast failures. */
  attempts: number;
  modelId: string | null;
  /**
   * What the run spent, in tokens. Never in dollars: Bedrock returns tokens
   * and a price is arithmetic against a table that goes stale silently, so a
   * cost is derived wherever it is shown and labelled an estimate there.
   */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** The 1h share of `cacheWrite`, which prices at 2x base input, not 1.25x. */
  cacheWrite1h: number;
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/** A signal as a source hands it to us, before it has an id or an incident. */
export type RawSignal = Omit<
  Signal,
  | "id"
  | "incidentId"
  | "explained"
  | "closedAt"
  // An adapter parses what a source sent. What placing it then cost is
  // decided here and is not a thing any source could hand over.
  | "tokensIn"
  | "tokensOut"
  | "cacheRead"
  | "cacheWrite"
  | "modelCalls"
  | "modelId"
>;

export interface Evidence {
  /** The query that produced this, stored so the result is checkable. */
  query: string;
  summary: string;
  /** S3 key for the full result, when it is too big to inline. */
  artifactKey: string | null;
}

/**
 * One per signal source. Four functions, which is the whole surface a new
 * source has to implement.
 */
export interface SignalAdapter {
  readonly source: string;

  /** Verify and parse. Throws on a signature failure; fails closed. */
  parse(req: IncomingRequest): Promise<RawSignal[]>;

  dedupKey(signal: RawSignal): string;

  /**
   * Run deterministically before triage sees the signal. For Grafana this is
   * the alert's own known_causes LogQL queries. This is where triage quality
   * comes from, and it costs no agent turns.
   */
  prefetchEvidence(signal: RawSignal): Promise<Evidence[]>;

}

export interface IncomingRequest {
  headers: Record<string, string>;
  rawBody: string;
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

export type TriageDecision =
  | { action: "attach"; incidentId: string; reason: string }
  | { action: "new_incident"; reason: string }
  | { action: "suppress"; knownCauseId: string; reason: string };

/** What triage sees. Entirely static except for the SQL it may run. */
export interface TriageContext {
  signal: RawSignal;
  evidence: Evidence[];
  openIncidents: IncidentDigest[];
}

export interface IncidentDigest {
  id: string;
  status: IncidentStatus;
  rootCause: string | null;
  signalTitles: string[];
  ageSeconds: number;
}

// ---------------------------------------------------------------------------
// The assign primitive
// ---------------------------------------------------------------------------

/**
 * Merge and split are the same operation: re-partition signals across
 * incidents. Create is one signal to NEW, attach is one to an existing,
 * merge is all of B's signals to A, split is a subset of A's to NEW.
 */
export interface AssignRequest {
  signalIds: string[];
  target: string | "NEW";
  reason: string;
}

// ---------------------------------------------------------------------------
// The agent tool API
// ---------------------------------------------------------------------------

export interface ToolResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  directives: Directive[];
}

/**
 * How an agent learns something changed, as a side effect of a call it was
 * already making. There is no push channel and an agent never needs to be
 * addressable.
 */
export type Directive =
  | { type: "stop"; reason: string }
  | { type: "merged"; into: string }
  /**
   * Signals landed on this incident that its agent did not put there.
   * `summary` is the reason the move was made.
   *
   * `absorbed` names the incidents that were emptied into this one, when
   * that is how the signals arrived. Without it a merge reaches the
   * surviving agent as an unexplained pile of new signals, and the agent is
   * then expected to write an honest title for an incident it never saw.
   * The incidents it names arrive in full on the next `getIncident`, as
   * `absorbed` on the view.
   */
  | {
      type: "new_signals";
      count: number;
      summary: string;
      absorbed?: string[];
    }
  /**
   * The Boss talking to this incident's agent. It is the only way anything a
   * person says reaches an agent: people talk to the Boss, and the Boss
   * decides what the agent needs to hear. Every one is deliberate, so any
   * of them ends a wait for an answer.
   */
  | { type: "boss_message"; text: string; at: number }
  /** Carries how long the agent was gone, so it can re-check before continuing. */
  | { type: "resumed_after"; seconds: number };

/**
 * What an incident agent sends up. `question` is one it is blocked on until
 * the Boss answers; `escalation` is one that needs a person urgently.
 */
export type BossInboxKind = "message" | "question" | "escalation";

export interface BossInboxItem {
  id: number;
  incidentId: string;
  kind: BossInboxKind;
  text: string;
  createdAt: number;
  seenAt: number | null;
}

/**
 * Runs the Boss for an incident because its inbox has something new. Returns
 * immediately; the Boss drains the inbox itself, so a wake that lands while
 * it is already running is picked up by that run rather than lost.
 */
export type WakeBoss = (incidentId: string) => void;

export interface ToolApi {
  /** INVESTIGATING -> FIXING. Triggers correlation and splits the unexplained. */
  reportRootCause(args: {
    cause: string;
    explainedSignalIds: string[];
    usersImpacted?: number;
    impactQuery?: string;
    /**
     * When impact began, as epoch millis: the earliest bad event the agent
     * found. Optional, because an agent that cannot pin it down should say
     * nothing rather than invent one -- time to detect is only worth having
     * if it is real.
     */
    impactStartedAt?: number;
  }): Promise<ToolResponse>;

  /**
   * What this incident is, in a few words. Callable at any time and at any
   * status, including before there is a root cause.
   *
   * Refused rather than truncated past `SUMMARY_CHARS`: a title cut at
   * eighty characters reads as a complete thought that happens to be wrong.
   */
  setSummary(args: { summary: string }): Promise<ToolResponse>;

  /** Callable repeatedly. Impact grows during an incident. */
  reportImpact(args: {
    usersImpacted: number;
    query: string;
  }): Promise<ToolResponse>;

  /** FIXING -> RESOLVED. Evidence is what the agent observed stop happening. */
  reportResolved(args: {
    prUrls: string[];
    evidence: string;
  }): Promise<ToolResponse>;

  /** RESOLVED -> CLOSED. Terminal; the agent exits after this. */
  reportAnalysis(args: PostmortemSections & {
    usersImpacted: number;
    impactQuery: string;
    /**
     * Required when the incident carries `recurrenceOf`, refused without it.
     * A recurrence closes on a second question the first incident never had
     * to answer, and the post-mortem that does not answer it leaves the next
     * agent exactly where this one started.
     */
    recurrence?: RecurrenceAnalysis;
  }): Promise<ToolResponse>;

  /**
   * Read-only. Text search over the post-mortems of incidents that already
   * claimed a problem was over -- the reach an exact signal key does not
   * have, and the only way to find the same cause under a different alert.
   */
  searchIncidents(args: { text: string }): Promise<ToolResponse<IncidentMatch[]>>;

  /**
   * Say that this incident needs a person, in its thread and at the rotation.
   * Changes nothing: the agent still owns the work and carries on driving.
   *
   * This was `handOff`, and its real effect was the ownership write that took
   * the incident out of the dispatcher's query. Announcing was always the
   * useful half; stopping was the half that stranded eight incidents.
   */
  escalate(args: { reason: string; brief: string }): Promise<ToolResponse>;

  /**
   * Stop relaunching this incident until a person replies, the cooldown
   * expires, or the stale sweep lifts it. The agent still has the incident;
   * it simply has nothing it can do yet.
   *
   * This is the half of `owner = 'human'` that had to survive. Anything that
   * makes an agent stop driving needs it, or the dispatcher relaunches on the
   * next tick into whatever stopped it: a budget-exhausted run becomes a hot
   * loop that pings the rotation every thirty seconds.
   *
   * It stops the relaunch. It does not free the dispatcher slot -- an agent
   * parked inside `monitor` is alive and still holds one, deliberately.
   */
  park(args: {
    waitingFor: string;
    /** Runnable again after this long. Omitted means only a reply lifts it. */
    wakeAfterSeconds?: number;
    /**
     * Whether a reply in the thread ends this wait. Defaults to true, which
     * is the wait on a person: somebody replying is exactly the signal it is
     * over. Pass false when a reply cannot change the thing being waited on
     * -- a run out of turns is the case that forced this -- because waking
     * on one relaunches an agent that stops again immediately and escalates
     * again, and every comment on the thread becomes a page.
     */
    liftsOnReply?: boolean;
  }): Promise<ToolResponse>;

  /**
   * Record one moment in the incident's timeline, when it happened rather
   * than when it was written down. The closer builds the post-mortem's
   * timeline from these rows, and every stage compaction carries them
   * forward, so they are the part of the story that survives the context.
   */
  trackTimelineEvent(args: {
    kind: TimelineEventKind;
    /** Epoch millis of when it happened, from the evidence. */
    occurredAt: number;
    summary: string;
    evidenceUrl?: string;
  }): Promise<ToolResponse<TimelineEvent>>;

  /**
   * Rehydration after resume, plus pending directives. With an id, any
   * incident: reads are not contained.
   *
   * Containment is about writes. The argument for it -- a compromised agent
   * re-partitions its own record and nothing else -- says nothing about
   * reading, and withholding the read only made this system incoherent from
   * the outside. An agent could already read a stranger's whole post-mortem
   * through `searchIncidents`, which is scoped to RESOLVED and CLOSED, and
   * could not see the open incident beside it: fluent about the past, blind
   * to the present. The Boss has served any incident to anyone
   * in the channel the whole time, and serves more of it than this does.
   */
  getIncident(args?: {
    /** Defaults to the caller's own incident. */
    incidentId?: string;
  }): Promise<ToolResponse<IncidentView>>;

  /**
   * Ask for this incident and another to be combined. The agent proposes;
   * it does not decide and it writes nothing across.
   *
   * An agent that works out its partition is wrong has to be able to say so.
   * Before this its only legal move was to create a *third* incident, which
   * is how a thread with days of history was abandoned for one opened
   * minutes earlier -- the rule that keeps blast radius at one record was
   * manufacturing the churn. The proposal goes to the Boss, which compares
   * the two on the same judgement it uses after a root cause, and `assign`
   * decides which record survives. So a captured agent can put one pair in
   * front of that judgement and can still move nothing.
   */
  proposeMerge(args: {
    /** The incident this one should be combined with. */
    incidentId: string;
    reason: string;
  }): Promise<ToolResponse<MergeOutcomeView>>;
}

/** What became of a `proposeMerge`, in terms of incidents rather than steps. */
export interface MergeOutcomeView {
  /** True when the two were combined. */
  combined: boolean;
  /** The incident of record afterwards. The caller's own when nothing moved. */
  incidentOfRecord: string;
  /** Plain sentence for the agent, and for anything it repeats to a person. */
  detail: string;
}

/**
 * The incident this one recurs from, carried on `getIncident` whenever
 * `recurrenceOf` is set.
 *
 * Someone already investigated this problem and wrote down what they
 * concluded, and that conclusion was wrong in a way this incident is the
 * proof of. It is the single most valuable thing an agent can start from, so
 * it arrives with the first read rather than waiting to be discovered.
 */
export interface PriorIncident {
  id: string;
  status: IncidentStatus;
  /** Its few-word title, which is the fastest way to know what it was. */
  summary: string | null;
  rootCause: string | null;
  prUrls: string[];
  /** What the earlier agent claimed it watched stop happening. */
  resolvedEvidence: string | null;
  /** Clipped: getIncident also carries directives, which must survive it. */
  postmortem: string | null;
  resolvedAt: number | null;
  closedAt: number | null;
}

/**
 * Why a resolution that met the bar did not hold.
 *
 * `category` is a closed set on purpose. Free text is what an agent produces
 * when it has not decided, and the whole value of this field is that the
 * answer is one of a few different kinds of failure -- one of which is a
 * defect in BugBoss itself, which nothing else in the system would ever
 * surface.
 */
export type RecurrenceCategory =
  /** The recorded cause was not the cause, or was a symptom of it. */
  | "previous_fix_wrong"
  /** The cause was real but covered one path into the failure, not all. */
  | "previous_fix_incomplete"
  /** The fix held; the alert should not have fired either time. */
  | "alert_is_wrong"
  /** The fix held but was never deployed, or was reverted. */
  | "fix_never_reached_production"
  /** RESOLVED was claimed on evidence too weak to carry it. */
  | "resolution_evidence_too_weak"
  /** BugBoss let a premature close happen. The fix belongs in ops. */
  | "bugboss_defect";

/**
 * One row of the post-mortem's timeline. `recordedEventId` names the
 * `incident_timeline_event` this row describes, and its recorded time wins
 * over `at`; a row without one must carry `at`.
 */
export interface PostmortemTimelineRow {
  /** ISO 8601 in UTC, e.g. 2026-10-01T02:14:30Z. */
  at?: string;
  event: string;
  evidenceUrl?: string;
  recordedEventId?: number;
}

export interface FiveWhy {
  why: string;
  because: string;
}

/**
 * The post-mortem as fields, rendered by code in a fixed order so every
 * report reads the same way.
 *
 * `practiceChanges` is about how we build, not about this incident: what
 * would stop a *similar* issue. Work still to do on this incident has no
 * field, because a closed incident has none.
 */
export interface PostmortemSections {
  atAGlance: string;
  timeline: PostmortemTimelineRow[];
  userImpact: string;
  rootCause: string;
  fiveWhys: FiveWhy[];
  resolutionActions: string[];
  practiceChanges: string;
}

export interface RecurrenceAnalysis {
  category: RecurrenceCategory;
  /** Why the earlier resolution did not hold, specifically. */
  why: string;
  /**
   * What was done about *that*, as opposed to about the symptom: pull
   * request urls, or an explicit statement that nothing was and why. An
   * empty answer is refused; "nothing, because X" is not.
   */
  remedy: string;
}

/**
 * What a signal looks like to the investigating agent.
 *
 * Triage's spend is left off deliberately. The agent is working out why
 * something broke, and what placing the signal cost is of no use to that --
 * it would be six numbers per signal re-serialized into the prompt on every
 * `get_incident`, which is how a tool result grows without anyone deciding
 * to grow it. The columns are on the row for a person or the Boss to query.
 */
export type SignalView = Omit<
  Signal,
  "tokensIn" | "tokensOut" | "cacheRead" | "cacheWrite" | "modelCalls" | "modelId"
>;

/**
 * The moments a post-mortem timeline is made of. A closed list rather than
 * free text, because the stage compactions key off two of them and code
 * never reads the words an agent chose.
 */
export const TIMELINE_EVENT_KINDS = [
  "first_error",
  "impact_confirmed",
  "root_cause_found",
  "mitigated",
  "fix_pr_opened",
  "fix_merged",
  "fix_deployed",
  "fix_verified",
  "other",
] as const;

export type TimelineEventKind = (typeof TIMELINE_EVENT_KINDS)[number];

/**
 * A stage-goal verdict, written by the harness rather than the agent. Kept
 * out of `TIMELINE_EVENT_KINDS` because that list is the agent's tool schema,
 * and a kind the agent may not record has no place in it.
 */
export const GOAL_VERDICT_KIND = "goal_verdict";

export type RecordedTimelineKind = TimelineEventKind | typeof GOAL_VERDICT_KIND;

export interface TimelineEvent {
  id: number;
  kind: RecordedTimelineKind;
  occurredAt: number;
  recordedAt: number;
  summary: string;
  evidenceUrl: string | null;
}

export interface IncidentView {
  incident: Incident;
  signals: SignalView[];
  evidence: Evidence[];
  /** What the agent recorded with `trackTimelineEvent`, oldest first. */
  timeline: TimelineEvent[];
  /** Non-null only when this incident reopens ground that one claimed. */
  priorIncident: PriorIncident | null;
  /**
   * Incidents that were merged into this one, most recent first. Empty for
   * almost every incident.
   *
   * The same shape and the same reason as `priorIncident`: somebody else
   * already investigated part of what is now this incident's problem, and
   * their conclusions are the most valuable thing this agent can start from.
   * An agent asked to keep a title current for an incident that absorbed
   * another one cannot do it honestly without having read the other one.
   */
  absorbed: PriorIncident[];
}

/**
 * What the stage-goal evaluator reads about an incident, without the drain a
 * `getIncident` would make: it runs between turns and inside tools, where a
 * drained directive would land in a result the model never sees.
 */
export interface GoalContext {
  incident: Pick<
    Incident,
    | "id"
    | "status"
    | "rootCause"
    | "usersImpacted"
    | "impactQuery"
    | "prUrls"
    | "resolvedEvidence"
  >;
  signals: Pick<SignalView, "id" | "kind" | "source" | "title" | "body">[];
  timeline: TimelineEvent[];
}

// ---------------------------------------------------------------------------
// Agent-local tools
// ---------------------------------------------------------------------------

/**
 * Blocking tools that live in the agent's harness rather than the Boss API.
 * Each costs one turn no matter how long it waits, which is what keeps a
 * multi-day incident from saturating context on polling.
 */
export interface AgentTools {
  /**
   * Block until `command` exits 0, then return its output. The general
   * primitive: PR merged, deploy shipped, signal quiet, anything else.
   *
   * The command MUST be a read-only check. On a container restart the session
   * holds a tool call with no result and the tool runs again, so an action
   * would be performed twice.
   */
  monitor(args: {
    command: string;
    intervalSeconds: number;
    timeoutSeconds: number;
    description: string;
  }): Promise<{ output: string; timedOut: boolean }>;

  /**
   * Post to the incident thread and block until a human replies. Not named
   * `ask_human`: the agent may be asking a question or asking someone to do
   * something it cannot do itself.
   *
   * Re-entrant. Records its message timestamp on the incident before posting,
   * so a resumed agent resumes waiting rather than asking twice.
   */
  contactHuman(args: {
    message: string;
    timeoutSeconds: number;
  }): Promise<{ reply: string | null; timedOut: boolean }>;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface RunningAgent {
  incidentId: string;
  pid: number;
  startedAt: number;
  phase: string;
}

export interface DispatcherConfig {
  /** Circuit breaker, not a scheduler. Hitting it means something is wrong. */
  maxConcurrentAgents: number;
  tickSeconds: number;
  /**
   * Wall clock, per launch. A poor proxy for work done and never the only
   * bound: `monitor` and `message_boss` each cost one turn however long
   * they block, so one real incident spent eight of its nine hours parked on
   * a human and the clock counted all of it.
   */
  agentTimeoutSeconds: number;
  /**
   * Turns the incident agent may take on one incident, across every launch.
   *
   * Named beside `agentTimeoutSeconds` because it bounds the same child: the
   * dispatcher launches incident agents and nothing else, and the Slack
   * agent's own budget (`SLACK_AGENT_MAX_TURNS`) never passes through here.
   *
   * The bound that tracks work rather than time. A turn is a model call, so
   * this does not inflate while the agent waits on a person -- the nine-hour
   * incident above was 92 turns. It is deliberately not per launch: every
   * merge to ops `main` restarts this container, and a budget that refilled
   * on a restart would bound nothing.
   */
  agentMaxTurns: number;
  /** Stop relaunching after this many attempts and escalate. */
  maxAttempts: number;
  /**
   * How long an incident may go with nothing happening to it at all before
   * the stale sweep says so in its thread and lifts whatever it was waiting
   * on. Zero or less turns the sweep off entirely.
   *
   * Omitting it is not the same as zero: an absent value takes
   * `STALE_AFTER_SECONDS`, so a config written before the sweep existed still
   * gets one. Turning the sweep off has to be said out loud.
   */
  staleAfterSeconds: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The Postgres an incident agent runs omni's database-backed tests against,
 * as the task definition named it. `refused` is a URL we will not hand an
 * agent -- see bugboss/testdb/index.ts for what is refused and why.
 */
export type TestDatabase =
  | { state: "absent" }
  | { state: "refused"; reason: string }
  | { state: "configured"; url: string; host: string; port: number };

export interface BugBossConfig {
  env: "prod";
  s3Bucket: string;
  dbPath: string;
  slackChannelId: string;
  dispatcher: DispatcherConfig;
  /** Signals on this list ping the channel at open, in parallel with the agent. */
  prodCriticalSlugs: string[];
  /**
   * When an agent blocked on a person may nudge the thread, as
   * `America/New_York:10-19` or `America/New_York:10-19:1,2,3,4,5`. Carried as
   * the raw string because the agent that acts on it is a child process and
   * the environment is the only channel to it; parsed at both ends, so a typo
   * fails the Boss at boot rather than every agent at launch.
   */
  workingHours?: string;
  /**
   * Model id to application inference profile ARN, as JSON. Carried raw for
   * the same reason `workingHours` is: the agent that uses it is a child
   * process and the environment is the only channel to it. Parsed at both
   * ends, but only this end throws -- an unattributable run is worth less
   * than a dead agent.
   */
  inferenceProfiles?: string;
  /** The Postgres agents run omni's database-backed tests against. */
  testDatabase: TestDatabase;
}
