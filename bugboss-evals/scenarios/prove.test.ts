import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadScenario } from "../core/scenario";

// The proof that every hidden check tests the symptom: it must fail at
// baseSha (exit 1, a SYMPTOM assertion, not a broken check) and pass at
// provingFixSha (exit 0). It builds throwaway omni worktrees, runs npm ci and
// boots gp-api against a real Postgres, so it takes minutes per scenario and
// only runs when pointed at an omni clone:
//
//   BUGBOSS_EVALS_OMNI_REPO=~/Repos/thegoodparty/omni \
//     npx tsx --test bugboss-evals/scenarios/prove.test.ts
//
// BUGBOSS_EVALS_PROVE=<id>[,<id>] narrows it, BUGBOSS_EVALS_KEEP=1 keeps the
// worktrees (and a re-run then skips their setup). The worktrees go under the
// OS temp directory, never inside the omni checkout, and are detached, so
// nothing is committed or branched in omni.

const SCENARIOS = __dirname;
const OMNI = process.env.BUGBOSS_EVALS_OMNI_REPO;
const ONLY = process.env.BUGBOSS_EVALS_PROVE?.split(",").filter(Boolean);
const KEEP = process.env.BUGBOSS_EVALS_KEEP === "1";
const ROOT = join(tmpdir(), "bugboss-evals-omni");

const ids = readdirSync(SCENARIOS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SCENARIOS, d.name, "scenario.json")))
  .map((d) => d.name)
  .filter((id) => !ONLY || ONLY.includes(id));

// OrbStack does not publish /var/run/docker.sock, and testcontainers cannot
// resolve its context, so a local run without this finds no container runtime.
const env = (): NodeJS.ProcessEnv => {
  const orb = join(homedir(), ".orbstack", "run", "docker.sock");
  if (!process.env.DOCKER_HOST && existsSync(orb)) {
    return { ...process.env, DOCKER_HOST: `unix://${orb}` };
  }
  return process.env;
};

const git = (args: string[], cwd: string) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const worktree = (sha: string): { dir: string; fresh: boolean } => {
  mkdirSync(ROOT, { recursive: true });
  const full = git(["rev-parse", `${sha}^{commit}`], OMNI!);
  const dir = join(ROOT, full.slice(0, 12));
  if (existsSync(dir) && git(["rev-parse", "HEAD"], dir) === full) {
    return { dir, fresh: !existsSync(join(dir, ".bugboss-setup-done")) };
  }
  git(["worktree", "add", "--detach", "--force", dir, full], OMNI!);
  return { dir, fresh: true };
};

const drop = (dir: string) => {
  if (!KEEP) spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: OMNI! });
};

const run = (
  scenarioDir: string,
  script: string,
  sha: string,
  omniDir: string,
  timeoutSeconds: number,
  log: string,
) => {
  const r = spawnSync("bash", [join(scenarioDir, script), sha, omniDir], {
    cwd: scenarioDir,
    env: env(),
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 1024 * 1024 * 512,
  });
  writeFileSync(log, `${r.stdout}\n--- stderr ---\n${r.stderr}`);
  return r;
};

for (const id of ids) {
  const { scenario, dir } = loadScenario(join(SCENARIOS, id, "scenario.json"));
  const cases = [
    { sha: scenario.omni.baseSha, expect: 1, label: "fails at baseSha" },
    { sha: scenario.omni.provingFixSha, expect: 0, label: "passes at provingFixSha" },
  ];
  for (const c of cases) {
    test(
      `${id}: the hidden check ${c.label} (${c.sha})`,
      { skip: OMNI ? false : "set BUGBOSS_EVALS_OMNI_REPO to an omni clone", timeout: 3_600_000 },
      () => {
        const { dir: omniDir, fresh } = worktree(c.sha);
        try {
          const stem = join(ROOT, `${id}-${c.sha.slice(0, 12)}`);
          if (fresh && scenario.check.setup) {
            const setup = run(dir, scenario.check.setup, c.sha, omniDir, 1800, `${stem}-setup.log`);
            assert.equal(setup.status, 0, `setup failed, see ${stem}-setup.log`);
            writeFileSync(join(omniDir, ".bugboss-setup-done"), "");
          }
          const started = Date.now();
          const check = run(
            dir,
            scenario.check.command,
            c.sha,
            omniDir,
            scenario.check.timeoutSeconds,
            `${stem}-check.log`,
          );
          const seconds = Math.round((Date.now() - started) / 1000);
          console.log(`${id} @ ${c.sha}: exit ${check.status} in ${seconds}s, log ${stem}-check.log`);
          assert.equal(
            check.status,
            c.expect,
            `expected exit ${c.expect}, got ${check.status} (signal ${check.signal}); see ${stem}-check.log`,
          );
        } finally {
          drop(omniDir);
        }
      },
    );
  }
}
