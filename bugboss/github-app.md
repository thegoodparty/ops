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
that matters. All it does is mint installation tokens that the incident agent
uses as `GITHUB_TOKEN` and `GH_TOKEN`.

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
| `pull_requests` | write | `gh pr create`, `gh pr comment` (including the bare `delegate review` that fires the reviewer), and reading review state. Driven by the ship-pr skill the prompt carries. |
| `actions` | **write** (requested) | Reading workflow runs and jobs to tell whether a PR is green (`gh run list`, `gh run view`) needs only `read`. Re-running a run's failed jobs — `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`, via [`agent/rerun.ts`](./agent/rerun.ts) — needs `write`. |
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
