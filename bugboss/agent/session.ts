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

export interface SessionStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer): Promise<void>;
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
): SessionStore => {
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
    put: async (key, body) => {
      const [{ PutObjectCommand }, s3] = await Promise.all([
        import("@aws-sdk/client-s3"),
        client(),
      ]);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/x-ndjson",
        }),
      );
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
