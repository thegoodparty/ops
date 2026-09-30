import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";

import { parseProxyLog, type ProxyLogRecord } from "../../core/adapters/proxy-log";
import { createModelProxy, type ProxyState } from "./bedrock";
import { FrameReader } from "./eventstream";

const MODEL = "us.anthropic.claude-opus-5";
const PROXY_CREDS = { accessKeyId: "AKIDPROXYREAL", secretAccessKey: "proxy-secret" };
const FAKE_CREDS = { accessKeyId: "AKIDBUGBOSSFAKE", secretAccessKey: "fake-secret" };
const codec = new EventStreamCodec(toUtf8, fromUtf8);

const chunkFrame = (event: object): Uint8Array =>
  codec.encode({
    headers: {
      ":event-type": { type: "string", value: "chunk" },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: fromUtf8(
      JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") }),
    ),
  });

const exceptionFrame = (type: string, message: string): Uint8Array =>
  codec.encode({
    headers: {
      ":exception-type": { type: "string", value: type },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "exception" },
    },
    body: fromUtf8(JSON.stringify({ message })),
  });

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
  {
    type: "message_stop",
    "amazon-bedrock-invocationMetrics": {
      inputTokenCount: 10,
      outputTokenCount: 100_000,
      invocationLatency: 1200,
      firstByteLatency: 300,
    },
  },
];

// 10*5.5 + 100000*27.5 + 1e6*0.55 + 200000*11, per million.
const EXPECTED_USD = (10 * 5.5 + 100_000 * 27.5 + 1_000_000 * 0.55 + 200_000 * 11) / 1e6;

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  signatureValid: boolean;
}

type Reply = (req: Seen, res: http.ServerResponse) => void;

const servers: Array<http.Server | http2.Http2Server> = [];
after(() => {
  for (const server of servers) server.close();
});

const listen = async (server: http.Server | http2.Http2Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

const verifySignature = async (
  seen: Omit<Seen, "signatureValid">,
  port: number,
): Promise<boolean> => {
  const auth = String(seen.headers.authorization ?? "");
  const signedNames = /SignedHeaders=([^,]+)/.exec(auth)?.[1].split(";") ?? [];
  const headers: Record<string, string> = {};
  for (const name of signedNames) headers[name] = String(seen.headers[name]);
  const amzDate = String(seen.headers["x-amz-date"]);
  const signingDate = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  const signer = new SignatureV4({
    service: "bedrock",
    region: "us-west-2",
    credentials: PROXY_CREDS,
    sha256: Hash.bind(null, "sha256"),
  });
  const resigned = await signer.sign(
    new HttpRequest({
      method: seen.method,
      protocol: "http:",
      hostname: "127.0.0.1",
      port,
      path: seen.path,
      headers,
      body: seen.body,
    }),
    { signingDate },
  );
  return resigned.headers.authorization === auth;
};

const startStack = async (reply: Reply, budgetUsd = 100, controlToken?: string) => {
  const seen: Seen[] = [];
  let upstreamPort = 0;
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const partial = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      const entry = { ...partial, signatureValid: await verifySignature(partial, upstreamPort) };
      seen.push(entry);
      reply(entry, res);
    });
  });
  upstreamPort = await listen(upstream);

  const tracePath = join(mkdtempSync(join(tmpdir(), "proxy-")), "trace.jsonl");
  const proxy = createModelProxy({
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
    region: "us-west-2",
    credentials: PROXY_CREDS,
    budgetUsd,
    tracePath,
    controlToken,
  });
  const proxyPort = await listen(http2.createServer((req, res) => void proxy.handle(req, res)));
  const controlPort = await listen(http.createServer((req, res) => proxy.handleControl(req, res)));
  const client = new BedrockRuntimeClient({
    endpoint: `http://127.0.0.1:${proxyPort}`,
    region: "us-west-2",
    credentials: FAKE_CREDS,
    maxAttempts: 1,
  });
  const control = async (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${controlPort}${path}`, init);
  const state = async (): Promise<ProxyState> => {
    const res = await control("/__control/state", {
      headers: controlToken ? { authorization: `Bearer ${controlToken}` } : {},
    });
    return (await res.json()) as ProxyState;
  };
  const log = (): ProxyLogRecord[] =>
    readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProxyLogRecord);
  return { seen, client, state, control, log, tracePath, proxyPort };
};

const streamBytes = (): Buffer => Buffer.concat(EVENTS.map((event) => chunkFrame(event)));

// Split at awkward offsets so frames straddle chunk boundaries.
const writeInPieces = (res: http.ServerResponse, bytes: Buffer, done = true) => {
  res.writeHead(200, {
    "content-type": "application/vnd.amazon.eventstream",
    "x-amzn-requestid": "req-upstream-1",
    "x-amzn-bedrock-content-type": "application/json",
  });
  for (let offset = 0; offset < bytes.length; offset += 37) {
    res.write(bytes.subarray(offset, offset + 37));
  }
  if (done) res.end();
};

const REQUEST_BODY = {
  anthropic_version: "bedrock-2023-05-31",
  max_tokens: 1000,
  system: [{ type: "text", text: "You are the incident agent.", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{ name: "bash", description: "run", input_schema: { type: "object", properties: {}, required: [] } }],
  messages: [{ role: "user", content: [{ type: "text", text: "investigate" }] }],
};

const streamCommand = (modelId = MODEL, body: object = REQUEST_BODY) =>
  new InvokeModelWithResponseStreamCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(JSON.stringify(body)),
  });

const readEvents = async (response: { body?: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> }) => {
  const events: unknown[] = [];
  for await (const item of response.body ?? []) {
    if (item.chunk?.bytes) events.push(JSON.parse(new TextDecoder().decode(item.chunk.bytes)));
  }
  return events;
};

test("the SDK sees the upstream stream unchanged, re-signed with the proxy's credentials", async () => {
  const stack = await startStack((_req, res) => writeInPieces(res, streamBytes()));
  const response = await stack.client.send(streamCommand());
  assert.deepEqual(await readEvents(response), EVENTS);

  const [upstream] = stack.seen;
  assert.equal(upstream.path, `/model/${MODEL}/invoke-with-response-stream`);
  assert.match(String(upstream.headers.authorization), /Credential=AKIDPROXYREAL\//);
  assert.doesNotMatch(JSON.stringify(upstream.headers), /AKIDBUGBOSSFAKE/);
  assert.equal(upstream.signatureValid, true);
  assert.deepEqual(JSON.parse(upstream.body.toString("utf8")), REQUEST_BODY);
});

test("the bytes relayed are the bytes upstream sent", async () => {
  const bytes = streamBytes();
  const stack = await startStack((_req, res) => writeInPieces(res, bytes));
  const session = http2.connect(`http://127.0.0.1:${stack.proxyPort}`);
  const received = await new Promise<Buffer>((resolve, reject) => {
    const req = session.request({
      ":method": "POST",
      ":path": `/model/${MODEL}/invoke-with-response-stream`,
      "content-type": "application/json",
    });
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.end(JSON.stringify(REQUEST_BODY));
  });
  session.close();
  assert.equal(Buffer.compare(received, bytes), 0);
});

