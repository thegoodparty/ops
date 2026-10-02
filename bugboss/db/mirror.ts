// The harness's SQLite file, mirrored to S3 once per dispatcher tick.
//
// Not `Db`'s write-then-PUT. Pi Durable commits a partial response every
// 100 ms, so a PUT per commit is impossible, and a transcript that is a tick
// behind the incident tables costs the model one "already FIXING" tool result
// at worst: the incident tables are the system of record. So a failed PUT
// alarms and never halts anything. Halting `Db` writes over a transcript
// upload would couple the wrong things.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import { makeAlarm, makeLog } from "../logging";

const log = makeLog("harness_mirror");
const alarm = makeAlarm("harness_mirror");

export const HARNESS_MIRROR_TIMING = {
  /** Per PUT. The SDK sets none by default, so a stalled socket waits forever. */
  putTimeoutMs: 20_000,
  /** A failure streak older than this alarms a second time, once. */
  stillFailingMs: 5 * 60_000,
};

export interface HarnessMirrorConfig {
  path: string;
  bucket: string;
  key: string;
  s3: S3Client;
  timing?: Partial<typeof HARNESS_MIRROR_TIMING>;
  now?: () => number;
}

export interface HarnessMirror {
  /** Fetch the snapshot when the local file is absent. True when one was written. */
  restore(): Promise<boolean>;
  /** PUT a snapshot if anything committed since the last one landed. Never throws. */
  snapshotIfDirty(): Promise<void>;
  markDirty(): void;
  close(): void;
}

const removeQuietly = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};

export const createHarnessMirror = (cfg: HarnessMirrorConfig): HarnessMirror => {
  const timing = { ...HARNESS_MIRROR_TIMING, ...cfg.timing };
  const now = cfg.now ?? Date.now;
  let read: Database.Database | null = null;
  let dirty = false;
  let failingSince: number | null = null;
  let alarmedStillFailing = false;
  let chain: Promise<void> = Promise.resolve();

  const snapshotOnce = async (): Promise<void> => {
    if (!dirty) return;
    // Cleared before the copy, so a commit that lands while the PUT is in
    // flight marks the next tick dirty rather than being lost.
    dirty = false;
    const snapshot = `${cfg.path}.snapshot`;
    try {
      // Read-only on purpose: VACUUM INTO is legal from one, reads a
      // consistent WAL snapshot, and cannot take Pi Durable's write lock.
      read ??= new Database(cfg.path, { readonly: true, fileMustExist: true });
      removeQuietly(snapshot);
      read.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
      await cfg.s3.send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: cfg.key, Body: readFileSync(snapshot) }),
        { abortSignal: AbortSignal.timeout(timing.putTimeoutMs) },
      );
      if (failingSince !== null) {
        log("harness_snapshot_recovered", { failedForMs: now() - failingSince });
      }
      failingSince = null;
      alarmedStillFailing = false;
    } catch (err) {
      dirty = true;
      const at = now();
      if (failingSince === null) {
        failingSince = at;
        alarm("harness_snapshot_failed", {
          error: String(err),
          note: "transcripts are behind S3 until a snapshot lands; retried every tick, nothing halts",
        });
      } else if (!alarmedStillFailing && at - failingSince >= timing.stillFailingMs) {
        alarmedStillFailing = true;
        alarm("harness_snapshot_still_failing", {
          failingForMs: at - failingSince,
          error: String(err),
          note: "a restart now loses every transcript commit since the last snapshot that landed",
        });
      }
    } finally {
      removeQuietly(snapshot);
    }
  };

  return {
    restore: async () => {
      if (existsSync(cfg.path)) return false;
      let bytes: Uint8Array;
      try {
        const res = await cfg.s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.key }));
        bytes = await res.Body!.transformToByteArray();
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== "NoSuchKey" && name !== "NotFound") throw err;
        log("harness_cold_start");
        return false;
      }
      // Stale WAL beside a restored file would be replayed onto it.
      removeQuietly(`${cfg.path}-wal`);
      removeQuietly(`${cfg.path}-shm`);
      const partial = `${cfg.path}.restoring`;
      writeFileSync(partial, bytes);
      renameSync(partial, cfg.path);
      log("harness_restored_snapshot", { bytes: bytes.length });
      return true;
    },

    snapshotIfDirty: () => {
      chain = chain.then(snapshotOnce);
      return chain;
    },

    markDirty: () => {
      dirty = true;
    },

    close: () => {
      read?.close();
      read = null;
    },
  };
};
