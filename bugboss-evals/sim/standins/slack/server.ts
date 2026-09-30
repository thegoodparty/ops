// Two listeners. The API port is what BugBoss reaches, as `SLACK_API_URL`,
// and serves the Web API and upload urls. The control port is on the
// orchestrator's network only, and is where people come from: a human's
// message enters Slack here and leaves as a signed event into BugBoss, the
// way a real person's message would. Nothing on the API port can post as a
// human, so BugBoss cannot put words in the persona's mouth.

import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

import { createEventSender, type EventSenderConfig } from "./events";
import { createSlackStore, SlackApiError, type SlackStoreConfig } from "./state";
import { createWebApi } from "./web";

export interface SlackStandinConfig {
  store: SlackStoreConfig;
  botToken: string;
  /** Null disables event delivery, for tests of the Web API alone. */
  events: Omit<EventSenderConfig, "record" | "botUserId" | "teamId"> | null;
  port: number;
  controlPort: number;
  /** Base of upload urls. Defaults to the API listener's own address. */
  publicUrl?: string;
  tls?: { certFile: string; keyFile: string };
  repliesPageCap?: number;
  echoBotMessages?: boolean;
  /** Where the API listener binds. */
  host?: string;
  /** Where the control listener binds. */
  controlHost?: string;
  /**
   * When set, every /__control request must carry it as a bearer token. On
   * a fan-out host containers can share a network namespace, so the port
   * alone does not keep BugBoss off it.
   */
  controlToken?: string;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

// The SDK sends form-encoded bodies with objects JSON-stringified; other
// clients send JSON. Both are accepted, as Slack accepts both.
const parseArgs = (req: IncomingMessage, body: Buffer, url: URL) => {
  const args: Record<string, unknown> = Object.fromEntries(url.searchParams);
  const type = String(req.headers["content-type"] ?? "");
  const text = body.toString("utf8");
  if (type.includes("application/json") && text) {
    Object.assign(args, JSON.parse(text));
  } else if (text) {
    Object.assign(args, Object.fromEntries(new URLSearchParams(text)));
  }
  return args;
};

const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () =>
      resolve((server.address() as AddressInfo).port),
    );
  });

export const startSlackStandin = async (config: SlackStandinConfig) => {
  const store = createSlackStore(config.store);
  const events = config.events
    ? createEventSender({
        ...config.events,
        teamId: config.store.teamId,
        botUserId: config.store.botUserId,
        now: config.events.now ?? config.store.now,
        record: store.recordDelivery,
      })
    : null;
  const host = config.host ?? "0.0.0.0";
  let publicUrl = config.publicUrl ?? "";
  const web = createWebApi({
    store,
    events,
    botToken: config.botToken,
    get publicUrl() {
      return publicUrl;
    },
    repliesPageCap: config.repliesPageCap,
    echoBotMessages: config.echoBotMessages,
  });

  const api = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://slack");
    const body = await readBody(req);
    const upload = /^\/upload\/([A-Z0-9]+)$/.exec(url.pathname);
    if (upload && req.method === "POST") {
      if (!web.upload(upload[1], body)) {
        res.writeHead(404).end("file not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`OK - ${body.byteLength}`);
      return;
    }
    const method = /^\/api\/([a-zA-Z.]+)$/.exec(url.pathname);
    if (!method) {
      res.writeHead(404).end("not found");
      return;
    }
    let args: Record<string, unknown>;
    try {
      args = parseArgs(req, body, url);
    } catch {
      sendJson(res, 200, { ok: false, error: "invalid_json" });
      return;
    }
    const header = String(req.headers.authorization ?? "");
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    const token = bearer ?? (typeof args.token === "string" ? args.token : undefined);
    delete args.token;
    sendJson(res, 200, web.call(method[1], args, token));
  };

  const control = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://slack");
    const body = await readBody(req);
    if (
      config.controlToken &&
      req.headers.authorization !== `Bearer ${config.controlToken}`
    ) {
      sendJson(res, 401, { ok: false, error: "not_authed" });
      return;
    }
    if (url.pathname === "/__control/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__control/state" && req.method === "GET") {
      sendJson(res, 200, store.snapshot());
      return;
    }
    if (url.pathname === "/__control/reset" && req.method === "POST") {
      store.reset();
      sendJson(res, 200, { ok: true });
      return;
    }
    // A person writes in Slack. Answered once the message is stored; the
    // event to BugBoss follows, as it would from Slack.
    if (url.pathname === "/__control/human-message" && req.method === "POST") {
      let input: { user?: unknown; channel?: unknown; threadTs?: unknown; text?: unknown };
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const user = typeof input.user === "string" ? store.user(input.user) : undefined;
      if (!user || user.isBot) {
        sendJson(res, 400, { ok: false, error: "user_not_found" });
        return;
      }
      try {
        const message = store.post({
          channel: input.channel,
          threadTs: typeof input.threadTs === "string" ? input.threadTs : null,
          user: user.id,
          botId: null,
          text: typeof input.text === "string" ? input.text : "",
        });
        const delivered = events ? events.messagePosted(message) : Promise.resolve();
        if (url.searchParams.get("wait") === "delivered") await delivered;
        else delivered.catch(() => undefined);
        sendJson(res, 200, { ok: true, ts: message.ts, threadTs: message.threadTs });
      } catch (err) {
        if (!(err instanceof SlackApiError)) throw err;
        sendJson(res, 400, { ok: false, error: err.code });
      }
      return;
    }
    if (url.pathname === "/__control/interaction" && req.method === "POST") {
      if (!events) {
        sendJson(res, 400, { ok: false, error: "events_disabled" });
        return;
      }
      const delivered = await events.interaction(JSON.parse(body.toString("utf8")));
      sendJson(res, 200, { ok: delivered });
      return;
    }
    if (url.pathname === "/__control/url-verification" && req.method === "POST") {
      if (!events) {
        sendJson(res, 400, { ok: false, error: "events_disabled" });
        return;
      }
      sendJson(res, 200, { ok: (await events.urlVerification()) !== null });
      return;
    }
    res.writeHead(404).end("not found");
  };

  const guard =
    (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse) => {
      handler(req, res).catch((err) => {
        console.error(JSON.stringify({ component: "slack-standin", error: String(err) }));
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal_error" });
        else res.end();
      });
    };

  const apiServer = config.tls
    ? createHttpsServer(
        {
          cert: readFileSync(config.tls.certFile),
          key: readFileSync(config.tls.keyFile),
        },
        guard(api),
      )
    : createHttpServer(guard(api));
  const controlServer = createHttpServer(guard(control));

  const apiPort = await listen(apiServer, config.port, host);
  const controlPort = await listen(
    controlServer,
    config.controlPort,
    config.controlHost ?? host,
  );
  if (!publicUrl) {
    publicUrl = `${config.tls ? "https" : "http"}://127.0.0.1:${apiPort}`;
  }

  return {
    store,
    events,
    apiPort,
    controlPort,
    apiUrl: `${config.tls ? "https" : "http"}://127.0.0.1:${apiPort}/api/`,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    close: async () => {
      await Promise.all(
        [apiServer, controlServer].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections?.();
              s.close(() => resolve());
            }),
        ),
      );
    },
  };
};

export type SlackStandin = Awaited<ReturnType<typeof startSlackStandin>>;
