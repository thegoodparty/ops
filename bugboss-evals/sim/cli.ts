import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { compare as comparePairs, signTest, type PairRecord, type RunRecord } from "../core/aggregate";
import type { IncidentOutput } from "../core/blind";
import { createBedrockJudgeModel, judgePair } from "../core/judge";
import { renderComparison } from "../core/report";
import { loadScenario } from "../core/scenario";
import type { GateName, GateResult } from "./gates";
import {
  OPS_ROOT,
  buildBugbossImage,
  buildSimImage,
  localDefaults,
  omniBundle,
  runScenario,
  scenarioJsonFor,
  type RunResult,
} from "./orchestrator";

const run = promisify(execFile);

const USAGE = `Usage: npx tsx bugboss-evals/sim/cli.ts <command> [options]

  run      --scenario <id> (--ref <git ref> | --image <tag>) [--rep 1] [--side baseline]
           [--sim-image <tag>] [--run-id <id>] [--out <dir|s3://...>]
           [--omni-bundle <path|s3://...|auto>] [--omni-dir <omni checkout>]
           [--zero-spend]      (no model credentials anywhere: every model call
                                fails, so the run exercises the stack for $0)
  compare  --baseline <ref> --candidate <ref> [--scenarios a,b] [--reps 3]
           [--parallel 6] [--out <dir>] [--omni-dir <omni checkout>]
  aa       --ref <ref> [same options as compare]
  report   --dir <dir with result.json files> [--out report.md]
  plan     --comment "<bugboss eval ...>" --baseline <sha> --candidate <sha>
           [--scenarios-dir bugboss-evals/scenarios]
  seed-bundle --sha <omni sha> [--omni-dir <omni checkout>] [--upload]

A run is one whole incident, black box, against the stack in sim/compose.
Model calls cost real money: every run is capped by its scenario's caps, and
compare, aa and plan refuse anything past the caps below.`;

// The spend ceiling lives here, in code, so a comment cannot raise it.
export const CAPS = { reps: 3, scenarios: 6, runs: 36, totalUsd: 700 };

type Args = Record<string, string | true>;

export const parseArgs = (argv: string[]): { command: string; args: Args } => {
  const [command = "", ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) args[token.slice(2)] = true;
    else {
      args[token.slice(2)] = next;
      i++;
    }
  }
  return { command, args };
};

const str = (args: Args, name: string, fallback?: string): string => {
  const value = args[name];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required\n\n${USAGE}`);
};

const scenariosRoot = (args: Args): string => resolve(str(args, "scenarios-dir", join(OPS_ROOT, "bugboss-evals", "scenarios")));

export const listScenarios = (root: string): string[] =>
  existsSync(root)
    ? readdirSync(root).filter((name) => existsSync(join(root, name, "scenario.json"))).sort()
    : [];

// ------------------------------------------------------------------- plan

export interface PlannedRun {
  scenario: string;
  side: "baseline" | "candidate";
  ref: string;
  rep: number;
  runId: string;
}

export interface Plan {
  evalId: string;
  mode: "ab" | "aa";
  scenarios: string[];
  reps: number;
  maxUsd: number;
  runs: PlannedRun[];
}

/**
 * `bugboss eval [aa] [scenarios=a,b] [reps=N]`, from a PR comment. The
 * words are ours, not a person's: this is a command syntax for a trigger, so
 * anything it does not recognise is refused rather than guessed at.
 */
export const planFromComment = (args: {
  comment: string;
  baseline: string;
  candidate: string;
  available: string[];
  capUsd: (scenario: string) => number;
  evalId?: string;
}): Plan => {
  const words = args.comment.trim().split(/\s+/);
  if (words[0]?.toLowerCase() !== "bugboss" || words[1]?.toLowerCase() !== "eval") {
    throw new Error('the comment must start with "bugboss eval"');
  }
  let mode: Plan["mode"] = "ab";
  let scenarios = args.available;
  let reps = CAPS.reps;
  for (const word of words.slice(2)) {
    if (word === "aa") mode = "aa";
    else if (word.startsWith("scenarios=")) scenarios = word.slice("scenarios=".length).split(",").filter(Boolean);
    else if (word.startsWith("reps=")) reps = Number(word.slice("reps=".length));
    else throw new Error(`unrecognised option "${word}"; the syntax is: bugboss eval [aa] [scenarios=a,b] [reps=N]`);
  }
  const unknown = scenarios.filter((id) => !args.available.includes(id));
  if (unknown.length > 0) throw new Error(`no such scenario: ${unknown.join(", ")} (have: ${args.available.join(", ")})`);
  if (scenarios.length === 0) throw new Error("no scenarios to run");
  if (!Number.isInteger(reps) || reps < 1 || reps > CAPS.reps) throw new Error(`reps must be 1 to ${CAPS.reps}`);
  if (scenarios.length > CAPS.scenarios) throw new Error(`at most ${CAPS.scenarios} scenarios per eval`);
  const runs: PlannedRun[] = [];
  const evalId = args.evalId ?? `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const sides: [PlannedRun["side"], string][] =
    mode === "aa" ? [["baseline", args.baseline], ["candidate", args.baseline]] : [["baseline", args.baseline], ["candidate", args.candidate]];
  for (const scenario of scenarios) {
    for (let rep = 1; rep <= reps; rep++) {
      for (const [side, ref] of sides) runs.push({ scenario, side, ref, rep, runId: `${evalId}-${scenario}-${side}-r${rep}` });
    }
  }
  if (runs.length > CAPS.runs) throw new Error(`${runs.length} runs is over the cap of ${CAPS.runs}`);
  const maxUsd = runs.reduce((sum, planned) => sum + args.capUsd(planned.scenario), 0);
  if (maxUsd > CAPS.totalUsd) throw new Error(`worst-case model spend $${maxUsd} is over the cap of $${CAPS.totalUsd}`);
  return { evalId, mode, scenarios, reps, maxUsd, runs };
};

