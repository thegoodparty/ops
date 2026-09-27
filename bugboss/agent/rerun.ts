// Re-running a failed CI job, with the part that makes it safe in code.
//
// An agent that can only read CI has to ask a human to press the button, and
// the first one did: incident 5 finished its investigation, got its pull
// request approved with 33 of 35 checks green, and then posted that it needed
// somebody to re-run two E2E failures it believed were a preview-environment
// flake. That was the honest answer to a missing permission — the App holds
// `actions: read`, and the endpoint needs `actions: write` — not a failure of
// nerve. See `../github-app.md` for what the App holds and why.
//
// The permission alone would be a worse system than the one we have. `gh run
// rerun --failed` in bash is all the capability needs, and an agent handed
// that will reach for it the moment a check goes red: retry as a reflex, which
// is the habit this repo rejects. Nothing useful is learned by a second
// attempt at a failure that was never environmental, and a pull request ground
// to green is a defect shipped.
//
// The rule itself is not new. omni's own ship-pr skill — which the prompt
// injects verbatim — already says "a single re-run for a suspected flake is
// fine, blind re-pushing is not". It has been a sentence in a document the
// model reads. This makes it a bound.
//
// So the affordance and the discipline are the same object. Three bounds, and
// only the first of them is something a model can be talked out of:
//
//   1. One attempt per workflow run, read from GitHub's own `run_attempt`
//      rather than from anything we store. A run that has been re-run once is
//      refused, whoever re-ran it, and the refusal says that a failure which
//      survives a re-run is a finding. This is also what makes the tool safe
//      to replay: a restarted agent's recorded call runs again, finds attempt
//      2, and refuses instead of re-running twice.
//   2. A budget across the incident, so the pattern of "push something small,
//      re-run, repeat" runs out. Process-scoped, and a restart hands it back —
//      but every run already re-run is still at attempt 2 and still refused,
//      so what a restart buys is only the runs it has not touched.
//   3. The thread hears about it. The notice is posted by this tool, not by
//      the model deciding to mention it, and it carries the agent's own
//      reasoning so a human reading the thread can say "that is not a flake,
//      that is your change".
//
// What is *not* here: a fence. The agent runs a real shell, so `gh run rerun`
// remains reachable the way `gh pr merge` does, and the control on merging is
// branch protection rather than the prompt. GitHub offers no equivalent
// server-side control for a re-run, so this is a designed affordance with the
// discipline attached, plus a prompt rule, and that honest gap. Read
// `CLAUDE.md` in this directory before widening it.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HumanContactPort } from "./tools";
import { truncateOutput, DEFAULT_MAX_TOOL_CHARS } from "./tools";

export const RERUN_TOOL_NAME = "rerun_ci";

/** One suspicion confirmed, not a pull request ground to green. */
export const MAX_RERUNS_PER_INCIDENT = 3;

/**
 * The suspicion is posted to Slack, where the reader is on a phone. Same
 * reasoning as `CONTACT_HUMAN_MESSAGE_LIMIT`, and a separate number because
 * they answer to different readers and will drift apart.
 */
export const RERUN_SUSPICION_LIMIT = 700;

/** Anchored, because the value is interpolated into an api.github.com path. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The conclusions that leave a failed job there is any point re-running. */
const RERUNNABLE_CONCLUSIONS = ["failure", "timed_out"];

export interface WorkflowRunView {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  name: string;
  html_url: string;
}

export type GitHubResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

/**
 * The two calls this needs, named rather than a general client: the agent
 * already has `gh` for everything else, and a broad GitHub client here would
 * invite the next action to arrive without its bound.
 */
export interface GitHubRunsPort {
  getRun(repo: string, runId: number): Promise<GitHubResult<WorkflowRunView>>;
  rerunFailedJobs(repo: string, runId: number): Promise<GitHubResult<null>>;
}

export type ThreadPort = Pick<HumanContactPort, "post">;

export interface RerunArgs {
  repo: string;
  runId: number;
  suspicion: string;
}

export interface RerunResult {
  /** Set when nothing reached GitHub. Says what to do instead. */
  refused: string | null;
  /** True only when GitHub accepted the re-run. */
  started: boolean;
  /** Set when GitHub was asked and said no. Carries GitHub's own words. */
  error: string | null;
  /** What the thread was told, or was meant to be told. */
  notice: string;
  /** Set when the re-run started and the thread never heard about it. */
  postError: string | null;
}

