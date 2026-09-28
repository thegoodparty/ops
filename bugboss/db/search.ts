// Full-text search over incidents that already claimed a problem was over.
//
// The corpus already exists and nothing read it back: CLOSED requires a
// post-mortem, so every incident that ever ended carries a timeline, a root
// cause and five whys. This makes it reachable.
//
// FTS5, which better-sqlite3 already ships. No embeddings, no similarity
// threshold, no index to keep warm in another process -- the point is
// something legible enough that a wrong answer can be explained by reading
// the query, and cheap enough to sit in the same transaction as the write
// that caused it.

import type Database from "better-sqlite3";

import type { IncidentMatch } from "../types";

export type { IncidentMatch };

/** The read half of the database. `Db` satisfies it structurally. */
export interface SearchReader {
  query<T = unknown>(sql: string, params?: unknown[]): T[];
}

const MAX_TERMS = 12;
const MIN_TERM_CHARS = 3;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/**
 * Words that match everything and rank nothing. Short, and deliberately not a
 * general English stop list: this corpus is incident prose, so "error",
 * "failed" and "prod" are the ones that appear in every document.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "was", "were", "with", "this", "that", "from", "into",
  "has", "had", "have", "not", "but", "its", "our", "all", "any", "are",
  "error", "errors", "failed", "failure", "issue", "incident", "alert",
  "prod", "production", "users", "user", "service", "when", "after", "before",
]);

/**
 * Natural language in, a safe MATCH expression out.
 *
 * Raw text cannot be handed to MATCH: FTS5 reads `:` as a column filter, `*`
 * as a prefix and an unbalanced quote as a syntax error, so a model-written
 * sentence throws rather than searching. Every surviving term is quoted,
 * which leaves no operator reachable from the input at all.
 *
 * Quoting makes a term a phrase, not a literal: it is tokenized the same way
 * the corpus was, so `"connection_pool"` is the phrase `connection pool` and
 * matches either spelling. That is why the split below keeps underscores --
 * an identifier stays one phrase, which asks for adjacency, where splitting
 * on the underscore would widen it to every incident that said "pool".
 */
export const toMatchQuery = (raw: string): string | null => {
  const terms = [
    ...new Set(
      raw
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((term) => term.length >= MIN_TERM_CHARS && !STOPWORDS.has(term)),
    ),
  ].slice(0, MAX_TERMS);
  return terms.length === 0 ? null : terms.map((term) => `"${term}"`).join(" OR ");
};

/**
 * Re-index one incident. Delete then insert, because FTS5 has no upsert and
 * this runs again every time the incident changes.
 *
 * Synchronous and takes a raw handle: it belongs inside the `withWrite`
 * transaction that produced the text, so an indexed incident and a resolved
 * one are the same commit.
 */
export const indexIncident = (w: Database.Database, incidentId: string): void => {
  const row = w
    .prepare(
      `SELECT i.id AS id, i.rootCause AS rootCause, i.resolvedEvidence AS resolvedEvidence,
              i.postmortem AS postmortem, i.recurrenceAnalysis AS recurrenceAnalysis,
              (SELECT group_concat(s.title, ' ') FROM signal s WHERE s.incidentId = i.id) AS titles
       FROM incident i WHERE i.id = ?`,
    )
    .get(incidentId) as
    | {
        id: string;
        rootCause: string | null;
        resolvedEvidence: string | null;
        postmortem: string | null;
        recurrenceAnalysis: string | null;
        titles: string | null;
      }
    | undefined;
  if (!row) return;

  w.prepare("DELETE FROM incident_fts WHERE incidentId = ?").run(incidentId);
  w.prepare(
    `INSERT INTO incident_fts
       (incidentId, titles, rootCause, resolvedEvidence, postmortem)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.titles ?? "",
    row.rootCause ?? "",
    row.resolvedEvidence ?? "",
    // The recurrence analysis is part of what a future search should find:
    // "this came back once before, and here is why" is the most useful
    // sentence in the corpus.
    [row.postmortem ?? "", row.recurrenceAnalysis ?? ""].join("\n").trim(),
  );
};

/**
 * Index every RESOLVED or CLOSED incident the table does not have yet.
 *
 * Two jobs in one query. It backfills a corpus that predates the table --
 * `schema.sql` runs over a restored snapshot, so the first boot after this
 * ships finds an empty index and a full history -- and it repairs anything a
 * later write missed, which makes the per-transition index a fast path
 * rather than the only path.
 */
export const reconcileSearchIndex = async (db: {
  query<T>(sql: string, params?: unknown[]): T[];
  withWrite<T>(fn: (w: Database.Database) => T): Promise<T>;
}): Promise<{ indexed: number }> => {
  const missing = db.query<{ id: string }>(
    `SELECT id FROM incident
     WHERE status IN ('RESOLVED','CLOSED')
       AND id NOT IN (SELECT incidentId FROM incident_fts)
     ORDER BY id`,
  );
  if (missing.length === 0) return { indexed: 0 };

  await db.withWrite((w) => {
    for (const row of missing) indexIncident(w, row.id);
  });
  return { indexed: missing.length };
};

/**
 * Throws on a failed read, like every other helper that answers a question
 * about recurrence. An empty array means "nothing in the corpus matches",
 * which is the one answer a broken search must never be able to produce.
 */
export const searchIncidents = (
  db: SearchReader,
  text: string,
  limit = DEFAULT_LIMIT,
): IncidentMatch[] => {
  const match = toMatchQuery(text);
  if (!match) return [];

  return db.query<IncidentMatch>(
    // bm25 takes one weight per column, unindexed ones included, so the
    // leading 0.0 is incidentId. A hit in the recorded cause is worth more
    // than a hit somewhere in five pages of timeline. The score is negative
    // and ascending, so ORDER BY without DESC is best-first.
    //
    // The excerpt comes from the post-mortem because that is the column
    // nothing else surfaces; rootCause is returned whole beside it.
    `SELECT f.incidentId AS incidentId, i.status AS status, i.rootCause AS rootCause,
            i.resolvedAt AS resolvedAt,
            snippet(incident_fts, 4, '[', ']', '...', 24) AS excerpt
     FROM incident_fts f
     JOIN incident i ON i.id = f.incidentId
     WHERE incident_fts MATCH ?
       AND i.status IN ('RESOLVED','CLOSED')
     ORDER BY bm25(incident_fts, 0.0, 2.0, 3.0, 2.0, 1.0)
     LIMIT ?`,
    [match, Math.min(Math.max(1, limit), MAX_LIMIT)],
  );
};
