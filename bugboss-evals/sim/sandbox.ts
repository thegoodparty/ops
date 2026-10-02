import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadScenario, SCENARIO_IDS } from "../core/scenario";

/**
 * The sandbox repository, served by the fake github.com (`./github/`), and
 * everything the harness asks of it.
 *
 * Layout: `main` is one empty commit. `scenario/<id>` is a snapshot of the
 * scenario's omni base, as one commit on main, with omni's workflows removed
 * and ship-pr pointed at the sandbox. Every run gets its own
 * `eval/<run>/main`, one empty commit on top of that, so its pull request can
 * be told apart from the others. main exists only because omni's ship-pr
 * opens every PR with `--base main`; the harness moves each PR onto its run's
 * own base the moment it appears.
 */

export const SANDBOX_OWNER = "thegoodparty";
export const SANDBOX_REPO = "bugboss-eval-sandbox";
export const SANDBOX_URL = `https://github.com/${SANDBOX_OWNER}/${SANDBOX_REPO}.git`;
const API = `https://api.github.com/repos/${SANDBOX_OWNER}/${SANDBOX_REPO}`;

/** The fake accepts any token; BugBoss still reads one from a file. */
export const FAKE_TOKEN = "ghs_bugbossevalfaketoken";

export const scenarioBranch = (id: string) => `scenario/${id}`;
export const runBase = (runId: string) => `eval/${runId}/main`;

export type Json = Record<string, unknown>;

export interface Sandbox {
  call: <T = Json>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
}

export const createSandbox = (): Sandbox => ({
  call: async <T,>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${FAKE_TOKEN}`,
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

/** The sandbox's CI is the fake's Actions runs on the commit, which the harness's `ci` callback decides. */
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

const SEED_ENV = {
  GIT_AUTHOR_NAME: "bugboss-evals",
  GIT_AUTHOR_EMAIL: "bugboss@goodparty.org",
  GIT_AUTHOR_DATE: "2026-09-30T00:00:00Z",
  GIT_COMMITTER_NAME: "bugboss-evals",
  GIT_COMMITTER_EMAIL: "bugboss@goodparty.org",
  GIT_COMMITTER_DATE: "2026-09-30T00:00:00Z",
};

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

const SHIP_PR = ".claude/skills/ship-pr/SKILL.md";

/**
 * Every scenario's base into the sandbox at `remote`, a path on disk. Each is
 * a snapshot, not omni's history: the omni clone holds only those commits, and
 * a clone of the sandbox stays one tree deep. Everything is written through a
 * scratch index, so the omni clone's checkout is never touched.
 */
export const seed = (omniDir: string, remote: string): void => {
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-seed-"));
  const git = (args: string[], input?: string, trim = true): string => {
    const out = execFileSync("git", ["-C", omniDir, ...args], {
      encoding: "utf8",
      input,
      maxBuffer: 1 << 26,
      env: { ...process.env, ...SEED_ENV, GIT_INDEX_FILE: join(scratch, "index") },
    });
    return trim ? out.trim() : out;
  };
  try {
    const main = git(["commit-tree", git(["mktree"], ""), "-m", "Eval sandbox"]);
    const refs = [`${main}:refs/heads/main`];
    for (const id of SCENARIO_IDS) {
      const base = loadScenario(id).scenario.omni.baseSha;
      git(["read-tree", base]);
      const workflows = git(["ls-files", "--", ".github/workflows"]).split("\n").filter(Boolean);
      if (workflows.length) git(["update-index", "--force-remove", "--", ...workflows]);
      const skill = git(["hash-object", "-w", "--stdin"], patchShipPr(git(["show", `${base}:${SHIP_PR}`], undefined, false)));
      git(["update-index", "--cacheinfo", `100644,${skill},${SHIP_PR}`]);
      const sha = git(["commit-tree", git(["write-tree"]), "-p", main, "-m", `${id}: omni ${base}`]);
      refs.push(`${sha}:refs/heads/${scenarioBranch(id)}`);
    }
    git(["push", "-q", remote, ...refs]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
