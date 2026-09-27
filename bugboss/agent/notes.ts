// The agent's scratch directory, mirrored to S3 beside its session.
//
// Restart is the normal path for an incident agent, not the exception: every
// merge to ops main redeploys the container and kills whatever is in flight.
// The session replays, so what the agent said survives, but it pays for all of
// it on every turn. A ruled-out ledger it can re-read one file at a time is
// cheaper than a conclusion it has to carry in context for a day.
//
// Pi has no notion of a persisted working directory. It has a cwd and a
// session file, and nothing else it writes outlives the process, so the mirror
// is ours. It hangs off the same `turn_end` extension point the session sync
// uses, so notes and transcript are durable at exactly the same moments and
// there is one cadence to reason about rather than two.
//
// One object per note rather than one archive, because the point of putting
// this beside the transcript is that a human or the Slack agent can read a
// single file out of it with `aws s3 cp`.
//
// The mirror is append-only, and there is no delete in it at all. These notes
// are the agent's record of its own work, not scratch space it is expected to
// tidy, and the record is worth more to the next launch, to the thread and to
// whoever reads the incident later than the bytes are worth reclaiming. The
// bytes would not be reclaimed anyway: the bucket is versioned and nothing
// under `sessions/` expires, so deleting a note writes a delete marker over a
// version that stays forever. It would cost the same and hide the note from
// every reader.
//
// That moves the bound. What accumulates is what S3 holds, not what is on
// disk at any moment, so the limit is measured over the whole record.

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** No delete. The record an agent keeps is not the agent's to unmake. */
export interface NotesStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** Every key under the prefix, paginated to exhaustion. */
  list(prefix: string): Promise<string[]>;
}

export interface NotesLimits {
  /** Total across every note the record holds, live or superseded. */
  maxBytes: number;
  maxFiles: number;
}

/**
 * Measured over the whole record, not over the directory as it stands: with
 * no deletes, a rename leaves the old key behind and that is what grows.
 * Notes are prose, so sixteen megabytes is far more than a day of writing.
 * The file count is also what keeps the per-turn walk cheap.
 */
export const NOTES_LIMITS: NotesLimits = {
  maxBytes: 16 * 1024 * 1024,
  maxFiles: 256,
};

export const NOTES_DIR_NAME = "notes";

/**
 * Derived from the session key rather than from the incident id, so notes
 * land beside whatever key the Boss actually chose. Deriving a second key
 * independently is how the old session default came to write where nothing
 * read, and that failure is invisible until a restart restores nothing.
 */
export const notesPrefixFor = (sessionKey: string): string => {
  const cut = sessionKey.lastIndexOf("/");
  if (cut <= 0) {
    throw new Error(
      `session key ${sessionKey} has no prefix to hang notes off; expected sessions/incident/<id>/session.jsonl`,
    );
  }
  return `${sessionKey.slice(0, cut)}/${NOTES_DIR_NAME}/`;
};

const digest = (body: Buffer): string =>
  createHash("sha256").update(body).digest("hex");

/**
 * The reason a note is its own object is that a human opens it out of the
 * console or pipes it out of `aws s3 cp`. Inheriting the session's NDJSON
 * type would hand every one of them back as a download.
 */
export const noteContentType = (relativePath: string): string => {
  const extension = relativePath.slice(relativePath.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "md" || extension === "markdown") return "text/markdown; charset=utf-8";
  if (extension === "json") return "application/json; charset=utf-8";
  if (extension === "csv") return "text/csv; charset=utf-8";
  return "text/plain; charset=utf-8";
};

const toPosix = (relativePath: string): string =>
  sep === "/" ? relativePath : relativePath.split(sep).join("/");

export interface NoteFile {
  /** Relative to the notes directory, always with forward slashes. */
  path: string;
  bytes: number;
}

export interface NotesScan {
  /**
   * False when the directory itself is gone, which is a different thing from
   * an agent that emptied it: the first is local storage we lost, the second
   * is a decision to mirror. See `createNotesSync`.
   */
  present: boolean;
  files: NoteFile[];
  totalBytes: number;
  /** Anything that is not a regular file. Reported, never mirrored. */
  skipped: string[];
}

