// Session persistence. The resume design rests on this file.
//
// Pi writes its JSONL session to local disk, synchronously per entry. We sync
// that file to S3 as a whole-file PUT after every turn, through Pi's public
// `turn_end` extension point, and restore it to local disk at container start.
//
// Whole-file rather than append: Pi's session-manager rewrites the file
// wholesale when it migrates an old session version, so an append-only object
// would diverge from the file the next process opens. Worst case on a SIGKILL
// is losing the turn in progress.
//
// Compaction is not one of those paths, and the transcript depends on that.
// Pi appends a `compaction` entry carrying the summary and `firstKeptEntryId`
// and deletes nothing: every entry before it stays in the file, and so in
// S3. The compaction entry is the anchor for reading the conversation it
// replaced -- everything between the previous compaction's `firstKeptEntryId`
// (or the start) and this one's is what the summary stands for, verbatim.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { MONITOR_TOOL_NAME } from "./tools";

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

/**
 * Every session read and write has a deadline, because the SDK sets none and
 * the write runs on Pi's turn_end, which Pi awaits before the next model
 * call: a PUT that never answers freezes the agent exactly as a stalled model
 * stream does. A failed write is already survivable (see SessionSync); a hung
 * one was not. A minute is far beyond any healthy whole-file PUT and still
 * nothing against the cost of an agent that stops.
 */
export const SESSION_STORE_TIMEOUT_MS = 60_000;

export const createS3SessionStore = (
  bucket: string,
  region?: string,
  deps: { client?: any; timeoutMs?: number } = {},
): SessionStore => {
  const timeoutMs = deps.timeoutMs ?? SESSION_STORE_TIMEOUT_MS;
  let clientPromise: Promise<any> | null = deps.client ? Promise.resolve(deps.client) : null;
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
        // One deadline for the headers and the body: send() resolves on
        // headers, and a body that stalls after them is the same hang.
        const abortSignal = AbortSignal.timeout(timeoutMs);
        const expired = new Promise<never>((_, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        });
        expired.catch(() => {});
        const res = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { abortSignal },
        );
        const bytes = await Promise.race([res.Body?.transformToByteArray(), expired]);
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
        { abortSignal: AbortSignal.timeout(timeoutMs) },
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

export const emptySessionUsage = (): SessionUsage => ({
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  modelId: null,
  turns: 0,
  costUsd: 0,
});

/**
 * What the restored session already spent, read off local disk at launch.
 *
 * The turn budget is measured over the incident rather than over the
 * process, so a launch has to start from what earlier launches used. A file
 * that is not there is a first launch, which is zero and not an error --
 * `restoreSessionFile` has already said whether one was restored.
 */
