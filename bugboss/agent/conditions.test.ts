import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  conditionKey,
  conditionProblem,
  createGitHubReadPort,
  DELEGATE_STATE_MARKER,
  parsePr,
  REVIEW_SETTLE_SECONDS,
  type GitHubReadPort,
} from "./conditions";
import type { GitHubResult } from "./rerun";
import {
  createMonitorTool,
  createWaitInterrupt,
  pollingGuardExtension,
  pollingRefusal,
  runMonitor,
  type HeartbeatDeps,
  type PendingWait,
} from "./tools";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const OMNI = "thegoodparty/omni";

const fakeClock = () => {
  let now = Date.parse("2026-09-30T18:00:00Z");
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
};

interface Run {
  id: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_attempt: number;
}

/**
 * GitHub as the typed conditions read it. `onRead` runs before each read and
 * is where a test moves the world forward, so "fires on the right event and
 * not before" is a count of reads.
 */
const fakeGitHub = (onCheck: (check: number) => void = () => {}) => {
  const world = {
    pull: {
      state: "open",
      merged: false,
      merged_at: null as string | null,
      closed_at: null as string | null,
      merge_commit_sha: null as string | null,
      merged_by: null as { login: string } | null,
      head: { sha: HEAD },
      html_url: "https://github.com/thegoodparty/omni/pull/2262",
    },
    checks: [] as Record<string, unknown>[],
    reviews: [] as Record<string, unknown>[],
    inline: new Map<number, Record<string, unknown>[]>(),
    comments: [] as Record<string, unknown>[],
    runs: [] as Run[],
    jobs: new Map<number, Record<string, unknown>[]>(),
  };
  let checks = 0;
  const paths: string[] = [];
  const ok = <T>(data: unknown): GitHubResult<T> => ({ ok: true, data: data as T });
  const port: GitHubReadPort = {
    get: async <T>(path: string) => {
      paths.push(path);
      if (path.endsWith("/pulls/2262")) {
        checks += 1;
        onCheck(checks);
        return ok<T>(world.pull);
      }
      if (path.includes("/commits/")) return ok<T>({ sha: MERGE });
      return { ok: false, status: 404, message: "Not Found", acceptedPermissions: null };
    },
    getAll: async <T>(path: string) => {
      paths.push(path);
      if (path.includes("/actions/runs?")) {
        checks += 1;
        onCheck(checks);
        return ok<T[]>(world.runs);
      }
      const jobs = /\/actions\/runs\/(\d+)\/jobs/.exec(path);
      if (jobs) return ok<T[]>(world.jobs.get(Number(jobs[1])) ?? []);
      const inline = /\/reviews\/(\d+)\/comments/.exec(path);
      if (inline) return ok<T[]>(world.inline.get(Number(inline[1])) ?? []);
      if (path.includes("/reviews")) return ok<T[]>(world.reviews);
      if (path.includes("/comments")) {
        const since = Date.parse(new URL(`https://x${path}`).searchParams.get("since") ?? "");
        return ok<T[]>(world.comments.filter((c) => Date.parse(String(c.updated_at)) >= since));
      }
      return { ok: false, status: 404, message: "Not Found", acceptedPermissions: null };
    },
    graphql: async <T>() => {
      checks += 1;
      onCheck(checks);
      return ok<T>({
        repository: {
          pullRequest: {
            headRefOid: world.pull.head.sha,
            state: world.pull.state === "closed" ? (world.pull.merged ? "MERGED" : "CLOSED") : "OPEN",
            commits: {
              nodes: [
                {
                  commit: {
                    oid: world.pull.head.sha,
                    statusCheckRollup: {
                      contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: world.checks },
                    },
                  },
                },
              ],
            },
          },
        },
      });
    },
  };
  return { port, world, checks: () => checks, paths };
};