/**
 * Symlinks are skipped rather than followed: a link out of the directory
 * would put a file the agent never wrote into the incident's own prefix, and
 * a link into it would make the size bound meaningless.
 */
export const scanNotesDir = async (dir: string): Promise<NotesScan> => {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { present: false, files: [], totalBytes: 0, skipped: [] };
    }
    throw err;
  }

  const files: NoteFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  for (const entry of entries.sort()) {
    let stats: Stats;
    try {
      stats = await lstat(join(dir, entry));
    } catch (err) {
      // The agent's own shell can remove a file between the readdir above and
      // this call. It is simply not part of this flush, and the next one sees
      // the true state. What it must not become is a durability failure: that
      // burns the streak and tells the agent its notes are not saving.
      if ((err as { code?: string }).code === "ENOENT") continue;
      throw err;
    }
    if (stats.isDirectory()) continue;
    if (!stats.isFile()) {
      skipped.push(toPosix(entry));
      continue;
    }
    files.push({ path: toPosix(entry), bytes: stats.size });
    totalBytes += stats.size;
  }
  return { present: true, files, totalBytes, skipped };
};

export interface NotesLimitBreach {
  totalBytes: number;
  fileCount: number;
  limits: NotesLimits;
  /** The worst offenders first, so the message can name them. */
  largest: NoteFile[];
}

/**
 * Takes the projected record rather than the directory: a note the agent
 * removed locally is still in S3 and still counts against what we carry.
 */
export const notesLimitBreach = (
  retained: NoteFile[],
  limits: NotesLimits = NOTES_LIMITS,
): NotesLimitBreach | null => {
  const totalBytes = retained.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes <= limits.maxBytes && retained.length <= limits.maxFiles) {
    return null;
  }
  return {
    totalBytes,
    fileCount: retained.length,
    limits,
    largest: [...retained].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
  };
};

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const notesOverLimitMessage = (breach: NotesLimitBreach): string =>
  [
    `Your record is full, so nothing more you write to your notes directory will be saved.`,
    `It holds ${breach.fileCount} notes and ${mib(breach.totalBytes)}; the limit is ${breach.limits.maxFiles} notes and ${mib(breach.limits.maxBytes)}.`,
    breach.largest.length > 0
      ? `Largest: ${breach.largest.map((file) => `${file.path} (${mib(file.bytes)})`).join(", ")}.`
      : "",
    // Nothing is ever deleted, so there is no way back under. Telling it to
    // trim would be advice that cannot work, and it would spend a turn
    // finding that out.
    `Deleting files will not bring it back under, because the record keeps what you have already written. From here, anything that must survive belongs in the incident thread or in your hand-off brief. Notes this large usually mean command output went into a file; pipe it instead.`,
  ]
    .filter(Boolean)
    .join(" ");

export const notesSyncFailedMessage = (streak: number): string =>
  `Your notes directory has failed to save ${streak} times in a row, so treat anything in it as lost on the next restart. Your session itself is unaffected. Put anything you cannot afford to lose into the incident thread or your hand-off brief instead.`;

/** What the record already holds for one key. */
export interface NoteRecord {
  digest: string;
  bytes: number;
}

export interface RestoredNotes {
  /**
   * Per S3 key, so the first flush after a restart uploads nothing, and so
   * the bound can count notes the directory no longer has.
   */
  seen: Map<string, NoteRecord>;
  fileCount: number;
}

/**
 * Restores the directory before the session starts, so a resumed agent finds
 * its notes where it left them. Creates the directory either way: the prompt
 * names an absolute path, and a path that does not exist reads to the model
 * as a feature that is broken.
 */
