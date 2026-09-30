// The GitHub stand-in: one process that is, as far as BugBoss can tell,
// GitHub Enterprise with one organisation, one App installation, branch
// protection on `main`, GitHub Actions, and a delegate-style reviewer.
//
// It is a stand-in for what BugBoss *reaches*, not a GitHub clone: REST under
// `/api/v3` and GraphQL at `/api/graphql` cover what the pinned `gh` sends
// for the commands the agent actually runs, git is real git, and anything
// else answers 404 and is recorded in `unhandled`, so a gap shows up in the
// run's state instead of as an agent inventing a reason for an empty answer.
//
// Three rules are the point of it, and they hold whatever a variant does:
// nothing lands on `main` except through a merge, a merge needs green visible
// CI and a human approval on the head, and the bot's token can never merge.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import {
  checkout,
  ciCheckout,
  commitInfo,
  commitsBetween,
  createBareRepo,
  listBranches,
  prDiff,
  prFiles,
  PROTECTED_BRANCH,
  removeCheckout,
  revParse,
  seedRepo,
  serveGit,
  squashMerge,
  type CommitInfo,
} from "./git";
import { execute, obj, type ArgValue, type Args, type GqlObject, type Value } from "./graphql";
import {
  emptyState,
  type Actor,
  type CheckRun,
  type IssueComment,
  type Job,
  type Pull,
  type Repo,
  type Review,
  type ScriptedVerdict,
  type State,
  type WorkflowRun,
} from "./state";

export interface StandinConfig {
  /** The origin BugBoss uses, e.g. `https://github`. html_urls are built on it. */
  publicUrl: string;
  dataDir: string;
  /** `{ token: login }` for the people who may use the API as themselves. */
  humans: Record<string, string>;
  /** The App's bot login, as a merge actor and a PR author. */
  appLogin: string;
  /** Whether the App holds `actions: write`, which re-running needs. */
  actionsWrite: boolean;
  ciMode: "run" | "scripted";
  ciVisible: string[];
  ciTimeoutSeconds: number;
  /** The only environment CI commands and the deploy hook run with. */
  ciEnv: Record<string, string>;
  /**
   * The user visible CI runs as. CI runs the agent's code, so it must not be
   * the stand-in's own user, whose environment and files hold the tokens.
   * Unset runs it as this process's user, which is only for tests off Linux.
   */
  ciUid?: number;
  deployHookCommand: string | null;
  reviewerLogin: string;
  requestChangesOnce: boolean;
  now?: () => Date;
}

export const WORKFLOWS = [
  { id: 1, name: "ci", path: ".github/workflows/ci.yml" },
  { id: 2, name: "release", path: ".github/workflows/release.yml" },
] as const;

const REVIEW_TRIGGER = /^\s*delegate review\s*$/i;

const b64 = (s: string): string => Buffer.from(s).toString("base64").replace(/=+$/, "");

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const done = (x: { status: string }): boolean => x.status === "completed";

const upper = (s: string | null): string | null => (s === null ? null : s.toUpperCase());

