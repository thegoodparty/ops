import { readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";

import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

import { createModelProxy } from "./bedrock";

/**
 * Entry point: `tsx bugboss-evals/sim/proxy/server.ts`.
 *
 * PORT                  model listener: HTTP/2 over TLS (HTTP/1.1 also accepted)
 *                       when TLS_CERT_FILE and TLS_KEY_FILE are set, else h2c
 * PROXY_HTTP_PORT       optional second model listener, cleartext h2c. The
 *                       Bedrock SDK speaks HTTP/2 with prior knowledge on an
 *                       http:// endpoint, so this is not HTTP/1.1
 * CONTROL_PORT          /__control listener, always plain http
 * CONTROL_HOST          control bind address, default 0.0.0.0
 * CONTROL_TOKEN         optional bearer token required on /__control
 * PROXY_BUDGET_USD      required; spend at which requests are throttled
 * PROXY_TRACE_FILE      JSONL log, default ./proxy-trace.jsonl
 * UPSTREAM_REGION       default AWS_REGION; the upstream is always
 *                       bedrock-runtime.<region>.amazonaws.com, never a host
 *                       the request names
 * UPSTREAM_URL          tests only: replaces that upstream
 *
 * Credentials come from the default chain in this process only.
 */

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const port = (name: string, fallback?: number): number => {
  const raw = process.env[name];
  if (!raw) {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} is not a port: ${raw}`);
  return value;
};

const budgetUsd = Number(required("PROXY_BUDGET_USD"));
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
  throw new Error(`PROXY_BUDGET_USD must be a positive number, got ${process.env.PROXY_BUDGET_USD}`);
}
const region = process.env.UPSTREAM_REGION || required("AWS_REGION");
const upstream = new URL(
  process.env.UPSTREAM_URL || `https://bedrock-runtime.${region}.amazonaws.com`,
);

const certFile = process.env.TLS_CERT_FILE;
const keyFile = process.env.TLS_KEY_FILE;
if (Boolean(certFile) !== Boolean(keyFile)) {
  throw new Error("set both TLS_CERT_FILE and TLS_KEY_FILE, or neither");
}

const proxy = createModelProxy({
  upstream,
  region,
  credentials: fromNodeProviderChain(),
  budgetUsd,
  tracePath: process.env.PROXY_TRACE_FILE || "./proxy-trace.jsonl",
  controlToken: process.env.CONTROL_TOKEN || undefined,
});

const onModel = (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
  proxy.handle(req, res).catch((error) => {
    console.error(JSON.stringify({ event: "proxy_request_failed", error: String(error) }));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
};

const modelPort = port("PORT", 8443);
const modelServer =
  certFile && keyFile
    ? http2.createSecureServer(
        { cert: readFileSync(certFile), key: readFileSync(keyFile), allowHTTP1: true },
        onModel,
      )
    : http2.createServer(onModel);
const listening = (server: { listen: (port: number, host: string, done: () => void) => unknown }, port: number, host: string) =>
  new Promise<void>((resolve) => server.listen(port, host, resolve));

const controlServer = http.createServer((req, res) => proxy.handleControl(req, res));

void Promise.all([
  listening(modelServer, modelPort, "0.0.0.0"),
  process.env.PROXY_HTTP_PORT
    ? listening(http2.createServer(onModel), port("PROXY_HTTP_PORT"), "0.0.0.0")
    : Promise.resolve(),
  listening(controlServer, port("CONTROL_PORT", 9001), process.env.CONTROL_HOST || "0.0.0.0"),
]).then(() => {
  console.log(
    JSON.stringify({
      event: "proxy_listening",
      port: modelPort,
      tls: Boolean(certFile),
      upstream: upstream.origin,
      budgetUsd,
    }),
  );
});
