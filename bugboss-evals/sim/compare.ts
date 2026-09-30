import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

import { createBedrockJudgeModel, judgePair, type CaseVerdict } from "../core/judge";
import { renderReport, type RunResult, type Side } from "../core/report";
import { loadScenario, SCENARIO_IDS } from "../core/scenario";
import { runOne, type Stack } from "./run";
import { startStubModel } from "./stub-model";

/**
 * `run`: baseline against candidate, every scenario x rep, both sides of a
 * pair at once, then the judge over each pair. Writes results.json.
 * `report`: one or more results.json into the table posted on the PR.
 *
 *   npx tsx bugboss-evals/sim/compare.ts run --baseline origin/main --candidate HEAD \
 *     --token-file /tmp/token --out /tmp/evals [--scenarios a,b] [--reps 3] [--stub <omni>] [--run-as user]
 *   npx tsx bugboss-evals/sim/compare.ts report --baseline main --candidate pr out1/results.json …
 */

const OPS_ROOT = resolve(__dirname, "..", "..");
const STACK_DIR = join(__dirname, "stack");

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

const run = async (argv: string[]): Promise<void> => {
  const out = resolve(flag(argv, "out") ?? "bugboss-evals-out");
  const tokenFile = resolve(flag(argv, "token-file") ?? "");
  const baselineRef = flag(argv, "baseline") ?? "origin/main";
  const candidateRef = flag(argv, "candidate") ?? "HEAD";
  const scenarios = flag(argv, "scenarios")?.split(",") ?? SCENARIO_IDS;
  const reps = Number(flag(argv, "reps") ?? 3);
  const stubOmni = flag(argv, "stub");
  const runAs = flag(argv, "run-as");
  const sides = (flag(argv, "sides")?.split(",") ?? ["baseline", "candidate"]) as Side[];
  if (!existsSync(tokenFile)) throw new Error("--token-file must name the file the trusted minter keeps fresh");
  mkdirSync(out, { recursive: true });

  const builds = {
    baseline: buildRef(baselineRef, out),
    candidate: buildRef(candidateRef, out),
  };
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
  const runs = await Promise.all(jobs);

  if (stubOmni) {
    const judgeStub = await startStubModel("/dev/null");
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = judgeStub.url;
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
  writeFileSync(join(out, "results.json"), JSON.stringify({ baselineRef, candidateRef, runs, verdicts }, null, 2));
  log("results_written", { path: join(out, "results.json") });
};

const report = (argv: string[]): void => {
  const files = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const all = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as { runs: RunResult[]; verdicts: CaseVerdict[] });
  const verdicts = all.flatMap((a) => a.verdicts);
  process.stdout.write(
    renderReport({
      baselineRef: flag(argv, "baseline") ?? "main",
      candidateRef: flag(argv, "candidate") ?? "candidate",
      runs: all.flatMap((a) => a.runs),
      verdicts,
      judgeUsd: verdicts.reduce((sum, v) => sum + v.judgeCostUsd, 0),
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

