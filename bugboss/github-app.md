# The GitHub App BugBoss runs as

This is the counterpart to [`slack-app-manifest.yaml`](./slack-app-manifest.yaml),
and it exists for the same reason: so the permissions are reviewable and the
next person does not have to reverse-engineer them from the code — or, worse,
find out what the App cannot do when an agent is mid-incident.

**Nothing here is applied by anything.** A GitHub App's permissions are
clickops. There is a manifest format, but it only applies at *creation*, so
there is no file to paste into an App that already exists. Changing this
document changes nothing until somebody makes the same change in the App
settings. What it buys is that the next widening arrives as a diff with a
reason next to it, instead of as a setting somebody changed once and nobody
can account for.

- **App:** `bugboss-gp`, owned by the `thegoodparty` organisation.
- **Settings:** <https://github.com/organizations/thegoodparty/settings/apps/bugboss-gp>
- **Installation:** <https://github.com/organizations/thegoodparty/settings/installations>
- **Recorded:** 2026-09-27, from the live permission set as the API reports it.

## What it is for

Credentials, and nothing else. BugBoss receives no GitHub webhooks — the
ingress handles Grafana, Slack and humans ([`ingress/`](./ingress/)) and there
is no GitHub route — so the App subscribes to no events and has no webhook URL
that matters. All it does is mint installation tokens, for two holders:

- **The incident agent**, as `GITHUB_TOKEN` and `GH_TOKEN` for `gh` and `git`.
- **The Boss**, in the composition root: one token source, shared by the
  closing report's PR-state reader and the Boss's `gh` tool
  ([`slack/gh.ts`](./slack/gh.ts)), which runs `gh` with that token for
  whatever the model asks of GitHub. The token is not scoped down for it:
  the Boss gets what an agent gets, so "who made this PR" is something it
  looks up rather than asks a person to paste. `gh auth`, `alias`,
  `extension` and `config` are refused in code, because they print the
  token or run another program; see [`slack/CLAUDE.md`](./slack/CLAUDE.md).

The agent gets the App's *credentials* rather than a token minted at launch,
because an installation token lasts an hour and an incident can run for a day.
[`github.ts`](./github.ts) does the minting; `keepGitHubTokenFresh` in
[`agent/run.ts`](./agent/run.ts) refreshes the environment in place every
twenty minutes, and a git credential helper presents the current one so no
token is ever written into `.git/config`.

## Permissions

`actions: write` is the one line here that is **not live yet**. Everything else
is what the App holds today. Granting it is the human step in "Changing a
permission" below, and until somebody does it `rerun_ci` returns a 403 that
names the missing permission rather than quietly falling back to asking.

| Permission | Level | What uses it |
| --- | --- | --- |
| `metadata` | read | Mandatory for every App. Nothing calls it directly. |
| `contents` | write | The agent pushes its fix branch. `git push` through the credential helper configured in `agent/run.ts`. |
| `pull_requests` | write | `gh pr create`, `gh pr comment` (including the bare `delegate review` that fires the reviewer), and reading review state. Driven by the ship-pr skill the prompt points the agent at. The Boss's `gh` reads PRs, their files and reviews with it. |
| `actions` | **write** (requested) | Reading workflow runs and jobs to tell whether a PR is green (`gh run list`, `gh run view`) needs only `read`. Re-running a run's failed jobs — `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`, via [`agent/rerun.ts`](./agent/rerun.ts) — needs `write`. |
| `checks` | read | `gh pr checks` and the `statusCheckRollup` field of `gh pr view --json`, for the Boss and for agents watching CI. |
| `issues` | read | `gh issue view` on a private repository, which `pull_requests` does not cover. |
| `deployments` | read | Granted, with no caller in this repo. Kept because a read permission nobody uses is cheaper to leave than to remove and rediscover; drop it the next time anyone is in the settings page anyway. |

`actions` is `read` today, and `read` is exactly enough to watch two E2E jobs
fail and reason about whether they are a flake while being unable to act on the
conclusion. That is where incident 5's agent stopped, and asking a human to
press the button was the honest answer to a missing permission rather than a
failure of initiative. See [`agent/rerun.ts`](./agent/rerun.ts) for why the
capability is bounded in code rather than handed over whole — an agent that can
re-run will otherwise re-run every time it sees red, which is retry-as-a-fix
with a bigger budget.

## What it deliberately does not have

