import { execFile, spawn } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { fromNodeProviderChain, fromTemporaryCredentials } from "@aws-sdk/credential-providers";

import { loadScenario, type Scenario } from "../core/scenario";
import { evaluateGates, type GateInputs, type GateResult } from "./gates";

/**
 * One Tier 1 run, black box: build or reuse the variant's image, bring up the
 * stack in sim/compose/stack.yml, fire the alert, watch until the incident
 * closes or a cap ends it, collect everything, and tear the stack down.
 *
 * The caps are enforced here and in the model proxy, outside the system under
 * test, so they hold whatever the variant does.
 */

const run = promisify(execFile);

/**
 * Every docker, compose and git call the harness makes on the host runs with
 * no credential helper. A person's docker config commonly names the macOS
 * keychain as its credsStore, and Apple's git names it as a credential helper,
 * so without this each pull and each run asks the keychain, over and over.
 * The images are public, so nothing needs a stored credential. The context,
 * CLI plugins and buildx state are linked from the real config so compose and
 * the daemon the person uses keep working. Set at import, before any call.
 */
export const isolateHostTools = (env: NodeJS.ProcessEnv = process.env): void => {
  if (env.BUGBOSS_EVALS_DOCKER_CONFIG_ISOLATED === "1") return;
  const real = env.DOCKER_CONFIG ?? join(homedir(), ".docker");
  const dir = mkdtempSync(join(tmpdir(), "bugboss-evals-docker-"));
  let currentContext: string | undefined;
  try {
    currentContext = (JSON.parse(readFileSync(join(real, "config.json"), "utf8")) as { currentContext?: string }).currentContext;
  } catch {
    currentContext = undefined;
  }
  writeFileSync(join(dir, "config.json"), JSON.stringify(currentContext ? { currentContext } : {}));
  for (const name of ["contexts", "cli-plugins", "buildx"]) {
    if (existsSync(join(real, name))) symlinkSync(join(real, name), join(dir, name));
  }
  env.DOCKER_CONFIG = dir;
  env.BUGBOSS_EVALS_DOCKER_CONFIG_ISOLATED = "1";
  // Apple's git names the keychain in its system gitconfig, which an empty
  // helper alone does not stop reading.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_TERMINAL_PROMPT = "0";
};

isolateHostTools();

export const SIM_DIR = __dirname;
export const OPS_ROOT = resolve(__dirname, "..", "..");
const COMPOSE_DIR = join(SIM_DIR, "compose");

export const BUCKET = "bugboss-sim";
export const CHANNEL = "C0SIMBUGS";
export const HUMAN_LOGIN = "oncall-human";
export const DEPLOYER_LOGIN = "sim-deployer";

// Every name a stand-in answers to, so one leaf certificate covers the stack.
export const TLS_NAMES = [
  "proxy",
  "github",
  "slack",
  "aws",
  "grafana",
  "loki",
  "prometheus",
  "tempo",
  "minio",
  "*.minio",
  "npm",
  "mirror",
  "gateway",
  "checker",
  "telemetry",
  "bugboss",
  "localhost",
];

export type EndKind = "closed" | "closed_inline" | "wall_clock" | "over_budget" | "stalled" | "error";

export interface RunEnd {
  kind: EndKind;
  at: number;
  detail: string;
}

export interface RunResult {
  runId: string;
  scenario: string;
  rep: number;
  seed: number;
  bugbossImage: string;
  ref: string | null;
  startedAt: number;
  firstAlertAt: number | null;
  end: RunEnd;
  wallClockSeconds: number | null;
  costUsd: number | null;
  turns: number | null;
  gates: GateResult[];
  resultsDir: string;
}

export interface RunSpec {
  scenarioJson: string;
  bugbossImage: string;
  simImage: string;
  ref?: string | null;
  rep: number;
  runId: string;
  /** Must be the same path on the docker host; see stack.yml. */
  workRoot: string;
  omniBundle: string;
  /**
   * Where the model proxy's and the persona's real credentials come from.
   * "none" gives them nothing, so every model call fails before it reaches
   * Bedrock and the run spends $0. Otherwise the orchestrator resolves them
   * here, from `profile` or the default chain, assuming `roleArn` when set,
   * and writes the session where only those two containers can read it.
   */
  modelCredentials: ModelCredentials;
  /**
   * The incident agent's model, as BUGBOSS_MODEL_ID. A variant knob that
   * needs no new image; unset, BugBoss uses its own default.
   */
  incidentModelId?: string;
  pollSeconds?: number;
  log?: (event: string, fields?: Record<string, string | number | boolean | null>) => void;
  /**
   * For integration tests: called once the stack is up and BugBoss is
   * healthy, and the run then ends there, with no alert sent and so no model
   * spend.
   */
  afterBringUp?: (stack: {
    compose: PreparedRun["compose"];
    gateway: ReturnType<typeof gatewayClient>;
    prepared: PreparedRun;
  }) => Promise<void>;
}

export type ModelCredentials = "none" | { profile?: string; roleArn?: string };

export const defaultLog = (event: string, fields: Record<string, string | number | boolean | null> = {}) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

// ------------------------------------------------------------------ images

const imageExists = async (tag: string): Promise<boolean> =>
  run("docker", ["image", "inspect", tag]).then(
    () => true,
    () => false,
  );

const stream = (command: string, args: string[], options: { cwd?: string; input?: Buffer } = {}) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: [options.input ? "pipe" : "ignore", "inherit", "inherit"] });
    if (options.input) child.stdin?.end(options.input);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });

