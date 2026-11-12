# delegate-durable

A prototype of Delegate, GoodParty's Slack engineering agent, built on
[Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
(`@earendil-works/pi-durable`, pinned at 1.5.2). It is option B of the
[runtime build shape](https://delegate-runtime-build-shape.artifacts.goodparty.org):
one Node process we own instead of the self-hosted agent-swarm in
`../agent-swarm/`. It is not deployed and not wired into Pulumi.

One process opens one Pi Durable `Harness` over SQLite at
`$DELEGATE_DATA/agent.sqlite`. Conversations, model turns, tool calls,
routes, schedules and spend are all committed there, so a restart picks up
where the last process stopped (`harness.resume()`).

## What it does

- Slack (socket mode): answers @mentions, DMs, and any later message in a
  thread it already has a conversation for. It adds :eyes: when it accepts a
  message and posts the final answer in the thread. A message that arrives
  while it is working is submitted as a steer, so it joins the running work
  after the current tool round instead of waiting for the next run.
- GitHub (`POST /webhooks/github`): PR comments (`issue_comment` on a PR and
  `pull_request_review_comment`). A comment on a linked PR goes to that
  conversation; a comment that mentions `@delegate-gp` on an unlinked PR starts
  a conversation keyed to the PR. The answer is posted back as a PR comment.
  Its own comments are ignored by login and by a hidden marker it appends,
  and so are comments from anyone who is not an owner, member or collaborator.
- Schedules: `schedule_create` (cron in UTC, or a one-off `at`),
  `schedule_list`, `schedule_delete`. Each is a durable task that sleeps with
  `sleepUntil`, so it survives restarts. When it fires, its prompt goes to its
  own conversation (or the given Slack thread) and the answer is posted to
  Slack.
- Grounding: each conversation works in its own detached git worktree of omni
  at `$DELEGATE_DATA/worktrees/<conversation id>`, created on first use from
  the warm clone at `$OMNI_REPO` at `origin/main` (no `npm ci`). The system
  prompt is `prompts/delegate.md`, the worktree's `AGENTS.md`, and the list of
  omni skills (name, description, path) from `.claude/skills/*/SKILL.md`.
- Tools: Pi Durable's `read`, `write`, `edit`, `bash`, plus `subagent` (a child
  conversation in the same worktree that returns its answer), `link_pr`, and
  the schedule tools.
- Memory: markdown files in `$DELEGATE_DATA/memory`, read and written with the
  normal file tools. The persona tells the agent to use it.
- Status: `GET /status` returns conversations (with their keys, busy flag and
  cost), live tasks (running, sleeping, ...), schedules, and total cost.
  `GET /healthz` returns 200.

## How routing works

Every inbound event has a key: `slack:CHANNEL:THREAD_TS`,
`github:OWNER/REPO:pr:N`, `schedule:ID`, or `cli:local`. A Pi Durable session
document (`delegate.routes`) maps keys to conversation ids; lookup and creation
happen in one commit, so one key never gets two conversations. Several keys can
point at one conversation: `link_pr` adds a PR, and a schedule's top-level Slack
post adds its thread. Each input records its origin (Slack thread or PR) in its
transcript entry, and an `afterRun` hook posts the answer to every origin in the
run. The Slack message ts or GitHub comment id is the request id, so a
redelivered event is admitted once.

## Run it locally

```sh
cd delegate-durable
npm ci
git clone git@github.com:thegoodparty/omni.git "$DELEGATE_DATA/omni"   # once
npm run cli -- "what does the omni AGENTS.md say about tests?"
npm start                                                              # Slack + HTTP
npm test
```

`npm run cli` submits to the `cli:local` conversation and prints the answer;
it needs no Slack or GitHub settings. The CLI and the service lock the same
data directory, so stop the service before using the CLI against its data.

Environment:

| Variable | Needed by | Default |
| --- | --- | --- |
| `DELEGATE_DATA` | both | cli: `./.data` |
| `OMNI_REPO` | both | `$DELEGATE_DATA/omni` |
| `DELEGATE_MODEL_PROVIDER`, `DELEGATE_MODEL_ID` | both | `anthropic`, `claude-sonnet-5-5` |
| `ANTHROPIC_API_KEY`, or `DELEGATE_AUTH_FILE` | both | pi-ai reads provider keys from the environment; `DELEGATE_AUTH_FILE` points at a pi `auth.json` (for example `~/.pi/agent/auth.json`), whose OAuth tokens it refreshes in place |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | service | |
| `GITHUB_TOKEN` | service | used to post PR comments, and visible to the agent's bash |
| `GITHUB_WEBHOOK_SECRET` | service | |
| `GITHUB_BOT_LOGIN` | service | `delegate-gp[bot]` |
| `GITHUB_MENTION` | service | `@delegate-gp` |
| `DELEGATE_HOME_CHANNEL` | service | where schedules without a channel post; unset, they post nowhere |
| `DELEGATE_ALLOWED_EMAIL_DOMAINS` | service | `goodparty.org`; empty allows everyone |
| `PORT`, `DELEGATE_HTTP_HOST` | service | `3080`, `127.0.0.1` |

The agent's bash does not see `SLACK_*`, `ANTHROPIC_*`, `DELEGATE_AUTH*` or
`GITHUB_WEBHOOK_SECRET`. It does see everything else, including
`GITHUB_TOKEN`, and it can read any file the service user can.

## Create the Slack app

1. https://api.slack.com/apps, Create New App, From a manifest, pick the
   GoodParty workspace, paste `slack-manifest.json`. It creates "Delegate beta"
   in socket mode, separate from the live Delegate app.
2. Basic Information, App-Level Tokens: generate one with
   `connections:write`. That is `SLACK_APP_TOKEN` (`xapp-...`).
3. Install App, Install to GoodParty. The Bot User OAuth Token is
   `SLACK_BOT_TOKEN` (`xoxb-...`).
4. Invite it to a test channel (`/invite @delegate-beta`) and mention it.

## Not done yet, compared with the swarm

- No dashboard: `/status` is JSON only.
- One agent, no roles: there is no lead, coder and reviewer split, and no
  per-role model or memory cap. Subagents share the parent's model and
  worktree.
- No workflows, scripts catalog, KV store, agent-fs, or panel hand-offs.
- Only Slack, GitHub PR comments, and its own schedules start work. No
  ClickUp, Vercel or other triggers, and no MCP servers (Grafana, ClickUp).
- Memory is plain files, with no search beyond `grep`.
- A run that fails (model error, turn limit) posts nothing to Slack; the
  :eyes: stays and the failure is only in `/status` and the logs.
- No sandbox: tools run as the service user on the host.
- No worktree cleanup: worktrees accumulate until removed by hand.
- The model is stored per conversation when it is created; changing
  `DELEGATE_MODEL_ID` applies to new conversations only.
- GitHub replies use a token (`GITHUB_TOKEN`), not the `delegate-gp` App.

## Deploy notes (existing EC2 host)

Not wired into Pulumi. To try it on the swarm host by hand:

1. Install Node 22 on the host if it is not there (the swarm runs Node only
   inside its containers).
2. Check out this branch to `/opt/delegate-durable` and run `npm ci` in
   `/opt/delegate-durable/delegate-durable`.
3. Clone omni to `$DELEGATE_DATA/omni` (for example
   `/var/lib/delegate-durable/omni`) with credentials that can fetch.
4. Write `/etc/delegate-durable.env` (mode 600) with the variables above.
5. Copy `deploy/delegate-durable.service` to `/etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now delegate-durable`.
6. GitHub webhooks need a public route to `/webhooks/github`; put it behind
   the host's Caddy on its own path and keep `/status` private.

Logs go to the journal (`journalctl -u delegate-durable`). Back up
`$DELEGATE_DATA/agent.sqlite` and `memory/`; worktrees can be recreated.
