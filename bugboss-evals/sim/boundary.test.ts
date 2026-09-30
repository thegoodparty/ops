import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import { OPS_ROOT, prepareRun, type PreparedRun } from "./orchestrator";

const run = promisify(execFile);
const SIM = __dirname;
const BUGBOSS = join(OPS_ROOT, "bugboss");

// ------------------------------------------------------------- the import rule

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|js|mjs|cjs)$/.test(name) ? [path] : [];
  });

const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

export const bugbossImports = (file: string, text: string): string[] =>
  [...text.matchAll(SPECIFIER)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[4])
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier))
    .filter((target) => target === BUGBOSS || target.startsWith(`${BUGBOSS}/`));

describe("the sim never imports BugBoss", () => {
  test("no file under sim/ resolves an import into bugboss/", () => {
    const offenders = sources(SIM).flatMap((file) =>
      bugbossImports(file, readFileSync(file, "utf8")).map((target) => `${relative(OPS_ROOT, file)} -> ${relative(OPS_ROOT, target)}`),
    );
    assert.deepEqual(offenders, [], "Tier 1 is black box: it talks to BugBoss only over the wire");
  });

  test("the check catches every import form", () => {
    const file = join(SIM, "x.ts");
    // Built rather than written out, so this file does not trip its own scan.
    const up = ["..", "..", "bugboss"].join("/");
    const text = [
      `import { a } from "${up}/types";`,
      `import type { B } from "${up}/agent/run";`,
      `const c = require("${up}/index");`,
      `const d = await import("${up}/db");`,
      `export { e } from "${up}/slack/client";`,
      `import "${up}/logging";`,
      'import { fine } from "../core/scenario";',
      `import { alsoFine } from "${up}-evals/core/trace";`,
    ].join("\n");
    assert.equal(bugbossImports(file, text).length, 6);
  });
});

// ------------------------------------------------------------ egress lockdown

const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const SCENARIO = {
  id: "boundary-probe",
  sourceIncident: 1,
  omni: { baseSha: "0000000", packages: ["gp-api"], provingFixSha: "1111111" },
  alert: { file: "alert.json", refireEverySeconds: 0 },
  telemetry: { generator: "telemetry.ts", backfillHoursBefore: 1 },
  aws: { data: "aws.json" },
  ci: { visible: ["true"] },
  check: { setup: null, command: "check/run.sh", timeoutSeconds: 60, runsAt: "deploy" },
  reviewer: { requestChangesOnce: false },
  persona: { file: "persona.md", model: "sonnet", replyDelaySeconds: [1, 2], mergeDelaySeconds: 1 },
  chaos: { restartBugbossAfterSeconds: null },
  caps: { wallClockSeconds: 60, modelUsd: 1, quietMinutes: 1 },
  reference: "reference.md",
};

// Runs inside a container attached only to the sim network, with the DNS
// sentinel as its resolver -- exactly how BugBoss is attached.
const PROBE = `
const net = require("node:net");
const dns = require("node:dns").promises;
const http = require("node:http");
const tcp = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: 4000 });
  socket.on("connect", () => { socket.destroy(); resolve("connected"); });
  socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
  socket.on("error", (error) => resolve(error.code || error.message));
});
const get = (url, headers = {}) => new Promise((resolve) => {
  const req = http.get(url, { headers, timeout: 60000 }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  req.on("error", (error) => resolve(error.code || error.message));
});
(async () => {
  const out = {};
  out.cloudflareTcp = await tcp("1.1.1.1", 443);
  out.googleDnsTcp = await tcp("8.8.8.8", 53);
  out.imds = await tcp("169.254.169.254", 80);
  out.registryDns = await dns.lookup("registry.npmjs.org").then(() => "resolved", (e) => e.code);
  out.githubDns = await dns.lookup("api.github.com").then(() => "resolved", (e) => e.code);
  out.npmPing = await get("http://npm:4873/-/ping");
  out.npmPackage = await get("http://npm:4873/left-pad");
  out.controlOnSimName = await tcp("ctl-listener", 9002);
  out.controlOnControlIp = await tcp(process.env.CTL_IP, 9002);
  out.gatewayNoToken = await get("http://gateway:8900/proxy/__control/health");
  console.log(JSON.stringify(out));
})();
`;