// ------------------------------------------------------------------ bundles

const resolveBundle = async (args: Args, baseSha: string): Promise<string> => {
  const wanted = str(args, "omni-bundle", "auto");
  const cache = localDefaults().bundleCache;
  const bucket = process.env.EVALS_BUCKET;
  const url = wanted === "auto" && bucket ? `s3://${bucket}/omni/${baseSha}.bundle` : wanted;
  if (url.startsWith("s3://")) {
    const local = join(cache, `${baseSha}.bundle`);
    if (!existsSync(local)) {
      mkdirSync(cache, { recursive: true });
      await run("aws", ["s3", "cp", "--only-show-errors", url, local]);
    }
    return local;
  }
  if (url !== "auto") return resolve(url);
  return omniBundle(str(args, "omni-dir", process.env.OMNI_DIR ?? join(homedir(), "Repos", "thegoodparty", "omni")), baseSha, cache);
};

// ECR images are pulled by the host daemon, which needs the CLI logged in.
const ecrLogin = async (image: string) => {
  const registry = /^(\d+\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com)\//.exec(image);
  if (!registry) return;
  const { stdout } = await run("aws", ["ecr", "get-login-password", "--region", registry[2]]);
  await new Promise<void>((resolvePromise, reject) => {
    const child = execFile("docker", ["login", "--username", "AWS", "--password-stdin", registry[1]], (error) =>
      error ? reject(error) : resolvePromise(),
    );
    child.stdin?.end(stdout);
  });
};

// -------------------------------------------------------------------- run

const sideOf = (args: Args, runId: string): string | null => {
  if (typeof args.side === "string") return args.side;
  const match = /-(baseline|candidate)-r\d+$/.exec(runId);
  return match ? match[1] : null;
};

const runOne = async (args: Args, simImage?: string): Promise<RunResult & { side: string | null }> => {
  const scenarioJson = scenarioJsonFor(str(args, "scenario"));
  const { scenario } = loadScenario(scenarioJson);
  const rep = Number(str(args, "rep", "1"));
  const runId = str(args, "run-id", `${scenario.id}-r${rep}-${randomBytes(3).toString("hex")}`);
  const ref = typeof args.ref === "string" ? args.ref : null;
  const image = typeof args.image === "string" ? args.image : ref ? (await buildBugbossImage(ref)).tag : null;
  if (!image) throw new Error(`--ref or --image is required\n\n${USAGE}`);
  const sim = simImage ?? (typeof args["sim-image"] === "string" ? args["sim-image"] : await buildSimImage());
  await ecrLogin(image);
  await ecrLogin(sim);
  const defaults = localDefaults();
  const result = await runScenario({
    scenarioJson,
    bugbossImage: image,
    simImage: sim,
    ref,
    rep,
    runId,
    workRoot: defaults.workRoot,
    omniBundle: await resolveBundle(args, scenario.omni.baseSha),
    modelCredentials:
      args["zero-spend"] === true
        ? "none"
        : { profile: process.env.AWS_PROFILE, roleArn: process.env.BUGBOSS_EVALS_MODEL_ROLE_ARN },
  });
  const side = sideOf(args, runId);
  writeFileSync(join(result.resultsDir, "result.json"), JSON.stringify({ ...result, side }, null, 2));
  const out = typeof args.out === "string" ? args.out : null;
  if (out?.startsWith("s3://")) {
    await run("aws", ["s3", "cp", "--only-show-errors", "--recursive", result.resultsDir, out]);
  } else if (out) {
    cpSync(result.resultsDir, resolve(out), { recursive: true });
  }
  return { ...result, side };
};

