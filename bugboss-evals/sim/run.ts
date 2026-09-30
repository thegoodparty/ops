import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import Database from "better-sqlite3";

import { parsePiSession } from "../core/adapters/pi-session";
import { spendOf } from "../core/metrics";
import type { Gates, RunResult, Side } from "../core/report";
import { loadScenario } from "../core/scenario";
import { startS3 } from "./s3";
import {
  checks,
  contains,
  createRunBase,
  createSandbox,
  refSha,
  runBase,
  SANDBOX_URL,
  type Pull,
  type Sandbox,
} from "./sandbox";
import { BOT_USER, CHANNEL, startSlack, type Message } from "./slack";
import { loadGenerator, pushBatch } from "./telemetry/load";
import { createEmitter } from "./telemetry/run";

/**
 * One run, black box: a BugBoss built from one ref, one scenario, its own
 * Grafana org, S3, Slack, Postgres and sandbox base. The harness plays the
 * on-call human and the reviewer, merges when CI is green, runs the hidden
 * check on what merged, and flips the telemetry healthy when it passes.
 */

export interface Stack {
  grafanaUrl: string;
  grafanaAdmin: string;
  /** How Grafana, inside the compose network, reaches the backends. */
  internal: { loki: string; prometheus: string; tempo: string };
  /** How this process pushes telemetry. */
  lokiUrl: string;
  prometheusUrl: string;
}

