import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Deploy" for the sim: the GitHub stand-in's deploy hook posts the merge SHA
 * here, and this runs the scenario's hidden check against it.
 *
 * It is its own container, rather than the hook running the check itself,
 * because the GitHub stand-in's container also runs visible CI, which is
 * agent-authored code. The check files, their output and the control token
 * that flips the telemetry never reach that container. All the hook can do
 * is ask for a deploy, and this refuses any SHA that is not on main.
 *
 * The check's scripts are called as the contract's deploy hook is: the merge
 * SHA as $1 and the checkout as $2.
 *
 * The check's result goes to the results directory and nowhere else. The
 * agent learns it the way it would in production: the fault stops, or it
 * does not.
 */

export interface DeployRecord {
  sha: string;
  startedAt: number;
  finishedAt: number;
  setupExit: number | null;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
}

export const CHECK_ENV = [
  "PATH",
  "LANG",
  "TMPDIR",
  "npm_config_registry",
  "PRISMA_ENGINES_MIRROR",
  "OMNI_TEST_POSTGRES_URL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
] as const;

export interface CheckerConfig {
  scenarioDir: string;
  checkSetup: string | null;
  checkCommand: string;
  setupTimeoutSeconds: number;
  timeoutSeconds: number;
  baseSha: string;
  repoDir: string;
  resultsDir: string;
  deployToken: string;
  controlToken: string;
  telemetryControlUrl: string;
  awsControlUrl: string;
  env: NodeJS.ProcessEnv;
  /**
   * The check runs the agent's merged code, so it runs as another user: it
   * cannot read this process's environment, which holds the tokens.
   */
  checkUid?: number;
}

const run = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; log?: string; timeoutMs?: number; uid?: number },
): Promise<{ code: number | null; stdout: string; timedOut: boolean }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      ...(options.uid === undefined ? {} : { uid: options.uid, gid: options.uid }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const sink = options.log ? createWriteStream(options.log, { flags: "a" }) : null;
    child.stdout.on("data", (chunk: Buffer) => {
      if (sink) sink.write(chunk);
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => sink?.write(chunk));
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        }, options.timeoutMs)
      : null;
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      sink?.end();
      resolve({ code, stdout, timedOut });
    });
  });

// The token rides in the environment of each git call rather than in
// .git/config, where the check (which runs the agent's code in a worktree of
// this repository) could read it.
const gitAuth = (): NodeJS.ProcessEnv => {
  const token = process.env.CHECKER_GITHUB_TOKEN;
  if (!token) return process.env;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
};

const git = async (repoDir: string, args: string[]): Promise<string> => {
  const result = await run("git", args, { cwd: repoDir, env: gitAuth() });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} exited ${result.code}`);
  return result.stdout.trim();
};

const postControl = async (url: string, token: string, body: Record<string, string>) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${await response.text()}`);
};

