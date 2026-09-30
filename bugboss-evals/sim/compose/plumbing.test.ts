import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createChecker } from "./checker";
import { createGateway, route, TOKEN_HEADER } from "./gateway";
import { createMirror, safePath } from "./mirror";
import { nxdomain, parseQuery, startSentinel } from "./sentinel";

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

const query = (name: string, id = 0x1234): Buffer => {
  const labels = name.split(".").flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
  return Buffer.concat([
    Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
    ...labels,
    Buffer.from([0, 0x00, 0x01, 0x00, 0x01]),
  ]);
};

describe("sentinel", () => {
  test("reads the question and answers NXDOMAIN with the same id", () => {
    const packet = query("Registry.NPMJS.org");
    assert.deepEqual(parseQuery(packet), { id: 0x1234, name: "registry.npmjs.org", type: 1 });
    const reply = nxdomain(packet);
    assert.equal(reply.readUInt16BE(0), 0x1234);
    assert.equal(reply[2] & 0x80, 0x80, "QR set");
    assert.equal(reply[3] & 0x0f, 3, "NXDOMAIN");
    assert.equal(reply.readUInt16BE(6), 0, "no answers");
  });

  test("ignores a packet it cannot read rather than crashing", () => {
    assert.equal(parseQuery(Buffer.from([1, 2, 3])), null);
    assert.equal(parseQuery(Buffer.concat([query("a.b").subarray(0, 12), Buffer.from([70])])), null);
  });

  test("records every query it is sent", async () => {
    const seen: string[] = [];
    const socket = await startSentinel({ bind: "127.0.0.1", port: 0, record: (entry) => seen.push(entry.name) });
    const port = socket.address().port;
    const client = createSocket("udp4");
    const reply = await new Promise<Buffer>((resolve) => {
      client.on("message", (message) => resolve(message));
      client.send(query("api.github.com"), port, "127.0.0.1");
    });
    client.close();
    socket.close();
    assert.equal(reply[3] & 0x0f, 3);
    assert.deepEqual(seen, ["api.github.com"]);
  });
});

describe("gateway", () => {
  let upstream: Server;
  let gateway: Server;
  let base: string;
  const seen: { url: string; authorization?: string; token?: string }[] = [];

  before(async () => {
    upstream = createServer((req, res) => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization, token: req.headers[TOKEN_HEADER] as string | undefined });
      res.end("ok");
    });
    const origin = await listen(upstream);
    gateway = createGateway({
      token: "t0k",
      targets: { proxy: { origin, control: true }, bugboss: { origin, control: false } },
    });
    base = await listen(gateway);
  });

  after(() => {
    gateway.close();
    upstream.close();
  });

  test("forwards nothing without the run's token", async () => {
    assert.equal((await fetch(`${base}/proxy/__control/state`)).status, 401);
    assert.equal((await fetch(`${base}/proxy/__control/state`, { headers: { [TOKEN_HEADER]: "wrong" } })).status, 401);
  });

  test("control targets get the token as a bearer, others keep their own auth, and the token header never leaves", async () => {
    await fetch(`${base}/proxy/__control/state`, { headers: { [TOKEN_HEADER]: "t0k" } });
    await fetch(`${base}/bugboss/grafana`, { method: "POST", body: "{}", headers: { [TOKEN_HEADER]: "t0k", authorization: "Basic abc" } });
    assert.deepEqual(seen.slice(-2), [
      { url: "/__control/state", authorization: "Bearer t0k", token: undefined },
      { url: "/grafana", authorization: "Basic abc", token: undefined },
    ]);
  });

  test("routes only to the fixed table", async () => {
    assert.equal(route("/evil.example.com/x"), null);
    assert.equal(route("/http://x"), null);
    assert.equal((await fetch(`${base}/nope/x`, { headers: { [TOKEN_HEADER]: "t0k" } })).status, 404);
  });
});

