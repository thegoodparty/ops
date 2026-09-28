// Session persistence. The resume design rests on this file.
//
// Pi writes its JSONL session to local disk, synchronously per entry. We sync
// that file to S3 as a whole-file PUT after every turn, through Pi's public
// `turn_end` extension point, and restore it to local disk at container start.
//
// Whole-file rather than append: Pi's session-manager rewrites the file
// wholesale in several paths (branching, migration, compaction), so an
// append-only object would diverge from the file the next process opens.
// Worst case on a SIGKILL is losing the turn in progress.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { NotesStore } from "./notes";

export interface SessionStore {
  get(key: string): Promise<Buffer | null>;
  /** `contentType` is for ./notes.ts; the session itself is always NDJSON. */
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
}

export interface SessionSync {
  flush(): Promise<void>;
  lastError(): Error | null;
  /** Consecutive failed flushes. Zeroed by the first success. */
  failureStreak(): number;
}

/**
 * The one layout. The Slack agent's read_agent_session and the S3 lifecycle
 * rule both read this prefix, so a session written anywhere else persists but
 * is invisible to every reader and restores nothing on the next launch.
 */
export const sessionKeyFor = (incidentId: string): string =>
  `sessions/incident/${incidentId}/session.jsonl`;

export const sessionFileFor = (sessionDir: string, incidentId: string): string =>
  join(sessionDir, `${incidentId}.jsonl`);

export const createS3SessionStore = (
  bucket: string,
  region?: string,
): SessionStore & NotesStore => {
  let clientPromise: Promise<any> | null = null;
  const client = (): Promise<any> => {
    if (!clientPromise) {
      clientPromise = import("@aws-sdk/client-s3").then(
        ({ S3Client }) => new S3Client(region ? { region } : {}),
      );
    }
    return clientPromise;
  };

  return {
    get: async (key) => {
      const [{ GetObjectCommand }, s3] = await Promise.all([
        import("@aws-sdk/client-s3"),
        client(),
      ]);
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        const bytes = await res.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "NoSuchKey" || name === "NotFound") return null;
        throw err;
      }
    },
    put: async (key, body, contentType) => {
      const [{ PutObjectCommand }, s3] = await Promise.all([
        import("@aws-sdk/client-s3"),
        client(),
      ]);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          // The session is the only caller that does not name one, and it is
          // the only NDJSON in the bucket.
          ContentType: contentType ?? "application/x-ndjson",
        }),
      );
    },
    // list exists for the notes mirror in ./notes.ts, which is a directory
    // rather than one object and has to know what S3 already holds. There is
    // deliberately no delete: nothing in the agent's path removes an object
    // from this bucket.
    list: async (prefix) => {
      const [{ ListObjectsV2Command }, s3] = await Promise.all([
        import("@aws-sdk/client-s3"),
        client(),
      ]);
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const object of res.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
};

export const restoreSessionFile = async (args: {
  store: SessionStore;
  key: string;
  sessionFile: string;
}): Promise<boolean> => {
  const body = await args.store.get(args.key);
  await mkdir(dirname(args.sessionFile), { recursive: true });
  if (!body) return false;
  await writeFile(args.sessionFile, body);
  return true;
};