- **No `administration`.** Branch protection is what stops an agent merging to
  `main`, and an App that could edit branch protection could remove the thing
  that stops it. `agent/CLAUDE.md` calls this the actual control; the prompt
  rule is only there to save turns.
- **No `checks: write`.** The agent does not publish check runs. Re-running
  needs `actions: write` and nothing from `checks`.
- **No `secrets`, `actions_variables`, `environments` or `workflows`.** An
  agent that could edit a workflow file or an environment secret could change
  what CI proves, which is the opposite of the point.
- **No `members`, `organization_administration`.** Nothing here touches org
  membership.

## What `actions: write` does and does not buy

It is enough for the re-run itself. `rerun-failed-jobs` needs `actions: write`
and nothing else — not `checks: write`, not anything from `contents` beyond
what the agent already has — and re-running produces a new **attempt** of the
same run id rather than a new run, which is what `rerun_ci` reads back as
`run_attempt` to enforce its one-attempt bound.

It is not enough for every red check, and `rerun_ci` refuses these by name
rather than letting the agent discover them as an undocumented 403:

- **A run parked on an approval.** GitHub's own docs claim only `201` for this
  endpoint and document no failure at all, so whether a re-run bypasses an
  approval gate is not something anyone can read — the one public claim that
  it does comes from a code path its own maintainers later found had never
  executed. So BugBoss refuses rather than finding out on a live pull request.
  Approval is a different endpoint anyway: `POST .../runs/{id}/approve` for a
  fork pull request (`actions: write`), `POST .../pending_deployments` for an
  environment protection rule (`deployments: write`, which the App does not
  have). The tool tells the agent to ask a human and says which run.
- **A run with no failed jobs.** `success`, `cancelled` and `skipped` have
  nothing to re-run. Only `failure` and `timed_out` do.
- **A run over about a month old**, which GitHub refuses outright, and a run
  still in progress. Both come back as a 403 with a plain-English message and
  **no** `X-Accepted-GitHub-Permissions` header, which is how the tool tells
  them apart from a real permission failure. It does not key on the message
  text: those strings are undocumented and have changed.

A **404** is also a permission symptom here. GitHub masks a private resource an
installation cannot see, so an App that is not on a repository is told the
repository does not exist rather than that it is forbidden. The tool names the
installation as one of the three things a 404 can mean.

**The approval gate now reaches our own pull requests.** Since 2026-06-11
GitHub applies it to pull requests opened by a bot even on a same-repo branch,
and the agent opens its PRs as this App. So `action_required` is a case BugBoss
should expect on its own work, not a fork-only curiosity.

`POST .../runs/{id}/approve` is available to a GitHub App with `actions: write`
— there is no human-only restriction. It is deliberately **not** used. An agent
that can approve the workflow run on a pull request is an agent that can decide
its own code gets to run, which is the gate, not a step before it.

## Installation scope, honestly

`repository_selection` is `all`. The App is installed on **every repository in
the `thegoodparty` organisation**, present and future, which means
`contents: write` and now `actions: write` apply to all of them — not just to
`omni`, which is the only repo the agent is ever pointed at.

That is wider than the work needs. It is recorded here rather than quietly
tolerated, and the prompt no longer claims otherwise (it used to tell the agent
its token reached "omni and nothing else", which was not true). Narrowing the
installation to a selected list is a one-click change on the installation page
and the obvious next tightening; it is not part of this change because
narrowing it wrongly breaks an agent mid-incident and that deserves its own
deliberate move.

## Changing a permission

Both steps are a human's, and neither can be done by an agent or from CI.

1. **Request it.** Organisation settings → Developer settings → GitHub Apps →
   `bugboss-gp` → **Permissions & events** → set the permission → **Save
   changes**. Direct link:
   <https://github.com/organizations/thegoodparty/settings/apps/bugboss-gp/permissions>
2. **Accept it on the installation.** A widened permission does **not** take
   effect on its own. GitHub raises a pending request that an organisation
   owner has to approve, at
   <https://github.com/organizations/thegoodparty/settings/installations> →
   the `bugboss-gp` installation → **Review request** → **Accept new
   permissions**. Until that click, tokens keep the old permission set and the
   API keeps returning 403.

Nothing needs redeploying afterwards. The App id, private key and installation
id are unchanged, and the next token the agent mints carries the new
permissions — tokens live an hour, and `keepGitHubTokenFresh` re-mints every
twenty minutes, so an agent that is already running picks it up without a
restart.

A permission that is granted but not written down here is the state this file
exists to prevent. Change both.
