import type { SnapshotReader } from "./export-usage-sqlite";

/**
 * The delegate swarm's usage export, minus everything that touches a database,
 * a bucket or a clock.
 *
 * The split is this repo's `usage-export-core.ts` / `usage-export-handler.ts`
 * pattern: the decisions that can be silently wrong live here, where a unit test
 * can reach them without a real SQLite file or an AWS credential, and
 * `export-usage.ts` is the small half that opens the connection, writes the temp
 * files and shells out to the AWS CLI.
 *
 * ## What it exports
 *
 * Two JSON Lines files per run, one per table, into two prefixes of the bucket
 * the Bifrost usage export already writes. The data contract is
 * `02-spec.md` section 1 in `gp-data-platform`'s DATA-2843 ticket folder; the
 * landing column lists below are a checked-in copy of it, and
 * `scripts/export-usage-core.test.ts` pins them as literals so a local edit fails
 * a test rather than drifting from the loader's `LANDING_COLUMNS`.
 *
 * One prefix per table, never one shared prefix, because `COPY INTO` reads a
 * whole prefix: a shared one would make each table's load read the other table's
 * file and fail on the columns it does not have.
 *
 * ## The three things that are easy to get wrong
 *
 * **One read transaction.** Both statements run inside a single read transaction
 * on one read-only connection, which is closed before anything is serialized or
 * uploaded (`readSnapshot` below). A task deleted upstream between the two
 * statement would otherwise leave a cost row whose edge row is gone, and the
 * nightly warehouse build would fail on it rather than the run failing here.
 *
 * **Money.** The ledger stores cost as a SQLite REAL. It is rendered as a
 * six-decimal string by `printf` in SQL, so the value that crosses is a decimal
 * string of the width the landing column (`DECIMAL(20,6)`) takes, never a JSON
 * number that a reader would parse as a binary float.
 *
 * **A null is not a zero.** `printf('%.6f', NULL)` returns `"0.000000"`, so every
 * money column that can be null carries an explicit `CASE`; without it a
 * session the adapter could not price would land as a priced zero.
 */

/** The bucket the Bifrost usage export writes. `deploy-workbench/usage-export.ts` owns it. */
export const BUCKET = "goodparty-workbench-bifrost-usage";

export const REGION = "us-west-2";

/**
 * The two prefixes, siblings under `delegate-swarm/` and never children of
 * `bifrost/logs`: Unity Catalog refuses an external location nested inside
 * another, which is why the terraform side adds a second location.
 */
export const SESSION_COST_PREFIX = "delegate-swarm/session-cost";
export const TASK_EDGE_PREFIX = "delegate-swarm/task-edge";

/**
 * Re-send windows. Seven days daily heals a cost row posted after a run had read
 * the ledger; ninety days on the first of the month heals a row whose `task_id`
 * was nulled by a task deletion upstream. Both files carry the same window.
 *
 * The read starts at 09:15, 45 minutes before the data volume's 10:00 snapshot,
 * and the unit's timeout bounds an on-time run to 30 minutes, so it finishes by
 * 09:45.
 */
export const DAILY_WINDOW_DAYS = 7;
export const MONTHLY_WINDOW_DAYS = 90;

/** The docker volume the api container's database lives in. The compose project name is pinned. */
export const DATABASE_VOLUME = "agent-swarm_swarm_api_data";

/**
 * What `agent_name` carries when a cost row's agent has no row in `agents`.
 *
 * Upstream's foreign key is `ON DELETE CASCADE`, so this should never happen. It
 * is a LEFT JOIN with a placeholder rather than an inner join because the
 * alternative is losing the cost row: a join cannot be allowed to drop the one
 * thing the export exists to carry. The loader's `not_null` test on `agent_name`
 * would otherwise be promising something the join had already removed.
 */
export const UNKNOWN_AGENT_NAME = "unknown_agent";

/**
 * The cost file's landing columns, in order, exactly as `02-spec.md` section 1
 * lists them. `exported_at` is the one the exporter stamps rather than reads.
 */
export const SESSION_COST_COLUMNS = [
  "id",
  "session_id",
  "task_id",
  "agent_id",
  "agent_name",
  "model",
  "cost_source",
  "kind",
  "total_cost_usd",
  "harness_cost_usd",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "reasoning_output_tokens",
  "thinking_tokens",
  "duration_ms",
  "num_turns",
  "is_error",
  "created_at",
  "exported_at",
] as const;

/** The edge file's landing columns, in order. All six, and nothing from `agent_tasks`' free text. */
export const TASK_EDGE_COLUMNS = [
  "task_id",
  "parent_task_id",
  "dispatched_by_task_id",
  "status",
  "created_at",
  "exported_at",
] as const;

/**
 * The cost statement. `agents` is joined in rather than read separately, so the
 * three column lists of the data contract are two statements; both are inside the
 * one read transaction, which is what the snapshot property needs.
 *
 * `created_at >= ?` with no upper bound: the run reads whatever is committed when
 * it opens, so a bound above would only risk dropping a row written with a skewed
 * clock.
 */
