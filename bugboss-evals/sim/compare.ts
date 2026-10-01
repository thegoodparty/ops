import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createBedrockJudgeModel, judgePair, type CaseVerdict } from "../core/judge";
import { renderReport, type RunResult, type Side } from "../core/report";
import { loadScenario, SCENARIO_IDS } from "../core/scenario";
import { asUser, createSpendPool, runOne, type Milestone, type Stack } from "./run";
import { scenarioBranch, SANDBOX_URL } from "./sandbox";
import { startStubModel } from "./stub-model";

/**
 * `run`: baseline against candidate, every scenario x rep, both sides of a
 * pair at once, then the judge over each pair. Writes results.json.
 * `report`: one or more results.json into the table posted on the PR.
 *
 *   npx tsx bugboss-evals/sim/compare.ts run --baseline origin/main --candidate HEAD \
 *     --token-file /tmp/token --out /tmp/evals [--scenarios a,b] [--reps 3] [--stub <omni>] [--run-as user] \
 *     [--until root_cause|pr_opened|closed] [--offline] [--spend-cap-usd 6.67]
 *
 * `--spend-cap-usd` is this process's share of the comparison's cap: every
 * run stops, ending `spend_cap`, once their live sessions together price at
 * 90% of it.
 *
 * `--offline` needs `--stub`: no GitHub and no token, the sandbox a local
 * bare repository with the scenario's base as one commit, each run ending at
 * the root cause. It proves everything up to the PR at zero spend and with no
 * credential at all, which is what a pull request's CI can hold.
 *   npx tsx bugboss-evals/sim/compare.ts report --baseline main --candidate pr out1/results.json …
 */

const OPS_ROOT = resolve(__dirname, "..", "..");
const STACK_DIR = join(__dirname, "stack");
const SETUP_OMNI = join(__dirname, "..", "scenarios", "_lib", "setup-omni.sh");

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

