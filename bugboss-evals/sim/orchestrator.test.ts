import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { createHmac, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import {
  alertBody,
  bugbossEnv,
  closedBy,
  dotenv,
  endCondition,
  makeSecrets,
  makeTls,
  prepareRun,
  signedAlert,
  TLS_NAMES,
  type PreparedRun,
} from "./orchestrator";

const run = promisify(execFile);

const slack = (over: Partial<Parameters<typeof closedBy>[0]> = {}): Parameters<typeof closedBy>[0] => ({
  threads: [],
  files: [],
  errors: [],
  lastActivityAt: null,
  ...over,
});

const caps = { wallClockSeconds: 3600, modelUsd: 35, quietMinutes: 30 };
const proxy = { spendUsd: 1, turns: 3, budgetUsd: 35, overBudget: false, lastActivityAt: 0 };

describe("end conditions", () => {
  test("the closing report file closes the run", () => {
    const files = [{ id: "F1", filename: "incident-4.md", title: "Incident 4 — closing report", content: "#", threadTs: "1.1", completed: true }];
    assert.equal(closedBy(slack({ files })), "closed");
    assert.equal(closedBy(slack({ files: [{ ...files[0], completed: false }] })), null);
  });

  test("an inline report, when the upload failed, is its own end", () => {
    const threads = [{ channel: "C", ts: "1.1", messages: [{ ts: "1.2", user: "U0BUGBOSS", text: "The report file could not be uploaded, so it is posted here instead." }] }];
    assert.equal(closedBy(slack({ threads })), "closed_inline");
  });

  test("cost, wall clock and quiet end the run in that order", () => {
    const base = { now: 10_000, firstAlertAt: 0, caps, slack: slack(), proxy, lastActivityAt: 10_000 };
    assert.equal(endCondition(base), null);
    assert.equal(endCondition({ ...base, proxy: { ...proxy, overBudget: true } })?.kind, "over_budget");
    assert.equal(endCondition({ ...base, now: 3_600_000, lastActivityAt: 3_600_000 })?.kind, "wall_clock");
    assert.equal(endCondition({ ...base, now: 1_900_000, lastActivityAt: 100_000 })?.kind, "stalled");
  });
});

describe("the alert", () => {
  test("is signed exactly as bugboss/ingress/grafana.ts verifies it", () => {
    const body = '{"alerts":[]}';
    const headers = signedAlert({ body, secret: "s3cret", basicAuthPassword: "pw", now: 1_700_000_000_500 });
    assert.equal(headers["X-Grafana-Alerting-Timestamp"], "1700000000");
    assert.equal(
      headers["X-Grafana-Alerting-Signature"],
      createHmac("sha256", "s3cret").update(`1700000000:${body}`).digest("hex"),
    );
    assert.equal(Buffer.from(headers.authorization.slice(6), "base64").toString(), "grafana:pw");
  });

  test("fires now, whatever time the scenario recorded", () => {
    const at = Date.UTC(2026, 8, 29, 12);
    const body = JSON.parse(alertBody('{"alerts":[{"startsAt":"2026-01-01T00:00:00Z","labels":{"x":"{{ALERT_AT_ISO}}"}}]}', at));
    assert.equal(body.alerts[0].startsAt, "2026-09-29T12:00:00.000Z");
    assert.equal(body.alerts[0].labels.x, "2026-09-29T12:00:00.000Z");
  });
});

describe("run configuration", () => {
  test("the env file refuses a value it cannot carry literally", () => {
    assert.equal(dotenv({ A: "x y", B: '{"a":1}' }), "A='x y'\nB='{\"a\":1}'\n");
    assert.throws(() => dotenv({ A: "it's" }), /single-quoted/);
    assert.throws(() => dotenv({ A: "a\nb" }), /single-quoted/);
  });

  test("the PEM survives the env file inside the secrets blob", () => {
    const secrets = makeSecrets();
    const env = bugbossEnv({ secrets, grafanaToken: "glsa_x" });
    const line = dotenv(env);
    assert.ok(!line.includes("-----BEGIN RSA PRIVATE KEY-----\n"));
    const blob = JSON.parse(env.BUGBOSS_SECRETS) as Record<string, string>;
    assert.equal(blob.GITHUB_APP_PRIVATE_KEY, secrets.githubAppPrivateKey);
    assert.match(blob.GITHUB_APP_PRIVATE_KEY, /^-----BEGIN RSA PRIVATE KEY-----\n/);
  });

  test("BugBoss is pointed at a stand-in for every endpoint it has", () => {
    const env = bugbossEnv({ secrets: makeSecrets(), grafanaToken: "t" });
    for (const [key, value] of Object.entries(env)) {
      if (/URL|REPO|ENDPOINT|MIRROR|registry/.test(key)) {
        assert.doesNotMatch(value, /amazonaws\.com|github\.com|slack\.com|grafana\.net|npmjs\.org/, key);
      }
    }
    assert.equal(env.BUGBOSS_GITHUB_URL, "https://github");
    assert.equal(env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME, "https://proxy:8443");
  });

  test("the certificate names every stand-in and chains to the run's CA", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-tls-"));
    try {
      await makeTls(dir);
      const ca = new X509Certificate(readFileSync(join(dir, "ca.crt")));
      const leaf = new X509Certificate(readFileSync(join(dir, "server.crt")));
      assert.ok(leaf.verify(ca.publicKey));
      for (const name of TLS_NAMES) assert.ok(leaf.subjectAltName?.includes(`DNS:${name}`), name);
      assert.ok(ca.ca);
      assert.throws(() => readFileSync(join(dir, "ca.key")), "the CA key is not kept");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

describe("the prepared run", { skip: dockerAvailable ? false : "docker is not available on this machine" }, () => {
  let workRoot: string;
  let prepared: PreparedRun;

  before(async () => {
    workRoot = mkdtempSync(join(tmpdir(), "sim-prepare-"));
    const dir = join(workRoot, "scenario");
    mkdirSync(join(dir, "check"), { recursive: true });
    writeFileSync(
      join(dir, "scenario.json"),
      JSON.stringify({
        id: "prepare-probe",
        sourceIncident: 1,
        omni: { baseSha: "abcdef0", packages: ["gp-api"], provingFixSha: "abcdef1" },
        alert: { file: "alert.json", refireEverySeconds: 300 },
        telemetry: { generator: "telemetry.ts", backfillHoursBefore: 6 },
        aws: { data: "aws.json" },
        ci: { visible: ["npm test -w packages/gp-api"] },
        check: { setup: "check/seed.sh", command: "check/run.sh", timeoutSeconds: 600, runsAt: "deploy" },
        reviewer: { requestChangesOnce: true },
        persona: { file: "persona.md", model: "sonnet", replyDelaySeconds: [20, 90], mergeDelaySeconds: 300 },
        chaos: { restartBugbossAfterSeconds: null },
        caps: { wallClockSeconds: 10800, modelUsd: 35, quietMinutes: 30 },
        reference: "reference.md",
      }),
    );
    for (const name of ["alert.json", "aws.json", "telemetry.ts", "helper.ts", "persona.md", "reference.md", "check/run.sh", "check/seed.sh"]) {
      writeFileSync(join(dir, name), name);
    }
    mkdirSync(join(workRoot, "_lib"));
    writeFileSync(join(workRoot, "_lib", "setup-omni.sh"), "");
    writeFileSync(join(workRoot, "empty.bundle"), "");
    prepared = await prepareRun({
      scenarioJson: join(dir, "scenario.json"),
      bugbossImage: "bugboss:test",
      simImage: "sim:test",
      rep: 2,
      runId: "prepare-probe",
      workRoot,
      omniBundle: join(workRoot, "empty.bundle"),
    });
  });

  after(() => rmSync(workRoot, { recursive: true, force: true }));

  test("the whole stack is valid compose once the run directory exists", async () => {
    const { stdout } = await prepared.compose(["config", "--format", "json"]);
    const config = JSON.parse(stdout) as {
      services: Record<string, { networks?: Record<string, { ipv4_address?: string } | null>; network_mode?: string; environment?: Record<string, string> }>;
      networks: Record<string, { internal?: boolean }>;
    };
    assert.equal(config.networks.sim.internal, true);
    assert.equal(config.networks.control.internal, true);
    assert.deepEqual(Object.keys(config.services.bugboss.networks ?? {}), ["sim"], "BugBoss is on the sim network only");
    assert.equal(config.services.postgres.network_mode, "service:bugboss");
    const onEgress = Object.entries(config.services)
      .filter(([, service]) => Object.keys(service.networks ?? {}).includes("egress"))
      .map(([name]) => name)
      .sort();
    assert.deepEqual(onEgress, ["mirror", "npm", "persona", "proxy", "uv-warm"], "the only containers with a route out");
    for (const name of ["proxy", "github", "slack", "aws", "checker"]) {
      const bind = config.services[name].environment?.CONTROL_HOST;
      assert.equal(bind, config.services[name].networks?.control?.ipv4_address, `${name} binds its control port to its control address`);
    }
  });

  test("no container BugBoss or visible CI can reach holds the hidden parts of the scenario", () => {
    const listing = (sub: string) => execFileSync("find", [".", "-type", "f"], { cwd: join(prepared.runDir, sub) }).toString().split("\n").filter(Boolean).sort();
    assert.deepEqual(listing("scenario-public"), ["./alert.json", "./aws.json", "./helper.ts", "./scenario.json", "./telemetry.ts"]);
    assert.deepEqual(listing("scenario-hidden"), ["./_lib/setup-omni.sh", "./prepare-probe/check/run.sh", "./prepare-probe/check/seed.sh"]);
    assert.deepEqual(listing("scenario-persona"), ["./persona.md"]);
    const hook = readFileSync(join(prepared.runDir, "hooks", "deploy.sh"), "utf8");
    assert.ok(hook.includes(prepared.secrets.deployToken));
    assert.ok(!hook.includes(prepared.secrets.controlToken), "the hook runs next to visible CI and holds no control token");
  });

  test("the sim image leaves the scenarios out", async () => {
    const ignore = readFileSync(join(__dirname, "compose", "sim.Dockerfile.dockerignore"), "utf8");
    assert.match(ignore, /^bugboss-evals\/scenarios$/m);
    await run("true");
  });
});
