import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";

import { parseProxyLog, type ProxyLogRecord } from "../../core/adapters/proxy-log";
import { modelProxyEnv, startModelProxy, type ModelProxy, type ModelProxyOptions } from "./index";

const BEDROCK_MODEL = "us.anthropic.claude-opus-5";
const ANTHROPIC_MODEL = "claude-opus-5-5";
const ANTHROPIC_RATES = { input: 4 / 1e6, output: 20 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite5m: 5 / 1e6, cacheWrite1h: 8 / 1e6 };
const PROXY_CREDS = { accessKeyId: "AKIDPROXYREAL", secretAccessKey: "proxy-secret" };
const FAKE_CREDS = { accessKeyId: "AKIDBUGBOSSFAKE", secretAccessKey: "fake-secret" };
const codec = new EventStreamCodec(toUtf8, fromUtf8);

const EVENTS = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 200_000,
        cache_creation: { ephemeral_1h_input_tokens: 200_000, ephemeral_5m_input_tokens: 0 },
      },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "look at " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "the pool" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig==" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "bash", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"comm' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'and":"ls"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100_000 } },
  { type: "message_stop" },
];

const ASSEMBLED_CONTENT = [
  { type: "thinking", thinking: "look at the pool", signature: "sig==" },
  { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
];

// 10*5.5 + 100000*27.5 + 1e6*0.55 + 200000*11, per million.
const BEDROCK_USD = (10 * 5.5 + 100_000 * 27.5 + 1_000_000 * 0.55 + 200_000 * 11) / 1e6;
const ANTHROPIC_USD = (10 * 4 + 100_000 * 20 + 1_000_000 * 0.2 + 200_000 * 8) / 1e6;

const REQUEST_BODY = {
  anthropic_version: "bedrock-2023-05-31",
  max_tokens: 1000,
  system: [{ type: "text", text: "You are the incident agent.", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{ name: "bash", description: "run", input_schema: { type: "object", properties: {}, required: [] } }],
  messages: [{ role: "user", content: [{ type: "text", text: "investigate" }] }],
};

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const servers: http.Server[] = [];
const proxies: ModelProxy[] = [];
after(async () => {
  for (const server of servers) server.close();
  for (const proxy of proxies) await proxy.close();
});

const listen = async (server: http.Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

const verifySignature = async (seen: Seen, port: number): Promise<boolean> => {
  const auth = String(seen.headers.authorization ?? "");
  const signedNames = /SignedHeaders=([^,]+)/.exec(auth)?.[1].split(";") ?? [];
  const headers: Record<string, string> = {};
  for (const name of signedNames) headers[name] = String(seen.headers[name]);
  const amzDate = String(seen.headers["x-amz-date"]);
  const signingDate = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  const signer = new SignatureV4({ service: "bedrock", region: "us-west-2", credentials: PROXY_CREDS, sha256: Hash.bind(null, "sha256") });
  const resigned = await signer.sign(
    new HttpRequest({ method: seen.method, protocol: "http:", hostname: "127.0.0.1", port, path: seen.path, headers, body: seen.body }),
    { signingDate },
  );
  return resigned.headers.authorization === auth;
};

const startStack = async (upstream: "bedrock" | "anthropic", reply: (req: Seen, res: http.ServerResponse) => void, extra: Partial<ModelProxyOptions> = {}) => {
  const seen: Seen[] = [];
  const upstreamServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      reply(entry, res);
    });
  });
  const upstreamPort = await listen(upstreamServer);
  const logPath = join(mkdtempSync(join(tmpdir(), "model-proxy-")), "nested", "proxy.jsonl");
  const proxy = await startModelProxy({
    upstream,
    region: "us-west-2",
    credentials: PROXY_CREDS,
    upstreamUrl: new URL(`http://127.0.0.1:${upstreamPort}`),
    logPath,
    rates: { [ANTHROPIC_MODEL]: ANTHROPIC_RATES },
    ...extra,
  });
  proxies.push(proxy);
  const log = (): ProxyLogRecord[] =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProxyLogRecord);
  return { seen, proxy, log, logPath, upstreamPort };
};

