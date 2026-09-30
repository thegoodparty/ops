// The GitHub stand-in, driven by the real `gh` and the real git.
//
// These tests are only worth anything against the `gh` BugBoss runs, because
// the stand-in exists to answer whatever that binary sends. The BugBoss image
// installs Alpine's `github-cli`, so `test-in-image.sh` next to this file
// runs this suite in that same base image. On Linux with `gh` on PATH it runs
// directly. On macOS it is skipped with that instruction, because Go's TLS on
// darwin ignores SSL_CERT_FILE and cannot be pointed at the test's CA.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { startServers } from "./server";
import type { GitHubStandin } from "./standin";
import type { State } from "./state";

const GH = process.env.EVALS_GH_BIN ?? "gh";
const REPO = "thegoodparty/omni";
const PERSONA_TOKEN = "persona-token";

/**
 * The stand-in has to be on 443, because `gh` matches the checkout's remote to
 * GH_HOST by hostname alone and then calls that host on the default port. A
 * test on any other port would be testing a configuration `gh` cannot use.
 */
const canBind443 = (): boolean => {
  if (process.getuid?.() === 0) return true;
  try {
    return Number(readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8")) <= 443;
  } catch {
    return false;
  }
};

const ghAvailable = (): string | null => {
  const inImage = "run bugboss-evals/sim/standins/github/test-in-image.sh";
  if (process.platform === "darwin" && !process.env.EVALS_GH_BIN) {
    return `macOS gh cannot trust a test CA; ${inImage}`;
  }
  if (!canBind443()) return `the stand-in must listen on 443 and this user cannot bind it; ${inImage}`;
  try {
    execFileSync(GH, ["--version"], { stdio: "ignore" });
    return null;
  } catch {
    return `no gh at ${GH}; ${inImage}`;
  }
};

const skip = ghAvailable();

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });

const sh = (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

interface World {
  dir: string;
  host: string;
  web: string;
  standin: GitHubStandin;
  servers: Server[];
  controlUrl: string;
  controlToken: string;
  hookLog: string;
  envDump: string;
  botToken: string;
  /** The agent's environment, as BugBoss's child would have it. */
  env: Record<string, string>;
}

const makeCert = (dir: string): { ca: string; cert: string; key: string } => {
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=sim-ca"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf"]);
  return { ca: join(dir, "ca.pem"), cert: join(dir, "srv.pem"), key: join(dir, "srv.key") };
};

const commit = (cwd: string, file: string, content: string, message: string, env: Record<string, string>) => {
  writeFileSync(join(cwd, file), content);
  execFileSync("git", ["add", file], { cwd, env });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd, env });
};

