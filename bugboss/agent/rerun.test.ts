import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_RERUNS_PER_INCIDENT,
  RERUN_SUSPICION_LIMIT,
  createGitHubRunsPort,
  createRerunCiTool,
  githubMessage,
  githubRefusalText,
  rerunNotice,
  runRerunFailedJobs,
  type GitHubResult,
  type GitHubRunsPort,
  type WorkflowRunView,
} from "./rerun";
import { THREAD_PROSE_CHARS } from "../slack/format";

const aRun = (overrides: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
  id: 42,
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
  name: "E2E",
  html_url: "https://github.com/thegoodparty/omni/actions/runs/42",
  ...overrides,
});

interface Harness {
  github: GitHubRunsPort;
  thread: { post: (message: string) => Promise<void> };
  attempted: Set<string>;
  posts: string[];
  reruns: string[];
}

const harness = (options: {
  run?: WorkflowRunView;
  getRun?: GitHubResult<WorkflowRunView>;
  rerun?: GitHubResult<null>;
  postFails?: string;
} = {}): Harness => {
  const posts: string[] = [];
  const reruns: string[] = [];
  return {
    posts,
    reruns,
    attempted: new Set<string>(),
    github: {
      getRun: async () =>
        options.getRun ?? { ok: true, data: options.run ?? aRun() },
      rerunFailedJobs: async (repo, runId) => {
        reruns.push(`${repo}#${runId}`);
        return options.rerun ?? { ok: true, data: null };
      },
    },
    thread: {
      post: async (message: string) => {
        if (options.postFails) throw new Error(options.postFails);
        posts.push(message);
      },
    },
  };
};

const args = {
  repo: "thegoodparty/omni",
  runId: 42,
  suspicion: "The two E2E failures are preview-environment timeouts, not my change.",
};

test("a first re-run reaches GitHub and tells the thread why", async () => {
  const h = harness();

  const result = await runRerunFailedJobs(args, h);

  assert.equal(result.started, true);
  assert.equal(result.refused, null);
  assert.equal(result.error, null);
  assert.equal(result.postError, null);
  assert.deepEqual(h.reruns, ["thegoodparty/omni#42"]);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0], /preview-environment timeouts/);
  assert.match(h.posts[0], /report it as a real failure/);
  assert.deepEqual([...h.attempted], ["thegoodparty/omni#42"]);
});

test("a run already on attempt 2 is refused as a finding, not re-run again", async () => {
  const h = harness({ run: aRun({ run_attempt: 2 }) });

  const result = await runRerunFailedJobs(args, h);

  assert.equal(result.started, false);
  assert.deepEqual(h.reruns, []);
  assert.deepEqual(h.posts, []);
  assert.match(result.refused ?? "", /already on attempt 2/);
  assert.match(result.refused ?? "", /finding, not a flake/);
  assert.match(result.refused ?? "", /empty commit/);
});

test("the attempt bound survives a replay, because it is read from GitHub", async () => {
  // A restarted agent replays the recorded call. GitHub has already bumped the
  // attempt, so the second execution refuses rather than re-running twice —
  // with no state of ours involved.
  const attempt = { value: 1 };
  const reruns: string[] = [];
  const deps = {
    attempted: new Set<string>(),
    thread: { post: async () => {} },
    github: {
      getRun: async (): Promise<GitHubResult<WorkflowRunView>> => ({
        ok: true,
        data: aRun({ run_attempt: attempt.value }),
      }),
      rerunFailedJobs: async (repo: string, runId: number): Promise<GitHubResult<null>> => {
        reruns.push(`${repo}#${runId}`);
        attempt.value += 1;
        return { ok: true, data: null };
      },
    },
  };

  await runRerunFailedJobs(args, deps);
  const replay = await runRerunFailedJobs(args, { ...deps, attempted: new Set<string>() });

  assert.equal(reruns.length, 1);
  assert.equal(replay.started, false);
  assert.match(replay.refused ?? "", /already on attempt 2/);
});

test("the incident budget refuses a fourth distinct run", async () => {
  const h = harness();
  for (let i = 0; i < MAX_RERUNS_PER_INCIDENT; i += 1) {
    const result = await runRerunFailedJobs({ ...args, runId: 100 + i }, h);
    assert.equal(result.started, true);
  }

  const result = await runRerunFailedJobs({ ...args, runId: 999 }, h);

  assert.equal(result.started, false);
  assert.equal(h.reruns.length, MAX_RERUNS_PER_INCIDENT);
  assert.match(result.refused ?? "", /grinding a pull request to green/);
});

