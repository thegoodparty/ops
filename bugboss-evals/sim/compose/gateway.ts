import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * The orchestrator's one door into a running stack. It is the only container
 * with a published port, so the orchestrator never needs a route onto the
 * internal networks, and the table below is the whole of what it can reach.
 *
 * It sits on the sim network because it delivers the alert webhook to
 * BugBoss, which means BugBoss can reach it too. So it forwards nothing
 * without the run's control token, and it forwards only to the fixed targets
 * here, never to a host a request names.
 */

interface Target {
  origin: string;
  /** Control listeners take the token as a bearer; nothing else sees it. */
  control: boolean;
}

export const TARGETS: Record<string, Target> = {
  proxy: { origin: "http://proxy:9001", control: true },
  github: { origin: "http://github:9002", control: true },
  slack: { origin: "http://slack:9003", control: true },
  aws: { origin: "http://aws:9004", control: true },
  telemetry: { origin: "http://telemetry:9005", control: true },
  checker: { origin: "http://checker:9006", control: true },
  bugboss: { origin: "http://bugboss:3000", control: false },
  grafana: { origin: "http://grafana:3000", control: false },
};

export const TOKEN_HEADER = "x-sim-token";

export const route = (
  url: string,
  targets: Record<string, Target> = TARGETS,
): { target: Target; path: string } | null => {
  const match = /^\/([a-z]+)(\/.*)?$/.exec(url);
  if (!match) return null;
  const target = targets[match[1]];
  if (!target) return null;
  return { target, path: match[2] ?? "/" };
};

export const createGateway = (options: {
  token: string;
  targets?: Record<string, Target>;
}) =>
  createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.headers[TOKEN_HEADER] !== options.token) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("missing or wrong sim token\n");
      return;
    }
    const routed = route(req.url ?? "/", options.targets);
    if (!routed) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no such target\n");
      return;
    }
    const upstream = new URL(routed.path, routed.target.origin);
    const headers = { ...req.headers };
    delete headers[TOKEN_HEADER];
    delete headers.host;
    if (routed.target.control) headers.authorization = `Bearer ${options.token}`;
    const out = request(
      upstream,
      { method: req.method, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    out.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end(`gateway: ${upstream.origin} unreachable: ${error.message}\n`);
    });
    req.pipe(out);
  });

if (require.main === module) {
  const token = process.env.CONTROL_TOKEN;
  if (!token) throw new Error("CONTROL_TOKEN is required");
  const port = Number(process.env.PORT ?? 8900);
  createGateway({ token }).listen(port, "0.0.0.0", () =>
    console.log(JSON.stringify({ event: "gateway_listening", port })),
  );
}