// ----------------------------------------------------------------- report

interface Stored extends RunResult {
  side: string | null;
  /** Where this result.json was found, which is not resultsDir once synced from S3. */
  dir: string;
}

const findResults = (dir: string): Stored[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return findResults(path);
    return name === "result.json" ? [{ ...(JSON.parse(readFileSync(path, "utf8")) as Stored), dir }] : [];
  });

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export interface Pair {
  scenario: string;
  rep: number;
  baseline: Stored;
  candidate: Stored;
}

export const pairUp = (results: Stored[]): { pairs: Pair[]; unpaired: Stored[] } => {
  const byKey = new Map<string, { baseline?: Stored; candidate?: Stored }>();
  for (const result of results) {
    if (result.side !== "baseline" && result.side !== "candidate") continue;
    const key = `${result.scenario}#${result.rep}`;
    const entry = byKey.get(key) ?? {};
    entry[result.side] = result;
    byKey.set(key, entry);
  }
  const pairs: Pair[] = [];
  const unpaired: Stored[] = results.filter((result) => result.side !== "baseline" && result.side !== "candidate");
  for (const entry of byKey.values()) {
    if (entry.baseline && entry.candidate) {
      pairs.push({ scenario: entry.baseline.scenario, rep: entry.baseline.rep, baseline: entry.baseline, candidate: entry.candidate });
    } else unpaired.push(...[entry.baseline, entry.candidate].filter((side): side is Stored => side !== undefined));
  }
  pairs.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.rep - b.rep);
  return { pairs, unpaired };
};

/**
 * A gate that passes in every baseline rep of a scenario and fails in any
 * candidate rep is a blocking regression. Gates are not statistical.
 */
export const gateRegressions = (pairs: Pair[]): { scenario: string; gate: GateName }[] => {
  const out: { scenario: string; gate: GateName }[] = [];
  const byScenario = new Map<string, Pair[]>();
  for (const pair of pairs) byScenario.set(pair.scenario, [...(byScenario.get(pair.scenario) ?? []), pair]);
  for (const [scenario, group] of byScenario) {
    const passes = (gates: GateResult[], name: GateName) => gates.find((gate) => gate.name === name)?.pass ?? false;
    const names = new Set(group.flatMap((pair) => [...pair.baseline.gates, ...pair.candidate.gates].map((gate) => gate.name)));
    for (const name of names) {
      const baselineAll = group.every((pair) => passes(pair.baseline.gates, name));
      const candidateAny = group.some((pair) => !passes(pair.candidate.gates, name));
      if (baselineAll && candidateAny) out.push({ scenario, gate: name });
    }
  }
  return out;
};

const money = (value: number | null) => (value === null ? "n/a" : `$${value.toFixed(2)}`);
const minutes = (value: number | null) => (value === null ? "n/a" : `${(value / 60).toFixed(1)} min`);

type SignTest = (wins: number, losses: number) => number | undefined;

export const statusOf = (kind: string): RunRecord["status"] =>
  kind === "closed" || kind === "closed_inline"
    ? "completed"
    : kind === "wall_clock"
      ? "timed_out"
      : kind === "over_budget" || kind === "stalled"
        ? kind
        : "error";

const runRecord = (result: Stored): RunRecord => ({
  status: statusOf(result.end.kind),
  costUsd: result.costUsd,
  wallClockSeconds: result.wallClockSeconds,
  gates: Object.fromEntries(result.gates.map((gate) => [gate.name, gate.pass])),
});

interface StoredOutputs {
  rootCause: string | null;
  rootCauseSource?: "closing_summary" | "heuristic" | null;
  closingReport: { content: string } | null;
  fixDiff: string | null;
}

const incidentOutput = (result: Stored): IncidentOutput => {
  const path = join(result.dir, "outputs.json");
  if (!existsSync(path)) return { rootCause: null, diff: null, postmortem: null };
  const outputs = JSON.parse(readFileSync(path, "utf8")) as StoredOutputs;
  return {
    rootCause: outputs.rootCause,
    rootCauseSource: outputs.rootCauseSource,
    diff: outputs.fixDiff,
    postmortem: outputs.closingReport?.content ?? null,
  };
};