const bedrockClient = (proxy: ModelProxy) =>
  new BedrockRuntimeClient({
    endpoint: modelProxyEnv(proxy, "bedrock").AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
    region: "us-west-2",
    credentials: FAKE_CREDS,
    maxAttempts: 1,
  });

const chunkFrame = (event: object): Uint8Array =>
  codec.encode({
    headers: {
      ":event-type": { type: "string", value: "chunk" },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: fromUtf8(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") })),
  });

const bedrockStream = (): Buffer =>
  Buffer.concat(
    EVENTS.map((event, i) =>
      chunkFrame(
        i === EVENTS.length - 1
          ? { ...event, "amazon-bedrock-invocationMetrics": { inputTokenCount: 10, outputTokenCount: 100_000, invocationLatency: 1200, firstByteLatency: 300 } }
          : event,
      ),
    ),
  );

// Split at awkward offsets so frames and SSE events straddle chunk boundaries.
const writeInPieces = (res: http.ServerResponse, status: number, headers: Record<string, string>, bytes: Buffer) => {
  res.writeHead(status, headers);
  for (let offset = 0; offset < bytes.length; offset += 37) res.write(bytes.subarray(offset, offset + 37));
  res.end();
};

const streamCommand = (modelId = BEDROCK_MODEL) =>
  new InvokeModelWithResponseStreamCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(JSON.stringify(REQUEST_BODY)),
  });

const readEvents = async (response: { body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> }) => {
  const events: unknown[] = [];
  for await (const item of response.body ?? []) {
    if (item.chunk?.bytes) events.push(JSON.parse(new TextDecoder().decode(item.chunk.bytes)));
  }
  return events;
};

