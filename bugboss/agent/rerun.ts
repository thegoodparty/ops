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
//   3. The Boss hears about it. The notice is sent by this tool, not by the
//      model deciding to mention it, and it carries the agent's own reasoning
//      so somebody the Boss shows it to can say "that is not a flake, that is
//      your change".
//
// What is *not* here: a fence. The agent runs a real shell, so `gh run rerun`
// remains reachable the way `gh pr merge` does, and the control on merging is
// branch protection rather than the prompt. GitHub offers no equivalent
// server-side control for a re-run, so this is a designed affordance with the
// discipline attached, plus a prompt rule, and that honest gap. Read
// `CLAUDE.md` in this directory before widening it.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BossInboxPort } from "./tools";

export const RERUN_TOOL_NAME = "rerun_ci";

/** One suspicion confirmed, not a pull request ground to green. */
export const MAX_RERUNS_PER_INCIDENT = 3;

/** Anchored, because the value is interpolated into a GitHub API path. */
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
  | {
      ok: false;
      status: number;
      message: string;
      /**
       * GitHub's own answer to "what permission would this have needed",
       * from the `X-Accepted-GitHub-Permissions` response header. Present on
       * a permission refusal to a fine-grained actor and absent otherwise,
       * which is the only reliable way to tell a permission 403 from the
       * other ones — the message strings are undocumented and have changed.
       */
      acceptedPermissions: string | null;
    };

/**
 * The two calls this needs, named rather than a general client: the agent
 * already has `gh` for everything else, and a broad GitHub client here would
 * invite the next action to arrive without its bound.
 */
export interface GitHubRunsPort {
  getRun(repo: string, runId: number): Promise<GitHubResult<WorkflowRunView>>;
  rerunFailedJobs(repo: string, runId: number): Promise<GitHubResult<null>>;
}

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
  /** What the Boss was told, or was meant to be told. */
  notice: string;
  /** Set when the re-run started and the Boss never heard about it. */
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
 *
 * The raw text goes whole. An HTML error page is the long case and the one
 * worth reading: whatever names the proxy that refused us is in the middle of
 * it, which is exactly what the old 500-character head-and-tail cut away.
 */
export const githubMessage = (status: number, body: string): string => {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    // Not JSON. Fall through to the raw body.
  }
  return body.trim() || `HTTP ${status}`;
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
        acceptedPermissions: null,
        message:
          "no GitHub token in this container: the App credentials did not resolve at launch, so BugBoss is running without GitHub access at all",
      };
    }
    // A thrown fetch is a result here rather than an exception out of the tool,
    // so the model reads a sentence it can act on instead of a stack. It is
    // safe to report a failed POST that may in fact have landed: the retry
    // reads `run_attempt` first and refuses a run that was already re-run.
    try {
      const response = await http(`${base}${path}`, {
        method,
        headers: githubHeaders(token),
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
      return { ok: true, data: (text ? JSON.parse(text) : null) as T };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        acceptedPermissions: null,
        message: `${method} ${path} failed: ${String(err)}`,
      };
    }
  };

  return {
    getRun: (repo, runId) =>
      call<WorkflowRunView>("GET", `/repos/${repo}/actions/runs/${runId}`),
    rerunFailedJobs: (repo, runId) =>
      call<null>("POST", `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`),
  };
};

/**
 * What the model is told when GitHub refuses.
 *
 * The permission case is the one this whole change exists because of, so it
 * never degrades into "the re-run failed": it names the permission, says where
 * the gap is, and tells the agent that falling back to asking a human is right
 * *only* if the ask says why. A missing permission nobody names is a missing
 * permission nobody grants, which is how incident 5 ended.
 *
 * The discriminator is the `X-Accepted-GitHub-Permissions` header, not the
 * message. GitHub documents no failure at all for this endpoint — only 201 —
 * so every 403 body is folklore collected from other people's bug reports, and
 * the two that are attested ("This workflow is already running", "Unable to
 * retry this workflow run because it was created over a month ago") are
 * nothing to do with permissions. The header is sent to fine-grained actors
 * precisely to answer "what would this have needed", so when it is there the
 * answer is definite and when it is not, this says so rather than blaming
 * permissions for a run that is simply too old.
 *
 * 404 gets the same paragraph because GitHub deliberately masks a private
 * resource an installation cannot see: an App that is not installed on a
 * repository is told the repository does not exist.
 */
