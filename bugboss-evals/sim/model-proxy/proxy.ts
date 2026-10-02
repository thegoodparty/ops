import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import https from "node:https";
import { dirname } from "node:path";

import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";

import type {
  ProxyCost,
  ProxyLogRecord,
  ProxyOperation,
  ProxyOutcome,
  ProxyUpstream,
} from "../../core/adapters/proxy-log";
import { PRICE_TABLE, type Rates } from "../../core/price";
import { encodeFrame, FrameReader } from "./eventstream";
import { assembleBody, emptyUsage, priceUsage, SseReader, StreamAssembler, zeroCost, type AssembledResponse } from "./response";

/**
 * The counting proxy between the system under test and its model provider.
 * It relays request and response bytes unchanged, logs each exchange with its
 * assembled response, and prices it. Two faces, one per upstream:
 *
 * - Bedrock: InvokeModel and InvokeModelWithResponseStream. The caller's
 *   signature is dropped and the request re-signed with this process's
 *   credentials, so the caller needs none that reach AWS.
 * - Anthropic: POST /v1/messages, the caller's own `x-api-key` or
 *   `authorization` forwarded as sent.
 *
 * Both carry Anthropic Messages bodies, so parsing and pricing are shared.
 *
 * A third arrangement crosses them: a Bedrock face on an Anthropic upstream.
 * BugBoss speaks only Bedrock InvokeModel, and the eval has no AWS at all, so
 * the proxy takes its Bedrock request, sends the same body to the Anthropic
 * API with the eval's key, and hands back Bedrock's shapes: the JSON as is,
 * or SSE events re-framed as an event stream. Pricing follows the Anthropic
 * model id, which is what the invoice will say.
 */

type Request = http.IncomingMessage | Http2ServerRequest;
type Response = http.ServerResponse | Http2ServerResponse;

export interface ProxyCoreOptions {
  upstream: ProxyUpstream;
  /** The protocol the caller speaks. Defaults to the upstream's. */
  face?: ProxyUpstream;
  /** Sent as `x-api-key` on an Anthropic upstream, replacing whatever the caller sent. */
  apiKey?: string | null;
  upstreamUrl: URL;
  region: string;
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  logPath: string;
  capUsd: number | null;
  /** Rates for models the eval's own table lacks, keyed as the model id appears on the wire. */
  rates: Record<string, Rates>;
  now?: () => number;
}

const BEDROCK_OPERATION = /^\/model\/([^/]+)\/(invoke|invoke-with-response-stream)$/;
const ANTHROPIC_MESSAGES = /^\/v1\/messages\/?$/;

// Headers that reach Bedrock. Everything else, above all the incoming
// signature, is dropped and the request re-signed.
const BEDROCK_REQUEST_HEADER = /^(content-type|accept|x-amzn-bedrock-.+)$/;
// Headers that reach the Anthropic API. The caller's credential is one of them.
const ANTHROPIC_REQUEST_HEADER = /^(content-type|accept|anthropic-version|anthropic-beta|x-api-key|authorization|x-stainless-.+|user-agent)$/;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "host"]);

/** A system-defined inference profile or foundation model ARN prices as its suffix. */
export const catalogModelOf = (modelId: string): string => {
  const match = /:(?:inference-profile|foundation-model)\/(.+)$/.exec(modelId);
  return match ? match[1] : modelId;
};

/** The Anthropic API id behind a Bedrock catalog id: `us.anthropic.claude-opus-5` is `claude-opus-5`. */
export const anthropicModelOf = (catalogId: string): string =>
  catalogId.replace(/^(?:us|eu|apac|global)\.anthropic\./, "").replace(/^anthropic\./, "").replace(/-v\d+:\d+$/, "");

// The Bedrock exception a client expects for each Anthropic error type, so a
// caller written against Bedrock's SDK retries and reports as it would there.
const BEDROCK_ERROR_TYPE: Record<string, string> = {
  invalid_request_error: "ValidationException",
  request_too_large: "ValidationException",
  authentication_error: "AccessDeniedException",
  permission_error: "AccessDeniedException",
  billing_error: "AccessDeniedException",
  not_found_error: "ResourceNotFoundException",
  rate_limit_error: "ThrottlingException",
  api_error: "InternalServerException",
  overloaded_error: "ServiceUnavailableException",
  timeout_error: "ModelTimeoutException",
};