export const createGitHubStandin = (config: StandinConfig) => {
  const now = config.now ?? (() => new Date());
  const iso = (): string => now().toISOString();
  const web = config.publicUrl.replace(/\/$/, "");
  const api = `${web}/api/v3`;

  // CI may pass through the data dir to its own checkout under ci/ and reach
  // nothing else: the bare repos and the push logs in scratch/ are what branch
  // protection rests on, and a CI that could write them could land on main.
  const ciRoot = join(config.dataDir, "ci");
  const ciHome = join(ciRoot, "home");
  mkdirSync(ciRoot, { recursive: true });
  chmodSync(config.dataDir, 0o711);
  chmodSync(ciRoot, 0o711);
  for (const name of ["repos", "scratch", "deploys"]) {
    mkdirSync(join(config.dataDir, name), { recursive: true });
    chmodSync(join(config.dataDir, name), 0o700);
  }

  let state: State = emptyState({ mode: config.ciMode, verdicts: [], used: 0 });
  /** Minted installation tokens. Kept out of `state`: they are credentials. */
  let appTokens = new Set<string>();
  const running = new Map<number, ChildProcess>();
  let deployQueue: Promise<void> = Promise.resolve();
  /** Work started by an event, so a test or a reset can wait for it. */
  const pending = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p)).catch(() => {});
    return p;
  };

  const id = (): number => state.nextId++;

  const actors = new Map<string, Actor>();
  const actor = (login: string): Actor => {
    let a = actors.get(login);
    if (!a) {
      a = { login, id: 5000 + actors.size, type: login.endsWith("[bot]") ? "Bot" : "User" };
      actors.set(login, a);
    }
    return a;
  };

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  const tokenFrom = (req: IncomingMessage): string | null => {
    const header = req.headers.authorization;
    if (!header) return null;
    const [scheme, rest] = header.split(/\s+/, 2);
    if (/^basic$/i.test(scheme) && rest) {
      const decoded = Buffer.from(rest, "base64").toString("utf8");
      return decoded.slice(decoded.indexOf(":") + 1) || null;
    }
    if (/^(bearer|token)$/i.test(scheme) && rest) return rest;
    return null;
  };

  const whoIs = (token: string | null): Actor | null => {
    if (!token) return null;
    if (appTokens.has(token)) return actor(config.appLogin);
    const human = config.humans[token];
    return human ? actor(human) : null;
  };

  // -------------------------------------------------------------------------
  // Repositories
  // -------------------------------------------------------------------------

  const findRepo = (fullName: string): Repo => {
    const repo = state.repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
    if (!repo) throw new HttpError(404, "Not Found");
    return repo;
  };

  const ensureRepo = async (fullName: string): Promise<Repo> => {
    const existing = state.repos.find((r) => r.fullName === fullName);
    if (existing) return existing;
    const repoId = id();
    const repo: Repo = {
      fullName,
      id: repoId,
      nodeId: `R_${b64(`repo:${repoId}`)}`,
      dir: join(config.dataDir, "repos", `${fullName}.git`),
    };
    await createBareRepo(repo.dir);
    state.repos.push(repo);
    return repo;
  };

  const seed = async (input: {
    repo?: string;
    source: string;
    main?: string;
    branches?: Record<string, string>;
  }): Promise<{ repo: string; main: string }> => {
    const repo = await ensureRepo(input.repo ?? "thegoodparty/omni");
    const { main } = await seedRepo(repo.dir, input);
    return { repo: repo.fullName, main };
  };

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  const pullsOf = (repo: Repo): Pull[] => state.pulls.filter((p) => p.repo === repo.fullName);

  const findPull = (repo: Repo, number: number): Pull => {
    const pull = pullsOf(repo).find((p) => p.number === number);
    if (!pull) throw new HttpError(404, "Not Found");
    return pull;
  };

  const createPull = async (
    repo: Repo,
    input: { head: string; base?: string; title: string; body?: string; draft?: boolean; user: string; number?: number },
  ): Promise<Pull> => {
    const headRef = input.head.includes(":") ? input.head.split(":")[1] : input.head;
    const base = input.base ?? PROTECTED_BRANCH;
    const headSha = await revParse(repo.dir, `refs/heads/${headRef}`);
    if (!headSha) throw new HttpError(422, `Validation Failed: head ${headRef} does not exist`);
    const baseSha = await revParse(repo.dir, `refs/heads/${base}`);
    if (!baseSha) throw new HttpError(422, `Validation Failed: base ${base} does not exist`);
    if (pullsOf(repo).some((p) => p.state === "open" && p.head === headRef && p.base === base)) {
      throw new HttpError(422, `A pull request already exists for ${repo.fullName.split("/")[0]}:${headRef}.`);
    }
    if (headSha === baseSha || (await commitsBetween(repo.dir, baseSha, headSha)).length === 0) {
      throw new HttpError(422, `No commits between ${base} and ${headRef}`);
    }
    const next = state.nextPullNumber[repo.fullName] ?? 1;
    const number = input.number ?? next;
    if (pullsOf(repo).some((p) => p.number === number)) {
      throw new HttpError(422, `pull request #${number} already exists`);
    }
    state.nextPullNumber[repo.fullName] = Math.max(next, number + 1);
    const pullId = id();
    const at = iso();
    const pull: Pull = {
      number,
      id: pullId,
      nodeId: `PR_${b64(`pull:${pullId}`)}`,
      repo: repo.fullName,
      title: input.title,
      body: input.body ?? "",
      head: headRef,
      headSha,
      base,
      baseSha,
      state: "open",
      draft: input.draft ?? false,
      merged: false,
      mergedAt: null,
      mergedBy: null,
      mergeCommitSha: null,
      closedAt: null,
      user: input.user,
      createdAt: at,
      updatedAt: at,
      reviews: [],
      comments: [],
    };
    state.pulls.push(pull);
    void track(startCi(repo, pull.headSha, pull.head, "pull_request", [pull.number]));
    return pull;
  };

  const addComment = (repo: Repo, pull: Pull, user: string, body: string): IssueComment => {
    const commentId = id();
    const comment: IssueComment = {
      id: commentId,
      nodeId: `IC_${b64(`comment:${commentId}`)}`,
      user,
      body,
      createdAt: iso(),
    };
    pull.comments.push(comment);
    pull.updatedAt = comment.createdAt;
    if (REVIEW_TRIGGER.test(body)) void track(maybeReview(repo, pull));
    return comment;
  };

  const addReview = (
    pull: Pull,
    user: string,
    event: string,
    body: string,
    commitId?: string,
  ): Review => {
    const states: Record<string, Review["state"]> = {
      APPROVE: "APPROVED",
      REQUEST_CHANGES: "CHANGES_REQUESTED",
      COMMENT: "COMMENTED",
    };
    const reviewState = states[event.toUpperCase()];
    if (!reviewState) throw new HttpError(422, `Unprocessable Entity: event must be one of APPROVE, REQUEST_CHANGES, COMMENT`);
    if (reviewState !== "COMMENTED" && user === pull.user) {
      throw new HttpError(
        422,
        reviewState === "APPROVED"
          ? "Unprocessable Entity: Can not approve your own pull request"
          : "Unprocessable Entity: Can not request changes on your own pull request",
      );
    }
    if (reviewState !== "APPROVED" && !body.trim()) {
      throw new HttpError(422, "Unprocessable Entity: body is required for this event");
    }
    const reviewId = id();
    const review: Review = {
      id: reviewId,
      nodeId: `PRR_${b64(`review:${reviewId}`)}`,
      user,
      state: reviewState,
      body,
      commitId: commitId ?? pull.headSha,
      submittedAt: iso(),
    };
    pull.reviews.push(review);
    pull.updatedAt = review.submittedAt;
    return review;
  };

  /** Latest completed-or-not `ci` run for a commit, if any. */
  const ciRunFor = (repo: Repo, sha: string): WorkflowRun | undefined =>
    state.workflowRuns
      .filter((r) => r.repo === repo.fullName && r.headSha === sha && r.name === "ci")
      .at(-1);

  const ciGreen = (repo: Repo, sha: string): boolean => {
    const run = ciRunFor(repo, sha);
    return run?.status === "completed" && run.conclusion === "success";
  };

  /**
   * Why a merge would be refused, or null. Branch protection as omni has it:
   * visible CI green on the head and a human's approval of the head, and no
   * human's latest word being "changes requested".
   */
  const mergeBlocker = async (repo: Repo, pull: Pull, who: Actor, sha?: string): Promise<{ status: number; reason: string } | null> => {
    if (who.type === "Bot") return { status: 403, reason: "Resource not accessible by integration" };
    if (pull.state !== "open") return { status: 405, reason: "Pull Request is not open" };
    if (sha && sha !== pull.headSha) return { status: 409, reason: "Head branch was modified. Review and try the merge again." };
    if (!ciGreen(repo, pull.headSha)) {
      return { status: 405, reason: "Required status check \"ci\" is expected. At least one required status check has not succeeded on the head commit." };
    }
    const latestByUser = new Map<string, Review>();
    for (const r of pull.reviews) {
      if (actor(r.user).type === "Bot" || r.state === "COMMENTED") continue;
      latestByUser.set(r.user, r);
    }
    const latest = [...latestByUser.values()];
    if (latest.some((r) => r.state === "CHANGES_REQUESTED")) {
      return { status: 405, reason: "Changes must be made before merging: a reviewer has requested changes." };
    }
    if (!latest.some((r) => r.state === "APPROVED" && r.commitId === pull.headSha)) {
      return { status: 405, reason: "At least 1 approving review is required by reviewers with write access, on the latest commit." };
    }
    return null;
  };

  const merge = async (
    repo: Repo,
    pull: Pull,
    who: Actor,
    input: { sha?: string; commitTitle?: string; commitMessage?: string },
  ): Promise<string> => {
    const blocker = await mergeBlocker(repo, pull, who, input.sha);
    if (blocker) {
      state.mergeRefusals.push({ repo: repo.fullName, number: pull.number, user: who.login, reason: blocker.reason, at: iso() });
      throw new HttpError(blocker.status, blocker.reason);
    }
    const author = actor(pull.user);
    const title = input.commitTitle ?? `${pull.title} (#${pull.number})`;
    const message = input.commitMessage ?? pull.body;
    const merged = await squashMerge(repo.dir, {
      headSha: pull.headSha,
      message: message ? `${title}\n\n${message}` : title,
      author: { name: author.login, email: `${author.id}+${author.login}@users.noreply.github.com` },
      now: now(),
    });
    if (!merged.ok) {
      state.mergeRefusals.push({ repo: repo.fullName, number: pull.number, user: who.login, reason: merged.reason, at: iso() });
      throw new HttpError(405, merged.reason);
    }
    const at = iso();
    pull.state = "closed";
    pull.merged = true;
    pull.mergedAt = at;
    pull.closedAt = at;
    pull.mergedBy = who.login;
    pull.mergeCommitSha = merged.sha;
    pull.updatedAt = at;
    const before = state.pushes.filter((p) => p.repo === repo.fullName && p.ref === `refs/heads/${PROTECTED_BRANCH}`).at(-1)?.sha;
    state.pushes.push({
      repo: repo.fullName,
      ref: `refs/heads/${PROTECTED_BRANCH}`,
      oldSha: before ?? "",
      sha: merged.sha,
      user: who.login,
      at,
    });
    void track(startCi(repo, merged.sha, PROTECTED_BRANCH, "push", []));
    void track(queueDeploy(repo, merged.sha));
    return merged.sha;
  };

  // -------------------------------------------------------------------------
  // Actions: visible CI and the release
  // -------------------------------------------------------------------------

  const newRun = (
    repo: Repo,
    workflow: (typeof WORKFLOWS)[number],
    headSha: string,
    headBranch: string,
    event: WorkflowRun["event"],
    pullNumbers: number[],
    jobNames: { name: string; command: string | null }[],
  ): WorkflowRun => {
    const runId = id();
    const at = iso();
    const runNumber = state.workflowRuns.filter((r) => r.repo === repo.fullName && r.name === workflow.name).length + 1;
    const run: WorkflowRun = {
      id: runId,
      nodeId: `WFR_${b64(`run:${runId}`)}`,
      repo: repo.fullName,
      workflowId: workflow.id,
      name: workflow.name,
      event,
      headSha,
      headBranch,
      status: "queued",
      conclusion: null,
      runNumber,
      runAttempt: 1,
      createdAt: at,
      updatedAt: at,
      runStartedAt: at,
      checkSuiteId: id(),
      pullNumbers,
      jobs: [],
    };
    run.jobs = jobNames.map((j) => newJob(repo, run, j.name, j.command));
    state.workflowRuns.push(run);
    return run;
  };

  const newJob = (repo: Repo, run: WorkflowRun, name: string, command: string | null): Job => {
    const jobId = id();
    const checkRunId = id();
    const check: CheckRun = {
      id: checkRunId,
      nodeId: `CR_${b64(`check:${checkRunId}`)}`,
      repo: repo.fullName,
      headSha: run.headSha,
      name,
      status: "queued",
      conclusion: null,
      startedAt: null,
      completedAt: null,
      runId: run.id,
      jobId,
    };
    state.checkRuns.push(check);
    return {
      id: jobId,
      runId: run.id,
      runAttempt: run.runAttempt,
      name,
      command,
      status: "queued",
      conclusion: null,
      startedAt: null,
      completedAt: null,
      log: "",
      steps: [],
      checkRunId,
    };
  };

  const checkFor = (job: Job): CheckRun | undefined => state.checkRuns.find((c) => c.id === job.checkRunId);

  const setJob = (job: Job, status: Job["status"], conclusion: string | null = null): void => {
    const at = iso();
    job.status = status;
    job.conclusion = conclusion;
    if (status === "in_progress") job.startedAt = at;
    if (status === "completed") job.completedAt = at;
    const check = checkFor(job);
    if (check) {
      check.status = status;
      check.conclusion = conclusion;
      if (status === "in_progress") check.startedAt = at;
      if (status === "completed") check.completedAt = at;
    }
  };

  const finishRun = (run: WorkflowRun): void => {
    run.status = "completed";
    const conclusions = run.jobs.map((j) => j.conclusion);
    run.conclusion = conclusions.includes("cancelled")
      ? "cancelled"
      : conclusions.every((c) => c === "success")
        ? "success"
        : "failure";
    run.updatedAt = iso();
  };

  /** Actions log lines carry a timestamp; `gh run view --log` prints them as-is. */
  const stamp = (text: string): string =>
    text
      .split("\n")
      .filter((line, i, all) => line !== "" || i < all.length - 1)
      .map((line) => `${iso()} ${line}`)
      .join("\n");

  const runCommand = (command: string, cwd: string, runId: number): Promise<{ code: number | null; output: string }> =>
    new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd,
        env: config.ciUid === undefined ? config.ciEnv : { ...config.ciEnv, HOME: ciHome },
        ...(config.ciUid === undefined ? {} : { uid: config.ciUid, gid: config.ciUid }),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      running.set(runId, child);
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      const timer = setTimeout(() => {
        output += `\n##[error]The job exceeded the maximum execution time of ${config.ciTimeoutSeconds}s.\n`;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, config.ciTimeoutSeconds * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        running.delete(runId);
        resolve({ code, output });
      });
    });

  /**
   * One `ci` run per head: a job per visible command in `run` mode, or one
   * job carrying the next scripted verdict. A newer head for the same branch
   * cancels an older run still going, the way a concurrency group does.
   */
  const startCi = async (
    repo: Repo,
    headSha: string,
    headBranch: string,
    event: WorkflowRun["event"],
    pullNumbers: number[],
    rerunOf?: WorkflowRun,
  ): Promise<void> => {
    for (const other of state.workflowRuns) {
      if (
        other.repo === repo.fullName &&
        other.name === "ci" &&
        other.headBranch === headBranch &&
        other.headSha !== headSha &&
        other.status !== "completed"
      ) {
        cancelRun(other);
      }
    }
    const scripted = state.ci.mode === "scripted";
    const run =
      rerunOf ??
      newRun(
        repo,
        WORKFLOWS[0],
        headSha,
        headBranch,
        event,
        pullNumbers,
        scripted
          ? [{ name: "test", command: null }]
          : config.ciVisible.map((command) => ({ name: command, command })),
      );
    run.status = "in_progress";
    run.updatedAt = iso();
    if (scripted) {
      const verdicts = state.ci.verdicts;
      const verdict: ScriptedVerdict = verdicts.length
        ? verdicts[Math.min(state.ci.used, verdicts.length - 1)]
        : { conclusion: "success" };
      state.ci.used++;
      for (const job of run.jobs.filter((j) => j.status !== "completed")) {
        setJob(job, "in_progress");
        job.log = stamp(verdict.log ?? (verdict.conclusion === "success" ? "All checks passed." : "Tests failed."));
        job.steps = [step("Run tests", 1, verdict.conclusion)];
        setJob(job, "completed", verdict.conclusion);
      }
      finishRun(run);
      await afterCi(repo, run);
      return;
    }
    const dir = join(ciRoot, String(run.id));
    await ciCheckout(repo.dir, headSha, dir);
    if (config.ciUid !== undefined) {
      const owner = `${config.ciUid}:${config.ciUid}`;
      const made = await mkdir(ciHome, { recursive: true });
      await chmod(ciHome, 0o700);
      // The home keeps npm's cache between runs, so it is handed over once
      // rather than walked on every run.
      const paths = made === undefined ? [dir] : [dir, ciHome];
      await new Promise<void>((resolve, reject) =>
        execFile("chown", ["-R", owner, ...paths], (err) => (err ? reject(err) : resolve())),
      );
    }
    try {
      for (const job of run.jobs) {
        if (job.status === "completed") continue;
        // Re-read after every await: a newer head cancels this run while a
        // command is still going.
        if (done(run)) break;
        setJob(job, "in_progress");
        const { code, output } = await runCommand(job.command ?? "true", dir, run.id);
        if (done(job)) continue;
        const conclusion = code === 0 ? "success" : "failure";
        job.log = stamp(`##[group]Run ${job.command}\n${job.command}\n##[endgroup]\n${output}${code === 0 ? "" : `\n##[error]Process completed with exit code ${code ?? "null"}.`}`);
        job.steps = [step("Set up job", 1, "success"), step(`Run ${job.command}`, 2, conclusion)];
        setJob(job, "completed", conclusion);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (!done(run)) finishRun(run);
    await afterCi(repo, run);
  };

  const step = (name: string, number: number, conclusion: string): Job["steps"][number] => ({
    name,
    number,
    status: "completed",
    conclusion,
    startedAt: iso(),
    completedAt: iso(),
  });

  const cancelRun = (run: WorkflowRun): void => {
    const child = running.get(run.id);
    for (const job of run.jobs) {
      if (job.status !== "completed") {
        job.log = stamp("##[error]The operation was canceled.");
        setJob(job, "completed", "cancelled");
      }
    }
    run.status = "completed";
    run.conclusion = "cancelled";
    run.updatedAt = iso();
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };

  const afterCi = async (repo: Repo, run: WorkflowRun): Promise<void> => {
    for (const number of run.pullNumbers) {
      const pull = pullsOf(repo).find((p) => p.number === number);
      if (pull && pull.headSha === run.headSha) await maybeReview(repo, pull);
    }
    for (const pull of pullsOf(repo)) {
      if (pull.state === "open" && pull.headSha === run.headSha && !run.pullNumbers.includes(pull.number)) {
        await maybeReview(repo, pull);
      }
    }
  };

  const rerun = async (repo: Repo, run: WorkflowRun, onlyFailed: boolean, onlyJob?: Job): Promise<void> => {
    if (run.status !== "completed") throw new HttpError(403, "This workflow is already running");
    run.runAttempt++;
    run.status = "queued";
    run.conclusion = null;
    run.updatedAt = iso();
    run.runStartedAt = iso();
    run.jobs = run.jobs.map((j) => {
      const again = onlyJob ? j.id === onlyJob.id : !onlyFailed || j.conclusion !== "success";
      if (!again) return j;
      const fresh = newJob(repo, run, j.name, j.command);
      return fresh;
    });
    if (run.name === "release") void track(queueDeploy(repo, run.headSha, run));
    else void track(startCi(repo, run.headSha, run.headBranch, run.event, run.pullNumbers, run));
  };

  const queueDeploy = (repo: Repo, sha: string, rerunOf?: WorkflowRun): Promise<void> => {
    const run = rerunOf ?? newRun(repo, WORKFLOWS[1], sha, PROTECTED_BRANCH, "push", [], [{ name: "deploy", command: null }]);
    const deploy = { sha, runId: run.id, exitCode: null as number | null, startedAt: iso(), finishedAt: null as string | null };
    state.deploys.push(deploy);
    const go = async (): Promise<void> => {
      run.status = "in_progress";
      const job = run.jobs[0];
      setJob(job, "in_progress");
      let code = 0;
      if (config.deployHookCommand) {
        const dir = join(config.dataDir, "deploys", `${sha}-${run.runAttempt}`);
        await checkout(repo.dir, sha, dir);
        try {
          code = await new Promise<number>((resolve) => {
            const child = spawn("bash", ["-c", `${config.deployHookCommand} "$1" "$2"`, "deploy-hook", sha, dir], {
              env: config.ciEnv,
              stdio: ["ignore", "inherit", "inherit"],
            });
            child.on("close", (c) => resolve(c ?? 1));
            child.on("error", () => resolve(127));
          });
        } finally {
          await removeCheckout(repo.dir, dir);
        }
      }
      deploy.exitCode = code;
      deploy.finishedAt = iso();
      const conclusion = code === 0 ? "success" : "failure";
      // The hook's own output is never copied here: it runs the hidden check,
      // and anything it printed would reach the agent through `gh run view`.
      job.log = stamp(code === 0 ? `Deploying ${sha}\nDeployed ${sha}` : `Deploying ${sha}\n##[error]Deploy failed.`);
      job.steps = [step("Deploy", 1, conclusion)];
      setJob(job, "completed", conclusion);
      finishRun(run);
    };
    deployQueue = deployQueue.then(go, go);
    return deployQueue;
  };

  // -------------------------------------------------------------------------
  // The reviewer
  // -------------------------------------------------------------------------

  /**
   * The delegate reviewer, mechanically: asked with a bare `delegate review`
   * comment, it reviews the head once visible CI on it is green, as a
   * COMMENTED review whose verdict is a line of text -- which is how the real
   * one reports, and what ship-pr reads. It answers each request once, and
   * `requestChangesOnce` makes its first answer a request for changes.
   */
  const maybeReview = async (repo: Repo, pull: Pull): Promise<void> => {
    if (pull.state !== "open") return;
    const lastReview = pull.reviews.filter((r) => r.user === config.reviewerLogin).at(-1);
    // Ids are handed out in order, so "asked since it last answered" is a
    // comparison of ids rather than of timestamps that can tie.
    const asked = pull.comments.some(
      (c) => REVIEW_TRIGGER.test(c.body) && (!lastReview || c.id > lastReview.id),
    );
    if (!asked) return;
    if (!ciGreen(repo, pull.headSha)) return;
    const requestChanges = config.requestChangesOnce && !state.reviewerRequestedChanges;
    if (requestChanges) state.reviewerRequestedChanges = true;
    const body = requestChanges
      ? [
          "## Review",
          "",
          "The change is plausible, but nothing in it proves the failure mode it fixes cannot come back. Add a test that fails on the base commit and passes with this change.",
          "",
          "Recommendation: request changes",
        ].join("\n")
      : [
          "## Review",
          "",
          "Visible CI is green on this commit and the change is scoped to the problem it describes.",
          "",
          "Recommendation: approve",
        ].join("\n");
    addReview(pull, config.reviewerLogin, "COMMENT", body, pull.headSha);
  };

  // -------------------------------------------------------------------------
  // JSON shapes
  // -------------------------------------------------------------------------

  const userJson = (login: string) => {
    const a = actor(login);
    return {
      login: a.login,
      id: a.id,
      node_id: `${a.type === "Bot" ? "BOT" : "U"}_${b64(`user:${a.id}`)}`,
      type: a.type,
      site_admin: false,
      url: `${api}/users/${encodeURIComponent(a.login)}`,
      html_url: `${web}/${a.type === "Bot" ? "apps/" + a.login.replace(/\[bot\]$/, "") : a.login}`,
      avatar_url: `${web}/avatars/${a.id}`,
    };
  };

  const repoJson = (repo: Repo) => {
    const [owner, name] = repo.fullName.split("/");
    return {
      id: repo.id,
      node_id: repo.nodeId,
      name,
      full_name: repo.fullName,
      private: true,
      visibility: "private",
      owner: { ...userJson(owner), type: "Organization" },
      html_url: `${web}/${repo.fullName}`,
      url: `${api}/repos/${repo.fullName}`,
      clone_url: `${web}/${repo.fullName}.git`,
      default_branch: PROTECTED_BRANCH,
      fork: false,
      archived: false,
      disabled: false,
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      delete_branch_on_merge: false,
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    };
  };

  const branchRef = (repo: Repo, ref: string, sha: string, owner: string) => ({
    label: `${repo.fullName.split("/")[0]}:${ref}`,
    ref,
    sha,
    user: { ...userJson(owner), type: "Organization" },
    repo: repoJson(repo),
  });

  const pullJson = async (repo: Repo, pull: Pull) => {
    const owner = repo.fullName.split("/")[0];
    const commits = await commitsBetween(repo.dir, pull.baseSha, pull.headSha).catch(() => []);
    const files = await prFiles(repo.dir, pull.baseSha, pull.headSha).catch(() => []);
    return {
      url: `${api}/repos/${repo.fullName}/pulls/${pull.number}`,
      id: pull.id,
      node_id: pull.nodeId,
      html_url: `${web}/${repo.fullName}/pull/${pull.number}`,
      diff_url: `${web}/${repo.fullName}/pull/${pull.number}.diff`,
      patch_url: `${web}/${repo.fullName}/pull/${pull.number}.patch`,
      issue_url: `${api}/repos/${repo.fullName}/issues/${pull.number}`,
      number: pull.number,
      state: pull.state,
      locked: false,
      title: pull.title,
      user: userJson(pull.user),
      body: pull.body,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.closedAt,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      draft: pull.draft,
      head: branchRef(repo, pull.head, pull.headSha, owner),
      base: branchRef(repo, pull.base, (await revParse(repo.dir, `refs/heads/${pull.base}`)) ?? pull.baseSha, owner),
      author_association: actor(pull.user).type === "Bot" ? "NONE" : "MEMBER",
      merged: pull.merged,
      mergeable: pull.state === "open" ? true : null,
      mergeable_state: pull.state !== "open" ? "unknown" : (await mergeBlocker(repo, pull, actor("sim-maintainer"))) ? "blocked" : "clean",
      merged_by: pull.mergedBy ? userJson(pull.mergedBy) : null,
      comments: pull.comments.length,
      review_comments: 0,
      commits: commits.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      changed_files: files.length,
      requested_reviewers: [],
      requested_teams: [],
      labels: [],
      assignees: [],
      milestone: null,
    };
  };

  const reviewJson = (repo: Repo, pull: Pull, r: Review) => ({
    id: r.id,
    node_id: r.nodeId,
    user: userJson(r.user),
    body: r.body,
    state: r.state,
    commit_id: r.commitId,
    submitted_at: r.submittedAt,
    author_association: actor(r.user).type === "Bot" ? "NONE" : "MEMBER",
    html_url: `${web}/${repo.fullName}/pull/${pull.number}#pullrequestreview-${r.id}`,
    pull_request_url: `${api}/repos/${repo.fullName}/pulls/${pull.number}`,
  });

  const commentJson = (repo: Repo, pull: Pull, c: IssueComment) => ({
    id: c.id,
    node_id: c.nodeId,
    user: userJson(c.user),
    body: c.body,
    created_at: c.createdAt,
    updated_at: c.createdAt,
    author_association: actor(c.user).type === "Bot" ? "NONE" : "MEMBER",
    html_url: `${web}/${repo.fullName}/pull/${pull.number}#issuecomment-${c.id}`,
    issue_url: `${api}/repos/${repo.fullName}/issues/${pull.number}`,
    url: `${api}/repos/${repo.fullName}/issues/comments/${c.id}`,
  });

  const commitJson = (repo: Repo, c: CommitInfo) => ({
    sha: c.sha,
    node_id: `C_${b64(`commit:${c.sha}`)}`,
    url: `${api}/repos/${repo.fullName}/commits/${c.sha}`,
    html_url: `${web}/${repo.fullName}/commit/${c.sha}`,
    commit: {
      message: c.message,
      tree: { sha: c.tree },
      author: { name: c.authorName, email: c.authorEmail, date: c.authorDate },
      committer: { name: c.committerName, email: c.committerEmail, date: c.committerDate },
    },
    parents: c.parents.map((sha) => ({ sha, url: `${api}/repos/${repo.fullName}/commits/${sha}` })),
    author: null,
    committer: null,
  });

  const jobJson = (repo: Repo, run: WorkflowRun, job: Job) => ({
    id: job.id,
    run_id: run.id,
    run_attempt: job.runAttempt,
    node_id: `CR_${b64(`job:${job.id}`)}`,
    head_sha: run.headSha,
    head_branch: run.headBranch,
    workflow_name: run.name,
    url: `${api}/repos/${repo.fullName}/actions/jobs/${job.id}`,
    html_url: `${web}/${repo.fullName}/actions/runs/${run.id}/job/${job.id}`,
    run_url: `${api}/repos/${repo.fullName}/actions/runs/${run.id}`,
    check_run_url: `${api}/repos/${repo.fullName}/check-runs/${job.checkRunId}`,
    status: job.status,
    conclusion: job.conclusion,
    created_at: run.createdAt,
    started_at: job.startedAt ?? run.createdAt,
    completed_at: job.completedAt,
    name: job.name,
    steps: job.steps.map((s) => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      number: s.number,
      started_at: s.startedAt,
      completed_at: s.completedAt,
    })),
    labels: ["ubuntu-latest"],
    runner_name: "sim-runner",
  });

  const runJson = async (repo: Repo, run: WorkflowRun) => {
    const head = await commitInfo(repo.dir, run.headSha);
    const workflow = WORKFLOWS.find((w) => w.id === run.workflowId)!;
    return {
      id: run.id,
      name: run.name,
      node_id: run.nodeId,
      head_branch: run.headBranch,
      head_sha: run.headSha,
      path: workflow.path,
      display_title: head?.message.split("\n")[0] ?? run.name,
      run_number: run.runNumber,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      workflow_id: run.workflowId,
      check_suite_id: run.checkSuiteId,
      url: `${api}/repos/${repo.fullName}/actions/runs/${run.id}`,
      html_url: `${web}/${repo.fullName}/actions/runs/${run.id}`,
      jobs_url: `${api}/repos/${repo.fullName}/actions/runs/${run.id}/jobs`,
      logs_url: `${api}/repos/${repo.fullName}/actions/runs/${run.id}/logs`,
      pull_requests: run.pullNumbers.map((n) => {
        const pull = pullsOf(repo).find((p) => p.number === n);
        return {
          number: n,
          url: `${api}/repos/${repo.fullName}/pulls/${n}`,
          head: { ref: pull?.head, sha: run.headSha },
          base: { ref: pull?.base },
        };
      }),
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      run_attempt: run.runAttempt,
      run_started_at: run.runStartedAt,
      actor: userJson(run.event === "push" ? "sim-maintainer" : config.appLogin),
      head_commit: head
        ? { id: head.sha, tree_id: head.tree, message: head.message, timestamp: head.committerDate, author: { name: head.authorName, email: head.authorEmail } }
        : null,
      repository: repoJson(repo),
      head_repository: repoJson(repo),
    };
  };

  const checkRunJson = (repo: Repo, c: CheckRun) => {
    const run = state.workflowRuns.find((r) => r.id === c.runId);
    return {
      id: c.id,
      node_id: c.nodeId,
      head_sha: c.headSha,
      external_id: String(c.jobId),
      url: `${api}/repos/${repo.fullName}/check-runs/${c.id}`,
      html_url: `${web}/${repo.fullName}/actions/runs/${c.runId}/job/${c.jobId}`,
      details_url: `${web}/${repo.fullName}/actions/runs/${c.runId}/job/${c.jobId}`,
      status: c.status,
      conclusion: c.conclusion,
      started_at: c.startedAt,
      completed_at: c.completedAt,
      name: c.name,
      output: { title: c.conclusion ?? null, summary: null, text: null, annotations_count: 0 },
      check_suite: { id: run?.checkSuiteId },
      app: { id: 15368, slug: "github-actions", name: "GitHub Actions" },
      pull_requests: (run?.pullNumbers ?? []).map((n) => ({ number: n })),
    };
  };

  // -------------------------------------------------------------------------
  // GraphQL model
  // -------------------------------------------------------------------------

  const connection = (nodes: Value[], args: Args = {}): GqlObject => {
    let list = nodes;
    if (typeof args.last === "number") list = list.slice(-args.last);
    if (typeof args.first === "number") list = list.slice(0, args.first);
    return obj(`Connection`, {
      nodes: list,
      edges: list.map((node, i) => obj("Edge", { node, cursor: b64(`cursor:${i}`) })),
      totalCount: nodes.length,
      pageInfo: obj("PageInfo", {
        hasNextPage: false,
        hasPreviousPage: false,
        endCursor: list.length ? b64(`cursor:${list.length - 1}`) : null,
        startCursor: list.length ? b64("cursor:0") : null,
      }),
    });
  };

  const actorGql = (login: string): GqlObject => {
    const a = actor(login);
    return obj(
      a.type,
      {
        id: `${a.type === "Bot" ? "BOT" : "U"}_${b64(`user:${a.id}`)}`,
        // GraphQL names a bot by its slug; REST appends "[bot]". gh relies on
        // the difference, printing a GraphQL bot author as "app/<slug>".
        login: a.type === "Bot" ? a.login.replace(/\[bot\]$/, "") : a.login,
        name: a.type === "Bot" ? null : a.login,
        databaseId: a.id,
        url: `${web}/${a.login}`,
        avatarUrl: `${web}/avatars/${a.id}`,
      },
      ["Actor", "Node", "RequestedReviewer", "Assignee"],
    );
  };

  const ownerGql = (repo: Repo): GqlObject => {
    const owner = repo.fullName.split("/")[0];
    return obj("Organization", { id: `O_${b64(`org:${owner}`)}`, login: owner, name: owner, url: `${web}/${owner}` }, ["RepositoryOwner", "Actor", "Node"]);
  };

  const commitGql = (repo: Repo, sha: string): GqlObject =>
    obj(
      "Commit",
      {
        oid: sha,
        abbreviatedOid: sha.slice(0, 7),
        id: `C_${b64(`commit:${sha}`)}`,
        url: `${web}/${repo.fullName}/commit/${sha}`,
        messageHeadline: async () => (await commitInfo(repo.dir, sha))?.message.split("\n")[0] ?? "",
        messageBody: async () => (await commitInfo(repo.dir, sha))?.message.split("\n").slice(1).join("\n").trim() ?? "",
        message: async () => (await commitInfo(repo.dir, sha))?.message ?? "",
        committedDate: async () => (await commitInfo(repo.dir, sha))?.committerDate ?? null,
        authoredDate: async () => (await commitInfo(repo.dir, sha))?.authorDate ?? null,
        authors: async (args) => {
          const info = await commitInfo(repo.dir, sha);
          return connection(
            info ? [obj("GitActor", { name: info.authorName, email: info.authorEmail, user: null })] : [],
            args,
          );
        },
        statusCheckRollup: () => statusCheckRollupGql(repo, sha),
      },
      ["Node", "GitObject"],
    );

  const checkRunGql = (repo: Repo, c: CheckRun): GqlObject => {
    const run = state.workflowRuns.find((r) => r.id === c.runId);
    const workflow = WORKFLOWS.find((w) => w.id === run?.workflowId);
    return obj("CheckRun", {
      id: c.nodeId,
      databaseId: c.id,
      name: c.name,
      status: upper(c.status),
      conclusion: upper(c.conclusion),
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      detailsUrl: `${web}/${repo.fullName}/actions/runs/${c.runId}/job/${c.jobId}`,
      isRequired: run?.name === "ci",
      checkSuite: obj("CheckSuite", {
        id: `CS_${b64(`suite:${run?.checkSuiteId}`)}`,
        workflowRun: obj("WorkflowRun", {
          id: run?.nodeId ?? null,
          databaseId: run?.id ?? null,
          event: run?.event ?? null,
          url: `${web}/${repo.fullName}/actions/runs/${c.runId}`,
          workflow: obj("Workflow", { name: workflow?.name ?? "", id: `W_${b64(`wf:${workflow?.id}`)}` }),
        }),
        app: obj("App", { name: "GitHub Actions", slug: "github-actions" }),
      }),
    }, ["StatusCheckRollupContext", "Node"]);
  };

  /** The check runs a commit shows, latest attempt of each job only. */
  const checksFor = (repo: Repo, sha: string): CheckRun[] => {
    const current = new Set(
      state.workflowRuns
        .filter((r) => r.repo === repo.fullName && r.headSha === sha)
        .flatMap((r) => r.jobs.map((j) => j.checkRunId)),
    );
    return state.checkRuns.filter((c) => c.repo === repo.fullName && c.headSha === sha && current.has(c.id));
  };

  const rollupState = (checks: CheckRun[]): string => {
    if (checks.some((c) => c.status !== "completed")) return "PENDING";
    if (checks.every((c) => c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral")) return "SUCCESS";
    return "FAILURE";
  };

  const statusCheckRollupGql = (repo: Repo, sha: string): Value => {
    const checks = checksFor(repo, sha);
    if (checks.length === 0) return null;
    const counts = (key: (c: CheckRun) => string) => {
      const m = new Map<string, number>();
      for (const c of checks) m.set(key(c), (m.get(key(c)) ?? 0) + 1);
      return [...m.entries()].map(([s, count]) => obj("CheckRunStateCount", { state: s, count }));
    };
    return obj("StatusCheckRollup", {
      state: rollupState(checks),
      contexts: (args) => {
        const conn = connection(checks.map((c) => checkRunGql(repo, c)), args);
        conn.__typename = "StatusCheckRollupContextConnection";
        conn.fields.checkRunCount = checks.length;
        conn.fields.checkRunCountsByState = counts((c) => (c.status === "completed" ? (c.conclusion ?? "").toUpperCase() : c.status.toUpperCase()));
        conn.fields.statusContextCount = 0;
        conn.fields.statusContextCountsByState = [];
        return conn;
      },
    });
  };

  const reviewGql = (repo: Repo, pull: Pull, r: Review): GqlObject =>
    obj("PullRequestReview", {
      id: r.nodeId,
      databaseId: r.id,
      author: actorGql(r.user),
      authorAssociation: actor(r.user).type === "Bot" ? "NONE" : "MEMBER",
      submittedAt: r.submittedAt,
      createdAt: r.submittedAt,
      body: r.body,
      state: r.state,
      commit: commitGql(repo, r.commitId),
      url: `${web}/${repo.fullName}/pull/${pull.number}#pullrequestreview-${r.id}`,
      reactionGroups: [],
    }, ["Node", "Comment"]);

  const commentGql = (repo: Repo, pull: Pull, c: IssueComment, viewer: string): GqlObject =>
    obj("IssueComment", {
      id: c.nodeId,
      databaseId: c.id,
      author: actorGql(c.user),
      authorAssociation: actor(c.user).type === "Bot" ? "NONE" : "MEMBER",
      body: c.body,
      createdAt: c.createdAt,
      includesCreatedEdit: false,
      isMinimized: false,
      minimizedReason: null,
      reactionGroups: [],
      url: `${web}/${repo.fullName}/pull/${pull.number}#issuecomment-${c.id}`,
      viewerDidAuthor: c.user === viewer,
    }, ["Node", "Comment"]);

  const emptyConnection = (args: Args = {}): GqlObject => connection([], args);

  const pullGql = (repo: Repo, pull: Pull, viewer: string): GqlObject => {
    const files = () => prFiles(repo.dir, pull.baseSha, pull.headSha).catch(() => []);
    const commits = () => commitsBetween(repo.dir, pull.baseSha, pull.headSha).catch(() => []);
    const latestReviews = () => {
      const byUser = new Map<string, Review>();
      for (const r of pull.reviews) byUser.set(r.user, r);
      return [...byUser.values()];
    };
    const decision = () => {
      const humans = latestReviews().filter((r) => actor(r.user).type !== "Bot" && r.state !== "COMMENTED");
      if (humans.some((r) => r.state === "CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
      if (humans.some((r) => r.state === "APPROVED")) return "APPROVED";
      return "REVIEW_REQUIRED";
    };
    const owner = repo.fullName.split("/")[0];
    return obj("PullRequest", {
      id: pull.nodeId,
      databaseId: pull.id,
      fullDatabaseId: String(pull.id),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      url: `${web}/${repo.fullName}/pull/${pull.number}`,
      state: pull.merged ? "MERGED" : pull.state.toUpperCase(),
      closed: pull.state === "closed",
      isDraft: pull.draft,
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
      closedAt: pull.closedAt,
      mergedAt: pull.mergedAt,
      author: actorGql(pull.user),
      mergedBy: pull.mergedBy ? actorGql(pull.mergedBy) : null,
      baseRefName: pull.base,
      baseRefOid: async () => (await revParse(repo.dir, `refs/heads/${pull.base}`)) ?? pull.baseSha,
      baseRef: obj("Ref", {
        name: pull.base,
        branchProtectionRule: obj("BranchProtectionRule", { requiresStrictStatusChecks: false }),
      }),
      headRefName: pull.head,
      headRefOid: pull.headSha,
      headRepository: () => repoGql(repo, viewer),
      headRepositoryOwner: obj("Organization", { id: `O_${b64(`org:${owner}`)}`, login: owner, name: owner }, ["RepositoryOwner"]),
      isCrossRepository: false,
      maintainerCanModify: false,
      mergeable: pull.state === "open" ? "MERGEABLE" : "UNKNOWN",
      mergeStateStatus: async () =>
        pull.state !== "open" ? "UNKNOWN" : (await mergeBlocker(repo, pull, actor("sim-maintainer"))) ? "BLOCKED" : "CLEAN",
      isInMergeQueue: false,
      isMergeQueueEnabled: false,
      mergeQueueEntry: null,
      mergeCommit: pull.mergeCommitSha ? commitGql(repo, pull.mergeCommitSha) : null,
      potentialMergeCommit: null,
      autoMergeRequest: null,
      reviewDecision: decision,
      additions: async () => (await files()).reduce((n, f) => n + f.additions, 0),
      deletions: async () => (await files()).reduce((n, f) => n + f.deletions, 0),
      changedFiles: async () => (await files()).length,
      files: async (args) =>
        connection(
          (await files()).map((f) =>
            obj("PullRequestChangedFile", {
              path: f.path,
              additions: f.additions,
              deletions: f.deletions,
              changeType: f.status === "added" ? "ADDED" : f.status === "removed" ? "DELETED" : "MODIFIED",
            }),
          ),
          args,
        ),
      commits: async (args) => {
        const list = await commits();
        const shas = list.length ? list.map((c) => c.sha) : [pull.headSha];
        return connection(shas.map((sha) => obj("PullRequestCommit", { commit: commitGql(repo, sha), id: `PRC_${b64(sha)}` })), args);
      },
      statusCheckRollup: () => statusCheckRollupGql(repo, pull.headSha),
      reviews: (args) => connection(pull.reviews.map((r) => reviewGql(repo, pull, r)), args),
      latestReviews: (args) => connection(latestReviews().map((r) => reviewGql(repo, pull, r)), args),
      latestOpinionatedReviews: (args) =>
        connection(latestReviews().filter((r) => r.state !== "COMMENTED").map((r) => reviewGql(repo, pull, r)), args),
      reviewRequests: emptyConnection,
      comments: (args) => connection(pull.comments.map((c) => commentGql(repo, pull, c, viewer)), args),
      assignees: emptyConnection,
      assignedActors: emptyConnection,
      labels: emptyConnection,
      projectCards: emptyConnection,
      projectItems: emptyConnection,
      milestone: null,
      reactionGroups: [],
      closingIssuesReferences: emptyConnection,
      viewerDidAuthor: pull.user === viewer,
      repository: () => repoGql(repo, viewer),
    }, ["Node", "Assignable", "Closable", "Comment", "Labelable", "UniformResourceLocatable"]);
  };

  const repoGql = (repo: Repo, viewer: string): GqlObject => {
    const [owner, name] = repo.fullName.split("/");
    const byState = (args: Args) => {
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      return pullsOf(repo)
        .filter((p) => !states || states.includes(p.merged ? "MERGED" : p.state.toUpperCase()))
        .filter((p) => !args.headRefName || p.head === args.headRefName)
        .filter((p) => !args.baseRefName || p.base === args.baseRefName)
        .sort((a, b) => b.number - a.number);
    };
    return obj("Repository", {
      id: repo.nodeId,
      databaseId: repo.id,
      name,
      nameWithOwner: repo.fullName,
      owner: ownerGql(repo),
      url: `${web}/${repo.fullName}`,
      sshUrl: `git@${new URL(web).host}:${repo.fullName}.git`,
      isPrivate: true,
      visibility: "PRIVATE",
      isFork: false,
      isArchived: false,
      isEmpty: false,
      isInOrganization: true,
      isMirror: false,
      isTemplate: false,
      parent: null,
      description: null,
      hasIssuesEnabled: true,
      hasWikiEnabled: false,
      hasProjectsEnabled: false,
      hasDiscussionsEnabled: false,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      autoMergeAllowed: false,
      deleteBranchOnMerge: false,
      viewerPermission: "WRITE",
      viewerCanAdminister: false,
      viewerDefaultMergeMethod: "SQUASH",
      viewerDefaultCommitEmail: null,
      createdAt: "2020-01-01T00:00:00Z",
      pushedAt: iso(),
      updatedAt: iso(),
      defaultBranchRef: async () =>
        obj("Ref", {
          name: PROTECTED_BRANCH,
          target: commitGql(repo, (await revParse(repo.dir, `refs/heads/${PROTECTED_BRANCH}`)) ?? ""),
        }),
      ref: async (args) => {
        const q = String(args.qualifiedName ?? "");
        const refName = q.startsWith("refs/") ? q : `refs/heads/${q}`;
        const sha = await revParse(repo.dir, refName);
        return sha ? obj("Ref", { name: refName.replace(/^refs\/heads\//, ""), prefix: "refs/heads/", target: commitGql(repo, sha) }) : null;
      },
      pullRequest: (args) => {
        const pull = pullsOf(repo).find((p) => p.number === args.number);
        if (!pull) throw new Error(`Could not resolve to a PullRequest with the number of ${String(args.number)}.`);
        return pullGql(repo, pull, viewer);
      },
      issueOrPullRequest: (args) => {
        const pull = pullsOf(repo).find((p) => p.number === args.number);
        if (!pull) throw new Error(`Could not resolve to an issue or pull request with the number of ${String(args.number)}.`);
        return pullGql(repo, pull, viewer);
      },
      pullRequests: (args) => connection(byState(args).map((p) => pullGql(repo, p, viewer)), args),
      pullRequestTemplates: [],
      issueTemplates: [],
      labels: emptyConnection,
      milestones: emptyConnection,
      assignableUsers: emptyConnection,
      mentionableUsers: emptyConnection,
      projects: emptyConnection,
      projectsV2: emptyConnection,
      repositoryTopics: emptyConnection,
      stargazerCount: 0,
      forkCount: 0,
    }, ["Node", "RepositoryInfo"]);
  };

  const graphqlTypes = (): Record<string, string[]> => {
    const repo = state.repos[0];
    const names = (o: GqlObject) => Object.keys(o.fields);
    const stub: Repo = repo ?? { fullName: "o/r", id: 0, nodeId: "", dir: "" };
    const stubPull: Pull = {
      number: 0, id: 0, nodeId: "", repo: stub.fullName, title: "", body: "", head: "", headSha: "", base: "", baseSha: "",
      state: "open", draft: false, merged: false, mergedAt: null, mergedBy: null, mergeCommitSha: null, closedAt: null,
      user: "", createdAt: "", updatedAt: "", reviews: [], comments: [],
    };
    return {
      PullRequest: names(pullGql(stub, stubPull, "")),
      Repository: names(repoGql(stub, "")),
      Issue: ["id", "number", "title", "body", "url", "state", "author", "comments"],
      StatusCheckRollupContextConnection: ["nodes", "edges", "pageInfo", "totalCount", "checkRunCount", "checkRunCountsByState", "statusContextCount", "statusContextCountsByState"],
      WorkflowRun: ["id", "databaseId", "event", "url", "workflow"],
      CheckRun: ["id", "databaseId", "name", "status", "conclusion", "startedAt", "completedAt", "detailsUrl", "isRequired", "checkSuite"],
    };
  };

  const findByNodeId = (nodeId: string, viewer: string): GqlObject | null => {
    for (const repo of state.repos) {
      if (repo.nodeId === nodeId) return repoGql(repo, viewer);
      for (const pull of pullsOf(repo)) {
        if (pull.nodeId === nodeId) return pullGql(repo, pull, viewer);
      }
    }
    return null;
  };

  const pullByNodeId = (nodeId: ArgValue): { repo: Repo; pull: Pull } => {
    for (const repo of state.repos) {
      const pull = pullsOf(repo).find((p) => p.nodeId === nodeId);
      if (pull) return { repo, pull };
    }
    throw new Error(`Could not resolve to a node with the global id of '${String(nodeId)}'`);
  };

  const input = (args: Args): Record<string, ArgValue> =>
    (args.input && typeof args.input === "object" && !Array.isArray(args.input) ? args.input : {}) as Record<string, ArgValue>;

  const graphql = async (who: Actor, body: { query?: string; variables?: Record<string, ArgValue>; operationName?: string }) => {
    const viewer = who.login;
    const queryRoot = obj("Query", {
      viewer: () => actorGql(viewer),
      repository: (args) => {
        const repo = state.repos.find((r) => r.fullName.toLowerCase() === `${String(args.owner)}/${String(args.name)}`.toLowerCase());
        if (!repo) throw new Error(`Could not resolve to a Repository with the name '${String(args.owner)}/${String(args.name)}'.`);
        return repoGql(repo, viewer);
      },
      node: (args) => findByNodeId(String(args.id), viewer),
      nodes: (args) => (Array.isArray(args.ids) ? args.ids.map((i) => findByNodeId(String(i), viewer)) : []),
      user: (args) => actorGql(String(args.login)),
      organization: (args) => obj("Organization", { id: `O_${b64(`org:${String(args.login)}`)}`, login: String(args.login), name: String(args.login) }),
      rateLimit: obj("RateLimit", { limit: 5000, remaining: 5000, cost: 1, resetAt: iso() }),
      // Issue search over pull requests, which is all there is here. Only the
      // qualifiers gh composes are read; any other term is a title match,
      // which is close enough to GitHub's full-text search for a handful of
      // PRs, and a qualifier nobody models matches nothing rather than all.
      search: (args) => {
        const terms = String(args.query ?? "").match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
        const matches = state.pulls.filter((p) => {
          const bot = actor(p.user).type === "Bot";
          for (const raw of terms) {
            const term = raw.replace(/"/g, "");
            const [key, value] = term.includes(":") ? [term.slice(0, term.indexOf(":")), term.slice(term.indexOf(":") + 1)] : ["", term];
            const me = value === "@me" ? viewer : value;
            const ok = (() => {
              switch (key) {
                case "repo": return p.repo.toLowerCase() === value.toLowerCase();
                case "is":
                  if (value === "pr") return true;
                  if (value === "issue") return false;
                  if (value === "open") return p.state === "open";
                  if (value === "closed") return p.state === "closed";
                  if (value === "merged") return p.merged;
                  if (value === "unmerged") return !p.merged;
                  if (value === "draft") return p.draft;
                  return false;
                case "state": return p.state === value;
                case "type": return value === "pr";
                case "author": return p.user === me || (bot && p.user === `${me.replace(/^app\//, "")}[bot]`);
                case "head": return p.head === value;
                case "base": return p.base === value;
                case "review-requested":
                case "assignee":
                case "label":
                case "mentions":
                  return false;
                case "archived": return value === "false";
                case "sort": return true;
                case "": return p.title.toLowerCase().includes(value.toLowerCase());
                default: return false;
              }
            })();
            if (!ok) return false;
          }
          return true;
        });
        const nodes = matches
          .sort((a, b) => b.number - a.number)
          .map((p) => pullGql(state.repos.find((r) => r.fullName === p.repo)!, p, viewer));
        const conn = connection(nodes, args);
        conn.__typename = "SearchResultItemConnection";
        conn.fields.issueCount = nodes.length;
        return conn;
      },
    });
    const mutationRoot = obj("Mutation", {
      createPullRequest: async (args) => {
        const i = input(args);
        const repo = state.repos.find((r) => r.nodeId === i.repositoryId);
        if (!repo) throw new Error(`Could not resolve to a node with the global id of '${String(i.repositoryId)}'`);
        try {
          const pull = await createPull(repo, {
            head: String(i.headRefName),
            base: i.baseRefName ? String(i.baseRefName) : undefined,
            title: String(i.title ?? ""),
            body: i.body ? String(i.body) : "",
            draft: i.draft === true,
            user: viewer,
          });
          return obj("CreatePullRequestPayload", { pullRequest: pullGql(repo, pull, viewer), clientMutationId: null });
        } catch (err) {
          throw new Error(err instanceof HttpError ? err.message : String(err));
        }
      },
      addComment: (args) => {
        const i = input(args);
        const { repo, pull } = pullByNodeId(i.subjectId);
        const comment = addComment(repo, pull, viewer, String(i.body ?? ""));
        return obj("AddCommentPayload", {
          commentEdge: obj("IssueCommentEdge", { node: commentGql(repo, pull, comment, viewer) }),
          subject: pullGql(repo, pull, viewer),
          clientMutationId: null,
        });
      },
      updatePullRequest: (args) => {
        const i = input(args);
        const { repo, pull } = pullByNodeId(i.pullRequestId);
        if (typeof i.title === "string") pull.title = i.title;
        if (typeof i.body === "string") pull.body = i.body;
        if (i.state === "CLOSED") {
          pull.state = "closed";
          pull.closedAt = iso();
        }
        pull.updatedAt = iso();
        return obj("UpdatePullRequestPayload", { pullRequest: pullGql(repo, pull, viewer), clientMutationId: null });
      },
      closePullRequest: (args) => {
        const { repo, pull } = pullByNodeId(input(args).pullRequestId);
        pull.state = "closed";
        pull.closedAt = iso();
        pull.updatedAt = iso();
        return obj("ClosePullRequestPayload", { pullRequest: pullGql(repo, pull, viewer), clientMutationId: null });
      },
      reopenPullRequest: (args) => {
        const { repo, pull } = pullByNodeId(input(args).pullRequestId);
        if (!pull.merged) {
          pull.state = "open";
          pull.closedAt = null;
          pull.updatedAt = iso();
        }
        return obj("ReopenPullRequestPayload", { pullRequest: pullGql(repo, pull, viewer), clientMutationId: null });
      },
      markPullRequestReadyForReview: (args) => {
        const { repo, pull } = pullByNodeId(input(args).pullRequestId);
        pull.draft = false;
        return obj("MarkPullRequestReadyForReviewPayload", { pullRequest: pullGql(repo, pull, viewer), clientMutationId: null });
      },
      requestReviews: (args) => {
        const { repo, pull } = pullByNodeId(input(args).pullRequestId);
        return obj("RequestReviewsPayload", { pullRequest: pullGql(repo, pull, viewer), clientMutationId: null });
      },
      addPullRequestReview: (args) => {
        const i = input(args);
        const { repo, pull } = pullByNodeId(i.pullRequestId);
        try {
          const review = addReview(pull, viewer, String(i.event ?? "COMMENT"), String(i.body ?? ""), i.commitOID ? String(i.commitOID) : undefined);
          return obj("AddPullRequestReviewPayload", { pullRequestReview: reviewGql(repo, pull, review), clientMutationId: null });
        } catch (err) {
          throw new Error(err instanceof HttpError ? err.message : String(err));
        }
      },
      mergePullRequest: async (args) => {
        const i = input(args);
        const { repo, pull } = pullByNodeId(i.pullRequestId);
        try {
          await merge(repo, pull, who, {
            sha: i.expectedHeadOid ? String(i.expectedHeadOid) : undefined,
            commitTitle: i.commitHeadline ? String(i.commitHeadline) : undefined,
            commitMessage: typeof i.commitBody === "string" ? i.commitBody : undefined,
          });
        } catch (err) {
          throw new Error(err instanceof HttpError ? err.message : String(err));
        }
        return obj("MergePullRequestPayload", { pullRequest: pullGql(repo, pull, viewer), clientMutationId: null });
      },
    });
    return execute({
      query: body.query ?? "",
      variables: body.variables ?? {},
      operationName: body.operationName,
      query_root: queryRoot,
      mutation_root: mutationRoot,
      types: graphqlTypes(),
      onMissing: (type, field) => state.unhandled.push({ method: "GRAPHQL", path: `${type}.${field}`, at: iso() }),
    });
  };

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const text = await readBody(req);
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Problems parsing JSON");
    }
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const isText = typeof body === "string" || Buffer.isBuffer(body);
    res.writeHead(status, {
      "content-type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "x-github-media-type": "github.v3; format=json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      ...headers,
    });
    res.end(isText ? body : body === undefined ? "" : JSON.stringify(body));
  };

  const sendError = (res: ServerResponse, err: HttpError): void =>
    send(res, err.status, { message: err.message, documentation_url: "https://docs.github.com/enterprise-server@3.17/rest", status: String(err.status) }, err.headers);

  const page = <T>(items: T[], url: URL): T[] => {
    const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), 100);
    const pageNo = Math.max(Number(url.searchParams.get("page") ?? 1), 1);
    return items.slice((pageNo - 1) * perPage, pageNo * perPage);
  };

  const emptyZip = (): Buffer => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    return eocd;
  };

  const runOf = (repo: Repo, runId: number): WorkflowRun => {
    const run = state.workflowRuns.find((r) => r.repo === repo.fullName && r.id === runId);
    if (!run) throw new HttpError(404, "Not Found");
    return run;
  };

  const jobOf = (repo: Repo, jobId: number): { run: WorkflowRun; job: Job } => {
    for (const run of state.workflowRuns.filter((r) => r.repo === repo.fullName)) {
      const job = run.jobs.find((j) => j.id === jobId);
      if (job) return { run, job };
    }
    throw new HttpError(404, "Not Found");
  };

  const requireWrite = (who: Actor): void => {
    if (who.type === "Bot" && !config.actionsWrite) {
      throw new HttpError(403, "Resource not accessible by integration", {
        "x-accepted-github-permissions": "actions=write",
      });
    }
  };

  const rest = async (req: IncomingMessage, res: ServerResponse, url: URL, who: Actor | null): Promise<void> => {
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v3/, "").replace(/\/$/, "") || "/";
    const m = (pattern: RegExp): RegExpExecArray | null => pattern.exec(path);
    let match: RegExpExecArray | null;

    if (method === "POST" && (match = m(/^\/app\/installations\/(\d+)\/access_tokens$/))) {
      const header = req.headers.authorization ?? "";
      if (!/^bearer\s+\S+\.\S+\.\S+$/i.test(header)) throw new HttpError(401, "A JSON web token could not be decoded");
      const token = `ghs_${randomBytes(18).toString("hex")}`;
      appTokens.add(token);
      state.tokensMinted++;
      return send(res, 201, {
        token,
        expires_at: new Date(now().getTime() + 3600_000).toISOString(),
        permissions: { contents: "write", pull_requests: "write", actions: config.actionsWrite ? "write" : "read", metadata: "read" },
        repository_selection: "all",
      });
    }
    if (method === "GET" && (path === "/meta" || path === "/")) {
      return send(res, 200, { installed_version: "3.17.0", verifiable_password_authentication: false });
    }
    if (!who) throw new HttpError(401, "Bad credentials");

    if (method === "GET" && path === "/user") {
      if (who.type === "Bot") throw new HttpError(403, "Resource not accessible by integration");
      return send(res, 200, userJson(who.login));
    }
    if (method === "GET" && (match = m(/^\/users\/([^/]+)$/))) return send(res, 200, userJson(decodeURIComponent(match[1])));

    match = m(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!match) throw new HttpError(404, "Not Found");
    const repo = findRepo(match[1]);
    const sub = match[2] ?? "";
    const s = (pattern: RegExp): RegExpExecArray | null => pattern.exec(sub);

    if (method === "GET" && sub === "") return send(res, 200, repoJson(repo));

    // Pulls
    if (method === "GET" && sub === "/pulls") {
      const st = url.searchParams.get("state") ?? "open";
      const head = url.searchParams.get("head");
      const base = url.searchParams.get("base");
      const list = pullsOf(repo)
        .filter((p) => st === "all" || p.state === st)
        .filter((p) => !head || p.head === (head.includes(":") ? head.split(":")[1] : head))
        .filter((p) => !base || p.base === base)
        .sort((a, b) => b.number - a.number);
      return send(res, 200, await Promise.all(page(list, url).map((p) => pullJson(repo, p))));
    }
    if (method === "POST" && sub === "/pulls") {
      const b = await readJson(req);
      const pull = await createPull(repo, {
        head: String(b.head ?? ""),
        base: b.base ? String(b.base) : undefined,
        title: String(b.title ?? ""),
        body: b.body ? String(b.body) : "",
        draft: b.draft === true,
        user: who.login,
      });
      return send(res, 201, await pullJson(repo, pull));
    }
    if ((match = s(/^\/pulls\/(\d+)$/))) {
      const pull = findPull(repo, Number(match[1]));
      if (method === "GET") {
        const accept = String(req.headers.accept ?? "");
        if (/diff|patch/.test(accept)) {
          return send(res, 200, await prDiff(repo.dir, pull.baseSha, pull.headSha), { "content-type": "text/plain; charset=utf-8" });
        }
        return send(res, 200, await pullJson(repo, pull));
      }
      if (method === "PATCH") {
        const b = await readJson(req);
        if (typeof b.title === "string") pull.title = b.title;
        if (typeof b.body === "string") pull.body = b.body;
        if (b.state === "closed" && pull.state === "open") {
          pull.state = "closed";
          pull.closedAt = iso();
        }
        if (b.state === "open" && !pull.merged) {
          pull.state = "open";
          pull.closedAt = null;
        }
        pull.updatedAt = iso();
        return send(res, 200, await pullJson(repo, pull));
      }
    }
    if (method === "GET" && (match = s(/^\/pulls\/(\d+)\/files$/))) {
      const pull = findPull(repo, Number(match[1]));
      const files = await prFiles(repo.dir, pull.baseSha, pull.headSha);
      return send(res, 200, page(files, url).map((f) => ({ filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions })));
    }
    if (method === "GET" && (match = s(/^\/pulls\/(\d+)\/commits$/))) {
      const pull = findPull(repo, Number(match[1]));
      return send(res, 200, page(await commitsBetween(repo.dir, pull.baseSha, pull.headSha), url).map((c) => commitJson(repo, c)));
    }
    if ((match = s(/^\/pulls\/(\d+)\/reviews$/))) {
      const pull = findPull(repo, Number(match[1]));
      if (method === "GET") return send(res, 200, page(pull.reviews, url).map((r) => reviewJson(repo, pull, r)));
      if (method === "POST") {
        const b = await readJson(req);
        const review = addReview(pull, who.login, String(b.event ?? "COMMENT"), String(b.body ?? ""), b.commit_id ? String(b.commit_id) : undefined);
        return send(res, 200, reviewJson(repo, pull, review));
      }
    }
    if (method === "GET" && (match = s(/^\/pulls\/(\d+)\/reviews\/(\d+)$/))) {
      const pull = findPull(repo, Number(match[1]));
      const review = pull.reviews.find((r) => r.id === Number(match![2]));
      if (!review) throw new HttpError(404, "Not Found");
      return send(res, 200, reviewJson(repo, pull, review));
    }
    if (method === "GET" && (match = s(/^\/pulls\/(\d+)\/(comments|requested_reviewers)$/))) {
      findPull(repo, Number(match[1]));
      return send(res, 200, match[2] === "comments" ? [] : { users: [], teams: [] });
    }
    if (method === "POST" && (match = s(/^\/pulls\/(\d+)\/requested_reviewers$/))) {
      const pull = findPull(repo, Number(match[1]));
      return send(res, 201, await pullJson(repo, pull));
    }
    if ((match = s(/^\/pulls\/(\d+)\/merge$/))) {
      const pull = findPull(repo, Number(match[1]));
      if (method === "GET") {
        if (pull.merged) return send(res, 204, undefined);
        throw new HttpError(404, "Not Found");
      }
      if (method === "PUT") {
        const b = await readJson(req);
        const sha = await merge(repo, pull, who, {
          sha: b.sha ? String(b.sha) : undefined,
          commitTitle: b.commit_title ? String(b.commit_title) : undefined,
          commitMessage: typeof b.commit_message === "string" ? b.commit_message : undefined,
        });
        return send(res, 200, { sha, merged: true, message: "Pull Request successfully merged" });
      }
    }

    // Issues (a PR is an issue for comments)
    if ((match = s(/^\/issues\/(\d+)\/comments$/))) {
      const pull = findPull(repo, Number(match[1]));
      if (method === "GET") return send(res, 200, page(pull.comments, url).map((c) => commentJson(repo, pull, c)));
      if (method === "POST") {
        const b = await readJson(req);
        if (typeof b.body !== "string" || !b.body) throw new HttpError(422, "Validation Failed: body is required");
        return send(res, 201, commentJson(repo, pull, addComment(repo, pull, who.login, b.body)));
      }
    }
    if (method === "GET" && (match = s(/^\/issues\/(\d+)$/))) {
      const pull = findPull(repo, Number(match[1]));
      const j = await pullJson(repo, pull);
      return send(res, 200, { ...j, pull_request: { url: j.url, html_url: j.html_url, merged_at: j.merged_at } });
    }

    // Commits and checks
    if (method === "GET" && (match = s(/^\/commits\/([^/]+)$/))) {
      const info = await commitInfo(repo.dir, decodeURIComponent(match[1]));
      if (!info) throw new HttpError(422, `No commit found for SHA: ${match[1]}`);
      return send(res, 200, commitJson(repo, info));
    }
    if (method === "GET" && (match = s(/^\/commits\/([^/]+)\/check-runs$/))) {
      const sha = await revParse(repo.dir, decodeURIComponent(match[1]));
      if (!sha) throw new HttpError(422, `No commit found for SHA: ${match[1]}`);
      const checks = checksFor(repo, sha);
      return send(res, 200, { total_count: checks.length, check_runs: page(checks, url).map((c) => checkRunJson(repo, c)) });
    }
    if (method === "GET" && (match = s(/^\/commits\/([^/]+)\/check-suites$/))) {
      const sha = await revParse(repo.dir, decodeURIComponent(match[1]));
      const runs = state.workflowRuns.filter((r) => r.repo === repo.fullName && r.headSha === sha);
      return send(res, 200, {
        total_count: runs.length,
        check_suites: runs.map((r) => ({ id: r.checkSuiteId, head_sha: r.headSha, head_branch: r.headBranch, status: r.status, conclusion: r.conclusion, app: { slug: "github-actions" } })),
      });
    }
    if (method === "GET" && (match = s(/^\/commits\/([^/]+)\/status$/))) {
      const sha = await revParse(repo.dir, decodeURIComponent(match[1]));
      return send(res, 200, { state: "pending", sha, total_count: 0, statuses: [], repository: repoJson(repo) });
    }
    if (method === "GET" && (match = s(/^\/check-runs\/(\d+)$/))) {
      const check = state.checkRuns.find((c) => c.repo === repo.fullName && c.id === Number(match![1]));
      if (!check) throw new HttpError(404, "Not Found");
      return send(res, 200, checkRunJson(repo, check));
    }
    if (method === "GET" && s(/^\/check-runs\/(\d+)\/annotations$/)) return send(res, 200, []);

    // Branches
    if (method === "GET" && sub === "/branches") {
      const branches = await listBranches(repo.dir);
      return send(res, 200, page(Object.entries(branches), url).map(([name, sha]) => ({ name, commit: { sha }, protected: name === PROTECTED_BRANCH })));
    }
    if (method === "GET" && (match = s(/^\/branches\/(.+)$/))) {
      const name = decodeURIComponent(match[1]);
      const info = await commitInfo(repo.dir, `refs/heads/${name}`);
      if (!info) throw new HttpError(404, "Branch not found");
      return send(res, 200, { name, commit: commitJson(repo, info), protected: name === PROTECTED_BRANCH });
    }
    if (method === "GET" && (match = s(/^\/git\/ref\/(.+)$/))) {
      const ref = `refs/${decodeURIComponent(match[1])}`;
      const sha = await revParse(repo.dir, ref);
      if (!sha) throw new HttpError(404, "Not Found");
      return send(res, 200, { ref, object: { sha, type: "commit" } });
    }

    // Actions
    if (method === "GET" && sub === "/actions/workflows") {
      return send(res, 200, {
        total_count: WORKFLOWS.length,
        workflows: WORKFLOWS.map((w) => ({ id: w.id, node_id: `W_${b64(`wf:${w.id}`)}`, name: w.name, path: w.path, state: "active", html_url: `${web}/${repo.fullName}/blob/main/${w.path}`, url: `${api}/repos/${repo.fullName}/actions/workflows/${w.id}` })),
      });
    }
    if (method === "GET" && (match = s(/^\/actions\/workflows\/([^/]+)$/))) {
      const key = decodeURIComponent(match[1]);
      const w = WORKFLOWS.find((x) => String(x.id) === key || x.path.endsWith(`/${key}`) || x.name === key);
      if (!w) throw new HttpError(404, "Not Found");
      return send(res, 200, { id: w.id, node_id: `W_${b64(`wf:${w.id}`)}`, name: w.name, path: w.path, state: "active", html_url: `${web}/${repo.fullName}/blob/main/${w.path}`, url: `${api}/repos/${repo.fullName}/actions/workflows/${w.id}` });
    }
    if (method === "GET" && ((match = s(/^\/actions\/runs$/)) || (match = s(/^\/actions\/workflows\/([^/]+)\/runs$/)))) {
      const wf = match[1] ? WORKFLOWS.find((x) => String(x.id) === match![1] || x.path.endsWith(`/${match![1]}`)) : null;
      const q = url.searchParams;
      const list = state.workflowRuns
        .filter((r) => r.repo === repo.fullName)
        .filter((r) => !wf || r.workflowId === wf.id)
        .filter((r) => !q.get("branch") || r.headBranch === q.get("branch"))
        .filter((r) => !q.get("head_sha") || r.headSha === q.get("head_sha"))
        .filter((r) => !q.get("event") || r.event === q.get("event"))
        .filter((r) => !q.get("status") || r.status === q.get("status") || r.conclusion === q.get("status"))
        .sort((a, b) => b.id - a.id);
      return send(res, 200, { total_count: list.length, workflow_runs: await Promise.all(page(list, url).map((r) => runJson(repo, r))) });
    }
    if (method === "GET" && (match = s(/^\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/))) {
      return send(res, 200, await runJson(repo, runOf(repo, Number(match[1]))));
    }
    if (method === "GET" && (match = s(/^\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/jobs$/))) {
      const run = runOf(repo, Number(match[1]));
      const attempt = match[2] ? Number(match[2]) : null;
      const jobs = attempt === null || attempt === run.runAttempt ? run.jobs : [];
      return send(res, 200, { total_count: jobs.length, jobs: page(jobs, url).map((j) => jobJson(repo, run, j)) });
    }
    if (method === "GET" && (match = s(/^\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/logs$/))) {
      runOf(repo, Number(match[1]));
      // An archive with no entries: `gh` then fetches each job's log from the
      // per-job endpoint, which is the one place a log is kept.
      return send(res, 200, emptyZip(), { "content-type": "application/zip" });
    }
    if (method === "GET" && (match = s(/^\/actions\/runs\/(\d+)\/artifacts$/))) {
      runOf(repo, Number(match[1]));
      return send(res, 200, { total_count: 0, artifacts: [] });
    }
    if (method === "GET" && sub === "/actions/artifacts") return send(res, 200, { total_count: 0, artifacts: [] });
    if (method === "GET" && (match = s(/^\/actions\/jobs\/(\d+)$/))) {
      const { run, job } = jobOf(repo, Number(match[1]));
      return send(res, 200, jobJson(repo, run, job));
    }
    if (method === "GET" && (match = s(/^\/actions\/jobs\/(\d+)\/logs$/))) {
      const { job } = jobOf(repo, Number(match[1]));
      return send(res, 200, job.log);
    }
    if (method === "POST" && (match = s(/^\/actions\/runs\/(\d+)\/(rerun|rerun-failed-jobs)$/))) {
      requireWrite(who);
      const run = runOf(repo, Number(match[1]));
      await rerun(repo, run, match[2] === "rerun-failed-jobs");
      return send(res, 201, {});
    }
    if (method === "POST" && (match = s(/^\/actions\/jobs\/(\d+)\/rerun$/))) {
      requireWrite(who);
      const { run, job } = jobOf(repo, Number(match[1]));
      await rerun(repo, run, false, job);
      return send(res, 201, {});
    }
    if (method === "POST" && (match = s(/^\/actions\/runs\/(\d+)\/cancel$/))) {
      requireWrite(who);
      const run = runOf(repo, Number(match[1]));
      if (run.status === "completed") throw new HttpError(409, "Cannot cancel a workflow run that is completed.");
      cancelRun(run);
      return send(res, 202, {});
    }

    throw new HttpError(404, "Not Found");
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", web);
    const method = req.method ?? "GET";
    try {
      const who = whoIs(tokenFrom(req));
      const gitMatch = /^\/([^/]+\/[^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (gitMatch) {
        if (!who) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"', "content-type": "text/plain" });
          res.end("Authentication required");
          return;
        }
        const repo = findRepo(gitMatch[1]);
        const service = (gitMatch[2] === "info/refs" ? url.searchParams.get("service") : gitMatch[2]) as "git-upload-pack" | "git-receive-pack" | null;
        if (service !== "git-upload-pack" && service !== "git-receive-pack") throw new HttpError(403, "Smart HTTP only");
        const scratch = join(config.dataDir, "scratch");
        await mkdir(scratch, { recursive: true });
        await serveGit({ req, res, repoDir: repo.dir, service, advertise: gitMatch[2] === "info/refs", user: who.login, scratch, record: async (result) => {
        const at = iso();
        for (const r of result.refusals) {
          state.prereceiveRefusals.push({ repo: repo.fullName, ref: r.ref, sha: r.sha, user: r.user, reason: "protected branch", at });
        }
        for (const p of result.pushes) {
          state.pushes.push({ repo: repo.fullName, ref: p.ref, oldSha: p.oldSha, sha: p.sha, user: who.login, at });
          const branch = p.ref.replace(/^refs\/heads\//, "");
          if (!p.ref.startsWith("refs/heads/") || /^0+$/.test(p.sha)) continue;
          for (const pull of pullsOf(repo).filter((x) => x.state === "open" && x.head === branch)) {
            pull.headSha = p.sha;
            pull.baseSha = (await revParse(repo.dir, `refs/heads/${pull.base}`)) ?? pull.baseSha;
            pull.updatedAt = at;
            void track(startCi(repo, p.sha, branch, "pull_request", [pull.number]));
          }
        }
        } });
        return;
      }
      if (url.pathname === "/api/graphql" && method === "POST") {
        if (!who) throw new HttpError(401, "Bad credentials");
        const body = (await readJson(req)) as { query?: string; variables?: Record<string, ArgValue>; operationName?: string };
        return send(res, 200, await graphql(who, body));
      }
      if (url.pathname.startsWith("/api/v3")) return await rest(req, res, url, who);
      throw new HttpError(404, "Not Found");
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        if (err.status === 404 && err.message === "Not Found") {
          state.unhandled.push({ method, path: url.pathname, at: iso() });
        }
        return sendError(res, err);
      }
      process.stderr.write(`[github-standin] ${method} ${url.pathname}: ${(err as Error).stack ?? String(err)}\n`);
      return sendError(res, new HttpError(500, (err as Error).message));
    }
  };

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  /** Waits until nothing an event started is still running. */
  const idle = async (): Promise<void> => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  const reset = async (): Promise<void> => {
    for (const run of state.workflowRuns) if (run.status !== "completed") cancelRun(run);
    await idle();
    await rm(join(config.dataDir, "repos"), { recursive: true, force: true });
    await mkdir(join(config.dataDir, "repos"), { mode: 0o700 });
    state = emptyState({ mode: config.ciMode, verdicts: [], used: 0 });
    appTokens = new Set();
  };

  const control = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://control");
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && url.pathname === "/__control/health") return send(res, 200, { ok: true });
      if (method === "GET" && url.pathname === "/__control/state") return send(res, 200, state);
      if (method === "POST" && url.pathname === "/__control/reset") {
        await reset();
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/__control/seed") {
        const b = await readJson(req);
        if (typeof b.source !== "string") throw new HttpError(422, "source is required");
        return send(res, 200, await seed({
          repo: typeof b.repo === "string" ? b.repo : undefined,
          source: b.source,
          main: typeof b.main === "string" ? b.main : undefined,
          branches: (b.branches ?? undefined) as Record<string, string> | undefined,
        }));
      }
      if (method === "POST" && url.pathname === "/__control/pulls") {
        const b = await readJson(req);
        const repo = findRepo(String(b.repo ?? "thegoodparty/omni"));
        const pull = await createPull(repo, {
          head: String(b.head ?? ""),
          base: typeof b.base === "string" ? b.base : undefined,
          title: String(b.title ?? ""),
          body: typeof b.body === "string" ? b.body : "",
          user: typeof b.user === "string" ? b.user : config.appLogin,
          number: typeof b.number === "number" ? b.number : undefined,
        });
        return send(res, 200, await pullJson(repo, pull));
      }
      if (method === "POST" && url.pathname === "/__control/ci") {
        const b = await readJson(req);
        if (b.mode !== "run" && b.mode !== "scripted") throw new HttpError(422, 'mode must be "run" or "scripted"');
        const verdicts = Array.isArray(b.verdicts) ? (b.verdicts as ScriptedVerdict[]) : [];
        for (const v of verdicts) {
          if (v.conclusion !== "success" && v.conclusion !== "failure") throw new HttpError(422, "each verdict needs conclusion success or failure");
        }
        state.ci = { mode: b.mode, verdicts, used: 0 };
        return send(res, 200, state.ci);
      }
      if (method === "POST" && url.pathname === "/__control/idle") {
        await idle();
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, "Not Found");
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err);
      return sendError(res, new HttpError(500, (err as Error).message));
    }
  };

  return {
    handle,
    control,
    seed,
    idle,
    reset,
    state: (): State => state,
    close: async (): Promise<void> => {
      for (const run of state.workflowRuns) if (run.status !== "completed") cancelRun(run);
      await idle();
    },
  };
};

export type GitHubStandin = ReturnType<typeof createGitHubStandin>;