const checkRun = (name: string, status: string, conclusion: string | null) => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/thegoodparty/omni/actions/runs/1/job/${name}`,
  checkSuite: { workflowRun: { workflow: { name: "gp-api" } } },
});

const iso = (ms: number): string => new Date(ms).toISOString();

const base = {
  intervalSeconds: 60,
  timeoutSeconds: 3000,
  description: "the wait",
  waitingFor: "the wait",
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test("a PR is named by URL, owner/repo#n or repo#n", () => {
  assert.deepEqual(parsePr("https://github.com/thegoodparty/omni/pull/2262"), { repo: OMNI, number: 2262, label: "omni#2262" });
  assert.deepEqual(parsePr("thegoodparty/omni#2262"), { repo: OMNI, number: 2262, label: "omni#2262" });
  assert.deepEqual(parsePr("omni#2262"), { repo: OMNI, number: 2262, label: "omni#2262" });
  assert.equal(parsePr("2262"), null);
});

test("a typed condition missing what it watches is refused before any wait", async () => {
  assert.match(conditionProblem({ condition: "pr_checks" }) ?? "", /needs `pr`/);
  assert.match(conditionProblem({ condition: "workflow_run", repo: "omni" }) ?? "", /needs `sha`/);
  assert.match(conditionProblem({ condition: "pr_review", pr: "omni#1", since: "yesterday" }) ?? "", /ISO time/);
  assert.match(conditionProblem({}) ?? "", /needs `command`/);
  assert.equal(conditionProblem({ condition: "pr_closed", pr: "omni#1" }), null);

  const github = fakeGitHub();
  const tool = await createMonitorTool({ github: github.port });
  const out = (await tool.execute("c1", { ...base, condition: "pr_checks" } as never, undefined, undefined, {} as never)) as {
    content: { text: string }[];
  };
  assert.match(out.content[0].text, /^Rejected, nothing was waited for/);
  assert.equal(github.paths.length, 0);
});

test("a command wait with no condition is keyed on its command, as before", () => {
  assert.equal(conditionKey({ command: "gh pr view 1" }), "gh pr view 1");
  assert.equal(conditionKey({ condition: "pr_closed", pr: "https://github.com/thegoodparty/omni/pull/2262" }), "pr_closed omni#2262");
});

// ---------------------------------------------------------------------------
// pr_checks
// ---------------------------------------------------------------------------

test("pr_checks waits while checks run and fires when the last one passes", async () => {
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    if (check === 1) github.world.checks = [];
    if (check === 2) github.world.checks = [checkRun("Test", "IN_PROGRESS", null), checkRun("Lint", "COMPLETED", "SUCCESS")];
    if (check === 4) github.world.checks = [checkRun("Test", "COMPLETED", "SUCCESS"), checkRun("Lint", "COMPLETED", "SUCCESS")];
  });

  const result = await runMonitor(
    { ...base, condition: "pr_checks", pr: "omni#2262" },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(github.checks(), 4, "not before the last check finished, and not after");
  assert.equal(result.timedOut, false);
  assert.match(result.output, /^RESULT: ALL PASSED\./);
  assert.match(result.output, /0 failed, 0 pending, 0 cancelled, 2 passed/);
});

test("pr_checks ends on the first failure, without waiting for the rest", async () => {
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    github.world.checks =
      check < 3
        ? [checkRun("Test (shard 1)", "IN_PROGRESS", null), checkRun("E2E", "QUEUED", null)]
        : [checkRun("Test (shard 1)", "COMPLETED", "FAILURE"), checkRun("E2E", "IN_PROGRESS", null)];
  });

  const result = await runMonitor(
    { ...base, condition: "pr_checks", pr: "omni#2262" },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(github.checks(), 3);
  assert.match(result.output, /^RESULT: FAILED\./);
  assert.match(result.output, /- failed: gp-api \/ Test \(shard 1\) https:\/\/github\.com\/.+\/job\/Test \(shard 1\)/);
  assert.match(result.output, /- pending: gp-api \/ E2E/);
});

// ---------------------------------------------------------------------------
// pr_review
// ---------------------------------------------------------------------------

const review = (id: number, state: string, at: number, body: string, commit = HEAD) => ({
  id,
  user: { login: "delegate-reviewer[bot]" },
  state,
  submitted_at: iso(at).replace(/\.\d{3}Z$/, "Z"),
  commit_id: commit,
  body,
  html_url: `https://github.com/thegoodparty/omni/pull/2262#pullrequestreview-${id}`,
});

