/**
 * The one read-only path to the swarm's ledger.
 *
 * Kept apart from `export-usage.ts` so the SQLite driver is a parameter rather
 * than an import. The host runs `bun`, whose `bun:sqlite` is the driver the spec
 * names; the repo's test suite runs `tsx` on node, where that module does not
 * exist. Passing the driver in lets the tests drive this exact code against a
 * real fixture database under `node:sqlite`, instead of testing a paraphrase of
 * it.
 *
 * ## What the shape guarantees
 *
 * - **One connection, one read transaction.** Both statements run between one
 *   `BEGIN` and one `COMMIT`, so they see one snapshot. Without it, a task
 *   deleted upstream between the two reads leaves a cost row whose edge row is
 *   gone, and the nightly warehouse build fails instead of this run.
 * - **Closed before anything else happens.** The connection closes when the
 *   callback returns, so serialization and the uploads run with no reader open.
 *   A short read cannot starve a WAL checkpoint.
 * - **Read-only, and never a copy.** `readonly: true` means the store refuses a
 *   write rather than this code promising not to. The file is opened where it
 *   lives: a filesystem copy of a live WAL database is a torn read, and
 *   `immutable=1` would ignore the write-ahead log and return an old snapshot as
 *   if it were current.
 */

export type SqliteStatement = {
  all(...params: unknown[]): unknown[];
};

export type SqliteHandle = {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): unknown;
};

/** Opens a read-only connection to `path`. `bun:sqlite`'s `Database` fits this as-is. */
export type SqliteOpen = (path: string) => SqliteHandle;

export type SnapshotReader = {
  query(sql: string, params?: readonly unknown[]): Record<string, unknown>[];
};

/**
 * Wrap a driver's open function into the `readSnapshot` the export takes.
 *
 * The `finally` is what makes the "closed before serialization" claim true even
 * when a statement throws: a failed read must not leave a reader holding a
 * snapshot open on a database the swarm is writing.
 */
export const readSnapshotWith =
  (open: SqliteOpen) =>
  (databasePath: string) =>
  <T>(fn: (reader: SnapshotReader) => T): T => {
    const db = open(databasePath);
    try {
      db.exec("BEGIN");
      const reader: SnapshotReader = {
        query: (sql, params = []) =>
          db.prepare(sql).all(...params) as Record<string, unknown>[],
      };
      const result = fn(reader);
      db.exec("COMMIT");
      return result;
    } finally {
      db.close();
    }
  };

/**
 * The whole database path from a volume mountpoint.
 *
 * Resolved at run time rather than hardcoded under `/var/lib/docker`, because
 * Docker's root can move and only the compose project name (which makes the
 * volume `agent-swarm_swarm_api_data`) is stable.
 */
export const databasePathFrom = (mountpoint: string): string =>
  `${mountpoint.replace(/\/+$/, "")}/${DATABASE_FILE_NAME}`;

export const DATABASE_FILE_NAME = "agent-swarm-db.sqlite";
