// The git half of the GitHub stand-in: bare repositories, smart HTTP, and
// the handful of plumbing operations a pull request needs.
//
// Smart HTTP is served by running `git upload-pack` and `git receive-pack` in
// stateless-rpc mode directly, which is all `git http-backend` does for these
// two services. That keeps the stand-in to one dependency (git itself), and
// the protocol is git's own, so a partial clone, a fetch of a single blob and
// a push behave as they do against GitHub.
//
// Branch protection is a real `pre-receive` hook in the bare repository, not
// a check in this process: a refused push has to fail inside git's protocol,
// with the message git prints, or the agent sees something no real remote
// would ever say.

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGunzip } from "node:zlib";

export const PROTECTED_BRANCH = "main";

export const git = (
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`), { stdout, stderr, code: (error as { code?: number }).code }));
        } else {
          resolve(stdout);
        }
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

const PRE_RECEIVE = `#!/bin/sh
# Branch protection. The stand-in's server reads what this writes.
status=0
while read old new ref; do
  if [ "$ref" = "refs/heads/${PROTECTED_BRANCH}" ]; then
    printf '%s\\t%s\\t%s\\n' "$ref" "$new" "\${GITHUB_STANDIN_USER:-unknown}" >> "\${GITHUB_STANDIN_REFUSALS:-/dev/null}"
    echo "error: GH006: Protected branch update failed for refs/heads/${PROTECTED_BRANCH}." >&2
    echo "error: Changes must be made through a pull request." >&2
    status=1
  fi
done
exit $status
`;

const POST_RECEIVE = `#!/bin/sh
while read old new ref; do
  printf '%s\\t%s\\t%s\\n' "$ref" "$old" "$new" >> "\${GITHUB_STANDIN_PUSHES:-/dev/null}"
done
`;

export const createBareRepo = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await git(["init", "--bare", "--quiet", "--initial-branch", PROTECTED_BRANCH, dir]);
  // allowFilter is what `git clone --filter=blob:none` needs, and a partial
  // clone then fetches each blob by id on demand, which needs the second.
  await git(["-C", dir, "config", "uploadpack.allowFilter", "true"]);
  await git(["-C", dir, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(["-C", dir, "config", "http.receivepack", "true"]);
  await git(["-C", dir, "config", "receive.advertisePushOptions", "true"]);
  const hooks = join(dir, "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, "pre-receive"), PRE_RECEIVE);
  await writeFile(join(hooks, "post-receive"), POST_RECEIVE);
  await chmod(join(hooks, "pre-receive"), 0o755);
  await chmod(join(hooks, "post-receive"), 0o755);
};

/**
 * Seeds `main` (and any other branches) from a repository or a bundle. The
 * source is only read: a push *from* it, or a fetch from a bundle, never
 * writes to it. Refs are written with `update-ref`, which skips the hooks,
 * because seeding is the harness setting up the world, not somebody pushing.
 */
export const seedRepo = async (
  dir: string,
  input: { source: string; main?: string; branches?: Record<string, string> },
): Promise<{ main: string }> => {
  const isBundle = !existsSync(join(input.source, ".git")) && !existsSync(join(input.source, "HEAD"));
  let main = input.main;
  if (isBundle) {
    await git(["-C", dir, "fetch", "--quiet", input.source, "+refs/*:refs/seed/*"]);
    if (!main) {
      const heads = (await git(["bundle", "list-heads", input.source])).trim().split("\n").filter(Boolean);
      const head = heads.find((l) => l.endsWith(" HEAD")) ?? heads[0];
      if (!head) throw new Error(`bundle ${input.source} has no refs`);
      main = head.split(" ")[0];
    }
  } else {
    const wanted = [main ?? "HEAD", ...Object.values(input.branches ?? {})];
    const resolved: string[] = [];
    for (const rev of wanted) {
      resolved.push((await git(["-C", input.source, "rev-parse", "--verify", `${rev}^{commit}`])).trim());
    }
    main = resolved[0];
    for (const sha of new Set(resolved)) {
      await git(["-C", input.source, "push", "--quiet", "--no-verify", dir, `${sha}:refs/seed/${sha}`]);
    }
  }
  const mainSha = (await git(["-C", dir, "rev-parse", "--verify", `${main}^{commit}`])).trim();
  await git(["-C", dir, "update-ref", `refs/heads/${PROTECTED_BRANCH}`, mainSha]);
  for (const [name, rev] of Object.entries(input.branches ?? {})) {
    const sha = (await git(["-C", dir, "rev-parse", "--verify", `${rev}^{commit}`])).trim();
    await git(["-C", dir, "update-ref", `refs/heads/${name}`, sha]);
  }
  // The seed refs would be advertised to every clone, so they go once the
  // branches point at what they carried. The objects stay.
  const seedRefs = (await git(["-C", dir, "for-each-ref", "--format=%(refname)", "refs/seed/"])).trim();
  for (const ref of seedRefs.split("\n").filter(Boolean)) {
    await git(["-C", dir, "update-ref", "-d", ref]);
  }
  await git(["-C", dir, "symbolic-ref", "HEAD", `refs/heads/${PROTECTED_BRANCH}`]);
  return { main: mainSha };
};

export const revParse = async (dir: string, rev: string): Promise<string | null> => {
  try {
    return (await git(["-C", dir, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim();
  } catch {
    return null;
  }
};

export const listBranches = async (dir: string): Promise<Record<string, string>> => {
  const out = await git(["-C", dir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]);
  const branches: Record<string, string> = {};
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const [name, sha] = line.split(" ");
    branches[name] = sha;
  }
  return branches;
};

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
}

export const commitInfo = async (dir: string, rev: string): Promise<CommitInfo | null> => {
  const sha = await revParse(dir, rev);
  if (!sha) return null;
  const raw = await git(["-C", dir, "show", "-s", "--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B", sha]);
  const [h, t, p, an, ae, ad, cn, ce, cd, ...rest] = raw.split("\0");
  return {
    sha: h,
    tree: t,
    parents: p ? p.split(" ") : [],
    authorName: an,
    authorEmail: ae,
    authorDate: ad,
    committerName: cn,
    committerEmail: ce,
    committerDate: cd,
    message: rest.join("\0").replace(/\n$/, ""),
  };
};

/** Commits on `head` that are not on `base`, oldest first. */
export const commitsBetween = async (dir: string, base: string, head: string): Promise<CommitInfo[]> => {
  const shas = (await git(["-C", dir, "rev-list", "--reverse", `${base}..${head}`])).trim().split("\n").filter(Boolean);
  const out: CommitInfo[] = [];
  for (const sha of shas) {
    const info = await commitInfo(dir, sha);
    if (info) out.push(info);
  }
  return out;
};

/** The pull request diff: what `head` changes since it left `base`. */
export const prDiff = async (dir: string, base: string, head: string): Promise<string> =>
  git(["-C", dir, "diff", "--no-color", "--no-ext-diff", `${base}...${head}`]);

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "removed" | "modified" | "renamed";
}

export const prFiles = async (dir: string, base: string, head: string): Promise<FileChange[]> => {
  const numstat = await git(["-C", dir, "diff", "--numstat", "--no-renames", `${base}...${head}`]);
  const status = await git(["-C", dir, "diff", "--name-status", "--no-renames", `${base}...${head}`]);
  const kinds = new Map<string, string>();
  for (const line of status.trim().split("\n").filter(Boolean)) {
    const [kind, path] = line.split("\t");
    kinds.set(path, kind);
  }
  return numstat
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, d, path] = line.split("\t");
      const kind = kinds.get(path);
      return {
        path,
        additions: a === "-" ? 0 : Number(a),
        deletions: d === "-" ? 0 : Number(d),
        status: kind === "A" ? "added" : kind === "D" ? "removed" : "modified",
      };
    });
};

/**
 * A squash merge onto `main`, done in the object store: `merge-tree` works
 * out the tree without a checkout, and a conflict is a refusal, as it is on
 * GitHub. `update-ref` with the old value is the compare-and-swap that keeps
 * two merges from racing.
 */
export const squashMerge = async (
  dir: string,
  input: {
    headSha: string;
    message: string;
    author: { name: string; email: string };
    now: Date;
  },
): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> => {
  const base = await revParse(dir, `refs/heads/${PROTECTED_BRANCH}`);
  if (!base) return { ok: false, reason: "main does not exist" };
  let tree: string;
  try {
    tree = (await git(["-C", dir, "merge-tree", "--write-tree", "--no-messages", base, input.headSha])).trim().split("\n")[0];
  } catch {
    return { ok: false, reason: "Pull Request is not mergeable" };
  }
  const date = input.now.toISOString();
  const sha = (
    await git(["-C", dir, "commit-tree", tree, "-p", base, "-F", "-"], {
      input: `${input.message}\n`,
      env: {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
        GIT_COMMITTER_DATE: date,
      },
    })
  ).trim();
  await git(["-C", dir, "update-ref", `refs/heads/${PROTECTED_BRANCH}`, sha, base]);
  return { ok: true, sha };
};

/** A detached checkout of one commit, for CI and the deploy hook. */
export const checkout = async (dir: string, sha: string, dest: string): Promise<void> => {
  await rm(dest, { recursive: true, force: true });
  await git(["-C", dir, "worktree", "add", "--quiet", "--detach", "--force", dest, sha]);
};

export const removeCheckout = async (dir: string, dest: string): Promise<void> => {
  try {
    await git(["-C", dir, "worktree", "remove", "--force", dest]);
  } catch {
    await rm(dest, { recursive: true, force: true });
    await git(["-C", dir, "worktree", "prune"]);
  }
};

// ---------------------------------------------------------------------------
// Smart HTTP
// ---------------------------------------------------------------------------

const pktLine = (line: string): Buffer => {
  const body = Buffer.from(line, "utf8");
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
};

export type GitService = "git-upload-pack" | "git-receive-pack";

export interface PushRecord {
  ref: string;
  oldSha: string;
  sha: string;
}

export interface RefusalRecord {
  ref: string;
  sha: string;
  user: string;
}

/**
 * `GET info/refs?service=...` and `POST /<service>`. Pushes and refusals are
 * read back from the hooks' own files once receive-pack exits, so what the
 * stand-in records is what git actually accepted. `record` runs before the
 * response ends: git exits the moment it has its answer, and whoever pushed
 * must find the push already in the state when it looks.
 */
export const serveGit = async (input: {
  req: IncomingMessage;
  res: ServerResponse;
  repoDir: string;
  service: GitService;
  advertise: boolean;
  user: string;
  scratch: string;
  record: (result: { pushes: PushRecord[]; refusals: RefusalRecord[] }) => Promise<void>;
}): Promise<void> => {
  const { req, res, repoDir, service, advertise, user } = input;
  const protocol = req.headers["git-protocol"];
  const env: Record<string, string> = {
    ...(typeof protocol === "string" ? { GIT_PROTOCOL: protocol } : {}),
  };
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const pushLog = join(input.scratch, `push-${tag}.log`);
  const refusalLog = join(input.scratch, `refusal-${tag}.log`);
  if (service === "git-receive-pack") {
    env.GITHUB_STANDIN_USER = user;
    env.GITHUB_STANDIN_PUSHES = pushLog;
    env.GITHUB_STANDIN_REFUSALS = refusalLog;
  }
  const verb = service === "git-upload-pack" ? "upload-pack" : "receive-pack";
  const args = [verb, "--stateless-rpc", ...(advertise ? ["--advertise-refs"] : []), repoDir];
  res.statusCode = 200;
  res.setHeader("cache-control", "no-cache");
  res.setHeader(
    "content-type",
    advertise ? `application/x-${service}-advertisement` : `application/x-${service}-result`,
  );
  if (advertise && env.GIT_PROTOCOL !== "version=2") {
    res.write(pktLine(`# service=${service}\n`));
    res.write("0000");
  }
  const child = spawn("git", args, { env: { ...process.env, ...env } });
  child.stdout.pipe(res, { end: false });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  if (advertise) {
    child.stdin.end();
  } else {
    const body = req.headers["content-encoding"] === "gzip" ? req.pipe(createGunzip()) : req;
    body.pipe(child.stdin);
  }
  const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  if (code !== 0 && stderr) process.stderr.write(`[github-standin] git ${verb}: ${stderr}\n`);
  const read = async (file: string): Promise<string[][]> => {
    if (!existsSync(file)) return [];
    const lines = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
    await rm(file, { force: true });
    return lines.map((l) => l.split("\t"));
  };
  try {
    await input.record({
      pushes: (await read(pushLog)).map(([ref, oldSha, sha]) => ({ ref, oldSha, sha })),
      refusals: (await read(refusalLog)).map(([ref, sha, who]) => ({ ref, sha, user: who })),
    });
  } finally {
    res.end();
  }
};