const bedrockErrorOf = (status: number, body: string): { status: number; type: string; message: string } => {
  let type = "";
  let message = body;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const nested = json.error as Record<string, unknown> | undefined;
    type = String(nested?.type ?? "");
    message = String(nested?.message ?? json.message ?? body);
  } catch {}
  return {
    status: status === 529 ? 503 : status,
    type: BEDROCK_ERROR_TYPE[type] ?? (status >= 500 ? "InternalServerException" : "ValidationException"),
    message,
  };
};

const chunkFrame = (event: unknown): Buffer =>
  encodeFrame(
    { ":event-type": "chunk", ":content-type": "application/json", ":message-type": "event" },
    Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") })),
  );

const readBody = (req: Request): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const errorTypeOf = (header: string | string[] | undefined): string =>
  String(Array.isArray(header) ? header[0] : (header ?? "")).split(":")[0];

type RecordedFields = Pick<ProxyLogRecord, "outcome" | "status" | "error" | "response" | "usage">;

/**
 * Answers a Bedrock caller from an Anthropic response. A non-streaming body
 * is the same JSON on both, so it passes through under Bedrock's headers; an
 * error becomes Bedrock's `{message}` with the matching exception type; a
 * stream is re-framed event by event, pings dropped because Bedrock never
 * sends them, and the final event carries Bedrock's invocation metrics.
 */
const relayTranslated = (
  upstreamRes: http.IncomingMessage,
  res: Response,
  context: { status: number; requestId: string; streaming: boolean; startedAt: number },
  done: (fields: RecordedFields) => void,
): void => {
  const ok = context.status >= 200 && context.status < 300;
  const bedrockHeaders = { "x-amzn-requestid": context.requestId };
  let finished = false;
  const finish = (fields: RecordedFields) => {
    if (finished) return;
    finished = true;
    done(fields);
  };

  if (!ok || !context.streaming) {
    const chunks: Buffer[] = [];
    upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!ok) {
        const mapped = bedrockErrorOf(context.status, text);
        const body = JSON.stringify({ message: mapped.message });
        res.writeHead(mapped.status, {
          ...bedrockHeaders,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-amzn-errortype": mapped.type,
        });
        res.end(body);
        finish({
          outcome: "upstream_error",
          status: mapped.status,
          error: { type: mapped.type, message: mapped.message },
          response: { message: null, invocationMetrics: null, errorBody: text },
          usage: emptyUsage(),
        });
        return;
      }
      res.writeHead(200, { ...bedrockHeaders, "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
      let assembled: AssembledResponse | null = null;
      let error: { type: string; message: string } | null = null;
      try {
        assembled = assembleBody(text);
      } catch (parseError) {
        error = { type: "ProxyDecodeError", message: String(parseError) };
      }
      finish({
        outcome: "ok",
        status: 200,
        error,
        response: { message: assembled?.message ?? null, invocationMetrics: null, errorBody: null },
        usage: assembled?.usage ?? emptyUsage(),
      });
    });
    upstreamRes.on("error", () => {
      if (!res.headersSent) res.writeHead(502, bedrockHeaders);
      res.end();
      finish({
        outcome: "upstream_error",
        status: 502,
        error: { type: "InternalServerException", message: "the upstream connection failed before the response ended" },
        response: { message: null, invocationMetrics: null, errorBody: null },
        usage: emptyUsage(),
      });
    });
    return;
  }

  res.writeHead(200, { ...bedrockHeaders, "content-type": "application/vnd.amazon.eventstream" });
  const sse = new SseReader();
  const assembler = new StreamAssembler();
  let firstByteAt: number | null = null;
  let invocationMetrics: Record<string, number> | null = null;
  upstreamRes.on("data", (chunk: Buffer) => {
    firstByteAt ??= Date.now();
    for (const data of sse.push(chunk.toString("utf8"))) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === "ping") continue;
      assembler.addEvent(event);
      if (event.type === "error") {
        const error = (event.error ?? {}) as Record<string, unknown>;
        const type = BEDROCK_ERROR_TYPE[String(error.type)] ?? "InternalServerException";
        (res as http.ServerResponse).write(
          encodeFrame(
            { ":message-type": "exception", ":exception-type": type, ":content-type": "application/json" },
            Buffer.from(JSON.stringify({ message: String(error.message ?? "") })),
          ),
        );
        continue;
      }
      if (event.type === "message_stop") {
        const endAt = Date.now();
        invocationMetrics = {
          inputTokenCount: assembler.usage.input,
          outputTokenCount: assembler.usage.output,
          invocationLatency: endAt - context.startedAt,
          firstByteLatency: (firstByteAt ?? endAt) - context.startedAt,
        };
        event["amazon-bedrock-invocationMetrics"] = invocationMetrics;
      }
      (res as http.ServerResponse).write(chunkFrame(event));
    }
  });
  const end = (aborted: boolean) => {
    const assembled = assembler.result();
    let outcome: ProxyOutcome = "ok";
    let error: { type: string; message: string } | null = null;
    if (assembled.exception) {
      outcome = "stream_exception";
      error = assembled.exception;
    }
    if (aborted) {
      outcome = "client_aborted";
      error ??= { type: "ClientAborted", message: "the caller closed the connection before the response ended" };
    }
    finish({
      outcome,
      status: 200,
      error,
      response: { message: assembled.message, invocationMetrics, errorBody: null },
      usage: assembled.usage,
    });
  };
  upstreamRes.on("end", () => {
    res.end();
    end(false);
  });
  upstreamRes.on("error", () => {
    res.destroy();
    end(true);
  });
  res.on("close", () => {
    if (!res.writableFinished) end(true);
  });
};