describe("mirror", () => {
  test("refuses anything but a plain GET under the one upstream", () => {
    assert.equal(safePath("/prisma/engines/x.gz?y=1"), "/prisma/engines/x.gz");
    assert.equal(safePath("/../etc/passwd"), null);
    assert.equal(safePath("//evil.example.com/x"), null);
    assert.equal(safePath("http://evil.example.com/x"), null);
  });

  test("fetches once and serves the cache after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-"));
    const fetched: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return new Response("engine-bytes");
    }) as typeof fetch;
    const log: Record<string, string | number | boolean>[] = [];
    const server = createMirror({ upstream: "https://binaries.prisma.sh", cacheDir: dir, log: (entry) => log.push(entry), fetchImpl: fake });
    const base = await listen(server);
    try {
      assert.equal(await (await fetch(`${base}/all_commits/abc/engine.gz`)).text(), "engine-bytes");
      assert.equal(await (await fetch(`${base}/all_commits/abc/engine.gz`)).text(), "engine-bytes");
      assert.equal((await fetch(`${base}/x`, { method: "POST" })).status, 405);
      assert.deepEqual(fetched, ["https://binaries.prisma.sh/all_commits/abc/engine.gz"]);
      assert.deepEqual(log.map((entry) => entry.cached ?? entry.refused), [false, true, true]);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checker", () => {
  let work: string;
  let control: Server;
  let controlBase: string;
  const flips: { url: string; body: string; authorization?: string }[] = [];
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd }).toString().trim();

  before(async () => {
    work = mkdtempSync(join(tmpdir(), "checker-"));
    const origin = join(work, "origin");
    mkdirSync(origin);
    git(origin, "init", "--quiet");
    writeFileSync(join(origin, "app.txt"), "broken\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "base");
    control = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        flips.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
        res.end("{}");
      });
    });
    controlBase = await listen(control);
  });

  after(() => {
    control.close();
    rmSync(work, { recursive: true, force: true });
  });

  test("runs the hidden check on a main SHA, records it privately, and flips the world", async () => {
    const origin = join(work, "origin");
    const base = git(origin, "rev-parse", "HEAD");
    const repo = join(work, "omni");
    execFileSync("git", ["clone", "--quiet", origin, repo]);
    writeFileSync(join(origin, "app.txt"), "fixed\n");
    git(origin, "commit", "--quiet", "-am", "fix");
    const fixed = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "--quiet", "-b", "side");
    writeFileSync(join(origin, "app.txt"), "sneaky\n");
    git(origin, "commit", "--quiet", "-am", "not on main");
    const offMain = git(origin, "rev-parse", "HEAD");
    git(origin, "checkout", "--quiet", "main");

    const scenarioDir = join(work, "scenario");
    mkdirSync(join(scenarioDir, "check"), { recursive: true });
    writeFileSync(join(scenarioDir, "check", "run.sh"), 'echo "token=${CONTROL_TOKEN:-none} sha=$1"\ngrep -q fixed "$2/app.txt"\n');
    const results = join(work, "results");
    const checker = createChecker({
      scenarioDir,
      checkSetup: null,
      checkCommand: "check/run.sh",
      setupTimeoutSeconds: 30,
      timeoutSeconds: 30,
      baseSha: base,
      repoDir: repo,
      resultsDir: results,
      deployToken: "deploy",
      controlToken: "control",
      telemetryControlUrl: controlBase,
      awsControlUrl: controlBase,
      env: { ...process.env, CONTROL_TOKEN: "control" },
    });
    const url = await listen(checker.server);
    const deploy = (sha: string, token = "deploy") =>
      fetch(`${url}/deploy`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ sha }) });
    try {
      assert.equal((await deploy(fixed, "control")).status, 401, "the control token is not the deploy token");
      assert.equal((await deploy(offMain)).status, 500, "a SHA that is not on main is never deployed");
      assert.deepEqual(checker.refusals.map((refusal) => refusal.reason), ["not on main"]);

      const response = await deploy(fixed);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { deployed: fixed }, "the answer says nothing about the check");
      assert.equal(checker.deploys[0].passed, true);
      assert.match(readFileSync(join(results, `${fixed}.diff`), "utf8"), /\+fixed/);
      assert.match(readFileSync(join(results, `${fixed}.log`), "utf8"), /token=none sha=[0-9a-f]{40}/, "the check gets no token, and the hook's arguments");
      assert.deepEqual(
        flips.map((flip) => [flip.url, flip.body, flip.authorization]),
        [
          ["/__control/state", '{"state":"healthy"}', "Bearer control"],
          ["/__control/deploy", `{"sha":"${fixed}"}`, "Bearer control"],
        ],
      );
      assert.ok(!existsSync(join(work, "deploys", fixed)), "the deploy tree is removed afterwards");

      const state = await fetch(`${url}/__control/state`, { headers: { authorization: "Bearer control" } });
      assert.equal(((await state.json()) as { deploys: unknown[] }).deploys.length, 1);
    } finally {
      checker.server.close();
    }
  });
});
