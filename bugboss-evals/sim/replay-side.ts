import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { referenceFor, loadCase, type ReplayCase } from "../replay/case";
import { cutAtPrOpen, readSession } from "../replay/checkpoint";
import { resolvePrCommits } from "../replay/run-phase";
import {
  OPS_ROOT,
  dotenv,
  makeTls,
  pickSubnets,
  resolveModelSession,
  writeModelSession,
  type ModelCredentials,
  type ModelSession,
} from "./orchestrator";

/**
 * One Tier 2 side as the fan-out runs it: the runner, which holds the docker
 * socket and the task role, prepares a run directory and brings up
 * compose/replay.yml; the replay container, which runs the variant's code,
 * gets only what the runner hands it read-only.
 *
 * The runner itself never runs variant code. It fetches the variant as a
 * `git archive` tarball and unpacks it, fetches the checkpoint with its own
 * credentials and writes only the cut (so the recorded turns after the PR
 * opened are never on the replay container's disk), and reads the PR's
 * commits from the case's omni bundle.
 */

const run = promisify(execFile);

export const REPLAY_TLS_NAMES = ["proxy", "github", "npm", "localhost"];
export const HUMAN_LOGIN = "oncall-human";
export const REPLAY_BOT_TOKEN = "replay-fake-bot";
export const BOT_LOGIN = "bugboss[bot]";
export const CASES_DIR = join(OPS_ROOT, "bugboss-evals", "replay", "cases");
const COMPOSE_DIR = join(__dirname, "compose");
const SESSION_REFRESH_MS = 15 * 60_000;
// On top of the case's own wall-clock cap, which run-phase.ts enforces on
// the agent: the variant's `npm ci` and the omni clone come before it.
const SETUP_ALLOWANCE_SECONDS = 1200;

export const caseJsonFor = (idOrPath: string): string =>
  idOrPath.endsWith(".json") ? resolve(idOrPath) : join(CASES_DIR, `${basename(idOrPath)}.json`);

/** Where a person uploads the omni bundle for a case, and where a side reads it. */
export const bundleUrlFor = (bucket: string, caseId: string) => `s3://${bucket}/replay/${caseId}.bundle`;

/** The two refs a replay bundle carries, read without unpacking it. */
export const bundleCommits = async (bundle: string): Promise<{ headSha: string; baseSha: string }> => {
  const { stdout } = await run("git", ["bundle", "list-heads", bundle], { maxBuffer: 1 << 26 });
  const refs = new Map(
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(" ");
        return [ref, sha] as const;
      }),
  );
  const headSha = refs.get("refs/replay/head");
  const baseSha = refs.get("refs/replay/base");
  if (!headSha || !baseSha) {
    throw new Error(`${bundle} has no refs/replay/head and refs/replay/base; build it with \`cli.ts replay-bundle\``);
  }
  return { headSha, baseSha };
};

/**
 * Builds a case's omni bundle on a person's machine: reads the checkpoint
 * with their AWS credentials, finds the PR's head at the moment it opened
 * and its merge base with `gh`, and bundles exactly those two commits'
 * history. The PR's later commits are left out, so the replayed agent cannot
 * find the fix it went on to write.
 */
