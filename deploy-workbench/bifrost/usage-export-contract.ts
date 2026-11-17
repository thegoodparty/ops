/**
 * The usage export's contract: the names, the numbers a second file has to
 * agree with, and the one thing both repos must not disagree about.
 *
 * A plain module with no `@pulumi/aws`, no `pg` and no AWS SDK, for the reason
 * `bifrost/vk-janitor-contract.ts` is one: the Pulumi program
 * (`deploy-workbench/usage-export.ts`), the handler
 * (`bifrost/usage-export-handler.ts`), the deploy's poll
 * (`scripts/verify-usage-export-bootstrap.ts`) and both test files read the same
 * numbers, and a Pulumi runtime in a workflow step or a database client in a
 * unit test would be the cost of splitting them.
 *
 * ## The column list is a copy, and it says so
 *
 * `EXPORTED_COLUMNS` is the 29 columns the export reads out of the gateway's
 * `logs` table, plus `exported_at` which the export stamps. It is copied from
 * `airflow/astro/include/custom_functions/bifrost_export.py` in
 * `thegoodparty/gp-data-platform`, whose `LANDING_COLUMNS` is the authority: the
 * loader's DDL, its COPY INTO projection and its cross-subproject drift test are
 * all built from that one tuple, and the file this module writes has to match it
 * column for column and in order.
 *
 * A copy rather than a test that reads the Python by path, on purpose. That repo
 * is not checked out in this repo's CI, so a test that reads it would either
 * fail every run or skip every run, and a permanently-skipping test reads as a
 * passing one. A pinned copy at least fails on a local edit, and the cross-repo
 * drift is a stated, accepted gap rather than something a test pretends to
 * cover. When the loader's list changes, this list changes in the same week and
 * the PR says so.
 *
 * ## Types
 *
 * Types are Parquet physical types, not Databricks types, because this module's
 * consumer is the writer. The loader casts every column explicitly regardless
 * (`build_copy_sql`), so a mismatch is a readable error there rather than a
 * column of nulls.
 *
 * Money is `DECIMAL`, never `DOUBLE`: these are summed across hundreds of
 * thousands of rows in the mart, and the file is also read directly by anyone
 * checking a number. The writer's `unconvert` treats a `bigint` on a `DECIMAL`
 * column as the already-scaled unscaled value, so the handler converts the
 * decimal string to a `bigint` and never lets the value pass through a JS
 * `number`.
 */

/**
 * The function, role, secret and alarm names.
 *
 * The function and role share one name, as the mint's and the janitor's do, so
 * CloudTrail and the console show one string. Nothing else in the repo trusts
 * this name (unlike the janitor's, which `deploy/components/bifrost-vk-reader.ts`
 * pins), so renaming it is a rename rather than an `AccessDenied`.
 */
export const USAGE_EXPORT_NAME = "bifrost-usage-export";
export const USAGE_EXPORT_FUNCTION_NAME = USAGE_EXPORT_NAME;
export const USAGE_EXPORT_ROLE_NAME = USAGE_EXPORT_NAME;
export const USAGE_EXPORT_LOG_GROUP_NAME = `/aws/lambda/${USAGE_EXPORT_FUNCTION_NAME}`;

/** Same thirty days as the mint's and the gateway's own group. */
export const USAGE_EXPORT_LOG_RETENTION_DAYS = 30;

/**
 * The Lambda's shell.
 *
 * 900s is the runtime's ceiling and it is the number the monthly run is sized
 * against, not the daily one: a 7-day window is under a second of work, while a
 * 90-day window is the largest read this job ever does. Memory is 512 MB against
 * a measured peak under 125 MB at the monthly row count, because Lambda bills
 * duration and the headroom is fractions of a cent for a job that runs once a
 * day.
 */
export const USAGE_EXPORT_TIMEOUT_SECONDS = 900;
export const USAGE_EXPORT_MEMORY_MB = 512;

/**
 * One run at a time, for the reason the janitor sets it (two runs writing
 * overlapping windows is not something to reason about when the fix is a line)
 * and to bound this job's load on the shared instance. The schedule is set so
 * it never actually throttles; this is the backstop for a manual invoke landing
 * on a scheduled one.
 */
export const USAGE_EXPORT_RESERVED_CONCURRENCY = 1;