export const createChecker = (config: CheckerConfig) => {
  const deploys: DeployRecord[] = [];
  const refusals: { at: number; sha: string; reason: string }[] = [];
  let queue: Promise<void> = Promise.resolve();
  mkdirSync(config.resultsDir, { recursive: true });

  const deploy = async (sha: string): Promise<DeployRecord> => {
    await git(config.repoDir, ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main", sha]);
    const onMain = await run("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], {
      cwd: config.repoDir,
    });
    if (onMain.code !== 0) {
      refusals.push({ at: Date.now(), sha, reason: "not on main" });
      throw new Error(`${sha} is not on main`);
    }
    const tree = join(config.repoDir, "..", "deploys", sha);
    if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
    await git(config.repoDir, ["worktree", "add", "--detach", "--force", tree, sha]);
    if (config.checkUid !== undefined) {
      await run("chown", ["-R", `${config.checkUid}:${config.checkUid}`, tree], { cwd: config.repoDir });
    }
    const diff = await git(config.repoDir, ["diff", config.baseSha, sha]);
    writeFileSync(join(config.resultsDir, `${sha}.diff`), diff);

    const log = join(config.resultsDir, `${sha}.log`);
    // The check runs the agent's merged code, so it gets no token.
    const env: NodeJS.ProcessEnv = { OMNI_DIR: tree, CI: "true", HOME: config.checkUid === undefined ? config.env.HOME : "/home/node" };
    for (const name of CHECK_ENV) {
      if (config.env[name] !== undefined) env[name] = config.env[name];
    }
    const startedAt = Date.now();
    let setupExit: number | null = null;
    let timedOut = false;
    if (config.checkSetup) {
      // Its own budget: setup is an `npm ci` of omni, and counting it against
      // the check would fail a correct fix on a slow registry.
      const setup = await run("bash", [join(config.scenarioDir, config.checkSetup), sha, tree], {
        cwd: tree,
        env,
        log,
        timeoutMs: config.setupTimeoutSeconds * 1000,
        uid: config.checkUid,
      });
      setupExit = setup.code;
      timedOut = setup.timedOut;
    }
    let exitCode: number | null = null;
    if (setupExit === null || setupExit === 0) {
      const check = await run("bash", [join(config.scenarioDir, config.checkCommand), sha, tree], {
        cwd: tree,
        env,
        log,
        timeoutMs: config.timeoutSeconds * 1000,
        uid: config.checkUid,
      });
      exitCode = check.code;
      timedOut = check.timedOut;
    }
    const record: DeployRecord = {
      sha,
      startedAt,
      finishedAt: Date.now(),
      setupExit,
      exitCode,
      timedOut,
      passed: exitCode === 0 && !timedOut,
    };
    deploys.push(record);
    writeFileSync(join(config.resultsDir, `${sha}.json`), JSON.stringify(record, null, 2));
    await git(config.repoDir, ["worktree", "remove", "--force", tree]);

    // A later deploy that breaks it again brings the fault back, as prod would.
    await postControl(`${config.telemetryControlUrl}/__control/state`, config.controlToken, {
      state: record.passed ? "healthy" : "fault",
    });
    if (record.passed) {
      await postControl(`${config.awsControlUrl}/__control/deploy`, config.controlToken, { sha });
    }
    return record;
  };

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };

  const reply = (res: ServerResponse, status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization ?? "";
    if (req.method === "POST" && req.url === "/deploy") {
      if (auth !== `Bearer ${config.deployToken}`) return reply(res, 401, { error: "unauthorized" });
      const { sha } = JSON.parse(await readBody(req)) as { sha?: string };
      if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return reply(res, 400, { error: "sha required" });
      const result = queue.then(() => deploy(sha));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      try {
        await result;
        // Deliberately says nothing about the check: this answer ends up in a
        // workflow run the agent can read.
        return reply(res, 200, { deployed: sha });
      } catch (error) {
        appendFileSync(join(config.resultsDir, "errors.log"), `${new Date().toISOString()} ${sha} ${String(error)}\n`);
        return reply(res, 500, { error: "deploy failed" });
      }
    }
    if (auth !== `Bearer ${config.controlToken}`) return reply(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/__control/health") return reply(res, 200, { ok: true });
    if (req.method === "GET" && req.url === "/__control/state") return reply(res, 200, { deploys, refusals });
    return reply(res, 404, { error: "not found" });
  };

  return {
    deploys,
    refusals,
    server: createServer((req, res) => {
      handle(req, res).catch((error: Error) => reply(res, 500, { error: error.message }));
    }),
  };
};

if (require.main === module) {
  const need = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`${name} is required`);
    return value;
  };
  const work = process.env.CHECKER_WORK_DIR ?? "/work";
  const repoDir = join(work, "omni");
  void (async () => {
    if (!existsSync(repoDir)) {
      mkdirSync(work, { recursive: true });
      const clone = await run("git", ["clone", "--quiet", need("SEED_BUNDLE"), repoDir], { cwd: work, env: gitAuth() });
      if (clone.code !== 0) throw new Error("could not clone the seed bundle");
      await git(repoDir, ["remote", "set-url", "origin", need("GIT_REMOTE")]);
    }
    const checker = createChecker({
      scenarioDir: need("SCENARIO_DIR"),
      checkSetup: process.env.CHECK_SETUP || null,
      checkCommand: need("CHECK_COMMAND"),
      setupTimeoutSeconds: Number(need("CHECK_SETUP_TIMEOUT_SECONDS")),
      timeoutSeconds: Number(need("CHECK_TIMEOUT_SECONDS")),
      baseSha: need("BASE_SHA"),
      repoDir,
      resultsDir: process.env.DEPLOY_RESULTS_DIR ?? "/results/deploys",
      deployToken: need("DEPLOY_TOKEN"),
      controlToken: need("CONTROL_TOKEN"),
      telemetryControlUrl: need("TELEMETRY_CONTROL_URL"),
      awsControlUrl: need("AWS_CONTROL_URL"),
      env: process.env,
      checkUid: process.getuid?.() === 0 ? Number(process.env.CHECK_UID ?? 1000) : undefined,
    });
    const port = Number(process.env.PORT ?? 9006);
    const host = process.env.CONTROL_HOST ?? "0.0.0.0";
    checker.server.listen(port, host, () =>
      console.log(JSON.stringify({ event: "checker_listening", host, port })),
    );
  })();
}