export const createProxyCore = (options: ProxyCoreOptions) => {
  const now = options.now ?? Date.now;
  const face: ProxyUpstream = options.face ?? options.upstream;
  const translate = face === "bedrock" && options.upstream === "anthropic";
  const signer = new SignatureV4({
    service: "bedrock",
    region: options.region,
    credentials: options.credentials,
    sha256: Hash.bind(null, "sha256"),
  });

  let seq = 0;
  let spendUsd = 0;
  let requests = 0;

  mkdirSync(dirname(options.logPath), { recursive: true });
  if (!existsSync(options.logPath)) writeFileSync(options.logPath, "");

  const ratesFor = (model: string): Rates | null => options.rates[model] ?? PRICE_TABLE[model] ?? null;

  const record = (entry: Omit<ProxyLogRecord, "v" | "endedAt" | "spendUsdAfter" | "capUsd" | "cost"> & { cost?: ProxyCost }): void => {
    const cost = entry.cost ?? zeroCost();
    spendUsd += cost.total;
    const line: ProxyLogRecord = {
      v: 1,
      ...entry,
      cost,
      endedAt: now(),
      spendUsdAfter: spendUsd,
      capUsd: options.capUsd,
    };
    appendFileSync(options.logPath, `${JSON.stringify(line)}\n`);
  };

  const sendError = (res: Response, status: number, type: string, message: string, requestId: string): void => {
    const body =
      face === "bedrock"
        ? JSON.stringify({ message })
        : JSON.stringify({ type: "error", error: { type, message }, request_id: requestId });
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(face === "bedrock" ? { "x-amzn-errortype": type, "x-amzn-requestid": requestId } : { "request-id": requestId }),
    });
    res.end(body);
  };

  const handle = async (req: Request, res: Response): Promise<void> => {
    const startedAt = now();
    const mySeq = ++seq;
    requests += 1;
    const localId = randomUUID();
    const url = new URL(req.url ?? "/", "http://proxy");
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      parsed = body.toString("utf8");
    }

    let operation: ProxyOperation = "unknown";
    let modelId = "";
    if (face === "bedrock") {
      const match = BEDROCK_OPERATION.exec(url.pathname);
      if (match) {
        modelId = decodeURIComponent(match[1]);
        operation = match[2] as ProxyOperation;
      }
    } else if (ANTHROPIC_MESSAGES.test(url.pathname)) {
      operation = "messages";
      const model = (parsed as Record<string, unknown> | null)?.model;
      modelId = typeof model === "string" ? model : "";
    }
    const catalog = catalogModelOf(modelId);
    const model = translate ? anthropicModelOf(catalog) : catalog;
    const rates = ratesFor(model);
    const streaming =
      face === "bedrock"
        ? operation === "invoke-with-response-stream"
        : (parsed as Record<string, unknown> | null)?.stream === true;

    const base = {
      seq: mySeq,
      startedAt,
      upstream: options.upstream,
      operation,
      modelId,
      request: parsed,
    };
    const refuse = (status: number, type: string, message: string, outcome: ProxyOutcome) => {
      sendError(res, status, type, message, localId);
      record({
        ...base,
        requestId: localId,
        model: outcome === "refused" ? "" : model,
        priced: rates !== null,
        outcome,
        status,
        error: { type, message },
        response: { message: null, invocationMetrics: null, errorBody: null },
        usage: emptyUsage(),
      });
    };

    try {
      if (req.method !== "POST" || operation === "unknown") {
        refuse(
          404,
          face === "bedrock" ? "UnknownOperationException" : "not_found_error",
          `the eval model proxy forwards only model calls, not ${req.method} ${url.pathname}`,
          "refused",
        );
        return;
      }
      if (rates === null && options.capUsd !== null) {
        refuse(
          400,
          face === "bedrock" ? "ValidationException" : "invalid_request_error",
          `the eval model proxy has no price for model ${JSON.stringify(model)}, so it cannot hold the cap and will not forward the request`,
          "refused",
        );
        return;
      }
      if (options.capUsd !== null && spendUsd >= options.capUsd) {
        refuse(
          402,
          face === "bedrock" ? "PaymentRequiredException" : "eval_cap_exceeded",
          `the eval model cap of $${options.capUsd.toFixed(2)} is spent: $${spendUsd.toFixed(2)}`,
          "cap_exceeded",
        );
        return;
      }

      const basePath = options.upstreamUrl.pathname.replace(/\/$/, "");
      const rawPath = (req.url ?? "/").split("?")[0];
      let path = `${basePath}${rawPath}${url.search}`;
      let outBody = body;
      const headers: Record<string, string> = { host: options.upstreamUrl.host };
      if (translate) {
        const json = parsed && typeof parsed === "object" ? { ...(parsed as Record<string, unknown>) } : {};
        const beta = json.anthropic_beta;
        delete json.anthropic_version;
        delete json.anthropic_beta;
        json.model = model;
        if (streaming) json.stream = true;
        outBody = Buffer.from(JSON.stringify(json));
        headers["content-type"] = "application/json";
        headers.accept = streaming ? "text/event-stream" : "application/json";
        headers["anthropic-version"] = "2023-06-01";
        if (beta !== undefined) headers["anthropic-beta"] = Array.isArray(beta) ? beta.map(String).join(",") : String(beta);
        path = `${basePath}/v1/messages`;
      } else {
        const allowed = options.upstream === "bedrock" ? BEDROCK_REQUEST_HEADER : ANTHROPIC_REQUEST_HEADER;
        for (const [name, value] of Object.entries(req.headers)) {
          if (allowed.test(name) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(",") : value;
        }
      }
      if (options.upstream === "anthropic" && options.apiKey) {
        delete headers.authorization;
        headers["x-api-key"] = options.apiKey;
      }
      headers["content-length"] = String(outBody.length);

      let outHeaders: Record<string, string> = headers;
      if (options.upstream === "bedrock") {
        const query: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          query[key] = value;
        });
        const signed = await signer.sign(
          new HttpRequest({
            method: "POST",
            protocol: options.upstreamUrl.protocol,
            hostname: options.upstreamUrl.hostname,
            port: options.upstreamUrl.port ? Number(options.upstreamUrl.port) : undefined,
            path: `${basePath}${rawPath}`,
            query,
            headers,
            body: outBody,
          }),
        );
        outHeaders = signed.headers;
      }

      const transport = options.upstreamUrl.protocol === "https:" ? https : http;
      await new Promise<void>((resolve) => {
        const upstreamReq = transport.request(
          {
            method: "POST",
            protocol: options.upstreamUrl.protocol,
            hostname: options.upstreamUrl.hostname,
            port: options.upstreamUrl.port || undefined,
            path,
            headers: outHeaders,
          },
          (upstreamRes) => {
            const status = upstreamRes.statusCode ?? 502;
            const requestId = String(upstreamRes.headers["x-amzn-requestid"] ?? upstreamRes.headers["request-id"] ?? localId);
            if (translate) {
              relayTranslated(upstreamRes, res, { status, requestId, streaming, startedAt }, (fields) => {
                record({ ...base, requestId, model, priced: rates !== null, ...fields, cost: rates ? priceUsage(rates, fields.usage) : zeroCost() });
                resolve();
              });
              res.on("close", () => {
                if (!res.writableFinished) upstreamReq.destroy();
              });
              return;
            }
            const responseHeaders: Record<string, string | string[]> = {};
            for (const [name, value] of Object.entries(upstreamRes.headers)) {
              if (!HOP_BY_HOP.has(name) && value !== undefined) responseHeaders[name] = value;
            }
            res.writeHead(status, responseHeaders);

            const ok = status >= 200 && status < 300;
            const reader = new FrameReader();
            const assembler = new StreamAssembler();
            const buffered: Buffer[] = [];
            let decodeError: string | null = null;
            let finished = false;

            upstreamRes.on("data", (chunk: Buffer) => {
              (res as http.ServerResponse).write(chunk);
              if (!(ok && streaming)) {
                buffered.push(chunk);
                return;
              }
              if (decodeError) return;
              try {
                if (options.upstream === "bedrock") {
                  for (const frame of reader.push(chunk)) assembler.addFrame(frame);
                } else {
                  assembler.addSse(chunk.toString("utf8"));
                }
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
              if (ok && streaming) {
                assembled = assembler.result();
                if (assembled.exception) {
                  outcome = "stream_exception";
                  error = assembled.exception;
                } else if (decodeError) {
                  error = { type: "ProxyDecodeError", message: decodeError };
                }
              } else if (ok) {
                try {
                  assembled = assembleBody(Buffer.concat(buffered).toString("utf8"));
                } catch (parseError) {
                  error = { type: "ProxyDecodeError", message: String(parseError) };
                }
              } else {
                outcome = "upstream_error";
                errorBody = Buffer.concat(buffered).toString("utf8");
                let message = errorBody;
                let type = errorTypeOf(upstreamRes.headers["x-amzn-errortype"]);
                try {
                  const json = JSON.parse(errorBody) as Record<string, unknown>;
                  const nested = json.error as Record<string, unknown> | undefined;
                  message = String(nested?.message ?? json.message ?? json.Message ?? errorBody);
                  type ||= String(nested?.type ?? "");
                } catch {}
                error = { type: type || `HTTP${status}`, message };
              }
              if (aborted) {
                outcome = "client_aborted";
                error ??= { type: "ClientAborted", message: "the caller closed the connection before the response ended" };
              }
              const usage = assembled?.usage ?? emptyUsage();
              record({
                ...base,
                requestId,
                model,
                priced: rates !== null,
                outcome,
                status,
                error,
                response: {
                  message: assembled?.message ?? null,
                  invocationMetrics: assembled?.invocationMetrics ?? null,
                  errorBody,
                },
                usage,
                cost: rates ? priceUsage(rates, usage) : zeroCost(),
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
            face === "bedrock" ? "ServiceUnavailableException" : "api_error",
            `the eval model proxy could not reach ${options.upstreamUrl.host}: ${String(error)}`,
            "upstream_unreachable",
          );
          resolve();
        });
        upstreamReq.end(outBody);
      });
    } catch (error) {
      if (res.headersSent) return;
      refuse(
        503,
        face === "bedrock" ? "ServiceUnavailableException" : "api_error",
        `the eval model proxy could not sign or send the request: ${String(error)}`,
        "upstream_unreachable",
      );
    }
  };

  return {
    handle,
    spentUsd: () => spendUsd,
    requests: () => requests,
  };
};
