import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureInMirror, readBundleFile, readManifest, scoreDir, selectCases } from "./expect";
import type { CaseReport } from "./expect";
import type { Result } from "./replay";

// Local A/B over structural changes. Each arm is a checkout of ops (usually a
// worktree on its own branch) with whatever agent code it wants: a new
// subagent, injected context, a new tool. Every arm replays the same tune
// cases with its own code, and this checkout scores all of them, so an arm
// cannot change what it is graded on. Holdout cases are never run.

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
      return { name, path: resolve(path) };
    });
  if (arms.length === 0) throw new Error("--arms name=path[,name=path...] is required");

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

    const runArm = (arm: { name: string; path: string }) =>
      new Promise<void>((done) => {
        const args = [
          "tsx", "delegate/review/eval/expect.ts",
          "--mode", "replay",
          "--manifest", manifestPath,
          "--split", "tune",
          "--runs", String(runs),
          "--concurrency", String(concurrency),
          "--out", join(out, arm.name),
          "--work-dir", join(workDir, arm.name),
          "--mirror-dir", mirrorDir,
          "--variant", arm.name,
          ...(flags.case ? ["--case", flags.case] : []),
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
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(parallelArms, arms.length) }, async () => {
        while (next < arms.length) await runArm(arms[next++]);
      }),
    );
  }

  const reports = arms.map((a) => ({ arm: a.name, reports: scoreDir(cases, join(out, a.name)) }));
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
    `| Case | Expected | ${arms.map((a) => a.name).join(" | ")} |`,
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
    `| **Avg cost per run** | | ${arms.map((a) => { const c = costOf(join(out, a.name)); return c.n ? money(c.total / c.n) : "n/a"; }).join(" | ")} |`,
    "",
    `Total spend in ${out}: ${money(arms.reduce((sum, a) => sum + costOf(join(out, a.name)).total, 0))}.`,
    "",
  ];
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
  console.log(lines.join("\n"));
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
