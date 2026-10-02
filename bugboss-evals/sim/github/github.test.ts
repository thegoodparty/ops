import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startFakeGitHub, type FakeGitHub } from "./index";

let gh: FakeGitHub;
let ca: string;
let base: string;
let bare: string;
const ciCalls: string[] = [];
const failing = new Set<string>();
const tmp = mkdtempSync(join(tmpdir(), "fake-github-"));

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
// Async, because the server answering git runs in this same process.
const git = (cwd: string, ...args: string[]): Promise<string> =>
  new Promise((done, failed) =>
    execFile("git", ["-c", "credential.helper=", "-c", `http.sslCAInfo=${ca}`, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: ENV }, (e, stdout, stderr) =>
      e ? failed(Object.assign(e, { stderr })) : done(stdout.trim()),
    ),
  );
const gitFails = async (cwd: string, ...args: string[]): Promise<string> => {
  try {
    await git(cwd, ...args);
  } catch (e) {
    return String((e as { stderr?: string }).stderr);
  }
  throw new Error(`git ${args.join(" ")} succeeded`);
};

const call = <T = any>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<{ status: number; body: T }> =>
  new Promise((done, failed) => {
    const req = request(`${base}${path}`, { method, ca: readFileSync(ca), headers: { accept, authorization: "Bearer anything", "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        done({ status: res.statusCode ?? 0, body: (res.headers["content-type"]?.includes("json") ? JSON.parse(text) : text) as T });
      });
    });
    req.on("error", failed);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
const gql = async (query: string, variables: Record<string, unknown> = {}) => {
  const { body } = await call("POST", "/graphql", { query, variables });
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data;
};
const until = async <T>(fn: () => Promise<T | undefined | false>): Promise<T> => {
  for (let i = 0; i < 200; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};
const ciDone = (sha: string) =>
  until(async () => {
    const { body } = await call("GET", `/repos/acme/demo/actions/runs?head_sha=${sha}&per_page=100`);
    return body.workflow_runs[0]?.status === "completed" && body.workflow_runs[0];
  });

const commitFile = async (dir: string, file: string, text: string, message: string) => {
  writeFileSync(join(dir, file), text);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
};
const clone = async (name: string) => {
  const dir = join(tmp, name);
  await git(tmp, "clone", "-q", `${base}/acme/demo.git`, dir);
  return dir;
};

before(async () => {
  gh = await startFakeGitHub({
    root: join(tmp, "server"),
    port: 0,
    ci: async ({ sha }) => {
      ciCalls.push(sha);
      return !failing.has(sha);
    },
  });
  ca = gh.caFile;
  base = `https://127.0.0.1:${gh.port}`;
  bare = gh.bareRepo("acme", "demo");
  const seed = join(tmp, "seed");
  await git(tmp, "init", "-q", "-b", "main", seed);
  await commitFile(seed, "a.txt", "one\ntwo\nthree\n", "Seed");
  await git(seed, "push", "-q", bare, "main");
});

after(() => gh.close());

test("git clones, pushes a branch, and refuses a push to main and a force push", async () => {
  const dir = await clone("push");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  await git(dir, "checkout", "-qb", "topic");
  await commitFile(dir, "b.txt", "b\n", "Add b");
  await git(dir, "push", "-q", "origin", "topic");
  assert.equal(await git(bare, "rev-parse", "topic"), await git(dir, "rev-parse", "HEAD"));

  await git(dir, "checkout", "-q", "main");
  await commitFile(dir, "c.txt", "c\n", "Straight to main");
  assert.match(await gitFails(dir, "push", "origin", "main"), /GH013/);

  await git(dir, "checkout", "-q", "topic");
  await git(dir, "commit", "-q", "--amend", "-m", "Rewritten");
  assert.match(await gitFails(dir, "push", "--force", "origin", "topic"), /force-push/);
  await git(tmp, "clone", "-q", "--depth", "1", "--branch", "topic", `${base}/acme/demo`, join(tmp, "shallow"));
});

test("a REST pull request runs CI and compares, diffs and lists files from git", async () => {
  const dir = await clone("rest");
  await git(dir, "checkout", "-qb", "rest-fix");
  const sha = await commitFile(dir, "a.txt", "one\nTWO\nthree\n", "Fix two");
  await git(dir, "push", "-q", "origin", "rest-fix");

  const created = await call("POST", "/repos/acme/demo/pulls", { title: "Fix two", head: "rest-fix", base: "main", body: "why" });
  assert.equal(created.status, 201);
  assert.equal(created.body.html_url, `https://github.com/acme/demo/pull/${created.body.number}`);
  assert.equal(created.body.head.sha, sha);
  const run = await ciDone(sha);
  assert.equal(run.event, "pull_request");
  assert.equal(run.conclusion, "success");

  const open = await call("GET", "/repos/acme/demo/pulls?state=open&per_page=100");
  assert.ok(open.body.some((p: any) => p.number === created.body.number && p.base.ref === "main"));
  assert.equal((await call("GET", `/repos/acme/demo/compare/main...${sha}`)).body.status, "ahead");
  assert.equal((await call("GET", `/repos/acme/demo/compare/${sha}...main`)).body.status, "behind");
  assert.equal((await call("GET", "/repos/acme/demo/compare/main...main")).body.status, "identical");
  const diff = await call<string>("GET", `/repos/acme/demo/compare/main...${sha}`, undefined, "application/vnd.github.diff");
  assert.match(diff.body, /^\+TWO$/m);
  assert.deepEqual((await call("GET", `/repos/acme/demo/pulls/${created.body.number}/files`)).body.map((f: any) => f.filename), ["a.txt"]);
  assert.equal((await call("POST", "/repos/acme/demo/pulls", { title: "Again", head: "rest-fix", base: "main" })).status, 422);
  await call("PATCH", `/repos/acme/demo/pulls/${created.body.number}`, { state: "closed" });
});

test("gh's GraphQL: repository info, create, view, comment, checks and the Boss's rollup", async () => {
  const dir = await clone("gql");
  await git(dir, "checkout", "-qb", "gql-fix");
  const sha = await commitFile(dir, "d.txt", "d\n", "Add d");
  await git(dir, "push", "-q", "-u", "origin", "HEAD");
  failing.add(sha);

  const { repository } = await gql(
    `fragment repo on Repository { id name owner { login } hasIssuesEnabled description hasWikiEnabled viewerPermission defaultBranchRef { name } }
    query RepositoryInfo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ...repo parent { ...repo } mergeCommitAllowed rebaseMergeAllowed squashMergeAllowed } }`,
    { owner: "acme", name: "demo" },
  );
  assert.equal(repository.defaultBranchRef.name, "main");
  const forBranch = `query PullRequestForBranch($owner: String!, $repo: String!, $headRefName: String!, $states: [PullRequestState!]) {
    repository(owner: $owner, name: $repo) {
      pullRequests(headRefName: $headRefName, states: $states, first: 30, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {id,number,url,state,baseRefName,headRefName,isCrossRepository,headRepositoryOwner{id,login,...on User{name}}}
      }
      defaultBranchRef { name }
    }
  }`;
  assert.deepEqual((await gql(forBranch, { owner: "acme", repo: "demo", headRefName: "gql-fix", states: ["OPEN"] })).repository.pullRequests.nodes, []);

  const created = await gql(
    `mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }`,
    { input: { repositoryId: repository.id, title: "Add d", body: "why", draft: false, baseRefName: "main", headRefName: "gql-fix", maintainerCanModify: true } },
  );
  const { id, url } = created.createPullRequest.pullRequest;
  const number = Number(url.split("/").pop());
  assert.match(url, /^https:\/\/github\.com\/acme\/demo\/pull\/\d+$/);
  assert.equal((await gql(forBranch, { owner: "acme", repo: "demo", headRefName: "gql-fix", states: ["OPEN"] })).repository.pullRequests.nodes[0].url, url);

  const view = await gql(
    `query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $pr_number) {id,number,url,headRefOid,state,mergeable,mergeStateStatus,author{login,...on User{id,name}}} }
    }`,
    { owner: "acme", repo: "demo", pr_number: number },
  );
  assert.deepEqual(
    { oid: view.repository.pullRequest.headRefOid, state: view.repository.pullRequest.state, m: view.repository.pullRequest.mergeable },
    { oid: sha, state: "OPEN", m: "MERGEABLE" },
  );

  await gql(`mutation CommentCreate($input:AddCommentInput!){addComment(input: $input){commentEdge{node{url}}}}`, { input: { body: "delegate review", subjectId: id } });
  const comments = await call("GET", `/repos/acme/demo/issues/${number}/comments`);
  assert.deepEqual(comments.body.map((c: any) => c.body), ["delegate review"]);

  await ciDone(sha);
  const rollup = await gql(
    `query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid state
        commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { __typename ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state targetUrl } }
        } } } } } } }
    }`,
    { owner: "acme", name: "demo", number },
  );
  const check = rollup.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0];
  assert.deepEqual([check.__typename, check.status, check.conclusion, check.checkSuite.workflowRun.workflow.name], ["CheckRun", "COMPLETED", "FAILURE", "CI"]);

  const features = await gql(`query PullRequest_fields2{WorkflowRun: __type(name: "WorkflowRun"){fields(includeDeprecated: true){name}}}`);
  assert.ok(features.WorkflowRun.fields.some((f: any) => f.name === "event"));
  const checks = await gql(
    `query PullRequestStatusChecks($id: ID!, $endCursor: String) { node(id: $id) { ...on PullRequest {
      statusCheckRollup: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first:100,after:$endCursor) {
        nodes { __typename ...on StatusContext { context,state,targetUrl,createdAt,description,isRequired(pullRequestId: $id) },
          ...on CheckRun { name,checkSuite{workflowRun{event,workflow{name}}},status,conclusion,startedAt,completedAt,detailsUrl,isRequired(pullRequestId: $id) } },
        pageInfo{hasNextPage,endCursor} } } } } } } } }`,
    { id },
  );
  assert.equal(checks.node.statusCheckRollup.nodes[0].commit.statusCheckRollup.contexts.nodes[0].checkSuite.workflowRun.event, "pull_request");

  const runs = await call("GET", `/repos/acme/demo/actions/runs?head_sha=${sha}`);
  failing.delete(sha);
  assert.equal((await call("POST", `/repos/acme/demo/actions/runs/${runs.body.workflow_runs[0].id}/rerun-failed-jobs`)).status, 201);
  const rerun = await ciDone(sha);
  assert.deepEqual([rerun.run_attempt, rerun.conclusion], [2, "success"]);
});

test("merging makes a real merge commit, moves the base and records the PR as merged", async () => {
  const dir = await clone("merge");
  await git(dir, "checkout", "-qb", "merge-me");
  const head = await commitFile(dir, "e.txt", "e\n", "Add e");
  await git(dir, "push", "-q", "origin", "merge-me");
  await git(bare, "branch", "eval/run-1/main", "main");
  const pr = (await call("POST", "/repos/acme/demo/pulls", { title: "Add e", head: "merge-me", base: "main" })).body;
  await call("PATCH", `/repos/acme/demo/pulls/${pr.number}`, { base: "eval/run-1/main" });
  const before = await git(bare, "rev-parse", "eval/run-1/main");

  assert.equal((await call("PUT", `/repos/acme/demo/pulls/${pr.number}/merge`, { sha: "0".repeat(40), merge_method: "merge" })).status, 409);
  const merged = await call("PUT", `/repos/acme/demo/pulls/${pr.number}/merge`, { sha: head, merge_method: "merge" });
  assert.equal(merged.status, 200);
  assert.equal(await git(bare, "rev-parse", "eval/run-1/main"), merged.body.sha);
  assert.equal(await git(bare, "rev-parse", `${merged.body.sha}^1`, `${merged.body.sha}^2`), `${before}\n${head}`);
  const got = (await call("GET", `/repos/acme/demo/pulls/${pr.number}`)).body;
  assert.deepEqual([got.state, got.merged_at !== null, got.merge_commit_sha, got.merged_by.login], ["closed", true, merged.body.sha, "bugboss-gp[bot]"]);
  assert.equal((await call("GET", `/repos/acme/demo/compare/eval/run-1/main...${head}`)).body.status, "behind");
  assert.deepEqual((await call("GET", `/repos/acme/demo/pulls/${pr.number}/files`)).body.map((f: any) => f.filename), ["e.txt"]);
});

test("a PR that conflicts with its base is dirty and cannot merge; a push that resolves it re-runs CI", async () => {
  await git(bare, "branch", "eval/run-2/main", "main");
  const dir = await clone("conflict");
  await git(dir, "checkout", "-qb", "conflict", "origin/eval/run-2/main");
  const head = await commitFile(dir, "a.txt", "one\nmine\nthree\n", "Mine");
  await git(dir, "push", "-q", "origin", "conflict");
  const pr = (await call("POST", "/repos/acme/demo/pulls", { title: "Mine", head: "conflict", base: "eval/run-2/main" })).body;
  assert.equal(pr.mergeable_state, "clean");

  const other = join(tmp, "theirs");
  await git(tmp, "clone", "-q", bare, other);
  await git(other, "checkout", "-qb", "side", "origin/eval/run-2/main");
  const theirs = await commitFile(other, "a.txt", "one\ntheirs\nthree\n", "Theirs");
  await git(other, "push", "-q", "origin", "side:refs/heads/scratch");
  gh.advance("acme", "demo", "eval/run-2/main", theirs);

  const dirty = (await call("GET", `/repos/acme/demo/pulls/${pr.number}`)).body;
  assert.deepEqual([dirty.mergeable, dirty.mergeable_state], [false, "dirty"]);
  const status = await gql(`query { repository(owner: "acme", name: "demo") { pullRequest(number: ${pr.number}) { mergeable mergeStateStatus } } }`);
  assert.deepEqual(status.repository.pullRequest, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
  const refused = await call("PUT", `/repos/acme/demo/pulls/${pr.number}/merge`, { sha: head, merge_method: "merge" });
  assert.deepEqual([refused.status, refused.body.message], [405, "Pull Request is not mergeable"]);
  assert.equal(await git(bare, "rev-parse", "eval/run-2/main"), theirs);

  await git(dir, "fetch", "-q", "origin");
  try {
    await git(dir, "merge", "-q", "origin/eval/run-2/main");
  } catch {
    // The conflict is the point; resolve it by hand.
  }
  const resolved = await commitFile(dir, "a.txt", "one\nboth\nthree\n", "Resolve");
  await git(dir, "push", "-q", "origin", "conflict");
  await ciDone(resolved);
  assert.ok(ciCalls.includes(resolved));
  assert.equal((await call("GET", `/repos/acme/demo/pulls/${pr.number}`)).body.mergeable_state, "clean");
});

test("with up-to-date required, a PR behind its base is BEHIND and cannot merge until it catches up", async () => {
  await git(bare, "branch", "eval/run-3/main", "main");
  gh.requireUpToDate("acme", "demo", "eval/run-3/main");
  const dir = await clone("behind");
  await git(dir, "checkout", "-qb", "behind", "origin/eval/run-3/main");
  const head = await commitFile(dir, "f.txt", "f\n", "Add f");
  await git(dir, "push", "-q", "origin", "behind");
  const pr = (await call("POST", "/repos/acme/demo/pulls", { title: "Add f", head: "behind", base: "eval/run-3/main" })).body;
  assert.equal(pr.mergeable_state, "clean");

  await git(dir, "checkout", "-q", "-b", "elsewhere", "origin/eval/run-3/main");
  const moved = await commitFile(dir, "g.txt", "g\n", "Add g");
  await git(dir, "push", "-q", "origin", "elsewhere");
  gh.advance("acme", "demo", "eval/run-3/main", moved);

  const behind = (await call("GET", `/repos/acme/demo/pulls/${pr.number}`)).body;
  assert.deepEqual([behind.mergeable, behind.mergeable_state], [true, "behind"]);
  const status = await gql(`query { repository(owner: "acme", name: "demo") { pullRequest(number: ${pr.number}) { mergeStateStatus } } }`);
  assert.equal(status.repository.pullRequest.mergeStateStatus, "BEHIND");
  const refused = await call("PUT", `/repos/acme/demo/pulls/${pr.number}/merge`, { sha: head });
  assert.deepEqual([refused.status, refused.body.message], [405, "Head branch was modified. Review and try the merge again."]);
  assert.equal(await git(bare, "rev-parse", "eval/run-3/main"), moved);

  await git(dir, "checkout", "-q", "behind");
  await git(dir, "merge", "-q", "--no-edit", "elsewhere");
  await git(dir, "push", "-q", "origin", "behind");
  const caughtUp = await git(dir, "rev-parse", "HEAD");
  await until(async () => (await call("GET", `/repos/acme/demo/pulls/${pr.number}`)).body.head.sha === caughtUp);
  assert.equal((await call("PUT", `/repos/acme/demo/pulls/${pr.number}/merge`, { sha: caughtUp })).status, 200);
});