export const readSessionUsageFromFile = async (
  sessionFile: string,
): Promise<SessionUsage> => {
  try {
    return sumSessionUsage(await readFile(sessionFile, "utf8"));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return emptySessionUsage();
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
  /**
   * The 1h share of `cacheWrite`. Carried separately because it does not
   * price like the rest of it: Pi bills a 1h write at 2x base input against
   * 1.25x for 5m, so a re-pricing that only has the total understates a run
   * that used the long cache -- which is every run here, since
   * `DEFAULT_CACHE_RETENTION` is `"long"`.
   */
  cacheWrite1h: number;
  modelId: string | null;
  turns: number;
  /**
   * What Pi priced this file at as it ran, summed over the same entries.
   *
   * Not a substitute for the tokens, and not what the incident row stores:
   * the record is tokens plus `modelId`, because those still multiply out
   * correctly after a price change. This is the arithmetic done at the time,
   * carried so a reader gets a figure without a price list -- and it is only
   * ever presented as an estimate. Zero when the provider reported no prices.
   */
  costUsd: number;
}

interface UsageFields {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
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
 * - `{ type: "custom", customType: GOAL_VERDICT_ENTRY_TYPE, data: { usage } }`
 *   -- a stage-goal evaluation, made on a different and cheaper model. Its
 *   tokens count here and its model does not: the row carries one `modelId`,
 *   and it has to stay the agent's.
 *
 * A message entry never carries top-level `usage`, so reading the nested one
 * first and falling back cannot double count.
 */
interface SessionUsageLine {
  type?: string;
  customType?: string;
  data?: { usage?: UsageFields };
  usage?: UsageFields;
  model?: string;
  modelId?: string;
  message?: { role?: string; model?: string; usage?: UsageFields };
}

/** One stage-goal verdict, with what the evaluation spent. */
export const GOAL_VERDICT_ENTRY_TYPE = "bugboss_goal_verdict";

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
    cacheWrite1h: 0,
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

    const usage =
      entry.message?.usage ??
      entry.usage ??
      (entry.type === "custom" && entry.customType === GOAL_VERDICT_ENTRY_TYPE
        ? entry.data?.usage
        : undefined);
    if (usage) {
      total.tokensIn += usage.input ?? 0;
      total.tokensOut += usage.output ?? 0;
      total.cacheRead += usage.cacheRead ?? 0;
      total.cacheWrite += usage.cacheWrite ?? 0;
      total.cacheWrite1h += usage.cacheWrite1h ?? 0;
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
  /** The wall-clock deadline fired. The agent had its grace to write a brief. */
  | "timed_out"
  /**
   * The incident's turn budget ran out. Counted across every launch, not per
   * container, so this is the bound a restart does not refill -- which is
   * what makes it the only one that tracks work done rather than time
   * passed.
   */
  | "turns_exhausted"
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
  const reasons: ExitReason[] = [
    "completed",
    "timed_out",
    "turns_exhausted",
    "turn_error",
    "signal",
  ];
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

/**
 * When the session last recorded anything, as epoch ms, or null when no line
 * carries a readable timestamp.
 *
 * Every entry Pi writes is stamped when it happens, and the file is synced
 * after every turn, so the newest stamp is the last moment the agent is
 * known to have been working. Read from the content rather than from S3
 * `LastModified`, which is when the object was last put and moves with a
 * re-upload of unchanged bytes.
 */
export const lastSessionEventAt = (contents: string): number | null => {
  let latest: number | null = null;
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { timestamp?: unknown };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue;
    }
    if (typeof entry.timestamp !== "string") continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
};

/**
 * What a live agent's local session says about whether it is working: the
 * newest stamp, and whether it is sitting in a `monitor` call that has not
 * returned. A monitor wait is the agent choosing to be quiet, so the
 * dispatcher's silence check has to tell it apart from a stall.
 *
 * Only the newest assistant message's tool calls count as open. A call a
 * killed run never answered stays unanswered in the file forever, and reading
 * it as a wait would hide every silence after the resume.
 */
export interface AgentActivity {
  lastEntryAt: number | null;
  inMonitor: boolean;
}

interface ActivityLine {
  timestamp?: string;
  type?: string;
  message?: {
    role?: string;
    toolCallId?: string;
    content?: string | { type?: string; id?: string; name?: string }[];
  };
}

export const sessionActivity = (contents: string): AgentActivity => {
  let lastEntryAt: number | null = null;
  let open = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: ActivityLine;
    try {
      entry = JSON.parse(trimmed) as ActivityLine;
    } catch {
      continue;
    }
    if (typeof entry.timestamp === "string") {
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at) && (lastEntryAt === null || at > lastEntryAt)) lastEntryAt = at;
    }
    if (entry.type !== "message") continue;
    if (entry.message?.role === "assistant") {
      open = new Map();
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "toolCall" && part.id && part.name) open.set(part.id, part.name);
        }
      }
    } else if (entry.message?.role === "toolResult" && entry.message.toolCallId) {
      open.delete(entry.message.toolCallId);
    }
  }
  return { lastEntryAt, inMonitor: [...open.values()].includes(MONITOR_TOOL_NAME) };
};

/**
 * The live agent's activity read from its local session directory, which the
 * Boss shares with the child. Pi names a new session file itself, so the
 * newest `.jsonl` there is the one being written. Re-parsed only when the
 * file changed, because the dispatcher asks every tick for every live agent.
 */
export const createActivityReader = () => {
  const seen = new Map<string, { file: string; mtimeMs: number; size: number; activity: AgentActivity }>();
  return async (sessionDir: string): Promise<AgentActivity | null> => {
    let names: string[];
    try {
      names = await readdir(sessionDir);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
    let newest: { file: string; mtimeMs: number; size: number } | null = null;
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(sessionDir, name);
      const info = await stat(file);
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: info.mtimeMs, size: info.size };
    }
    if (!newest) return null;
    const cached = seen.get(sessionDir);
    if (cached && cached.file === newest.file && cached.mtimeMs === newest.mtimeMs && cached.size === newest.size) {
      return cached.activity;
    }
    const activity = sessionActivity(await readFile(newest.file, "utf8"));
    seen.set(sessionDir, { ...newest, activity });
    return activity;
  };
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
