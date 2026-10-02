import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import { ActivitySchema, renderTimeline } from "../core/activity";
import type { SideOutput } from "../core/blind";
import { createAnthropicJudgeModel, judgePair, type CaseVerdict } from "../core/judge";
import { renderReport, type RunResult, type Side } from "../core/report";
import { loadScenario, SCENARIO_IDS } from "../core/scenario";
import { asUser, createSpendPool, runOne, type Milestone, type Stack } from "./run";
import { startFakeGitHub } from "./github/index";
import type { CiResult } from "./github/store";
import { bugboss } from "./runtimes/bugboss";
import type { Runtime } from "./runtimes/types";
import { FAKE_TOKEN, SANDBOX_OWNER, SANDBOX_REPO, scenarioBranch, seed } from "./sandbox";

/**
 * `run`: baseline against candidate, every scenario x rep, both sides of a
 * pair at once, then the judge over each pair. Writes results.json.
 * `report`: one or more results.json into the table posted on the PR.
 *
 *   npx tsx bugboss-evals/sim/compare.ts run --baseline origin/main --candidate HEAD \
 *     --omni /tmp/omni --out /tmp/evals [--runtime bugboss] [--scenarios a,b] [--reps 3] \
 *     [--run-as user] [--until pr_opened|closed] [--spend-cap-usd 6.67]
 *
 * `--runtime` names the system under test (`sim/runtimes/`); both refs are
 * built by it. `--omni` is a clone holding every scenario's shas, which seeds
 * the fake GitHub's sandbox. The model is the Anthropic API, through the
 * proxy, with `ANTHROPIC_API_KEY` from the environment; nothing here touches
 * AWS. GitHub is always the fake, so the machine must map github.com and
 * api.github.com to 127.0.0.1 and let Node bind 443 (see the workflows); the
 * harness trusts the fake's CA itself, through sudo.
 *
 * `--spend-cap-usd` is this process's share of the comparison's cap: every
 * run stops, ending `spend_cap`, once their model proxies together price at
 * 90% of it.
 *   npx tsx bugboss-evals/sim/compare.ts report --baseline main --candidate pr out1/results.json …
 */

const STACK_DIR = join(__dirname, "stack");
const SETUP_OMNI = join(__dirname, "..", "scenarios", "_lib", "setup-omni.sh");

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

/**
 * The container credential endpoint the system under test resolves AWS
 * through. The credentials are not real: the only AWS the system can reach
 * is the fake S3 and the model proxy, and neither checks a signature.
 */
const startCredentials = async (): Promise<string> => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        AccessKeyId: "AKIAEVALFAKE",
        SecretAccessKey: "fake",
        Token: "fake",
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
      fetch(`${stack.prometheusUrl}/-/ready`).then((r) => r.ok, () => false),
      // The proxy answers only once Prometheus behind it does.
      fetch("http://127.0.0.1:9391/api/v1/query?query=up", { headers: { "X-Eval-Run": "ready" } }).then((r) => r.ok, () => false),
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

/**
 * An omni tree at one base with its dependencies installed and built, as the
 * run-as user, through the hidden check's own setup. It warms the one npm
 * cache every run's HOME links `.npm` to, and the hidden check hardlinks its
 * node_modules. Skipped when the workflow's cache restored it. False when the
 * build failed, and the checks then install for themselves.
 */
/**
 * Opens paths to the run-as user. What that user already wrote is shared,
 * since it writes with umask 0, and is not ours to chmod: those failures are
 * expected and ignored.
 */
const share = (...paths: string[]): void => void spawnSync("chmod", ["-R", "a+rwX", ...paths], { stdio: "ignore" });