/** The sim's own image, from this working tree. */
export const buildSimImage = async (tag = "bugboss-evals-sim:local"): Promise<string> => {
  await stream("docker", ["build", "-f", join(COMPOSE_DIR, "sim.Dockerfile"), "-t", tag, OPS_ROOT]);
  return tag;
};

/**
 * The variant, built from its own Dockerfile at its own commit and cached by
 * SHA. The image is the whole interface to the variant, so nothing of this
 * working tree goes into it.
 */
export const buildBugbossImage = async (ref: string, opsRoot = OPS_ROOT): Promise<{ tag: string; sha: string }> => {
  const { stdout } = await run("git", ["-C", opsRoot, "rev-parse", `${ref}^{commit}`]);
  const sha = stdout.trim();
  const tag = `bugboss-evals-bugboss:${sha}`;
  if (await imageExists(tag)) return { tag, sha };
  const tree = mkdtempSync(join(tmpdir(), "bugboss-variant-"));
  try {
    const archive = await run("git", ["-C", opsRoot, "archive", "--format=tar", sha], {
      encoding: "buffer",
      maxBuffer: 1 << 30,
    });
    await stream("tar", ["-x", "-C", tree], { input: archive.stdout });
    // tsc runs inside a build container: this is the variant's code, and it
    // should not run on the host that holds the docker socket.
    await stream("docker", [
      "build",
      "-f",
      join(COMPOSE_DIR, "bugboss-dist.Dockerfile"),
      "--output",
      `type=local,dest=${join(tree, "out")}`,
      tree,
    ]);
    renameSync(join(tree, "out", "dist"), join(tree, "dist"));
    await stream("docker", ["build", "-f", join(tree, "bugboss", "Dockerfile"), "-t", tag, tree]);
    return { tag, sha };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
};

/** omni history up to `sha`, as a bundle, cached. Reads the checkout; never writes to it. */
export const omniBundle = async (omniDir: string, sha: string, cacheDir: string): Promise<string> => {
  const out = join(cacheDir, `${sha}.bundle`);
  if (existsSync(out)) return out;
  mkdirSync(cacheDir, { recursive: true });
  const bare = mkdtempSync(join(tmpdir(), "omni-seed-"));
  try {
    await run("git", ["init", "--quiet", "--bare", bare]);
    await run("git", ["-C", bare, "fetch", "--quiet", "--no-tags", resolve(omniDir), `${sha}:refs/heads/main`], {
      maxBuffer: 1 << 26,
    });
    await run("git", ["-C", bare, "bundle", "create", `${out}.part`, "refs/heads/main"], { maxBuffer: 1 << 26 });
    renameSync(`${out}.part`, out);
    return out;
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------- run dir

const secret = (bytes = 24): string => randomBytes(bytes).toString("hex");

export const makeTls = async (dir: string, names: string[] = TLS_NAMES): Promise<void> => {
  mkdirSync(dir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "sim-ca-"));
  try {
    const ca = join(work, "ca.key");
    await run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", ca, "-out", join(dir, "ca.crt"),
      "-days", "7", "-subj", "/CN=bugboss-sim CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    await run("openssl", [
      "req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "server.key"),
      "-out", join(work, "server.csr"), "-subj", "/CN=bugboss-sim",
    ]);
    const ext = join(work, "ext.cnf");
    writeFileSync(
      ext,
      [
        `subjectAltName=${[...names.map((name) => `DNS:${name}`), "IP:127.0.0.1"].join(",")}`,
        "basicConstraints=CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
      ].join("\n"),
    );
    await run("openssl", [
      "x509", "-req", "-in", join(work, "server.csr"), "-CA", join(dir, "ca.crt"), "-CAkey", ca,
      "-CAcreateserial", "-out", join(dir, "server.crt"), "-days", "7", "-extfile", ext,
    ]);
    chmodSync(join(dir, "server.key"), 0o600);
  } finally {
    // The CA key never outlives this function, so nothing in the stack can
    // mint a certificate.
    rmSync(work, { recursive: true, force: true });
  }
};

export interface RunSecrets {
  controlToken: string;
  deployToken: string;
  slackSigningSecret: string;
  slackBotToken: string;
  grafanaWebhookSecret: string;
  grafanaBasicAuthPassword: string;
  grafanaAdminPassword: string;
  personaGithubToken: string;
  checkerGithubToken: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  githubAppPrivateKey: string;
}

export const makeSecrets = (): RunSecrets => ({
  controlToken: secret(),
  deployToken: secret(),
  slackSigningSecret: secret(),
  slackBotToken: `xoxb-sim-${secret(12)}`,
  grafanaWebhookSecret: secret(),
  grafanaBasicAuthPassword: secret(),
  grafanaAdminPassword: secret(),
  personaGithubToken: `ghp_sim${secret(16)}`,
  checkerGithubToken: `ghp_sim${secret(16)}`,
  // MinIO's root credentials as well as BugBoss's: they are fake everywhere
  // else, and MinIO checks the signature.
  awsAccessKeyId: `AKIASIM${randomBytes(6).toString("hex").toUpperCase()}`,
  awsSecretAccessKey: secret(20),
  githubAppPrivateKey: generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey,
});

/** Compose's dotenv: one line per value, single-quoted so nothing is expanded. */
export const dotenv = (values: Record<string, string>): string =>
  Object.entries(values)
    .map(([key, value]) => {
      if (value.includes("'") || value.includes("\n")) {
        throw new Error(`${key} cannot be written to a compose env file as a single-quoted line`);
      }
      return `${key}='${value}'`;
    })
    .join("\n") + "\n";