describe("egress lockdown", { skip: dockerAvailable ? false : "docker is not available on this machine" }, () => {
  let prepared: PreparedRun;
  let workRoot: string;
  let files: string[];
  const image = "bugboss-evals-boundary:test";

  before(async () => {
    workRoot = mkdtempSync(join(tmpdir(), "bugboss-boundary-"));
    const scenarioDir = join(workRoot, "scenario");
    mkdirSync(join(scenarioDir, "check"), { recursive: true });
    writeFileSync(join(scenarioDir, "scenario.json"), JSON.stringify(SCENARIO));
    for (const name of ["alert.json", "aws.json", "telemetry.ts", "persona.md", "reference.md", "check/run.sh"]) {
      writeFileSync(join(scenarioDir, name), name.endsWith(".json") ? "{}" : "");
    }
    const bundle = join(workRoot, "empty.bundle");
    writeFileSync(bundle, "");

    // Only the pieces this test starts, so it does not need the whole ops
    // install inside an image.
    const context = join(workRoot, "image");
    mkdirSync(context, { recursive: true });
    writeFileSync(
      join(context, "Dockerfile"),
      [
        "FROM node:22-alpine",
        "WORKDIR /app",
        "RUN npm init -y > /dev/null && npm install --no-audit --no-fund tsx@4.21.0 > /dev/null",
        "COPY compose /app/bugboss-evals/sim/compose",
      ].join("\n"),
    );
    execFileSync("cp", ["-R", join(SIM, "compose"), join(context, "compose")]);
    await run("docker", ["build", "-q", "-t", image, context], { maxBuffer: 1 << 26 });

    prepared = await prepareRun({
      scenarioJson: join(scenarioDir, "scenario.json"),
      bugbossImage: "node:22-alpine",
      simImage: image,
      rep: 1,
      runId: `boundary-${process.pid}`,
      workRoot,
      omniBundle: bundle,
      modelCredentials: "none",
    });
    writeFileSync(join(prepared.runDir, "probe.js"), PROBE);
    writeFileSync(
      join(prepared.runDir, "boundary.override.yml"),
      [
        "services:",
        "  ctl-listener:",
        "    image: node:22-alpine",
        '    command: ["node", "-e", "require(\\"node:http\\").createServer((q, s) => s.end(\\"control\\")).listen(9002, process.env.BIND)"]',
        "    environment:",
        `      BIND: ${prepared.subnets.control}.20`,
        "    networks:",
        "      sim: {}",
        "      control:",
        `        ipv4_address: ${prepared.subnets.control}.20`,
        "  probe:",
        "    image: node:22-alpine",
        `    dns: [${prepared.subnets.sim}.53]`,
        "    environment:",
        `      CTL_IP: ${prepared.subnets.control}.20`,
        "    volumes:",
        `      - ${prepared.runDir}/probe.js:/probe.js:ro`,
        '    command: ["node", "/probe.js"]',
        "    networks: [sim]",
        "",
      ].join("\n"),
    );
    files = ["-f", join(prepared.runDir, "stack.yml"), "-f", join(prepared.runDir, "boundary.override.yml")];
    await run(
      "docker",
      ["compose", "-p", prepared.project, ...files, "--env-file", join(prepared.runDir, ".env"), "up", "-d", "--quiet-pull", "sentinel", "gateway", "npm", "ctl-listener"],
      { maxBuffer: 1 << 26 },
    );
  });

  after(async () => {
    if (prepared) {
      await run("docker", ["compose", "-p", prepared.project, ...files, "--env-file", join(prepared.runDir, ".env"), "down", "-v", "--remove-orphans"], {
        maxBuffer: 1 << 26,
      }).catch(() => undefined);
    }
    rmSync(workRoot, { recursive: true, force: true });
  });

  test("a container on the sim network reaches the npm exit and nothing else", async () => {
    // Verdaccio takes a few seconds to bind; the probe waits on it rather
    // than reading a cold start as a lockdown.
    let probe: Record<string, string | number> = {};
    for (let attempt = 0; attempt < 30; attempt++) {
      const { stdout } = await run(
        "docker",
        ["compose", "-p", prepared.project, ...files, "--env-file", join(prepared.runDir, ".env"), "run", "--rm", "--no-deps", "probe"],
        { maxBuffer: 1 << 26 },
      );
      probe = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, string | number>;
      if (probe.npmPing === 200) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }

    for (const key of ["cloudflareTcp", "googleDnsTcp", "imds"]) {
      assert.notEqual(probe[key], "connected", `${key}: a sim container opened a connection to the internet`);
    }
    for (const key of ["registryDns", "githubDns"]) {
      assert.notEqual(probe[key], "resolved", `${key}: an external name resolved on the sim network`);
    }
    assert.equal(probe.npmPing, 200, "the npm exit must be reachable, or the lockdown proves nothing");
    assert.equal(probe.npmPackage, 200, "the npm exit proxies the public registry");
    assert.equal(probe.controlOnSimName, "ECONNREFUSED", "a control listener is not listening on the sim network");
    assert.notEqual(probe.controlOnControlIp, "connected", "the control network is not routable from the sim network");
    assert.equal(probe.gatewayNoToken, 401, "the gateway forwards nothing without the run's token");
  });

  test("every name BugBoss tries to resolve outside the sim is recorded", () => {
    const log = join(prepared.runDir, "results", "egress-dns.jsonl");
    assert.ok(existsSync(log), "the sentinel wrote no log, so the egress gate would pass on silence");
    const names = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { name: string }).name);
    assert.ok(names.includes("registry.npmjs.org"), `sentinel saw: ${names.join(", ")}`);
    assert.ok(names.includes("api.github.com"));
    assert.ok(!names.includes("npm"), "sim names are answered by Docker, not forwarded out");
  });
});
