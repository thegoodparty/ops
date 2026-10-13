import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { BundleSchema, FindingSchema, ReviewRecordSchema } from "../schema";
import type { Bundle, ReviewRecord } from "../schema";
import { replayCase } from "./replay";
import type { CheckoutFn, Result } from "./replay";

// A small set of cases with a known right answer, scored on the outcome
// alone. The pairwise suite asks "better or worse than main"; this one asks
// "did it block what must be blocked, and approve what must be approved".

const REVIEW_BUCKET = process.env.REVIEW_BUCKET ?? "delegate-reviews";
const DEFAULT_MANIFEST = join(__dirname, "expected", "manifest.json");

const ExpectSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("approve") }),
  z.object({
    verdict: z.literal("block"),
    paths: z.array(z.string().min(1)).min(1),
    categories: z.array(FindingSchema.shape.category).optional(),
  }),
]);
export type Expect = z.infer<typeof ExpectSchema>;

// A case is either a recorded production run (key, in S3) or a simulated PR
// (bundle, a file next to the manifest) whose head commit is rebuilt locally
// by applying its diff to the base.
const ExpectedCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    key: z.string().startsWith("reviews/").endsWith(".json").optional(),
    bundle: z.string().endsWith(".json").optional(),
    expect: ExpectSchema,
    tests: z.string().min(1),
  })
  .refine((c) => Boolean(c.key) !== Boolean(c.bundle), "set exactly one of key or bundle");
export type ExpectedCase = z.infer<typeof ExpectedCaseSchema>;

export const ManifestSchema = z
  .array(ExpectedCaseSchema)
  .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "case ids must be unique");

export const readManifest = (path: string): ExpectedCase[] =>
  ManifestSchema.parse(JSON.parse(readFileSync(path, "utf-8")));

export const readBundleFile = (manifestPath: string, file: string): Bundle =>
  BundleSchema.parse(JSON.parse(readFileSync(join(dirname(manifestPath), file), "utf-8")));

// The simulated head commit has fixed author, committer and dates, so the same
// diff on the same base always yields the sha recorded in the bundle.
const SYNTHETIC_COMMIT_ENV = {
  GIT_AUTHOR_NAME: "delegate-eval",
  GIT_AUTHOR_EMAIL: "delegate-eval@goodparty.invalid",
  GIT_AUTHOR_DATE: "2026-10-13T00:00:00Z",
  GIT_COMMITTER_NAME: "delegate-eval",
  GIT_COMMITTER_EMAIL: "delegate-eval@goodparty.invalid",
  GIT_COMMITTER_DATE: "2026-10-13T00:00:00Z",
};

export const commitSyntheticHead = (bundle: Bundle, repoDir: string): void => {
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: repoDir,
      input,
      stdio: "pipe",
      timeout: 120_000,
      env: { ...process.env, ...SYNTHETIC_COMMIT_ENV },
    });
  git(["apply", "--index", "-"], bundle.diff);
  git(["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", bundle.title]);
  const head = git(["rev-parse", "HEAD"]).toString().trim();
  if (head !== bundle.headSha) {
    throw new Error(`simulated head is ${head}, bundle says ${bundle.headSha}`);
  }
};

const checkoutFor = (synthetic: Set<string>): CheckoutFn => (bundle, repoDir) => {
  const git = (args: string[], timeout = 120_000) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe", timeout });
  rmSync(repoDir, { recursive: true, force: true });
  execFileSync(
    "gh",
    ["repo", "clone", bundle.repo, repoDir, "--", "--depth=1", "--no-checkout"],
    { stdio: "pipe", timeout: 300_000 },
  );
  if (synthetic.has(bundle.headSha)) {
    git(["fetch", "--depth=50", "origin", bundle.baseSha]);
    git(["checkout", bundle.baseSha], 60_000);
    commitSyntheticHead(bundle, repoDir);
  } else {
    git(["fetch", "--depth=50", "origin", bundle.headSha]);
    git(["checkout", bundle.headSha], 60_000);
  }
  git(["submodule", "update", "--init", "--recursive"]);
};

const readBody = async (body: unknown): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

// replayCase only reads runId and bundle, so a simulated case needs no more
// than that. runId is set to the case id so results are named after the case.
const loadRecord = async (
  c: ExpectedCase,
  manifestPath: string,
  client: S3Client,
): Promise<ReviewRecord> => {
  if (c.bundle) {
    const bundle = readBundleFile(manifestPath, c.bundle);
    return { runId: c.id, bundle } as ReviewRecord;
  }
  const res = await client.send(new GetObjectCommand({ Bucket: REVIEW_BUCKET, Key: c.key }));
  const record = ReviewRecordSchema.parse(JSON.parse(await readBody(res.Body)));
  return { ...record, runId: c.id };
};

export interface RunScore {
  pass: boolean;
  outcome: string;
}