export interface Subnets {
  sim: string;
  control: string;
}

/** Two /24s no other network on this daemon uses, so parallel runs coexist. */
export const pickSubnets = async (): Promise<Subnets> => {
  const { stdout } = await run("docker", ["network", "ls", "-q"]);
  const ids = stdout.split("\n").filter(Boolean);
  const used = new Set<string>();
  if (ids.length > 0) {
    const inspect = await run("docker", [
      "network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", ...ids,
    ]);
    for (const subnet of inspect.stdout.split(/\s+/).filter(Boolean)) used.add(subnet);
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    const third = 16 + Math.floor(Math.random() * 224);
    const sim = `10.213.${third}`;
    const control = `10.214.${third}`;
    if (!used.has(`${sim}.0/24`) && !used.has(`${control}.0/24`)) return { sim, control };
  }
  throw new Error("no free 10.213.x/10.214.x subnet pair on this docker daemon");
};

export const agentHomeFiles = (secrets: RunSecrets): Record<string, string> => ({
  // The agent's child environment is an allowlist, so these files are what
  // point its AWS CLI, npm, git and uv at the sim whatever the allowlist
  // carries. They are mounted read-only.
  "aws/config": [
    "[default]",
    "region = us-west-2",
    "ca_bundle = /sim/tls/ca.crt",
    "endpoint_url = https://aws:8446",
    "services = sim",
    "",
    "[services sim]",
    "bedrock_runtime =",
    "  endpoint_url = https://proxy:8443",
    "s3 =",
    "  endpoint_url = http://minio:9000",
    "ecs =",
    "  endpoint_url = https://aws:8446",
    "cloudwatch =",
    "  endpoint_url = https://aws:8446",
    "secrets_manager =",
    "  endpoint_url = https://aws:8446",
    "",
  ].join("\n"),
  "aws/credentials": [
    "[default]",
    `aws_access_key_id = ${secrets.awsAccessKeyId}`,
    `aws_secret_access_key = ${secrets.awsSecretAccessKey}`,
    "",
  ].join("\n"),
  "uv.toml": "offline = true\n",
  npmrc: "registry=http://npm:4873/\n",
  gitconfig: "[http]\n\tsslCAInfo = /sim/tls/ca.crt\n",
});

export const bugbossEnv = (args: {
  secrets: RunSecrets;
  grafanaToken: string;
  incidentModelId?: string;
}): Record<string, string> => ({
  ...(args.incidentModelId ? { BUGBOSS_MODEL_ID: args.incidentModelId } : {}),
  PORT: "3000",
  BUGBOSS_LOOPBACK_PORT: "8080",
  BUGBOSS_BUCKET: BUCKET,
  BUGBOSS_SLACK_CHANNEL_ID: CHANNEL,
  SLACK_BOT_USER_ID: "U0BUGBOSS",
  SLACK_ROTATION_GROUP_ID: "S0ROTATION",
  SLACK_API_URL: "https://slack:8445/api/",
  GRAFANA_URL: "http://grafana:3000",
  BUGBOSS_GITHUB_URL: "https://github",
  BUGBOSS_OMNI_REPO: "https://github/thegoodparty/omni.git",
  GITHUB_APP_ID: "1",
  GITHUB_APP_INSTALLATION_ID: "1",
  // The blob form prod uses, which is also the one way a PEM survives an
  // env file: JSON carries the newlines as escapes and settingsEnv parses them.
  BUGBOSS_SECRETS: JSON.stringify({
    SLACK_BOT_TOKEN: args.secrets.slackBotToken,
    SLACK_SIGNING_SECRET: args.secrets.slackSigningSecret,
    GRAFANA_WEBHOOK_SECRET: args.secrets.grafanaWebhookSecret,
    GRAFANA_BASIC_AUTH_PASSWORD: args.secrets.grafanaBasicAuthPassword,
    GRAFANA_SERVICE_ACCOUNT_TOKEN: args.grafanaToken,
    GITHUB_APP_PRIVATE_KEY: args.secrets.githubAppPrivateKey,
  }),
  AWS_REGION: "us-west-2",
  AWS_DEFAULT_REGION: "us-west-2",
  // Fake, and the child inherits them: Pi decides whether Bedrock is usable
  // from the credential variables alone. The proxy drops this signature and
  // re-signs with the only real credentials in the stack. They are also
  // MinIO's root credentials, so BugBoss's S3 state signs correctly.
  AWS_ACCESS_KEY_ID: args.secrets.awsAccessKeyId,
  AWS_SECRET_ACCESS_KEY: args.secrets.awsSecretAccessKey,
  // Everything AWS lands on a stand-in. The catch-all sends any service
  // nobody modelled to the AWS stand-in, which answers AccessDenied, rather
  // than to a name that does not resolve.
  AWS_ENDPOINT_URL: "https://aws:8446",
  AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://proxy:8443",
  AWS_ENDPOINT_URL_S3: "http://minio:9000",
  AWS_ENDPOINT_URL_ECS: "https://aws:8446",
  AWS_ENDPOINT_URL_CLOUDWATCH: "https://aws:8446",
  AWS_ENDPOINT_URL_SECRETS_MANAGER: "https://aws:8446",
  NODE_EXTRA_CA_CERTS: "/sim/tls/ca.crt",
  SSL_CERT_FILE: "/sim/tls/ca.crt",
  GIT_SSL_CAINFO: "/sim/tls/ca.crt",
  AWS_CA_BUNDLE: "/sim/tls/ca.crt",
  npm_config_registry: "http://npm:4873/",
  PRISMA_ENGINES_MIRROR: "http://mirror:4874",
  OMNI_TEST_POSTGRES_URL: "postgresql://test_user:test_password@127.0.0.1:5432/postgres",
});

