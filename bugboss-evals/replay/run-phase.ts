/**
 * Runs one side of one Tier 2 case: the after-PR phase of a real incident,
 * resumed from a checkpoint under a variant's ops checkout.
 *
 * One side per call, on purpose. The resumed agent's checkout path is baked
 * into its recorded system prompt (`/work/<id>/omni`), so two sides on one
 * host would share a directory. Each side gets its own container, or they run
 * one after the other, and `compare` in `cli.ts` joins the two results.
 *
 * What it needs running already: a model proxy (sim/proxy) and a GitHub
 * stand-in (sim/standins/github), each with its control port reachable from
 * here. Both are reset at the start, so one pair of them serves many runs.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { IncidentView } from "../../bugboss/types";
import type { RunRecord, RunStatus } from "../core/aggregate";
import type { IncidentOutput } from "../core/blind";
import { measure } from "../core/metrics";
import { ratesFor } from "../core/price";
import type { Trace } from "../core/trace";
import type { ReplayCase } from "./case";
import { cutAtPrOpen, readSession, rewriteGitHubHost, type Checkpoint } from "./checkpoint";
import type { ChildConfig, ChildOutput } from "./child";

const exec = promisify(execFile);

export interface ReplayEnvironment {
  github: {
    /** REST base the agent's `gh` and the human merge reach, e.g. https://github:8444/api/v3. */
    apiUrl: string;
    /** Clone URL of omni on the stand-in, e.g. https://github:8444/thegoodparty/omni.git. */
    gitUrl: string;
    /** Control listener, e.g. http://github:9002. */
    controlUrl: string;
    /** A token listed in the stand-in's GITHUB_STANDIN_HUMANS. */
    humanToken: string;
  };
  proxy: {
    /** What the agent's Bedrock client dials: AWS_ENDPOINT_URL_BEDROCK_RUNTIME. */
    url: string;
    controlUrl: string;
  };
  /** The Tier 1 stack's Grafana, when the case has a scenario behind it. */
  grafanaUrl?: string;
  /** The stack's local CA, for the stand-ins' https listeners. */
  caFile?: string;
  awsRegion?: string;
}

export interface SideResult {
  caseId: string;
  rep: number;
  ref: string;
  run: RunRecord;
  output: IncidentOutput;
  /** Why the run ended as it did, in a sentence. */
  detail: string;
  scorecard: {
    turns: number;
    refusalLoops: number;
    peakContext: number | null;
  } | null;
}

const control = async (base: string, path: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
};

/**
 * The PR's head at the moment it opened, and the main commit it branched
 * from, read from the real repository. A read of github.com by the runner
 * with the runner's own credentials; the agent never gets these.
 */