test("a delegate COMMENTED review minutes after an APPROVED one is reported, last", async () => {
  const clock = fakeClock();
  const started = clock.now();
  const github = fakeGitHub((check) => {
    if (check === 1) github.world.reviews = [review(1, "APPROVED", started - 3_600_000, "old approval")];
    if (check === 3) github.world.reviews.push(review(2, "APPROVED", clock.now() - 1000, "**Recommendation: approve**"));
    if (check === 6) {
      github.world.reviews.push(review(3, "COMMENTED", clock.now() - 1000, "**Recommendation: request changes**"));
      github.world.inline.set(3, [{ path: "packages/gp-api/src/x.ts", line: 42, original_line: 42, body: "This drops the retry." }]);
    }
  });

  const result = await runMonitor(
    { ...base, condition: "pr_review", pr: "omni#2262", reviewer: "delegate-reviewer" },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.timedOut, false);
  assert.ok(clock.now() - started >= (2 + REVIEW_SETTLE_SECONDS / 60) * 60_000, "it kept watching after the approval");
  assert.doesNotMatch(result.output, /old approval/, "a review from before the wait is not news");
  const approved = result.output.indexOf("REVIEW APPROVED");
  const commented = result.output.indexOf("REVIEW COMMENTED");
  assert.ok(approved > 0 && commented > approved, "both, oldest first, so the last one stands");
  assert.match(result.output, /Recommendation: request changes/);
  assert.match(result.output, /Inline on packages\/gp-api\/src\/x\.ts:42:\nThis drops the retry\./);
  assert.match(result.output, /on the current head/);
});

test("pr_review does not fire on an old review, and fires on the delegate state comment", async () => {
  const clock = fakeClock();
  const started = clock.now();
  const github = fakeGitHub((check) => {
    if (check === 1) {
      github.world.reviews = [review(1, "COMMENTED", started - 60_000, "before")];
      github.world.comments = [{ id: 9, user: { login: "delegate-reviewer[bot]" }, body: `${DELEGATE_STATE_MARKER}\nold`, updated_at: iso(started - 60_000), html_url: "u" }];
    }
    if (check === 4) {
      github.world.comments = [{ id: 9, user: { login: "delegate-reviewer[bot]" }, body: `${DELEGATE_STATE_MARKER}\n\nInline comments could not be posted. Findings below.`, updated_at: iso(clock.now()), html_url: "u" }];
    }
  });

  const result = await runMonitor(
    { ...base, condition: "pr_review", pr: "omni#2262" },
    { github: github.port, sleep: clock.sleep, now: clock.now, settleSeconds: 0 },
  );

  assert.equal(github.checks(), 4);
  assert.match(result.output, /REVIEWER STATE COMMENT by delegate-reviewer\[bot\]/);
  assert.match(result.output, /Findings below/);
  assert.doesNotMatch(result.output, /before/);
});

test("a review wait capped mid-settle ends as met, not timed out", async () => {
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    if (check === 2) github.world.reviews = [review(1, "APPROVED", clock.now() - 1000, "ok")];
  });

  const result = await runMonitor(
    { ...base, timeoutSeconds: 180, condition: "pr_review", pr: "omni#2262" },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.timedOut, false);
  assert.match(result.output, /REVIEW APPROVED/);
});