test("bedrock: the SDK sees the stream unchanged, re-signed with the proxy's credentials, logged and priced", async () => {
  const stack = await startStack("bedrock", (_req, res) =>
    writeInPieces(res, 200, { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "req-upstream-1" }, bedrockStream()),
  );
  const events = await readEvents(await bedrockClient(stack.proxy).send(streamCommand()));
  assert.equal(events.length, EVENTS.length);
  assert.deepEqual(events.slice(0, -1), EVENTS.slice(0, -1));

  const [upstream] = stack.seen;
  assert.equal(upstream.path, `/model/${BEDROCK_MODEL}/invoke-with-response-stream`);
  assert.match(String(upstream.headers.authorization), /Credential=AKIDPROXYREAL\//);
  assert.doesNotMatch(JSON.stringify(upstream.headers), /AKIDBUGBOSSFAKE/);
  assert.equal(await verifySignature(upstream, stack.upstreamPort), true);
  assert.deepEqual(JSON.parse(upstream.body.toString("utf8")), REQUEST_BODY);

  assert.equal(stack.proxy.requests(), 1);
  assert.ok(Math.abs(stack.proxy.spentUsd() - BEDROCK_USD) < 1e-9);
  const [record] = stack.log();
  assert.equal(record.upstream, "bedrock");
  assert.equal(record.operation, "invoke-with-response-stream");
  assert.equal(record.outcome, "ok");
  assert.equal(record.priced, true);
  assert.equal(record.requestId, "req-upstream-1");
  assert.equal(record.model, BEDROCK_MODEL);
  assert.equal(record.response.message?.stopReason, "tool_use");
  assert.deepEqual(record.response.message?.content, ASSEMBLED_CONTENT);
  assert.equal(record.response.invocationMetrics?.invocationLatency, 1200);
  assert.equal(record.usage.split, true);
  assert.equal(record.capUsd, null);

  const trace = parseProxyLog(readFileSync(stack.logPath, "utf8"));
  assert.equal(trace.turns[0].toolCalls[0].args.command, "ls");
  assert.ok(Math.abs(trace.turns[0].usage.cost.total - BEDROCK_USD) < 1e-9);
});

test("bedrock: non-streaming InvokeModel is forwarded and priced, and an inference profile ARN prices as its catalog id", async () => {
  const stack = await startStack("bedrock", (_req, res) => {
    const body = JSON.stringify({
      id: "msg_2",
      model: "claude-opus-5",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    res.writeHead(200, { "content-type": "application/json", "x-amzn-requestid": "req-2" });
    res.end(body);
  });
  const arn = `arn:aws:bedrock:us-west-2:123456789012:inference-profile/${BEDROCK_MODEL}`;
  const response = await bedrockClient(stack.proxy).send(
    new InvokeModelCommand({ modelId: arn, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(REQUEST_BODY)) }),
  );
  assert.equal(JSON.parse(new TextDecoder().decode(response.body)).id, "msg_2");
  assert.equal(decodeURIComponent(stack.seen[0].path), `/model/${arn}/invoke`);
  const [record] = stack.log();
  assert.equal(record.operation, "invoke");
  assert.equal(record.modelId, arn);
  assert.equal(record.model, BEDROCK_MODEL);
  assert.ok(Math.abs(record.cost.total - (1000 * 5.5 + 10 * 27.5) / 1e6) < 1e-12);
});

test("bedrock: at the cap the proxy answers 402 without calling upstream, and an unpriced model is refused", async () => {
  const stack = await startStack(
    "bedrock",
    (_req, res) => writeInPieces(res, 200, { "content-type": "application/vnd.amazon.eventstream" }, bedrockStream()),
    { capUsd: 1 },
  );
  const client = bedrockClient(stack.proxy);
  await readEvents(await client.send(streamCommand()));
  await assert.rejects(client.send(streamCommand()), (error: Error) => {
    assert.equal(error.name, "PaymentRequiredException");
    assert.equal((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode, 402);
    return true;
  });
  assert.equal(stack.seen.length, 1);
  assert.equal(stack.log()[1].outcome, "cap_exceeded");
  assert.equal(stack.log()[1].capUsd, 1);

  await assert.rejects(
    client.send(streamCommand("arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123")),
    (error: Error) => error.name === "ValidationException" && /no price/.test(error.message),
  );
  assert.equal(stack.seen.length, 1);
  assert.equal(stack.log()[2].outcome, "refused");
});

test("bedrock: an upstream error passes through with its type and bills nothing", async () => {
  const stack = await startStack("bedrock", (_req, res) => {
    res.writeHead(400, {
      "content-type": "application/json",
      "x-amzn-errortype": "ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/",
      "x-amzn-requestid": "req-bad",
    });
    res.end(JSON.stringify({ message: "thinking.adaptive.block_binding: Extra inputs are not permitted" }));
  });
  await assert.rejects(
    bedrockClient(stack.proxy).send(streamCommand()),
    (error: Error) => error.name === "ValidationException" && /block_binding/.test(error.message),
  );
  const [record] = stack.log();
  assert.equal(record.outcome, "upstream_error");
  assert.equal(record.error?.type, "ValidationException");
  assert.match(String(record.response.errorBody), /block_binding/);
  assert.equal(record.cost.total, 0);
  assert.equal(stack.proxy.spentUsd(), 0);
});

const sse = (events: object[]): Buffer =>
  Buffer.from(events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));

const anthropicHeaders = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-test" };
const anthropicBody = (stream: boolean) => ({ ...REQUEST_BODY, anthropic_version: undefined, model: ANTHROPIC_MODEL, stream });

test("anthropic: a streamed /v1/messages call is relayed byte for byte, its tool_use assembled, logged and priced", async () => {
  const bytes = sse(EVENTS);
  const stack = await startStack("anthropic", (_req, res) =>
    writeInPieces(res, 200, { "content-type": "text/event-stream", "request-id": "req_abc" }, bytes),
  );
  const base = modelProxyEnv(stack.proxy, "anthropic").ANTHROPIC_BASE_URL;
  const response = await fetch(`${base}/v1/messages`, { method: "POST", headers: anthropicHeaders, body: JSON.stringify(anthropicBody(true)) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const received = Buffer.from(await response.arrayBuffer());
  assert.equal(Buffer.compare(received, bytes), 0);

  const [upstream] = stack.seen;
  assert.equal(upstream.path, "/v1/messages");
  assert.equal(upstream.headers["x-api-key"], "sk-ant-test");
  assert.equal(upstream.headers["anthropic-version"], "2023-06-01");
  assert.equal(JSON.parse(upstream.body.toString("utf8")).model, ANTHROPIC_MODEL);

  const [record] = stack.log();
  assert.equal(record.upstream, "anthropic");
  assert.equal(record.operation, "messages");
  assert.equal(record.outcome, "ok");
  assert.equal(record.requestId, "req_abc");
  assert.equal(record.modelId, ANTHROPIC_MODEL);
  assert.equal(record.priced, true);
  assert.deepEqual(record.response.message?.content, ASSEMBLED_CONTENT);
  assert.equal(record.response.message?.stopReason, "tool_use");
  assert.equal(record.response.invocationMetrics, null);
  assert.ok(Math.abs(record.cost.total - ANTHROPIC_USD) < 1e-9);
  assert.ok(Math.abs(stack.proxy.spentUsd() - ANTHROPIC_USD) < 1e-9);

  const trace = parseProxyLog(readFileSync(stack.logPath, "utf8"));
  assert.deepEqual(trace.turns[0].toolCalls, [{ id: "tu_1", name: "bash", args: { command: "ls" } }]);
  assert.equal(trace.turns[0].cacheTtl, "1h");
});

test("anthropic: a non-streaming call, then the cap, then a model with no price", async () => {
  const stack = await startStack(
    "anthropic",
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_2" });
      res.end(
        JSON.stringify({
          id: "msg_3",
          model: ANTHROPIC_MODEL,
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1000, output_tokens: 10 },
        }),
      );
    },
    { capUsd: 0.001 },
  );
  const base = modelProxyEnv(stack.proxy, "anthropic").ANTHROPIC_BASE_URL;
  const post = (body: object) => fetch(`${base}/v1/messages`, { method: "POST", headers: anthropicHeaders, body: JSON.stringify(body) });

  const first = await post(anthropicBody(false));
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { id: string }).id, "msg_3");
  assert.ok(Math.abs(stack.proxy.spentUsd() - (1000 * 4 + 10 * 20) / 1e6) < 1e-12);

  const capped = await post(anthropicBody(false));
  assert.equal(capped.status, 402);
  const error = (await capped.json()) as { type: string; error: { type: string; message: string } };
  assert.equal(error.type, "error");
  assert.equal(error.error.type, "eval_cap_exceeded");
  assert.match(error.error.message, /cap of \$0\.00/);

  const unpriced = await post({ ...anthropicBody(false), model: "claude-haiku-4-5" });
  assert.equal(unpriced.status, 400);
  assert.equal(stack.seen.length, 1);
  assert.deepEqual(
    stack.log().map((record) => record.outcome),
    ["ok", "cap_exceeded", "refused"],
  );
});

