import { readFileSync } from "node:fs";

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ParquetWriter, ByteWriter } from "hyparquet-writer";
import { Client, types as pgTypes } from "pg";
import Cursor from "pg-cursor";

import {
  EXPORT_QUERY,
  USAGE_EXPORT_DAILY_WINDOW_DAYS,
  USAGE_EXPORT_PAGE_ROWS,
  USAGE_EXPORT_SECRET_JSON_KEY,
  USAGE_EXPORT_SECRET_NAME,
  USAGE_EXPORT_STATEMENT_TIMEOUT_MS,
} from "./usage-export-contract";
import { exportWindow, parquetSchema, toColumnData, usageExportObjectKey } from "./usage-export-core";

/**
 * The export Lambda's entrypoint: the thin, impure shell around
 * `usage-export-core.ts`.
 *
 * It resolves the database password, connects, pages one cursor over one
 * statement, writes each page into the Parquet writer, and PUTs the finished
 * file. The column list, the schema and every value conversion are in the core so
 * they can be tested without a database or a bucket.
 *
 * ## What this file must not get wrong
 *
 * - **It logs counts, never rows.** The file carries person identifiers:
 *   `user_name` and `virtual_key_name` are email addresses, and a row in
 *   CloudWatch would be per-person usage in a log group with a thirty-day
 *   retention that anyone with the account can read. The log line is the window,
 *   the row count, the byte count and the key, and
 *   `usage-export-handler.test.ts` asserts that whitelist rather than trusting
 *   the next edit.
 * - **A failed run throws.** A silent success leaves a gap in the bucket that
 *   nothing notices until the loader's freshness check — which, as it turns out,
 *   nothing runs. Throwing is what feeds both alarms.
 * - **`end()` always runs**, or a failed run leaves a connection open on the
 *   gateway's database instance until the execution environment is reaped.
 * - **`IfNoneMatch: "*"`.** S3 conditional write: with a timestamp in the key a
 *   collision means two runs in the same second, so this is a guard against a bug
 *   rather than an expected event, and it makes "never rewrites a file" a
 *   property of the store rather than only of this code.
 *
 * ## The two driver traps, both verified
 *
 * 1. **`timestamptz` loses microseconds by default.** node-postgres parses it
 *    with `Date`, which keeps milliseconds. Bifrost writes `time.Time` at
 *    microsecond precision, so the default would truncate every timestamp and
 *    make `exported_at` disagree with the object key by up to 999µs. The parser
 *    for OID 1184 below returns the raw string and the core converts it.
 * 2. **`numeric` arrives as a string.** OID 1700 has no default parser, which is
 *    the behaviour wanted: the core converts the string to an unscaled `bigint`
 *    without a float ever touching it.
 *
 * ## TLS, which is not optional here
 *
 * RDS for PostgreSQL 15 and later defaults `rds.force_ssl` to 1, so a non-TLS
 * connection is rejected outright with `no pg_hba.conf entry for host ... SSL
 * off`; node-postgres defaults `ssl` to `false`. And since Node.js 20 the Lambda
 * runtime no longer loads Amazon's CA certificates by default, though the image
 * still carries them at `/var/runtime/ca-cert.pem`. So the CA is read from there
 * and passed explicitly, which gives verified TLS rather than `rejectUnauthorized:
 * false`.
 *
 * Environment, all set by `deploy-workbench/usage-export.ts`:
 *
 *   EXPORT_BUCKET              the workbench bucket
 *   EXPORT_PREFIX              `bifrost/logs`
 *   EXPORT_SECRET_NAME         `bifrost/usage-export`
 *   PG_HOST / PG_PORT / PG_DATABASE / PG_USER
 */

/** Where the Lambda runtime keeps Amazon's CA bundle. */
const RDS_CA_PATH = "/var/runtime/ca-cert.pem";

/**
 * OID 1184 is `timestamptz`, which is what GORM creates for a `time.Time`
 * (`gorm.io/driver/postgres` `getSchemaBaseType` returns `timestamptz` for
 * `schema.Time`), so this is the parser the gateway's columns actually hit.
 * Returning the raw string is the whole point: the core converts it to
 * microseconds and a `Date` would already have lost them.
 */
pgTypes.setTypeParser(1184, (value: string) => value);
/**
 * OID 1114 is `timestamp without time zone`, registered as insurance.
 *
 * GORM does not create one for these columns, so on today's schema this never
 * fires. It costs one line and closes a failure that would be total: with no
 * parser, the driver's `Date` runs, `String(Date)` then gives
 * `"Fri Nov 13 2026 ..."`, and `timestamptzToMicros` throws on every row of every
 * run. A column type that changed under us should degrade to a readable parse
 * error naming the value rather than a stack of them.
 */
pgTypes.setTypeParser(1114, (value: string) => value);

export type ExportEvent = {
  /** Days of history to read. Defaults to the daily window. */
  window_days?: number;
};

export type ExportResult = {
  rows: number;
  bytes: number;
  key: string;
  windowStart: string;
  windowEnd: string;
};

type ExportEnvironment = {
  bucket: string;
  prefix: string;
  secretName: string;
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
};

/**
 * Read the non-secret configuration, failing loudly on anything absent.
 *
 * A missing environment variable is a deploy bug and reads as `undefined` deep
 * inside a connection attempt otherwise, which is the kind of failure that gets
 * diagnosed as a network problem.
 */
