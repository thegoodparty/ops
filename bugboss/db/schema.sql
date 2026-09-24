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

  firstBadEventAt   INTEGER,
  firstSignalAt     INTEGER NOT NULL,
  fixingAt          INTEGER,
  resolvedAt        INTEGER,
  closedAt          INTEGER,

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
  resolvedEvidence  TEXT
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

  UNIQUE (source, sourceId)
);

-- The open list, which is the only query the control plane itself makes often.
CREATE INDEX IF NOT EXISTS incident_status_idx ON incident (status);
CREATE INDEX IF NOT EXISTS signal_incident_idx ON signal (incidentId);

-- A question asked by contact_human that has not been answered yet. Lets a
-- resumed agent find the message it already posted rather than asking twice.
CREATE TABLE IF NOT EXISTS pending_question (
  incidentId        TEXT PRIMARY KEY REFERENCES incident(id),
  messageTs         TEXT NOT NULL,
  askedAt           INTEGER NOT NULL
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