test("anthropic: without a cap an unpriced model is forwarded and recorded as unpriced", async () => {
  const stack = await startStack("anthropic", (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", model: "claude-haiku-4-5", content: [], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }));
  });
  const base = modelProxyEnv(stack.proxy, "anthropic").ANTHROPIC_BASE_URL;
  const res = await fetch(`${base}/v1/messages`, { method: "POST", headers: anthropicHeaders, body: JSON.stringify({ ...anthropicBody(false), model: "claude-haiku-4-5" }) });
  assert.equal(res.status, 200);
  const [record] = stack.log();
  assert.equal(record.priced, false);
  assert.equal(record.cost.total, 0);
  assert.equal(record.usage.input, 5);
  assert.equal(stack.proxy.requests(), 1);
});

test("the wrong face is refused: HTTP/1.1 to a bedrock proxy never reaches upstream, and an unknown path is 404", async () => {
  const stack = await startStack("anthropic", (_req, res) => res.end());
  const res = await fetch(`${stack.proxy.url}/model/x/invoke`, { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
  assert.equal(stack.seen.length, 0);
  assert.equal(stack.log()[0].outcome, "refused");

  const bedrock = await startStack("bedrock", (_req, res) => res.end());
  const session = http2.connect(bedrock.proxy.url);
  const status = await new Promise<number>((resolve) => {
    const req = session.request({ ":method": "GET", ":path": "/v1/messages" });
    req.on("response", (headers) => resolve(Number(headers[":status"])));
    req.resume();
    req.end();
  });
  session.close();
  assert.equal(status, 404);
  assert.equal(bedrock.seen.length, 0);
});