// ---------------------------------------------------------------------------
// pr_closed
// ---------------------------------------------------------------------------

test("pr_closed fires on the merge and hands over the merge commit", async () => {
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    if (check === 3) {
      Object.assign(github.world.pull, {
        state: "closed",
        merged: true,
        merged_at: "2026-09-30T18:03:00Z",
        merge_commit_sha: MERGE,
        merged_by: { login: "swain" },
      });
    }
  });

  const result = await runMonitor(
    { ...base, condition: "pr_closed", pr: "omni#2262" },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(github.checks(), 3);
  assert.match(result.output, /omni#2262 was MERGED at 2026-09-30T18:03:00Z by swain\./);
  assert.match(result.output, new RegExp(`Merge commit: ${MERGE}`));
  assert.match(result.output, /workflow_run/);
});

test("a person-wait on a merge ends with one Boss message saying it is done, and the marker gone", async () => {
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    if (check === 2) Object.assign(github.world.pull, { state: "closed", merged: true, merged_at: "t", merge_commit_sha: MERGE });
  });
  const told: { kind: string; text: string }[] = [];
  let marker: PendingWait | null = null;
  const heartbeat: HeartbeatDeps = {
    marker: {
      recordWait: async (command) => (marker = { command, startedAt: clock.now(), pings: 0, lastPingAt: null }),
      recordPing: async () => marker as PendingWait,
      clearWait: async () => {
        marker = null;
      },
    },
    boss: { tellBoss: async (kind, text) => void told.push({ kind, text }), escalationsSince: async () => ({ count: 0, lastAt: null }) },
  };

  await runMonitor(
    { ...base, condition: "pr_closed", pr: "omni#2262", waitingFor: "someone to merge omni#2262", awaitingHuman: "Merge omni#2262" },
    { github: github.port, sleep: clock.sleep, now: clock.now, heartbeat },
  );

  assert.equal(told.length, 1);
  assert.equal(told[0].kind, "message");
  assert.match(told[0].text, /^Done: someone to merge omni#2262\./);
  assert.match(told[0].text, /was MERGED/);
  assert.equal(marker, null, "the pending wait is gone");
});

test("a command person-wait gets the same close", async () => {
  const clock = fakeClock();
  const told: string[] = [];
  let cleared = false;
  await runMonitor(
    { ...base, command: "gh pr view 2262 --json state | grep -qE 'MERGED|CLOSED'", awaitingHuman: "Merge it" },
    {
      probe: async () => ({ code: 0, output: "" }),
      sleep: clock.sleep,
      now: clock.now,
      heartbeat: {
        marker: {
          recordWait: async (command) => ({ command, startedAt: clock.now(), pings: 0, lastPingAt: null }),
          recordPing: async () => assert.fail("no reminder is due"),
          clearWait: async () => {
            cleared = true;
          },
        },
        boss: { tellBoss: async (_kind, text) => void told.push(text), escalationsSince: async () => ({ count: 0, lastAt: null }) },
      },
    },
  );
  assert.equal(told.length, 1);
  assert.match(told[0], /^Done: the wait\./);
  assert.equal(cleared, true);
});

test("a wait with nobody asked tells the Boss nothing when it ends", async () => {
  const clock = fakeClock();
  const github = fakeGitHub(() => Object.assign(github.world.pull, { state: "closed", merged: true }));
  let told = 0;
  await runMonitor(
    { ...base, condition: "pr_closed", pr: "omni#2262" },
    {
      github: github.port,
      sleep: clock.sleep,
      now: clock.now,
      heartbeat: {
        marker: { recordWait: async () => assert.fail("no marker"), recordPing: async () => assert.fail(), clearWait: async () => {} },
        boss: { tellBoss: async () => void (told += 1), escalationsSince: async () => ({ count: 0, lastAt: null }) },
      },
    },
  );
  assert.equal(told, 0);
});