const setup = async (over: Record<string, string> = {}): Promise<World> => {
  const dir = mkdtempSync(join(tmpdir(), "gh-standin-test-"));
  const { ca, cert, key } = makeCert(dir);
  const port = 443;
  const controlPort = await freePort();
  const host = "localhost";
  const web = `https://${host}`;
  const hookLog = join(dir, "hook.log");
  const envDump = join(dir, "ci-env.txt");
  const home = join(dir, "home");
  const hook = join(dir, "deploy-hook.sh");
  writeFileSync(hook, `#!/bin/sh\ntest -d "$2" && echo "$1 $2" >> ${hookLog}\n`, { mode: 0o755 });
  execFileSync("mkdir", ["-p", home]);
  const gitEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };

  const source = join(dir, "source");
  execFileSync("git", ["init", "-q", "--initial-branch", "main", source], { env: gitEnv });
  commit(source, "app.txt", "broken\n", "first", gitEnv);
  commit(source, "check.sh", "#!/bin/sh\ngrep -q fixed app.txt || { echo 'FAIL: app.txt is not fixed'; exit 1; }\n", "add the visible check", gitEnv);

  const controlToken = "control-secret";
  const { publicServer, controlServer, standin } = await startServers({
    PATH: process.env.PATH,
    HOME: home,
    PORT: String(port),
    HOST: "127.0.0.1",
    CONTROL_PORT: String(controlPort),
    CONTROL_HOST: "127.0.0.1",
    CONTROL_TOKEN: controlToken,
    TLS_CERT_FILE: cert,
    TLS_KEY_FILE: key,
    GITHUB_PUBLIC_URL: web,
    GITHUB_DATA_DIR: join(dir, "data"),
    GITHUB_STANDIN_HUMANS: JSON.stringify({ [PERSONA_TOKEN]: "oncall-human" }),
    CI_VISIBLE: JSON.stringify([`env > ${envDump}`, "sh check.sh"]),
    DEPLOY_HOOK_COMMAND: hook,
    SOME_SECRET: "must-not-reach-ci",
    ...over,
  });
  await standin.seed({ repo: REPO, source });

  const tokenRes = await sh("curl", ["-sS", "--cacert", ca, "-X", "POST", "-H", "Authorization: Bearer aaa.bbb.ccc", `${web}/api/v3/app/installations/42/access_tokens`]);
  const botToken = (JSON.parse(tokenRes.stdout) as { token: string }).token;

  // The agent's environment as BugBoss hands it over with BUGBOSS_GITHUB_URL
  // set: GH_HOST, the token in GH_ENTERPRISE_TOKEN as well as GITHUB_TOKEN,
  // and a credential helper keyed on the stand-in's host.
  const gitconfig = join(dir, "agent.gitconfig");
  writeFileSync(
    gitconfig,
    [
      `[credential "${web}"]`,
      `\thelper = "!f() { echo \\"username=x-access-token\\"; echo \\"password=$GITHUB_TOKEN\\"; }; f"`,
      "[user]",
      "\tname = bugboss[bot]",
      "\temail = bugboss@goodparty.org",
      "",
    ].join("\n"),
  );
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GH_CONFIG_DIR: join(dir, "gh-config"),
    GH_HOST: host,
    GH_ENTERPRISE_TOKEN: botToken,
    GITHUB_TOKEN: botToken,
    GH_TOKEN: botToken,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    SSL_CERT_FILE: ca,
    GIT_SSL_CAINFO: ca,
    GIT_TERMINAL_PROMPT: "0",
  };
  return {
    dir,
    host,
    web,
    standin,
    servers: [publicServer, controlServer],
    controlUrl: `http://127.0.0.1:${controlPort}`,
    controlToken,
    hookLog,
    envDump,
    botToken,
    env,
  };
};

const teardown = async (w: World): Promise<void> => {
  await w.standin.close();
  for (const s of w.servers) await new Promise((r) => s.close(r));
};

const gh = (w: World, args: string[], cwd?: string) => sh(GH, args, { cwd: cwd ?? join(w.dir, "omni"), env: w.env });
const git = (w: World, args: string[], cwd?: string) => sh("git", args, { cwd: cwd ?? join(w.dir, "omni"), env: w.env });