test("an exchange is logged, priced from the price table, and counted as a turn", async () => {
  const stack = await startStack((_req, res) => writeInPieces(res, streamBytes()));
  await readEvents(await stack.client.send(streamCommand()));

  const state = await stack.state();
  assert.equal(state.turns, 1);
  assert.equal(state.requests, 1);
  assert.equal(state.inFlight, 0);
  assert.ok(Math.abs(state.spendUsd - EXPECTED_USD) < 1e-9);
  assert.equal(state.byModel[MODEL].turns, 1);
  assert.equal(state.tokens.cacheWrite1h, 200_000);

  const [record] = stack.log();
  assert.equal(record.outcome, "ok");
  assert.equal(record.requestId, "req-upstream-1");
  assert.equal(record.model, MODEL);
  assert.deepEqual(record.request, REQUEST_BODY);
  assert.equal(record.response.message?.stopReason, "tool_use");
  assert.deepEqual(record.response.message?.content, [
    { type: "thinking", thinking: "look at the pool", signature: "sig==" },
    { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
  ]);
  assert.equal(record.response.invocationMetrics?.invocationLatency, 1200);
  assert.equal(record.usage.split, true);

  const [trace] = parseProxyLog(readFileSync(stack.tracePath, "utf8"));
  assert.equal(trace.turns[0].toolCalls[0].args.command, "ls");
  assert.ok(Math.abs(trace.turns[0].usage.cost.total - EXPECTED_USD) < 1e-9);
});

test("at the budget the proxy answers ThrottlingException without calling upstream", async () => {
  const stack = await startStack((_req, res) => writeInPieces(res, streamBytes()), 1);
  await readEvents(await stack.client.send(streamCommand()));
  assert.equal((await stack.state()).overBudget, true);

  await assert.rejects(stack.client.send(streamCommand()), (error: Error) => {
    assert.equal(error.name, "ThrottlingException");
    assert.equal((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode, 429);
    return true;
  });
  assert.equal(stack.seen.length, 1);
  const state = await stack.state();
  assert.equal(state.turns, 1);
  assert.equal(state.outcomes.budget_throttled, 1);
  assert.ok(Math.abs(state.spendUsd - EXPECTED_USD) < 1e-9);
  assert.equal(stack.log()[1].outcome, "budget_throttled");
});

test("a model with no price is refused and never forwarded", async () => {
  const stack = await startStack((_req, res) => writeInPieces(res, streamBytes()));
  await assert.rejects(
    stack.client.send(
      streamCommand("arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123"),
    ),
    (error: Error) => error.name === "ValidationException" && /no price/.test(error.message),
  );
  assert.equal(stack.seen.length, 0);
  assert.equal((await stack.state()).outcomes.refused, 1);
});

test("a system inference profile ARN prices as its catalog id and goes upstream as sent", async () => {
  const stack = await startStack((_req, res) => writeInPieces(res, streamBytes()));
  const arn = `arn:aws:bedrock:us-west-2:123456789012:inference-profile/${MODEL}`;
  await readEvents(await stack.client.send(streamCommand(arn)));
  assert.equal(decodeURIComponent(stack.seen[0].path), `/model/${arn}/invoke-with-response-stream`);
  assert.equal(stack.seen[0].signatureValid, true);
  assert.equal(stack.log()[0].model, MODEL);
  assert.equal(stack.log()[0].modelId, arn);
});

test("an upstream error passes through with its type and is logged", async () => {
  const stack = await startStack((_req, res) => {
    const body = JSON.stringify({ message: "thinking.adaptive.block_binding: Extra inputs are not permitted" });
    res.writeHead(400, {
      "content-type": "application/json",
      "x-amzn-errortype": "ValidationException:http://internal.amazon.com/coral/com.amazon.bedrock/",
      "x-amzn-requestid": "req-bad",
    });
    res.end(body);
  });
  await assert.rejects(
    stack.client.send(streamCommand()),
    (error: Error) => error.name === "ValidationException" && /block_binding/.test(error.message),
  );
  const [record] = stack.log();
  assert.equal(record.outcome, "upstream_error");
  assert.equal(record.error?.type, "ValidationException");
  assert.match(String(record.response.errorBody), /block_binding/);
  assert.equal(record.cost.total, 0);
  assert.equal((await stack.state()).turns, 0);
});

test("an exception inside the stream is relayed and recorded, and what it billed still counts", async () => {
  const bytes = Buffer.concat([
    chunkFrame(EVENTS[0]),
    exceptionFrame("modelStreamErrorException", "the model stream broke"),
  ]);
  const stack = await startStack((_req, res) => writeInPieces(res, bytes));
  const response = await stack.client.send(streamCommand());
  await assert.rejects(readEvents(response), (error: Error) => /stream broke/.test(error.message));
  const [record] = stack.log();
  assert.equal(record.outcome, "stream_exception");
  assert.equal(record.error?.type, "modelStreamErrorException");
  assert.equal(record.usage.cacheRead, 1_000_000);
  assert.ok(record.cost.total > 0);
});

test("non-streaming InvokeModel is forwarded and priced too", async () => {
  const stack = await startStack((_req, res) => {
    const body = JSON.stringify({
      id: "msg_2",
      model: "claude-opus-5",
      content: [{ type: "text", text: "tool_use" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    res.writeHead(200, { "content-type": "application/json", "x-amzn-requestid": "req-2" });
    res.end(body);
  });
  const response = await stack.client.send(
    new InvokeModelCommand({
      modelId: MODEL,
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify(REQUEST_BODY)),
    }),
  );
  assert.equal(JSON.parse(new TextDecoder().decode(response.body)).id, "msg_2");
  const state = await stack.state();
  assert.equal(state.turns, 1);
  assert.ok(Math.abs(state.spendUsd - (1000 * 5.5 + 10 * 27.5) / 1e6) < 1e-12);
});

test("control needs the token when one is set, and reset clears spend and the trace", async () => {
  const stack = await startStack((_req, res) => writeInPieces(res, streamBytes()), 100, "tok");
  await readEvents(await stack.client.send(streamCommand()));
  assert.equal((await stack.control("/__control/state")).status, 401);
  assert.equal((await stack.control("/__control/health", { headers: { authorization: "Bearer nope" } })).status, 401);
  const auth = { authorization: "Bearer tok" };
  assert.equal((await stack.control("/__control/health", { headers: auth })).status, 200);
  const trace = await (await stack.control("/__control/trace", { headers: auth })).text();
  assert.equal(trace.trim().split("\n").length, 1);
  await stack.control("/__control/reset", { method: "POST", headers: auth });
  const state = await stack.state();
  assert.equal(state.spendUsd, 0);
  assert.equal(state.turns, 0);
  assert.equal(stack.log().length, 0);
});

test("control routes are not served on the model port", async () => {
  const stack = await startStack((_req, res) => writeInPieces(res, streamBytes()));
  const session = http2.connect(`http://127.0.0.1:${stack.proxyPort}`);
  const status = await new Promise<number>((resolve) => {
    const req = session.request({ ":method": "GET", ":path": "/__control/state" });
    req.on("response", (headers) => resolve(Number(headers[":status"])));
    req.resume();
    req.end();
  });
  session.close();
  assert.equal(status, 404);
  assert.equal(stack.seen.length, 0);
});

test("the frame reader agrees with the SDK's own codec across split chunks", () => {
  const reader = new FrameReader();
  const bytes = Buffer.concat([chunkFrame(EVENTS[1]), exceptionFrame("throttlingException", "slow")]);
  const frames = [
    ...reader.push(bytes.subarray(0, 5)),
    ...reader.push(bytes.subarray(5, 70)),
    ...reader.push(bytes.subarray(70)),
  ];
  assert.equal(frames.length, 2);
  assert.equal(frames[0].headers[":event-type"], "chunk");
  assert.equal(frames[1].headers[":exception-type"], "throttlingException");
  assert.equal(reader.leftover, 0);
  const decoded = codec.decode(bytes.subarray(0, bytes.readUInt32BE(0)));
  assert.equal(Buffer.compare(Buffer.from(decoded.body), frames[0].payload), 0);
});
