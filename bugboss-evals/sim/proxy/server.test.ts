import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
after(() => {
  for (const child of children) child.kill();
  for (const server of servers) server.close();
});

const freePort = async (): Promise<number> => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const boot = async (env: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-server-"));
  const ports = { model: await freePort(), control: await freePort() };
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(__dirname, "server.ts")],
    {
      env: {
        PATH: process.env.PATH ?? "",
        PORT: String(ports.model),
        CONTROL_PORT: String(ports.control),
        CONTROL_HOST: "127.0.0.1",
        PROXY_BUDGET_USD: "5",
        PROXY_TRACE_FILE: join(dir, "trace.jsonl"),
        UPSTREAM_REGION: "us-west-2",
        AWS_ACCESS_KEY_ID: "AKIDPROXYREAL",
        AWS_SECRET_ACCESS_KEY: "proxy-secret",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("proxy_listening")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`proxy exited ${code}: ${stderr}`)));
  });
  return { ports, dir };
};

test("the entry point boots on h2c and the SDK reaches upstream through it", async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      assert.match(String(req.headers.authorization), /Credential=AKIDPROXYREAL\//);
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      res.end();
    });
  });
  servers.push(upstream);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const { ports, dir } = await boot({
    UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
    CONTROL_TOKEN: "tok",
  });
  const client = new BedrockRuntimeClient({
    endpoint: `http://127.0.0.1:${ports.model}`,
    region: "us-west-2",
    credentials: { accessKeyId: "AKIDFAKE", secretAccessKey: "fake" },
    maxAttempts: 1,
  });
  const response = await client.send(
    new InvokeModelWithResponseStreamCommand({
      modelId: "us.anthropic.claude-opus-5",
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify({ messages: [] })),
    }),
  );
  for await (const _ of response.body ?? []) {
    // drain
  }

  const control = `http://127.0.0.1:${ports.control}/__control/state`;
  assert.equal((await fetch(control)).status, 401);
  const state = (await (await fetch(control, { headers: { authorization: "Bearer tok" } })).json()) as {
    turns: number;
    budgetUsd: number;
  };
  assert.equal(state.turns, 1);
  assert.equal(state.budgetUsd, 5);
  assert.equal(readFileSync(join(dir, "trace.jsonl"), "utf8").trim().split("\n").length, 1);
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

test("with a cert and key the model listener serves HTTP/2 over TLS", { skip: !hasOpenssl }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-tls-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const made = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=proxy", "-addext", "subjectAltName=DNS:proxy,IP:127.0.0.1",
    "-keyout", key, "-out", cert,
  ]);
  assert.equal(made.status, 0, String(made.stderr));

  const { ports } = await boot({ TLS_CERT_FILE: cert, TLS_KEY_FILE: key });
  const session = http2.connect(`https://127.0.0.1:${ports.model}`, { ca: readFileSync(cert) });
  const status = await new Promise<number>((resolve, reject) => {
    session.on("error", reject);
    const req = session.request({ ":method": "GET", ":path": "/not-bedrock" });
    req.on("response", (headers) => resolve(Number(headers[":status"])));
    req.resume();
    req.end();
  });
  assert.equal(session.alpnProtocol, "h2");
  session.close();
  assert.equal(status, 404);
});

test("the entry point refuses to start without a budget", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "server.ts")], {
    env: { PATH: process.env.PATH ?? "", AWS_REGION: "us-west-2" },
  });
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /PROXY_BUDGET_USD is required/);
});
