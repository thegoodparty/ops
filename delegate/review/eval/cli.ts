import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, loadScenarios, readManifest, saveCases, scenarioNames, scenarioSplits } from "./cases";
import { pullCache, pushCache, replayKey } from "./cache";
import type { CacheLayout } from "./cache";
import { SplitSchema } from "./expect";
import { loadRunResults, replayAll, resultFromRecord } from "./replay";
import { createAnthropicJudgeModel, judgeAll, DEFAULT_JUDGE_MODEL } from "./judge";
import { summarize, renderMarkdown, renderPrComment } from "./report";

const parseFlags = (args: string[]): Record<string, string | boolean> => {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
};

const flag = (flags: Record<string, string | boolean>, key: string): string | undefined => {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
};

const boolFlag = (flags: Record<string, string | boolean>, key: string): boolean =>
  flags[key] === true;

const usage = () => {
  console.error(
    [
      "Usage:",
      "  review:eval cases scenarios --manifest <scenarios.json> --out <dir> [--suite <name>] [--split tune|holdout]",
      "  review:eval cases snapshot --out <dir> [--repo <r>] [--limit <n>] [--only-complete]",
      "  review:eval results from-cases --cases <dir|s3> --out <dir>",
      "  review:eval replay --cases <dir|s3> --out <dir> [--variant <label>] [--concurrency 4] [--work-dir /tmp/review-eval] [--replays 1] [--force] [--split tune|holdout --manifest <scenarios.json>]",
      "  review:eval cache key | cache pull|push --suite <name> --key <replay-key> --out <dir> [--layout flat|runs]",
      "  review:eval judge --cases <dir|s3> --a <dir> --b <dir> [--label-a <x>] [--label-b <y>] [--passes 4] [--concurrency 6] [--model <id>] [--manifest <scenarios.json>] [--out <report.md>] [--pr-comment <comment.md>] [--run-url <url>]",
    ].join("\n"),
  );
  process.exit(1);
};