export const buildReplayBundle = async (args: {
  replayCase: ReplayCase;
  omniDir: string;
  cacheDir: string;
  out: string;
  region?: string;
}): Promise<{ path: string; headSha: string; baseSha: string }> => {
  const checkpoint = cutAtPrOpen(await readSession(args.replayCase.checkpoint.session, args.region), args.replayCase.checkpoint.prOrdinal);
  const commits = await resolvePrCommits({ checkpoint, cacheDir: args.cacheDir, omniSource: resolve(args.omniDir) });
  const bare = mkdtempSync(join(tmpdir(), "replay-bundle-"));
  try {
    await run("git", ["init", "--quiet", "--bare", bare]);
    await run(
      "git",
      ["-C", bare, "fetch", "--quiet", "--no-tags", commits.mirror, `${commits.headSha}:refs/replay/head`, `${commits.baseSha}:refs/replay/base`],
      { maxBuffer: 1 << 26 },
    );
    await run("git", ["-C", bare, "bundle", "create", `${args.out}.part`, "refs/replay/head", "refs/replay/base"], { maxBuffer: 1 << 26 });
    await run("mv", [`${args.out}.part`, args.out]);
    return { path: args.out, headSha: commits.headSha, baseSha: commits.baseSha };
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
};

export interface ReplaySideSpec {
  caseJson: string;
  ref: string;
  rep: number;
  runId: string;
  simImage: string;
  /** Must be the same path on the docker host; see replay.yml. */
  workRoot: string;
  variantTar: string;
  /** Defaults to the case's own S3 URI. */
  checkpoint?: string;
  omniBundle: string;
  modelCredentials: ModelCredentials;
  out: string;
  region?: string;
  log?: (event: string, fields?: Record<string, string | number | boolean | null>) => void;
}

export interface PreparedReplay {
  runDir: string;
  project: string;
  replayCase: ReplayCase;
  compose: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

const fetchTo = async (source: string, dest: string) => {
  if (source.startsWith("s3://")) await run("aws", ["s3", "cp", "--only-show-errors", source, dest]);
  else copyFileSync(resolve(source), dest);
};

export const prepareReplaySide = async (spec: ReplaySideSpec): Promise<PreparedReplay> => {
  const replayCase = loadCase(spec.caseJson);
  // The runner holds the scenarios; the replay container does not, so the
  // case's reference is checked here and the side skips it.
  referenceFor(replayCase);
  const runDir = join(spec.workRoot, spec.runId);
  const project = `bbreplay-${spec.runId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  for (const sub of ["results", "replay-out", "seed", "checkpoint", "variant", "sim", "model-aws", "replay-home"]) {
    mkdirSync(join(runDir, sub), { recursive: true });
  }
  await makeTls(join(runDir, "tls"), REPLAY_TLS_NAMES);

  const tar = join(runDir, "variant.tar");
  await fetchTo(spec.variantTar, tar);
  await run("tar", ["-x", "--no-same-owner", "-f", tar, "-C", join(runDir, "variant")]);
  rmSync(tar);

  const recorded = cutAtPrOpen(await readSession(spec.checkpoint ?? replayCase.checkpoint.session, spec.region), replayCase.checkpoint.prOrdinal);
  writeFileSync(join(runDir, "checkpoint", "session.jsonl"), recorded.jsonl);

  const bundle = join(runDir, "seed", "omni.bundle");
  await fetchTo(spec.omniBundle, bundle);
  const commits = await bundleCommits(bundle);

  copyFileSync(join(COMPOSE_DIR, "verdaccio.yaml"), join(runDir, "sim", "verdaccio.yaml"));
  copyFileSync(join(COMPOSE_DIR, "replay.yml"), join(runDir, "replay.yml"));
  writeFileSync(join(runDir, "replay-home", "npmrc"), "registry=http://npm:4873/\n");
  writeFileSync(
    join(runDir, "model-aws", "config"),
    ["[default]", "region = us-west-2", "credential_process = cat /sim/model-aws/session.json", ""].join("\n"),
  );
  const npmCache = join(spec.workRoot, "_cache", "npm");
  mkdirSync(npmCache, { recursive: true });

  const subnets = await pickSubnets();
  const controlToken = randomBytes(24).toString("hex");
  const humanToken = `ghp_replay${randomBytes(16).toString("hex")}`;
  writeFileSync(
    join(runDir, ".env"),
    dotenv({
      RUN_DIR: runDir,
      SIM_IMAGE: spec.simImage,
      CONTROL_TOKEN: controlToken,
      SIM_NET: subnets.sim,
      CTL_NET: subnets.control,
      BUDGET_USD: String(replayCase.caps.modelUsd),
      // run-phase.ts gives the agent the fixed token REPLAY_BOT_TOKEN and
      // opens the PR as BOT_LOGIN; this maps one to the other, so the agent
      // pushes as the App that owns the PR, as it does in production.
      GITHUB_STANDIN_HUMANS: JSON.stringify({ [humanToken]: HUMAN_LOGIN, [REPLAY_BOT_TOKEN]: BOT_LOGIN }),
      HUMAN_TOKEN: humanToken,
      CASE_ID: replayCase.id,
      REP: String(spec.rep),
      REF: spec.ref,
      HEAD_SHA: commits.headSha,
      BASE_SHA: commits.baseSha,
      NPM_CACHE_DIR: npmCache,
    }),
  );

  const compose = (args: string[]) =>
    run(
      "docker",
      ["compose", "-p", project, "-f", join(runDir, "replay.yml"), "--env-file", join(runDir, ".env"), ...args],
      { maxBuffer: 1 << 28 },
    );
  return { runDir, project, replayCase, compose };
};

/** What a side that wrote no result of its own is recorded as, so `compare` still pairs it. */
export const errorResult = (args: { caseId: string; rep: number; ref: string; detail: string }) => ({
  caseId: args.caseId,
  rep: args.rep,
  ref: args.ref,
  run: { status: "error" as const, costUsd: null, wallClockSeconds: null, gates: {} },
  output: { rootCause: null, diff: null, postmortem: null },
  detail: args.detail,
  scorecard: null,
});

/**
 * A regular file only. `replay-out` is written by the replay container, so
 * a symlink there would have the runner copy out whatever it points at.
 */
const regularFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export const runReplaySide = async (spec: ReplaySideSpec): Promise<{ status: string; detail: string }> => {
  const log = spec.log ?? ((event, fields = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields })));
  const collected = mkdtempSync(join(tmpdir(), "replay-collect-"));
  const upload = async () => {
    try {
      if (spec.out.startsWith("s3://")) {
        await run("aws", ["s3", "cp", "--only-show-errors", "--recursive", collected, spec.out]);
      } else cpSync(collected, resolve(spec.out), { recursive: true });
    } finally {
      rmSync(collected, { recursive: true, force: true });
    }
  };
  let prepared: PreparedReplay;
  try {
    prepared = await prepareReplaySide(spec);
  } catch (error) {
    const detail = `the runner could not prepare the side: ${error instanceof Error ? error.message : String(error)}`;
    log("side_failed", { error: detail });
    rmSync(join(spec.workRoot, spec.runId), { recursive: true, force: true });
    const caseId = loadCase(spec.caseJson).id;
    writeFileSync(join(collected, "result.json"), JSON.stringify(errorResult({ caseId, rep: spec.rep, ref: spec.ref, detail }), null, 2));
    await upload();
    return { status: "error", detail };
  }
  const { compose, runDir, replayCase } = prepared;
  let detail = "the side did not finish";
  let session: ModelSession | null = null;
  const refreshSession = async () => {
    if (session && (!session.expiration || session.expiration.getTime() - Date.now() > SESSION_REFRESH_MS)) return;
    session = await resolveModelSession(spec.modelCredentials);
    if (session) writeModelSession(runDir, session);
  };
  try {
    await refreshSession();
    log("model_credentials", { mode: spec.modelCredentials === "none" ? "none" : "resolved" });
    await compose(["up", "-d", "--quiet-pull", "replay"]);
    const deadline = Date.now() + (replayCase.caps.wallClockSeconds + SETUP_ALLOWANCE_SECONDS) * 1000;
    let exitCode: string | null = null;
    while (Date.now() < deadline) {
      await sleep(10_000);
      await refreshSession();
      const { stdout } = await compose(["ps", "-a", "--format", "{{.State}} {{.ExitCode}}", "replay"]);
      const [state, code] = stdout.trim().split(" ");
      if (state === "exited") {
        exitCode = code;
        break;
      }
    }
    if (exitCode === null) {
      await compose(["stop", "--timeout", "30", "replay"]);
      detail = `the runner stopped the side at ${replayCase.caps.wallClockSeconds + SETUP_ALLOWANCE_SECONDS}s`;
    } else detail = `the replay container exited ${exitCode}`;
    log("side_ended", { detail });
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
    log("side_failed", { error: detail });
  } finally {
    try {
      const logs = await compose(["logs", "--no-color", "--timestamps"]);
      writeFileSync(join(collected, "compose.log"), logs.stdout);
    } catch (error) {
      log("log_collect_failed", { error: String(error) });
    }
    await compose(["down", "-v", "--remove-orphans"]).catch((error: Error) => log("teardown_failed", { error: error.message }));
    const result = join(runDir, "replay-out", "result.json");
    if (regularFile(result)) copyFileSync(result, join(collected, "result.json"));
    else {
      writeFileSync(
        join(collected, "result.json"),
        JSON.stringify(errorResult({ caseId: replayCase.id, rep: spec.rep, ref: spec.ref, detail: `no result: ${detail}` }), null, 2),
      );
    }
    if (regularFile(join(runDir, "results", "proxy.jsonl"))) copyFileSync(join(runDir, "results", "proxy.jsonl"), join(collected, "proxy.jsonl"));
    // For the judge in the report job: the cut, which the proxy trace
    // already carries turn by turn, so this puts nothing new in the bucket.
    copyFileSync(join(runDir, "checkpoint", "session.jsonl"), join(collected, "checkpoint.jsonl"));
    // The checkpoint and the model session must not outlive the side on the host.
    rmSync(runDir, { recursive: true, force: true });
  }
  let status = "error";
  try {
    status = (JSON.parse(readFileSync(join(collected, "result.json"), "utf8")) as { run?: { status?: string } }).run?.status ?? "error";
  } catch {
    detail = `${detail}; its result.json is not JSON`;
  }
  await upload();
  return { status, detail };
};
