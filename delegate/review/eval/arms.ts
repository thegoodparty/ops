import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeGate, ensureInMirror, readBundleFile, readManifest, scoreDir, selectCases } from "./expect";
import type { CaseReport, Gate } from "./expect";
import type { Result } from "./replay";

// Local A/B over structural changes. Each arm is a checkout of ops (usually a
// worktree on its own branch) with whatever agent code it wants: a new
// subagent, injected context, a new tool. Every arm replays the same tune
// cases with its own code, and this checkout scores all of them, so an arm
// cannot change what it is graded on. Holdout cases are never run.
//
// Results are kept per commit, under <out>/runs/<sha>, so an arm whose code
// has not changed since an earlier round reuses its runs under any name, and
// an arm whose code changed always replays.

const parseFlags = (args: string[]): Record<string, string> => {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined) throw new Error(`bad argument: ${args[i]}`);
    flags[args[i].slice(2)] = args[i + 1];
  }
  return flags;
};

const passes = (r: CaseReport) => r.scores.filter((s) => s.pass).length;

const money = (n: number) => `$${n.toFixed(2)}`;

const main = async () => {
  const flags = parseFlags(process.argv.slice(2));
  const manifestPath = resolve(flags.manifest ?? join(__dirname, "expected", "manifest.json"));
  const out = resolve(flags.out ?? "./eval-arms");
  const workDir = resolve(flags["work-dir"] ?? "/tmp/review-arms");
  const mirrorDir = resolve(flags["mirror-dir"] ?? join(workDir, "mirrors"));
  const runs = Number(flags.runs ?? 3);
  const concurrency = Number(flags.concurrency ?? 2);
  const parallelArms = Number(flags["parallel-arms"] ?? 3);
  const arms = (flags.arms ?? "")
    .split(",")
    .filter(Boolean)
    .map((a) => {
      const [name, path] = a.split("=");
      if (!/^[a-z0-9-]+$/.test(name) || !path) throw new Error(`bad arm "${a}", want name=path`);
      const git = (...a: string[]) => execFileSync("git", ["-C", resolve(path), ...a], { encoding: "utf-8" }).trim();
      // Runs are keyed by commit, so uncommitted agent code would be filed
      // under a commit that does not contain it.
      if (git("status", "--porcelain", "--", "delegate", "package.json", "package-lock.json")) {
        throw new Error(`arm "${name}" has uncommitted changes under delegate/; commit them first`);
      }
      const sha = git("rev-parse", "HEAD");
      return { name, path: resolve(path), sha, dir: join(out, "runs", sha) };
    });
  if (arms.length === 0) throw new Error("--arms name=path[,name=path...] is required");
  const base = flags.base ? arms.find((a) => a.name === flags.base) : undefined;
  if (flags.base && !base) throw new Error(`--base ${flags.base} is not one of the arms`);
  const targets = flags.targets ? flags.targets.split(",") : [];

  const cases = selectCases(readManifest(manifestPath), { case: flags.case, split: "tune" });
  if (cases.length === 0) throw new Error("no tune case matches");

  if (flags.mode !== "score") {
    // Every sha a checkout needs is fetched once, here, so arms running side
    // by side only ever read the mirror.
    const byRepo = new Map<string, string[]>();
    for (const c of cases) {
      if (!c.bundle) {
        // A recorded case's key is reviews/<owner>/<repo>/<pr>/<head sha>/<run>.json.
        const [, owner, name, , sha] = (c.key ?? "").split("/");
        const repo = `${owner}/${name}`;
        byRepo.set(repo, [...(byRepo.get(repo) ?? []), sha]);
        continue;
      }
      const b = readBundleFile(manifestPath, c.bundle);
      byRepo.set(b.repo, [...(byRepo.get(b.repo) ?? []), c.source === "simulated" ? b.baseSha : b.headSha]);
    }
    for (const [repo, shas] of byRepo) ensureInMirror(mirrorDir, repo, shas);

    const runArm = (arm: (typeof arms)[number], only = flags.case, fromRun = 1) =>
      new Promise<void>((done) => {
        const args = [
          "tsx", "delegate/review/eval/expect.ts",
          "--mode", "replay",
          "--manifest", manifestPath,
          "--split", "tune",
          "--runs", String(runs),
          "--concurrency", String(concurrency),
          "--from-run", String(fromRun),
          "--out", arm.dir,
          "--work-dir", join(workDir, arm.sha),
          "--mirror-dir", mirrorDir,
          "--variant", `${arm.name}@${arm.sha.slice(0, 7)}`,
          ...(only ? ["--case", only] : []),
        ];
        const child = spawn("npx", args, { cwd: arm.path, stdio: ["ignore", "pipe", "pipe"] });
        const tag = (chunk: Buffer) =>
          chunk.toString().split("\n").filter(Boolean).forEach((l) => console.error(`[${arm.name}] ${l}`));
        child.stdout.on("data", tag);
        child.stderr.on("data", tag);
        child.on("close", (code) => {
          if (code !== 0) console.error(`[${arm.name}] exited ${code}`);
          done();
        });
      });
    // Two arms on the same commit share one set of runs, so replay it once.
    const unique = arms.filter((a, i) => arms.findIndex((b) => b.sha === a.sha) === i);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(parallelArms, unique.length) }, async () => {
        while (next < unique.length) await runArm(unique[next++]);
      }),
    );

    // A case the base held that an arm dropped below every run gets `runs`
    // more runs, and then has to pass 2*runs-1 of 2*runs, so one unlucky run
    // is not a regression.
    if (base) {
      const baseline = { variant: base.name, runs, reports: scoreDir(cases, base.dir) };
      for (const arm of unique.filter((a) => a.sha !== base.sha)) {
        const { rerun } = computeGate(scoreDir(cases, arm.dir), baseline, targets, false, [], runs);
        if (rerun.length > 0) await runArm(arm, rerun.join(","), runs + 1);
      }
    }
  }

  const reports = arms.map((a) => ({ arm: a.name, reports: scoreDir(cases, a.dir) }));
  const gates: { arm: string; gate: Gate }[] = [];
  if (base) {
    const baseline = { variant: base.name, runs, reports: scoreDir(cases, base.dir) };
    for (const a of arms.filter((a) => a.sha !== base.sha)) {
      gates.push({ arm: a.name, gate: computeGate(scoreDir(cases, a.dir), baseline, targets, true, [], runs) });
    }
  }
  const costOf = (dir: string) => {
    let total = 0;
    let n = 0;
    if (!existsSync(dir)) return { total, n };
    for (const c of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const f of readdirSync(join(dir, c.name)).filter((f) => /^run-\d+\.json$/.test(f))) {
        const r = JSON.parse(readFileSync(join(dir, c.name, f), "utf-8")) as Result;
        if (r.costUsd !== null) {
          total += r.costUsd;
          n += 1;
        }
      }
    }
    return { total, n };
  };
  const lines = [
    "### Arms",
    "",
    `| Case | Expected | ${arms.map((a) => `${a.name} (${a.sha.slice(0, 7)})`).join(" | ")} |`,
    `| --- | --- | ${arms.map(() => "---").join(" | ")} |`,
    ...cases.map((c) => {
      const cells = reports.map(({ reports: rs }) => {
        const r = rs.find((x) => x.c.id === c.id)!;
        return `${passes(r)}/${r.scores.length}`;
      });
      const expected = c.expect.verdict === "block" ? "block" : c.expect.verdict;
      return `| ${c.id} | ${expected} | ${cells.join(" | ")} |`;
    }),
    `| **Block cases passed (runs)** | | ${reports.map(({ reports: rs }) => { const b = rs.filter((r) => r.c.expect.verdict === "block"); return `${b.reduce((a, r) => a + passes(r), 0)}/${b.reduce((a, r) => a + r.scores.length, 0)}`; }).join(" | ")} |`,
    `| **Approve cases passed (runs)** | | ${reports.map(({ reports: rs }) => { const b = rs.filter((r) => r.c.expect.verdict === "approve"); return `${b.reduce((a, r) => a + passes(r), 0)}/${b.reduce((a, r) => a + r.scores.length, 0)}`; }).join(" | ")} |`,
    `| **Avg cost per run** | | ${arms.map((a) => { const c = costOf(a.dir); return c.n ? money(c.total / c.n) : "n/a"; }).join(" | ")} |`,
    "",
    `Total spend in ${out}, every round: ${money(
      existsSync(join(out, "runs"))
        ? readdirSync(join(out, "runs")).reduce((sum, sha) => sum + costOf(join(out, "runs", sha)).total, 0)
        : 0,
    )}.`,
    "",
  ];
  if (base) {
    lines.push(`### Gate against ${base.name}`, "");
    for (const { arm, gate } of gates) {
      const parts = [
        gate.pass ? "pass" : "FAIL",
        gate.regressions.length ? `regressed: ${gate.regressions.join(", ")}` : "",
        gate.targetsMissed.length ? `targets missed: ${gate.targetsMissed.join(", ")}` : "",
        gate.costRatio === null ? "" : `cost ${gate.costRatio.toFixed(2)}x${gate.costOver ? " (over)" : ""}`,
      ].filter(Boolean);
      lines.push(`- **${arm}**: ${parts.join("; ")}`);
    }
    lines.push("");
  }
  const detail = ["### Every run", ""];
  for (const c of cases) {
    detail.push(`**${c.id}** (${c.expect.verdict}): ${c.tests}`, "");
    for (const { arm, reports: rs } of reports) {
      const r = rs.find((x) => x.c.id === c.id)!;
      r.scores.forEach((s, i) => detail.push(`- ${arm} run ${i + 1}: ${s.pass ? "pass" : "FAIL"}, ${s.outcome}`));
    }
    detail.push("");
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "arms.md"), [...lines, ...detail].join("\n"));
  if (base) writeFileSync(join(out, "gate.json"), JSON.stringify({ base: base.name, gates }, null, 2));
  console.log(lines.join("\n"));
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
