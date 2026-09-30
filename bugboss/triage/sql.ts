// Read-only SQL over the incident database, exposed as a tool to the Boss's
// own agentic calls. Design spec: bugboss/docs/architecture.md, "Who can query it".
//
// The digest answers "what is open right now". This answers everything else:
// has this alert slug produced a real incident before, how did the last one
// resolve, how often does this fire and get suppressed.

import { searchIncidents, UnsearchableQuery, type SearchReader } from "../db/search";
import type { LoopTool } from "./model";

/** The read half of the database. `Db` from ../db satisfies it structurally. */
export interface IncidentReader {
  query<T = unknown>(sql: string, params?: unknown[]): T[];
}

export const QUERY_TOOL = "query_incidents";
export const SEARCH_TOOL = "search_incidents";

const MAX_ROWS = 50;

export const SCHEMA_SUMMARY = `incident(
  id TEXT, status TEXT in (INVESTIGATING,FIXING,RESOLVED,CLOSED,MERGED),
  rootCause TEXT, prUrls TEXT json, postmortem TEXT,
  usersImpacted INT, impactQuery TEXT,
  impactStartedAt INT, firstSignalAt INT, fixingAt INT, resolvedAt INT, closedAt INT,
  mergedInto TEXT, recurrenceOf TEXT, attempts INT, modelId TEXT,
  tokensIn INT, tokensOut INT, cacheRead INT, cacheWrite INT, cacheWrite1h INT)
signal(
  id TEXT, source TEXT, sourceId TEXT, kind TEXT, title TEXT, body TEXT,
  labels TEXT json, reportedBy TEXT, openedAt INT, closedAt INT,
  incidentId TEXT, explained INT,
  tokensIn INT, tokensOut INT, cacheRead INT, cacheWrite INT,
  modelCalls INT, modelId TEXT)
The token columns on signal are what triage spent placing it. There is no
cost column on signal: price the tokens against modelId if somebody asks for
dollars, and say it is an estimate.
Timestamps are epoch milliseconds. Labels and prUrls are JSON text; use
json_extract(labels, '$.alert_slug') to read one.
There is no cost column. Spend is recorded in tokens because prices move and
tokens do not; a dollar figure is arithmetic over these and modelId, and is an
estimate whenever you quote one. An incident's tokens are its own agent's
only; the incidents merged into it keep theirs on their own rows (mergedInto
is that id), so add those when somebody asks what an incident cost in all.`;

// The guard below used to exist twice, against the same database, with
// different answers: this one allowed SELECT and WITH and checked the raw
// text, while the Slack agent's allowed EXPLAIN too, stripped comments and
// string literals before checking anything, and scanned for nineteen write
// keywords. Neither caller ever saw the other, so nobody noticed that the
// path running on every single signal was the weaker one -- and that checking
// raw text means a semicolon inside a string literal is a false refusal.
//
// One guard now, the stronger of the two.

const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|VACUUM|PRAGMA|REINDEX|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RETURNING)\b/i;

/**
 * Blank out string literals, bracketed identifiers and comments, so the
 * checks below read only code. Checking raw text is how a `;` or a `DROP`
 * inside a quoted string becomes a refusal of a legitimate query.
 */
const stripSqlNoise = (sql: string): string => {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === "[") {
      while (i < sql.length && sql[i] !== "]") i++;
      i++;
      out += " ";
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

/**
 * The read connection is already opened read-only, so containment is not what
 * this is for: a write fails at the driver even if this misses one. It runs
 * first because a correctable sentence beats a SQLITE_READONLY stack trace to
 * a model that can try again, and because it is what keeps multi-statement
 * input away from the driver at all.
 *
 * Returns an error rather than throwing, which is the shape both callers
 * want: the answer goes back to the model as a tool result either way, and a
 * throw would have to be caught at every call site to become one.
 */
export const prepareQuery = (raw: string): { sql: string } | { error: string } => {
  const sql = raw.trim().replace(/;+\s*$/, "").trim();
  const body = stripSqlNoise(sql).trim().replace(/;\s*$/, "");
  if (body.length === 0) return { error: "empty query" };
  if (body.includes(";")) {
    return { error: "one statement at a time; remove the extra ';'" };
  }
  if (!/^(select|with|explain)\b/i.test(body)) {
    return {
      error: "read-only access: statements must start with SELECT, WITH or EXPLAIN",
    };
  }
  const hit = body.match(FORBIDDEN);
  if (hit) {
    return { error: `read-only access: ${hit[1].toUpperCase()} is not allowed` };
  }
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
      // Rows, and only rows. The result used to be cut at 4,000 characters
      // on top of the row cap, which meant a query whose answer was in a
      // long column came back looking complete and was not -- and the model
      // has no way to tell a short answer from a cut one.
      return `${rows.length} row(s), showing ${head.length}: ${JSON.stringify(head)}`;
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

/** Throws on a failed read, for the same reason: [] means "nothing attached". */
export const attachedSignalIds = (db: IncidentReader, incidentId: string): string[] =>
  db
    .query<{ id: string }>("SELECT id FROM signal WHERE incidentId = ?", [incidentId])
    .map((row) => row.id);

const MAX_SEARCH_RESULTS = 5;

/**
 * Text search over the post-mortems of incidents that already claimed a
 * problem was over. A tool rather than a lookup done for the caller, because
 * a search needs a query and only something that has read the signal can
 * write one -- and because the incident agent needs the same reach, not just
 * triage.
 *
 * It catches what an exact key cannot: the same cause returning through a
 * different alert rule. That is the premature close worth catching, and no
 * structural key sees it.
 */
export const searchTool = (db: SearchReader & IncidentReader): LoopTool => ({
  spec: {
    name: SEARCH_TOOL,
    description:
      "Search the post-mortems, root causes and resolution evidence of incidents that were RESOLVED or CLOSED. Pass plain words describing the failure -- the mechanism, the component, the error text -- not a question and not SQL. Returns the best matches with an excerpt of where the query hit.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "Words from the signal: the failing operation, the component, the error. Common incident words like 'error' and 'prod' are ignored.",
        },
      },
      required: ["text"],
    },
  },
  run: (input) => {
    const text = typeof input.text === "string" ? input.text : "";
    if (text.trim().length === 0) return "error: search needs some text";
    try {
      const hits = searchIncidents(db, text, MAX_SEARCH_RESULTS);
      if (hits.length === 0) {
        return "0 matches. Nothing already closed reads like this, on these words.";
      }
      return hits
        .map(
          (hit) =>
            `- ${hit.incidentId} | ${hit.status} | resolved ${
              hit.resolvedAt ? new Date(hit.resolvedAt).toISOString().slice(0, 10) : "?"
            }\n  rootCause: ${hit.rootCause ?? "never established"}\n  matched: ${hit.excerpt}`,
        )
        .join("\n");
    } catch (err) {
      // Never an empty result. "The search is broken" and "nothing in the
      // corpus matches" are the two answers that must not look alike, and
      // "the query never ran" is a third that must not look like either.
      if (err instanceof UnsearchableQuery) {
        return `error: ${(err as Error).message} Nothing was compared against the corpus -- search again with the failing operation, the component or the error text.`;
      }
      return `error: the incident search failed (${String(err)}); this is not the same as finding nothing`;
    }
  },
});
