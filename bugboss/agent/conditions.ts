// The typed conditions `monitor` can wait on without a shell command.
//
// Each one is evaluated here, in code, against GitHub, so the agent says what
// it is waiting for and no model turn happens until it is true. Before these,
// every agent wrote its own check script: two to five bash turns probing `gh`
// output to get the jq right, a script that exited 0 with nothing in it, and a
// bash turn afterwards to fetch what the wait had just seen. A script that
// only exits 0 on success also watches a failed release run until it times
// out, which is how incident 80 watched prod for 1h51m after the release had
// already failed.
//
// Every condition that can fail fires on the failure. Waiting on a pipeline
// means waiting for its answer, and "failed" is an answer.

import { githubMessage, type GitHubResult } from "./rerun";

export const DELEGATE_STATE_MARKER = "<!-- delegate-reviewer-state -->";

/**
 * How long a review wait keeps watching after the first verdict lands.
 * delegate-reviewer can post APPROVED and then COMMENTED on the same commit a
 * few minutes later, and an agent that acts on the first has acted on a
 * verdict that was already stale.
 */
export const REVIEW_SETTLE_SECONDS = 300;

export const CONDITION_TYPES = [
  "command",
  "pr_checks",
  "pr_review",
  "pr_closed",
  "workflow_run",
] as const;

export type ConditionType = (typeof CONDITION_TYPES)[number];

export interface ConditionArgs {
  condition?: ConditionType;
  command?: string;
  /** `owner/repo#123`, `repo#123` (thegoodparty) or a pull request URL. */
  pr?: string;
  /** Login, or part of one, whose review ends a `pr_review` wait. */
  reviewer?: string;
  /** ISO time. A `pr_review` wait counts only reviews after it. */
  since?: string;
  repo?: string;
  sha?: string;
  /** Workflow name or file, e.g. `release` or `release.yml`. */
  workflow?: string;
}

export interface ConditionState {
  done: boolean;
  output: string;
  /**
   * The condition has been seen but the wait is still settling. A wait that
   * reaches its deadline in this state ends as met, not timed out.
   */
  met?: boolean;
  /** Nothing was observed: GitHub refused the arguments. Ends the wait, and is not the condition. */
  failed?: boolean;
}

export type ConditionCheck = () => Promise<ConditionState>;

/**
 * The reads these conditions make, and nothing that writes. GraphQL is here
 * for one query: `statusCheckRollup`, which is what `gh pr checks` reads. It
 * is one call for every check on the head, Actions or not (Cursor Bugbot,
 * Vercel, delegate's pr-reviewer), where REST splits check runs and commit
 * statuses into two endpoints.
 */
export interface GitHubReadPort {
  get<T>(path: string): Promise<GitHubResult<T>>;
  /** Every page of a list endpoint, following `Link: rel="next"`. */
  getAll<T>(path: string, key?: string): Promise<GitHubResult<T[]>>;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<GitHubResult<T>>;
}

const headers = (token: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "bugboss",
});

const NO_TOKEN = "no GitHub token in this container: the App credentials did not resolve at launch";