export const restoreNotesDir = async (args: {
  store: NotesStore;
  prefix: string;
  dir: string;
}): Promise<RestoredNotes> => {
  await mkdir(args.dir, { recursive: true });
  const seen = new Map<string, NoteRecord>();
  for (const key of await args.store.list(args.prefix)) {
    const relativePath = key.slice(args.prefix.length);
    // Nothing we write produces one of these, so a key that escapes the
    // directory means the prefix was tampered with rather than mistyped.
    if (!relativePath || relativePath.split("/").includes("..")) continue;
    const body = await args.store.get(key);
    if (!body) continue;
    const file = join(args.dir, ...relativePath.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    seen.set(key, { digest: digest(body), bytes: body.byteLength });
  }
  return { seen, fileCount: seen.size };
};

export interface NotesSync {
  flush(): Promise<void>;
  lastError(): Error | null;
  /** Consecutive failed flushes. Zeroed by the first success. */
  failureStreak(): number;
  /** Non-null while the directory is over its bounds and nothing is mirrored. */
  overLimit(): NotesLimitBreach | null;
  /** Entries skipped on the last flush because they are not regular files. */
  skipped(): string[];
}

export const createNotesSync = (args: {
  store: NotesStore;
  prefix: string;
  dir: string;
  seen?: Map<string, NoteRecord>;
  limits?: NotesLimits;
}): NotesSync => {
  const limits = args.limits ?? NOTES_LIMITS;
  const seen = args.seen ?? new Map<string, NoteRecord>();
  let chain: Promise<void> = Promise.resolve();
  let failure: Error | null = null;
  let streak = 0;
  let breach: NotesLimitBreach | null = null;
  let skipped: string[] = [];

  const mirror = async (): Promise<void> => {
    const scan = await scanNotesDir(args.dir);
    skipped = scan.skipped;

    // What the record would hold after this flush: everything already in S3,
    // with the sizes of anything that is also on disk brought up to date. A
    // note the agent removed locally still counts, because it is still there.
    //
    // Recomputed on every flush including the one where the directory has
    // gone, because what the record holds does not depend on the directory
    // still being there. Carrying the previous answer forward would keep
    // naming files that no longer exist; discarding it would claim room that
    // the record does not have.
    const projected = new Map<string, number>();
    for (const [key, record] of seen) {
      projected.set(key.slice(args.prefix.length), record.bytes);
    }
    for (const file of scan.files) projected.set(file.path, file.bytes);
    breach = notesLimitBreach(
      [...projected].map(([path, bytes]) => ({ path, bytes })),
      limits,
    );

    // A directory that is gone is local storage we lost, and there is nothing
    // in it to mirror. The S3 copy is what a restart restores from and is
    // never touched here. The session sync skips on the same ENOENT.
    if (!scan.present) return;

    // Refuse the whole directory rather than mirroring part of it. A partial
    // mirror restores a directory the agent never had, and picking which
    // notes to drop is a decision this code has no basis for making.
    if (breach) return;

    for (const file of scan.files) {
      const key = `${args.prefix}${file.path}`;
      let body: Buffer;
      try {
        body = await readFile(join(args.dir, ...file.path.split("/")));
      } catch (err) {
        // Same race as the walk, one step later: scanned, then removed before
        // we read it. Not this flush's file, and not a failure.
        if ((err as { code?: string }).code === "ENOENT") continue;
        throw err;
      }
      const hash = digest(body);
      if (seen.get(key)?.digest === hash) continue;
      await args.store.put(key, body, noteContentType(file.path));
      seen.set(key, { digest: hash, bytes: body.byteLength });
    }
  };

  return {
    // Same contract as the session sync: a failure here must never end a turn,
    // and must never pass unnoticed either.
    flush: () => {
      chain = chain.then(mirror).then(
        () => {
          failure = null;
          streak = 0;
        },
        (err: unknown) => {
          failure = err instanceof Error ? err : new Error(String(err));
          streak += 1;
        },
      );
      return chain;
    },
    lastError: () => failure,
    failureStreak: () => streak,
    overLimit: () => breach,
    skipped: () => skipped,
  };
};

/** After this many consecutive failures the agent is told not to rely on it. */
export const NOTES_SYNC_FAILURE_LIMIT = 3;

/**
 * `onFlush` is required, and is handed the sync rather than an error, because
 * there are two things worth reporting here and they are not the same event:
 * a failed upload, and a directory that has grown past what we will carry.
 */
export const notesSyncExtension =
  (sync: NotesSync, onFlush: (sync: NotesSync) => void) =>
  (pi: ExtensionAPI): void => {
    const flush = async (): Promise<void> => {
      await sync.flush();
      onFlush(sync);
    };
    pi.on("turn_end", flush);
    pi.on("session_shutdown", flush);
  };