const prebuild = async (dir: string, npmCache: string, runAs: string | undefined): Promise<boolean> => {
  if (existsSync(join(dir, "node_modules"))) return true;
  const home = join(dir, "..", `${dir.split("/").pop()}-home`);
  mkdirSync(home, { recursive: true });
  if (runAs) share(dir, home, npmCache);
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

const RUNTIMES: Record<string, Runtime> = { bugboss };

const run = async (argv: string[]): Promise<void> => {
  isolateFromKeychain();
  const out = resolve(flag(argv, "out") ?? "bugboss-evals-out");
  const runtimeId = flag(argv, "runtime") ?? "bugboss";
  const runtime = RUNTIMES[runtimeId];
  if (!runtime) throw new Error(`--runtime must be one of ${Object.keys(RUNTIMES).join(", ")}`);
  const omni = resolve(flag(argv, "omni") ?? "");
  const baselineRef = flag(argv, "baseline") ?? "origin/main";
  const candidateRef = flag(argv, "candidate") ?? "HEAD";
  const scenarios = flag(argv, "scenarios")?.split(",") ?? SCENARIO_IDS;
  const reps = Number(flag(argv, "reps") ?? 3);
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is unset: the system under test and the judge both spend through it");
  const runAs = flag(argv, "run-as");
  const sides = (flag(argv, "sides")?.split(",") ?? ["baseline", "candidate"]) as Side[];
  const until = flag(argv, "until") as Milestone | undefined;
  const maxRunMinutes = flag(argv, "max-run-minutes");
  const capUsd = flag(argv, "spend-cap-usd") === undefined ? null : Number(flag(argv, "spend-cap-usd"));
  const spend = capUsd === null ? undefined : createSpendPool(capUsd);
  if (!existsSync(join(omni, ".git"))) throw new Error("--omni must name a clone holding every scenario's shas");
  mkdirSync(out, { recursive: true });

  // The fake's CI for a commit is the run whose base it is built on.
  const ciRuns = new Map<string, (sha: string) => Promise<CiResult>>();
  const fake = await startFakeGitHub({
    root: join(out, "github"),
    ci: async ({ sha }) => {
      for (const [base, ci] of ciRuns) {
        const ancestor = await promisify(execFile)("git", ["-C", repo, "merge-base", "--is-ancestor", base, sha]).then(() => true, () => false);
        if (ancestor) return ci(sha);
      }
      log("ci_unclaimed", { sha });
      return false;
    },
  });
  const repo = fake.bareRepo(SANDBOX_OWNER, SANDBOX_REPO);
  seed(omni, repo);
  // Node reads NODE_EXTRA_CA_CERTS only at startup, and the CA is made just
  // now, so this process adds it in place. git and gh read the system store.
  setDefaultCACertificates([...getCACertificates("default"), readFileSync(fake.caFile, "utf8")]);
  execFileSync("sudo", ["cp", fake.caFile, "/usr/local/share/ca-certificates/bugboss-eval-github.crt"]);
  execFileSync("sudo", ["update-ca-certificates"], { stdio: "ignore" });
  chmodSync(fake.caFile, 0o644);
  const tokenFile = join(out, "github-token");
  writeFileSync(tokenFile, `${FAKE_TOKEN}\n`, { mode: 0o644 });

  const npmCache = join(out, "npm-cache");
  mkdirSync(npmCache, { recursive: true });
  const baseOf = (id: string) => loadScenario(id).scenario.omni.baseSha;
  const prebuilt: Record<string, string> = {};
  const warming = Promise.all(
    [...new Set(scenarios.map(baseOf))].map(async (sha) => {
      const id = scenarios.find((s) => baseOf(s) === sha)!;
      const dir = join(out, "prebuilt", sha);
      if (!existsSync(join(dir, "package-lock.json"))) {
        await new Promise<void>((resolve) =>
          execFile("git", ["clone", "-q", "--depth", "1", "--branch", scenarioBranch(id), `file://${repo}`, dir], () => resolve()),
        );
      }
      if (existsSync(join(dir, "package-lock.json")) && (await prebuild(dir, npmCache, runAs))) prebuilt[sha] = dir;
    }),
  );

  const builds = {
    baseline: await runtime.build(baselineRef, out),
    candidate: await runtime.build(candidateRef, out),
  };
  await warming;
  share(npmCache);
  const stack = await startStack();
  const awsCredentialsUrl = await startCredentials();
  const stamp = Date.now().toString(36);

  const jobs = scenarios.flatMap((scenarioId) =>
    Array.from({ length: reps }, (_, i) => i + 1).flatMap((rep) =>
      sides.map(async (side): Promise<RunResult> => {
        const runId = `${stamp}-${scenarioId}-${rep}-${side}`;
        return runOne({
            runId,
            scenarioId,
            rep,
            side,
            ref: side === "baseline" ? baselineRef : candidateRef,
            runtime,
            build: builds[side],
            root: join(out, "runs", runId),
            stack,
            tokenFile,
            github: {
              caFile: fake.caFile,
              repo,
              onCi: (base, ci) => {
                ciRuns.set(base, ci);
                return () => void ciRuns.delete(base);
              },
              moveBase: async (branch) => {
                const index = join(out, `index-${runId}`);
                const git = (args: string[], input?: string) =>
                  new Promise<string>((done, fail) => {
                    const child = execFile(
                      "git",
                      ["-C", repo, "-c", "user.name=bugboss-evals", "-c", "user.email=evals@invalid", ...args],
                      { encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: index } },
                      (error, stdout) => (error ? fail(error) : done(stdout.trim())),
                    );
                    // git exits before reading stdin it never asked for; a
                    // write into that closed pipe must not kill the harness.
                    child.stdin?.on("error", () => undefined);
                    child.stdin?.end(input ?? "");
                  });
                const tip = await git(["rev-parse", `refs/heads/${branch}`]);
                await git(["read-tree", tip]);
                const note = await git(["hash-object", "-w", "--stdin"], "Someone else's change landed on the base after approval.\n");
                await git(["update-index", "--add", "--cacheinfo", `100644,${note},docs/eval-base-moved.md`]);
                const sha = await git(["commit-tree", await git(["write-tree"]), "-p", tip, "-m", "An unrelated change on the base"]);
                rmSync(index, { force: true });
                fake.advance(SANDBOX_OWNER, SANDBOX_REPO, branch, sha);
                fake.requireUpToDate(SANDBOX_OWNER, SANDBOX_REPO, branch);
                return sha;
              },
            },
            awsCredentialsUrl,
            anthropicApiKey,
            npmCache,
            ...(prebuilt[baseOf(scenarioId)] ? { prebuilt: prebuilt[baseOf(scenarioId)] } : {}),
            ...(spend ? { spend } : {}),
            ...(until ? { until } : {}),
            ...(maxRunMinutes ? { maxRunSeconds: Number(maxRunMinutes) * 60 } : {}),
            ...(runAs ? { runAs } : {}),
            seed: rep,
            log: (event, fields) => log(event, { runId, ...fields }),
        });
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
  await fake.close();

  const model = createAnthropicJudgeModel({ apiKey: anthropicApiKey });
  // What the judge sees of a run: the activity the harness recorded, rendered
  // whole, and the fix diff. judgePair blinds both.
  const sideOutput = (run: RunResult): SideOutput => {
    const dir = join(out, "runs", run.runId);
    const activity = ActivitySchema.parse(JSON.parse(readFileSync(join(dir, "activity.json"), "utf8")));
    const diff = existsSync(join(dir, "diff.patch")) ? readFileSync(join(dir, "diff.patch"), "utf8") : "";
    return { timeline: renderTimeline(activity, (s) => s), diff: diff.trim() === "" ? null : diff };
  };
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
          baseline: sideOutput(baseline),
          candidate: sideOutput(candidate),
          model,
          blinding: {
            identifying: [
              baselineRef,
              candidateRef,
              builds.baseline.sha,
              builds.candidate.sha,
              baseline.runId,
              candidate.runId,
              ...(baseline.prHeads ?? []),
              ...(candidate.prHeads ?? []),
            ].filter(
              (s): s is string => typeof s === "string",
            ),
          },
        }),
      );
    }
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({ runtime: runtime.id, baselineRef, candidateRef, spendCapUsd: capUsd, runs, verdicts }, null, 2));
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