export const renderReport = (args: { pairs: Pair[]; unpaired: Stored[]; signTest: SignTest | null; judged: string | null }): string => {
  const { pairs } = args;
  const lines: string[] = ["## BugBoss Tier 1 eval", ""];
  const regressions = gateRegressions(pairs);
  lines.push("### Gates", "");
  lines.push(
    regressions.length === 0
      ? "No gate regressed: no gate that passed in every baseline rep failed in a candidate rep."
      : `**Blocking:** ${regressions.map((r) => `\`${r.gate}\` in ${r.scenario}`).join(", ")}.`,
    "",
  );

  const direction = (pick: (result: Stored) => number | null, label: string) => {
    const diffs = pairs
      .map((pair) => {
        const a = pick(pair.baseline);
        const b = pick(pair.candidate);
        return a === null || b === null ? null : b - a;
      })
      .filter((diff): diff is number => diff !== null);
    const lower = diffs.filter((diff) => diff < 0).length;
    const higher = diffs.filter((diff) => diff > 0).length;
    const p = args.signTest ? args.signTest(lower, higher) : undefined;
    return `${label}: candidate lower in ${lower} of ${diffs.length} pairs, higher in ${higher}${p === undefined ? "" : `, sign test p = ${p.toFixed(3)}`}.`;
  };
  lines.push("### Cost and wall clock", "");
  lines.push(direction((r) => r.costUsd, "Cost"), direction((r) => r.wallClockSeconds, "Wall clock"), "");
  if (!args.signTest) lines.push("The sign test (core/aggregate.ts) is not available in this build, so no direction is claimed.", "");

  lines.push("| Scenario | Rep | Baseline cost | Candidate cost | Baseline time | Candidate time | Baseline end | Candidate end |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const pair of pairs) {
    lines.push(
      `| ${pair.scenario} | ${pair.rep} | ${money(pair.baseline.costUsd)} | ${money(pair.candidate.costUsd)} | ${minutes(pair.baseline.wallClockSeconds)} | ${minutes(pair.candidate.wallClockSeconds)} | ${pair.baseline.end.kind} | ${pair.candidate.end.kind} |`,
    );
  }
  lines.push("");
  const scenarios = [...new Set(pairs.map((pair) => pair.scenario))];
  for (const scenario of scenarios) {
    const group = pairs.filter((pair) => pair.scenario === scenario);
    lines.push(
      `- ${scenario}: median cost ${money(median(group.flatMap((p) => (p.baseline.costUsd === null ? [] : [p.baseline.costUsd]))))} -> ${money(median(group.flatMap((p) => (p.candidate.costUsd === null ? [] : [p.candidate.costUsd]))))}, median time ${minutes(median(group.flatMap((p) => (p.baseline.wallClockSeconds === null ? [] : [p.baseline.wallClockSeconds]))))} -> ${minutes(median(group.flatMap((p) => (p.candidate.wallClockSeconds === null ? [] : [p.candidate.wallClockSeconds]))))}`,
    );
  }
  lines.push("", "### Quality", "", args.judged ?? "The judge (core/judge.ts) is not available in this build, so quality was not judged.", "");
  if (args.unpaired.length > 0) {
    lines.push(`${args.unpaired.length} runs had no partner and are not counted: ${args.unpaired.map((r) => r.runId).join(", ")}.`, "");
  }
  return lines.join("\n");
};

const report = async (dir: string, out: string, scenariosDir: string): Promise<string> => {
  const { pairs, unpaired } = pairUp(findResults(dir));
  let text: string;
  if (pairs.length > 0) {
    const model = createBedrockJudgeModel({});
    const records: PairRecord[] = [];
    for (const pair of pairs) {
      const scenarioDir = join(scenariosDir, pair.scenario);
      const { scenario } = loadScenario(join(scenarioDir, "scenario.json"));
      const pairId = `${pair.scenario}-r${pair.rep}`;
      const verdict = await judgePair({
        pairId,
        context: {
          alert: JSON.parse(readFileSync(join(scenarioDir, scenario.alert.file), "utf8")) as object,
          reference: readFileSync(join(scenarioDir, scenario.reference), "utf8"),
        },
        baseline: incidentOutput(pair.baseline),
        candidate: incidentOutput(pair.candidate),
        model,
      });
      records.push({
        pairId,
        scenarioId: pair.scenario,
        rep: pair.rep,
        baseline: runRecord(pair.baseline),
        candidate: runRecord(pair.candidate),
        verdict,
        vettedReference: true,
      });
    }
    const aa = pairs.every((pair) => pair.baseline.bugbossImage === pair.candidate.bugbossImage);
    text = renderComparison({
      comparison: comparePairs(records, { aa }),
      tier: "Tier 1",
      baselineRef: pairs[0].baseline.ref ?? pairs[0].baseline.bugbossImage,
      candidateRef: pairs[0].candidate.ref ?? pairs[0].candidate.bugbossImage,
    });
    if (unpaired.length > 0) {
      text += `\n${unpaired.length} runs had no partner and are not counted: ${unpaired.map((r) => r.runId).join(", ")}.\n`;
    }
  } else {
    text = renderReport({ pairs, unpaired, signTest, judged: null });
  }
  writeFileSync(out, text);
  return text;
};

// ---------------------------------------------------------------- compare

const pool = async <T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> => {
  const results: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await items[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
};

const compare = async (args: Args, baseline: string, candidate: string, mode: Plan["mode"]) => {
  const root = scenariosRoot(args);
  const available = listScenarios(root);
  const plan = planFromComment({
    comment: [
      "bugboss eval",
      mode === "aa" ? "aa" : "",
      typeof args.scenarios === "string" ? `scenarios=${args.scenarios}` : "",
      typeof args.reps === "string" ? `reps=${args.reps}` : "",
    ].join(" "),
    baseline,
    candidate,
    available,
    capUsd: (id) => loadScenario(join(root, id, "scenario.json")).scenario.caps.modelUsd,
  });
  const out = resolve(str(args, "out", join(localDefaults().workRoot, `eval-${plan.evalId}`)));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2));
  const images = new Map<string, string>();
  for (const ref of new Set(plan.runs.map((planned) => planned.ref))) images.set(ref, (await buildBugbossImage(ref)).tag);
  const sim = await buildSimImage();

  // Both sides of a pair start together, because Bedrock latency moves with
  // the time of day and a pair is the unit every comparison is made on.
  const pairs = new Map<string, PlannedRun[]>();
  for (const planned of plan.runs) {
    const key = `${planned.scenario}#${planned.rep}`;
    pairs.set(key, [...(pairs.get(key) ?? []), planned]);
  }
  await pool(
    [...pairs.values()].map((group) => () =>
      Promise.all(
        group.map((planned) =>
          runOne(
            {
              ...args,
              scenario: join(root, planned.scenario, "scenario.json"),
              image: images.get(planned.ref) ?? "",
              ref: planned.ref,
              rep: String(planned.rep),
              side: planned.side,
              "run-id": planned.runId,
              out: join(out, planned.runId),
            },
            sim,
          ),
        ),
      ),
    ),
    Number(str(args, "parallel", "3")),
  );
  return report(out, join(out, "report.md"), root);
};