// ---------------------------------------------------------------------------
// workflow_run
// ---------------------------------------------------------------------------

const run = (id: number, name: string, event: string, status: string, conclusion: string | null): Run => ({
  id,
  name,
  path: `.github/workflows/${name}.yml`,
  event,
  status,
  conclusion,
  html_url: `https://github.com/thegoodparty/omni/actions/runs/${id}`,
  run_attempt: 1,
});

test("a failed release run ends a deploy wait at the failure, not at the timeout", async () => {
  const clock = fakeClock();
  const started = clock.now();
  const github = fakeGitHub((check) => {
    if (check === 1) github.world.runs = [];
    if (check === 2) github.world.runs = [run(10, "release", "push", "in_progress", null)];
    if (check === 5) {
      github.world.runs = [run(10, "release", "push", "completed", "failure")];
      github.world.jobs.set(10, [
        { name: "Deploy gp-api (prod)", conclusion: "failure", html_url: "https://job/1", steps: [{ name: "Push image to ECR", conclusion: "failure" }] },
        { name: "Deploy gp-webapp (prod)", conclusion: "success", html_url: "https://job/2", steps: [] },
      ]);
    }
  });

  const result = await runMonitor(
    { ...base, timeoutSeconds: 7200, intervalSeconds: 30, condition: "workflow_run", repo: "omni", sha: MERGE, workflow: "release" },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(github.checks(), 5);
  assert.equal(clock.now() - started, 4 * 30_000, "two minutes, where incident 80 watched prod for 1h51m");
  assert.equal(result.timedOut, false);
  assert.match(result.output, /^RESULT: FAILED\./);
  assert.match(result.output, /- release \/ Deploy gp-api \(prod\): failure, at step Push image to ECR https:\/\/job\/1/);
  assert.doesNotMatch(result.output, /gp-webapp/);
});

test("the prompt's old deploy check watches the same failed run to its timeout", async () => {
  // What the change replaces: `gh run list ... | grep -q success` exits 0
  // only on success, so a failure is indistinguishable from still running.
  const clock = fakeClock();
  const started = clock.now();
  const result = await runMonitor(
    { ...base, timeoutSeconds: 3000, intervalSeconds: 30, command: "gh run list --commit <sha> --json conclusion -q '.[0].conclusion' | grep -q success" },
    { probe: async () => ({ code: 1, output: "" }), sleep: clock.sleep, now: clock.now },
  );
  assert.equal(result.timedOut, true);
  assert.equal(clock.now() - started, 3000 * 1000);
});

test("cancelled workflow_run and schedule runs on the same commit are not its answer", async () => {
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    github.world.runs = [
      run(1, "gpbot-ci-drive", "workflow_run", "completed", "cancelled"),
      run(2, "gpbot-sweep", "schedule", "completed", "failure"),
      run(3, "gp-api", "push", "completed", "success"),
      run(4, "release", "push", check < 3 ? "in_progress" : "completed", check < 3 ? null : "success"),
    ];
  });

  const result = await runMonitor(
    { ...base, condition: "workflow_run", repo: OMNI, sha: MERGE },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(github.checks(), 3);
  assert.match(result.output, /^RESULT: SUCCEEDED\./);
  assert.doesNotMatch(result.output, /gpbot/);
});

test("a short sha is resolved once, so the run is found", async () => {
  const clock = fakeClock();
  const github = fakeGitHub(() => {
    github.world.runs = [run(4, "release", "push", "completed", "success")];
  });
  const result = await runMonitor(
    { ...base, condition: "workflow_run", repo: OMNI, sha: MERGE.slice(0, 9), workflow: "release.yml" },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );
  assert.match(result.output, /^RESULT: SUCCEEDED/);
  assert.ok(github.paths.some((path) => path.includes(`head_sha=${MERGE}`)));
});