test("a retry of a run already in the ledger does not cost a second budget slot", async () => {
  const h = harness();
  h.attempted.add("thegoodparty/omni#42");
  h.attempted.add("thegoodparty/omni#43");
  h.attempted.add("thegoodparty/omni#44");

  const result = await runRerunFailedJobs(args, h);

  // Full budget, but this run is one of the three, so the budget does not
  // answer — `run_attempt` does, and here the fake still reports attempt 1.
  assert.equal(result.started, true);
  assert.deepEqual(h.reruns, ["thegoodparty/omni#42"]);
});

test("a missing permission is named, not reported as a generic failure", async () => {
  const h = harness({
    rerun: {
      ok: false,
      status: 403,
      message: "Resource not accessible by integration",
      acceptedPermissions: "actions=write",
    },
  });

  const result = await runRerunFailedJobs(args, h);

  assert.equal(result.started, false);
  assert.equal(result.refused, null);
  assert.match(result.error ?? "", /Resource not accessible by integration/);
  assert.match(result.error ?? "", /This is a permission/);
  assert.match(result.error ?? "", /actions=write/);
  assert.match(result.error ?? "", /rerun-failed-jobs/);
  assert.match(result.error ?? "", /contact_human/);
  assert.deepEqual(h.posts, []);
});

test("nothing is announced when GitHub refuses, so the thread never sees a re-run that did not happen", async () => {
  const h = harness({
    rerun: { ok: false, status: 403, message: "nope", acceptedPermissions: "actions=write" },
  });

  await runRerunFailedJobs(args, h);

  assert.deepEqual(h.posts, []);
  assert.deepEqual([...h.attempted], []);
});

test("a re-run whose announcement fails says so and hands back the text", async () => {
  const h = harness({ postFails: "slack 503" });

  const result = await runRerunFailedJobs(args, h);

  assert.equal(result.started, true);
  assert.match(result.postError ?? "", /slack 503/);
  assert.match(result.notice, /preview-environment timeouts/);
});

test("a run that has not finished is not a flake yet", async () => {
  const h = harness({ run: aRun({ status: "in_progress", conclusion: null }) });

  const result = await runRerunFailedJobs(args, h);

  assert.equal(result.started, false);
  assert.match(result.refused ?? "", /in_progress/);
  assert.match(result.refused ?? "", /monitor/);
});

test("a run waiting on approval is not re-runnable and says which button is", async () => {
  // All three shapes GitHub uses, and none of them should send the agent into
  // a monitor waiting for a run that is not going to move on its own.
  const parked: Array<Partial<WorkflowRunView>> = [
    { conclusion: "action_required" },
    { status: "action_required", conclusion: null },
    { status: "waiting", conclusion: null },
  ];

  for (const shape of parked) {
    const h = harness({ run: aRun(shape) });
    const result = await runRerunFailedJobs(args, h);

    assert.equal(result.started, false, JSON.stringify(shape));
    assert.match(result.refused ?? "", /waiting on a human to approve/);
    assert.match(result.refused ?? "", /fork pull request/);
    assert.doesNotMatch(result.refused ?? "", /Wait for it with monitor/);
    assert.deepEqual(h.reruns, []);
  }
});

test("a run that succeeded or was cancelled has no failed jobs to re-run", async () => {
  for (const conclusion of ["success", "cancelled", "skipped"]) {
    const h = harness({ run: aRun({ conclusion }) });
    const result = await runRerunFailedJobs(args, h);
    assert.equal(result.started, false, conclusion);
    assert.match(result.refused ?? "", /no failed jobs to re-run/);
  }
});

test("a timed_out run is re-runnable", async () => {
  const h = harness({ run: aRun({ conclusion: "timed_out" }) });

  const result = await runRerunFailedJobs(args, h);

  assert.equal(result.started, true);
});

test("an unreadable run is reported with GitHub's own words", async () => {
  const h = harness({
    getRun: { ok: false, status: 404, message: "Not Found", acceptedPermissions: null },
  });

  const result = await runRerunFailedJobs(args, h);

  assert.equal(result.started, false);
  assert.match(result.error ?? "", /404/);
  assert.match(result.error ?? "", /cannot see\s+thegoodparty\/omni/);
  assert.deepEqual(h.reruns, []);
});

