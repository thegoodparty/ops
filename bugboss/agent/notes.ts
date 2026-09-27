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
// single file out of it with `aws s3 cp`. The cost is that a deletion has to
// be mirrored too, which is what the digest map is for.

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface NotesStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** Every key under the prefix, paginated to exhaustion. */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export interface NotesLimits {
  maxBytes: number;
  maxFiles: number;
}

/**
 * Notes are prose. Four megabytes of it is more than an agent can write in a
 * day, and the file count is what keeps a per-turn walk cheap.
 */
export const NOTES_LIMITS: NotesLimits = {
  maxBytes: 4 * 1024 * 1024,
  maxFiles: 64,
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
    const stats = await lstat(join(dir, entry));
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

export const notesLimitBreach = (
  scan: NotesScan,
  limits: NotesLimits = NOTES_LIMITS,
): NotesLimitBreach | null => {
  if (scan.totalBytes <= limits.maxBytes && scan.files.length <= limits.maxFiles) {
    return null;
  }
  return {
    totalBytes: scan.totalBytes,
    fileCount: scan.files.length,
    limits,
    largest: [...scan.files].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
  };
};

const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const notesOverLimitMessage = (breach: NotesLimitBreach): string =>
  [
    `Your notes directory is over its limit, so nothing in it is being saved any more.`,
    `It holds ${breach.fileCount} files and ${mib(breach.totalBytes)}; the limit is ${breach.limits.maxFiles} files and ${mib(breach.limits.maxBytes)}.`,
    `The copy in S3 has stopped moving, so a restart would take you back to whatever it held when you crossed the limit.`,
    breach.largest.length > 0
      ? `Largest: ${breach.largest.map((file) => `${file.path} (${mib(file.bytes)})`).join(", ")}.`
      : "",
    `Delete what you no longer need and the next turn will save again. Do not put command output or downloaded data there; it is for notes.`,
  ]
    .filter(Boolean)
    .join(" ");

export const notesSyncFailedMessage = (streak: number): string =>
  `Your notes directory has failed to save ${streak} times in a row, so treat anything in it as lost on the next restart. Your session itself is unaffected. Put anything you cannot afford to lose into the incident thread or your hand-off brief instead.`;

export interface RestoredNotes {
  /** Digest per S3 key, so the first flush only uploads what changed. */
  seen: Map<string, string>;
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
  const seen = new Map<string, string>();
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
    seen.set(key, digest(body));
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
  seen?: Map<string, string>;
  limits?: NotesLimits;
}): NotesSync => {
  const limits = args.limits ?? NOTES_LIMITS;
  const seen = args.seen ?? new Map<string, string>();
  let chain: Promise<void> = Promise.resolve();
  let failure: Error | null = null;
  let streak = 0;
  let breach: NotesLimitBreach | null = null;
  let skipped: string[] = [];

  const mirror = async (): Promise<void> => {
    const scan = await scanNotesDir(args.dir);
    skipped = scan.skipped;

    // A directory that is gone is local storage we lost, not an instruction
    // to delete the copy in S3. The session sync skips on the same ENOENT for
    // the same reason: the mirror is the safer of the two, so it wins. A
    // breach recorded before it vanished is cleared with it, or the agent
    // keeps being told to trim files that no longer exist.
    if (!scan.present) {
      breach = null;
      return;
    }

    // Refuse the whole directory rather than mirroring part of it. A partial
    // mirror restores a directory the agent never had, and picking which
    // notes to drop is a decision this code has no basis for making.
    breach = notesLimitBreach(scan, limits);
    if (breach) return;

    const live = new Set<string>();
    for (const file of scan.files) {
      const key = `${args.prefix}${file.path}`;
      live.add(key);
      const body = await readFile(join(args.dir, ...file.path.split("/")));
      const hash = digest(body);
      if (seen.get(key) === hash) continue;
      await args.store.put(key, body, noteContentType(file.path));
      seen.set(key, hash);
    }

    for (const key of [...seen.keys()]) {
      if (live.has(key)) continue;
      await args.store.delete(key);
      seen.delete(key);
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