export interface PreparedRun {
  runDir: string;
  project: string;
  secrets: RunSecrets;
  subnets: Subnets;
  scenario: Scenario;
  scenarioDir: string;
  seed: number;
  alertAt: number;
  compose: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

const copyScenarioPart = (from: string, to: string, include: (relative: string) => boolean) => {
  mkdirSync(to, { recursive: true });
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(from, relative), { withFileTypes: true })) {
      const path = relative ? join(relative, entry.name) : entry.name;
      if (!include(path)) continue;
      if (entry.isDirectory()) {
        mkdirSync(join(to, path), { recursive: true });
        walk(path);
      } else {
        copyFileSync(join(from, path), join(to, path));
      }
    }
  };
  walk("");
};

export const prepareRun = async (spec: RunSpec, now = Date.now()): Promise<PreparedRun> => {
  const { scenario, dir: scenarioDir } = loadScenario(spec.scenarioJson);
  const runDir = join(spec.workRoot, spec.runId);
  const project = `bbsim-${spec.runId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  mkdirSync(runDir, { recursive: true });
  for (const sub of ["results/deploys", "seed", "hooks", "sim", "agent-home/aws"]) {
    mkdirSync(join(runDir, sub), { recursive: true });
  }
  const secrets = makeSecrets();
  await makeTls(join(runDir, "tls"));

  const bundle = join(runDir, "seed", "omni.bundle");
  try {
    linkSync(spec.omniBundle, bundle);
  } catch {
    copyFileSync(spec.omniBundle, bundle);
  }

  for (const file of ["loki.yaml", "prometheus.yml", "tempo.yaml", "verdaccio.yaml"]) {
    copyFileSync(join(COMPOSE_DIR, file), join(runDir, "sim", file));
  }
  cpSync(join(SIM_DIR, "grafana", "provisioning"), join(runDir, "sim", "grafana-provisioning"), { recursive: true });
  copyFileSync(join(COMPOSE_DIR, "stack.yml"), join(runDir, "stack.yml"));

  // Three views of the scenario, so no container holds more of it than it
  // needs. Nothing BugBoss or visible CI can reach holds any of them.
  const hidden = new Set(["check", scenario.reference, scenario.persona.file]);
  copyScenarioPart(scenarioDir, join(runDir, "scenario-public"), (path) => !hidden.has(path.split("/")[0]));
  copyScenarioPart(scenarioDir, join(runDir, "scenario-persona"), (path) => path === scenario.persona.file);
  // The checker's copy keeps the scenarios-root layout, because checks reach
  // shared scripts at ../../_lib from their own directory.
  copyScenarioPart(scenarioDir, join(runDir, "scenario-hidden", scenario.id), (path) => path.split("/")[0] === "check");
  const shared = join(dirname(scenarioDir), "_lib");
  if (existsSync(shared)) cpSync(shared, join(runDir, "scenario-hidden", "_lib"), { recursive: true });

  for (const [path, content] of Object.entries(agentHomeFiles(secrets))) {
    writeFileSync(join(runDir, "agent-home", path), content);
  }

  // The hook runs inside the GitHub stand-in, next to visible CI, so it holds
  // only the deploy token, and the checker refuses any SHA not on main.
  writeFileSync(
    join(runDir, "hooks", "deploy.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      `curl -fsS --max-time ${scenario.check.setupTimeoutSeconds + scenario.check.timeoutSeconds + 300} -X POST \\`,
      `  -H "Authorization: Bearer ${secrets.deployToken}" -H "content-type: application/json" \\`,
      `  --data "{\\"sha\\":\\"$1\\"}" http://checker:9006/deploy > /dev/null`,
      "",
    ].join("\n"),
    // Owner-only: it carries the deploy token, and visible CI runs as another
    // user in the same container.
    { mode: 0o700 },
  );

  const subnets = await pickSubnets();
  const seed = spec.rep;
  const alertAt = now;
  // A directory only the model proxy and the persona mount. It never holds a
  // long-lived key: `credential_process` reads a session the orchestrator
  // writes and refreshes, so neither container needs a profile, an SSO cache
  // or the instance metadata endpoint, and none of those is mounted anywhere.
  const modelAws = join(runDir, "model-aws");
  mkdirSync(modelAws, { recursive: true });
  writeFileSync(
    join(modelAws, "config"),
    ["[default]", "region = us-west-2", `credential_process = cat ${MODEL_SESSION_IN_CONTAINER}`, ""].join("\n"),
  );
  const cacheRoot = join(spec.workRoot, "_cache");
  mkdirSync(join(cacheRoot, "npm"), { recursive: true });
  // Verdaccio runs as uid 10001 and answers 500 to every fetch it cannot
  // cache. A Linux host resolves bind-mount ownership literally, so the
  // directory has to be writable by that user; it holds only public packages.
  chmodSync(join(cacheRoot, "npm"), 0o777);
  mkdirSync(join(cacheRoot, "prisma"), { recursive: true });

  writeFileSync(join(runDir, "bugboss.env"), "");
  writeFileSync(
    join(runDir, ".env"),
    dotenv({
      RUN_DIR: runDir,
      SIM_IMAGE: spec.simImage,
      BUGBOSS_IMAGE: spec.bugbossImage,
      CONTROL_TOKEN: secrets.controlToken,
      DEPLOY_TOKEN: secrets.deployToken,
      SIM_NET: subnets.sim,
      CTL_NET: subnets.control,
      SCENARIO_ID: scenario.id,
      ALERT_AT: String(alertAt),
      SEED: String(seed),
      TELEMETRY_GENERATOR: scenario.telemetry.generator,
      BACKFILL_HOURS: String(scenario.telemetry.backfillHoursBefore),
      AWS_DATA_FILE: scenario.aws.data,
      BUDGET_USD: String(scenario.caps.modelUsd),
      BASE_SHA: scenario.omni.baseSha,
      CI_VISIBLE: JSON.stringify(scenario.ci.visible),
      REVIEWER_REQUEST_CHANGES_ONCE: String(scenario.reviewer.requestChangesOnce),
      GITHUB_ACTIONS_WRITE: scenario.github.actionsWrite ? "true" : "",
      CHECK_SETUP: scenario.check.setup ?? "",
      CHECK_COMMAND: scenario.check.command,
      CHECK_SETUP_TIMEOUT_SECONDS: String(scenario.check.setupTimeoutSeconds),
      CHECK_TIMEOUT_SECONDS: String(scenario.check.timeoutSeconds),
      PERSONA_FILE: scenario.persona.file,
      PERSONA_MODEL: scenario.persona.model,
      PERSONA_REPLY_DELAY_SECONDS: scenario.persona.replyDelaySeconds.join(","),
      PERSONA_MERGE_DELAY_SECONDS: String(scenario.persona.mergeDelaySeconds),
      PERSONA_GITHUB_TOKEN: secrets.personaGithubToken,
      CHECKER_GITHUB_TOKEN: secrets.checkerGithubToken,
      GITHUB_STANDIN_HUMANS: JSON.stringify({
        [secrets.personaGithubToken]: HUMAN_LOGIN,
        [secrets.checkerGithubToken]: DEPLOYER_LOGIN,
      }),
      SLACK_SIGNING_SECRET: secrets.slackSigningSecret,
      SLACK_BOT_TOKEN: secrets.slackBotToken,
      SLACK_CHANNEL_ID: CHANNEL,
      GRAFANA_ADMIN_PASSWORD: secrets.grafanaAdminPassword,
      MINIO_ROOT_USER: secrets.awsAccessKeyId,
      MINIO_ROOT_PASSWORD: secrets.awsSecretAccessKey,
      BUGBOSS_BUCKET: BUCKET,
      NPM_CACHE_DIR: join(cacheRoot, "npm"),
      MIRROR_CACHE_DIR: join(cacheRoot, "prisma"),
    }),
  );

  const compose = (args: string[]) =>
    run(
      "docker",
      ["compose", "-p", project, "-f", join(runDir, "stack.yml"), "--env-file", join(runDir, ".env"), ...args],
      { maxBuffer: 1 << 28 },
    );

  return { runDir, project, secrets, subnets, scenario, scenarioDir, seed, alertAt, compose };
};

