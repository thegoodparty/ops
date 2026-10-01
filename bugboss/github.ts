// GitHub App credentials for the incident agent.
//
// The agent gets the App's own credentials rather than a token minted for it,
// because an installation token lasts an hour and an incident can run for a
// day. A token handed down at launch would expire mid-investigation, and the
// failure would surface as `gh` refusing to push a branch the agent had
// already built.
//
// @octokit/auth-app caches and refreshes on its own, so the agent re-mints
// only when the current token is close to expiry.

import { createAppAuth } from "@octokit/auth-app";

import { makeAlarm, makeLog } from "./logging";

import {
  latestDelegateVerdict,
  refKey,
  type CommentNode,
  type PrObservation,
  type PrWatchReader,
  type ReviewNode,
} from "./prwatch";
import type { PrStateReader, ReportPr } from "./report";

const alarm = makeAlarm("github");
const log = makeLog("github");

/**
 * Secrets Manager stores the PEM as one line, since JSON has no way to carry
 * the newlines. Rebuilding the armour is what makes it parse. Same shape as
 * `delegate/worker/github-auth.ts`, which solved this first.
 */
export const normalizePrivateKey = (raw: string): string => {
  const body = raw
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "")
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const header = /BEGIN PRIVATE KEY/.test(raw)
    ? "PRIVATE KEY"
    : "RSA PRIVATE KEY";
  return [`-----BEGIN ${header}-----`, body, `-----END ${header}-----`].join(
    "\n",
  );
};

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

export const gitHubAppFromEnv = (
  env: NodeJS.ProcessEnv,
): GitHubAppConfig | null => {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!appId || !privateKey || !installationId) return null;
  return { appId, privateKey, installationId };
};

/**
 * Returns the current installation token, minting a new one when the cached
 * one is spent. Call it before each use rather than holding the result: over a
 * day-long incident the value changes underneath you.
 */
export const createInstallationToken = (
  config: GitHubAppConfig,
): (() => Promise<string>) => {
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: normalizePrivateKey(config.privateKey),
    installationId: config.installationId,
  });
  return async () => (await auth({ type: "installation" })).token;
};

// ---------------------------------------------------------------------------
// What became of a PR
// ---------------------------------------------------------------------------

/**
 * Only the shape a BugBoss agent can produce. `prUrls` is whatever the model
 * put there, so anything that is not a pull request url is left unanswered
 * rather than guessed at.
 */
const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** GitHub says `closed` for a merged PR too, so `merged_at` is the difference. */
interface PullRequestBody {
  state?: string;
  merged_at?: string | null;
}

const PR_STATE_TIMEOUT_MS = 5_000;

/**
 * Reads whether each PR merged, for the closing report.
 *
 * Deliberately per-url and deliberately forgiving: a report is a notification
 * on an already-committed transition, so a PR GitHub will not answer for is
 * left out of the result and rendered as "state not known". Saying a PR
 * merged when it did not is the one outcome worth avoiding here.
 */
export const createPrStateReader = (
  installationToken: () => Promise<string>,
): PrStateReader => ({
  states: async (urls) => {
    const token = await installationToken();
    const found: Record<string, ReportPr["state"]> = {};
    await Promise.all(
      urls.map(async (url) => {
        const parsed = PR_URL.exec(url.trim());
        if (!parsed) return;
        const [, owner, repo, number] = parsed;
        try {
          const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
            {
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "x-github-api-version": "2022-11-28",
              },
              signal: AbortSignal.timeout(PR_STATE_TIMEOUT_MS),
            },
          );
          if (!res.ok) {
            // 401, 403 and 404 are not this PR's bad luck. A rotated private
            // key, a suspended installation, or an App that was never put on
            // the repository will answer the same way for every PR on every
            // incident until a human changes something -- and GitHub masks a
            // repository an installation cannot see as 404 rather than 403,
            // which is the same trap `agent/rerun.ts` has to explain to the
            // agent. A 5xx is weather: the next report will be fine. Only the
            // first kind is a failure nobody asked for.
            const durable =
              res.status === 401 || res.status === 403 || res.status === 404;
            (durable ? alarm : log)("pr_state_unavailable", {
              url,
              status: res.status,
            });
            return;
          }
          const body = (await res.json()) as PullRequestBody;
          found[url] = body.merged_at
            ? "merged"
            : body.state === "open"
              ? "open"
              : body.state === "closed"
                ? "closed"
                : null;
        } catch (err) {
          // Left absent, which renders as "state not known" -- but said out
          // loud, because a report that quietly stops naming PR outcomes
          // reads exactly like a report for an incident that opened none.
          //
          // The bound firing is the bound doing the job it was given, so it
          // is news about this one request and nothing more. Anything else
          // thrown here is a request that never got an answer for a reason
          // nobody chose, and is worth waking someone for on the same
          // grounds as a 401 above.
          const name = (err as { name?: string }).name;
          const transient = name === "TimeoutError" || name === "AbortError";
          (transient ? log : alarm)("pr_state_unavailable", {
            url,
            error: String(err),
          });
        }
      }),
    );
    return found;
  },
});

