import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A small Slack: the Web API methods BugBoss calls, one channel, and a way to
 * post as the on-call human, delivered to BugBoss as a signed Events API
 * callback. Only the Boss's own code calls Slack, so this is its whole world.
 */

export const CHANNEL = "C0EVALBUGS";
export const BOT_USER = "U0EVALBOT";
export const HUMAN_USER = "U0EVALHUMAN";

export interface Message {
  ts: string;
  threadTs: string | null;
  user: string;
  text: string;
  bot: boolean;
  /** An uploaded file's content, for the closing report. */
  file: string | null;
  fileName: string | null;
  /** The text as posted, then after every chat.update, with epoch ms. */
  history: { at: number; text: string }[];
}

export interface Slack {
  apiUrl: string;
  messages: Message[];
  /** Post as the human and deliver it to BugBoss. */
  say: (threadTs: string, text: string) => Promise<void>;
  close: () => void;
}

export const signSlack = (secret: string, stamp: number, body: string): string =>
  `v0=${createHmac("sha256", secret).update(`v0:${stamp}:${body}`, "utf8").digest("hex")}`;

export const startSlack = async (args: {
  botToken: string;
  signingSecret: string;
  /** The system's Slack events route, read at delivery time so it can be known only once the system is up. */
  eventsUrl: string | (() => string);
  onBotMessage?: (message: Message) => void;
}): Promise<Slack> => {
  const messages: Message[] = [];
  const uploads = new Map<string, { name: string; content: string | null }>();
  let clock = Math.floor(Date.now() / 1000) * 1_000_000;
  const nextTs = () => {
    clock = Math.max(clock + 1, Date.now() * 1000);
    return `${Math.floor(clock / 1_000_000)}.${String(clock % 1_000_000).padStart(6, "0")}`;
  };
  const toSlack = (m: Message) => ({
    type: "message",
    user: m.user,
    text: m.text,
    ts: m.ts,
    ...(m.threadTs ? { thread_ts: m.threadTs } : {}),
    ...(m.bot ? { bot_id: "B0EVALBOT" } : {}),
  });
  const postBot = (text: string, threadTs: string | null, file: { name: string; content: string } | null = null): Message => {
    const message: Message = {
      ts: nextTs(),
      threadTs,
      user: BOT_USER,
      text,
      bot: true,
      file: file?.content ?? null,
      fileName: file?.name ?? null,
      history: [{ at: Date.now(), text }],
    };
    messages.push(message);
    args.onBotMessage?.(message);
    return message;
  };
  let port = 0;

  const methods: Record<string, (a: Record<string, string>) => Record<string, unknown>> = {
    "auth.test": () => ({ user_id: BOT_USER, bot_id: "B0EVALBOT", team_id: "T0EVAL", url: "https://eval.slack.com/" }),
    "chat.postMessage": (a) => {
      const m = postBot(a.text ?? "", a.thread_ts || null);
      return { channel: CHANNEL, ts: m.ts, message: toSlack(m) };
    },
    "chat.update": (a) => {
      const m = messages.find((x) => x.ts === a.ts);
      if (!m) throw new Error("message_not_found");
      m.text = a.text ?? m.text;
      m.history.push({ at: Date.now(), text: m.text });
      return { channel: CHANNEL, ts: m.ts, text: m.text };
    },
    "chat.getPermalink": (a) => ({
      channel: CHANNEL,
      permalink: `https://eval.slack.com/archives/${CHANNEL}/p${(a.message_ts ?? "").replace(".", "")}`,
    }),
    "reactions.add": () => ({}),
    "conversations.replies": (a) => {
      const parent = messages.find((m) => m.ts === a.ts);
      if (!parent) throw new Error("thread_not_found");
      const root = parent.threadTs ?? parent.ts;
      const thread = messages.filter((m) => m.ts === root || m.threadTs === root);
      return { messages: thread.map(toSlack), has_more: false, response_metadata: { next_cursor: "" } };
    },
    "files.getUploadURLExternal": (a) => {
      const id = `F${randomUUID().slice(0, 8).toUpperCase()}`;
      uploads.set(id, { name: a.filename ?? "file", content: null });
      return { upload_url: `http://127.0.0.1:${port}/upload/${id}`, file_id: id };
    },
    "files.completeUploadExternal": (a) => {
      const files = JSON.parse(a.files ?? "[]") as Array<{ id: string; title?: string }>;
      for (const f of files) {
        const upload = uploads.get(f.id);
        if (!upload || upload.content === null) throw new Error("file_not_found");
        postBot(a.initial_comment ?? "", a.thread_ts || null, { name: f.title || upload.name, content: upload.content });
      }
      return { files: files.map((f) => ({ id: f.id, title: f.title ?? "" })) };
    },
    "users.info": (a) => ({ user: { id: a.user, name: a.user, real_name: a.user, is_bot: a.user === BOT_USER } }),
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = new URL(req.url ?? "/", "http://slack").pathname;
      const upload = /^\/upload\/(\w+)$/.exec(path);
      if (upload) {
        const file = uploads.get(upload[1]);
        if (file) file.content = raw;
        res.writeHead(file ? 200 : 404).end("OK");
        return;
      }
      const method = path.replace(/^\/api\//, "");
      const body: Record<string, string> = (req.headers["content-type"] ?? "").includes("json")
        ? (JSON.parse(raw || "{}") as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(raw));
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "") || body.token;
      let answer: Record<string, unknown>;
      try {
        if (token !== args.botToken) throw new Error("invalid_auth");
        const handler = methods[method];
        if (!handler) throw new Error("unknown_method");
        answer = { ok: true, ...handler(body) };
      } catch (error: unknown) {
        answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("slack did not bind");
  port = address.port;

  return {
    apiUrl: `http://127.0.0.1:${port}/api/`,
    messages,
    say: async (threadTs, text) => {
      const message: Message = { ts: nextTs(), threadTs, user: HUMAN_USER, text, bot: false, file: null, fileName: null, history: [{ at: Date.now(), text }] };
      messages.push(message);
      const body = JSON.stringify({
        type: "event_callback",
        team_id: "T0EVAL",
        api_app_id: "A0EVAL",
        event_id: `Ev${randomUUID().slice(0, 10)}`,
        event_time: Math.floor(Date.now() / 1000),
        event: { type: "message", channel: CHANNEL, channel_type: "channel", user: HUMAN_USER, text, ts: message.ts, event_ts: message.ts, thread_ts: threadTs },
      });
      const stamp = Math.floor(Date.now() / 1000);
      const res = await fetch(typeof args.eventsUrl === "function" ? args.eventsUrl() : args.eventsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(stamp),
          "x-slack-signature": signSlack(args.signingSecret, stamp, body),
        },
        body,
      });
      if (!res.ok) throw new Error(`the system refused a Slack event: ${res.status} ${await res.text()}`);
    },
    close: () => server.close(),
  };
};
