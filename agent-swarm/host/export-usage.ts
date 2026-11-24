#!/usr/bin/env bun
/**
 * Exports the delegate swarm's cost ledger and task edges to S3, once a day.
 *
 * Runs as root from `agent-swarm-usage-export.timer`. Everything this decides is
 * in `export-usage-core.ts`, the read-only handle is in `export-usage-sqlite.ts`
 * and the two outside calls are in `export-usage-aws.ts`; this file is only the
 * wiring, so the parts that can be wrong are the parts a test can reach.
 *
 * What it does, in order: find the database through `docker volume inspect`,
 * open one read-only connection, run both statements inside one read
 * transaction, close it, serialize each table to JSON Lines, and PUT each file
 * with `--if-none-match '*'`.
 *
 * No credential of its own. The host's instance profile already carries
 * `s3:PutObject` on these two prefixes, and this run is that identity (see
 * `swarmUsageExportPutStatement` in `deploy-infrastructure/agent-swarm.ts`,
 * which also states what that grant means).
 *
 * A failed run is loud in `systemctl` and silent everywhere else; the page's
 * "data through" line is the only automatic signal in v1.
 */

import { Database } from "bun:sqlite";

import { putObjectWithCli, volumeMountpoint } from "./export-usage-aws";
import { DATABASE_VOLUME, REGION, runExport, type ExportOutcome } from "./export-usage-core";
import {
  databasePathFrom,
  readSnapshotWith,
  type SqliteHandle,
} from "./export-usage-sqlite";

const log = (line: string): void => {
  // stdout, so `journalctl -u agent-swarm-usage-export` has it in order with
  // systemd's own lines.
  console.log(line);
};

/** `bun:sqlite`'s `Database`, narrowed to the handle a snapshot needs. */
const openBunSqlite = (path: string) =>
  new Database(path, { readonly: true }) as unknown as SqliteHandle;

/**
 * The real run, with the one clock read it needs.
 *
 * The clock is read once so the object key, the window and every row's
 * `exported_at` are the same instant; a second read after the SQL would let the
 * window and the file name disagree.
 */
export const exportOnce = (startedAt: Date = new Date()): ExportOutcome => {
  const mountpoint = volumeMountpoint(DATABASE_VOLUME);
  const databasePath = databasePathFrom(mountpoint);
  log(`export-usage: database ${databasePath}`);

  const outcome = runExport({
    readSnapshot: readSnapshotWith(openBunSqlite)(databasePath),
    putObject: (args) => putObjectWithCli({ ...args, region: REGION }),
    now: () => startedAt,
    log,
  });

  // One line naming every table's fate, so `journalctl` answers "did both files
  // land" without reading the lines in between. The per-file lines come from the
  // core.
  log(
    `export-usage: ${outcome.exitCode === 0 ? "ok" : "failed"} ${outcome.reports
      .map((report) => `${report.table}=${report.outcome}`)
      .join(" ")}`,
  );
  return outcome;
};

try {
  process.exit(exportOnce().exitCode);
} catch (error) {
  // Anything the volume lookup or the driver throws lands here: a missing
  // volume, a database that is not there, a permission denied on `-shm`. The
  // unit is oneshot, so a non-zero exit is what marks it failed.
  log(`export-usage: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
