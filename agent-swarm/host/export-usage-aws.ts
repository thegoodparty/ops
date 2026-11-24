/**
 * The two things the export needs from the outside world that are not the
 * database: Docker's answer about where the volume is, and the conditional PUT.
 *
 * Kept out of the entry point so both are testable without `bun` and without a
 * bucket. A test puts a stub `docker` and a stub `aws` on `PATH` and reads what
 * the export would have done, which is how the failure path for an unwritable
 * prefix is exercised without asking AWS anything.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PutResult } from "./export-usage-core";

/**
 * The volume's mountpoint, from Docker.
 *
 * Resolved at run time rather than hardcoded under `/var/lib/docker`, because
 * Docker's root can move and only the compose project name (which makes the
 * volume `agent-swarm_swarm_api_data`) is stable. Docker's own message is what
 * surfaces on failure, so a missing volume reads as a missing volume.
 */
export const volumeMountpoint = (volume: string, run: typeof execFileSync = execFileSync): string =>
  String(
    run("docker", ["volume", "inspect", "-f", "{{.Mountpoint}}", volume], {
      encoding: "utf8",
    }),
  ).trim();

/**
 * One conditional PUT through the AWS CLI.
 *
 * `--if-none-match '*'` makes the store refuse an overwrite, which is the
 * guarantee the Bifrost export relies on too: the file cannot be replaced by a
 * rerun, not merely that this code tries not to. Versioning sits behind it.
 *
 * The body goes to a temp file rather than stdin because a month's file runs to
 * megabytes, and `--body file:///...` is the shape that does not make the CLI
 * buffer it twice. The temp file is removed either way, so a failed run cannot
 * leave a copy of the ledger in `/tmp`.
 *
 * A 412 comes back as `PreconditionFailed` on stderr with the status in the
 * CLI's message. That is "this second's file already exists": a rerun inside the
 * same second, or a rerun of a run that already succeeded. It is reported and
 * the run exits zero, because there is nothing to fix and nothing lost.
 */
export const putObjectWithCli = (
  args: { bucket: string; key: string; body: string; region: string },
  run: typeof execFileSync = execFileSync,
): PutResult => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-export-"));
  const file = join(dir, "body.ndjson");
  try {
    writeFileSync(file, args.body, { encoding: "utf8", mode: 0o600 });
    run(
      "aws",
      [
        "s3api",
        "put-object",
        "--region",
        args.region,
        "--bucket",
        args.bucket,
        "--key",
        args.key,
        "--body",
        file,
        "--if-none-match",
        "*",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true };
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    const stdout = String((error as { stdout?: string }).stdout ?? "");
    const message =
      `${stderr}${stdout}`.trim() || String((error as { message?: string }).message ?? error);
    if (/(^|\D)412(\D|$)|PreconditionFailed/.test(message)) {
      return { ok: false, alreadyExists: true };
    }
    return { ok: false, error: message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