test("a PR GitHub says does not exist ends the wait at once and says why", async () => {
  const clock = fakeClock();
  const port: GitHubReadPort = {
    get: async () => ({ ok: false, status: 404, message: "Not Found", acceptedPermissions: null }),
    getAll: async () => ({ ok: true, data: [] }),
    graphql: async () => ({ ok: true, data: {} as never }),
  };
  const result = await runMonitor(
    { ...base, condition: "pr_closed", pr: "omni#99999" },
    { github: port, sleep: clock.sleep, now: clock.now },
  );
  assert.match(result.output, /^COULD NOT READ omni#99999: Not Found \(HTTP 404\)/);
});

// ---------------------------------------------------------------------------
// The read port
// ---------------------------------------------------------------------------

test("the read port follows every page and never sends a token it does not have", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    const page = url.includes("page=2") ? 2 : 1;
    return new Response(JSON.stringify({ workflow_runs: [{ id: page }] }), {
      status: 200,
      headers: page === 1 ? { link: '<https://api.github.com/x?page=2>; rel="next"' } : {},
    });
  }) as typeof fetch;
  const port = createGitHubReadPort({ token: () => "t", fetchImpl });
  const all = await port.getAll<{ id: number }>("/x", "workflow_runs");
  assert.deepEqual(all, { ok: true, data: [{ id: 1 }, { id: 2 }] });

  const none = createGitHubReadPort({ token: () => undefined, fetchImpl: (async () => assert.fail("no request")) as never });
  const result = await none.get("/x");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Through the tool, and through a real agent session
// ---------------------------------------------------------------------------

test("a Boss message interrupts a typed wait", async () => {
  const waits = createWaitInterrupt();
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    if (check === 3) waits.interrupt();
  });
  const tool = await createMonitorTool({
    github: github.port,
    waitSignal: waits.signal,
    now: clock.now,
    sleep: clock.sleep,
  });

  const out = (await tool.execute(
    "c1",
    { ...base, condition: "pr_closed", pr: "omni#2262", description: "omni#2262 to merge" } as never,
    undefined,
    undefined,
    {} as never,
  )) as { content: { text: string }[] };

  assert.match(out.content[0].text, /^STOPPED WAITING for: omni#2262 to merge \(interrupted\)/);
  assert.equal(github.checks(), 3, "ended at the check the message landed on");
});

const fauxSession = async (tools: Awaited<ReturnType<typeof createMonitorTool>>[], toolNames: string[]) => {
  const ai = await import("@earendil-works/pi-ai");
  const pi = await import("@earendil-works/pi-coding-agent");
  const core = ai.createFauxCore({ provider: "faux", api: "faux", models: [{ id: "m" }] });
  const dir = mkdtempSync(join(tmpdir(), "typed-waits-"));
  const runtime = await pi.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("faux", {
    api: core.api as never,
    apiKey: "x",
    baseUrl: "http://faux.invalid",
    streamSimple: core.streamSimple as never,
    models: [
      { id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 },
    ],
  });
  const settingsManager = pi.SettingsManager.inMemory({});
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    extensionFactories: [pollingGuardExtension],
  });
  await resourceLoader.reload();
  const model = runtime.getModel("faux", "m");
  const { session } = await pi.createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory(dir),
    tools: toolNames,
    customTools: tools,
  });
  return { ai, core, session };
};

test("a wait spends no model request between the call and the condition", async () => {
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    github.world.checks = [checkRun("Test", check < 40 ? "IN_PROGRESS" : "COMPLETED", check < 40 ? null : "SUCCESS")];
  });
  const monitor = await createMonitorTool({ github: github.port, sleep: clock.sleep, now: clock.now });
  const { ai, core, session } = await fauxSession([monitor], ["monitor"]);
  const requestsAt: number[] = [];
  core.setResponses([
    () => {
      requestsAt.push(github.checks());
      return ai.fauxAssistantMessage(ai.fauxToolCall("monitor", { ...base, condition: "pr_checks", pr: "omni#2262" }));
    },
    () => {
      requestsAt.push(github.checks());
      return ai.fauxAssistantMessage("green");
    },
  ]);

  await session.prompt("wait for CI");

  assert.equal(github.checks(), 40, "the premise: the wait checked forty times");
  assert.deepEqual(requestsAt, [0, 40], "one request to start the wait, one after it fired, none between");
});