// ---------------------------------------------------------------- the run

export const INFRA_SERVICES = [
  "sentinel",
  "gateway",
  "proxy",
  "npm",
  "mirror",
  "loki",
  "prometheus",
  "tempo",
  "grafana",
  "minio",
  "cidb",
  "checkdb",
  "aws",
  "slack",
  "github",
  "telemetry",
  "checker",
];

export const gatewayClient = (base: string, token: string) => {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), "x-sim-token": token },
    });
  const json = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await call(path, init);
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  };
  return { call, json };
};

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const waitFor = async (what: string, probe: () => Promise<boolean>, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = String(error);
    }
    await sleep(1000);
  }
  throw new Error(`${what} was not ready after ${timeoutMs / 1000}s${last ? `: ${last}` : ""}`);
};

/** Grafana's alerting webhook, signed the way bugboss/ingress/grafana.ts verifies it. */
export const signedAlert = (args: {
  body: string;
  secret: string;
  basicAuthPassword: string;
  now: number;
}): Record<string, string> => {
  const stamp = String(Math.floor(args.now / 1000));
  return {
    "content-type": "application/json",
    "X-Grafana-Alerting-Timestamp": stamp,
    "X-Grafana-Alerting-Signature": createHmac("sha256", args.secret).update(`${stamp}:${args.body}`, "utf8").digest("hex"),
    authorization: `Basic ${Buffer.from(`grafana:${args.basicAuthPassword}`).toString("base64")}`,
  };
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The alert as the scenario wrote it, with its firing time moved to now. */
export const alertBody = (raw: string, alertAt: number): string => {
  const iso = new Date(alertAt).toISOString();
  const shift = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(shift);
    if (value && typeof value === "object") {
      const out: { [key: string]: Json } = {};
      for (const [key, inner] of Object.entries(value)) out[key] = key === "startsAt" ? iso : shift(inner);
      return out;
    }
    return value;
  };
  return JSON.stringify(shift(JSON.parse(raw.replaceAll("{{ALERT_AT_ISO}}", iso)) as Json));
};

const MODEL_SESSION_IN_CONTAINER = "/sim/model-aws/session.json";