test("a suspicion is required, because an unexplained re-run cannot be disagreed with", async () => {
  const h = harness();

  const result = await runRerunFailedJobs({ ...args, suspicion: "   " }, h);

  assert.equal(result.started, false);
  assert.match(result.refused ?? "", /suspicion is required/);
  assert.deepEqual(h.reruns, []);
});

test("an over-long suspicion is refused rather than truncated", async () => {
  const h = harness();

  const result = await runRerunFailedJobs(
    { ...args, suspicion: "x".repeat(RERUN_SUSPICION_LIMIT + 1) },
    h,
  );

  assert.equal(result.started, false);
  assert.match(result.refused ?? "", new RegExp(`limit is ${RERUN_SUSPICION_LIMIT}`));
});

test("a repo that is not owner/name never reaches a url", async () => {
  const h = harness();

  for (const repo of ["omni", "../../orgs/evil", "thegoodparty/omni/extra", ""]) {
    const result = await runRerunFailedJobs({ ...args, repo }, h);
    assert.equal(result.started, false, repo);
    assert.match(result.refused ?? "", /owner\/name repository/);
  }
});

test("a run id that is not a positive integer is refused", async () => {
  const h = harness();

  for (const runId of [0, -1, 1.5, Number.NaN]) {
    const result = await runRerunFailedJobs({ ...args, runId }, h);
    assert.equal(result.started, false, String(runId));
    assert.match(result.refused ?? "", /not a workflow run id/);
  }
});

test("the notice carries the run link so the thread can check it", () => {
  const notice = rerunNotice("thegoodparty/omni", aRun(), "flaky preview");

  assert.match(notice, /<https:\/\/github\.com\/thegoodparty\/omni\/actions\/runs\/42\|E2E>/);
  assert.match(notice, /flaky preview/);
});

test("githubMessage prefers GitHub's message and falls back to the body", () => {
  assert.equal(githubMessage(403, JSON.stringify({ message: "Resource not accessible" })), "Resource not accessible");
  assert.equal(githubMessage(502, "<html>bad gateway</html>"), "<html>bad gateway</html>");
  assert.equal(githubMessage(500, ""), "HTTP 500");
});

test("a 403 GitHub did not blame on a permission is not blamed on one here", () => {
  // The attested bodies for this endpoint — a run still going, a run over a
  // month old — arrive as a 403 with no X-Accepted-GitHub-Permissions header.
  // Calling those a permission problem would send the agent to ask for a grant
  // that changes nothing.
  const text = githubRefusalText(
    "thegoodparty/omni",
    42,
    403,
    "Unable to retry this workflow run because it was created over a month ago",
    null,
  );

  assert.match(text, /created over a month ago/);
  assert.match(text, /did not say a permission was missing/);
  assert.doesNotMatch(text, /actions: read/);
  assert.doesNotMatch(text, /contact_human/);
});

test("GitHub's own answer to what was needed is what the agent is told to ask for", () => {
  const text = githubRefusalText(
    "thegoodparty/omni",
    42,
    403,
    "Resource not accessible by integration",
    "actions=write",
  );

  assert.match(text, /This is a permission/);
  assert.match(text, /actions=write/);
  assert.match(text, /rerun-failed-jobs/);
  assert.match(text, /contact_human/);
});

test("a 404 names the installation as a candidate, because GitHub masks it as one", () => {
  const text = githubRefusalText("thegoodparty/omni", 42, 404, "Not Found", null);

  assert.match(text, /404 rather than 403/);
  assert.match(text, /aged out/);
  assert.match(text, /databaseId/);
});

test("the port says plainly when there is no token at all", async () => {
  const port = createGitHubRunsPort({
    token: () => undefined,
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });

  const result = await port.getRun("thegoodparty/omni", 42);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /no GitHub token in this container/);
});

test("the port calls the documented endpoints with the current token", async () => {
  const calls: Array<{ url: string; method: string; auth: string }> = [];
  let token = "first";
  const port = createGitHubRunsPort({
    token: () => token,
    fetchImpl: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        auth: headers.authorization,
      });
      return new Response(JSON.stringify(aRun()), { status: 200 });
    },
  });

  await port.getRun("thegoodparty/omni", 42);
  token = "second";
  await port.rerunFailedJobs("thegoodparty/omni", 42);

  assert.deepEqual(calls, [
    {
      url: "https://api.github.com/repos/thegoodparty/omni/actions/runs/42",
      method: "GET",
      auth: "Bearer first",
    },
    {
      url: "https://api.github.com/repos/thegoodparty/omni/actions/runs/42/rerun-failed-jobs",
      method: "POST",
      auth: "Bearer second",
    },
  ]);
});

