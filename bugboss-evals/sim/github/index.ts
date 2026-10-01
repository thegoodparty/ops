import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { git, gitStatus, httpBackend, makeCerts, resolve } from "./git";
import { BOT_LOGIN, createGraphQL, pullId } from "./graphql";
import { ApiError, createStore, now, type Ci, type Pull, type Repo, type Run } from "./store";

/**
 * A local github.com for the eval harness: git over smart HTTP, the REST and
 * GraphQL calls a run makes (harness, Boss, agent's gh and git), and Actions
 * runs backed by the `ci` callback. On the runner, /etc/hosts sends github.com
 * and api.github.com here and the CA is trusted, so nothing else changes.
 * Requests are routed by path, so `https://127.0.0.1:<port>` works too.
 */

export interface FakeGitHub {
  /** PEM of the CA that signed the server certificate. */
  caFile: string;
  /** Bare repository on disk for owner/name (created empty if new). Seeding pushes into it with plain local git. */
  bareRepo: (owner: string, name: string) => string;
  /** Moves a branch to a commit already in the bare repo, bypassing the push rules. A PR head moved this way re-runs CI. */
  advance: (owner: string, repo: string, branch: string, sha: string) => void;
  /** Like a ruleset requiring branches to be up to date: a PR into `branch` whose head lacks its tip is BEHIND and cannot merge. */
  requireUpToDate: (owner: string, repo: string, branch: string) => void;
  /** The port the server is listening on. */
  port: number;
  close: () => Promise<void>;
}

const API = "https://api.github.com";
const WEB = "https://github.com";
const user = { login: BOT_LOGIN, id: 1, node_id: "BOT_1", type: "Bot", html_url: `${WEB}/apps/bugboss-gp` };
// An empty zip: gh then fetches each job's log on its own.
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