export interface ModelSession {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export const resolveModelSession = async (access: ModelCredentials): Promise<ModelSession | null> => {
  if (access === "none") return null;
  const base = fromNodeProviderChain(access.profile ? { profile: access.profile } : {});
  const provider = access.roleArn
    ? fromTemporaryCredentials({
        masterCredentials: base,
        // Role chaining caps a session at an hour; the run loop refreshes it.
        params: { RoleArn: access.roleArn, RoleSessionName: "bugboss-eval", DurationSeconds: 3600 },
      })
    : base;
  return provider();
};

/** The shape `credential_process` prints, written whole so a reader never sees half of it. */
export const writeModelSession = (runDir: string, session: ModelSession): void => {
  const path = join(runDir, "model-aws", "session.json");
  writeFileSync(
    `${path}.part`,
    JSON.stringify({
      Version: 1,
      AccessKeyId: session.accessKeyId,
      SecretAccessKey: session.secretAccessKey,
      ...(session.sessionToken ? { SessionToken: session.sessionToken } : {}),
      ...(session.expiration ? { Expiration: session.expiration.toISOString() } : {}),
    }),
    { mode: 0o600 },
  );
  renameSync(`${path}.part`, path);
};

const SESSION_REFRESH_MS = 15 * 60_000;

interface ProxyState {
  spendUsd: number;
  turns: number;
  budgetUsd: number;
  overBudget: boolean;
  lastActivityAt: number | null;
}

export interface SlackState {
  threads: { channel: string; ts: string; messages: { ts: string; user: string; botId?: string; text: string; edits?: { previousText: string }[] }[] }[];
  files: { id: string; filename: string; title: string; content: string; threadTs: string; completed: boolean }[];
  errors: { at: number; method: string; error: string }[];
  lastActivityAt: number | null;
}

interface TelemetryState {
  state: "fault" | "healthy";
}

const INLINE_REPORT = /could not be uploaded, so it is posted here instead|Posted inline: BugBoss has no file upload/;

export const closedBy = (slack: SlackState): EndKind | null => {
  if (slack.files.some((file) => file.completed && /^incident-\d+\.md$/.test(file.filename))) return "closed";
  const inline = slack.threads.some((thread) =>
    thread.messages.some((message) => message.user === "U0BUGBOSS" && INLINE_REPORT.test(message.text)),
  );
  return inline ? "closed_inline" : null;
};

/** Pure, so the end conditions are testable without a stack. */
export const endCondition = (args: {
  now: number;
  firstAlertAt: number;
  caps: Scenario["caps"];
  slack: SlackState;
  proxy: ProxyState;
  lastActivityAt: number;
}): RunEnd | null => {
  const closed = closedBy(args.slack);
  if (closed) return { kind: closed, at: args.now, detail: "closing report in the incident thread" };
  if (args.proxy.overBudget) {
    return { kind: "over_budget", at: args.now, detail: `model spend reached $${args.proxy.budgetUsd}` };
  }
  if (args.now - args.firstAlertAt >= args.caps.wallClockSeconds * 1000) {
    return { kind: "wall_clock", at: args.now, detail: `${args.caps.wallClockSeconds}s wall-clock cap` };
  }
  if (args.now - args.lastActivityAt >= args.caps.quietMinutes * 60_000) {
    return { kind: "stalled", at: args.now, detail: `no model, Slack or GitHub activity for ${args.caps.quietMinutes} minutes` };
  }
  return null;
};

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    : [];

export const runScenario = async (spec: RunSpec): Promise<RunResult> => {
  const log = spec.log ?? defaultLog;
  const startedAt = Date.now();
  const prepared = await prepareRun(spec, startedAt);
  const { compose, runDir, secrets, scenario } = prepared;
  const results = join(runDir, "results");
  const pollMs = (spec.pollSeconds ?? 10) * 1000;
  log("run_prepared", { runId: spec.runId, scenario: scenario.id, project: prepared.project, runDir });

  let end: RunEnd = { kind: "error", at: Date.now(), detail: "the run did not reach its loop" };
  let firstAlertAt: number | null = null;
  let proxy: ProxyState | null = null;
  const states: Record<string, Json> = {};
  let gw: ReturnType<typeof gatewayClient> | null = null;

  const collect = async () => {
    if (!gw) return;
    for (const name of ["proxy", "github", "slack", "aws", "telemetry", "checker"]) {
      try {
        states[name] = await gw.json<Json>(`/${name}/__control/state`);
        writeFileSync(join(results, `state-${name}.json`), JSON.stringify(states[name], null, 2));
      } catch (error) {
        log("state_collect_failed", { service: name, error: String(error) });
      }
    }
  };

  const finish = async (): Promise<RunResult> => {
    await collect();
    try {
      await compose(["stop", "persona"]);
      const logs = await compose(["logs", "--no-color", "--timestamps"]);
      writeFileSync(join(results, "compose.log"), logs.stdout);
    } catch (error) {
      log("log_collect_failed", { error: String(error) });
    }
    await compose(["down", "-v", "--remove-orphans"]).catch((error: Error) =>
      log("teardown_failed", { error: error.message }),
    );
    const proxyState = (states.proxy as unknown as ProxyState | undefined) ?? proxy;
    const inputs: GateInputs = {
      end,
      humans: [HUMAN_LOGIN],
      slack: (states.slack as GateInputs["slack"] | undefined) ?? null,
      github: (states.github as GateInputs["github"] | undefined) ?? null,
      proxy: proxyState,
      telemetry: (states.telemetry as GateInputs["telemetry"] | undefined) ?? null,
      checker: (states.checker as GateInputs["checker"] | undefined) ?? null,
      egress: readJsonl(join(results, "egress-dns.jsonl")),
    };
    const result: RunResult = {
      runId: spec.runId,
      scenario: scenario.id,
      rep: spec.rep,
      seed: prepared.seed,
      bugbossImage: spec.bugbossImage,
      ref: spec.ref ?? null,
      startedAt,
      firstAlertAt,
      end,
      wallClockSeconds: firstAlertAt === null ? null : (end.at - firstAlertAt) / 1000,
      // An over-budget run is recorded at the cap, not at whatever the last
      // throttled request left the counter at.
      costUsd: proxyState ? (end.kind === "over_budget" ? proxyState.budgetUsd : proxyState.spendUsd) : null,
      turns: proxyState?.turns ?? null,
      gates: evaluateGates(inputs),
      resultsDir: results,
    };
    const slackState = (states.slack as unknown as SlackState | undefined) ?? null;
    writeFileSync(join(results, "outputs.json"), JSON.stringify(outputsFor(inputs, slackState, results), null, 2));
    writeFileSync(join(results, "result.json"), JSON.stringify(result, null, 2));
    log("run_finished", { runId: spec.runId, end: end.kind, costUsd: result.costUsd, wallClockSeconds: result.wallClockSeconds });
    return result;
  };

  let session: ModelSession | null = null;
  const refreshSession = async () => {
    if (session && (!session.expiration || session.expiration.getTime() - Date.now() > SESSION_REFRESH_MS)) return;
    session = await resolveModelSession(spec.modelCredentials);
    if (session) writeModelSession(runDir, session);
  };

  try {
    await refreshSession();
    log("model_credentials", { mode: spec.modelCredentials === "none" ? "none" : "resolved" });
    await compose(["up", "-d", "--quiet-pull", "minio-init", "uv-warm", ...INFRA_SERVICES]);
    const { stdout } = await compose(["port", "gateway", "8900"]);
    const base = `http://${stdout.trim().replace("0.0.0.0", "127.0.0.1")}`;
    gw = gatewayClient(base, secrets.controlToken);
    const client = gw;
    for (const name of ["proxy", "github", "slack", "aws", "telemetry", "checker"]) {
      await waitFor(name, async () => (await client.call(`/${name}/__control/health`)).ok, 180_000);
    }
    await waitFor("grafana", async () => (await client.call("/grafana/api/health")).ok, 180_000);
    // `compose wait` finds no container once a one-shot has already exited,
    // so read their exit codes instead.
    for (const service of ["minio-init", "uv-warm"]) {
      let code = "";
      await waitFor(
        service,
        async () => {
          const { stdout } = await compose(["ps", "-a", "--format", "{{.State}} {{.ExitCode}}", service]);
          const [state, exitCode] = stdout.trim().split(" ");
          code = exitCode;
          return state === "exited";
        },
        600_000,
      );
      if (code !== "0") throw new Error(`${service} exited ${code}; its log is in compose.log`);
    }

    const admin = { authorization: `Basic ${Buffer.from(`admin:${secrets.grafanaAdminPassword}`).toString("base64")}`, "content-type": "application/json" };
    const account = await client.json<{ id: number }>("/grafana/api/serviceaccounts", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: "bugboss", role: "Viewer" }),
    });
    const token = await client.json<{ key: string }>(`/grafana/api/serviceaccounts/${account.id}/tokens`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: "bugboss" }),
    });
    writeFileSync(join(runDir, "bugboss.env"), dotenv(bugbossEnv({ secrets, grafanaToken: token.key, incidentModelId: spec.incidentModelId })));

    await compose(["up", "-d", "bugboss", "postgres"]);
    await waitFor("bugboss", async () => (await client.call("/bugboss/health")).ok, 180_000);
    if (spec.afterBringUp) {
      await spec.afterBringUp({ compose, gateway: client, prepared });
      end = { kind: "error", at: Date.now(), detail: "stopped after bring-up, as asked" };
      return await finish();
    }
    await compose(["up", "-d", "persona"]);

    const raw = readFileSync(join(prepared.scenarioDir, scenario.alert.file), "utf8");
    const fire = async () => {
      const now = Date.now();
      const body = alertBody(raw, prepared.alertAt);
      const response = await client.call("/bugboss/grafana", {
        method: "POST",
        headers: signedAlert({
          body,
          secret: secrets.grafanaWebhookSecret,
          basicAuthPassword: secrets.grafanaBasicAuthPassword,
          now,
        }),
        body,
      });
      log("alert_sent", { status: response.status });
      if (!response.ok) throw new Error(`BugBoss refused the alert: ${response.status} ${await response.text()}`);
      return now;
    };
    firstAlertAt = await fire();
    let lastFire = firstAlertAt;
    let lastActivityAt = firstAlertAt;
    let restarted = false;
    const fingerprints: Record<string, string> = {};

    for (;;) {
      await sleep(pollMs);
      await refreshSession();
      const now = Date.now();
      proxy = await client.json<ProxyState>("/proxy/__control/state");
      const slack = await client.json<SlackState>("/slack/__control/state");
      const github = await client.json<Json>("/github/__control/state");
      const telemetry = await client.json<TelemetryState>("/telemetry/__control/state");
      for (const [name, value] of Object.entries({ github: JSON.stringify(github) })) {
        if (fingerprints[name] !== value) {
          fingerprints[name] = value;
          lastActivityAt = Math.max(lastActivityAt, now);
        }
      }
      lastActivityAt = Math.max(lastActivityAt, proxy.lastActivityAt ?? 0, slack.lastActivityAt ?? 0);

      const ended = endCondition({ now, firstAlertAt, caps: scenario.caps, slack, proxy, lastActivityAt });
      if (ended) {
        end = ended;
        break;
      }
      const restartAfter = scenario.chaos.restartBugbossAfterSeconds;
      if (restartAfter !== null && !restarted && now - firstAlertAt >= restartAfter * 1000) {
        restarted = true;
        log("chaos_restart", { afterSeconds: restartAfter });
        // Postgres lives in BugBoss's network namespace, which a restart
        // replaces, so it goes too -- as it does when a deploy replaces the
        // prod task.
        await compose(["restart", "bugboss"]);
        await compose(["restart", "postgres"]);
        // A refire sent before BugBoss is listening again is refused by the
        // gateway, which would end the run on the harness's own restart.
        await waitFor("bugboss after the chaos restart", async () => (await client.call("/bugboss/health")).ok, 180_000);
      }
      const refire = scenario.alert.refireEverySeconds;
      if (refire > 0 && telemetry.state === "fault" && now - lastFire >= refire * 1000) {
        // Only the first alert must land. A refused refire is BugBoss's
        // outcome to record, not a reason for the harness to stop watching.
        lastFire = await fire().catch((error: Error) => {
          log("refire_refused", { error: error.message });
          return now;
        });
      }
    }
    return await finish();
  } catch (error) {
    end = { kind: "error", at: Date.now(), detail: error instanceof Error ? error.message : String(error) };
    log("run_failed", { error: end.detail });
    return await finish();
  }

};