// ---------------------------------------------------------------------------
// The PR watcher's one read
// ---------------------------------------------------------------------------

const PR_WATCH_FIELDS = `url state mergedAt closedAt
  mergedBy { login }
  mergeCommit { oid }
  headRefOid
  commits(last: 1) { nodes { commit { oid committedDate } } }
  reviews(last: 30) { nodes { author { __typename login } state body submittedAt url commit { oid } } }
  comments(last: 50) { nodes { author { __typename login } body updatedAt url } }`;

const PR_WATCH_TIMEOUT_MS = 15_000;

interface WatchedPullNode {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: { login: string } | null;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
  commits: { nodes: { commit: { oid: string; committedDate: string } }[] };
  reviews: { nodes: ReviewNode[] };
  comments: { nodes: CommentNode[] };
}

/**
 * One GraphQL request for every watched PR, each under its own alias. One
 * request costs one point of the 5,000 an hour, however many PRs it names,
 * where REST would be three calls a PR. The repo and number are parsed by
 * `parsePr` before they get here, so they are safe to put in the query as
 * literals; a PR GitHub cannot find comes back as an error on its alias and
 * is left out, without costing the others their answer.
 */
export const createPrWatchReader = (
  installationToken: () => Promise<string>,
  fetchImpl: typeof fetch = fetch,
): PrWatchReader => ({
  read: async (refs) => {
    const found = new Map<string, PrObservation>();
    if (!refs.length) return found;
    const query = `query {\n${refs
      .map((ref, index) => {
        const [owner, name] = ref.repo.split("/");
        return `  pr${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${ref.number}) { ${PR_WATCH_FIELDS} } }`;
      })
      .join("\n")}\n}`;
    const token = await installationToken();
    const res = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "bugboss",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(PR_WATCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`GitHub GraphQL answered ${res.status}: ${await res.text()}`), {
        status: res.status,
      });
    }
    const body = (await res.json()) as {
      data?: Record<string, { pullRequest: WatchedPullNode | null } | null> | null;
      errors?: { message: string; path?: (string | number)[] }[];
    };
    if (body.errors?.length) {
      log("pr_watch_partial", { errors: body.errors.map((error) => `${error.path?.join(".") ?? ""}: ${error.message}`) });
    }
    if (!body.data) throw new Error(`GitHub GraphQL returned no data: ${JSON.stringify(body.errors ?? [])}`);
    refs.forEach((ref, index) => {
      const pull = body.data?.[`pr${index}`]?.pullRequest;
      if (!pull) return;
      const head = pull.commits.nodes[0]?.commit;
      found.set(refKey(ref), {
        state: pull.state,
        url: pull.url,
        mergedAt: pull.mergedAt,
        closedAt: pull.closedAt,
        mergedBy: pull.mergedBy?.login ?? null,
        mergeCommit: pull.mergeCommit?.oid ?? null,
        head: pull.headRefOid,
        verdict: latestDelegateVerdict({
          head: pull.headRefOid,
          headCommittedAt: head?.oid === pull.headRefOid ? head.committedDate : null,
          reviews: pull.reviews.nodes,
          comments: pull.comments.nodes,
        }),
      });
    });
    return found;
  },
});
