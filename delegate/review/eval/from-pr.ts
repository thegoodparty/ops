import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BundleSchema } from "../schema";
import { ensureInMirror } from "./expect";

// Builds a case bundle for a real PR from GitHub alone, so a production case
// can be replayed without its record in S3. The bundle is what production
// would have built for a first review at `--sha`: the diff from the merge base,
// the PR's current title and body, and no prior findings.

const parseFlags = (args: string[]): Record<string, string> => {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || args[i + 1] === undefined) throw new Error(`bad argument: ${args[i]}`);
    flags[args[i].slice(2)] = args[i + 1];
  }
  return flags;
};

const main = () => {
  const flags = parseFlags(process.argv.slice(2));
  const repo = flags.repo ?? "thegoodparty/omni";
  const pr = Number(flags.pr);
  if (!pr || !flags.out) throw new Error("usage: --pr <n> --out <file> [--repo owner/name] [--sha <head sha>] [--mirror-dir <dir>]");
  const pull = JSON.parse(
    execFileSync("gh", ["api", `repos/${repo}/pulls/${pr}`], { maxBuffer: 50 * 1024 * 1024 }).toString(),
  ) as { title: string; body: string | null; user: { login: string }; base: { ref: string; sha: string }; head: { sha: string } };
  const headSha = flags.sha ?? pull.head.sha;
  const mirror = ensureInMirror(resolve(flags["mirror-dir"] ?? "/tmp/review-expect/mirrors"), repo, [headSha, pull.base.sha]);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: mirror, maxBuffer: 200 * 1024 * 1024 }).toString();
  const baseSha = git(["merge-base", pull.base.sha, headSha]).trim();
  const bundle = BundleSchema.parse({
    repo,
    prNumber: pr,
    baseRef: pull.base.ref,
    baseSha,
    headSha,
    author: pull.user.login,
    title: pull.title,
    body: pull.body ?? "",
    diff: git(["diff", baseSha, headSha]),
    changedFiles: git(["diff", "--name-only", baseSha, headSha]).trim().split("\n").filter(Boolean),
    priorFindings: [],
  });
  const out = resolve(flags.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(bundle, null, 2));
  console.log(`${out}: ${bundle.changedFiles.length} files, ${bundle.diff.length} diff chars, head ${headSha.slice(0, 7)}, base ${baseSha.slice(0, 7)}`);
};

if (require.main === module) main();