const CLOSING_SUMMARY = /^\*Incident \d+ — closing report\*$/;
// The summary's fixed tail: facts, then work ("N signals · ... agent
// launches"), then spend. The cause is everything between the header and the
// facts line.
const WORK_LINE = /^• [\d,]+ signals? · .* agent launch(es)?$/;
const NO_CAUSE = "No root cause was recorded.";

/**
 * The root cause as a person reads it: the closing summary BugBoss writes in
 * code from the cause `report_root_cause` stored, posted with the report file
 * or, when the upload fails, as thread text split across posts. Null when no
 * summary was posted or it carries no cause.
 */
export const closingSummaryCause = (slack: SlackState): string | null => {
  for (const thread of slack.threads) {
    const bot = thread.messages.filter((message) => message.user === "U0BUGBOSS");
    const start = bot.findIndex((message) => CLOSING_SUMMARY.test(message.text.split("\n")[0]));
    if (start === -1) continue;
    const lines: string[] = [];
    for (const message of bot.slice(start)) {
      lines.push(...message.text.split("\n"));
      const work = lines.findIndex((line) => WORK_LINE.test(line));
      if (work === -1) continue;
      const cause = lines.slice(1, work - 1).join("\n").trim();
      return cause && cause !== NO_CAUSE ? cause : null;
    }
  }
  return null;
};