export const scoreRun = (expect: Expect, result: Result): RunScore => {
  if (result.error || !result.output || result.output.status !== "complete") {
    const reason = result.error ?? (result.output?.status === "failed" ? result.output.reason : "no output");
    return { pass: false, outcome: `no review: ${reason.slice(0, 200)}` };
  }
  const findings = result.output.findings;
  const listed = findings.map((f) => `${f.path}:${f.line} [${f.category}]`).join(", ");
  if (expect.verdict === "approve") {
    return findings.length === 0
      ? { pass: true, outcome: "approved" }
      : { pass: false, outcome: `blocked: ${listed}` };
  }
  if (findings.length === 0) return { pass: false, outcome: "approved" };
  const hit = findings.some(
    (f) =>
      expect.paths.includes(f.path) &&
      (!expect.categories || expect.categories.includes(f.category)),
  );
  return { pass: hit, outcome: `blocked${hit ? "" : " on the wrong thing"}: ${listed}` };
};

export interface CaseReport {
  c: ExpectedCase;
  scores: RunScore[];
  costs: (number | null)[];
}

const describeExpect = (e: Expect): string => {
  if (e.verdict === "approve") return "approve";
  const files = e.paths.map((p) => `\`${p.split("/").pop()}\``).join(" or ");
  return `block${e.categories ? ` (${e.categories.join("/")})` : ""} in ${files}`;
};

export const renderExpectReport = (reports: CaseReport[], variant: string): string => {
  const casePasses = reports.filter((r) => r.scores.every((s) => s.pass)).length;
  const money = (costs: (number | null)[]) => {
    const known = costs.filter((c): c is number => c !== null);
    return known.length === 0 ? "n/a" : `$${(known.reduce((a, b) => a + b, 0) / known.length).toFixed(2)}`;
  };
  const lines = [
    "# Expected-result eval",
    "",
    `**${casePasses}/${reports.length} cases passed** on \`${variant}\`. A case passes only when every run gets the expected result.`,
    "",
    "| Case | Expected | Runs passed | Avg cost |",
    "| --- | --- | --- | --- |",
    ...reports.map(
      (r) =>
        `| ${r.c.id} | ${describeExpect(r.c.expect)} | ${r.scores.filter((s) => s.pass).length}/${r.scores.length} | ${money(r.costs)} |`,
    ),
    "",
    "<details><summary>Every run</summary>",
    "",
  ];
  for (const r of reports) {
    lines.push(`**${r.c.id}**: ${r.c.tests}`, "");
    r.scores.forEach((s, i) => lines.push(`- run ${i + 1}: ${s.pass ? "pass" : "FAIL"}, ${s.outcome}`));
    lines.push("");
  }
  lines.push("</details>", "");
  return lines.join("\n");
};

const parseFlags = (args: string[]): Record<string, string> => {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined) {
      throw new Error(`bad argument: ${args[i]}`);
    }
    flags[args[i].slice(2)] = args[i + 1];
  }
  return flags;
};

const main = async () => {
  const flags = parseFlags(process.argv.slice(2));
  const manifestPath = resolve(flags.manifest ?? DEFAULT_MANIFEST);
  const runs = Number(flags.runs ?? 3);
  const concurrency = Number(flags.concurrency ?? 5);
  const out = resolve(flags.out ?? "./eval-expected");
  const workDir = resolve(flags["work-dir"] ?? "/tmp/review-expect");
  const variant = flags.variant;

  const all = readManifest(manifestPath);
  const cases = flags.case ? all.filter((c) => c.id === flags.case) : all;
  if (cases.length === 0) throw new Error(`no case named ${flags.case}`);

  const client = new S3Client({});
  const records = new Map<string, ReviewRecord>();
  for (const c of cases) records.set(c.id, await loadRecord(c, manifestPath, client));
  const synthetic = new Set(
    cases.filter((c) => c.bundle).map((c) => records.get(c.id)!.bundle.headSha),
  );
  const checkout = checkoutFor(synthetic);

  const tasks = cases.flatMap((c) => Array.from({ length: runs }, (_, i) => ({ c, run: i + 1 })));
  const results = new Map<string, Result>();
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const { c, run } = tasks[next++];
      const result = await replayCase(
        records.get(c.id)!,
        { workDir: join(workDir, `run-${run}`), variant },
        undefined,
        checkout,
      );
      results.set(`${c.id}/${run}`, result);
      mkdirSync(join(out, c.id), { recursive: true });
      writeFileSync(join(out, c.id, `run-${run}.json`), JSON.stringify(result, null, 2));
      console.error(`  ${c.id} run ${run}: ${scoreRun(c.expect, result).outcome}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));

  const reports: CaseReport[] = cases.map((c) => {
    const rs = Array.from({ length: runs }, (_, i) => results.get(`${c.id}/${i + 1}`)!);
    return { c, scores: rs.map((r) => scoreRun(c.expect, r)), costs: rs.map((r) => r.costUsd) };
  });
  const report = renderExpectReport(reports, variant ?? results.values().next().value?.variant ?? "unknown");
  writeFileSync(join(out, "report.md"), report);
  console.log(report);
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