export const resolvePrCommits = async (args: {
  checkpoint: Checkpoint;
  cacheDir: string;
  /** A local omni clone to seed the cache from, to avoid a full network clone. */
  omniSource?: string;
}): Promise<{ mirror: string; headSha: string; baseSha: string }> => {
  const { pr } = args.checkpoint;
  const mirror = join(args.cacheDir, `${pr.owner}-${pr.repo}.git`);
  const remote = `https://github.com/${pr.owner}/${pr.repo}.git`;
  if (!existsSync(mirror)) {
    await mkdir(args.cacheDir, { recursive: true });
    await exec("git", ["clone", "--mirror", args.omniSource ?? remote, mirror], { maxBuffer: 1 << 26 });
  }
  await exec(
    "git",
    ["-C", mirror, "fetch", remote, `+refs/pull/${pr.number}/head:refs/replay/pr-${pr.number}`, "+refs/heads/main:refs/replay/main"],
    { maxBuffer: 1 << 26 },
  );
  const { stdout } = await exec(
    "gh",
    ["api", "--paginate", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/commits`, "--jq", ".[] | [.sha, .commit.committer.date] | @tsv"],
    { maxBuffer: 1 << 26 },
  );
  const commits = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date] = line.split("\t");
      return { sha, at: Date.parse(date) };
    });
  const atOpen = commits.filter((c) => c.at <= args.checkpoint.prOpenedAt).at(-1);
  if (!atOpen) {
    throw new Error(`no commit on PR ${pr.number} predates its opening at ${new Date(args.checkpoint.prOpenedAt).toISOString()}`);
  }
  const base = await exec("git", ["-C", mirror, "merge-base", atOpen.sha, "refs/replay/main"]);
  return { mirror, headSha: atOpen.sha, baseSha: base.stdout.trim() };
};

export const statusOf = (args: {
  killed: boolean;
  overBudget: boolean;
  child: ChildOutput | null;
  exitCode: number | null;
  merged: boolean;
  resolvedAfterMerge: boolean;
}): { status: RunStatus; detail: string } => {
  if (args.overBudget) return { status: "over_budget", detail: "the model proxy reached the case's budget and throttled the run" };
  if (args.killed) return { status: "timed_out", detail: "the case's wall-clock cap was reached and the run was killed" };
  if (!args.child || args.exitCode !== 0) return { status: "error", detail: `the replay process exited ${args.exitCode}` };
  if (args.child.error) return { status: "error", detail: `runIncidentAgent threw: ${args.child.error}` };
  if (!args.child.stop.honoured) {
    return {
      status: "error",
      detail: "the variant never ran the replay's extensions, so its turn cap did not apply; it predates the extensions option",
    };
  }
  if (args.merged && args.resolvedAfterMerge) return { status: "completed", detail: "merged, and the deploy was confirmed" };
  if (args.child.stop.capped) return { status: "stalled", detail: "the replay's turn cap was reached before merge and confirmation" };
  return { status: "stalled", detail: "the agent ended before merge and confirmation" };
};

export const runPhase = async (args: {
  replayCase: ReplayCase;
  rep: number;
  ref: string;
  /** The variant's ops checkout, with its own node_modules installed. */
  variantRoot: string;
  env: ReplayEnvironment;
  cacheDir: string;
  omniSource?: string;
  modelId?: string;
}): Promise<SideResult> => {
  const { replayCase: c, env } = args;
  const scratch = await mkdtemp(join(tmpdir(), `replay-${c.id}-`));
  try {
    const recorded = cutAtPrOpen(await readSession(c.checkpoint.session, env.awsRegion), c.checkpoint.prOrdinal);
    const checkout = recorded.cwd;
    const suffix = join(recorded.incidentId, "omni");
    if (!checkout.endsWith(`/${suffix}`)) {
      throw new Error(`the checkpoint's checkout ${checkout} is not <workRoot>/${suffix}`);
    }
    const workRoot = checkout.slice(0, -suffix.length - 1);
    const ghHost = new URL(env.github.gitUrl).host;
    const checkpoint = { ...recorded, jsonl: rewriteGitHubHost(recorded.jsonl, ghHost) };
    if (!checkpoint.view) throw new Error("the checkpoint holds no get_incident view to resume from");

    const commits = await resolvePrCommits({ checkpoint, cacheDir: args.cacheDir, omniSource: args.omniSource });
    const repo = `${checkpoint.pr.owner}/${checkpoint.pr.repo}`;
    await control(env.github.controlUrl, "/__control/reset", {});
    await control(env.github.controlUrl, "/__control/seed", {
      repo,
      source: commits.mirror,
      main: commits.baseSha,
      branches: { [checkpoint.branch]: commits.headSha },
    });
    await control(env.github.controlUrl, "/__control/pulls", {
      repo,
      head: checkpoint.branch,
      base: "main",
      title: checkpoint.title ?? `Incident ${checkpoint.incidentId}`,
      body: checkpoint.body ?? "",
      number: checkpoint.pr.number,
      user: "bugboss[bot]",
    });
    await control(env.github.controlUrl, "/__control/ci", { mode: "scripted", verdicts: c.ci.verdicts });
    await control(env.proxy.controlUrl, "/__control/reset", {});

    // The recorded prompt names this path, so the checkout has to be exactly here.
    if (!existsSync(workRoot)) {
      throw new Error(`${workRoot} does not exist; run Tier 2 inside the BugBoss image or on a host where it is writable`);
    }
    await rm(dirname(checkout), { recursive: true, force: true });
    await mkdir(dirname(checkout), { recursive: true });
    const gitEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(env.caFile ? { GIT_SSL_CAINFO: env.caFile } : {}),
    };
    const origin = new URL(env.github.gitUrl);
    origin.username = "x-access-token";
    origin.password = "replay-fake-bot";
    await exec("git", ["clone", "--filter=blob:none", "--branch", checkpoint.branch, origin.toString(), checkout], {
      env: gitEnv,
      maxBuffer: 1 << 26,
    });

    const outPath = join(scratch, "out.json");
    const config: ChildConfig = {
      incidentId: checkpoint.incidentId,
      sessionKey: `sessions/incident/${checkpoint.incidentId}/session.jsonl`,
      workRoot,
      checkpoint: checkpoint.jsonl,
      view: checkpoint.view as unknown as IncidentView,
      script: c.script,
      turnCap: c.stop.turnCap,
      // The agent's own deadline sits past the kill, so the cap is ours alone.
      timeoutSeconds: c.caps.wallClockSeconds + 600,
      ...(args.modelId ? { modelId: args.modelId } : {}),
      ...(env.awsRegion ? { awsRegion: env.awsRegion } : {}),
      github: {
        apiUrl: env.github.apiUrl,
        owner: checkpoint.pr.owner,
        repo: checkpoint.pr.repo,
        prNumber: checkpoint.pr.number,
        humanToken: env.github.humanToken,
      },
      ...(env.grafanaUrl ? { grafana: { url: env.grafanaUrl, token: "replay-fake" } } : {}),
      outPath,
    };
    const configPath = join(scratch, "config.json");
    await writeFile(configPath, JSON.stringify(config));

    // Built from nothing, like the dispatcher builds an agent's environment:
    // fake credentials everywhere, and every AWS service but Bedrock pointed
    // at a closed port, so nothing in the run can reach production.
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? scratch,
      TMPDIR: scratch,
      REPLAY_VARIANT_ROOT: args.variantRoot,
      REPLAY_CONFIG: configPath,
      AWS_ACCESS_KEY_ID: "AKIAREPLAYFAKE000000",
      AWS_SECRET_ACCESS_KEY: "replay-fake",
      AWS_REGION: env.awsRegion ?? "us-west-2",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_ENDPOINT_URL: "http://127.0.0.1:9",
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: env.proxy.url,
      GH_HOST: ghHost,
      GH_ENTERPRISE_TOKEN: "replay-fake-bot",
      GITHUB_TOKEN: "replay-fake-bot",
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      BUGBOSS_OMNI_REPO: env.github.gitUrl,
      ...(env.grafanaUrl ? { GRAFANA_URL: env.grafanaUrl } : {}),
      ...(env.caFile
        ? { SSL_CERT_FILE: env.caFile, NODE_EXTRA_CA_CERTS: env.caFile, GIT_SSL_CAINFO: env.caFile }
        : {}),
    };
    const child = spawn(process.execPath, [require.resolve("tsx/cli"), join(__dirname, "child.ts")], {
      cwd: args.variantRoot,
      env: childEnv,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let killed = false;
    const kill = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, c.caps.wallClockSeconds * 1000);
    const startedAt = Date.now();
    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    clearTimeout(kill);
    const endedAt = Date.now();

    const output: ChildOutput | null = existsSync(outPath)
      ? (JSON.parse(await readFile(outPath, "utf8")) as ChildOutput)
      : null;
    const proxyState = (await control(env.proxy.controlUrl, "/__control/state")) as {
      spendUsd?: number;
      overBudget?: boolean;
    };
    const traceText = await (await fetch(`${env.proxy.controlUrl.replace(/\/$/, "")}/__control/trace`)).text();
    // Required at use rather than imported: the adapter lands with the proxy
    // (evals-proxy), and this keeps the rest of replay/ loadable without it.
    const { parseProxyLog } = require("../core/adapters/proxy-log") as {
      parseProxyLog: (jsonl: string) => Trace[];
    };
    const agentTrace = parseProxyLog(traceText).find((t) => t.toolNames.includes("monitor")) ?? null;
    const card = agentTrace ? measure(agentTrace, ratesFor(agentTrace.model)) : null;

    const boss = output?.boss;
    const firstMerge = boss?.merges.find((m) => m.merged) ?? null;
    const merged = firstMerge !== null;
    const resolvedAfterMerge =
      firstMerge !== null && (boss?.resolved ?? []).some((r) => r.at >= firstMerge.at && r.evidence.trim() !== "");

    let diff: string | null = null;
    try {
      await exec("git", ["-C", checkout, "fetch", "origin", checkpoint.branch], { env: gitEnv });
      diff = (await exec("git", ["-C", checkout, "diff", commits.baseSha, "FETCH_HEAD"], { maxBuffer: 1 << 28 })).stdout;
    } catch {
      diff = null;
    }

    const { status, detail } = statusOf({
      killed,
      overBudget: proxyState.overBudget === true,
      child: output,
      exitCode,
      merged,
      resolvedAfterMerge,
    });
    return {
      caseId: c.id,
      rep: args.rep,
      ref: args.ref,
      run: {
        status,
        costUsd: typeof proxyState.spendUsd === "number" ? proxyState.spendUsd : null,
        wallClockSeconds: ((output?.endedAt ?? endedAt) - (output?.startedAt ?? startedAt)) / 1000,
        gates: {
          merged,
          resolvedAfterMerge,
          closed: boss?.analysis != null,
          noRefusalLoop: card !== null && card.refusals.loops.length === 0,
          withinCaps: status !== "timed_out" && status !== "over_budget",
        },
      },
      output: {
        rootCause: checkpoint.rootCause,
        diff: diff && diff.trim() !== "" ? diff : null,
        postmortem: boss?.analysis?.postmortem ?? null,
      },
      detail,
      scorecard: card
        ? { turns: card.turns, refusalLoops: card.refusals.loops.length, peakContext: card.context.peak }
        : null,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
