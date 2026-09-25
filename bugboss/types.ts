// The contract every BugBoss component is built against. Owned by Phase 0 of
// the build plan; nothing in Phase 1 edits this file.
//
// Design spec: docs/bugboss/design.md

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Where the work is. Orthogonal to `owner`, which says who has it.
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

export type IncidentOwner = "agent" | "human";

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
  /** Who filed it: a Slack user id, or a Google email via MCP. Null for machine sources. */
  reportedBy: string | null;
  openedAt: number;
  closedAt: number | null;
  incidentId: string | null;
  /** Set when an agent's root cause accounts for this signal. */
  explained: boolean;
}

export interface Incident {
  id: string;
  status: IncidentStatus;
  owner: IncidentOwner;
  slackThreadTs: string | null;

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

  sessionRef: string | null;
  /** When the current or most recent launch started. Survives a restart. */
  lastStartedAt: number | null;
  /** Total launches, informational. Escalation gates on fast failures. */
  attempts: number;
  modelId: string | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

/** A signal as a source hands it to us, before it has an id or an incident. */
export type RawSignal = Omit<
  Signal,
  "id" | "incidentId" | "explained" | "closedAt"
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
  | { type: "handoff"; reason: string }
  | { type: "new_signals"; count: number; summary: string }
  | { type: "human_message"; from: string; text: string; ts: string }
  /** Carries how long the agent was gone, so it can re-check before continuing. */
  | { type: "resumed_after"; seconds: number };

export interface ToolApi {
  /** INVESTIGATING -> FIXING. Triggers correlation and splits the unexplained. */
  reportRootCause(args: {
    cause: string;
    explainedSignalIds: string[];
    usersImpacted?: number;
    impactQuery?: string;
  }): Promise<ToolResponse>;

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
  reportAnalysis(args: {
    postmortem: string;
    usersImpacted: number;
    impactQuery: string;
  }): Promise<ToolResponse>;

  /** Terminal. Sets owner: human and posts the brief. */
  handOff(args: { reason: string; brief: string }): Promise<ToolResponse>;

  /** Rehydration after resume, plus pending directives. */
  getIncident(): Promise<ToolResponse<IncidentView>>;
}

export interface IncidentView {
  incident: Incident;
  signals: Signal[];
  evidence: Evidence[];
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
  /** Wall clock, the only bound on a run. Not a token or dollar cap. */
  agentTimeoutSeconds: number;
  /** Stop relaunching after this many attempts and escalate. */
  maxAttempts: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BugBossConfig {
  env: "prod";
  s3Bucket: string;
  dbPath: string;
  slackChannelId: string;
  dispatcher: DispatcherConfig;
  /** Signals on this list ping the channel at open, in parallel with the agent. */
  prodCriticalSlugs: string[];
}