type Tool = Awaited<ReturnType<typeof createRerunCiTool>>;

/** The four trailing arguments Pi passes and this tool ignores. */
const call = async (tool: Tool, params: object): Promise<string> => {
  const result = await tool.execute("call-1", params as never, undefined, undefined, {} as never);
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
};

test("the tool keeps one budget ledger for the life of the process", async () => {
  const h = harness();
  const tool = await createRerunCiTool({ github: h.github, thread: h.thread });

  for (let i = 0; i < MAX_RERUNS_PER_INCIDENT; i += 1) {
    await call(tool, { ...args, runId: 200 + i });
  }
  const refused = await call(tool, { ...args, runId: 500 });

  assert.equal(h.reruns.length, MAX_RERUNS_PER_INCIDENT);
  assert.match(refused, /Nothing was re-run/);
  assert.match(refused, /grinding a pull request to green/);
});

test("the tool result for a 403 reaches the model with the permission named", async () => {
  const h = harness({
    rerun: {
      ok: false,
      status: 403,
      message: "Resource not accessible by integration",
      acceptedPermissions: "actions=write",
    },
  });
  const tool = await createRerunCiTool({ github: h.github, thread: h.thread });

  const text = await call(tool, args);

  assert.match(text, /Nothing was re-run/);
  assert.match(text, /actions=write/);
  assert.match(text, /Do not quietly work around this/);
});

test("a successful tool call tells the model the flake is still a defect", async () => {
  const h = harness();
  const tool = await createRerunCiTool({ github: h.github, thread: h.thread });

  const text = await call(tool, args);

  assert.match(text, /one attempt you get on this run/);
  assert.match(text, /the flake is still a defect/);
  assert.match(text, /monitor/);
});

test("a tool call whose announcement fails hands the model the text to post", async () => {
  const h = harness({ postFails: "slack 503" });
  const tool = await createRerunCiTool({ github: h.github, thread: h.thread });

  const text = await call(tool, args);

  assert.match(text, /The thread was NOT told/);
  assert.match(text, /slack 503/);
  assert.match(text, /Post this yourself now/);
});

test("a thrown fetch becomes a result the model can act on, not a stack", async () => {
  const port = createGitHubRunsPort({
    token: () => "t",
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });

  const result = await port.rerunFailedJobs("thegoodparty/omni", 42);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 0);
  assert.match(result.message, /ECONNRESET/);
  assert.match(result.message, /rerun-failed-jobs/);
});

test("a body that is not JSON on a 200 is a refusal, not a crash", async () => {
  const port = createGitHubRunsPort({
    token: () => "t",
    fetchImpl: async () => new Response("<html>hi</html>", { status: 200 }),
  });

  const result = await port.getRun("thegoodparty/omni", 42);

  assert.equal(result.ok, false);
});

test("a workflow name cannot break out of the link it is the label for", () => {
  const notice = rerunNotice(
    "thegoodparty/omni",
    aRun({ name: "E2E <prod> | nightly" }),
    "flaky",
  );

  assert.match(notice, /\|E2E prod nightly>/);
  assert.equal(notice.split("<").length, 2, "exactly one entity opens");
  assert.equal(notice.split(">").length, 2, "and exactly one closes it");
});

test("the notice fits a thread post even at its worst", () => {
  // The notice goes out through the thread, which refuses a post past
  // THREAD_PROSE_CHARS. The suspicion has its own limit, so the only other
  // thing here that can run long is a name GitHub handed us -- and before it
  // was clamped, a 200-character workflow name plus a maximal suspicion came
  // to 1,205 against a budget of 1,200. That would have been a rerun_ci that
  // fails on a workflow with a verbose name, which is nobody's idea of a
  // reason.
  const notice = rerunNotice(
    "thegoodparty/omni",
    aRun({ name: "nightly end to end suite ".repeat(12) }),
    "s".repeat(RERUN_SUSPICION_LIMIT),
  );

  assert.ok(
    notice.length <= THREAD_PROSE_CHARS,
    `${notice.length} characters against a budget of ${THREAD_PROSE_CHARS}`,
  );
  assert.match(notice, /…\|?>/, "the name is clamped where it ran long");
});

test("a workflow name short enough to read is left alone", () => {
  const notice = rerunNotice("thegoodparty/omni", aRun({ name: "E2E" }), "flaky");

  assert.match(notice, /\|E2E>/);
  assert.doesNotMatch(notice, /…/);
});