const readEnvironment = (env: NodeJS.ProcessEnv): ExportEnvironment => {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set; the Lambda's environment did not reach it`);
    return value;
  };
  const port = Number(required("PG_PORT"));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PG_PORT is not a port: ${env.PG_PORT}`);
  }
  return {
    bucket: required("EXPORT_BUCKET"),
    prefix: required("EXPORT_PREFIX"),
    secretName: required("EXPORT_SECRET_NAME"),
    pgHost: required("PG_HOST"),
    pgPort: port,
    pgDatabase: required("PG_DATABASE"),
    pgUser: required("PG_USER"),
  };
};

/**
 * The database password, from its own secret.
 *
 * Read per invocation rather than cached across invocations, because a rotated
 * password must take effect on the next run rather than on the next cold start,
 * and one `GetSecretValue` a day is not a cost worth optimising.
 */
const readPassword = async (secretName: string): Promise<string> => {
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  const raw = response.SecretString;
  if (!raw) throw new Error(`secret ${secretName} has no SecretString`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`secret ${secretName} is not JSON`);
  }
  const value = (parsed as Record<string, unknown>)[USAGE_EXPORT_SECRET_JSON_KEY];
  if (typeof value !== "string" || value === "") {
    throw new Error(`secret ${secretName} has no non-empty ${USAGE_EXPORT_SECRET_JSON_KEY}`);
  }
  return value;
};

/**
 * The connection config, exported so a test can assert the parts that are easy to
 * omit: `ssl` with a real CA, and `statement_timeout`.
 */
export const connectionConfig = (args: {
  environment: ExportEnvironment;
  password: string;
  ca: string;
}) => ({
  host: args.environment.pgHost,
  port: args.environment.pgPort,
  database: args.environment.pgDatabase,
  user: args.environment.pgUser,
  password: args.password,
  ssl: { ca: args.ca, rejectUnauthorized: true },
  // Bounds the damage a bad plan can do to an instance shared with the gateway:
  // 300s against a 900s function timeout. See the contract's comment for the
  // reasoning; the short version is that a correct read takes seconds.
  statement_timeout: USAGE_EXPORT_STATEMENT_TIMEOUT_MS,
});

/**
 * The row-count and byte-count summary this handler returns and logs.
 *
 * Split out so the log-whitelist test can assert the shape rather than search for
 * interpolated strings: if a field is not here it cannot be logged.
 */
export const summarise = (result: ExportResult): Record<string, string | number> => ({
  rows: result.rows,
  bytes: result.bytes,
  key: result.key,
  windowStart: result.windowStart,
  windowEnd: result.windowEnd,
});

export const handler = async (event: ExportEvent = {}): Promise<ExportResult> => {
  const windowDays = event.window_days ?? USAGE_EXPORT_DAILY_WINDOW_DAYS;
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new Error(`window_days must be a positive integer, got ${String(event.window_days)}`);
  }

  const environment = readEnvironment(process.env);
  const runStartedAt = new Date();
  // One instant for both the key and every row's `exported_at`, so a row's stamp
  // and its file name agree. A per-row clock would destroy the ordering the
  // loader's staging model depends on.
  const exportedAtMicros = BigInt(runStartedAt.getTime()) * 1000n;
  const { start, end } = exportWindow(runStartedAt, windowDays);

  const password = await readPassword(environment.secretName);
  const ca = readFileSync(RDS_CA_PATH, "utf8");
  const client = new Client(connectionConfig({ environment, password, ca }));

  // Built in memory and written once at the end: the largest file measured is
  // 6.8 MB, so a single PUT is simpler than a multipart upload and needs no
  // abort lifecycle rule.
  const writer = new ByteWriter();
  const parquet = new ParquetWriter({
    writer,
    schema: parquetSchema() as never,
    codec: "SNAPPY",
  });

  let rows = 0;
  try {
    await client.connect();
    const cursor = client.query(new Cursor(EXPORT_QUERY, [start, end]));
    try {
      while (true) {
        const page: Record<string, unknown>[] = await new Promise((resolve, reject) => {
          cursor.read(USAGE_EXPORT_PAGE_ROWS, (error: Error | undefined, pageRows: Record<string, unknown>[]) => {
            if (error) reject(error);
            else resolve(pageRows ?? []);
          });
        });
        if (page.length === 0) break;
        for (const row of page) row.exported_at = exportedAtMicros;
        const written = parquet.write({ columnData: toColumnData(page) as never });
        if (written) await written;
        rows += page.length;
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        cursor.close((error?: Error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  await parquet.finish();
  const buffer = writer.getBuffer();
  const key = usageExportObjectKey(runStartedAt, environment.prefix);

  const s3 = new S3Client({});
  await s3.send(
    new PutObjectCommand({
      Bucket: environment.bucket,
      Key: key,
      Body: Buffer.from(buffer),
      ContentType: "application/vnd.apache.parquet",
      // Refuse to overwrite. With a timestamp in the key this can only fire on a
      // bug, and firing is better than replacing a file the loader has already
      // recorded.
      IfNoneMatch: "*",
    }),
  );

  const result: ExportResult = {
    rows,
    bytes: buffer.byteLength,
    key,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
  // The whitelist, and nothing else. See the header.
  console.log("bifrost usage export", summarise(result));
  return result;
};