// ------------------------------------------------------------------- main

export const main = async (argv: string[]): Promise<number> => {
  const { command, args } = parseArgs(argv);
  switch (command) {
    case "run": {
      const result = await runOne(args);
      console.log(JSON.stringify({ runId: result.runId, end: result.end, costUsd: result.costUsd, wallClockSeconds: result.wallClockSeconds, gates: result.gates }, null, 2));
      return result.end.kind === "error" ? 1 : 0;
    }
    case "compare":
      console.log(await compare(args, str(args, "baseline"), str(args, "candidate"), "ab"));
      return 0;
    case "aa":
      console.log(await compare(args, str(args, "ref"), str(args, "ref"), "aa"));
      return 0;
    case "report":
      console.log(await report(resolve(str(args, "dir")), resolve(str(args, "out", "report.md")), scenariosRoot(args)));
      return 0;
    case "plan": {
      const root = scenariosRoot(args);
      try {
        const plan = planFromComment({
          comment: str(args, "comment"),
          baseline: str(args, "baseline"),
          candidate: str(args, "candidate"),
          available: listScenarios(root),
          capUsd: (id) => loadScenario(join(root, id, "scenario.json")).scenario.caps.modelUsd,
        });
        console.log(JSON.stringify(plan));
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
      }
    }
    case "seed-bundle": {
      const sha = str(args, "sha");
      const path = await omniBundle(str(args, "omni-dir", process.env.OMNI_DIR ?? join(homedir(), "Repos", "thegoodparty", "omni")), sha, localDefaults().bundleCache);
      if (args.upload === true) {
        const bucket = process.env.EVALS_BUCKET ?? "goodparty-bugboss-evals";
        const url = `s3://${bucket}/omni/${sha}.bundle`;
        await run("aws", ["s3", "cp", "--only-show-errors", path, url]);
        console.log(url);
      } else console.log(path);
      return 0;
    }
    default:
      console.error(USAGE);
      return command === "" || command === "help" ? 0 : 2;
  }
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
