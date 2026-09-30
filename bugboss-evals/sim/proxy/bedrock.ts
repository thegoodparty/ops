import { randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import https from "node:https";

import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";

import type {
  ProxyCost,
  ProxyLogRecord,
  ProxyOutcome,
  ProxyUsage,
} from "../../core/adapters/proxy-log";
import { PRICE_TABLE } from "../../core/price";
import { FrameReader } from "./eventstream";
import {
  assembleBody,
  emptyUsage,
  priceUsage,
  StreamAssembler,
  zeroCost,
  type AssembledResponse,
} from "./response";

/**
 * The counting proxy in front of Bedrock. BugBoss reaches it through
 * AWS_ENDPOINT_URL_BEDROCK_RUNTIME with fake credentials; the proxy drops the
 * incoming signature, re-signs with its own, relays the response bytes
 * unchanged, logs the exchange, and prices it. Once spend reaches the budget,
 * every request gets a ThrottlingException, so the variant's own failure path
 * runs whatever it is.
 *
 * BugBoss's Bedrock client speaks HTTP/2 only (the SDK builds it on
 * NodeHttp2Handler), so the model listener must be an http2 server; the
 * handlers accept either kind of request.
 */

type Request = http.IncomingMessage | Http2ServerRequest;
type Response = http.ServerResponse | Http2ServerResponse;

export interface ModelProxyOptions {
  /** Base URL of the real service, e.g. https://bedrock-runtime.us-west-2.amazonaws.com. */
  upstream: URL;
  region: string;
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  budgetUsd: number;
  tracePath: string;
  /** When set, every /__control request must carry `Authorization: Bearer <token>`. */
  controlToken?: string;
  now?: () => number;
}

export interface ProxyState {
  budgetUsd: number;
  spendUsd: number;
  remainingUsd: number;
  overBudget: boolean;
  /** Exchanges that reached the model and returned 2xx: the turns that billed. */
  turns: number;
  requests: number;
  inFlight: number;
  outcomes: Record<ProxyOutcome, number>;
  tokens: Omit<ProxyUsage, "split">;
  byModel: Record<string, { turns: number; spendUsd: number }>;
  firstRequestAt: number | null;
  lastActivityAt: number | null;
  tracePath: string;
}

const OPERATION = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream)$/;

// Headers that reach Bedrock. Everything else, above all the incoming
// signature, is dropped and the request re-signed.
const FORWARDED_REQUEST_HEADER = /^(content-type|accept|x-amzn-bedrock-.+)$/;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding"]);

/** A system-defined inference profile or foundation model ARN prices as its suffix. */
export const catalogModelOf = (modelId: string): string => {
  const match = /:(?:inference-profile|foundation-model)\/(.+)$/.exec(modelId);
  return match ? match[1] : modelId;
};

const emptyOutcomes = (): Record<ProxyOutcome, number> => ({
  ok: 0,
  budget_throttled: 0,
  refused: 0,
  upstream_error: 0,
  upstream_unreachable: 0,
  stream_exception: 0,
  client_aborted: 0,
});

const readBody = (req: Request): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const sendError = (
  res: Response,
  status: number,
  type: string,
  message: string,
  requestId: string,
): void => {
  const body = JSON.stringify({ message });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "x-amzn-errortype": type,
    "x-amzn-requestid": requestId,
  });
  res.end(body);
};

const errorTypeOf = (header: string | string[] | undefined): string =>
  String(Array.isArray(header) ? header[0] : (header ?? "")).split(":")[0];