export interface RunSpec {
  runId: string;
  scenarioId: string;
  rep: number;
  side: Side;
  ref: string;
  /** A checkout of `ref` with `dist/` built. */
  bugbossDir: string;
  root: string;
  stack: Stack;
  tokenFile: string;
  /** A container credential endpoint (AWS_CONTAINER_CREDENTIALS_FULL_URI). */
  awsCredentialsUrl: string;
  /** Set only for the zero-spend proof. */
  stubModelUrl?: string;
  /** Run BugBoss and the hidden check as this user, which holds no secrets. */
  runAs?: string;
  seed: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address !== "string" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

/**
 * With `runAs`, the command runs as a user that holds nothing: not the App
 * key, not the workflow's token, not the runner's sudo. umask 0 so the
 * harness, as the runner, can still read and write what it leaves behind.
 */
const asUser = (runAs: string | undefined, command: string, args: string[], env: Record<string, string>) =>
  runAs
    ? {
        command: "sudo",
        args: ["-u", runAs, "env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "sh", "-c", 'umask 0; exec "$0" "$@"', command, ...args],
        env: undefined,
      }
    : { command, args, env };

const shareWith = async (runAs: string | undefined, path: string): Promise<void> => {
  if (runAs) await exec("chmod", ["-R", "a+rwX", path]);
};

const grafana = async <T>(stack: Stack, path: string, init: { method?: string; body?: unknown; org?: number } = {}): Promise<T> => {
  const res = await fetch(`${stack.grafanaUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Basic ${Buffer.from(`admin:${stack.grafanaAdmin}`).toString("base64")}`,
      "content-type": "application/json",
      ...(init.org ? { "x-grafana-org-id": String(init.org) } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!res.ok) throw new Error(`grafana ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

/** A Grafana org of the run's own, with production's datasource uids, and a viewer token in it. */
const grafanaOrg = async (stack: Stack, runId: string): Promise<string> => {
  const { orgId } = await grafana<{ orgId: number }>(stack, "/api/orgs", { method: "POST", body: { name: runId } });
  const tenant = (header: string) => ({ jsonData: { httpHeaderName1: header }, secureJsonData: { httpHeaderValue1: runId } });
  for (const ds of [
    { name: "grafanacloud-logs", uid: "grafanacloud-logs", type: "loki", url: stack.internal.loki, ...tenant("X-Scope-OrgID") },
    { name: "grafanacloud-prom", uid: "grafanacloud-prom", type: "prometheus", url: stack.internal.prometheus, isDefault: true, ...tenant("X-Eval-Run") },
    { name: "grafanacloud-traces", uid: "grafanacloud-traces", type: "tempo", url: stack.internal.tempo, ...tenant("X-Scope-OrgID") },
  ]) {
    await grafana(stack, "/api/datasources", { method: "POST", org: orgId, body: { access: "proxy", ...ds } });
  }
  const account = await grafana<{ id: number }>(stack, "/api/serviceaccounts", {
    method: "POST",
    org: orgId,
    body: { name: "bugboss", role: "Viewer" },
  });
  const { key } = await grafana<{ key: string }>(stack, `/api/serviceaccounts/${account.id}/tokens`, {
    method: "POST",
    org: orgId,
    body: { name: "bugboss" },
  });
  return key;
};

/**
 * omni's ship-pr opens every PR with `--base main`, so the agent's clone has
 * to see its run's base as main. The hook runs once, at the end of the clone,
 * and points the checkout's main and origin/main at the run's own branch.
 */
const writeHome = (home: string, runId: string): void => {
  mkdirSync(join(home, "hooks"), { recursive: true });
  const hook = join(home, "hooks", "post-checkout");
  writeFileSync(
    hook,
    `#!/bin/sh
[ "$1" = "0000000000000000000000000000000000000000" ] || exit 0
git config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git config --add remote.origin.fetch '^refs/heads/main'
git config --add remote.origin.fetch '+refs/heads/${runBase(runId)}:refs/remotes/origin/main'
git fetch -q origin && git checkout -q -B main origin/main
`,
  );
  chmodSync(hook, 0o755);
  // The empty helper clears any the system config names (the macOS keychain,
  // on a Mac), for the Boss and every agent under this HOME. BugBoss adds its
  // own helper for github.com after it.
  writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${join(home, "hooks")}\n[credential]\n\thelper =\n`);
};

const startPostgres = (runId: string): { url: string; stop: () => void } => {
  const name = `evb-pg-${runId}`;
  const run = spawnSync("docker", ["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`postgres: ${run.stderr}`);
  const port = spawnSync("docker", ["port", name, "5432"], { encoding: "utf8" }).stdout.trim().split(":").pop();
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: () => void spawnSync("docker", ["rm", "-f", name]),
  };
};

const sendAlert = async (url: string, secret: string, body: unknown): Promise<void> => {
  const raw = JSON.stringify(body);
  const stamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${url}/grafana`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Grafana-Alerting-Timestamp": stamp,
      "X-Grafana-Alerting-Signature": createHmac("sha256", secret).update(`${stamp}:${raw}`, "utf8").digest("hex"),
      authorization: `Basic ${Buffer.from(`grafana:${secret}`).toString("base64")}`,
    },
    body: raw,
  });
  if (!res.ok) throw new Error(`BugBoss refused the alert: ${res.status} ${await res.text()}`);
};

const DONT_KNOW = "I don't know more, proceed.";

/** The scripted human's reply: every fact the question matches, once each. */
export const humanReply = (question: string, facts: { when: string; say: string }[], said: Set<string>): string => {
  const fresh = facts.filter((f) => new RegExp(f.when, "i").test(question) && !said.has(f.say));
  for (const f of fresh) said.add(f.say);
  return fresh.length ? fresh.map((f) => f.say).join(" ") : DONT_KNOW;
};

const MAX_HUMAN_REPLIES = 20;

interface IncidentRow {
  id: string;
  status: string;
  rootCause: string | null;
  postmortem: string | null;
  closedAt: number | null;
}

const readIncident = (dbPath: string): IncidentRow | null => {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (
      (db
        .prepare("SELECT id, status, rootCause, postmortem, closedAt FROM incident WHERE mergedInto IS NULL ORDER BY firstSignalAt LIMIT 1")
        .get() as IncidentRow | undefined) ?? null
    );
  } catch {
    return null;
  } finally {
    db.close();
  }
};

const sessionsUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sessionsUnder(path) : path.endsWith(".jsonl") ? [path] : [];
      })
    : [];

const exec = (command: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number; log?: string } = {}): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => out.push(c));
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (options.log) writeFileSync(options.log, Buffer.concat(out));
      resolve(code);
    });
  });

/** Merge means deploy: clone what merged and run the hidden check against it. */
const hiddenCheck = async (spec: RunSpec, scenarioDir: string, check: { setup: string; command: string; timeoutSeconds: number }, sha: string, env: Record<string, string>): Promise<boolean> => {
  const dir = join(spec.root, "deploy");
  const token = readFileSync(spec.tokenFile, "utf8").trim();
  const auth = `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  if ((await exec("git", ["-c", "credential.helper=", "-c", auth, "clone", "-q", "--filter=blob:none", "--no-checkout", SANDBOX_URL, dir])) !== 0) return false;
  if ((await exec("git", ["-C", dir, "-c", "credential.helper=", "-c", auth, "checkout", "-q", sha])) !== 0) return false;
  await shareWith(spec.runAs, dir);
  for (const [step, timeout] of [
    [check.setup, 1800],
    [check.command, check.timeoutSeconds],
  ] as const) {
    const { command, args, env: stepEnv } = asUser(spec.runAs, "bash", [join(scenarioDir, step), sha, dir], env);
    const code = await exec(command, args, {
      env: stepEnv ?? env,
      timeoutMs: timeout * 1000,
      log: join(spec.root, `check-${step.replace(/\W/g, "_")}.log`),
    });
    if (code !== 0) {
      spec.log("check_failed", { step, code });
      return false;
    }
  }
  return true;
};

export const runOne = async (spec: RunSpec): Promise<RunResult> => {
  const { scenario, dir: scenarioDir } = loadScenario(spec.scenarioId);
  const home = join(spec.root, "home");
  const work = join(spec.root, "work");
  const s3Root = join(spec.root, "s3");
  const dbPath = join(spec.root, "bugboss.db");
  for (const d of [home, work, s3Root]) mkdirSync(d, { recursive: true });
  writeHome(home, spec.runId);

  const sandbox: Sandbox = createSandbox(() => readFileSync(spec.tokenFile, "utf8").trim());
  const mainAtStart = await refSha(sandbox, "main");
  const baseSha = await createRunBase(sandbox, scenario.id, spec.runId);
  const grafanaToken = await grafanaOrg(spec.stack, spec.runId);

  const generator = await loadGenerator(scenarioDir, scenario.telemetry.generator);
  const alertAt = Date.now();
  const emitter = createEmitter({
    generator,
    alertAt,
    hoursBefore: scenario.telemetry.backfillHoursBefore,
    seed: spec.seed,
    push: (batch) => pushBatch({ lokiUrl: spec.stack.lokiUrl, prometheusUrl: spec.stack.prometheusUrl, tenant: spec.runId }, batch),
  });
  await emitter.backfill();

  const postgres = startPostgres(spec.runId);
  const s3 = await startS3(s3Root);
  const [port, loopbackPort] = [await freePort(), await freePort()];
  const secrets = { bot: `xoxb-${randomBytes(12).toString("hex")}`, signing: randomBytes(16).toString("hex"), grafana: randomBytes(16).toString("hex") };

  const bossUrl = `http://127.0.0.1:${port}`;
  const questions: Message[] = [];
  const slack = await startSlack({
    botToken: secrets.bot,
    signingSecret: secrets.signing,
    eventsUrl: `${bossUrl}/slack`,
    onBotMessage: (m) => {
      if (m.text.includes("?")) questions.push(m);
    },
  });

  await shareWith(spec.runAs, spec.root);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    PORT: String(port),
    BUGBOSS_LOOPBACK_PORT: String(loopbackPort),
    BUGBOSS_BUCKET: "bugboss-eval",
    BUGBOSS_DB_PATH: dbPath,
    BUGBOSS_SLACK_CHANNEL_ID: CHANNEL,
    BUGBOSS_TICK_SECONDS: "10",
    BUGBOSS_OMNI_REPO: SANDBOX_URL,
    BUGBOSS_WORK_ROOT: work,
    BUGBOSS_GITHUB_TOKEN_FILE: spec.tokenFile,
    SLACK_BOT_TOKEN: secrets.bot,
    SLACK_SIGNING_SECRET: secrets.signing,
    SLACK_BOT_USER_ID: BOT_USER,
    SLACK_API_URL: slack.apiUrl,
    GRAFANA_URL: spec.stack.grafanaUrl,
    GRAFANA_SERVICE_ACCOUNT_TOKEN: grafanaToken,
    GRAFANA_WEBHOOK_SECRET: secrets.grafana,
    AWS_REGION: "us-west-2",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: spec.awsCredentialsUrl,
    AWS_ENDPOINT_URL_S3: s3.url,
    OMNI_TEST_POSTGRES_URL: postgres.url,
    ...(spec.stubModelUrl ? { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: spec.stubModelUrl } : {}),
  };

  const launch = asUser(spec.runAs, "node", [join(spec.bugbossDir, "dist", "bugboss", "index.js")], env);
  const logFd = join(spec.root, "bugboss.log");
  writeFileSync(logFd, "");
  const boss: ChildProcess = spawn(launch.command, launch.args, {
    env: launch.env ?? process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => writeFileSync(logFd, chunk, { flag: "a" });
  boss.stdout?.on("data", append);
  boss.stderr?.on("data", append);
  let exited: string | null = null;
  boss.on("exit", (code, signal) => (exited = `BugBoss exited ${code ?? signal}`));

  const pulls = new Map<number, { reviewedSha: string | null; reviewAsks: number; mergedGreen: boolean | null }>();
  let fixed: boolean | null = null;
  let deploying: Promise<void> | null = null;
  let end = "wall_clock";
  let closedAt: number | null = null;
  const said = new Set<string>();
  let replies = 0;
  const deadline = alertAt + scenario.wallClockSeconds * 1000;
  let lastAlert = 0;

  try {
    for (let i = 0; ; i++) {
      if (i > 60) throw new Error("BugBoss never answered /health");
      if (exited) throw new Error(exited);
      if (await fetch(`${bossUrl}/health`).then((r) => r.ok, () => false)) break;
      await sleep(2000);
    }
    const alertBody = JSON.parse(readFileSync(join(scenarioDir, scenario.alert.file), "utf8"));
    for (const a of alertBody.alerts ?? []) a.startsAt = new Date(alertAt).toISOString();
    spec.log("run_started", { runId: spec.runId });

    while (Date.now() < deadline) {
      if (exited) {
        end = `error: ${exited}`;
        break;
      }
      await emitter.tick();
      if (fixed !== true && Date.now() - lastAlert >= scenario.alert.refireEverySeconds * 1000) {
        await sendAlert(bossUrl, secrets.grafana, alertBody).catch((e: unknown) => spec.log("alert_failed", { error: String(e) }));
        lastAlert = Date.now();
      }

      for (const question of questions.splice(0)) {
        if (replies >= MAX_HUMAN_REPLIES) break;
        replies += 1;
        await slack
          .say(question.threadTs ?? question.ts, humanReply(question.text, scenario.human.facts, said))
          .catch((e: unknown) => spec.log("human_reply_failed", { error: String(e) }));
      }

      await driveGitHub({ sandbox, spec, baseSha, pulls, onMerged: (sha) => {
        if (deploying) return;
        spec.log("deploying", { sha });
        deploying = hiddenCheck(spec, scenarioDir, scenario.check, sha, { PATH: env.PATH, HOME: home, OMNI_TEST_POSTGRES_URL: postgres.url }).then((passed) => {
          fixed = passed;
          spec.log("deployed", { fixed });
          if (passed) emitter.setState("healthy");
        });
      } }).catch((e: unknown) => spec.log("github_step_failed", { error: String(e) }));

      const incident = readIncident(dbPath);
      if (incident?.status === "CLOSED") {
        end = "closed";
        closedAt = incident.closedAt;
        break;
      }
      await sleep(15_000);
    }
  } catch (error: unknown) {
    end = `error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // Give the Boss a moment to roll the session up, then stop everything.
    await sleep(5000);
    await deploying;
    if (boss.pid) {
      try {
        process.kill(-boss.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    slack.close();
    s3.server.close();
    postgres.stop();
  }

  const incident = readIncident(dbPath);
  const merged = [...pulls.entries()].filter(([, p]) => p.mergedGreen !== null);
  const baseNow = await refSha(sandbox, runBase(spec.runId)).catch(() => "unknown");
  const mergeCommits = await Promise.all(merged.map(async ([n]) => (await sandbox.call<Pull>(`/pulls/${n}`)).merge_commit_sha));
  const gates: Gates = {
    closed: incident?.status === "CLOSED",
    fixed,
    mergedGreen: merged.every(([, p]) => p.mergedGreen === true),
    noPushToMain:
      (await refSha(sandbox, "main").catch(() => "unknown")) === mainAtStart &&
      (baseNow === baseSha || mergeCommits.includes(baseNow)),
  };
  const diff =
    baseNow !== baseSha && baseNow !== "unknown"
      ? await fetch(`https://api.github.com/repos/thegoodparty/bugboss-eval-sandbox/compare/${baseSha}...${baseNow}`, {
          headers: { accept: "application/vnd.github.diff", authorization: `Bearer ${readFileSync(spec.tokenFile, "utf8").trim()}` },
        }).then((r) => (r.ok ? r.text() : null))
      : null;
  const traces = sessionsUnder(s3Root).map((path) => parsePiSession(path, readFileSync(path, "utf8")));

  const result: RunResult = {
    runId: spec.runId,
    scenario: scenario.id,
    rep: spec.rep,
    side: spec.side,
    ref: spec.ref,
    end,
    gates,
    spend: spendOf(traces),
    wallClockSeconds: closedAt ? Math.round((closedAt - alertAt) / 1000) : null,
    output: { rootCause: incident?.rootCause ?? null, diff, postmortem: incident?.postmortem ?? null },
  };
  writeFileSync(join(spec.root, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(spec.root, "slack.json"), JSON.stringify(slack.messages, null, 2));
  spec.log("run_finished", { runId: spec.runId, end, gates });
  return result;
};

const REVIEW_BODY = "Approved.\n\nRecommendation: approve";

/**
 * The reviewer and the human's merge. A PR opened against main that carries
 * this run's base is moved onto the run's own branch; every new head, and
 * every `delegate review` ask, gets an approving review; an approved PR whose
 * checks are green at its head is merged, which is the deploy.
 */
const driveGitHub = async (args: {
  sandbox: Sandbox;
  spec: RunSpec;
  baseSha: string;
  pulls: Map<number, { reviewedSha: string | null; reviewAsks: number; mergedGreen: boolean | null }>;
  onMerged: (sha: string) => void;
}): Promise<void> => {
  const { sandbox, spec, baseSha, pulls } = args;
  const open = await sandbox.call<Pull[]>("/pulls?state=open&per_page=100");
  for (const pull of open) {
    if (pulls.has(pull.number) || (pull.base.ref !== "main" && pull.base.ref !== runBase(spec.runId))) continue;
    if (!(await contains(sandbox, baseSha, pull.head.sha))) continue;
    if (pull.base.ref === "main") {
      await sandbox.call(`/pulls/${pull.number}`, { method: "PATCH", body: { base: runBase(spec.runId) } });
    }
    pulls.set(pull.number, { reviewedSha: null, reviewAsks: 0, mergedGreen: null });
    spec.log("pr_claimed", { number: pull.number });
  }
  for (const [number, state] of pulls) {
    if (state.mergedGreen !== null) continue;
    const pull = await sandbox.call<Pull>(`/pulls/${number}`);
    if (pull.merged_at) {
      // Merged by something other than the harness.
      state.mergedGreen = (await checks(sandbox, pull.head.sha)) === "green";
      args.onMerged(pull.merge_commit_sha ?? pull.head.sha);
      continue;
    }
    if (pull.state !== "open") continue;
    const comments = await sandbox.call<Array<{ body: string }>>(`/issues/${number}/comments?per_page=100`);
    const asks = comments.filter((c) => c.body.trim() === "delegate review").length;
    if (state.reviewedSha !== pull.head.sha || asks > state.reviewAsks) {
      await sandbox.call(`/pulls/${number}/reviews`, {
        method: "POST",
        body: { commit_id: pull.head.sha, event: "COMMENT", body: REVIEW_BODY },
      });
      state.reviewedSha = pull.head.sha;
      state.reviewAsks = asks;
      continue;
    }
    if ((await checks(sandbox, pull.head.sha)) !== "green") continue;
    const merged = await sandbox.call<{ sha: string }>(`/pulls/${number}/merge`, {
      method: "PUT",
      body: { sha: pull.head.sha, merge_method: "merge" },
    });
    state.mergedGreen = true;
    spec.log("pr_merged", { number, sha: merged.sha });
    args.onMerged(merged.sha);
  }
};
