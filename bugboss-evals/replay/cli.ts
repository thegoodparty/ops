/**
 * Tier 2 from the command line.
 *
 *   side     run one side of one case and write its result as JSON
 *   compare  join baseline and candidate side results into pairs, judge the
 *            pairs that reached a post-mortem, and write the report
 *
 * Sides run separately because each needs `/work/<id>/omni` to itself; the
 * fan-out runs them in parallel containers and hands the JSON to `compare`.
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { compare, type PairRecord } from "../core/aggregate";
import { createBedrockJudgeModel, DEFAULT_JUDGE_MODEL, judgePair, type JudgeContext } from "../core/judge";
import { renderComparison } from "../core/report";
import { loadCase, referenceFor } from "./case";
import { cutAtPrOpen, readSession } from "./checkpoint";
import { runPhase, type SideResult } from "./run-phase";

const USAGE = `usage:
  cli.ts side --case <case.json> --rep <n> --ref <name> --variant-root <ops checkout>
              --github-api <url> --github-git <url> --github-control <url> --human-token <token>
              --proxy-url <url> --proxy-control <url> --out <result.json>
              [--grafana-url <url>] [--ca-file <pem>] [--cache-dir <dir>] [--omni-source <repo>]
              [--model-id <id>] [--region <aws region>]
  side reads REPLAY_GITHUB_CONTROL_TOKEN and REPLAY_PROXY_CONTROL_TOKEN from the
  environment when the stand-in or the proxy sets CONTROL_TOKEN.
  cli.ts compare --case <case.json> --baseline <result.json>... --candidate <result.json>...
              --out <report.md> [--aa] [--no-judge] [--judge-model <id>] [--region <aws region>]`;

const parse = (argv: string[]) => {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}\n${USAGE}`);
    const name = arg.slice(2);
    if (name === "aa" || name === "no-judge") {
      flags.set(name, ["true"]);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value\n${USAGE}`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
    i += 1;
  }
  const one = (name: string): string => {
    const values = flags.get(name);
    if (!values?.length) throw new Error(`--${name} is required\n${USAGE}`);
    return values[values.length - 1];
  };
  const maybe = (name: string): string | undefined => flags.get(name)?.at(-1);
  const all = (name: string): string[] => flags.get(name) ?? [];
  return { one, maybe, all, has: (name: string) => flags.has(name) };
};

const side = async (args: ReturnType<typeof parse>) => {
  const replayCase = loadCase(args.one("case"));
  // Fails here, before any work, when the case names a scenario that is not there.
  referenceFor(replayCase);
  const result = await runPhase({
    replayCase,
    rep: Number(args.one("rep")),
    ref: args.one("ref"),
    variantRoot: args.one("variant-root"),
    env: {
      github: {
        apiUrl: args.one("github-api"),
        gitUrl: args.one("github-git"),
        controlUrl: args.one("github-control"),
        humanToken: args.one("human-token"),
        controlToken: process.env.REPLAY_GITHUB_CONTROL_TOKEN || undefined,
      },
      proxy: {
        url: args.one("proxy-url"),
        controlUrl: args.one("proxy-control"),
        controlToken: process.env.REPLAY_PROXY_CONTROL_TOKEN || undefined,
      },
      grafanaUrl: args.maybe("grafana-url"),
      caFile: args.maybe("ca-file"),
      awsRegion: args.maybe("region"),
    },
    cacheDir: args.maybe("cache-dir") ?? join(homedir(), ".cache", "bugboss-evals"),
    omniSource: args.maybe("omni-source"),
    modelId: args.maybe("model-id"),
  });
  await writeFile(args.one("out"), JSON.stringify(result, null, 2));
  console.log(`${result.caseId} rep ${result.rep} (${result.ref}): ${result.run.status}. ${result.detail}`);
};

const compareSides = async (args: ReturnType<typeof parse>) => {
  const replayCase = loadCase(args.one("case"));
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as SideResult;
  const baselines = args.all("baseline").map(read);
  const candidates = args.all("candidate").map(read);
  const byRep = new Map(candidates.map((c) => [c.rep, c]));
  const unmatched = baselines.filter((b) => !byRep.has(b.rep)).map((b) => b.rep);
  if (unmatched.length || baselines.length !== candidates.length) {
    throw new Error(`every baseline rep needs a candidate rep; unmatched: ${unmatched.join(", ") || "counts differ"}`);
  }

  const judging = !args.has("no-judge");
  const judgeModelId = args.maybe("judge-model") ?? DEFAULT_JUDGE_MODEL;
  const model = judging ? createBedrockJudgeModel({ modelId: judgeModelId, region: args.maybe("region") }) : null;
  const reference = referenceFor(replayCase);
  let context: JudgeContext | null = null;
  if (judging) {
    const checkpoint = cutAtPrOpen(await readSession(replayCase.checkpoint.session, args.maybe("region")), replayCase.checkpoint.prOrdinal);
    // The recorded signals are what the agent was answering; the scenario's
    // synthetic alert stands in only when the checkpoint holds none.
    context = {
      alert: checkpoint.view?.signals ?? (reference.vetted ? reference.alert : null),
      reference: reference.vetted ? reference.reference : null,
    };
  }

  const pairs: PairRecord[] = [];
  for (const baseline of baselines) {
    const candidate = byRep.get(baseline.rep) as SideResult;
    const pairId = `${replayCase.id}/rep-${baseline.rep}`;
    // The judge only runs when the phase reached a post-mortem on both sides;
    // before that there is nothing of the agent's own to compare.
    const judgeable = model && context && baseline.output.postmortem !== null && candidate.output.postmortem !== null;
    pairs.push({
      pairId,
      scenarioId: replayCase.id,
      rep: baseline.rep,
      vettedReference: reference.vetted,
      baseline: baseline.run,
      candidate: candidate.run,
      verdict: judgeable
        ? await judgePair({
            pairId,
            context: context as JudgeContext,
            baseline: baseline.output,
            candidate: candidate.output,
            model,
            modelId: judgeModelId,
            blinding: { identifying: [baseline.ref, candidate.ref] },
          })
        : null,
    });
  }
  const report = renderComparison({
    comparison: compare(pairs, { aa: args.has("aa") }),
    tier: "Tier 2",
    baselineRef: baselines[0]?.ref ?? "",
    candidateRef: candidates[0]?.ref ?? "",
    ...(judging ? { judgeModel: judgeModelId } : {}),
  });
  await writeFile(args.one("out"), report);
  console.log(report);
};

if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  const run = command === "side" ? side : command === "compare" ? compareSides : null;
  if (!run) {
    console.error(USAGE);
    process.exit(2);
  }
  run(parse(rest)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