const main = async () => {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "cases" && argv[1] === "scenarios") {
    const flags = parseFlags(argv.slice(2));
    const manifest = flag(flags, "manifest");
    const out = flag(flags, "out");
    if (!manifest || !out) { console.error("--manifest and --out are required"); process.exit(1); }
    const loaded = await loadScenarios(readManifest(manifest), { suite: flag(flags, "suite"), split: flag(flags, "split") });
    saveCases(loaded.map((l) => l.record), out);
    for (const { scenario, record } of loaded) {
      console.error(`  ${scenario.id} (${scenario.suite}) ${record.repo}#${record.prNumber} ${record.runId}`);
    }
    console.error(`Saved ${loaded.length} scenario case(s) to ${out}`);
    return;
  }

  if (command === "cases") {
    const subcommand = argv[1];
    if (subcommand !== "snapshot") usage();
    const flags = parseFlags(argv.slice(2));
    const out = flag(flags, "out");
    if (!out) { console.error("--out is required"); process.exit(1); }
    const repo = flag(flags, "repo");
    const limit = flag(flags, "limit") ? parseInt(flag(flags, "limit")!, 10) : undefined;
    const onlyComplete = boolFlag(flags, "only-complete");

    console.error("Loading cases from S3...");
    let records = await loadCases({ from: "s3", repo, limit: onlyComplete ? undefined : limit });

    if (onlyComplete) {
      records = records
        .filter((r) => r.action === "approved" || r.action === "commented")
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (limit !== undefined) records = records.slice(0, limit);
    }

    saveCases(records, out);
    console.error(`Saved ${records.length} case(s) to ${out}`);
    return;
  }

  if (command === "results") {
    const subcommand = argv[1];
    if (subcommand !== "from-cases") usage();
    const flags = parseFlags(argv.slice(2));
    const casesFrom = flag(flags, "cases");
    const out = flag(flags, "out");
    if (!casesFrom || !out) { console.error("--cases and --out are required"); process.exit(1); }
    const records = await loadCases({ from: casesFrom });
    mkdirSync(out, { recursive: true });
    let written = 0;
    for (const record of records) {
      if (record.action !== "approved" && record.action !== "commented") continue;
      writeFileSync(join(out, `${record.runId}.json`), JSON.stringify(resultFromRecord(record), null, 2));
      written++;
    }
    console.error(`Wrote ${written} production result(s) to ${out} (skipped ${records.length - written} that posted nothing)`);
    return;
  }

  if (command === "cache") {
    const subcommand = argv[1];
    if (subcommand === "key") {
      console.log(replayKey(process.cwd()));
      return;
    }
    if (subcommand !== "pull" && subcommand !== "push") usage();
    const flags = parseFlags(argv.slice(2));
    const suite = flag(flags, "suite");
    const key = flag(flags, "key");
    const dir = flag(flags, "out");
    const layout = flag(flags, "layout") ?? "flat";
    if (!suite || !key || !dir) { console.error("--suite, --key and --out are required"); process.exit(1); }
    if (layout !== "flat" && layout !== "runs") { console.error("--layout must be flat or runs"); process.exit(1); }
    const opts = { suite, key, dir, layout: layout as CacheLayout };
    if (subcommand === "pull") {
      const pulled = await pullCache(opts);
      console.error(`Pulled ${pulled.length} cached result(s) for ${suite} at replay key ${key}`);
    } else {
      const s = await pushCache(opts);
      console.error(
        `Pushed ${s.pushed.length} result(s) for ${suite} at replay key ${key} ` +
          `(skipped ${s.skippedPulled.length} pulled, ${s.skippedErrored.length} errored, ${s.skippedExisting.length} already cached)`,
      );
    }
    return;
  }

  if (command === "replay") {
    const flags = parseFlags(argv.slice(1));
    const casesFrom = flag(flags, "cases");
    const out = flag(flags, "out");
    if (!casesFrom || !out) { console.error("--cases and --out are required"); process.exit(1); }
    const variant = flag(flags, "variant");
    const concurrency = flag(flags, "concurrency") ? parseInt(flag(flags, "concurrency")!, 10) : 4;
    const workDir = flag(flags, "work-dir") ?? "/tmp/review-eval";
    const force = boolFlag(flags, "force");
    const replays = flag(flags, "replays") ? parseInt(flag(flags, "replays")!, 10) : 1;
    if (!(replays >= 1)) { console.error("--replays must be a positive integer"); process.exit(1); }

    let records = await loadCases({ from: casesFrom });
    const splitFlag = flag(flags, "split");
    if (splitFlag) {
      const split = SplitSchema.parse(splitFlag);
      const manifest = flag(flags, "manifest");
      if (!manifest) { console.error("--split needs --manifest <scenarios.json>"); process.exit(1); }
      const inSplit = scenarioNames(readManifest(manifest).filter((s) => s.split === split));
      records = records.filter((r) => inSplit.has(r.runId));
    }
    console.error(`Loaded ${records.length} case(s), ${replays} replay(s) each, concurrency ${concurrency}`);
    const results = await replayAll(records, { out, variant, workDir, force, replays }, { concurrency });
    const errors = results.filter((r) => r.error);
    console.error(
      `Done. ${results.length - errors.length} succeeded, ${errors.length} failed.`,
    );
    return;
  }

  if (command === "judge") {
    const flags = parseFlags(argv.slice(1));
    const casesFrom = flag(flags, "cases");
    const aDirArg = flag(flags, "a");
    const bDirArg = flag(flags, "b");
    if (!casesFrom || !aDirArg || !bDirArg) {
      console.error("--cases, --a, and --b are required");
      process.exit(1);
    }
    const labelA = flag(flags, "label-a") ?? "a";
    const labelB = flag(flags, "label-b") ?? "b";
    const passes = flag(flags, "passes") ? parseInt(flag(flags, "passes")!, 10) : 4;
    const concurrency = flag(flags, "concurrency") ? parseInt(flag(flags, "concurrency")!, 10) : 6;
    const modelId = flag(flags, "model") ?? DEFAULT_JUDGE_MODEL;
    const outFile = flag(flags, "out");
    const prCommentFile = flag(flags, "pr-comment");
    const runUrl = flag(flags, "run-url") ?? "";
    const manifest = flag(flags, "manifest");
    const scenarios = manifest ? readManifest(manifest) : undefined;
    const names = scenarios && scenarioNames(scenarios);

    const records = await loadCases({ from: casesFrom });
    const runsA = loadRunResults(aDirArg);
    const runsB = loadRunResults(bDirArg);
    const splits = scenarios && new Map([...scenarioSplits(scenarios)].filter(([id]) => records.some((r) => r.runId === id)));

    console.error(`Judging ${records.length} case(s) with model ${modelId}, ${passes} passes each, concurrency ${concurrency}...`);

    const model = createAnthropicJudgeModel({ model: modelId });
    const verdicts = await judgeAll(records, runsA, runsB, model, passes, concurrency);

    const summary = summarize(verdicts);
    const report = renderMarkdown(summary, verdicts, { labelA, labelB, names, splits });

    // Not printed: the report lists holdout cases, and CI job logs are readable by whoever tunes.
    if (outFile) {
      writeFileSync(outFile, report);
      console.error(`Report written to ${outFile}`);
    }

    if (prCommentFile) {
      const both = [...runsA.values(), ...runsB.values()].flatMap((runs) => [...runs.values()]);
      const replayCost = both.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const replayFailures = both.filter((r) => r.error).length;
      const comment = renderPrComment(summary, verdicts, {
        labelA,
        labelB,
        casesCount: records.length,
        replayCost,
        replayFailures,
        runUrl,
        resultsA: runsA,
        resultsB: runsB,
        names,
        splits,
      });
      writeFileSync(prCommentFile, comment);
      console.error(`PR comment written to ${prCommentFile}`);
    }

    return;
  }

  usage();
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