export const createGitHubReadPort = (deps: {
  token: () => string | undefined;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): GitHubReadPort => {
  const http = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? "https://api.github.com";

  const request = async (
    url: string,
    init: { method: string; body?: string },
  ): Promise<GitHubResult<{ data: unknown; next: string | null }>> => {
    const token = deps.token();
    if (!token) return { ok: false, status: 401, message: NO_TOKEN, acceptedPermissions: null };
    try {
      const response = await http(url, {
        ...init,
        headers: init.body ? { ...headers(token), "content-type": "application/json" } : headers(token),
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: githubMessage(response.status, text),
          acceptedPermissions: response.headers.get("x-accepted-github-permissions"),
        };
      }
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
      return { ok: true, data: { data: text ? JSON.parse(text) : null, next } };
    } catch (error) {
      return { ok: false, status: 0, message: `${init.method} ${url} failed: ${String(error)}`, acceptedPermissions: null };
    }
  };

  return {
    get: async <T>(path: string) => {
      const result = await request(`${base}${path}`, { method: "GET" });
      return result.ok ? { ok: true, data: result.data.data as T } : result;
    },
    getAll: async <T>(path: string, key?: string) => {
      const items: T[] = [];
      let url: string | null = `${base}${path}`;
      while (url) {
        const result = await request(url, { method: "GET" });
        if (!result.ok) return result;
        const page = result.data.data as Record<string, unknown> | unknown[];
        const list = (key ? (page as Record<string, unknown>)[key] : page) as T[] | undefined;
        items.push(...(list ?? []));
        url = result.data.next;
      }
      return { ok: true, data: items };
    },
    graphql: async <T>(query: string, variables: Record<string, unknown>) => {
      const result = await request(`${base}/graphql`, {
        method: "POST",
        body: JSON.stringify({ query, variables }),
      });
      if (!result.ok) return result;
      const body = result.data.data as { data?: T; errors?: { message: string }[] };
      if (body.errors?.length) {
        return {
          ok: false,
          status: 422,
          message: body.errors.map((error) => error.message).join("; "),
          acceptedPermissions: null,
        };
      }
      return { ok: true, data: body.data as T };
    },
  };
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const parseRepo = (value: string): string | null => {
  const repo = value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  if (REPO_PATTERN.test(repo)) return repo;
  if (NAME_PATTERN.test(repo)) return `thegoodparty/${repo}`;
  return null;
};

export interface PrRef {
  repo: string;
  number: number;
  label: string;
}

export const parsePr = (value: string): PrRef | null => {
  const text = value.trim();
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(text);
  const short = /^([A-Za-z0-9._/-]+)#(\d+)$/.exec(text);
  const match = url ?? short;
  if (!match) return null;
  const repo = parseRepo(match[1]);
  if (!repo) return null;
  const number = Number(match[2]);
  return { repo, number, label: `${repo.replace(/^thegoodparty\//, "")}#${number}` };
};

/** Why these arguments cannot be waited on, or null. */
export const conditionProblem = (args: ConditionArgs): string | null => {
  const type = args.condition ?? "command";
  if (!CONDITION_TYPES.includes(type)) {
    return `condition must be one of ${CONDITION_TYPES.join(", ")}.`;
  }
  if (type === "command") {
    return args.command?.trim() ? null : "condition command needs `command`.";
  }
  if (type === "workflow_run") {
    if (!args.repo || !parseRepo(args.repo)) return "workflow_run needs `repo`, e.g. thegoodparty/omni.";
    if (!args.sha || !/^[0-9a-f]{7,40}$/i.test(args.sha.trim())) return "workflow_run needs `sha`, the commit the pipeline runs on.";
    return null;
  }
  if (!args.pr || !parsePr(args.pr)) {
    return `${type} needs \`pr\`: a pull request URL, or thegoodparty/omni#123.`;
  }
  if (args.since !== undefined && Number.isNaN(Date.parse(args.since))) {
    return "`since` must be an ISO time, e.g. 2026-09-30T18:00:00Z.";
  }
  return null;
};

/**
 * The durable name of a wait: what the heartbeat marker is keyed on and what
 * the logs carry. The same arguments give the same key, so a re-armed or
 * replayed typed wait resumes its marker the way a command does.
 */
export const conditionKey = (args: ConditionArgs): string => {
  const type = args.condition ?? "command";
  if (type === "command") return args.command ?? "";
  if (type === "workflow_run") {
    return `${type} ${parseRepo(args.repo ?? "")}@${args.sha?.trim()}${args.workflow ? ` ${args.workflow}` : ""}`;
  }
  return `${type} ${parsePr(args.pr ?? "")?.label}${args.reviewer ? ` by ${args.reviewer}` : ""}`;
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * A 404, a 401 or a GraphQL error will not fix itself by waiting, so the wait
 * ends and says so. Anything else -- a 5xx, a rate limit, the network -- is
 * reported and waited through.
 */
const fatal = (status: number): boolean => status === 401 || status === 404 || status === 422;

const unreadable = (what: string, result: { status: number; message: string; acceptedPermissions: string | null }): ConditionState => {
  const needs = result.acceptedPermissions ? ` GitHub says this needs: ${result.acceptedPermissions}.` : "";
  return fatal(result.status)
    ? { done: true, failed: true, output: `COULD NOT READ ${what}: ${result.message} (HTTP ${result.status}).${needs} Nothing was waited for; fix the arguments.` }
    : { done: false, output: `could not read ${what} this time: ${result.message}. Still waiting.` };
};

const short = (sha: string): string => sha.slice(0, 7);

interface PullView {
  state: string;
  merged: boolean;
  merged_at: string | null;
  closed_at: string | null;
  merge_commit_sha: string | null;
  merged_by: { login: string } | null;
  head: { sha: string };
  html_url: string;
}

const prClosed = (ref: PrRef, github: GitHubReadPort): ConditionCheck => async () => {
  const pull = await github.get<PullView>(`/repos/${ref.repo}/pulls/${ref.number}`);
  if (!pull.ok) return unreadable(ref.label, pull);
  const pr = pull.data;
  if (pr.state !== "closed") {
    return { done: false, output: `${ref.label} is still open (head ${short(pr.head.sha)}).` };
  }
  if (!pr.merged) {
    return { done: true, output: `${ref.label} was CLOSED WITHOUT MERGING at ${pr.closed_at}.` };
  }
  return {
    done: true,
    output: [
      `${ref.label} was MERGED at ${pr.merged_at}${pr.merged_by ? ` by ${pr.merged_by.login}` : ""}.`,
      `Merge commit: ${pr.merge_commit_sha}`,
      `To wait for it to ship, monitor condition workflow_run with repo ${ref.repo}, sha ${pr.merge_commit_sha} and the deploy workflow (release in omni).`,
    ].join("\n"),
  };
};

const ROLLUP_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      state
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        contexts(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
            ... on StatusContext { context state targetUrl }
          }
        }
      } } } }
    }
  }
}`;

interface RollupNode {
  __typename: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  checkSuite?: { workflowRun?: { workflow?: { name?: string } | null } | null } | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
}

interface RollupData {
  repository: {
    pullRequest: {
      headRefOid: string;
      state: string;
      commits: {
        nodes: {
          commit: {
            oid: string;
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: RollupNode[];
              };
            } | null;
          };
        }[];
      };
    } | null;
  } | null;
}

type Bucket = "pass" | "fail" | "pending" | "cancelled";

// Cancelled is its own bucket, not a failure: a push that supersedes a run
// cancels it, and a cancelled run is not the PR being broken.
const checkBucket = (node: RollupNode): Bucket => {
  if (node.__typename === "StatusContext") {
    const state = (node.state ?? "").toUpperCase();
    if (state === "SUCCESS") return "pass";
    if (state === "FAILURE" || state === "ERROR") return "fail";
    return "pending";
  }
  if ((node.status ?? "").toUpperCase() !== "COMPLETED") return "pending";
  const conclusion = (node.conclusion ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "pass";
  if (conclusion === "CANCELLED" || conclusion === "STALE") return "cancelled";
  return "fail";
};

const checkName = (node: RollupNode): string => {
  if (node.__typename === "StatusContext") return node.context ?? "(status)";
  const workflow = node.checkSuite?.workflowRun?.workflow?.name;
  return workflow ? `${workflow} / ${node.name}` : (node.name ?? "(check)");
};

const prChecks = (ref: PrRef, github: GitHubReadPort): ConditionCheck => async () => {
  const [owner, name] = ref.repo.split("/");
  const nodes: RollupNode[] = [];
  let head = "";
  let state = "OPEN";
  let after: string | null = null;
  for (;;) {
    const result: GitHubResult<RollupData> = await github.graphql<RollupData>(ROLLUP_QUERY, {
      owner,
      name,
      number: ref.number,
      after,
    });
    if (!result.ok) return unreadable(`the checks on ${ref.label}`, result);
    const pull: NonNullable<RollupData["repository"]>["pullRequest"] = result.data.repository?.pullRequest ?? null;
    if (!pull) return { done: true, failed: true, output: `COULD NOT READ ${ref.label}: no such pull request. Nothing was waited for; fix the arguments.` };
    head = pull.headRefOid;
    state = pull.state;
    const contexts: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RollupNode[] } | undefined =
      pull.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    nodes.push(...(contexts?.nodes ?? []));
    if (!contexts?.pageInfo.hasNextPage) break;
    after = contexts.pageInfo.endCursor;
  }

  if (!nodes.length) {
    // An open PR's checks may not have started yet; a closed one's never will.
    return state === "OPEN"
      ? { done: false, output: `No checks have started on ${ref.label} at ${short(head)} yet.` }
      : { done: true, output: `RESULT: NO CHECKS. ${ref.label} is ${state} and has no checks at ${short(head)}, so there is nothing left to wait for.` };
  }
  const by = (bucket: Bucket) => nodes.filter((node) => checkBucket(node) === bucket);
  const failed = by("fail");
  const pending = by("pending");
  const cancelled = by("cancelled");
  const passed = by("pass");
  const line = (label: string, node: RollupNode) =>
    `- ${label}: ${checkName(node)}${node.detailsUrl ?? node.targetUrl ? ` ${node.detailsUrl ?? node.targetUrl}` : ""}`;

  const summary = `${ref.label} checks at ${short(head)}: ${failed.length} failed, ${pending.length} pending, ${cancelled.length} cancelled, ${passed.length} passed.`;
  const detail = [
    ...failed.map((node) => line("failed", node)),
    ...cancelled.map((node) => line("cancelled", node)),
    ...pending.map((node) => line("pending", node)),
  ];
  const verdict = failed.length
    ? "RESULT: FAILED. Stopped at the first failure; the pending checks are still running."
    : pending.length
      ? null
      : cancelled.length
        ? "RESULT: FINISHED, NOT GREEN. Nothing failed, but some checks were cancelled."
        : "RESULT: ALL PASSED.";
  return {
    done: verdict !== null,
    output: [verdict ?? "", summary, ...detail].filter(Boolean).join("\n"),
  };
};

interface ReviewView {
  id: number;
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
  commit_id: string;
  body: string | null;
  html_url: string;
}

interface ReviewCommentView {
  path: string;
  line: number | null;
  original_line: number | null;
  body: string;
}

interface IssueCommentView {
  id: number;
  user: { login: string } | null;
  body: string | null;
  updated_at: string;
  html_url: string;
}

const prReview = (
  ref: PrRef,
  github: GitHubReadPort,
  args: { reviewer?: string; sinceMs: number; now: () => number; settleMs: number },
): ConditionCheck => {
  let firstSeenAt: number | null = null;
  const matches = (login: string | undefined): boolean =>
    !args.reviewer || (login ?? "").toLowerCase().includes(args.reviewer.trim().toLowerCase());
  const since = new Date(args.sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");

  return async () => {
    const pull = await github.get<PullView>(`/repos/${ref.repo}/pulls/${ref.number}`);
    if (!pull.ok) return unreadable(ref.label, pull);
    const head = pull.data.head.sha;
    const reviews = await github.getAll<ReviewView>(`/repos/${ref.repo}/pulls/${ref.number}/reviews?per_page=100`);
    if (!reviews.ok) return unreadable(`the reviews on ${ref.label}`, reviews);
    const comments = await github.getAll<IssueCommentView>(
      `/repos/${ref.repo}/issues/${ref.number}/comments?per_page=100&since=${since}`,
    );
    if (!comments.ok) return unreadable(`the comments on ${ref.label}`, comments);

    const fresh = reviews.data.filter(
      (review) =>
        review.state !== "PENDING" &&
        review.submitted_at !== null &&
        Date.parse(review.submitted_at) > args.sinceMs &&
        matches(review.user?.login),
    );
    const states = comments.data.filter(
      (comment) =>
        (comment.body ?? "").trimStart().startsWith(DELEGATE_STATE_MARKER) &&
        Date.parse(comment.updated_at) > args.sinceMs &&
        matches(comment.user?.login),
    );

    if (!fresh.length && !states.length) {
      return { done: false, output: `No new review on ${ref.label} since ${since} (head ${short(head)}).` };
    }
    firstSeenAt ??= args.now();
    const settled = args.now() - firstSeenAt >= args.settleMs;

    const blocks: { at: string; text: string }[] = [];
    for (const review of fresh) {
      const inline = await github.getAll<ReviewCommentView>(
        `/repos/${ref.repo}/pulls/${ref.number}/reviews/${review.id}/comments?per_page=100`,
      );
      const where = review.commit_id === head ? "the current head" : `${short(review.commit_id)}, NOT the current head ${short(head)}`;
      blocks.push({
        at: review.submitted_at as string,
        text: [
          `REVIEW ${review.state} by ${review.user?.login ?? "unknown"} at ${review.submitted_at}, on ${where}. ${review.html_url}`,
          (review.body ?? "").trim(),
          ...(inline.ok
            ? inline.data.map((comment) => `\nInline on ${comment.path}:${comment.line ?? comment.original_line ?? "?"}:\n${comment.body.trim()}`)
            : [`(could not read this review's inline comments: ${inline.message})`]),
        ].filter(Boolean).join("\n"),
      });
    }
    for (const comment of states) {
      blocks.push({
        at: comment.updated_at,
        text: `REVIEWER STATE COMMENT by ${comment.user?.login ?? "unknown"}, updated ${comment.updated_at}. ${comment.html_url}\n${(comment.body ?? "").trim()}`,
      });
    }
    blocks.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const latest = blocks.at(-1)?.at ?? since;

    return {
      done: settled,
      met: true,
      output: [
        `${blocks.length} new review${blocks.length === 1 ? "" : "s"} on ${ref.label} since ${since}, oldest first. The last one is the verdict that stands. Head is ${short(head)}.`,
        ...blocks.map((block) => `\n${block.text}`),
        `\nTo wait for the next review after these, call monitor again with since: "${latest}".`,
      ].join("\n"),
    };
  };
};