export const createModelProxy = (options: ModelProxyOptions) => {
  const now = options.now ?? Date.now;
  const signer = new SignatureV4({
    service: "bedrock",
    region: options.region,
    credentials: options.credentials,
    sha256: Hash.bind(null, "sha256"),
  });

  let seq = 0;
  let spendUsd = 0;
  let turns = 0;
  let requests = 0;
  let inFlight = 0;
  let outcomes = emptyOutcomes();
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0 };
  let byModel: Record<string, { turns: number; spendUsd: number }> = {};
  let firstRequestAt: number | null = null;
  let lastActivityAt: number | null = null;

  if (!existsSync(options.tracePath)) writeFileSync(options.tracePath, "");

  const state = (): ProxyState => ({
    budgetUsd: options.budgetUsd,
    spendUsd,
    remainingUsd: Math.max(0, options.budgetUsd - spendUsd),
    overBudget: spendUsd >= options.budgetUsd,
    turns,
    requests,
    inFlight,
    outcomes: { ...outcomes },
    tokens: { ...tokens },
    byModel: structuredClone(byModel),
    firstRequestAt,
    lastActivityAt,
    tracePath: options.tracePath,
  });

  const reset = (): void => {
    seq = 0;
    spendUsd = 0;
    turns = 0;
    requests = 0;
    outcomes = emptyOutcomes();
    tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cacheWrite5m: 0 };
    byModel = {};
    firstRequestAt = null;
    lastActivityAt = null;
    writeFileSync(options.tracePath, "");
  };

  const record = (
    entry: Omit<ProxyLogRecord, "v" | "endedAt" | "spendUsdAfter" | "budgetUsd" | "cost"> & {
      cost?: ProxyCost;
    },
  ): void => {
    const cost = entry.cost ?? zeroCost();
    spendUsd += cost.total;
    outcomes[entry.outcome] += 1;
    if (entry.outcome === "ok") turns += 1;
    for (const key of Object.keys(tokens) as Array<keyof typeof tokens>) {
      tokens[key] += entry.usage[key];
    }
    if (entry.model && cost.total > 0) {
      byModel[entry.model] ??= { turns: 0, spendUsd: 0 };
      byModel[entry.model].spendUsd += cost.total;
      if (entry.outcome === "ok") byModel[entry.model].turns += 1;
    }
    lastActivityAt = now();
    const line: ProxyLogRecord = {
      v: 1,
      ...entry,
      cost,
      endedAt: lastActivityAt,
      spendUsdAfter: spendUsd,
      budgetUsd: options.budgetUsd,
    };
    appendFileSync(options.tracePath, `${JSON.stringify(line)}\n`);
  };

  const handle = async (req: Request, res: Response): Promise<void> => {
    const startedAt = now();
    const mySeq = ++seq;
    requests += 1;
    firstRequestAt ??= startedAt;
    lastActivityAt = startedAt;
    inFlight += 1;
    const localId = randomUUID();
    const url = new URL(req.url ?? "/", "http://proxy");
    const match = OPERATION.exec(url.pathname);
    const modelId = match ? decodeURIComponent(match[1]) : "";
    const operation: ProxyLogRecord["operation"] = match
      ? (match[2] as "invoke" | "invoke-with-response-stream")
      : "unknown";
    const model = catalogModelOf(modelId);

    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      parsed = body.toString("utf8");
    }
    const base = {
      seq: mySeq,
      startedAt,
      operation,
      modelId,
      request: parsed,
    };
    const refuse = (status: number, type: string, message: string, outcome: ProxyOutcome) => {
      inFlight -= 1;
      sendError(res, status, type, message, localId);
      record({
        ...base,
        requestId: localId,
        model: outcome === "refused" ? "" : model,
        outcome,
        status,
        error: { type, message },
        response: { message: null, invocationMetrics: null, errorBody: null },
        usage: emptyUsage(),
      });
    };

    try {
      if (req.method !== "POST" || !match) {
        refuse(
          404,
          "UnknownOperationException",
          `the eval model proxy only forwards InvokeModel and InvokeModelWithResponseStream, not ${req.method} ${url.pathname}`,
          "refused",
        );
        return;
      }
      if (!PRICE_TABLE[model]) {
        refuse(
          400,
          "ValidationException",
          `the eval model proxy has no price for model ${JSON.stringify(model)}, so it cannot hold the budget and will not forward the request`,
          "refused",
        );
        return;
      }
      if (spendUsd >= options.budgetUsd) {
        refuse(
          429,
          "ThrottlingException",
          `Too many requests, please wait before trying again. (eval model budget of $${options.budgetUsd.toFixed(2)} is spent: $${spendUsd.toFixed(2)})`,
          "budget_throttled",
        );
        return;
      }

      const headers: Record<string, string> = { host: options.upstream.host };
      for (const [name, value] of Object.entries(req.headers)) {
        if (FORWARDED_REQUEST_HEADER.test(name) && value !== undefined) {
          headers[name] = Array.isArray(value) ? value.join(",") : value;
        }
      }
      headers["content-length"] = String(body.length);
      const basePath = options.upstream.pathname.replace(/\/$/, "");
      const rawPath = (req.url ?? "/").split("?")[0];
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      const signed = await signer.sign(
        new HttpRequest({
          method: "POST",
          protocol: options.upstream.protocol,
          hostname: options.upstream.hostname,
          port: options.upstream.port ? Number(options.upstream.port) : undefined,
          path: `${basePath}${rawPath}`,
          query,
          headers,
          body,
        }),
      );

      const transport = options.upstream.protocol === "https:" ? https : http;
      const search = url.search;
      await new Promise<void>((resolve) => {
        const upstreamReq = transport.request(
          {
            method: "POST",
            protocol: options.upstream.protocol,
            hostname: options.upstream.hostname,
            port: options.upstream.port || undefined,
            path: `${basePath}${rawPath}${search}`,
            headers: signed.headers,
          },
          (upstreamRes) => {
            const status = upstreamRes.statusCode ?? 502;
            const requestId = String(upstreamRes.headers["x-amzn-requestid"] ?? localId);
            const responseHeaders: Record<string, string | string[]> = {};
            for (const [name, value] of Object.entries(upstreamRes.headers)) {
              if (!HOP_BY_HOP.has(name) && value !== undefined) responseHeaders[name] = value;
            }
            res.writeHead(status, responseHeaders);

            const ok = status >= 200 && status < 300;
            const streaming = ok && operation === "invoke-with-response-stream";
            const reader = new FrameReader();
            const assembler = new StreamAssembler();
            const buffered: Buffer[] = [];
            let decodeError: string | null = null;
            let finished = false;

            upstreamRes.on("data", (chunk: Buffer) => {
              (res as http.ServerResponse).write(chunk);
              if (!streaming) {
                buffered.push(chunk);
                return;
              }
              if (decodeError) return;
              try {
                for (const frame of reader.push(chunk)) assembler.add(frame);
              } catch (error) {
                decodeError = String(error);
              }
            });

            const finish = (aborted: boolean) => {
              if (finished) return;
              finished = true;
              let assembled: AssembledResponse | null = null;
              let errorBody: string | null = null;
              let error: { type: string; message: string } | null = null;
              let outcome: ProxyOutcome = "ok";
              if (streaming) {
                assembled = assembler.result();
                if (assembled.exception) {
                  outcome = "stream_exception";
                  error = assembled.exception;
                } else if (decodeError) {
                  error = { type: "ProxyDecodeError", message: decodeError };
                }
              } else if (ok) {
                const text = Buffer.concat(buffered).toString("utf8");
                try {
                  assembled = assembleBody(text);
                } catch (parseError) {
                  error = { type: "ProxyDecodeError", message: String(parseError) };
                }
              } else {
                outcome = "upstream_error";
                errorBody = Buffer.concat(buffered).toString("utf8");
                let message = errorBody;
                try {
                  const json = JSON.parse(errorBody) as Record<string, unknown>;
                  message = String(json.message ?? json.Message ?? errorBody);
                } catch {}
                error = {
                  type: errorTypeOf(upstreamRes.headers["x-amzn-errortype"]) || `HTTP${status}`,
                  message,
                };
              }
              if (aborted) {
                outcome = "client_aborted";
                error ??= { type: "ClientAborted", message: "BugBoss closed the connection before the response ended" };
              }
              const usage = assembled?.usage ?? emptyUsage();
              inFlight -= 1;
              record({
                ...base,
                requestId,
                model,
                outcome,
                status,
                error,
                response: {
                  message: assembled?.message ?? null,
                  invocationMetrics: assembled?.invocationMetrics ?? null,
                  errorBody,
                },
                usage,
                cost: priceUsage(model, usage),
              });
              resolve();
            };

            upstreamRes.on("end", () => {
              res.end();
              finish(false);
            });
            upstreamRes.on("error", () => {
              res.destroy();
              finish(true);
            });
            res.on("close", () => {
              if (!res.writableFinished) {
                upstreamReq.destroy();
                finish(true);
              }
            });
          },
        );
        upstreamReq.on("error", (error) => {
          if (res.headersSent) return;
          refuse(
            503,
            "ServiceUnavailableException",
            `the eval model proxy could not reach Bedrock: ${String(error)}`,
            "upstream_unreachable",
          );
          resolve();
        });
        upstreamReq.end(body);
      });
    } catch (error) {
      if (res.headersSent) return;
      refuse(
        503,
        "ServiceUnavailableException",
        `the eval model proxy could not sign or send the request: ${String(error)}`,
        "upstream_unreachable",
      );
    }
  };

  const handleControl = (req: Request, res: Response): void => {
    const path = new URL(req.url ?? "/", "http://control").pathname;
    const json = (status: number, value: unknown) => {
      const body = JSON.stringify(value);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    if (
      options.controlToken &&
      req.headers.authorization !== `Bearer ${options.controlToken}`
    ) {
      return json(401, { error: "control requests need the control token" });
    }
    if (req.method === "GET" && path === "/__control/health") return json(200, { ok: true });
    if (req.method === "GET" && path === "/__control/state") return json(200, state());
    if (req.method === "POST" && path === "/__control/reset") {
      reset();
      return json(200, state());
    }
    if (req.method === "GET" && path === "/__control/trace") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      createReadStream(options.tracePath).pipe(res);
      return;
    }
    json(404, { error: `no control route ${req.method} ${path}` });
  };

  return { handle, handleControl, state, reset };
};

export type ModelProxy = ReturnType<typeof createModelProxy>;