/** BugBoss from its own commit, built as production builds it. */
const buildRef = (ref: string, out: string): { dir: string; sha: string } => {
  const sha = execFileSync("git", ["-C", OPS_ROOT, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  const dir = join(out, "build", sha.slice(0, 12));
  if (!existsSync(join(dir, "dist", "bugboss", "index.js"))) {
    if (!existsSync(dir)) execFileSync("git", ["-C", OPS_ROOT, "worktree", "add", "--detach", dir, sha], { stdio: "inherit" });
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
    execFileSync("npx", ["tsc", "-p", "."], { cwd: dir, stdio: "inherit" });
    copyFileSync(join(dir, "bugboss", "db", "schema.sql"), join(dir, "dist", "bugboss", "db", "schema.sql"));
  }
  return { dir, sha };
};

/**
 * The container credential endpoint BugBoss and its agents resolve AWS
 * through. It serves this process's own credentials, which in CI are the
 * Bedrock-only OIDC role, so every other AWS call is denied. With --stub it
 * serves fake ones.
 */
const startCredentials = async (fake: boolean): Promise<string> => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        AccessKeyId: fake ? "AKIAEVALFAKE" : process.env.AWS_ACCESS_KEY_ID,
        SecretAccessKey: fake ? "fake" : process.env.AWS_SECRET_ACCESS_KEY,
        Token: fake ? "fake" : process.env.AWS_SESSION_TOKEN,
        Expiration: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("credentials server did not bind");
  server.unref();
  return `http://127.0.0.1:${address.port}/credentials`;
};

const startStack = async (): Promise<Stack> => {
  const grafanaAdmin = process.env.GRAFANA_ADMIN_PASSWORD ?? "admin";
  execFileSync("docker", ["compose", "-f", join(STACK_DIR, "stack.yml"), "up", "-d", "--wait"], {
    stdio: "inherit",
    env: { ...process.env, GRAFANA_ADMIN_PASSWORD: grafanaAdmin },
  });
  const stack: Stack = {
    grafanaUrl: "http://127.0.0.1:3300",
    grafanaAdmin,
    internal: { loki: "http://loki:3100", prometheus: "http://prom-label-proxy:8080", tempo: "http://tempo:3200" },
    lokiUrl: "http://127.0.0.1:3310",
    prometheusUrl: "http://127.0.0.1:9390",
  };
  for (let i = 0; i < 60; i++) {
    const ready = await Promise.all([
      fetch(`${stack.grafanaUrl}/api/health`).then((r) => r.ok, () => false),
      fetch(`${stack.lokiUrl}/ready`).then((r) => r.ok, () => false),
    ]);
    if (ready.every(Boolean)) return stack;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("the observability stack never became ready");
};

/**
 * Nothing the harness starts may reach a credential store. On a Mac the
 * user's docker config names the keychain as its credsStore, and the system
 * gitconfig names it as a credential helper, so every pull and every https
 * git call would prompt. Every child inherits this environment: docker gets a
 * config with no credsStore (keeping the user's CLI plugins, compose among
 * them), and git reads no system or global config.
 */
export const isolateFromKeychain = (): void => {
  const dockerConfig = mkdtempSync(join(tmpdir(), "evb-docker-"));
  writeFileSync(
    join(dockerConfig, "config.json"),
    JSON.stringify({ cliPluginsExtraDirs: [join(homedir(), ".docker", "cli-plugins")] }),
  );
  const gitConfig = join(dockerConfig, "gitconfig");
  writeFileSync(gitConfig, "[credential]\n\thelper =\n");
  Object.assign(process.env, {
    DOCKER_CONFIG: dockerConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TERMINAL_PROMPT: "0",
  });
};

const git = (args: string[], cwd?: string) =>
  execFileSync("git", ["-c", "user.name=bugboss-evals", "-c", "user.email=evals@invalid", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 26 }).trim();

/** The scenario's base as a one-commit bare repository, for `--offline`. */
const offlineRepo = (omni: string, id: string, out: string): { repo: string; baseSha: string } => {
  const { scenario } = loadScenario(id);
  const snap = join(out, "offline", id, "base");
  const repo = join(out, "offline", id, "sandbox.git");
  if (!existsSync(repo)) {
    git(["-C", omni, "worktree", "add", "-q", "--detach", snap, scenario.omni.baseSha]);
    rmSync(join(snap, ".git"));
    git(["-C", omni, "worktree", "prune"]);
    git(["init", "-q", "-b", "main"], snap);
    git(["add", "-A"], snap);
    git(["commit", "-q", "-m", `${id} base`], snap);
    git(["init", "-q", "--bare", repo]);
    git(["push", "-q", repo, "HEAD:refs/heads/main"], snap);
  }
  return { repo, baseSha: git(["rev-parse", "HEAD"], snap) };
};

/**
 * An omni tree at one base with its dependencies installed and built, as the
 * run-as user, through the hidden check's own setup. It warms the one npm
 * cache every run's HOME links `.npm` to, and the hidden check hardlinks its
 * node_modules. Skipped when the workflow's cache restored it. False when the
 * build failed, and the checks then install for themselves.
 */
const prebuild = async (dir: string, npmCache: string, runAs: string | undefined): Promise<boolean> => {
  if (existsSync(join(dir, "node_modules"))) return true;
  const home = join(dir, "..", `${dir.split("/").pop()}-home`);
  mkdirSync(home, { recursive: true });
  execFileSync("chmod", ["-R", "a+rwX", dir, home, npmCache]);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, npm_config_cache: npmCache };
  const { command, args, env: stepEnv } = asUser(runAs, "bash", [SETUP_OMNI, dir], env);
  const ok = await new Promise<boolean>((resolve) =>
    execFile(command, args, { env: stepEnv ?? env, maxBuffer: 1 << 28 }, (error, _stdout, stderr) => {
      if (error) log("prebuild_failed", { dir, error: error.message, stderr });
      resolve(!error);
    }),
  );
  if (!ok) rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  return ok;
};

const run = async (argv: string[]): Promise<void> => {
  isolateFromKeychain();
  const out = resolve(flag(argv, "out") ?? "bugboss-evals-out");
  const offline = argv.includes("--offline");
  const tokenFile = offline ? join(out, "no-token") : resolve(flag(argv, "token-file") ?? "");
  const baselineRef = flag(argv, "baseline") ?? "origin/main";
  const candidateRef = flag(argv, "candidate") ?? "HEAD";
  const scenarios = flag(argv, "scenarios")?.split(",") ?? SCENARIO_IDS;
  const reps = Number(flag(argv, "reps") ?? 3);
  const stubOmni = flag(argv, "stub");
  const runAs = flag(argv, "run-as");
  const sides = (flag(argv, "sides")?.split(",") ?? ["baseline", "candidate"]) as Side[];
  const until = flag(argv, "until") as Milestone | undefined;
  const capUsd = flag(argv, "spend-cap-usd") === undefined ? null : Number(flag(argv, "spend-cap-usd"));
  const spend = capUsd === null ? undefined : createSpendPool(capUsd);
  if (offline && !stubOmni) throw new Error("--offline runs only against the stub: pass --stub <omni>");
  if (!offline && !existsSync(tokenFile)) throw new Error("--token-file must name the file the trusted minter keeps fresh");
  mkdirSync(out, { recursive: true });
  const offlineRepos = offline ? Object.fromEntries(scenarios.map((id) => [id, offlineRepo(stubOmni!, id, out)])) : {};
  if (offline) writeFileSync(tokenFile, "offline\n");

  const npmCache = join(out, "npm-cache");
  mkdirSync(npmCache, { recursive: true });
  const baseOf = (id: string) => loadScenario(id).scenario.omni.baseSha;
  const prebuilt: Record<string, string> = {};
  const warming = Promise.all(
    [...new Set(scenarios.map(baseOf))].map(async (sha) => {
      const id = scenarios.find((s) => baseOf(s) === sha)!;
      const dir = offline ? join(out, "offline", id, "base") : join(out, "prebuilt", sha);
      if (!offline && !existsSync(join(dir, "package-lock.json"))) {
        const token = readFileSync(tokenFile, "utf8").trim();
        const auth = `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
        await new Promise<void>((resolve) =>
          execFile("git", ["-c", "credential.helper=", "-c", auth, "clone", "-q", "--depth", "1", "--branch", scenarioBranch(id), SANDBOX_URL, dir], () => resolve()),
        );
      }
      if (existsSync(join(dir, "package-lock.json")) && (await prebuild(dir, npmCache, runAs))) prebuilt[sha] = dir;
    }),
  );

  const builds = {
    baseline: buildRef(baselineRef, out),
    candidate: buildRef(candidateRef, out),
  };
  await warming;
  execFileSync("chmod", ["-R", "a+rwX", npmCache]);
  const stack = await startStack();
  const awsCredentialsUrl = await startCredentials(Boolean(stubOmni));
  const stamp = Date.now().toString(36);

  const patchFor = (id: string): string => {
    const { scenario } = loadScenario(id);
    const path = join(out, `${id}.patch`);
    writeFileSync(path, execFileSync("git", ["-C", stubOmni!, "diff", scenario.omni.baseSha, scenario.omni.provingFixSha], { maxBuffer: 1 << 26 }));
    return path;
  };

  const jobs = scenarios.flatMap((scenarioId) =>
    Array.from({ length: reps }, (_, i) => i + 1).flatMap((rep) =>
      sides.map(async (side): Promise<RunResult> => {
        const runId = `${stamp}-${scenarioId}-${rep}-${side}`;
        const stub = stubOmni ? await startStubModel(patchFor(scenarioId)) : null;
        try {
          return await runOne({
            runId,
            scenarioId,
            rep,
            side,
            ref: side === "baseline" ? baselineRef : candidateRef,
            bugbossDir: builds[side].dir,
            root: join(out, "runs", runId),
            stack,
            tokenFile,
            awsCredentialsUrl,
            npmCache,
            ...(prebuilt[baseOf(scenarioId)] ? { prebuilt: prebuilt[baseOf(scenarioId)] } : {}),
            ...(spend ? { spend } : {}),
            ...(offline ? { offline: offlineRepos[scenarioId] } : {}),
            ...(until ? { until } : {}),
            ...(stub ? { stubModelUrl: stub.url } : {}),
            ...(runAs ? { runAs } : {}),
            seed: rep,
            log: (event, fields) => log(event, { runId, ...fields }),
          });
        } finally {
          stub?.server.close();
        }
      }),
    ),
  );
  // One run that throws must not cost the job every other run's result.
  const runs = (
    await Promise.all(
      jobs.map((job) =>
        job.catch((e: unknown) => {
          log("run_threw", { error: e instanceof Error ? e.stack : String(e) });
          return null;
        }),
      ),
    )
  ).filter((r): r is RunResult => r !== null);

  if (stubOmni) {
    const judgeStub = await startStubModel("/dev/null");
    Object.assign(process.env, {
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: judgeStub.url,
      AWS_ACCESS_KEY_ID: "AKIAEVALFAKE",
      AWS_SECRET_ACCESS_KEY: "fake",
    });
  }
  const model = createBedrockJudgeModel({ region: "us-west-2" });
  const verdicts: CaseVerdict[] = [];
  for (const scenarioId of scenarios) {
    const { scenario, dir } = loadScenario(scenarioId);
    const context = {
      alert: JSON.parse(readFileSync(join(dir, scenario.alert.file), "utf8")),
      reference: readFileSync(join(dir, scenario.reference), "utf8"),
    };
    for (let rep = 1; rep <= reps; rep++) {
      const baseline = runs.find((r) => r.scenario === scenarioId && r.rep === rep && r.side === "baseline");
      const candidate = runs.find((r) => r.scenario === scenarioId && r.rep === rep && r.side === "candidate");
      if (!baseline || !candidate) continue;
      verdicts.push(
        await judgePair({
          pairId: `${scenarioId}/${rep}`,
          context,
          baseline: baseline.output,
          candidate: candidate.output,
          model,
          blinding: { identifying: [baselineRef, candidateRef, builds.baseline.sha, builds.candidate.sha, baseline.runId, candidate.runId] },
        }),
      );
    }
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({ baselineRef, candidateRef, spendCapUsd: capUsd, runs, verdicts }, null, 2));
  log("results_written", { path: join(out, "results.json") });
};

const report = (argv: string[]): void => {
  const files = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const all = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as { spendCapUsd: number | null; runs: RunResult[]; verdicts: CaseVerdict[] });
  const verdicts = all.flatMap((a) => a.verdicts);
  const caps = all.map((a) => a.spendCapUsd).filter((c): c is number => typeof c === "number");
  process.stdout.write(
    renderReport({
      baselineRef: flag(argv, "baseline") ?? "main",
      candidateRef: flag(argv, "candidate") ?? "candidate",
      runs: all.flatMap((a) => a.runs),
      verdicts,
      judgeUsd: verdicts.reduce((sum, v) => sum + v.judgeCostUsd, 0),
      tier: flag(argv, "tier") ?? "full",
      capUsd: caps.length ? caps.reduce((a, b) => a + b, 0) : null,
    }) + "\n",
  );
};

if (require.main === module) {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "run") {
    run(argv).then(
      () => process.exit(0),
      (error: unknown) => {
        log("run_failed", { error: error instanceof Error ? error.stack : String(error) });
        process.exit(1);
      },
    );
  } else if (command === "report") {
    report(argv);
  } else {
    console.error("usage: compare.ts run|report …");
    process.exit(2);
  }
}

