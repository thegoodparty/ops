import { join } from "node:path";

import { git, gitStatus, initBare, isAncestor, mergeTree, resolve } from "./git";

/**
 * What the fake GitHub remembers: pull requests, their comments and reviews,
 * and workflow runs, in memory. Everything about commits and branches is
 * read from the bare repositories, so it is always what git says it is.
 */

export type CiResult = boolean | { success: boolean; log: string };
export type Ci = (args: { owner: string; repo: string; sha: string; pull: number }) => Promise<CiResult>;

export interface Run {
  id: number;
  sha: string;
  pull: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | null;
  attempt: number;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  log: string;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Review {
  id: number;
  body: string;
  state: string;
  commit_id: string;
  submitted_at: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  /** The base tip just before the merge, so a merged PR keeps its commits and files. */
  baseAtMerge: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  comments: Comment[];
  reviews: Review[];
}

export interface Repo {
  owner: string;
  name: string;
  dir: string;
  pulls: Pull[];
  runs: Run[];
  upToDate: Set<string>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const now = () => new Date().toISOString();

export type Mergeability = { mergeable: boolean | null; state: "clean" | "dirty" | "behind" | "unknown" };

export const createStore = (root: string, ci: Ci) => {
  const repos = new Map<string, Repo>();
  let ids = 0;
  const nextId = () => ++ids;

  const bareRepo = (owner: string, name: string): Repo => {
    const key = `${owner}/${name}`;
    let repo = repos.get(key);
    if (!repo) {
      const dir = join(root, "repos", owner, `${name}.git`);
      initBare(dir);
      repo = { owner, name, dir, pulls: [], runs: [], upToDate: new Set() };
      repos.set(key, repo);
    }
    return repo;
  };

  const find = (owner: string, name: string): Repo => {
    const repo = repos.get(`${owner}/${name}`);
    if (!repo) throw new ApiError(404, "Not Found");
    return repo;
  };

  const pull = (repo: Repo, number: number): Pull => {
    const found = repo.pulls.find((p) => p.number === number);
    if (!found) throw new ApiError(404, "Not Found");
    return found;
  };

  const runCi = (repo: Repo, run: Run) => {
    run.status = "queued";
    run.conclusion = null;
    run.updated_at = now();
    setImmediate(() => {
      run.status = "in_progress";
      run.run_started_at = run.updated_at = now();
      const attempt = run.attempt;
      ci({ owner: repo.owner, repo: repo.name, sha: run.sha, pull: run.pull })
        .then(
          (result) => (typeof result === "boolean" ? { success: result, log: `CI ${result ? "passed" : "failed"}.` } : result),
          (e: unknown) => ({ success: false, log: String(e) }),
        )
        .then(({ success, log }) => {
          if (run.attempt !== attempt) return;
          run.status = "completed";
          run.conclusion = success ? "success" : "failure";
          run.log = log;
          run.updated_at = now();
        });
    });
  };

  const triggerCi = (repo: Repo, p: Pull) => {
    const at = now();
    const run: Run = { id: nextId(), sha: p.headSha, pull: p.number, status: "queued", conclusion: null, attempt: 1, created_at: at, updated_at: at, run_started_at: at, log: "" };
    repo.runs.push(run);
    runCi(repo, run);
  };

  const rerun = (repo: Repo, run: Run) => {
    if (run.status !== "completed") throw new ApiError(403, "This workflow run is not completed.");
    if (run.conclusion === "success") throw new ApiError(403, "This workflow run has no failed jobs to re-run.");
    run.attempt += 1;
    runCi(repo, run);
  };

  /** Picks up new heads after a push or a direct ref move; a new head re-runs CI. */
  const refresh = (repo: Repo) => {
    for (const p of repo.pulls) {
      if (p.state !== "open") continue;
      const sha = resolve(repo.dir, `refs/heads/${p.head}`);
      if (!sha || sha === p.headSha) continue;
      p.headSha = sha;
      p.updated_at = now();
      triggerCi(repo, p);
    }
  };

  const mergeability = (repo: Repo, p: Pull): Mergeability => {
    const base = resolve(repo.dir, `refs/heads/${p.base}`);
    if (p.state !== "open" || !base) return { mergeable: null, state: "unknown" };
    if (!mergeTree(repo.dir, base, p.headSha)) return { mergeable: false, state: "dirty" };
    if (repo.upToDate.has(p.base) && !isAncestor(repo.dir, base, p.headSha)) return { mergeable: true, state: "behind" };
    return { mergeable: true, state: "clean" };
  };

  const createPull = (repo: Repo, args: { title: string; body?: string | null; head: string; base: string; draft?: boolean | null }): Pull => {
    const head = args.head.includes(":") ? args.head.slice(args.head.indexOf(":") + 1) : args.head;
    const headSha = resolve(repo.dir, `refs/heads/${head}`);
    const baseSha = resolve(repo.dir, `refs/heads/${args.base}`);
    if (!args.title) throw new ApiError(422, "Validation Failed: title is missing.");
    if (!headSha) throw new ApiError(422, `Validation Failed: head ${head} does not exist.`);
    if (!baseSha) throw new ApiError(422, `Validation Failed: base ${args.base} does not exist.`);
    if (repo.pulls.some((p) => p.state === "open" && p.head === head && p.base === args.base)) {
      throw new ApiError(422, `A pull request already exists for ${repo.owner}:${head}.`);
    }
    if (isAncestor(repo.dir, headSha, baseSha)) throw new ApiError(422, `No commits between ${args.base} and ${head}.`);
    const at = now();
    const p: Pull = {
      number: repo.pulls.length + 1,
      title: args.title,
      body: args.body ?? "",
      head,
      base: args.base,
      headSha,
      baseAtMerge: null,
      state: "open",
      draft: args.draft ?? false,
      merged_at: null,
      merge_commit_sha: null,
      closed_at: null,
      created_at: at,
      updated_at: at,
      comments: [],
      reviews: [],
    };
    repo.pulls.push(p);
    triggerCi(repo, p);
    return p;
  };

  const merge = (repo: Repo, p: Pull, args: { sha?: string; merge_method?: string; commit_title?: string; commit_message?: string }) => {
    if (p.state !== "open") throw new ApiError(405, "Pull Request is not mergeable");
    if (args.sha && args.sha !== p.headSha) throw new ApiError(409, "Head branch was modified. Review and try the merge again.");
    const m = mergeability(repo, p);
    if (m.state === "dirty") throw new ApiError(405, "Pull Request is not mergeable");
    if (m.state === "behind") throw new ApiError(405, "Head branch was modified. Review and try the merge again.");
    const method = args.merge_method ?? "merge";
    if (method !== "merge" && method !== "squash") throw new ApiError(422, `Merge method ${method} is not allowed on this repository.`);
    const base = resolve(repo.dir, `refs/heads/${p.base}`) as string;
    const tree = mergeTree(repo.dir, base, p.headSha) as string;
    const title = args.commit_title ?? (method === "merge" ? `Merge pull request #${p.number} from ${repo.owner}/${p.head}` : `${p.title} (#${p.number})`);
    const message = `${title}\n\n${args.commit_message ?? (method === "merge" ? p.title : "")}`.trim();
    const parents = method === "merge" ? ["-p", base, "-p", p.headSha] : ["-p", base];
    const sha = git(repo.dir, ["commit-tree", tree, ...parents, "-m", message]);
    if (gitStatus(repo.dir, ["update-ref", `refs/heads/${p.base}`, sha, base]).code !== 0) {
      throw new ApiError(409, "Base branch was modified. Review and try the merge again.");
    }
    const at = now();
    Object.assign(p, { state: "closed", merged_at: at, closed_at: at, updated_at: at, merge_commit_sha: sha, baseAtMerge: base });
    return { sha, merged: true, message: "Pull Request successfully merged" };
  };

  /** The commit the PR's changes are measured from: the merge base with its base branch. */
  const pullBase = (repo: Repo, p: Pull): string => {
    const base = p.baseAtMerge ?? resolve(repo.dir, `refs/heads/${p.base}`) ?? p.headSha;
    return gitStatus(repo.dir, ["merge-base", base, p.headSha]).out || base;
  };

  const files = (repo: Repo, from: string, to: string) => {
    const status = new Map(
      git(repo.dir, ["diff", "--no-renames", "--name-status", from, to])
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(line.indexOf("\t") + 1), line[0]] as const),
    );
    const names: Record<string, string> = { A: "added", D: "removed", M: "modified", T: "changed" };
    return git(repo.dir, ["diff", "--no-renames", "--numstat", from, to])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [add, del, ...path] = line.split("\t");
        const filename = path.join("\t");
        const additions = add === "-" ? 0 : Number(add);
        const deletions = del === "-" ? 0 : Number(del);
        return { filename, status: names[status.get(filename) ?? "M"] ?? "modified", additions, deletions, changes: additions + deletions };
      });
  };

  const commits = (repo: Repo, p: Pull): string[] => {
    const out = git(repo.dir, ["rev-list", "--reverse", `${pullBase(repo, p)}..${p.headSha}`]);
    return out ? out.split("\n") : [];
  };

  const commit = (repo: Repo, sha: string) => {
    const [oid, tree, parents, an, ae, ad, cn, ce, cd, ...message] = git(repo.dir, ["show", "-s", "--format=%H%n%T%n%P%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%B", sha]).split("\n");
    return {
      sha: oid,
      tree,
      parents: parents ? parents.split(" ") : [],
      author: { name: an, email: ae, date: ad },
      committer: { name: cn, email: ce, date: cd },
      message: message.join("\n").trim(),
    };
  };

  return { repos, nextId, bareRepo, find, pull, refresh, rerun, mergeability, createPull, merge, pullBase, files, commits, commit };
};

export type Store = ReturnType<typeof createStore>;