const githubHeaders = (token: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "bugboss",
});

/**
 * GitHub's error bodies are JSON with a `message`, except when they are an
 * HTML error page from a proxy. Both end up in a tool result a model reads, so
 * take the message when there is one and the raw text when there is not.
 */
export const githubMessage = (status: number, body: string): string => {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    // Not JSON. Fall through to the raw body.
  }
  return body.trim() ? truncateOutput(body.trim(), 500) : `HTTP ${status}`;
};

export const createGitHubRunsPort = (deps: {
  token: () => string | undefined;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): GitHubRunsPort => {
  const http = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? "https://api.github.com";

  const call = async <T>(
    method: string,
    path: string,
  ): Promise<GitHubResult<T>> => {
    const token = deps.token();
    // The token is refreshed in place by `keepGitHubTokenFresh`, so an absent
    // one means the App credentials never resolved at boot. Said plainly here
    // rather than sent as `Bearer undefined` for GitHub to call a 401.
    if (!token) {
      return {
        ok: false,
        status: 0,
        message:
          "no GitHub token in this container: the App credentials did not resolve at launch, so BugBoss is running without GitHub access at all",
      };
    }
    const response = await http(`${base}${path}`, {
      method,
      headers: githubHeaders(token),
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, message: githubMessage(response.status, text) };
    }
    return { ok: true, data: (text ? JSON.parse(text) : null) as T };
  };

  return {
    getRun: (repo, runId) =>
      call<WorkflowRunView>("GET", `/repos/${repo}/actions/runs/${runId}`),
    rerunFailedJobs: (repo, runId) =>
      call<null>("POST", `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`),
  };
};

/**
 * What the model is told when GitHub refuses. The 403 case is the one this
 * whole change exists because of, so it never degrades into "the re-run
 * failed": it names the permission, names where the gap is, and tells the
 * agent that falling back to asking a human is right *only* if the ask says
 * why. A missing permission nobody names is a missing permission nobody
 * grants, which is how incident 5 ended.
 *
 * It says "likeliest" rather than "is" on purpose. Once `actions: write` is
 * granted a 403 here means something else — a run past its retention window,
 * a run with no failed jobs left — and GitHub's own message is carried
 * through so the real reason is always in front of the reader.
 */
export const githubRefusalText = (
  repo: string,
  runId: number,
  status: number,
  message: string,
): string => {
  if (status === 403) {
    return [
      `GitHub refused with 403: ${message}`,
      "",
      "The likeliest cause is permission. Re-running calls",
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs, which",
      "requires `actions: write`, and BugBoss's GitHub App holds `actions: read` —",
      "enough to watch a job fail and not enough to act on it.",
      "",
      "Do not just ask a human to press the button. Ask with contact_human AND say",
      "in the ask that the BugBoss GitHub App is missing `actions: write`, so",
      "somebody grants it instead of clicking around it again next incident.",
    ].join("\n");
  }
  if (status === 404) {
    return [
      `GitHub returned 404 for run ${runId} in ${repo}: ${message}`,
      "",
      `Either that run id does not exist, or BugBoss's GitHub App is not installed on ${repo}.`,
      "Check the id with `gh run list` against the head SHA before trying again.",
    ].join("\n");
  }
  return `GitHub refused with ${status || "a transport error"}: ${message}`;
};

export const rerunNotice = (
  repo: string,
  run: WorkflowRunView,
  suspicion: string,
): string =>
  [
    `*Re-running the failed jobs in ${repo} <${run.html_url}|${run.name}>.*`,
    "",
    suspicion.trim(),
    "",
    "I am confirming that once. If the same job fails on the second attempt I will",
    "report it as a real failure rather than re-running it again. Tell me if you",
    "think the failure is my change.",
  ].join("\n");

/**
 * The one re-run, with every bound checked before GitHub is touched.
 *
 * `attempted` is the incident's budget ledger and is mutated here rather than
 * by the caller, so there is no path that spends a re-run without recording
 * it. It holds `repo#runId` keys, which makes a second call for the same run
 * cost nothing from the budget — that one is refused by `run_attempt`, and
 * charging it twice would make an honest retry-after-error expensive.
 */
export const runRerunFailedJobs = async (
  args: RerunArgs,
  deps: {
    github: GitHubRunsPort;
    thread: ThreadPort;
    attempted: Set<string>;
    maxReruns?: number;
    suspicionLimit?: number;
  },
): Promise<RerunResult> => {
  const max = deps.maxReruns ?? MAX_RERUNS_PER_INCIDENT;
  const limit = deps.suspicionLimit ?? RERUN_SUSPICION_LIMIT;
  const refuse = (reason: string): RerunResult => ({
    refused: reason,
    started: false,
    error: null,
    notice: "",
    postError: null,
  });

  if (!REPO_PATTERN.test(args.repo)) {
    return refuse(
      `"${args.repo}" is not an owner/name repository. Pass it as it appears in the pull request url, for example "thegoodparty/omni".`,
    );
  }
  if (!Number.isInteger(args.runId) || args.runId <= 0) {
    return refuse(
      `"${args.runId}" is not a workflow run id. Get it from \`gh run list --commit <sha> --json databaseId\`; it is not the check name and not the job id.`,
    );
  }
  const suspicion = args.suspicion?.trim() ?? "";
  if (!suspicion) {
    return refuse(
      "suspicion is required: name the job that failed and say what makes you think it is the environment rather than your change. It is posted to the incident thread, because a re-run nobody can see is a re-run nobody can disagree with.",
    );
  }
  if (suspicion.length > limit) {
    return refuse(
      `suspicion is ${suspicion.length} characters and the limit is ${limit}. It is a line or two in a Slack thread, not the analysis — keep which job, which failure, and why it looks environmental.`,
    );
  }

  const key = `${args.repo}#${args.runId}`;
  if (!deps.attempted.has(key) && deps.attempted.size >= max) {
    return refuse(
      `you have already re-run ${deps.attempted.size} workflow runs on this incident, which is the limit. A re-run confirms one suspicion; past that it is grinding a pull request to green. Report what is failing and why you believe it, and let a human decide.`,
    );
  }

  const run = await deps.github.getRun(args.repo, args.runId);
  if (!run.ok) {
    return {
      refused: null,
      started: false,
      error: githubRefusalText(args.repo, args.runId, run.status, run.message),
      notice: "",
      postError: null,
    };
  }

  // Checked before status, so the message for the common case is the precise
  // one. This is the durable bound: it survives a restart, and it holds just
  // as well when the run was re-run by a human or by an earlier incarnation of
  // this agent whose tool call is being replayed.
  if (run.data.run_attempt > 1) {
    return refuse(
      `run ${args.runId} is already on attempt ${run.data.run_attempt}: its failed jobs have been re-run once. A failure that comes back on a second attempt is a finding, not a flake. Report which job, which step and what the failure says — and if it went green, the flake is still a defect worth naming. Do not re-run it again, and do not push an empty commit to buy a fresh run.`,
    );
  }
  // Checked before "is it finished", because a run parked on an approval is
  // not a run that is still working and telling the agent to wait for it would
  // send it into a monitor that never returns. GitHub spells this three ways —
  // `status: waiting` for an environment protection rule, `status` or
  // `conclusion: action_required` for a fork pull request from a first-time
  // contributor — and none of them are cleared by a re-run.
  if (
    run.data.status === "waiting" ||
    run.data.status === "action_required" ||
    run.data.conclusion === "action_required"
  ) {
    return refuse(
      `run ${args.runId} is waiting on a human to approve it (status ${run.data.status}, conclusion ${run.data.conclusion ?? "none"}). That is what a fork pull request from a first-time contributor or an environment protection rule does, and re-running does not clear it — approval is a different button that BugBoss does not hold. Ask for the approval with contact_human, and say which run.`,
    );
  }
  if (run.data.status !== "completed") {
    return refuse(
      `run ${args.runId} is ${run.data.status}, so nothing has failed yet. Wait for it with monitor and look at the result before deciding it is a flake.`,
    );
  }
  if (!RERUNNABLE_CONCLUSIONS.includes(run.data.conclusion ?? "")) {
    return refuse(
      `run ${args.runId} concluded ${run.data.conclusion ?? "nothing"}, so it has no failed jobs to re-run. Only ${RERUNNABLE_CONCLUSIONS.join(" and ")} do.`,
    );
  }

  const rerun = await deps.github.rerunFailedJobs(args.repo, args.runId);
  if (!rerun.ok) {
    return {
      refused: null,
      started: false,
      error: githubRefusalText(args.repo, args.runId, rerun.status, rerun.message),
      notice: "",
      postError: null,
    };
  }
  deps.attempted.add(key);

  // Posted after the re-run rather than before it, which is the opposite of
  // what `contact_human` does with its marker, for a reason that only applies
  // here: until the permission is granted every call ends in a 403, and a
  // notice posted first would announce a re-run that never happened, over and
  // over, in the thread a human is reading. A post that fails afterwards is
  // recoverable and loud — the tool result hands the agent the exact text and
  // tells it to post it — where a thread full of announcements for re-runs
  // that did not happen is neither.
  const notice = rerunNotice(args.repo, run.data, suspicion);
  let postError: string | null = null;
  try {
    await deps.thread.post(notice);
  } catch (err) {
    postError = String(err);
  }
  return { refused: null, started: true, error: null, notice, postError };
};

const RERUN_DESCRIPTION = [
  "Re-run the failed jobs in one GitHub Actions workflow run, once, to confirm",
  "that a failure is environmental rather than yours. It posts your reasoning to",
  "the incident thread before it reports back, so a human can tell you that the",
  "failure is your change.",
  "",
  "THIS IS NOT A WAY TO GET A PULL REQUEST GREEN. Read the failure first. A test",
  "that names something you touched is your change, and a second attempt at it",
  "teaches you nothing and costs everyone the time it runs.",
  "",
  "A run can be re-run once. A failure that comes back on the second attempt is a",
  `finding: report it. At most ${MAX_RERUNS_PER_INCIDENT} runs across this incident, and pushing an empty`,
  "commit to buy a fresh run is the same thing wearing a different hat.",
  "",
  "A flake you confirm is a defect in its own right, even when the re-run is",
  "green. Name it the way you would name a bad alert: which test, which job, what",
  "makes it non-deterministic, and a pull request if the fix is small.",
  "",
  "The run id comes from `gh run list --commit <sha> --json databaseId`. Wait for",
  "the re-run with monitor; it does not block.",
].join("\n");

export const createRerunCiTool = async (deps: {
  github: GitHubRunsPort;
  thread: ThreadPort;
  maxOutputChars?: number;
}): Promise<ToolDefinition> => {
  const { Type } = await import("typebox");
  // One ledger for the life of the process, which is one incident.
  const attempted = new Set<string>();
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_TOOL_CHARS;

  const parameters = Type.Object({
    repo: Type.String({
      description: 'The repository as owner/name, for example "thegoodparty/omni".',
    }),
    runId: Type.Number({
      description: "The workflow run id (databaseId), not the job id and not the check name.",
    }),
    suspicion: Type.String({
      description: `Which job failed and why you believe it is the environment rather than your change. Posted to the incident thread. mrkdwn, at most ${RERUN_SUSPICION_LIMIT} characters.`,
    }),
  });

  return {
    name: RERUN_TOOL_NAME,
    label: "Re-run CI",
    description: RERUN_DESCRIPTION,
    parameters,
    execute: async (_toolCallId: string, params: unknown) => {
      const args = params as unknown as RerunArgs;
      const result = await runRerunFailedJobs(args, {
        github: deps.github,
        thread: deps.thread,
        attempted,
      });
      const text = result.refused
        ? `Nothing was re-run: ${result.refused}`
        : result.error
          ? `Nothing was re-run. ${result.error}`
          : result.postError
            ? [
                `Re-running the failed jobs in run ${args.runId}. This is the one attempt you get on it.`,
                "",
                `The thread was NOT told: posting failed with ${result.postError}. Post this yourself now, before you wait for the result:`,
                "",
                result.notice,
              ].join("\n")
            : [
                `Re-running the failed jobs in run ${args.runId}, and the thread has been told why.`,
                "",
                "This is the one attempt you get on this run. If the same job fails again,",
                "that is a finding to report rather than something to re-run. If it goes",
                "green, the flake is still a defect: name the test and the job, and open a",
                "pull request if the fix is small.",
                "",
                "Wait for the new attempt with monitor.",
              ].join("\n");
      return {
        content: [{ type: "text", text: truncateOutput(text, maxChars) }],
        details: { started: result.started, runId: args.runId },
      };
    },
  } as ToolDefinition;
};
