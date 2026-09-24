// The database layer. Design spec: docs/bugboss/design.md, Layer 1.
//
// Two properties come from one place, the withWrite helper: writes are
// serialized so two concurrent handlers cannot clobber each other even though
// they share a process, and a write does not return until S3 has it. When an
// agent's reportRootCause returns, the transition is durable.

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const log = (event: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ component: "db", event, ...data }));

export interface DbConfig {
  path: string;
  bucket: string;
  /** Key for the snapshot. Restored on boot, overwritten on every write. */
  key: string;
  s3?: S3Client;
}

export class Db {
  private readonly write: Database.Database;
  /** Separate connection, opened read-only. Agents query through this one. */
  private readonly read: Database.Database;
  private readonly s3: S3Client;
  private readonly cfg: DbConfig;
  /** Serializes writes. One process, so a promise chain is the whole lock. */
  private queue: Promise<unknown> = Promise.resolve();
  private halted: string | null = null;

  private constructor(cfg: DbConfig, s3: S3Client) {
    this.cfg = cfg;
    this.s3 = s3;
    this.write = new Database(cfg.path);
    this.write.pragma("journal_mode = WAL");
    this.write.pragma("foreign_keys = ON");
    this.read = new Database(cfg.path, { readonly: true });
  }

  /**
   * Fetch the snapshot from S3 if present, then open. A missing object is a
   * cold start, not an error.
   */
  static async open(cfg: DbConfig): Promise<Db> {
    const s3 = cfg.s3 ?? new S3Client({});
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.key }),
      );
      const bytes = await res.Body!.transformToByteArray();
      const { writeFileSync } = await import("node:fs");
      writeFileSync(cfg.path, bytes);
      log("restored_snapshot", { bytes: bytes.length });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== "NoSuchKey" && name !== "NotFound") throw err;
      log("cold_start");
    }

    const db = new Db(cfg, s3);
    db.write.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));
    return db;
  }

  /**
   * The only way to write. Runs fn in a transaction, snapshots, and does not
   * resolve until S3 has the snapshot.
   *
   * A failed PUT halts writes rather than continuing. A process that keeps
   * committing locally while S3 falls behind is worse than one that stops,
   * because the divergence stays invisible until a restart loses it.
   */
  async withWrite<T>(fn: (db: Database.Database) => T): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.halted) throw new Error(`writes halted: ${this.halted}`);

      const result = this.write.transaction(fn)(this.write);

      const snapshot = `${this.cfg.path}.snapshot`;
      try {
        unlinkSync(snapshot);
      } catch {
        // First write, or already cleaned up.
      }
      this.write.exec(`VACUUM INTO '${snapshot}'`);

      try {
        await this.s3.send(
          new PutObjectCommand({
            Bucket: this.cfg.bucket,
            Key: this.cfg.key,
            Body: readFileSync(snapshot),
          }),
        );
      } catch (err) {
        this.halted = String(err);
        log("snapshot_failed_halting_writes", { error: String(err) });
        throw err;
      } finally {
        try {
          unlinkSync(snapshot);
        } catch {
          // Nothing to clean up.
        }
      }

      return result;
    });

    // Keep the chain alive even when a write throws, or one failure would
    // wedge every subsequent write behind a rejected promise.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Read-only. This is what triage and the Slack agent query through. */
  query<T = unknown>(sql: string, params: unknown[] = []): T[] {
    return this.read.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
    return this.read.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  close(): void {
    this.read.close();
    this.write.close();
  }
}