test("bash refuses a sleep and gh's watchers, and runs nothing", async () => {
  const { ai, core, session } = await fauxSession([], ["bash"]);
  core.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("bash", { command: "sleep 600; touch ran" })),
    ai.fauxAssistantMessage("ok"),
  ]);

  await session.prompt("go");

  const result = session.messages.find((message) => message.role === "toolResult") as { content: { text: string }[] };
  assert.match(result.content[0].text, /^Refused, nothing ran: this bash call waits \(sleep 600s\)/);
  assert.match(result.content[0].text, /monitor/);
});

test("the bash guard refuses only what can be nothing but a wait", () => {
  for (const command of ["sleep 20; gh pr checks 2262", "sleep 2m", "gh pr checks 2262 --watch", "gh run watch 123", "until x; do sleep 30; done"]) {
    assert.notEqual(pollingRefusal(command), null, command);
  }
  for (const command of ["sleep 5 && gh pr view 2262", "gh pr checks 2262 --json name,bucket", "grep -r sleeping src", "npm test -- --watch=false"]) {
    assert.equal(pollingRefusal(command), null, command);
  }
});

test("a PR GitHub cannot find ends a person-wait without telling the Boss it is done", async () => {
  const clock = fakeClock();
  const told: string[] = [];
  let cleared = false;
  const port: GitHubReadPort = {
    get: async () => ({ ok: false, status: 404, message: "Not Found", acceptedPermissions: null }),
    getAll: async () => ({ ok: true, data: [] }),
    graphql: async () => ({ ok: true, data: {} as never }),
  };
  const tool = await createMonitorTool({
    github: port,
    sleep: clock.sleep,
    now: clock.now,
    heartbeat: {
      marker: {
        recordWait: async (command) => ({ command, startedAt: clock.now(), pings: 0, lastPingAt: null }),
        recordPing: async () => assert.fail("no reminder"),
        clearWait: async () => {
          cleared = true;
        },
      },
      boss: { tellBoss: async (_kind, text) => void told.push(text), escalationsSince: async () => ({ count: 0, lastAt: null }) },
    },
  });
  const out = (await tool.execute(
    "c1",
    { ...base, condition: "pr_closed", pr: "omni#99999", awaitingHuman: "Merge it" } as never,
    undefined,
    undefined,
    {} as never,
  )) as { content: { text: string }[] };

  assert.deepEqual(told, [], "nothing happened, so nobody is told it is done");
  assert.equal(cleared, true);
  assert.match(out.content[0].text, /^CHECK FAILED/);
  assert.doesNotMatch(out.content[0].text, /Condition met/);
});

test("a GraphQL request says it is JSON", async () => {
  let contentType: string | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    contentType = (init.headers as Record<string, string>)["content-type"];
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await createGitHubReadPort({ token: () => "t", fetchImpl }).graphql("query { viewer { login } }", {});
  assert.equal(contentType, "application/json");
});

test("pr_checks on a PR that closed with no checks ends instead of waiting out its timeout", async () => {
  const clock = fakeClock();
  const github = fakeGitHub((check) => {
    if (check === 3) Object.assign(github.world.pull, { state: "closed", merged: true });
  });

  const result = await runMonitor(
    { ...base, condition: "pr_checks", pr: "omni#2262" },
    { github: github.port, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(github.checks(), 3, "waited while open, ended once merged");
  assert.equal(result.timedOut, false);
  assert.match(result.output, /^RESULT: NO CHECKS\. omni#2262 is MERGED/);
});
