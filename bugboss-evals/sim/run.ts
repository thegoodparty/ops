import { execFile, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { Activity, ActivityEvent } from "../core/activity";
import { tracesFromProxyLog } from "../core/adapters/proxy-log";
import { spendOf, ZERO_SPEND } from "../core/metrics";
import type { Gates, Milestone, RunResult, Side } from "../core/report";
import { loadScenario, type VolunteerMilestone } from "../core/scenario";
import type { CiResult } from "./github/store";
import { due, humanReply } from "./human";
import { modelProxyEnv, startModelProxy, type ModelProxy } from "./model-proxy";
import type { Runtime, RuntimeBuild, RuntimeLaunch } from "./runtimes/types";
import { startS3 } from "./s3";
import {
  checks,
  contains,
  createRunBase,
  createSandbox,
  refSha,
  runBase,
  SANDBOX_URL,
  type CheckState,
  type Pull,
  type Sandbox,
} from "./sandbox";
import { BOT_USER, CHANNEL, startSlack, type Message } from "./slack";
import { loadGenerator, pushBatch } from "./telemetry/load";
import { createEmitter } from "./telemetry/run";

/**
 * One run, black box: one runtime built from one ref, one scenario, its own
 * Grafana org, S3, Slack, Postgres, model proxy and sandbox base. The harness
 * plays the on-call human and the reviewer, runs the sandbox's CI, merges when
 * it is green, runs the hidden check on what merged, and flips the telemetry
 * healthy when it passes. Everything it observes of the system is what the
 * world saw, recorded as the run's activity for the judge.
 */

const SETUP_OMNI = join(__dirname, "..", "scenarios", "_lib", "setup-omni.sh");

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
  runtime: Runtime;
  /** `runtime.build(ref)`, done once per side. */
  build: RuntimeBuild;
  root: string;
  stack: Stack;
  /** The file the system reads its GitHub token from. The fake takes any token. */
  tokenFile: string;
  /**
   * The fake github.com: the CA it serves with, the sandbox's bare repository
   * on disk, and `onCi`, which hands the fake this run's CI for every commit
   * on top of `baseSha`. It returns the unregister.
   */
  github: {
    caFile: string;
    repo: string;
    onCi: (baseSha: string, run: (sha: string) => Promise<CiResult>) => () => void;
    /** Pushes one unrelated commit onto `branch` and from then on refuses to merge a PR behind it. Returns the new tip. */
    moveBase: (branch: string) => Promise<string>;
  };
  /** A container credential endpoint (AWS_CONTAINER_CREDENTIALS_FULL_URI). Fake: nothing the system reaches checks a signature. */
  awsCredentialsUrl: string;
  /** The one real credential. Only the model proxy holds it; the system under test never sees it. */
  anthropicApiKey: string;
  /** Run the system, the sandbox's CI and the hidden check as this user, which holds no secrets. */
  runAs?: string;
  /** Where a run stops. `closed` is the whole lifecycle. */
  until?: Milestone;
  /** Ends the run sooner than the scenario's own wall clock: PR CI's bound, so a broken run fails in minutes. */
  maxRunSeconds?: number;
  /** A shared npm cache, warmed once, every run's HOME points at. */
  npmCache?: string;
  /** An omni tree at the scenario's base with its dependencies built, which the hidden check copies from. */
  prebuilt?: string;
  /** The job's spend, shared by every run in it. */
  spend?: SpendPool;
  seed: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export type { Milestone };

/**
 * Every run in a job reports its live spend here; once the total reaches the
 * stop point every run ends with `spend_cap`. In-flight turns land after the
 * stop, so the stop sits below the cap.
 */
export interface SpendPool {
  record: (runId: string, usd: number) => void;
  exhausted: () => boolean;
}

export const createSpendPool = (capUsd: number, stopAt = 0.9): SpendPool => {
  const spent = new Map<string, number>();
  return {
    record: (runId, usd) => void spent.set(runId, usd),
    exhausted: () => [...spent.values()].reduce((a, b) => a + b, 0) >= capUsd * stopAt,
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Both sides of a pair ask at once, and the OS can hand both the same port
// between one's close and the other's listen.
const handedOut = new Set<number>();
const freePort = async (): Promise<number> => {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => (address && typeof address !== "string" ? resolve(address.port) : reject(new Error("no port"))));
      });
    });
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
};

