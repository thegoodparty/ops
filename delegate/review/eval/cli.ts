import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases, saveCases } from "./cases";
import { replayAll, resultFromRecord } from "./replay";
import type { Result } from "./replay";
import { createAnthropicJudgeModel, judgeAll, DEFAULT_JUDGE_MODEL } from "./judge";
import { summarize, renderMarkdown } from "./report";

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

const loadResultsFromDir = (dir: string): Result[] => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as Result);
};

const usage = () => {
  console.error(
    [
      "Usage:",
      "  review:eval cases snapshot --out <dir> [--repo <r>] [--limit <n>]",
      "  review:eval results from-cases --cases <dir|s3> --out <dir>",
      "  review:eval replay --cases <dir|s3> --out <dir> [--variant <label>] [--concurrency 3] [--work-dir /tmp/review-eval] [--force]",
      "  review:eval judge --cases <dir|s3> --a <dir> --b <dir> [--label-a <x>] [--label-b <y>] [--passes 4] [--model <id>] [--out <report.md>]",
    ].join("\n"),
  );
  process.exit(1);
};

const main = async () => {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "cases") {
    const subcommand = argv[1];
    if (subcommand !== "snapshot") usage();
    const flags = parseFlags(argv.slice(2));
    const out = flag(flags, "out");
    if (!out) { console.error("--out is required"); process.exit(1); }
    const repo = flag(flags, "repo");
    const limit = flag(flags, "limit") ? parseInt(flag(flags, "limit")!, 10) : undefined;

    console.error("Loading cases from S3...");
    const records = await loadCases({ from: "s3", repo, limit });
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

  if (command === "replay") {
    const flags = parseFlags(argv.slice(1));
    const casesFrom = flag(flags, "cases");
    const out = flag(flags, "out");
    if (!casesFrom || !out) { console.error("--cases and --out are required"); process.exit(1); }
    const variant = flag(flags, "variant");
    const concurrency = flag(flags, "concurrency") ? parseInt(flag(flags, "concurrency")!, 10) : 3;
    const workDir = flag(flags, "work-dir") ?? "/tmp/review-eval";
    const force = boolFlag(flags, "force");

    const records = await loadCases({ from: casesFrom });
    console.error(`Replaying ${records.length} case(s) with concurrency ${concurrency}...`);
    const results = await replayAll(records, { out, variant, workDir, force }, { concurrency });
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
    const modelId = flag(flags, "model") ?? DEFAULT_JUDGE_MODEL;
    const outFile = flag(flags, "out");

    const records = await loadCases({ from: casesFrom });
    const resultsA = loadResultsFromDir(aDirArg);
    const resultsB = loadResultsFromDir(bDirArg);

    console.error(`Judging ${records.length} case(s) with model ${modelId}, ${passes} passes each...`);

    const model = createAnthropicJudgeModel({ model: modelId });
    const verdicts = await judgeAll(records, resultsA, resultsB, model, passes);

    const summary = summarize(verdicts);
    const report = renderMarkdown(summary, verdicts, { labelA, labelB });

    console.log(report);
    if (outFile) {
      writeFileSync(outFile, report);
      console.error(`Report written to ${outFile}`);
    }
    return;
  }

  usage();
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