/**
 * The two windows, in days, against the gateway's 90-day log retention.
 *
 * Seven days daily, because `logs` rows are written `processing` and later
 * updated to a terminal status with cost and tokens, so a run that read only new
 * rows would capture requests mid-flight and never see their cost. Ninety on the
 * first of the month, so a row repriced after it left the 7-day window is
 * re-observed eventually (`plugins/logging/costrecalc.go` recalcs a
 * caller-supplied window, so late repricing is real if rare).
 */
export const USAGE_EXPORT_DAILY_WINDOW_DAYS = 7;
export const USAGE_EXPORT_MONTHLY_WINDOW_DAYS = 90;

/**
 * The two schedule expressions, and the half hour between them is load-bearing.
 *
 * `reservedConcurrentExecutions: 1` means a second invocation arriving while one
 * runs is refused with `TooManyRequestsException`, and that refusal lands in
 * `Throttles`, not `Errors` — so the failure alarm would not fire for it,
 * EventBridge would retry and then drop it, and the monthly run would be missed
 * on the one day of the month it matters. Both at 09:00 would collide every
 * month.
 *
 * 09:00 UTC is 1 to 2am Pacific, clear of the 00:02 UTC dbt build and of the US
 * working day.
 */
export const USAGE_EXPORT_DAILY_SCHEDULE = "cron(0 9 * * ? *)";
export const USAGE_EXPORT_MONTHLY_SCHEDULE = "cron(30 9 1 * ? *)";

/**
 * How long one statement may run, in milliseconds, and why it is not the
 * function's timeout.
 *
 * The export is a guest on a `t4g.micro` shared with the one gateway every
 * engineer codes through. A predicate on `timestamp` should use
 * `idx_logs_timestamp`, and a read of one window should take seconds; 300s is
 * orders of magnitude above that and still far inside the 900s ceiling, so a plan
 * that went wrong costs the instance five minutes and one alarm rather than
 * fifteen minutes of scan. It is passed to `pg` as `statement_timeout`, which the
 * client sends as a startup parameter.
 */
export const USAGE_EXPORT_STATEMENT_TIMEOUT_MS = 300_000;

/**
 * Rows per page. The measured peak RSS at the monthly row count is under 125 MB
 * at this size, and a multiple-of-20k page count keeps the row-group layout of
 * the file regular without being a partition scheme.
 */
export const USAGE_EXPORT_PAGE_ROWS = 20_000;

/**
 * The read-only Postgres role the export connects as. Its name is shared with
 * the bootstrap function's DDL, so the two cannot disagree.
 */
export const USAGE_EXPORT_DB_ROLE = "bifrost_usage_export";

/**
 * The Secrets Manager container the export's password lives in, and the JSON key
 * inside it.
 *
 * `password` is not a choice: `bifrost/pg-password.sh` already resolves the
 * gateway's own password with `jq -er '.password'`, so this account has one
 * convention for a database password and not two. The bootstrap writes it and
 * the handler reads it.
 */
export const USAGE_EXPORT_SECRET_NAME = "bifrost/usage-export";
export const USAGE_EXPORT_SECRET_JSON_KEY = "password";

/** The bootstrap function, which exists to be removed. See `usage-export.ts`. */
export const USAGE_EXPORT_BOOTSTRAP_NAME = "bifrost-usage-export-db-bootstrap";
export const USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME = USAGE_EXPORT_BOOTSTRAP_NAME;
export const USAGE_EXPORT_BOOTSTRAP_ROLE_NAME = USAGE_EXPORT_BOOTSTRAP_NAME;
export const USAGE_EXPORT_BOOTSTRAP_LOG_GROUP_NAME = `/aws/lambda/${USAGE_EXPORT_BOOTSTRAP_FUNCTION_NAME}`;
export const USAGE_EXPORT_BOOTSTRAP_TIMEOUT_SECONDS = 120;
export const USAGE_EXPORT_BOOTSTRAP_MEMORY_MB = 256;

/**
 * What one bootstrap invocation returns.
 *
 * `already-provisioned` is the no-op that lets the deploy workflow invoke this
 * on every deploy: the export's secret holding a non-empty password means the
 * role and the password exist and must not be rotated under a running export.
 * It is a discriminated union rather than a boolean so the workflow can tell
 * "nothing to do" from "I just did it", and `provisioned` is what the poll
 * reports.
 */