export const createSessionSync = (args: {
  store: SessionStore;
  key: string;
  sessionFile: () => string | undefined;
}): SessionSync => {
  let chain: Promise<void> = Promise.resolve();
  let failure: Error | null = null;
  let streak = 0;

  const put = async (): Promise<void> => {
    const file = args.sessionFile();
    if (!file) return;
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    await args.store.put(args.key, body);
  };

  return {
    // A sync failure must never end a turn: losing a turn of durability is
    // survivable, killing a live incident agent is not. It must never pass
    // unnoticed either, which is what the streak is for.
    flush: () => {
      chain = chain.then(put).then(
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
  };
};

/**
 * After this many consecutive failures the session is not durable and a
 * restart would lose the whole investigation, so the agent is told to hand
 * off while it still has one to describe.
 */
export const SESSION_SYNC_FAILURE_LIMIT = 3;

/**
 * `onFailure` is required rather than optional. Both call sites used to drop
 * the result of `flush()`, which made a silently no-op durability write the
 * default: every turn appeared to sync, the next restart restored nothing,
 * and the dispatcher relaunched an agent that started over from zero.
 */
export const sessionSyncExtension =
  (sync: SessionSync, onFailure: (error: Error, streak: number) => void) =>
  (pi: ExtensionAPI): void => {
    const flush = async (): Promise<void> => {
      await sync.flush();
      const error = sync.lastError();
      if (error) onFailure(error, sync.failureStreak());
    };
    pi.on("turn_end", flush);
    pi.on("session_shutdown", flush);
  };

// The prefix the model signs over must be reproduced byte for byte on resume,
// so the prompt and tool list are stored in the session itself rather than
// recomposed. Pi persists custom entries synchronously and excludes them from
// model context, so they travel with the whole-file sync for free.
export const PROMPT_ENTRY_TYPE = "bugboss_prompt";

export interface StoredPrefix {
  systemPrompt: string;
  toolNames: string[];
  modelId: string;
}

export const isStoredPrefix = (value: unknown): value is StoredPrefix => {
  const candidate = value as StoredPrefix | undefined;
  return (
    !!candidate &&
    typeof candidate.systemPrompt === "string" &&
    Array.isArray(candidate.toolNames) &&
    candidate.toolNames.every((name) => typeof name === "string") &&
    typeof candidate.modelId === "string"
  );
};

export const readStoredPrefixFromEntries = (
  entries: SessionEntry[],
): StoredPrefix | null => {
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const custom = entry as SessionEntry & {
      customType?: string;
      data?: unknown;
    };
    if (custom.customType !== PROMPT_ENTRY_TYPE) continue;
    if (isStoredPrefix(custom.data)) return custom.data;
  }
  return null;
};

export const readStoredPrefixFromJsonl = (contents: string): StoredPrefix | null => {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = parsed as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== PROMPT_ENTRY_TYPE) continue;
    if (isStoredPrefix(entry.data)) return entry.data;
  }
  return null;
};

export const readStoredPrefixFromFile = async (
  sessionFile: string,
): Promise<StoredPrefix | null> => {
  try {
    return readStoredPrefixFromJsonl(await readFile(sessionFile, "utf8"));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
};

/**
 * Token usage summed over one incident's whole session file.
 *
 * `turns` is not decoration. Tokens are never legitimately zero for a turn
 * that reached the model, so a non-zero turn count next to a zero total is
 * the signature of a reader that has drifted from Pi's entry shape -- which
 * is exactly how this went unnoticed once already.
 */
export interface SessionUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  modelId: string | null;
  turns: number;
  /**
   * What Pi priced this file at as it ran, summed over the same entries.
   *
   * Not a substitute for the tokens, and not what the incident row stores:
   * the record is tokens plus `modelId`, because those still multiply out
   * correctly after a price change. This is the arithmetic done at the time,
   * carried so a reader gets a figure without a price list -- and it is only
   * ever presented as derived. Zero when the provider reported no prices.
   */
  costUsd: number;
}

interface UsageFields {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/**
 * Pi writes usage in two shapes, and both are spend:
 *
 * - `{ type: "message", message: { role: "assistant", usage } }` -- one per
 *   model turn, and the overwhelming bulk of a run.
 * - `{ type: "usage" | "compaction", usage }` -- out-of-band calls that are
 *   billed but are not turns, such as the summarization compaction runs.
 *
 * A message entry never carries top-level `usage`, so reading the nested one
 * first and falling back cannot double count.
 */
interface SessionUsageLine {
  type?: string;
  usage?: UsageFields;
  model?: string;
  modelId?: string;
  message?: { role?: string; model?: string; usage?: UsageFields };
}

/**
 * Sum a session file's usage. Totals are absolute over the whole file, which
 * is what makes resume correct: a relaunched agent reopens the same restored
 * file and appends to it, so re-reading it counts every launch once. Adding
 * onto the stored row instead would double count every earlier launch.
 */
export const sumSessionUsage = (contents: string): SessionUsage => {
  const total: SessionUsage = {
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    modelId: null,
    turns: 0,
    costUsd: 0,
  };

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: SessionUsageLine;
    try {
      entry = JSON.parse(trimmed) as SessionUsageLine;
    } catch {
      // A session file is appended a line at a time, so a torn last line is
      // normal after a kill. Everything before it is still good.
      continue;
    }

    if (entry.type === "message" && entry.message?.role === "assistant") {
      total.turns += 1;
    }

    const usage = entry.message?.usage ?? entry.usage;
    if (usage) {
      total.tokensIn += usage.input ?? 0;
      total.tokensOut += usage.output ?? 0;
      total.cacheRead += usage.cacheRead ?? 0;
      total.cacheWrite += usage.cacheWrite ?? 0;
      total.costUsd += usage.cost?.total ?? 0;
    }

    total.modelId = entry.modelId ?? entry.message?.model ?? entry.model ?? total.modelId;
  }