/**
 * What the judge reads for one side: the thread as people saw it, the fix
 * as merged, and the closing report. Everything else stays in the results
 * directory for a person.
 */
export const outputsFor = (inputs: GateInputs, slack: SlackState | null, resultsDir: string) => {
  const thread = (slack?.threads ?? []).map((t) => ({
    ts: t.ts,
    messages: t.messages.map((m) => ({ user: m.user, text: m.text })),
  }));
  const report = slack?.files.find((file) => /^incident-\d+\.md$/.test(file.filename)) ?? null;
  const merged = (inputs.github?.pulls ?? []).filter((pull) => pull.merged && pull.mergeCommitSha);
  const last = merged[merged.length - 1];
  const diffFile = last?.mergeCommitSha ? join(resultsDir, "deploys", `${last.mergeCommitSha}.diff`) : null;
  const summary = slack ? closingSummaryCause(slack) : null;
  // Only when there is no closing summary: every bot message that names a
  // root cause, which the report flags, because it can include guesses the
  // agent later dropped.
  const heuristic = thread
    .flatMap((t) => t.messages)
    .filter((m) => m.user === "U0BUGBOSS" && /root cause/i.test(m.text) && !CLOSING_SUMMARY.test(m.text.split("\n")[0]))
    .map((m) => m.text);
  const rootCause = summary ?? (heuristic.length > 0 ? heuristic.join("\n\n") : null);
  return {
    thread,
    rootCause,
    rootCauseSource: summary ? ("closing_summary" as const) : heuristic.length > 0 ? ("heuristic" as const) : null,
    closingReport: report ? { filename: report.filename, content: report.content } : null,
    fixDiff: diffFile && existsSync(diffFile) ? readFileSync(diffFile, "utf8") : null,
    mergedPulls: merged.map((pull) => pull.number),
  };
};

export const localDefaults = () => ({
  workRoot: process.env.BUGBOSS_EVALS_WORK ?? join(homedir(), ".cache", "bugboss-evals", "runs"),
  bundleCache: join(homedir(), ".cache", "bugboss-evals", "omni"),
});

export const scenarioJsonFor = (idOrPath: string): string =>
  idOrPath.endsWith(".json") ? resolve(idOrPath) : join(OPS_ROOT, "bugboss-evals", "scenarios", basename(idOrPath), "scenario.json");

export const scenarioDirOf = (scenarioJson: string): string => dirname(scenarioJson);