export const startFakeGitHub = async (args: { root: string; port?: number; host?: string; ci: Ci }): Promise<FakeGitHub> => {
  const certs = makeCerts(join(args.root, "certs"));
  const store = createStore(args.root, args.ci);
  const graphql = createGraphQL(store);

  const repoJson = (r: Repo) => ({
    id: 1,
    node_id: `R_${r.name}`,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, type: "Organization" },
    private: false,
    html_url: `${WEB}/${r.owner}/${r.name}`,
    clone_url: `${WEB}/${r.owner}/${r.name}.git`,
    default_branch: "main",
  });

  const pullJson = (r: Repo, p: Pull) => {
    const m = store.mergeability(r, p);
    return {
      url: `${API}/repos/${r.owner}/${r.name}/pulls/${p.number}`,
      id: p.number,
      node_id: pullId(r, p),
      html_url: `${WEB}/${r.owner}/${r.name}/pull/${p.number}`,
      number: p.number,
      state: p.state,
      locked: false,
      title: p.title,
      body: p.body,
      user,
      draft: p.draft,
      created_at: p.created_at,
      updated_at: p.updated_at,
      closed_at: p.closed_at,
      merged_at: p.merged_at,
      merged: p.merged_at !== null,
      merged_by: p.merged_at ? user : null,
      merge_commit_sha: p.merge_commit_sha,
      mergeable: m.mergeable,
      mergeable_state: m.state,
      head: { label: `${r.owner}:${p.head}`, ref: p.head, sha: p.headSha, user, repo: repoJson(r) },
      base: { label: `${r.owner}:${p.base}`, ref: p.base, sha: p.baseAtMerge ?? resolve(r.dir, `refs/heads/${p.base}`), user, repo: repoJson(r) },
    };
  };

  const commentJson = (r: Repo, p: Pull, c: Pull["comments"][number]) => ({
    id: c.id,
    node_id: `IC_${c.id}`,
    html_url: `${WEB}/${r.owner}/${r.name}/pull/${p.number}#issuecomment-${c.id}`,
    issue_url: `${API}/repos/${r.owner}/${r.name}/issues/${p.number}`,
    body: c.body,
    user,
    author_association: "NONE",
    created_at: c.created_at,
    updated_at: c.updated_at,
  });

  const reviewJson = (r: Repo, p: Pull, rv: Pull["reviews"][number]) => ({
    id: rv.id,
    node_id: `PRR_${rv.id}`,
    user,
    body: rv.body,
    state: rv.state,
    commit_id: rv.commit_id,
    submitted_at: rv.submitted_at,
    author_association: "NONE",
    html_url: `${WEB}/${r.owner}/${r.name}/pull/${p.number}#pullrequestreview-${rv.id}`,
    pull_request_url: `${API}/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  });

  const runJson = (r: Repo, run: Run) => {
    const p = store.pull(r, run.pull);
    const c = store.commit(r, run.sha);
    const runs = `${API}/repos/${r.owner}/${r.name}/actions/runs/${run.id}`;
    return {
      id: run.id,
      node_id: `WFR_${run.id}`,
      name: "CI",
      display_title: p.title,
      path: ".github/workflows/ci.yml",
      head_branch: p.head,
      head_sha: run.sha,
      event: "pull_request",
      status: run.status,
      conclusion: run.conclusion,
      workflow_id: 1,
      run_number: run.id,
      run_attempt: run.attempt,
      created_at: run.created_at,
      updated_at: run.updated_at,
      run_started_at: run.run_started_at,
      url: runs,
      html_url: `${WEB}/${r.owner}/${r.name}/actions/runs/${run.id}`,
      jobs_url: `${runs}/jobs`,
      logs_url: `${runs}/logs`,
      actor: user,
      triggering_actor: user,
      pull_requests: [{ number: p.number, head: { ref: p.head, sha: run.sha }, base: { ref: p.base } }],
      head_commit: { id: run.sha, tree_id: c.tree, message: c.message, timestamp: c.committer.date, author: c.author, committer: c.committer },
      head_repository: repoJson(r),
      repository: repoJson(r),
    };
  };

  const jobJson = (r: Repo, run: Run) => {
    const completed_at = run.status === "completed" ? run.updated_at : null;
    return {
      id: run.id,
      run_id: run.id,
      run_attempt: run.attempt,
      name: "checks",
      workflow_name: "CI",
      head_sha: run.sha,
      head_branch: store.pull(r, run.pull).head,
      status: run.status,
      conclusion: run.conclusion,
      started_at: run.run_started_at,
      completed_at,
      html_url: `${WEB}/${r.owner}/${r.name}/actions/runs/${run.id}/job/${run.id}`,
      run_url: `${API}/repos/${r.owner}/${r.name}/actions/runs/${run.id}`,
      steps: [{ name: "Run checks", status: run.status, conclusion: run.conclusion, number: 1, started_at: run.run_started_at, completed_at }],
    };
  };

  const run = (r: Repo, id: string): Run => {
    const found = r.runs.find((x) => x.id === Number(id));
    if (!found) throw new ApiError(404, "Not Found");
    return found;
  };

  type Body = Record<string, unknown>;
  type Reply = { status?: number; json?: unknown; text?: string | Buffer; type?: string };
  type Route = [method: string, path: RegExp, handle: (r: Repo, m: string[], body: Body, q: URLSearchParams, accept: string) => Reply];
  const json = (value: unknown, status = 200): Reply => ({ status, json: value });
  const sinceFilter = <T extends { updated_at?: string; submitted_at?: string }>(items: T[], q: URLSearchParams) =>
    items.filter((x) => !q.get("since") || (x.updated_at ?? x.submitted_at ?? "") >= (q.get("since") as string));

  const compare = (r: Repo, spec: string, accept: string): Reply => {
    const [a, b] = spec.split("...");
    const base = resolve(r.dir, a);
    const head = b === undefined ? null : resolve(r.dir, b);
    if (!base || !head) throw new ApiError(404, "Not Found");
    const mergeBase = gitStatus(r.dir, ["merge-base", base, head]).out;
    if (!mergeBase) throw new ApiError(404, `No common ancestor between ${a} and ${b}.`);
    if (accept.includes("diff")) return { text: `${git(r.dir, ["diff", "--no-renames", mergeBase, head])}\n`, type: "text/plain; charset=utf-8" };
    const [behind, ahead] = git(r.dir, ["rev-list", "--left-right", "--count", `${base}...${head}`]).split(/\s+/).map(Number);
    const status = ahead === 0 && behind === 0 ? "identical" : behind === 0 ? "ahead" : ahead === 0 ? "behind" : "diverged";
    const commits = git(r.dir, ["rev-list", "--reverse", `${base}..${head}`]).split("\n").filter(Boolean);
    return json({
      status,
      ahead_by: ahead,
      behind_by: behind,
      total_commits: ahead,
      base_commit: { sha: base },
      merge_base_commit: { sha: mergeBase },
      commits: commits.map((sha) => ({ sha })),
      files: store.files(r, mergeBase, head),
    });
  };

  const gitCommitJson = (r: Repo, sha: string) => {
    const c = store.commit(r, sha);
    return { sha: c.sha, node_id: `C_${c.sha}`, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((s) => ({ sha: s })), author: c.author, committer: c.committer };
  };

  const routes: Route[] = [
    ["GET", /^git\/ref\/heads\/(.+)$/, (r, [branch]) => {
      const sha = resolve(r.dir, `refs/heads/${branch}`);
      if (!sha) throw new ApiError(404, "Not Found");
      return json({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });
    }],
    ["GET", /^git\/commits\/([0-9a-f]+)$/, (r, [sha]) => {
      if (!resolve(r.dir, sha)) throw new ApiError(404, "Not Found");
      return json(gitCommitJson(r, sha));
    }],
    ["POST", /^git\/commits$/, (r, _, body) => {
      const parents = ((body.parents as string[] | undefined) ?? []).flatMap((p) => ["-p", p]);
      const { code, out } = gitStatus(r.dir, ["commit-tree", String(body.tree), ...parents, "-m", String(body.message ?? "")]);
      if (code !== 0) throw new ApiError(422, "Tree SHA does not exist or a parent SHA does not exist.");
      return json(gitCommitJson(r, out), 201);
    }],
    ["POST", /^git\/refs$/, (r, _, body) => {
      const ref = String(body.ref);
      if (resolve(r.dir, ref)) throw new ApiError(422, "Reference already exists");
      if (gitStatus(r.dir, ["update-ref", ref, String(body.sha), ""]).code !== 0) throw new ApiError(422, "Object does not exist");
      return json({ ref, object: { sha: body.sha, type: "commit" } }, 201);
    }],
    ["GET", /^commits\/([^/]+)$/, (r, [ref]) => {
      const sha = resolve(r.dir, ref);
      if (!sha) throw new ApiError(422, `No commit found for SHA: ${ref}`);
      const c = store.commit(r, sha);
      return json({
        sha,
        node_id: `C_${sha}`,
        html_url: `${WEB}/${r.owner}/${r.name}/commit/${sha}`,
        commit: { message: c.message, author: c.author, committer: c.committer, tree: { sha: c.tree } },
        author: null,
        committer: null,
        parents: c.parents.map((s) => ({ sha: s })),
      });
    }],
    ["GET", /^compare\/(.+)$/, (r, [spec], _, __, accept) => compare(r, decodeURIComponent(spec), accept)],
    ["GET", /^pulls$/, (r, _, __, q) => {
      const state = q.get("state") ?? "open";
      const head = q.get("head")?.split(":").pop();
      const list = r.pulls
        .filter((p) => state === "all" || p.state === state)
        .filter((p) => !head || p.head === head)
        .filter((p) => !q.get("base") || p.base === q.get("base"))
        .reverse();
      return json(list.slice(0, Number(q.get("per_page") ?? 30)).map((p) => pullJson(r, p)));
    }],
    ["POST", /^pulls$/, (r, _, body) =>
      json(pullJson(r, store.createPull(r, { title: String(body.title ?? ""), body: body.body as string, head: String(body.head), base: String(body.base), draft: body.draft as boolean })), 201)],
    ["GET", /^pulls\/(\d+)$/, (r, [n], _, __, accept) => {
      const p = store.pull(r, Number(n));
      if (accept.includes("diff")) return { text: `${git(r.dir, ["diff", "--no-renames", store.pullBase(r, p), p.headSha])}\n`, type: "text/plain; charset=utf-8" };
      return json(pullJson(r, p));
    }],
    ["PATCH", /^pulls\/(\d+)$/, (r, [n], body) => {
      const p = store.pull(r, Number(n));
      if (typeof body.base === "string") {
        if (!resolve(r.dir, `refs/heads/${body.base}`)) throw new ApiError(422, `Proposed base branch '${body.base}' was not found`);
        p.base = body.base;
      }
      if (typeof body.title === "string") p.title = body.title;
      if (typeof body.body === "string") p.body = body.body;
      if ((body.state === "closed" || body.state === "open") && !p.merged_at) {
        p.state = body.state;
        p.closed_at = body.state === "closed" ? now() : null;
      }
      p.updated_at = now();
      return json(pullJson(r, p));
    }],
    ["PUT", /^pulls\/(\d+)\/merge$/, (r, [n], body) => json(store.merge(r, store.pull(r, Number(n)), body as Parameters<typeof store.merge>[2]))],
    ["GET", /^pulls\/(\d+)\/files$/, (r, [n]) => {
      const p = store.pull(r, Number(n));
      return json(store.files(r, store.pullBase(r, p), p.headSha));
    }],
    ["GET", /^pulls\/(\d+)\/commits$/, (r, [n]) => {
      const p = store.pull(r, Number(n));
      return json(store.commits(r, p).map((sha) => ({ sha, commit: { message: store.commit(r, sha).message } })));
    }],
    ["GET", /^pulls\/(\d+)\/reviews$/, (r, [n]) => {
      const p = store.pull(r, Number(n));
      return json(p.reviews.map((rv) => reviewJson(r, p, rv)));
    }],
    ["POST", /^pulls\/(\d+)\/reviews$/, (r, [n], body) => {
      const p = store.pull(r, Number(n));
      const states: Record<string, string> = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };
      const rv = { id: store.nextId(), body: String(body.body ?? ""), state: states[String(body.event ?? "COMMENT")] ?? "COMMENTED", commit_id: String(body.commit_id ?? p.headSha), submitted_at: now() };
      p.reviews.push(rv);
      return json(reviewJson(r, p, rv));
    }],
    ["GET", /^pulls\/(\d+)\/reviews\/\d+\/comments$/, (r, [n]) => (store.pull(r, Number(n)), json([]))],
    ["GET", /^pulls\/(\d+)\/comments$/, (r, [n]) => (store.pull(r, Number(n)), json([]))],
    ["GET", /^issues\/(\d+)\/comments$/, (r, [n], _, q) => {
      const p = store.pull(r, Number(n));
      return json(sinceFilter(p.comments, q).map((c) => commentJson(r, p, c)));
    }],
    ["POST", /^issues\/(\d+)\/comments$/, (r, [n], body) => {
      const p = store.pull(r, Number(n));
      const at = now();
      const c = { id: store.nextId(), body: String(body.body ?? ""), created_at: at, updated_at: at };
      p.comments.push(c);
      return json(commentJson(r, p, c), 201);
    }],
    ["GET", /^actions\/runs$/, (r, _, __, q) => {
      const list = [...r.runs]
        .sort((a, b) => b.id - a.id)
        .filter((x) => !q.get("head_sha") || x.sha === q.get("head_sha"))
        .filter((x) => !q.get("branch") || store.pull(r, x.pull).head === q.get("branch"))
        .filter((x) => !q.get("event") || q.get("event") === "pull_request")
        .filter((x) => !q.get("status") || x.status === q.get("status") || x.conclusion === q.get("status"));
      return json({ total_count: list.length, workflow_runs: list.map((x) => runJson(r, x)) });
    }],
    ["GET", /^actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/, (r, [id]) => json(runJson(r, run(r, id)))],
    ["GET", /^actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/jobs$/, (r, [id]) => json({ total_count: 1, jobs: [jobJson(r, run(r, id))] })],
    ["GET", /^actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/logs$/, (r, [id]) => (run(r, id), { text: EMPTY_ZIP, type: "application/zip" })],
    ["POST", /^actions\/runs\/(\d+)\/rerun-failed-jobs$/, (r, [id]) => (store.rerun(r, run(r, id)), json({}, 201))],
    ["GET", /^actions\/jobs\/(\d+)$/, (r, [id]) => json(jobJson(r, run(r, id)))],
    ["GET", /^actions\/jobs\/(\d+)\/logs$/, (r, [id]) => ({ text: run(r, id).log, type: "text/plain; charset=utf-8" })],
    ["GET", /^check-runs\/\d+\/annotations$/, () => json([])],
    ["GET", /^actions\/workflows$/, () => json({ total_count: 1, workflows: [{ id: 1, node_id: "W_1", name: "CI", path: ".github/workflows/ci.yml", state: "active" }] })],
    ["GET", /^actions\/workflows\/[^/]+$/, () => json({ id: 1, node_id: "W_1", name: "CI", path: ".github/workflows/ci.yml", state: "active" })],
  ];

  const send = (res: ServerResponse, reply: Reply) => {
    const body = reply.text ?? `${JSON.stringify(reply.json)}`;
    res.writeHead(reply.status ?? 200, { "content-type": reply.type ?? "application/json; charset=utf-8" }).end(body);
  };

  const readBody = (req: IncomingMessage): Promise<Body> =>
    new Promise((done) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try {
          done(text ? (JSON.parse(text) as Body) : {});
        } catch {
          done({});
        }
      });
    });

  const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "https://api.github.com");
    const gitMatch = GIT_PATH.exec(url.pathname);
    if (gitMatch) {
      const [, owner, name, service] = gitMatch;
      const r = store.repos.get(`${owner}/${name}`);
      if (!r) return send(res, json({ message: "Repository not found." }, 404));
      await httpBackend(join(args.root, "repos"), `/${owner}/${name}.git/${service}`, req, res);
      if (service === "git-receive-pack") store.refresh(r);
      return;
    }
    const body = await readBody(req);
    if (url.pathname === "/graphql" && req.method === "POST") return send(res, json(await graphql(body)));
    const api = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (api) {
      const [, owner, name, rest] = api;
      for (const [method, path, fn] of routes) {
        const m = path.exec(rest);
        if (m && method === req.method) return send(res, fn(store.find(owner, name), m.slice(1), body, url.searchParams, String(req.headers.accept ?? "")));
      }
    }
    send(res, json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404));
  };

  const server = createServer({ key: readFileSync(certs.key), cert: readFileSync(certs.cert) }, (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof ApiError) return send(res, json({ message: e.message, documentation_url: "https://docs.github.com/rest" }, e.status));
      send(res, json({ message: String(e) }, 500));
    });
  });
  await new Promise<void>((done) => server.listen(args.port ?? 443, args.host ?? "127.0.0.1", done));

  return {
    caFile: certs.ca,
    port: (server.address() as AddressInfo).port,
    bareRepo: (owner, name) => store.bareRepo(owner, name).dir,
    advance: (owner, name, branch, sha) => {
      const r = store.find(owner, name);
      git(r.dir, ["update-ref", `refs/heads/${branch}`, sha]);
      store.refresh(r);
    },
    requireUpToDate: (owner, name, branch) => void store.find(owner, name).upToDate.add(branch),
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
};