export type BootstrapOutcome =
  | { outcome: "provisioned" }
  | { outcome: "already-provisioned" };

/**
 * The bootstrap's reply, validated rather than trusted.
 *
 * A Lambda can return anything on a bug, and the workflow reads this string to
 * decide whether the deploy is green. An unrecognised value is a failure, not a
 * pass, which is the same rule `rows_inserted` follows on the loader side.
 */
export const isBootstrapOutcome = (value: unknown): value is BootstrapOutcome => {
  if (typeof value !== "object" || value === null) return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "provisioned" || outcome === "already-provisioned";
};

/**
 * The two alarms' names and descriptions.
 *
 * `never-ran` is the one that catches a run which did not start at all, which
 * the failure alarm structurally cannot: a disabled rule, a schedule that
 * stopped matching or a delete by a bad apply publishes no `Errors` datapoint,
 * and the failure alarm treats missing data as healthy. `Invocations` either
 * publishes a zero or publishes nothing, and the alarm below treats absence
 * itself as the signal.
 */
export const USAGE_EXPORT_FAILURE_ALARM_NAME = `${USAGE_EXPORT_NAME}-failed`;
export const USAGE_EXPORT_NEVER_RAN_ALARM_NAME = `${USAGE_EXPORT_NAME}-never-ran`;

/** One day, in seconds: the granularity CloudWatch accepts for a daily alarm. */
export const USAGE_EXPORT_NEVER_RAN_PERIOD_SECONDS = 86_400;

/**
 * The alert topic. One topic for both alarms, not one each: they answer the same
 * operator question ("is the export working?") and two topics would be two
 * subscriptions to confirm on two separate AWS emails.
 */
export const USAGE_EXPORT_ALERT_TOPIC_NAME = `${USAGE_EXPORT_NAME}-alerts`;

/**
 * The exported columns, in the loader's order, with Parquet physical types.
 *
 * `exported_at` is not a column of the gateway's `logs` table; the export adds
 * it to every row. That distinction matters at the grant: the read-only role
 * holds a column-level `SELECT` over the 29 that exist, and a `GRANT` naming
 * `exported_at` would be rejected because Postgres will not grant a column that
 * does not exist. It is in this list because it is in the file.
 *
 * Every element is `OPTIONAL` because every source column is nullable
 * (`Cost *float64`, `VirtualKeyName *string`, `Latency *float64` in
 * `framework/logstore/tables.go` at the pinned tag), and a `REQUIRED` column
 * carrying a null is a writer error or a silent zero.
 */
export type ParquetPrimitive =
  | "BYTE_ARRAY"
  | "INT32"
  | "INT64"
  | "BOOLEAN"
  | "DOUBLE"
  | "FIXED_LEN_BYTE_ARRAY";

export type ExportColumn = {
  /** The column name in the gateway's table and in the landing table. */
  name: string;
  /** Parquet physical type. */
  type: ParquetPrimitive;
  /** Parquet converted type, where one narrows the physical type. */
  convertedType?: "UTF8" | "TIMESTAMP_MICROS" | "DECIMAL";
  /** For `DECIMAL` and `FIXED_LEN_BYTE_ARRAY`. */
  precision?: number;
  scale?: number;
  typeLength?: number;
  /**
   * How the handler turns the driver's value into what the writer takes:
   * `string` for text; `timestamp` for a `timestamptz` **read from the
   * database as a string**, which has to be parsed; `micros` for a timestamp this
   * job stamps itself, already epoch microseconds; `decimal` for a numeric read as
   * a string; `int` for a bigint-safe integer; `int32` for a small integer;
   * `bool`; and `double` for a measurement.
   *
   * `timestamp` and `micros` are deliberately separate kinds rather than one that
   * accepts either. Two of the three timestamp columns come from the driver as
   * strings and one is stamped here as a number, and a single kind that sniffed
   * the value's runtime type would hide precisely that difference.
   */
  kind: "string" | "timestamp" | "micros" | "decimal" | "int" | "int32" | "bool" | "double";
};

/**
 * 30 columns: the 29 the export reads plus `exported_at`, which it stamps.
 *
 * The order is the loader's `LANDING_COLUMNS` order minus `loaded_at`, which the
 * loader stamps server-side. A column added to one side and not the other
 * silently shifts every later value by a position, which is why
 * `usage-export-core.test.ts` asserts this list against a literal rather than
 * deriving it.
 */