  return total;
};

// ---------------------------------------------------------------------------
// The exit record
// ---------------------------------------------------------------------------

/**
 * How a run ended, written into the session as its last entry.
 *
 * Without this a killed run and a finished one are byte-for-byte the same
 * *shape*: the writer appends per event and the file closes with the last
 * one, so there is no exit record, no error entry and no signal marker, and
 * S3 `LastModified` sits within a second of the last event either way. Three
 * of seven real runs died mid-turn and read exactly like the four that did
 * not. A 9.5-hour, $42.71 run was among them, and nobody knew to finish it.
 *
 * The record is a custom entry rather than a sidecar object because it has to
 * travel with the whole-file sync that already exists, and because Pi persists
 * custom entries synchronously -- so it is on disk before the flush that
 * carries it, including from inside a signal handler.
 */
export const EXIT_ENTRY_TYPE = "bugboss_exit";

export type ExitReason =
  /** `session.prompt` returned and the last turn was clean. */
  | "completed"
  /** The wall-clock deadline fired. The agent had its grace to hand off. */
  | "timed_out"
  /** Pi reported an error on the last turn. */
  | "turn_error"
  /** SIGTERM or SIGINT reached the child before it was done. */
  | "signal";

export interface StoredExit {
  reason: ExitReason;
  /** Epoch ms, so a reader can tell the exit from the last event before it. */
  at: number;
  /** Which launch this was, matching the incident row's `attempts`. */
  attempt: number | null;
  /** Set when `reason` is `signal`. */
  signal?: string;
  /** Pi's message for the failing turn. Set when `reason` is `turn_error`. */
  error?: string;
}

export const isStoredExit = (value: unknown): value is StoredExit => {
  const candidate = value as StoredExit | undefined;
  if (!candidate || typeof candidate !== "object") return false;
  const reasons: ExitReason[] = ["completed", "timed_out", "turn_error", "signal"];
  return (
    reasons.includes(candidate.reason) &&
    typeof candidate.at === "number" &&
    (candidate.attempt === null || typeof candidate.attempt === "number")
  );
};

/**
 * What a session file says about how its last launch ended.
 *
 * `killed` is the answer that matters and it is reached two ways: no exit
 * record at all, or an exit record with session events appended after it. The
 * second is the resume case -- every launch writes its own record, so a file
 * restored and continued carries an older one, and reading the last record
 * without checking what follows would report a killed run as finished.
 *
 * `empty` is kept separate from `killed` because a child spawned and killed
 * before its first turn synced has lost nothing, and calling that a killed
 * run would put an alarm on every crash at boot.
 */
export type SessionOutcome =
  | { kind: "ended"; exit: StoredExit }
  | { kind: "killed"; turns: number }
  | { kind: "empty" };

/**
 * Entry types Pi writes as part of running. A line of one of these after the
 * last exit record is proof the run carried on past it.
 */
const isSessionEvent = (type: string | undefined): boolean =>
  type !== undefined && type !== "custom";

export const readSessionOutcome = (contents: string): SessionOutcome => {
  let exit: StoredExit | null = null;
  let eventsAfterExit = 0;
  let turns = 0;

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string; customType?: string; data?: unknown; message?: { role?: string } };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      // A torn last line is the normal signature of a kill mid-write. It is
      // an event like any other for this purpose: something happened after
      // whatever exit record came before it.
      eventsAfterExit += 1;
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") turns += 1;
    if (entry.type === "custom" && entry.customType === EXIT_ENTRY_TYPE) {
      if (isStoredExit(entry.data)) {
        exit = entry.data;
        eventsAfterExit = 0;
      }
      continue;
    }
    if (isSessionEvent(entry.type)) eventsAfterExit += 1;
  }

  if (exit && eventsAfterExit === 0) return { kind: "ended", exit };
  if (turns === 0 && eventsAfterExit === 0) return { kind: "empty" };
  return { kind: "killed", turns };
};

/** One line for a log or a thread, so the wording is not written twice. */
export const describeOutcome = (outcome: SessionOutcome): string => {
  switch (outcome.kind) {
    case "empty":
      return "the session holds nothing; the run died before its first turn synced";
    case "ended":
      return `the run ended on purpose (${outcome.exit.reason}${outcome.exit.signal ? ` ${outcome.exit.signal}` : ""})`;
    case "killed":
      return `the run was killed after ${outcome.turns} turns, without writing an exit record`;
  }
};
