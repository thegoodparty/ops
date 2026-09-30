import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadScenario, SCENARIO_IDS, type Scenario } from "../core/scenario";
import { SANDBOX_OWNER, SANDBOX_REPO } from "./token";

/**
 * The sandbox repository and everything the harness asks of it.
 *
 * Layout: `scenario/<id>` is the scenario's omni base plus one commit that
 * swaps omni's workflows for a CI running the scenario's visible checks.
 * Every run gets its own `eval/<run>/main`, one empty commit on top of that,
 * so its pull request can be told apart from the others. `main` is the oldest
 * base with omni's workflows removed: it exists only because omni's ship-pr
 * skill opens every PR with `--base main`, and GitHub refuses a PR between
 * branches with no history in common. The harness moves each PR onto its
 * run's own base the moment it appears.
 */

export const SANDBOX_URL = `https://github.com/${SANDBOX_OWNER}/${SANDBOX_REPO}.git`;
const API = `https://api.github.com/repos/${SANDBOX_OWNER}/${SANDBOX_REPO}`;

export const scenarioBranch = (id: string) => `scenario/${id}`;
export const runBase = (runId: string) => `eval/${runId}/main`;

export type Json = Record<string, unknown>;

export interface Sandbox {
  call: <T = Json>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
}

export const createSandbox = (token: () => string): Sandbox => ({
  call: async <T,>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token()}`,
        "x-github-api-version": "2022-11-28",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  },
});

export const refSha = async (sandbox: Sandbox, branch: string): Promise<string> =>
  (await sandbox.call<{ object: { sha: string } }>(`/git/ref/heads/${branch}`)).object.sha;

export const createRunBase = async (sandbox: Sandbox, scenarioId: string, runId: string): Promise<string> => {
  const parent = await refSha(sandbox, scenarioBranch(scenarioId));
  const { tree } = await sandbox.call<{ tree: { sha: string } }>(`/git/commits/${parent}`);
  const commit = await sandbox.call<{ sha: string }>("/git/commits", {
    method: "POST",
    body: { message: `Eval run ${runId}`, tree: tree.sha, parents: [parent] },
  });
  await sandbox.call("/git/refs", {
    method: "POST",
    body: { ref: `refs/heads/${runBase(runId)}`, sha: commit.sha },
  });
  return commit.sha;
};

export interface Pull {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
}

/** True when `head` has `base` in its history. */
export const contains = async (sandbox: Sandbox, base: string, head: string): Promise<boolean> => {
  const { status } = await sandbox.call<{ status: string }>(`/compare/${base}...${head}`);
  return status === "ahead" || status === "identical";
};

export type CheckState = "green" | "pending" | "red";

/**
 * The sandbox's CI is its Actions workflow runs on the commit. Read through
 * the Actions API because the App holds no `checks` permission.
 */
export const checks = async (sandbox: Sandbox, sha: string): Promise<CheckState> => {
  const { workflow_runs } = await sandbox.call<{
    workflow_runs: Array<{ status: string; conclusion: string | null; event: string; created_at: string }>;
  }>(`/actions/runs?head_sha=${sha}&per_page=100`);
  // A PR edit re-triggers CI and cancels the run before it; only the newest counts.
  const latest = workflow_runs.filter((run) => run.event === "pull_request").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!latest || latest.status !== "completed") return "pending";
  return latest.conclusion === "success" ? "green" : "red";
};

// ------------------------------------------------------------------ seeding

// Fixed dates make every seed commit reproducible, so re-seeding pushes
// nothing new: the sandbox refuses force-pushes, to main and to anything.
const SEED_DATE = "2026-09-30T00:00:00Z";

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 1 << 26,
    env: { ...process.env, GIT_AUTHOR_DATE: SEED_DATE, GIT_COMMITTER_DATE: SEED_DATE },
  }).trim();

export const ciWorkflow = (scenario: Scenario): string => `name: CI
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
concurrency:
  group: ci-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  checks:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: --health-cmd pg_isready --health-interval 5s --health-retries 20
    env:
      OMNI_TEST_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - run: npm ci --no-audit --no-fund
      - run: npm run build -w packages/contracts
      - run: if [ -f packages/nest-common/package.json ]; then npm run build -w packages/nest-common; fi
      - run: npm run generate -w packages/gp-api
${scenario.ci.map((command) => `      - run: ${command}\n`).join("")}`;

const APP_BOT = "bugboss-gp[bot]";

/**
 * The sandbox is not omni, so the skill the agent follows is pointed at it:
 * the repository its API calls name, and the reviewer whose verdict it waits
 * for, which here is the harness posting as the App.
 */
export const patchShipPr = (text: string): string =>
  text
    .replaceAll("thegoodparty/omni", `${SANDBOX_OWNER}/${SANDBOX_REPO}`)
    .replaceAll("delegate-reviewer[bot]", APP_BOT);

/**
 * One-time setup, run by a person with push access over SSH (a workflow file
 * cannot be pushed by the App, which holds no `workflows` permission):
 *
 *   npx tsx bugboss-evals/sim/sandbox.ts seed ~/Repos/thegoodparty/omni
 */
export const seed = (omniDir: string, remote = `git@github.com:${SANDBOX_OWNER}/${SANDBOX_REPO}.git`): void => {
  const work = mkdtempSync(join(tmpdir(), "sandbox-seed-"));
  try {
    git(work, ["init", "-q"]);
    git(work, ["config", "user.name", "bugboss-evals"]);
    git(work, ["config", "user.email", "bugboss@goodparty.org"]);
    const scenarios = SCENARIO_IDS.map((id) => loadScenario(id).scenario);
    const bases = scenarios.map((s) => s.omni.baseSha);
    git(work, ["fetch", "-q", "--no-tags", omniDir, ...bases]);
    const oldest = git(work, ["merge-base", "--octopus", ...bases]);

    const commitOn = (base: string, message: string, edit: () => void): string => {
      git(work, ["checkout", "-q", "--detach", base]);
      git(work, ["rm", "-rq", "--ignore-unmatch", ".github/workflows"]);
      edit();
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", message]);
      return git(work, ["rev-parse", "HEAD"]);
    };

    const refs = [`${commitOn(oldest, "Remove omni's workflows from the eval sandbox", () => undefined)}:refs/heads/main`];
    for (const scenario of scenarios) {
      const sha = commitOn(scenario.omni.baseSha, `Eval sandbox CI for ${scenario.id}`, () => {
        execFileSync("mkdir", ["-p", join(work, ".github", "workflows")]);
        writeFileSync(join(work, ".github", "workflows", "ci.yml"), ciWorkflow(scenario));
        const skill = join(work, ".claude", "skills", "ship-pr", "SKILL.md");
        writeFileSync(skill, patchShipPr(readFileSync(skill, "utf8")));
      });
      refs.push(`${sha}:refs/heads/${scenarioBranch(scenario.id)}`);
    }
    execFileSync("git", ["push", remote, ...refs], { cwd: work, stdio: "inherit" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

if (require.main === module) {
  const [command, omniDir] = process.argv.slice(2);
  if (command !== "seed" || !omniDir) {
    console.error("usage: sandbox.ts seed <omni checkout>");
    process.exit(2);
  }
  seed(omniDir);
}