export const EXPORTED_COLUMNS: readonly ExportColumn[] = [
  // identity and the two source clocks, plus the export's own stamp
  { name: "id", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "timestamp", type: "INT64", convertedType: "TIMESTAMP_MICROS", kind: "timestamp" },
  { name: "created_at", type: "INT64", convertedType: "TIMESTAMP_MICROS", kind: "timestamp" },
  { name: "exported_at", type: "INT64", convertedType: "TIMESTAMP_MICROS", kind: "micros" },
  // what was called and how it went
  { name: "provider", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "model", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "canonical_model_name", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "alias", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "object_type", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "status", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "is_passthrough", type: "BOOLEAN", kind: "bool" },
  { name: "fallback_index", type: "INT32", kind: "int32" },
  { name: "parent_request_id", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  // who called it, and from what
  { name: "app", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "user_agent", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "virtual_key_id", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "virtual_key_name", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "team_id", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "team_name", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "user_id", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  { name: "user_name", type: "BYTE_ARRAY", convertedType: "UTF8", kind: "string" },
  // what it cost
  {
    name: "cost",
    type: "FIXED_LEN_BYTE_ARRAY",
    convertedType: "DECIMAL",
    precision: 20,
    scale: 6,
    // 9 bytes holds 20 decimal digits: the loader declares DECIMAL(20,6).
    typeLength: 9,
    kind: "decimal",
  },
  {
    name: "input_cost",
    type: "FIXED_LEN_BYTE_ARRAY",
    convertedType: "DECIMAL",
    precision: 20,
    scale: 6,
    typeLength: 9,
    kind: "decimal",
  },
  {
    name: "output_cost",
    type: "FIXED_LEN_BYTE_ARRAY",
    convertedType: "DECIMAL",
    precision: 20,
    scale: 6,
    typeLength: 9,
    kind: "decimal",
  },
  {
    name: "additional_cost",
    type: "FIXED_LEN_BYTE_ARRAY",
    convertedType: "DECIMAL",
    precision: 20,
    scale: 6,
    typeLength: 9,
    kind: "decimal",
  },
  // what it used
  { name: "prompt_tokens", type: "INT64", kind: "int" },
  { name: "completion_tokens", type: "INT64", kind: "int" },
  { name: "total_tokens", type: "INT64", kind: "int" },
  { name: "cached_read_tokens", type: "INT64", kind: "int" },
  { name: "latency", type: "DOUBLE", kind: "double" },
] as const;

/**
 * The 29 columns the read-only Postgres role is granted `SELECT` on.
 *
 * `exported_at` is excluded because it does not exist in the gateway's table.
 * This is the list the bootstrap's `GRANT` names, so it has to be exactly this
 * and nothing more: a `GRANT` naming `exported_at` is rejected by Postgres, and
 * granting a 30th column would widen the projection past what the loader
 * expects.
 */
export const GRANTED_COLUMNS: readonly string[] = EXPORTED_COLUMNS.map(
  (column) => column.name,
).filter((name) => name !== "exported_at");

/**
 * The SELECT the export runs.
 *
 * Three properties, each of which is a requirement rather than a preference:
 *
 * - **The predicate is on `timestamp`**, so the planner can use
 *   `idx_logs_timestamp` (`CREATE INDEX ... ON logs(timestamp)` in
 *   `framework/logstore/migrations.go` at the pinned tag). Not verified with
 *   `EXPLAIN`, because nothing here can reach the database.
 * - **The column list is explicit and never `*`.** The read-only role holds
 *   `SELECT` on exactly these columns, so a widened query fails with a
 *   permission error at the source rather than reading a payload column.
 * - **`timestamp` and `alias` are quoted**, because both are reserved words in
 *   Postgres. This is the same pair the loader's DDL quotes.
 *
 * One statement, paged by a cursor. Postgres takes a statement-level snapshot in
 * `READ COMMITTED`, so a run cannot see a row flip from `processing` to `success`
 * halfway through its own read; issuing the query once per page would lose that.
 */
export const EXPORT_QUERY = `select ${EXPORTED_COLUMNS.filter(
  (column) => column.name !== "exported_at",
)
  .map((column) => (column.name === "timestamp" || column.name === "alias" ? `"${column.name}"` : column.name))
  .join(", ")}
from logs
where "timestamp" >= $1 and "timestamp" < $2`;