export const githubRefusalText = (
  repo: string,
  runId: number,
  status: number,
  message: string,
  acceptedPermissions: string | null,
): string => {
  const endpoint = "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs";
  if (acceptedPermissions) {
    return [
      `GitHub refused with ${status}: ${message}`,
      "",
      `This is a permission. GitHub says the call needs \`${acceptedPermissions}\`, and`,
      "BugBoss's GitHub App does not hold it — it has `actions: read`, which is enough",
      "to watch a job fail and not enough to act on it.",
      "",
      "Do not quietly work around this. Ask the Boss with message_boss AND say in the",
      `ask that the BugBoss GitHub App is missing \`${acceptedPermissions}\` for ${endpoint},`,
      "so somebody grants it instead of clicking around it again next incident.",
    ].join("\n");
  }
  if (status === 403) {
    return [
      `GitHub refused with 403: ${message}`,
      "",
      "GitHub did not say a permission was missing, so this is probably not one. The",
      "two refusals it returns here are a run that is still going and a run created",
      "more than about a month ago, which cannot be re-run at all.",
      "",
      "If the message does not explain it, treat the failure as real and report it",
      "rather than trying again.",
    ].join("\n");
  }
  if (status === 404) {
    return [
      `GitHub returned 404 for run ${runId} in ${repo}: ${message}`,
      "",
      "A 404 here is one of three things. The run id is wrong — check it with",
      "`gh run list --commit <sha> --json databaseId`, and remember the run id is not",
      "the job id. Or the run has aged out. Or BugBoss's GitHub App cannot see",
      `${repo} at all: GitHub answers 404 rather than 403 for a private repository an`,
      "installation is not on. If you believe the id is right, say so when you ask the",
      "Boss, and name the App.",
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
    `I am re-running the failed jobs in ${repo}, workflow run "${run.name}" (${run.html_url}).`,
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
    boss: Pick<BossInboxPort, "tellBoss">;
    attempted: Set<string>;
    maxReruns?: number;
  },
): Promise<RerunResult> => {
  const max = deps.maxReruns ?? MAX_RERUNS_PER_INCIDENT;
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
      "suspicion is required: name the job that failed and say what makes you think it is the environment rather than your change. It goes to the Boss, because a re-run nobody can see is a re-run nobody can disagree with.",
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
      error: githubRefusalText(
        args.repo,
        args.runId,
        run.status,
        run.message,
        run.acceptedPermissions,
      ),
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
      `run ${args.runId} is waiting on a human to approve it (status ${run.data.status}, conclusion ${run.data.conclusion ?? "none"}). That is what a fork pull request from a first-time contributor or an environment protection rule does, and re-running does not clear it — approval is a different button that BugBoss does not hold. Ask the Boss for the approval with message_boss, and say which run.`,
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
      error: githubRefusalText(
        args.repo,
        args.runId,
        rerun.status,
        rerun.message,
        rerun.acceptedPermissions,
      ),
      notice: "",
      postError: null,
    };
  }
  deps.attempted.add(key);

  // Sent after the re-run rather than before it, which is the opposite of
  // what `message_boss` does with its question, for a reason that only
  // applies here: until the permission is granted every call ends in a 403,
  // and a notice sent first would announce a re-run that never happened, over
  // and over. A send that fails afterwards is recoverable and loud — the tool
  // result hands the agent the exact text and tells it to send it — where a
  // stream of announcements for re-runs that did not happen is neither.
  const notice = rerunNotice(args.repo, run.data, suspicion);
  let postError: string | null = null;
  try {
    await deps.boss.tellBoss("message", notice);
  } catch (err) {
    postError = String(err);
  }
  return { refused: null, started: true, error: null, notice, postError };
};

const RERUN_DESCRIPTION = [
  "Re-run the failed jobs in one GitHub Actions workflow run, once, to confirm",
  "that a failure is environmental rather than yours. It sends your reasoning to",
  "the Boss before it reports back, so somebody can tell you that the failure is",
  "your change.",
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
  boss: Pick<BossInboxPort, "tellBoss">;
}): Promise<ToolDefinition> => {
  const { Type } = await import("typebox");
  // One ledger for the life of the process, which is one incident.
  const attempted = new Set<string>();

  const parameters = Type.Object({
    repo: Type.String({
      description: 'The repository as owner/name, for example "thegoodparty/omni".',
    }),
    runId: Type.Number({
      description: "The workflow run id (databaseId), not the job id and not the check name.",
    }),
    suspicion: Type.String({
      description: "Which job failed and why you believe it is the environment rather than your change. Sent to the Boss.",
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
        boss: deps.boss,
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
                `The Boss was NOT told: sending failed with ${result.postError}. Send this yourself with message_boss now, before you wait for the result:`,
                "",
                result.notice,
              ].join("\n")
            : [
                `Re-running the failed jobs in run ${args.runId}, and the Boss has been told why.`,
                "",
                "This is the one attempt you get on this run. If the same job fails again,",
                "that is a finding to report rather than something to re-run. If it goes",
                "green, the flake is still a defect: name the test and the job, and open a",
                "pull request if the fix is small.",
                "",
                "Wait for the new attempt with monitor.",
              ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { started: result.started, runId: args.runId },
      };
    },
  } as ToolDefinition;
};
