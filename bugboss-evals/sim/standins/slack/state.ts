// Everything the Slack stand-in has seen, in memory. The orchestrator reads it
// whole through `/__control/state`, and the gates read that export, so what is
// kept here is what a gate can check: every message and edit, every upload,
// every Web API call with the answer it got, and every event delivery.

export interface SlackUser {
  id: string;
  name: string;
  realName: string;
  isBot: boolean;
}

export interface Reaction {
  name: string;
  users: string[];
}

export interface StoredMessage {
  channel: string;
  ts: string;
  /** The parent's ts for a reply, null for a top-level message. */
  threadTs: string | null;
  user: string;
  botId: string | null;
  text: string;
  /** Every earlier text of an edited message, oldest first. */
  edits: { ts: string; previousText: string }[];
  reactions: Reaction[];
  files: string[];
}

export interface StoredFile {
  id: string;
  filename: string;
  /** The byte length promised to files.getUploadURLExternal. */
  length: number;
  title: string | null;
  content: string | null;
  uploadedBytes: number | null;
  channel: string | null;
  threadTs: string | null;
  messageTs: string | null;
  completed: boolean;
}

export interface ApiCall {
  at: number;
  method: string;
  args: Record<string, unknown>;
  ok: boolean;
  error: string | null;
}

export interface EventDelivery {
  at: number;
  eventId: string;
  eventType: string;
  attempt: number;
  status: number | null;
  error: string | null;
}

export interface SlackStoreConfig {
  channels: string[];
  users: SlackUser[];
  usergroups: Record<string, string[]>;
  botUserId: string;
  botId: string;
  teamId: string;
  workspaceDomain: string;
  now?: () => number;
}

export class SlackApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Slack's real ceiling on `text`. Past it, real Slack truncates and answers
 * 200 (bugboss/slack/CLAUDE.md, "Two length rules"), which is the one failure
 * a reader cannot recover from. The stand-in refuses with `msg_too_long`
 * instead, so a gate can see that a post would have been cut rather than
 * inferring it from a short message.
 */
export const MAX_TEXT_CHARS = 40_000;

export const createSlackStore = (config: SlackStoreConfig) => {
  const now = config.now ?? Date.now;
  let messages: StoredMessage[] = [];
  let files: StoredFile[] = [];
  let calls: ApiCall[] = [];
  let deliveries: EventDelivery[] = [];
  let lastTs = 0;
  let fileSeq = 0;
  let lastActivityAt: number | null = null;
  const touch = () => {
    lastActivityAt = now();
  };

  // Slack timestamps are seconds with a six-digit suffix, unique per channel.
  // Monotonic across the whole store so ordering by ts is ordering by time.
  const nextTs = (): string => {
    const micros = Math.max(now() * 1000, lastTs + 1);
    lastTs = micros;
    const seconds = Math.floor(micros / 1e6);
    const rest = String(micros % 1e6).padStart(6, "0");
    return `${seconds}.${rest}`;
  };

  const requireChannel = (channel: unknown): string => {
    if (typeof channel !== "string" || channel === "") {
      throw new SlackApiError("channel_not_found");
    }
    if (!config.channels.includes(channel)) {
      throw new SlackApiError("channel_not_found");
    }
    return channel;
  };

  const find = (channel: string, ts: string): StoredMessage | undefined =>
    messages.find((m) => m.channel === channel && m.ts === ts);

  const checkLength = (text: string) => {
    if (text.length > MAX_TEXT_CHARS) throw new SlackApiError("msg_too_long");
  };

  const post = (args: {
    channel: unknown;
    threadTs?: string | null;
    user: string;
    botId: string | null;
    text: string;
    files?: string[];
  }): StoredMessage => {
    const channel = requireChannel(args.channel);
    if (args.text === "" && !args.files?.length) {
      throw new SlackApiError("no_text");
    }
    checkLength(args.text);
    let threadTs: string | null = null;
    if (args.threadTs) {
      const parent = find(channel, args.threadTs);
      if (!parent) throw new SlackApiError("thread_not_found");
      // A reply to a reply lands in the parent's thread, as in Slack.
      threadTs = parent.threadTs ?? parent.ts;
    }
    const message: StoredMessage = {
      channel,
      ts: nextTs(),
      threadTs,
      user: args.user,
      botId: args.botId,
      text: args.text,
      edits: [],
      reactions: [],
      files: args.files ?? [],
    };
    messages.push(message);
    touch();
    return message;
  };

  const threadOf = (channel: string, parentTs: string): StoredMessage[] =>
    messages
      .filter((m) => m.channel === channel && m.threadTs === parentTs)
      .sort((a, b) => Number(a.ts) - Number(b.ts));

  const permalink = (channel: string, ts: string): string => {
    const message = find(channel, ts);
    if (!message) throw new SlackApiError("message_not_found");
    const base = `https://${config.workspaceDomain}/archives/${channel}/p${ts.replace(".", "")}`;
    // What real Slack returns for a message inside a thread, query string and
    // all. BugBoss's linker has broken on exactly this before.
    return message.threadTs
      ? `${base}?thread_ts=${message.threadTs}&cid=${channel}`
      : base;
  };

  return {
    config,
    now,
    nextTs,
    requireChannel,
    find,
    checkLength,
    post,
    threadOf,
    permalink,
    user: (id: string) => config.users.find((u) => u.id === id),
    newFileId: () => `F${String(++fileSeq).padStart(9, "0")}`,
    messages: () => messages,
    files: () => files,
    touch,
    recordCall: (call: ApiCall) => {
      calls.push(call);
      touch();
    },
    recordDelivery: (delivery: EventDelivery) => deliveries.push(delivery),
    reset: () => {
      messages = [];
      files = [];
      calls = [];
      deliveries = [];
      fileSeq = 0;
      lastActivityAt = null;
    },
    /**
     * The whole world as the gates read it. Threads are grouped under their
     * parent so a reader gets an incident's story in order without joining.
     */
    snapshot: () => {
      const topLevel = messages
        .filter((m) => m.threadTs === null)
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      return {
        botUserId: config.botUserId,
        botId: config.botId,
        /** Every top-level message with its replies, parent first. */
        threads: topLevel.map((m) => ({
          channel: m.channel,
          ts: m.ts,
          messages: [m, ...threadOf(m.channel, m.ts)],
        })),
        channels: config.channels.map((id) => ({
          id,
          messages: topLevel
            .filter((m) => m.channel === id)
            .map((m) => ({ ...m, replies: threadOf(id, m.ts) })),
        })),
        files,
        calls,
        errors: calls
          .filter((c) => !c.ok)
          .map((c) => ({ at: c.at, method: c.method, error: c.error })),
        deliveries,
        /** Epoch ms of the last Web API call or message, for the quiet cap. */
        lastActivityAt,
        refused: {
          msgTooLong: calls.filter((c) => c.error === "msg_too_long").length,
        },
      };
    },
  };
};

export type SlackStore = ReturnType<typeof createSlackStore>;
export type SlackSnapshot = ReturnType<SlackStore["snapshot"]>;