export const SESSION_COST_SQL = `SELECT
  sc.id                                       AS id,
  sc.sessionId                                AS session_id,
  sc.taskId                                   AS task_id,
  sc.agentId                                  AS agent_id,
  COALESCE(ag.name, '${UNKNOWN_AGENT_NAME}')  AS agent_name,
  sc.model                                    AS model,
  sc.costSource                               AS cost_source,
  sc.kind                                     AS kind,
  CASE WHEN sc.totalCostUsd IS NULL THEN NULL ELSE printf('%.6f', sc.totalCostUsd) END
                                              AS total_cost_usd,
  CASE WHEN sc.harnessCostUsd IS NULL THEN NULL ELSE printf('%.6f', sc.harnessCostUsd) END
                                              AS harness_cost_usd,
  sc.inputTokens                              AS input_tokens,
  sc.outputTokens                             AS output_tokens,
  sc.cacheReadTokens                          AS cache_read_tokens,
  sc.cacheWriteTokens                         AS cache_write_tokens,
  sc.cacheWrite5mTokens                       AS cache_write_5m_tokens,
  sc.cacheWrite1hTokens                       AS cache_write_1h_tokens,
  sc.reasoningOutputTokens                    AS reasoning_output_tokens,
  sc.thinkingTokens                           AS thinking_tokens,
  sc.durationMs                               AS duration_ms,
  sc.numTurns                                 AS num_turns,
  sc.isError                                  AS is_error,
  sc.createdAt                                AS created_at
FROM session_costs sc
LEFT JOIN agents ag ON ag.id = sc.agentId
WHERE sc.createdAt >= ?
ORDER BY sc.createdAt, sc.id`;

/** The edge statement. Six columns, and `ORDER BY` so two runs of the same ledger agree byte for byte. */
export const TASK_EDGE_SQL = `SELECT
  t.id                  AS task_id,
  t.parentTaskId        AS parent_task_id,
  t.dispatchedByTaskId  AS dispatched_by_task_id,
  t.status              AS status,
  t.createdAt           AS created_at
FROM agent_tasks t
WHERE t.createdAt >= ?
ORDER BY t.createdAt, t.id`;

export type ExportTable = {
  /** The table's name in log lines and in a test's assertion. */
  readonly table: string;
  /** The stem of the object's file name. */
  readonly stem: string;
  readonly prefix: string;
  readonly columns: readonly string[];
  readonly sql: string;
};

export const EXPORTS: readonly ExportTable[] = [
  {
    table: "session_cost",
    stem: "session-cost",
    prefix: SESSION_COST_PREFIX,
    columns: SESSION_COST_COLUMNS,
    sql: SESSION_COST_SQL,
  },
  {
    table: "task_edge",
    stem: "task-edge",
    prefix: TASK_EDGE_PREFIX,
    columns: TASK_EDGE_COLUMNS,
    sql: TASK_EDGE_SQL,
  },
];

/** `YYYYMMDDTHHMMSSZ`, the object-key stamp, from the run's UTC start. */
export const compactStamp = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/**
 * `YYYY-MM-DDTHH:MM:SSZ`, the same instant as `compactStamp` in timestamp form.
 *
 * Truncated to the second rather than carrying milliseconds so a row's stamp and
 * its file name are literally the same digits. Nothing downstream needs the
 * sub-second part: the window is days wide.
 */
export const exportedAtStamp = (at: Date): string =>
  `${at.toISOString().slice(0, 19)}Z`;

/** The object key for one table: `<prefix>/<stem>-<stamp>.ndjson`. */
export const objectKey = (table: ExportTable, startedAt: Date): string =>
  `${table.prefix}/${table.stem}-${compactStamp(startedAt)}.ndjson`;

/**
 * The window this run reads: ninety days on the first of the month, seven on
 * every other day. Decided from the run's UTC start, so the object key and the
 * window always come from the same instant.
 */
export const windowDaysFor = (startedAt: Date): number =>
  startedAt.getUTCDate() === 1 ? MONTHLY_WINDOW_DAYS : DAILY_WINDOW_DAYS;

/**
 * The lower bound of the window, in the `strftime('%Y-%m-%dT%H:%M:%fZ')` shape
 * upstream writes: `2026-11-23T18:25:01.123Z`, which is exactly what
 * `Date.prototype.toISOString` produces. So the comparison in SQL is a plain
 * string `>=` and needs no parsing.
 */
export const windowStart = (startedAt: Date, days: number): string =>
  new Date(startedAt.getTime() - days * 24 * 60 * 60 * 1000).toISOString();


/** One row as the landing object, keys in landing-column order. */
export const toLandingRow = (
  columns: readonly string[],
  row: Record<string, unknown>,
  exportedAt: string,
): Record<string, unknown> =>
  Object.fromEntries(
    columns.map((column) => [
      column,
      column === "exported_at" ? exportedAt : row[column] === undefined ? null : row[column],
    ]),
  );

