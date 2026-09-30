// The Slack Web API subset BugBoss calls, read off bugboss/slack/client.ts:
// chat.postMessage, chat.update, chat.getPermalink, reactions.add,
// conversations.replies (cursor-paginated), files.getUploadURLExternal, the
// POST to the upload url it hands back, files.completeUploadExternal and
// usergroups.users.list. users.info and auth.test are here because any Slack
// client reaches for them first when something looks wrong.
//
// Answers follow Slack's shape: HTTP 200 with `ok: false` and an error code
// for every refusal, which is what @slack/web-api turns into a thrown
// platform error.

import type { EventSender } from "./events";
import { SlackApiError, type SlackStore, type StoredMessage } from "./state";

export interface WebApiConfig {
  store: SlackStore;
  events: EventSender | null;
  /** The only token the Web API accepts: BugBoss's bot token. */
  botToken: string;
  /** Where upload urls point, e.g. https://slack:8445. */
  publicUrl: string;
  /**
   * The largest page conversations.replies will return, whatever `limit`
   * asks for. Set low to push a real thread through the cursor path.
   */
  repliesPageCap?: number;
  /** Re-deliver BugBoss's own posts as events, as Slack does. */
  echoBotMessages?: boolean;
}

type Args = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

const toSlackMessage = (m: StoredMessage) => {
  const out: Record<string, unknown> = {
    type: "message",
    user: m.user,
    text: m.text,
    ts: m.ts,
  };
  if (m.botId) out.bot_id = m.botId;
  if (m.threadTs) out.thread_ts = m.threadTs;
  if (m.edits.length) out.edited = { user: m.user, ts: m.edits.at(-1)!.ts };
  if (m.reactions.length) {
    out.reactions = m.reactions.map((r) => ({
      name: r.name,
      users: r.users,
      count: r.users.length,
    }));
  }
  if (m.files.length) out.files = m.files.map((id) => ({ id }));
  return out;
};

const encodeCursor = (offset: number) =>
  Buffer.from(`offset:${offset}`).toString("base64");

const decodeCursor = (cursor: string): number => {
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) throw new SlackApiError("invalid_cursor");
  return Number(match[1]);
};