interface WorkflowRunView {
  id: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_attempt: number;
}

interface JobView {
  name: string;
  conclusion: string | null;
  html_url: string;
  steps?: { name: string; conclusion: string | null }[];
}

// A push to the default branch also carries every `schedule` and
// `workflow_run` run that happened while it was the head, and omni's
// gpbot-ci-drive cancels dozens of those. None of them is the commit's
// pipeline, and treating their cancellations as its answer would end the
// wait on noise.
const INCIDENTAL_EVENTS = ["schedule", "workflow_run"];

const workflowMatches = (run: WorkflowRunView, workflow: string): boolean => {
  const wanted = workflow.trim().toLowerCase();
  const file = run.path.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    run.name.toLowerCase() === wanted ||
    file === wanted ||
    file.replace(/\.ya?ml$/, "") === wanted
  );
};

const workflowRun = (
  args: { repo: string; sha: string; workflow?: string },
  github: GitHubReadPort,
): ConditionCheck => {
  let full = /^[0-9a-f]{40}$/i.test(args.sha) ? args.sha.toLowerCase() : null;
  return async () => {
    if (!full) {
      const commit = await github.get<{ sha: string }>(`/repos/${args.repo}/commits/${args.sha}`);
      if (!commit.ok) return unreadable(`commit ${args.sha} in ${args.repo}`, commit);
      full = commit.data.sha;
    }
    const listed = await github.getAll<WorkflowRunView>(
      `/repos/${args.repo}/actions/runs?head_sha=${full}&per_page=100`,
      "workflow_runs",
    );
    if (!listed.ok) return unreadable(`the workflow runs for ${short(full)}`, listed);

    const relevant = listed.data.filter((run) =>
      args.workflow ? workflowMatches(run, args.workflow) : !INCIDENTAL_EVENTS.includes(run.event),
    );
    // The newest run of each workflow is its answer; an older one was re-run
    // or superseded.
    const latest = new Map<string, WorkflowRunView>();
    for (const run of relevant) {
      const seen = latest.get(run.path);
      if (!seen || run.id > seen.id) latest.set(run.path, run);
    }
    const runs = [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
    const what = `${args.workflow ? `the ${args.workflow} run` : "the workflow runs"} for ${short(full)} in ${args.repo}`;
    if (!runs.length) {
      return { done: false, output: `No ${what.replace(/^the /, "")} yet.` };
    }

    const failed = runs.filter(
      (run) => run.status === "completed" && !["success", "skipped", "neutral", "cancelled"].includes(run.conclusion ?? ""),
    );
    const cancelled = runs.filter((run) => run.status === "completed" && run.conclusion === "cancelled");
    const pending = runs.filter((run) => run.status !== "completed");
    const lines = runs.map(
      (run) => `- ${run.name}: ${run.status === "completed" ? run.conclusion : run.status} ${run.html_url}`,
    );

    const jobs: string[] = [];
    for (const run of failed) {
      const listedJobs = await github.getAll<JobView>(
        `/repos/${args.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        "jobs",
      );
      if (!listedJobs.ok) {
        jobs.push(`(could not read the jobs of ${run.name}: ${listedJobs.message})`);
        continue;
      }
      for (const job of listedJobs.data.filter((job) => job.conclusion && !["success", "skipped", "neutral"].includes(job.conclusion))) {
        const steps = (job.steps ?? []).filter((step) => step.conclusion === "failure").map((step) => step.name);
        jobs.push(`- ${run.name} / ${job.name}: ${job.conclusion}${steps.length ? `, at step ${steps.join(", ")}` : ""} ${job.html_url}`);
      }
    }

    const verdict = failed.length
      ? `RESULT: FAILED. ${what} failed; stopped at the first failure. This commit will not ship from this run.`
      : pending.length
        ? null
        : cancelled.length
          ? `RESULT: CANCELLED. ${what} finished without succeeding. The release train coalesces bursts of merges, so a newer commit's run may be the one carrying this change: check the latest run on the branch.`
          : `RESULT: SUCCEEDED. ${what} finished green.`;
    return {
      done: verdict !== null,
      output: [verdict ?? `Still running: ${what}.`, ...lines, ...(jobs.length ? ["Failed jobs:", ...jobs] : [])].join("\n"),
    };
  };
};

/**
 * The check for a typed condition. `sinceMs` is when the wait began: the
 * marker's clock for a wait on a person, so a restart does not move it.
 */
export const createConditionCheck = (
  args: ConditionArgs,
  deps: { github: GitHubReadPort; now: () => number; sinceMs: number; settleSeconds?: number },
): ConditionCheck => {
  switch (args.condition) {
    case "pr_checks":
      return prChecks(parsePr(args.pr ?? "") as PrRef, deps.github);
    case "pr_closed":
      return prClosed(parsePr(args.pr ?? "") as PrRef, deps.github);
    case "pr_review":
      return prReview(parsePr(args.pr ?? "") as PrRef, deps.github, {
        reviewer: args.reviewer,
        sinceMs: args.since ? Date.parse(args.since) : deps.sinceMs,
        now: deps.now,
        settleMs: (deps.settleSeconds ?? REVIEW_SETTLE_SECONDS) * 1000,
      });
    case "workflow_run":
      return workflowRun(
        { repo: parseRepo(args.repo ?? "") as string, sha: (args.sha ?? "").trim(), workflow: args.workflow },
        deps.github,
      );
    default:
      throw new Error(`not a typed condition: ${args.condition}`);
  }
};
