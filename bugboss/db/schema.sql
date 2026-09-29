-- BugBoss incident database. Design spec: docs/bugboss/design.md, Layer 1.
--
-- The control plane's own access patterns are trivial. This is SQL because
-- the agents need it: triage asks arbitrary questions while deciding, and the
-- Slack agent gives people an open-ended question box.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS incident (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN
                      ('INVESTIGATING','FIXING','RESOLVED','CLOSED','MERGED')),
  owner             TEXT NOT NULL CHECK (owner IN ('agent','human')),
  slackThreadTs     TEXT,

  rootCause         TEXT,
  prUrls            TEXT NOT NULL DEFAULT '[]',   -- JSON array
  postmortem        TEXT,
  usersImpacted     INTEGER,
  impactQuery       TEXT,

  -- When users started being affected, which is not when we found out. Time
  -- to detect is (firstSignalAt - impactStartedAt), and it measures the alert
  -- rules rather than the agents: it is the only number here BugBoss cannot
  -- improve by being better at its job.
  --
  -- A lower bound, not a proven start. The agent reports the earliest bad
  -- event it can see, which log retention and its own query both bound from
  -- below, so treat it as "no later than this".
  impactStartedAt   INTEGER,
  firstSignalAt     INTEGER NOT NULL,
  fixingAt          INTEGER,
  resolvedAt        INTEGER,
  closedAt          INTEGER,

  -- Who was on the rotation when this opened, as a JSON array of Slack user
  -- ids. Snapshotted rather than looked up later because a Slack user group
  -- is mutable and keeps no history: three months on, "who was responsible
  -- when this fired at 2am" has no other answer. Null when no rotation group
  -- is configured, which is every incident until one exists.
  rotationAtOpen    TEXT,

  mergedInto        TEXT REFERENCES incident(id),
  recurrenceOf      TEXT REFERENCES incident(id),

  sessionRef        TEXT,
  -- When the current or most recent agent launch started. Survives a
  -- container restart, which is the case where the dispatcher has no memory
  -- of the run it is resuming.
  lastStartedAt     INTEGER,
  -- Total launches, informational. Escalation is gated on consecutive fast
  -- failures instead, so an interrupted agent is not mistaken for a crashing
  -- one: every merge to main restarts this container.
  attempts          INTEGER NOT NULL DEFAULT 0,
  modelId           TEXT,
  costUsd           REAL NOT NULL DEFAULT 0,
  tokensIn          INTEGER NOT NULL DEFAULT 0,
  tokensOut         INTEGER NOT NULL DEFAULT 0,
  cacheRead         INTEGER NOT NULL DEFAULT 0,
  cacheWrite        INTEGER NOT NULL DEFAULT 0,
  -- What the agent observed stop happening. RESOLVED is an evidence-based
  -- claim, so the evidence has to outlive the Slack message that carried it.
  resolvedEvidence  TEXT,

  -- Why this incident happened again after an earlier one was closed on the
  -- bar that no further alerts should occur, and what was done about that
  -- rather than about the symptom. Required by reportAnalysis whenever
  -- recurrenceOf is set, and refused at the tool rather than here: SQLite
  -- cannot add a CHECK to an existing table, and this column arrives after
  -- the table exists.
  recurrenceAnalysis TEXT,

  -- Cross-field constraints, which are the difference between an invariant
  -- and a comment. Every one of these was reachable at some point today: a
  -- resurrected MERGED row, a RESOLVED incident whose evidence lived only in
  -- a Slack message, a CLOSED one with no post-mortem.
  --
  -- They are here rather than in a migration because SQLite cannot add a
  -- CHECK to an existing table, this DDL runs as CREATE TABLE IF NOT EXISTS
  -- over a restored snapshot, and there is no migration runner. Free while
  -- the database is empty; a table rebuild afterwards.
  CHECK (mergedInto IS NULL OR mergedInto <> id),
  CHECK (recurrenceOf IS NULL OR recurrenceOf <> id),
  CHECK ((mergedInto IS NULL) = (status <> 'MERGED')),
  CHECK (closedAt IS NULL OR status = 'CLOSED'),
  CHECK (resolvedAt IS NULL OR status IN ('RESOLVED', 'CLOSED')),
  CHECK (status <> 'RESOLVED' OR resolvedAt IS NOT NULL),
  CHECK (status <> 'CLOSED'
         OR (resolvedAt IS NOT NULL AND closedAt IS NOT NULL
             AND postmortem IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS signal (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  sourceId          TEXT NOT NULL,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  labels            TEXT NOT NULL DEFAULT '{}',   -- JSON object
  reportedBy        TEXT,
  openedAt          INTEGER NOT NULL,
  closedAt          INTEGER,
  incidentId        TEXT REFERENCES incident(id),
  explained         INTEGER NOT NULL DEFAULT 0,

  -- What triage spent deciding where this signal belongs. The work that
  -- created this row, so it is costed on this row; an agent's spend lands on
  -- incident instead.
  --
  -- Tokens and a modelId rather than dollars, for the reason the incident
  -- row gives: a price table goes stale silently while tokens multiply out
  -- correctly whenever they are asked. There is deliberately no costUsd
  -- column here.
  --
  -- modelCalls is the guard, not decoration: a request that reached the model
  -- always spends something, so calls above zero beside zero tokens means the
  -- reader has drifted from what the provider reports rather than that triage
  -- was free.
  tokensIn          INTEGER NOT NULL DEFAULT 0,
  tokensOut         INTEGER NOT NULL DEFAULT 0,
  cacheRead         INTEGER NOT NULL DEFAULT 0,
  cacheWrite        INTEGER NOT NULL DEFAULT 0,
  modelCalls        INTEGER NOT NULL DEFAULT 0,
  modelId           TEXT,

  CHECK (kind IN ('alert', 'error', 'bug_report', 'regression')),
  -- explained is relative to a root cause, so it is meaningless detached.
  CHECK (explained = 0 OR incidentId IS NOT NULL)
);

-- At most one OPEN signal per (source, sourceId), not one for all time.
--
-- A Grafana fingerprint is stable for the life of the rule, so an all-time
-- unique key means the second time an alert ever fires it is discarded as a
-- duplicate: one incident per alert, forever. It also silently disables
-- recurrence, since the delivery proving a resolution was premature is the
-- one most certain to collide with the signal that resolution closed.
-- Scoped to open signals, a repeat delivery still collapses while the
-- incident is live, and becomes a new signal once the old one is closed.
CREATE UNIQUE INDEX IF NOT EXISTS signal_open_source_idx
  ON signal (source, sourceId) WHERE closedAt IS NULL;

-- The open list, which is the only query the control plane itself makes often.
CREATE INDEX IF NOT EXISTS incident_status_idx ON incident (status);
CREATE INDEX IF NOT EXISTS signal_incident_idx ON signal (incidentId);

-- Recurrence. Triage asks, on every delivery, whether an incident that
-- already claimed this problem was over carried a signal like this one. Both
-- reads join signal to incident, so both need the signal side indexed or the
-- cost of the question grows with every alert the system has ever seen.
--
-- signal_open_source_idx cannot serve this: it is partial on closedAt IS
-- NULL, and every signal a resolution closed has a closedAt. The exact key is
-- the same (source, sourceId) though, which is the point -- the delivery that
-- proves a resolution was premature is the one most certain to match the
-- signal that resolution closed.
CREATE INDEX IF NOT EXISTS signal_source_idx ON signal (source, sourceId);


-- Text search over incidents that already claimed a problem was over.
--
-- The corpus is the post-mortems CLOSED has always required and nothing ever
-- read back. FTS5 rather than embeddings on purpose: it is in-process, needs
-- no service and no similarity threshold, and a wrong answer can be explained
-- by reading the query.
--
-- Not an external-content table. External content keys on rowid and
-- incident.id is TEXT, and a trigger-maintained index would have to survive
-- being created over a restored snapshot that already has rows. This one is
-- written by reportResolved and reportAnalysis inside their own transactions
-- and reconciled at boot, which backfills the history for free.
CREATE VIRTUAL TABLE IF NOT EXISTS incident_fts USING fts5(
  incidentId UNINDEXED,
  titles,
  rootCause,
  resolvedEvidence,
  postmortem,
  tokenize = 'porter unicode61'
);

-- A question asked by contact_human that has not been answered yet. Lets a
-- resumed agent find the message it already posted rather than asking twice.
CREATE TABLE IF NOT EXISTS pending_question (
  incidentId        TEXT PRIMARY KEY REFERENCES incident(id),
  -- Empty until the post that follows the marker succeeds. The marker has to
  -- be durable before the message exists, so there is no ts to record yet.
  messageTs         TEXT NOT NULL,
  askedAt           INTEGER NOT NULL,
  message           TEXT NOT NULL DEFAULT ''
);

-- A wait on a person that monitor is sitting in. Keeps the elapsed clock and
-- the nudge count across a container restart, so a resumed agent carries on
-- waiting quietly instead of nudging the thread again -- every merge to ops
-- main restarts this container, so that is the normal path.
CREATE TABLE IF NOT EXISTS pending_wait (
  incidentId        TEXT PRIMARY KEY REFERENCES incident(id),
  -- Matched on resume. clearWait does not run when the child is SIGKILLed
  -- mid-wait, so a marker outlives the wait it was written for.
  command           TEXT NOT NULL,
  startedAt         INTEGER NOT NULL,
  pings             INTEGER NOT NULL DEFAULT 0,
  -- The backoff counts from the last nudge, not from the start. Without it a
  -- wait that spanned a night would fire its whole ladder in the first three
  -- minutes after the window opened.
  lastPingAt        INTEGER
);

-- Slack replies the Boss has relayed, which agents poll for.
CREATE TABLE IF NOT EXISTS thread_reply (
  id                TEXT PRIMARY KEY,
  incidentId        TEXT NOT NULL REFERENCES incident(id),
  slackUserId       TEXT NOT NULL,
  text              TEXT NOT NULL,
  ts                TEXT NOT NULL,
  receivedAt        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS thread_reply_incident_idx
  ON thread_reply (incidentId, ts);

-- Directives waiting for an agent to pick up on its next call.
CREATE TABLE IF NOT EXISTS pending_directive (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  incidentId        TEXT NOT NULL REFERENCES incident(id),
  payload           TEXT NOT NULL,                -- JSON Directive
  createdAt         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pending_directive_incident_idx
  ON pending_directive (incidentId);

-- Who did what. The post-mortem template has a "humans involved" section, and
-- merge / close / stop / split are supposed to appear in it, so the actions
-- need a home that survives the Slack thread.
CREATE TABLE IF NOT EXISTS incident_action (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  incidentId        TEXT NOT NULL REFERENCES incident(id),
  actorKind         TEXT NOT NULL CHECK (actorKind IN ('agent','human','boss')),
  actorId           TEXT,
  action            TEXT NOT NULL,
  reason            TEXT,
  at                INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS incident_action_incident_idx
  ON incident_action (incidentId, at);