export const createWebApi = (config: WebApiConfig) => {
  const { store } = config;
  const bot = { user: store.config.botUserId, botId: store.config.botId };
  const echo = config.echoBotMessages ?? true;

  // Deliveries run after the answer, as Slack's do. A failure is recorded in
  // the delivery log, which is where the orchestrator looks for it.
  const fire = (work: (() => Promise<void>) | null) => {
    if (!work) return;
    work().catch(() => undefined);
  };

  const methods: Record<string, (args: Args) => Record<string, unknown>> = {
    "auth.test": () => ({
      url: `https://${store.config.workspaceDomain}/`,
      team_id: store.config.teamId,
      user_id: bot.user,
      bot_id: bot.botId,
    }),

    "chat.postMessage": (args) => {
      const text = typeof args.text === "string" ? args.text : "";
      const message = store.post({
        channel: args.channel,
        threadTs: str(args.thread_ts) ?? null,
        user: bot.user,
        botId: bot.botId,
        text,
      });
      if (echo && config.events) {
        const events = config.events;
        fire(() => events.messagePosted(message));
      }
      return {
        channel: message.channel,
        ts: message.ts,
        message: toSlackMessage(message),
      };
    },

    "chat.update": (args) => {
      const channel = store.requireChannel(args.channel);
      const ts = str(args.ts);
      const message = ts ? store.find(channel, ts) : undefined;
      if (!message) throw new SlackApiError("message_not_found");
      if (message.user !== bot.user) {
        throw new SlackApiError("cant_update_message");
      }
      const text = typeof args.text === "string" ? args.text : "";
      if (text === "") throw new SlackApiError("no_text");
      store.checkLength(text);
      message.edits.push({ ts: store.nextTs(), previousText: message.text });
      message.text = text;
      if (echo && config.events) {
        const events = config.events;
        fire(() => events.messageChanged(message));
      }
      return { channel, ts: message.ts, text };
    },

    "chat.getPermalink": (args) => {
      const channel = store.requireChannel(args.channel);
      const ts = str(args.message_ts);
      if (!ts) throw new SlackApiError("message_not_found");
      return { channel, permalink: store.permalink(channel, ts) };
    },

    "reactions.add": (args) => {
      const channel = store.requireChannel(args.channel);
      const ts = str(args.timestamp);
      const name = str(args.name);
      if (!name) throw new SlackApiError("invalid_name");
      const message = ts ? store.find(channel, ts) : undefined;
      if (!message) throw new SlackApiError("message_not_found");
      let reaction = message.reactions.find((r) => r.name === name);
      if (!reaction) {
        reaction = { name, users: [] };
        message.reactions.push(reaction);
      }
      if (reaction.users.includes(bot.user)) {
        throw new SlackApiError("already_reacted");
      }
      reaction.users.push(bot.user);
      return {};
    },

    "conversations.replies": (args) => {
      const channel = store.requireChannel(args.channel);
      const ts = str(args.ts);
      const asked = ts ? store.find(channel, ts) : undefined;
      if (!asked) throw new SlackApiError("thread_not_found");
      const parent = asked.threadTs
        ? store.find(channel, asked.threadTs)!
        : asked;
      const oldest = str(args.oldest);
      const latest = str(args.latest);
      const inclusive = args.inclusive === true || args.inclusive === "true";
      const inWindow = (m: StoredMessage) => {
        const t = Number(m.ts);
        if (oldest && (inclusive ? t < Number(oldest) : t <= Number(oldest))) {
          return false;
        }
        if (latest && (inclusive ? t > Number(latest) : t >= Number(latest))) {
          return false;
        }
        return true;
      };
      const replies = store.threadOf(channel, parent.ts).filter(inWindow);
      const asks = Number(args.limit ?? 1000);
      const limit = Math.max(
        1,
        Math.min(
          Number.isFinite(asks) && asks > 0 ? asks : 1000,
          1000,
          config.repliesPageCap ?? 1000,
        ),
      );
      const cursor = str(args.cursor);
      const offset = cursor ? decodeCursor(cursor) : 0;
      const page = replies.slice(offset, offset + limit);
      const more = offset + limit < replies.length;
      // Every page leads with the parent, whatever the window, as Slack's do.
      return {
        messages: [parent, ...page].map(toSlackMessage),
        has_more: more,
        response_metadata: { next_cursor: more ? encodeCursor(offset + limit) : "" },
      };
    },

    "files.getUploadURLExternal": (args) => {
      const filename = str(args.filename);
      const length = Number(args.length);
      if (!filename || !Number.isInteger(length) || length <= 0) {
        throw new SlackApiError("invalid_arguments");
      }
      const id = store.newFileId();
      store.files().push({
        id,
        filename,
        length,
        title: null,
        content: null,
        uploadedBytes: null,
        channel: null,
        threadTs: null,
        messageTs: null,
        completed: false,
      });
      return { upload_url: `${config.publicUrl}/upload/${id}`, file_id: id };
    },

    "files.completeUploadExternal": (args) => {
      let requested: { id?: unknown; title?: unknown }[];
      try {
        requested =
          typeof args.files === "string"
            ? JSON.parse(args.files)
            : (args.files as typeof requested);
      } catch {
        throw new SlackApiError("invalid_arguments");
      }
      if (!Array.isArray(requested) || requested.length === 0) {
        throw new SlackApiError("invalid_arguments");
      }
      const found = requested.map((r) => {
        const file = store.files().find((f) => f.id === r.id);
        if (!file || file.completed) throw new SlackApiError("file_not_found");
        if (file.uploadedBytes === null) {
          throw new SlackApiError("file_not_found");
        }
        // Slack refuses a completion whose bytes differ from the promised
        // length, which is why BugBoss measures bytes and not characters.
        if (file.uploadedBytes !== file.length) {
          throw new SlackApiError("file_upload_size_mismatch");
        }
        return { file, title: typeof r.title === "string" ? r.title : null };
      });
      const channel = str(args.channel_id);
      const comment =
        typeof args.initial_comment === "string" ? args.initial_comment : "";
      let message: StoredMessage | null = null;
      if (channel) {
        message = store.post({
          channel,
          threadTs: str(args.thread_ts) ?? null,
          user: bot.user,
          botId: bot.botId,
          text: comment,
          files: found.map((f) => f.file.id),
        });
      }
      for (const { file, title } of found) {
        file.title = title ?? file.filename;
        file.completed = true;
        file.channel = message?.channel ?? null;
        file.threadTs = message?.threadTs ?? null;
        file.messageTs = message?.ts ?? null;
      }
      if (message && echo && config.events) {
        const events = config.events;
        const posted = message;
        fire(() => events.messagePosted(posted));
      }
      return {
        files: found.map(({ file }) => ({ id: file.id, title: file.title })),
      };
    },

    "usergroups.users.list": (args) => {
      const group = str(args.usergroup);
      const users = group ? store.config.usergroups[group] : undefined;
      if (!users) throw new SlackApiError("no_such_subteam");
      return { users };
    },

    "users.info": (args) => {
      const id = str(args.user);
      const user = id ? store.user(id) : undefined;
      if (!user) throw new SlackApiError("user_not_found");
      return {
        user: {
          id: user.id,
          team_id: store.config.teamId,
          name: user.name,
          real_name: user.realName,
          is_bot: user.isBot,
          deleted: false,
          profile: { real_name: user.realName, display_name: user.name },
        },
      };
    },
  };

  return {
    /** One Web API call, already authenticated. */
    call: (method: string, args: Args, token: string | undefined) => {
      const at = store.now();
      let answer: Record<string, unknown>;
      try {
        if (!token) throw new SlackApiError("not_authed");
        if (token !== config.botToken) throw new SlackApiError("invalid_auth");
        const handler = methods[method];
        if (!handler) throw new SlackApiError("unknown_method");
        answer = { ok: true, ...handler(args) };
      } catch (err) {
        if (!(err instanceof SlackApiError)) throw err;
        answer = { ok: false, error: err.code };
      }
      store.recordCall({
        at,
        method,
        args,
        ok: answer.ok === true,
        error: answer.ok === true ? null : String(answer.error),
      });
      return answer;
    },
    /** The body of the POST to an upload url. No token, as in Slack. */
    upload: (fileId: string, body: Buffer): boolean => {
      const file = store.files().find((f) => f.id === fileId);
      if (!file || file.completed) return false;
      file.uploadedBytes = body.byteLength;
      file.content = body.toString("utf8");
      return true;
    },
  };
};

export type WebApi = ReturnType<typeof createWebApi>;