/**
 * With `runAs`, the command runs as a user that holds nothing: not the
 * workflow's token, not the AWS role, not the runner's sudo. umask 0 so the
 * harness, as the runner, can still read and write what it leaves behind.
 */
export const asUser = (runAs: string | undefined, command: string, args: string[], env: Record<string, string>) =>
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
const writeHome = (home: string, runId: string, npmCache?: string): void => {
  mkdirSync(join(home, "hooks"), { recursive: true });
  if (npmCache) symlinkSync(npmCache, join(home, ".npm"));
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
  // on a Mac), for everything the system runs under this HOME. The system
  // adds its own helper for github.com after it.
  writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${join(home, "hooks")}\n[credential]\n\thelper =\n`);
};

/**
 * Async on purpose: the fake GitHub serves from this process, so a
 * synchronous child call stalls every git and gh request of every run.
 */
const capture = (command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) =>
    execFile(command, args, { encoding: "utf8", maxBuffer: 1 << 28 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    ),
  );

const startPostgres = async (runId: string): Promise<{ url: string; stop: () => Promise<unknown> }> => {
  const name = `evb-pg-${runId}`;
  const run = await capture("docker", ["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
  if (run.code !== 0) throw new Error(`postgres: ${run.stderr}`);
  const port = (await capture("docker", ["port", name, "5432"])).stdout.trim().split(":").pop();
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: () => capture("docker", ["rm", "-f", name]),
  };
};

const sendAlert = async (url: string, secret: string, body: unknown): Promise<void> => {
  const raw = JSON.stringify(body);
  const stamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Grafana-Alerting-Timestamp": stamp,
      "X-Grafana-Alerting-Signature": createHmac("sha256", secret).update(`${stamp}:${raw}`, "utf8").digest("hex"),
      authorization: `Basic ${Buffer.from(`grafana:${secret}`).toString("base64")}`,
    },
    body: raw,
  });
  if (!res.ok) throw new Error(`the system refused the alert: ${res.status} ${await res.text()}`);
};

const MAX_HUMAN_REPLIES = 20;

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

/** A checkout of `sha` from the sandbox's repository on disk, for the run-as user. */
const checkout = async (spec: RunSpec, sha: string, dir: string): Promise<boolean> => {
  if ((await exec("git", ["clone", "-q", "--no-checkout", spec.github.repo, dir])) !== 0) return false;
  if ((await exec("git", ["-C", dir, "checkout", "-q", sha])) !== 0) return false;
  await shareWith(spec.runAs, dir);
  return true;
};

/**
 * The sandbox's visible CI, which the fake runs for every new PR head: the
 * scenario's `ci` commands in a checkout of the head, with omni's
 * dependencies hardlinked from the prebuilt tree.
 */
const visibleCi = async (spec: RunSpec, commands: string[], sha: string, env: Record<string, string>): Promise<CiResult> => {
  const dir = join(spec.root, `ci-${sha.slice(0, 12)}-${Date.now().toString(36)}`);
  const log = (step: string) => join(spec.root, `${dir.split("/").pop()}-${step}.log`);
  if (!(await checkout(spec, sha, dir))) return false;
  spec.log("ci_started", { sha });
  const steps = [["setup", `bash ${SETUP_OMNI} .`], ...commands.map((command, i) => [String(i + 1), command])];
  for (const [step, command] of steps) {
    const { command: cmd, args, env: stepEnv } = asUser(spec.runAs, "bash", ["-c", `cd ${dir} && ${command}`], env);
    const code = await exec(cmd, args, { env: stepEnv ?? env, timeoutMs: 1800_000, log: log(step) });
    if (code !== 0) {
      spec.log("ci_finished", { sha, passed: false, step: command, code });
      return { success: false, log: `$ ${command}\n${readFileSync(log(step), "utf8")}` };
    }
  }
  spec.log("ci_finished", { sha, passed: true });
  return { success: true, log: commands.map((c) => `$ ${c}`).join("\n") };
};

/** Merge means deploy: check out what merged and run the hidden check against it. */
const hiddenCheck = async (spec: RunSpec, scenarioDir: string, check: { setup: string; command: string; timeoutSeconds: number }, sha: string, env: Record<string, string>): Promise<boolean> => {
  const dir = join(spec.root, `deploy-${sha.slice(0, 12)}`);
  if (!(await checkout(spec, sha, dir))) return false;
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
  const stateDir = join(spec.root, "state");
  for (const d of [home, work, s3Root, stateDir]) mkdirSync(d, { recursive: true });
  writeHome(home, spec.runId, spec.npmCache);

  const sandbox = createSandbox();
  const mainAtStart = await refSha(sandbox, "main");
  const baseSha = await createRunBase(sandbox, scenario.id, spec.runId);
  const until: Milestone = spec.until ?? "closed";
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

  // What the world saw, in order. The judge reads this and nothing else of the run.
  const events: ActivityEvent[] = [];
  const record = (event: ActivityEvent): void => void events.push(event);

  const postgres = await startPostgres(spec.runId);
  const s3 = await startS3(s3Root);
  const [port, spare] = [await freePort(), await freePort()];
  const secrets = { bot: `xoxb-${randomBytes(12).toString("hex")}`, signing: randomBytes(16).toString("hex"), grafana: randomBytes(16).toString("hex") };

  let launched: RuntimeLaunch | null = null;
  const questions: Message[] = [];
  const slack = await startSlack({
    botToken: secrets.bot,
    signingSecret: secrets.signing,
    eventsUrl: () => {
      if (!launched?.slackEventsUrl) throw new Error("the runtime takes no Slack events over HTTP");
      return launched.slackEventsUrl;
    },
    onBotMessage: (m) => {
      if (m.text.includes("?")) questions.push(m);
    },
  });

  // The system never reaches AWS: the region only lets its SDK build clients.
  const region = "us-west-2";
  const proxy: ModelProxy = await startModelProxy({
    upstream: "anthropic",
    face: spec.runtime.modelProtocol,
    apiKey: spec.anthropicApiKey,
    logPath: join(spec.root, "proxy.jsonl"),
  });

  await shareWith(spec.runAs, spec.root);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    ...modelProxyEnv(proxy, spec.runtime.modelProtocol),
  };

  const checkEnv: Record<string, string> = {
    PATH: env.PATH,
    HOME: home,
    OMNI_TEST_POSTGRES_URL: postgres.url,
    ...(spec.prebuilt ? { OMNI_PREBUILT: spec.prebuilt } : {}),
  };
  // gp-api's eslint runs out of the default 2 GB heap.
  const unregisterCi = spec.github.onCi(baseSha, (sha) => visibleCi(spec, scenario.ci, sha, { ...checkEnv, NODE_OPTIONS: "--max-old-space-size=6144" }));

  launched = await spec.runtime.launch({
    build: spec.build,
    env,
    ports: { http: port, spare: [spare] },
    workRoot: work,
    world: {
      slack: { apiUrl: slack.apiUrl, botToken: secrets.bot, signingSecret: secrets.signing, botUserId: BOT_USER, channel: CHANNEL },
      grafana: { url: spec.stack.grafanaUrl, serviceAccountToken: grafanaToken, webhookSecret: secrets.grafana },
      github: { repoUrl: SANDBOX_URL, tokenFile: spec.tokenFile, caFile: spec.github.caFile },
      aws: { region, credentialsUrl: spec.awsCredentialsUrl, s3Url: s3.url },
      postgresUrl: postgres.url,
      stateDir,
    },
    ...(spec.runAs ? { runAs: spec.runAs } : {}),
  });
  const system = launched;
  let exited: string | null = null;
  system.child.on("exit", (code, signal) => (exited = `the system exited ${code ?? signal}`));

  const pulls = new Map<number, PullState>();
  let fixed: boolean | null = null;
  let deploying: Promise<void> | null = null;
  let latestMerge: string | null = null;
  // A follow-up PR that merges while a check runs is checked once that check
  // ends; the newest merge is what is deployed.
  const deploy = (): void => {
    const sha = latestMerge;
    if (deploying || !sha) return;
    spec.log("deploying", { sha });
    deploying = hiddenCheck(spec, scenarioDir, scenario.check, sha, checkEnv)
      .then((passed) => {
        fixed = passed;
        record({ at: Date.now(), kind: "check_result", passed });
        spec.log("deployed", { sha, fixed });
        emitter.setState(passed ? "healthy" : "fault");
      })
      .finally(() => {
        deploying = null;
        if (latestMerge !== sha) deploy();
      });
  };
  let end = "wall_clock";
  let closedAt: number | null = null;
  const said = new Set<string>();
  let replies = 0;
  let prOpenedAt: number | null = null;
  let mergedAt: number | null = null;
  let mergeAskedAt: number | null = null;
  const reached = new Set<VolunteerMilestone>();
  const volunteeredSaid = new Set<string>();
  let movedBase: string | null = null;
  const deadline = alertAt + Math.min(scenario.wallClockSeconds, spec.maxRunSeconds ?? Infinity) * 1000;
  let lastAlert = 0;

  try {
    for (let i = 0; ; i++) {
      if (i > 60) throw new Error("the system never answered its health check");
      if (exited) throw new Error(exited);
      if (await fetch(system.healthUrl).then((r) => r.ok, () => false)) break;
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
        const refire = lastAlert !== 0;
        await sendAlert(system.alertUrl, secrets.grafana, alertBody).then(
          () => record({ at: Date.now(), kind: "alert_fired", refire }),
          (e: unknown) => spec.log("alert_failed", { error: String(e) }),
        );
        lastAlert = Date.now();
      }

      // Everything the world does to the run this tick: the on-call human in
      // Slack, the reviewer and the merging human on GitHub, the scenario's
      // world events, then the human's volunteered lines.
      for (const question of questions.splice(0)) {
        if (replies >= MAX_HUMAN_REPLIES) break;
        replies += 1;
        await slack
          .say(question.threadTs ?? question.ts, humanReply(question.text, scenario.human.facts, said))
          .catch((e: unknown) => spec.log("human_reply_failed", { error: String(e) }));
      }
      if (mergeAskedAt === null && slack.messages.some((m) => m.bot && /\bmerg/i.test(m.text))) mergeAskedAt = Date.now();
      const mayMerge =
        scenario.human.merge.after === "green" ||
        (mergeAskedAt !== null && Date.now() >= mergeAskedAt + scenario.human.merge.delaySeconds * 1000);
      await driveGitHub({
        sandbox,
        spec,
        baseSha,
        pulls,
        mayMerge,
        record,
        onOpened: () => {
          reached.add("pr_opened");
          prOpenedAt ??= Date.now();
        },
        onApproved: () => reached.add("approved"),
        onMergeRefused: () => reached.add("merge_refused"),
        onMerged: (sha) => {
          reached.add("merged");
          mergedAt ??= Date.now();
          latestMerge = sha;
          deploy();
        },
      }).catch((e: unknown) => spec.log("github_step_failed", { error: String(e) }));
      if (scenario.world?.baseMovesAfter && reached.has(scenario.world.baseMovesAfter) && movedBase === null) {
        movedBase = await spec.github.moveBase(runBase(spec.runId));
        spec.log("base_moved", { sha: movedBase });
      }
      const thread = slack.messages.find((m) => m.bot && m.threadTs === null);
      if (thread) {
        for (const line of due(scenario.human.volunteer, reached, volunteeredSaid, pulls.size ? Math.min(...pulls.keys()) : null)) {
          await slack.say(thread.ts, line.say).catch((e: unknown) => spec.log("human_volunteer_failed", { error: String(e) }));
        }
      }

      if (spec.spend) {
        spec.spend.record(spec.runId, proxy.spentUsd());
        if (spec.spend.exhausted()) {
          end = "spend_cap";
          break;
        }
      }

      if (await system.closed()) {
        end = "closed";
        closedAt = Date.now();
        record({ at: closedAt, kind: "closed" });
        break;
      }
      if (until === "pr_opened" && pulls.size > 0) {
        end = "pr_opened";
        break;
      }
      await sleep(5_000);
    }
  } catch (error: unknown) {
    end = `error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    // Give the system a moment to finish what it was writing, then stop everything.
    await sleep(5000);
    while (deploying as Promise<void> | null) {
      await (deploying as Promise<void> | null)?.catch((e: unknown) => spec.log("deploy_failed", { error: String(e) }));
    }
    if (system.child.pid) {
      try {
        process.kill(-system.child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    unregisterCi();
    slack.close();
    s3.server.close();
    await postgres.stop();
    await proxy.close();
  }

  const merged = [...pulls.entries()].filter(([, p]) => p.mergedGreen !== null);
  const lifecycle = until === "closed";
  const baseNow = await refSha(sandbox, runBase(spec.runId)).catch(() => "unknown");
  const mergeCommits = await Promise.all(merged.map(async ([n]) => (await sandbox.call<Pull>(`/pulls/${n}`)).merge_commit_sha));
  const gates: Gates = {
    closed: lifecycle ? end === "closed" : null,
    fixed: lifecycle ? fixed === true : null,
    mergedGreen: lifecycle && merged.length > 0 ? merged.every(([, p]) => p.mergedGreen === true) : null,
    noPushToMain:
      (await refSha(sandbox, "main").catch(() => "unknown")) === mainAtStart &&
      (baseNow === baseSha || baseNow === movedBase || mergeCommits.includes(baseNow)),
  };

  // The fix as the judge sees it: base to merge when something merged, else
  // base to the first pull request's head, else nothing.
  const diffFrom = movedBase ?? baseSha;
  let diffTo: string | null = baseNow !== diffFrom && baseNow !== "unknown" ? baseNow : null;
  if (diffTo === null && pulls.size > 0) {
    const first = Math.min(...pulls.keys());
    diffTo = await sandbox.call<Pull>(`/pulls/${first}`).then((p) => p.head.sha, () => null);
  }
  let diff = "";
  if (diffTo) {
    const shown = await capture("git", ["-C", spec.github.repo, "diff", diffFrom, diffTo]);
    diff = shown.code === 0 ? shown.stdout : "";
  }

  for (const m of slack.messages) {
    const posted = m.history[0]?.at ?? alertAt;
    if (!m.bot) {
      record({ at: posted, kind: "slack_human", ts: m.ts, threadTs: m.threadTs, text: m.history[0]?.text ?? m.text });
      continue;
    }
    if (m.file !== null) record({ at: posted, kind: "slack_file", ts: m.ts, name: m.fileName ?? "file", text: m.file });
    if (m.file === null || (m.history[0]?.text ?? "").trim() !== "") {
      record({ at: posted, kind: "slack_post", ts: m.ts, threadTs: m.threadTs, text: m.history[0]?.text ?? m.text });
    }
    for (const edit of m.history.slice(1)) record({ at: edit.at, kind: "slack_update", ts: m.ts, text: edit.text });
  }
  const activity: Activity = { alertAt, events: [...events].sort((a, b) => a.at - b.at) };

  const traces = proxy ? await tracesFromProxyLog(join(spec.root, "proxy.jsonl")).catch((e: unknown) => (spec.log("proxy_log_unreadable", { error: String(e) }), [])) : [];
  const seconds = (at: number | null) => (at === null ? null : Math.round((at - alertAt) / 1000));
  const result: RunResult = {
    runId: spec.runId,
    scenario: scenario.id,
    rep: spec.rep,
    side: spec.side,
    ref: spec.ref,
    until,
    end,
    gates,
    spend: traces.length ? spendOf(traces) : ZERO_SPEND,
    wallClock: { prOpened: seconds(prOpenedAt), merged: seconds(mergedAt), closed: seconds(closedAt) },
    prHeads: [...pulls.values()].map((p) => p.head),
  };
  writeFileSync(join(spec.root, "activity.json"), JSON.stringify(activity, null, 2));
  writeFileSync(join(spec.root, "diff.patch"), diff);
  writeFileSync(join(spec.root, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(spec.root, "slack.json"), JSON.stringify(slack.messages, null, 2));
  spec.log("run_finished", { runId: spec.runId, end, gates });
  return result;
};

const REVIEW_BODY = "Approved.\n\nRecommendation: approve";

interface PullState {
  head: string;
  reviewedSha: string | null;
  reviewAsks: number;
  mergedGreen: boolean | null;
  /** The latest CI conclusion recorded per head, so each run's result lands in the activity once. */
  ciRecorded: Map<string, CheckState>;
}

const pullFiles = (sandbox: Sandbox, number: number): Promise<string[]> =>
  sandbox.call<Array<{ filename: string }>>(`/pulls/${number}/files?per_page=100`).then((files) => files.map((f) => f.filename), () => []);

/**
 * The reviewer and the human's merge. A PR opened against main that carries
 * this run's base is moved onto the run's own branch; every new head, and
 * every `delegate review` ask, gets an approving review; an approved PR whose
 * checks are green at its head is merged, which is the deploy. Everything
 * seen here is recorded as the run's activity.
 */
const driveGitHub = async (args: {
  sandbox: Sandbox;
  spec: RunSpec;
  baseSha: string;
  pulls: Map<number, PullState>;
  /** False while the scripted human is not yet merging. */
  mayMerge: boolean;
  record: (event: ActivityEvent) => void;
  onOpened: () => void;
  onApproved: () => void;
  /** GitHub said no to the human's merge: the PR is behind its base. */
  onMergeRefused: () => void;
  onMerged: (sha: string) => void;
}): Promise<void> => {
  const { sandbox, spec, baseSha, pulls, record } = args;
  const open = await sandbox.call<Array<Pull & { title: string }>>("/pulls?state=open&per_page=100");
  for (const pull of open) {
    if (pulls.has(pull.number) || (pull.base.ref !== "main" && pull.base.ref !== runBase(spec.runId))) continue;
    if (!(await contains(sandbox, baseSha, pull.head.sha))) continue;
    if (pull.base.ref === "main") {
      await sandbox.call(`/pulls/${pull.number}`, { method: "PATCH", body: { base: runBase(spec.runId) } });
    }
    pulls.set(pull.number, { head: pull.head.ref, reviewedSha: null, reviewAsks: 0, mergedGreen: null, ciRecorded: new Map() });
    record({ at: Date.now(), kind: "pr_opened", number: pull.number, title: pull.title, files: await pullFiles(sandbox, pull.number) });
    args.onOpened();
    spec.log("pr_claimed", { number: pull.number });
  }
  for (const [number, state] of pulls) {
    if (state.mergedGreen !== null) continue;
    const pull = await sandbox.call<Pull>(`/pulls/${number}`);
    const ci = await checks(sandbox, pull.head.sha);
    if (ci !== "pending" && state.ciRecorded.get(pull.head.sha) !== ci) {
      state.ciRecorded.set(pull.head.sha, ci);
      record({ at: Date.now(), kind: "ci_run", number, conclusion: ci === "green" ? "success" : "failure" });
    }
    if (pull.merged_at) {
      // Merged by something other than the harness.
      state.mergedGreen = ci === "green";
      record({ at: Date.now(), kind: "merged", number });
      args.onMerged(pull.merge_commit_sha ?? pull.head.sha);
      continue;
    }
    if (pull.state !== "open") continue;
    const comments = await sandbox.call<Array<{ body: string }>>(`/issues/${number}/comments?per_page=100`);
    const asks = comments.filter((c) => c.body.trim() === "delegate review").length;
    if (state.reviewedSha !== pull.head.sha || asks > state.reviewAsks) {
      if (state.reviewedSha !== null && state.reviewedSha !== pull.head.sha) {
        record({ at: Date.now(), kind: "pr_head_pushed", number, files: await pullFiles(sandbox, number) });
      }
      await sandbox.call(`/pulls/${number}/reviews`, {
        method: "POST",
        body: { commit_id: pull.head.sha, event: "COMMENT", body: REVIEW_BODY },
      });
      record({ at: Date.now(), kind: "review", number, state: "approved", body: REVIEW_BODY });
      state.reviewedSha = pull.head.sha;
      state.reviewAsks = asks;
      args.onApproved();
      continue;
    }
    if (!args.mayMerge || ci !== "green") continue;
    const merged = await sandbox
      .call<{ sha: string }>(`/pulls/${number}/merge`, { method: "PUT", body: { sha: pull.head.sha, merge_method: "merge" } })
      .catch((e: unknown) => {
        if (!/: 405 /.test(String(e))) throw e;
        spec.log("merge_refused", { number, error: String(e) });
        record({ at: Date.now(), kind: "merge_refused", number, reason: "the pull request is behind its base branch" });
        args.onMergeRefused();
        return null;
      });
    if (!merged) continue;
    state.mergedGreen = true;
    spec.log("pr_merged", { number, sha: merged.sha });
    record({ at: Date.now(), kind: "merged", number });
    args.onMerged(merged.sha);
  }
};