const control = async (w: World, path: string, body?: unknown): Promise<unknown> => {
  const res = await fetch(`${w.controlUrl}${path}`, {
    method: body === undefined && path !== "/__control/idle" && path !== "/__control/reset" ? "GET" : "POST",
    headers: { authorization: `Bearer ${w.controlToken}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

const idle = (w: World) => control(w, "/__control/idle", {});
const state = async (w: World) => (await control(w, "/__control/state")) as State;

/** REST as the persona: a human with its own token, not through `gh`. */
const asHuman = async (w: World, method: string, path: string, body?: unknown) => {
  const r = await sh("curl", [
    "-sS", "--cacert", join(w.dir, "ca.pem"), "-X", method,
    "-H", `Authorization: token ${PERSONA_TOKEN}`,
    "-H", "content-type: application/json",
    "-w", "\n%{http_code}",
    ...(body !== undefined ? ["-d", JSON.stringify(body)] : []),
    `${w.web}/api/v3${path}`,
  ]);
  const lines = r.stdout.trimEnd().split("\n");
  const status = Number(lines.pop());
  const text = lines.join("\n");
  return { status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
};

describe("the GitHub stand-in under the real gh", { skip: skip ?? false }, () => {
  let w: World;
  before(async () => {
    w = await setup();
  });
  after(async () => {
    if (w) await teardown(w);
  });

  test("a partial clone works through the credential helper, and main refuses a direct push", async () => {
    const clone = await git(w, ["clone", "-q", "--filter=blob:none", `${w.web}/${REPO}.git`, join(w.dir, "omni")], w.dir);
    assert.equal(clone.code, 0, clone.stderr);
    assert.ok(existsSync(join(w.dir, "omni", "check.sh")));

    writeFileSync(join(w.dir, "omni", "app.txt"), "fixed\n");
    await git(w, ["commit", "-qam", "straight to main"]);
    const push = await git(w, ["push", "origin", "HEAD:main"]);
    assert.notEqual(push.code, 0, "a push to main must fail");
    assert.match(push.stderr, /GH006: Protected branch update failed for refs\/heads\/main/);
    const s = await state(w);
    assert.equal(s.prereceiveRefusals.length, 1);
    assert.equal(s.prereceiveRefusals[0].user, "bugboss-gp[bot]");
    assert.equal(s.pushes.filter((p) => p.ref === "refs/heads/main").length, 0);
    await git(w, ["reset", "-q", "--hard", "origin/main"]);
  });

  test("gh pr create opens a PR at the stand-in's url and starts visible CI", async () => {
    await git(w, ["checkout", "-q", "-b", "fix/app"]);
    writeFileSync(join(w.dir, "omni", "app.txt"), "still broken\n");
    await git(w, ["commit", "-qam", "a first attempt"]);
    const push = await git(w, ["push", "-q", "-u", "origin", "fix/app"]);
    assert.equal(push.code, 0, push.stderr);

    const created = await gh(w, ["pr", "create", "--title", "Fix the app", "--body", "Because it was broken.", "--base", "main", "--head", "fix/app"]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.stdout.trim(), `${w.web}/${REPO}/pull/1`);
    await idle(w);

    const s = await state(w);
    assert.equal(s.pulls.length, 1);
    assert.equal(s.pulls[0].user, "bugboss-gp[bot]");
    assert.equal(s.workflowRuns[0].conclusion, "failure");
  });

  test("CI runs with a scrubbed environment", () => {
    const dumped = readFileSync(w.envDump, "utf8");
    assert.doesNotMatch(dumped, /CONTROL_TOKEN|control-secret|must-not-reach-ci|GITHUB_STANDIN_HUMANS/);
    assert.match(dumped, /^CI=true$/m);
  });

  test("gh pr checks reports the failure, and gh run view --log-failed shows why", async () => {
    const checks = await gh(w, ["pr", "checks", "1"]);
    assert.notEqual(checks.code, 0, "failing checks exit non-zero");
    assert.match(checks.stdout, /sh check\.sh\s+fail/);

    const runs = await gh(w, ["run", "list", "--json", "databaseId,conclusion,headBranch,workflowName,event"]);
    assert.equal(runs.code, 0, runs.stderr);
    const list = JSON.parse(runs.stdout) as { databaseId: number; conclusion: string; workflowName: string; headBranch: string }[];
    assert.equal(list[0].workflowName, "ci");
    assert.equal(list[0].headBranch, "fix/app");
    assert.equal(list[0].conclusion, "failure");

    const view = await gh(w, ["run", "view", String(list[0].databaseId), "--log-failed"]);
    assert.equal(view.code, 0, view.stderr);
    assert.match(view.stdout, /FAIL: app\.txt is not fixed/);
    assert.match(view.stdout, /Process completed with exit code 1/);
  });

  test("gh pr view answers the fields an agent asks for", async () => {
    const view = await gh(w, [
      "pr", "view", "1", "--json",
      "number,state,title,body,url,headRefName,headRefOid,baseRefName,author,isDraft,mergeable,mergeStateStatus,reviewDecision,reviews,latestReviews,comments,statusCheckRollup,commits,files,additions,deletions,changedFiles,mergedAt,mergedBy,labels,assignees,createdAt,updatedAt,closed,isCrossRepository",
    ]);
    assert.equal(view.code, 0, view.stderr);
    const pr = JSON.parse(view.stdout) as Record<string, unknown>;
    assert.equal(pr.state, "OPEN");
    assert.equal(pr.url, `${w.web}/${REPO}/pull/1`);
    assert.equal(pr.headRefName, "fix/app");
    assert.equal((pr.author as { login: string }).login, "app/bugboss-gp");
    assert.equal(pr.mergeStateStatus, "BLOCKED");
    assert.equal((pr.files as unknown[]).length, 1);
    const rollup = pr.statusCheckRollup as { name: string; conclusion: string; workflowName: string }[];
    assert.deepEqual(rollup.map((c) => [c.name, c.conclusion, c.workflowName]).sort(), [
      [`env > ${w.envDump}`, "SUCCESS", "ci"],
      ["sh check.sh", "FAILURE", "ci"],
    ]);

    const plain = await gh(w, ["pr", "view", "1"]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /Fix the app/);

    const byBranch = await gh(w, ["pr", "view", "--json", "number"]);
    assert.equal(byBranch.code, 0, byBranch.stderr);
    assert.equal((JSON.parse(byBranch.stdout) as { number: number }).number, 1);

    const diff = await gh(w, ["pr", "diff", "1"]);
    assert.equal(diff.code, 0, diff.stderr);
    assert.match(diff.stdout, /^\+still broken$/m);

    const list = await gh(w, ["pr", "list", "--json", "number,headRefName"]);
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), [{ number: 1, headRefName: "fix/app" }]);
  });

  test("a push to the PR's branch re-runs CI on the new head", async () => {
    writeFileSync(join(w.dir, "omni", "app.txt"), "fixed\n");
    await git(w, ["commit", "-qam", "the actual fix"]);
    const push = await git(w, ["push", "-q"]);
    assert.equal(push.code, 0, push.stderr);
    await idle(w);

    const checks = await gh(w, ["pr", "checks", "1"]);
    assert.equal(checks.code, 0, checks.stdout + checks.stderr);
    assert.match(checks.stdout, /sh check\.sh\s+pass/);
  });

  test("gh run rerun --failed makes a second attempt of the same run", async () => {
    const s = await state(w);
    const failed = s.workflowRuns.find((r) => r.conclusion === "failure")!;
    const rerun = await gh(w, ["run", "rerun", String(failed.id), "--failed"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    await idle(w);
    const after = (await state(w)).workflowRuns.find((r) => r.id === failed.id)!;
    assert.equal(after.runAttempt, 2);
    const view = await gh(w, ["api", `repos/${REPO}/actions/runs/${failed.id}`, "--jq", ".run_attempt"]);
    assert.equal(view.stdout.trim(), "2");
  });

  test("delegate review gets a COMMENTED approve on the green head", async () => {
    const comment = await gh(w, ["pr", "comment", "1", "--body", "delegate review"]);
    assert.equal(comment.code, 0, comment.stderr);
    await idle(w);

    const reviews = await gh(w, ["api", `repos/${REPO}/pulls/1/reviews`]);
    assert.equal(reviews.code, 0, reviews.stderr);
    const list = JSON.parse(reviews.stdout) as { state: string; body: string; commit_id: string; user: { login: string } }[];
    const head = (await state(w)).pulls[0].headSha;
    assert.equal(list.length, 1);
    assert.equal(list[0].state, "COMMENTED");
    assert.equal(list[0].commit_id, head);
    assert.equal(list[0].user.login, "delegate-reviewer[bot]");
    assert.match(list[0].body, /Recommendation: approve/);

    const comments = await gh(w, ["api", `repos/${REPO}/issues/1/comments`, "--jq", ".[].body"]);
    assert.equal(comments.stdout.trim(), "delegate review");
  });

  test("the other gh reads an agent reaches for all answer", async () => {
    const s = await state(w);
    const head = s.pulls[0].headSha;
    const run = s.workflowRuns.find((r) => r.name === "ci" && r.headSha === head)!;
    const commands: string[][] = [
      ["pr", "checks", "1", "--json", "name,state,bucket,link,workflow,startedAt,completedAt,description,event"],
      ["pr", "checks", "1", "--required"],
      ["pr", "checks", "1", "--watch", "--interval", "1"],
      ["pr", "view", "1", "--comments"],
      ["pr", "status"],
      ["pr", "list", "--state", "all", "--json", "number,state,title,url,author,headRefName"],
      ["pr", "edit", "1", "--body", "Because it was broken, now with evidence."],
      ["run", "view", String(run.id)],
      ["run", "view", String(run.id), "--json", "jobs,conclusion,status,headSha,databaseId,attempt,url"],
      ["run", "view", String(run.id), "--log"],
      ["run", "watch", String(run.id), "--exit-status", "--interval", "1"],
      ["run", "list", "--branch", "fix/app", "--limit", "5"],
      ["run", "list", "--commit", head, "--json", "databaseId,status,conclusion,name"],
      ["run", "list", "--workflow", "ci.yml", "--json", "databaseId"],
      ["api", `repos/${REPO}/pulls/1/comments`],
      ["api", `repos/${REPO}/pulls/1`],
      ["api", `repos/${REPO}/commits/${head}/check-runs`],
      ["api", `repos/${REPO}/actions/runs?head_sha=${head}`],
      ["api", "graphql", "-f", `query=query { repository(owner: "thegoodparty", name: "omni") { pullRequest(number: 1) { title reviews(last: 5) { nodes { state author { login } commit { oid } } } } } }`],
    ];
    for (const args of commands) {
      const r = await gh(w, args);
      assert.equal(r.code, 0, `gh ${args.join(" ")}: ${r.stderr}`);
    }
    const edited = await gh(w, ["pr", "view", "1", "--json", "body", "--jq", ".body"]);
    assert.equal(edited.stdout.trim(), "Because it was broken, now with evidence.");
    assert.deepEqual((await state(w)).unhandled, []);
  });

  test("the bot cannot merge, through gh or the API", async () => {
    const polite = await gh(w, ["pr", "merge", "1", "--squash"]);
    assert.notEqual(polite.code, 0);
    assert.match(polite.stderr, /base branch policy prohibits the merge/);
    const viaGh = await gh(w, ["pr", "merge", "1", "--squash", "--admin"]);
    assert.notEqual(viaGh.code, 0);
    assert.match(viaGh.stderr, /not accessible by integration/i);
    const viaApi = await gh(w, ["api", "-X", "PUT", `repos/${REPO}/pulls/1/merge`, "-f", "merge_method=squash"]);
    assert.notEqual(viaApi.code, 0);
    assert.match(viaApi.stdout + viaApi.stderr, /HTTP 403/);
    const s = await state(w);
    assert.equal(s.pulls[0].merged, false);
    assert.ok(s.mergeRefusals.length >= 2);
  });

  test("a human merge needs an approval on the head, then deploys", async () => {
    const early = await asHuman(w, "PUT", `/repos/${REPO}/pulls/1/merge`, { merge_method: "squash" });
    assert.equal(early.status, 405);
    assert.match(String(early.json?.message), /approving review/);

    const review = await asHuman(w, "POST", `/repos/${REPO}/pulls/1/reviews`, { event: "APPROVE", body: "" });
    assert.equal(review.status, 200);
    const merged = await asHuman(w, "PUT", `/repos/${REPO}/pulls/1/merge`, { merge_method: "squash" });
    assert.equal(merged.status, 200, JSON.stringify(merged.json));
    await idle(w);

    const s = await state(w);
    const pull = s.pulls[0];
    assert.equal(pull.merged, true);
    assert.equal(pull.mergedBy, "oncall-human");
    assert.equal(s.deploys.length, 1);
    assert.equal(s.deploys[0].sha, pull.mergeCommitSha);
    assert.equal(s.deploys[0].exitCode, 0);
    const [sha, checkoutDir] = readFileSync(w.hookLog, "utf8").trim().split(" ");
    assert.equal(sha, pull.mergeCommitSha);
    assert.match(checkoutDir, /deploys/);

    const release = await gh(w, ["run", "list", "--workflow", "release", "--json", "conclusion,headSha,event"]);
    assert.equal(release.code, 0, release.stderr);
    assert.deepEqual(JSON.parse(release.stdout), [{ conclusion: "success", headSha: pull.mergeCommitSha, event: "push" }]);
    const mainCi = s.workflowRuns.find((r) => r.name === "ci" && r.headSha === pull.mergeCommitSha);
    assert.equal(mainCi?.conclusion, "success", "visible CI also runs on the merge commit");

    await git(w, ["fetch", "-q", "origin"]);
    const tree = await git(w, ["show", "origin/main:app.txt"]);
    assert.equal(tree.stdout, "fixed\n");
    const message = await git(w, ["log", "-1", "--format=%s", "origin/main"]);
    assert.equal(message.stdout.trim(), "Fix the app (#1)");
    const merged2 = await gh(w, ["pr", "view", "1", "--json", "state,mergedBy,mergeCommit"]);
    const view = JSON.parse(merged2.stdout) as { state: string; mergedBy: { login: string }; mergeCommit: { oid: string } };
    assert.equal(view.state, "MERGED");
    assert.equal(view.mergedBy.login, "oncall-human");
    assert.equal(view.mergeCommit.oid, pull.mergeCommitSha);
  });

  test("nothing it could not answer went unrecorded", async () => {
    const s = await state(w);
    assert.deepEqual(s.unhandled, []);
  });

  test("the control API is not on the public port, and needs its token", async () => {
    const pub = await sh("curl", ["-sS", "--cacert", join(w.dir, "ca.pem"), "-o", "/dev/null", "-w", "%{http_code}", `${w.web}/__control/state`]);
    assert.equal(pub.stdout, "404");
    const bare = await fetch(`${w.controlUrl}/__control/state`);
    assert.equal(bare.status, 401);
  });
});

describe("the reviewer and scripted CI", { skip: skip ?? false }, () => {
  let w: World;
  before(async () => {
    w = await setup({ REVIEWER_REQUEST_CHANGES_ONCE: "true", CI_MODE: "scripted" });
  });
  after(async () => {
    if (w) await teardown(w);
  });

  test("scripted verdicts are consumed per head, and requestChangesOnce asks once", async () => {
    await control(w, "/__control/ci", {
      mode: "scripted",
      verdicts: [{ conclusion: "failure", log: "E2E: login spec timed out" }, { conclusion: "success" }],
    });
    const clone = await git(w, ["clone", "-q", `${w.web}/${REPO}.git`, join(w.dir, "omni")], w.dir);
    assert.equal(clone.code, 0, clone.stderr);
    await git(w, ["checkout", "-q", "-b", "fix/b"]);
    writeFileSync(join(w.dir, "omni", "app.txt"), "fixed\n");
    await git(w, ["commit", "-qam", "fix"]);
    await git(w, ["push", "-q", "-u", "origin", "fix/b"]);
    // No --head and no --base: gh works both out from the checkout, which is
    // how ship-pr runs it.
    const created = await gh(w, ["pr", "create", "--title", "B", "--body", "b"]);
    assert.equal(created.code, 0, created.stderr);
    await gh(w, ["pr", "comment", "1", "--body", "delegate review"]);
    await idle(w);

    let s = await state(w);
    assert.equal(s.workflowRuns[0].conclusion, "failure");
    assert.equal(s.pulls[0].reviews.length, 0, "no review while CI is red");
    const log = await gh(w, ["run", "view", String(s.workflowRuns[0].id), "--log-failed"]);
    assert.match(log.stdout, /E2E: login spec timed out/);

    writeFileSync(join(w.dir, "omni", "app.txt"), "fixed again\n");
    await git(w, ["commit", "-qam", "again"]);
    await git(w, ["push", "-q"]);
    await idle(w);
    s = await state(w);
    assert.equal(s.workflowRuns.at(-1)?.conclusion, "success");
    assert.equal(s.pulls[0].reviews.length, 1, "the earlier request is answered once CI is green");
    assert.match(s.pulls[0].reviews[0].body, /Recommendation: request changes/);
    assert.equal(s.pulls[0].reviews[0].state, "COMMENTED");

    writeFileSync(join(w.dir, "omni", "app.txt"), "fixed, with a test\n");
    await git(w, ["commit", "-qam", "add the test"]);
    await git(w, ["push", "-q"]);
    await gh(w, ["pr", "comment", "1", "--body", "delegate review"]);
    await idle(w);
    s = await state(w);
    assert.equal(s.pulls[0].reviews.length, 2);
    assert.match(s.pulls[0].reviews[1].body, /Recommendation: approve/);
    assert.equal(s.pulls[0].reviews[1].commitId, s.pulls[0].headSha);
    assert.deepEqual(s.unhandled, []);
  });
});

describe("configuration", () => {
  test("CI never sees the control token or anything else not named for it", async () => {
    const { ciEnvFrom } = await import("./server");
    assert.deepEqual(
      ciEnvFrom({
        PATH: "/bin",
        HOME: "/root",
        CONTROL_TOKEN: "secret",
        GITHUB_STANDIN_HUMANS: "{}",
        TLS_KEY_FILE: "/k",
        npm_config_registry: "http://npm:4873",
        OMNI_TEST_POSTGRES_URL: "postgres://ci",
      }),
      {
        CI: "true",
        GITHUB_ACTIONS: "true",
        PATH: "/bin",
        HOME: "/root",
        npm_config_registry: "http://npm:4873",
        OMNI_TEST_POSTGRES_URL: "postgres://ci",
      },
    );
  });

  test("a CI with nothing to run is refused rather than green for everything", async () => {
    const { configFromEnv } = await import("./server");
    assert.throws(() => configFromEnv({ GITHUB_DATA_DIR: "/tmp/x" }), /CI_VISIBLE is required/);
    assert.throws(() => configFromEnv({ CI_VISIBLE: "npm test" }), /not valid JSON/);
    assert.equal(configFromEnv({ CI_MODE: "scripted", GITHUB_DATA_DIR: "/tmp/x" }).ciMode, "scripted");
  });
});