/**
 * The file body: one JSON object per line, no indentation, no nesting, and a
 * newline after every row **including the last**.
 *
 * The final newline is deliberate rather than tidy. It is the conventional
 * JSON Lines terminator, and `COPY INTO` with `fileformat = json` reads the empty
 * string after it as no row at all, so a file ends on a boundary.
 */
export const toJsonLines = (
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  exportedAt: string,
): string =>
  rows
    .map((row) => JSON.stringify(toLandingRow(columns, row, exportedAt)))
    .map((line) => `${line}\n`)
    .join("");

/** What one table's upload did. */
export type WriteOutcome = "uploaded" | "already-exists" | "failed" | "not-attempted";

export type TableReport = {
  table: string;
  key: string;
  rows: number;
  outcome: WriteOutcome;
  /** The AWS CLI's message, on `failed` only. */
  error?: string;
};

export type ExportOutcome = {
  /** 0 when both files are written or already present; 1 on any read or upload error. */
  exitCode: number;
  reports: TableReport[];
};

/** A read-only handle on the ledger, valid only inside `readSnapshot`'s callback. */
export type SqliteReader = SnapshotReader;

export type PutResult =
  | { ok: true }
  /** A 412: this second's file is already there. Not an error. */
  | { ok: false; alreadyExists: true }
  | { ok: false; alreadyExists?: false; error: string };

export type ExporterDeps = {
  /**
   * Run `fn` inside one read transaction on a fresh read-only connection, then
   * close it. Nothing returned by this may hold the connection open: the
   * serialization and the uploads happen after it has closed, which is what keeps
   * the read short enough not to starve a WAL checkpoint.
   */
  readSnapshot<T>(fn: (reader: SqliteReader) => T): T;
  putObject(args: { bucket: string; key: string; body: string }): PutResult;
  now(): Date;
  log(line: string): void;
};

/**
 * The run: one snapshot of the ledger, then a file per table, uploaded
 * conditionally.
 *
 * The cost file is written first and the edge file second, and a hard failure
 * stops the run, so the two land in that order or not at all. They are still two
 * objects and cannot be atomic: a cost file that lands without its edge file
 * leaves that day's tasks rooted at themselves until the next run's seven day
 * window heals it, which the loader's tests record rather than this code
 * pretending otherwise.
 */
export const runExport = (deps: ExporterDeps): ExportOutcome => {
  const startedAt = deps.now();
  const exportedAt = exportedAtStamp(startedAt);
  const days = windowDaysFor(startedAt);
  const since = windowStart(startedAt, days);
  deps.log(`export-usage: reading ${days} days from ${since}, stamp ${exportedAt}`);

  let rowsByTable: Record<string, Record<string, unknown>[]>;
  try {
    rowsByTable = deps.readSnapshot((reader) =>
      Object.fromEntries(EXPORTS.map((table) => [table.table, reader.query(table.sql, [since])])),
    );
  } catch (error) {
    // No object is written for either table: a half-read ledger is not a file.
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`export-usage: read failed, no object written: ${message}`);
    return {
      exitCode: 1,
      reports: EXPORTS.map((table) => ({
        table: table.table,
        key: objectKey(table, startedAt),
        rows: 0,
        outcome: "not-attempted",
        error: message,
      })),
    };
  }

  const reports: TableReport[] = [];
  let failed = false;
  for (const table of EXPORTS) {
    const key = objectKey(table, startedAt);
    const rows = rowsByTable[table.table] ?? [];
    if (failed) {
      reports.push({ table: table.table, key, rows: rows.length, outcome: "not-attempted" });
      continue;
    }
    let body: string;
    try {
      body = toJsonLines(rows, table.columns, exportedAt);
    } catch (error) {
      // A row that will not serialize is a missing or renamed column, which is a
      // contract break rather than a bad night.
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`export-usage: ${table.table} serialization failed, no object written: ${message}`);
      reports.push({ table: table.table, key, rows: rows.length, outcome: "failed", error: message });
      failed = true;
      continue;
    }

    const put = deps.putObject({ bucket: BUCKET, key, body });
    if (put.ok) {
      deps.log(`export-usage: wrote s3://${BUCKET}/${key} (${rows.length} rows)`);
      reports.push({ table: table.table, key, rows: rows.length, outcome: "uploaded" });
      continue;
    }
    if (put.alreadyExists) {
      // A rerun inside the same second, or a rerun of a run that succeeded.
      // Each run's key is its own start, so nothing is lost and nothing needs
      // overwriting.
      deps.log(`export-usage: s3://${BUCKET}/${key} already exists, leaving it alone (${rows.length} rows not resent)`);
      reports.push({ table: table.table, key, rows: rows.length, outcome: "already-exists" });
      continue;
    }
    deps.log(`export-usage: ${table.table} upload failed: ${put.error}`);
    reports.push({ table: table.table, key, rows: rows.length, outcome: "failed", error: put.error });
    failed = true;
  }

  return { exitCode: failed ? 1 : 0, reports };
};
