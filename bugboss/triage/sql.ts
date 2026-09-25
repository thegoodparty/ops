// Read-only SQL over the incident database, exposed as a tool to the Boss's
// own agentic calls. Design spec: bugboss/docs/architecture.md, "Who can query it".
//
// The digest answers "what is open right now". This answers everything else:
// has this alert slug produced a real incident before, how did the last one
// resolve, how often does this fire and get suppressed.

import type { LoopTool } from "./model";

/** The read half of the database. `Db` from ../db satisfies it structurally. */
export interface IncidentReader {
  query<T = unknown>(sql: string, params?: unknown[]): T[];
}

export const QUERY_TOOL = "query_incidents";

const MAX_ROWS = 50;
const MAX_CHARS = 4000;

export const SCHEMA_SUMMARY = `incident(
  id TEXT, status TEXT in (INVESTIGATING,FIXING,RESOLVED,CLOSED,MERGED),
  owner TEXT in (agent,human), rootCause TEXT, prUrls TEXT json, postmortem TEXT,
  usersImpacted INT, impactQuery TEXT,
  impactStartedAt INT, firstSignalAt INT, fixingAt INT, resolvedAt INT, closedAt INT,
  mergedInto TEXT, recurrenceOf TEXT, attempts INT, costUsd REAL)
signal(
  id TEXT, source TEXT, sourceId TEXT, kind TEXT, title TEXT, body TEXT,
  labels TEXT json, reportedBy TEXT, openedAt INT, closedAt INT,
  incidentId TEXT, explained INT)
Timestamps are epoch milliseconds. Labels and prUrls are JSON text; use
json_extract(labels, '$.alert_slug') to read one.`;

/**
 * The read connection is already opened read-only, so this guard is about
 * giving the model a correctable error rather than about containment.
 */
export const prepareQuery = (raw: string): { sql: string } | { error: string } => {
  const sql = raw.trim().replace(/;+\s*$/, "").trim();
  if (sql.length === 0) return { error: "empty query" };
  if (!/^(select|with)\b/i.test(sql)) {
    return { error: "only SELECT and WITH statements are allowed" };
  }
  if (sql.includes(";")) return { error: "one statement per call" };
  return { sql };
};

export const queryTool = (db: IncidentReader): LoopTool => ({
  spec: {
    name: QUERY_TOOL,
    description: `Run one read-only SELECT against the incident database and get the rows back as JSON. At most ${MAX_ROWS} rows are returned. Schema:\n${SCHEMA_SUMMARY}`,
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "A single SELECT or WITH statement, no trailing semicolon.",
        },
      },
      required: ["sql"],
    },
  },
  run: (input) => {
    const prepared = prepareQuery(typeof input.sql === "string" ? input.sql : "");
    if ("error" in prepared) return `error: ${prepared.error}`;

    try {
      const rows = db.query(prepared.sql);
      const head = rows.slice(0, MAX_ROWS);
      const body = JSON.stringify(head);
      const clipped =
        body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}...[truncated]` : body;
      return `${rows.length} row(s), showing ${head.length}: ${clipped}`;
    } catch (err) {
      return `error: ${String(err)}`;
    }
  },
});

/**
 * Used to check a model-supplied incident id before it reaches an outcome.
 *
 * Throws on a failed read rather than answering null. null is the answer for
 * "no such incident", which silently downgrades an attach to a new incident
 * and drops a recurrence pointer, and every caller sits inside a fallback that
 * records why it fell back -- so an exception carries strictly more
 * information than a plausible-looking wrong answer.
 */
export const incidentStatus = (db: IncidentReader, id: string): string | null => {
  const rows = db.query<{ status: string }>(
    "SELECT status FROM incident WHERE id = ?",
    [id],
  );
  return rows[0]?.status ?? null;
};

/**
 * Who has an incident, which types.ts keeps deliberately orthogonal to its
 * status: a handed-off incident still reads INVESTIGATING. Throws on a failed
 * read, for the same reason as above.
 */
export const incidentOwner = (db: IncidentReader, id: string): string | null => {
  const rows = db.query<{ owner: string }>(
    "SELECT owner FROM incident WHERE id = ?",
    [id],
  );
  return rows[0]?.owner ?? null;
};

/** Throws on a failed read, for the same reason: [] means "nothing attached". */
export const attachedSignalIds = (db: IncidentReader, incidentId: string): string[] =>
  db
    .query<{ id: string }>("SELECT id FROM signal WHERE incidentId = ?", [incidentId])
    .map((row) => row.id);
