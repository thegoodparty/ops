# Agent-swarm host

## What this is

The deployment of [agent-swarm](https://github.com/desplega-ai/agent-swarm)
v1.163.0 that shows up in Slack as the bot "Swarm" and serves its dashboard
at https://swarm.goodparty.org. One EC2 host runs the whole stack in Docker
Compose. State, decisions and history are in `HANDOFF.md`; this file is how
to operate it.

## How it deploys

The AWS side is Pulumi, in `deploy/components/agent-swarm.ts` in the `ops`
stack, and ships with every merge to `main` like the rest of `deploy/`. The
host itself was built by hand and is adopted with `import`; the instance,
its Elastic IP, role and security group are `protect`ed.

Everything in `host/` is the contents of `/opt/agent-swarm/` on the host
(`host/systemd/` goes to `/etc/systemd/system/`). On deploy, Pulumi uploads
`host/` to `s3://agent-swarm-config-333022194791/host/` and an SSM
association (`agent-swarm-host-sync`) runs `host/install.sh` on the instance
whenever any file changed. `install.sh` copies the files in place, installs
the systemd units, and runs `up.sh`, which renders `.env` from the secret,
rebuilds the dashboard if the version changed, and runs
`docker compose up -d`. Compose only recreates the containers whose
definition changed. `pulumi up` waits for the association, so a host that
fails to take a change fails the deploy. Run output lands in
`s3://agent-swarm-config-333022194791/ssm-output/`.

So: to change the host, edit `host/` and merge. Do not edit files on the
host; the next deploy overwrites them.

## Where it runs

- AWS account 333022194791, region us-west-2
- Instance `i-04cc03c17787f5d59`, Elastic IP 52.10.75.185, `swarm.goodparty.org`
- Instance role `agent-swarm-host`
- Secrets Manager secret `AGENT_SWARM` (filled by hand, never by Pulumi)
  with keys `ANTHROPIC_API_KEY`, `API_KEY`, `CLICKUP_API_TOKEN`,
  `GITHUB_TOKEN`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `SECRETS_ENCRYPTION_KEY`,
  `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, and optionally the three
  `OAUTH2_PROXY_*` keys that turn on Google login

`fill-secrets.sh` is the interactive way to fill the secret from a laptop.
After a secret change, re-run `up.sh` on the host (or merge any host change).

## Connect

```sh
aws ssm start-session --region us-west-2 --target i-04cc03c17787f5d59
```

## Upgrade agent-swarm

1. Edit `AGENT_SWARM_VERSION` in `host/render-env.sh`. It is the only place
   the version lives.
2. Merge. `up.sh` sees the dashboard marker
   (`ui-dist/.agent-swarm-version`) is stale and rebuilds the UI from the new
   tag, then compose pulls the new images and recreates every agent-swarm
   container. The API drains for up to 30 seconds; a task still running is
   superseded into a resume task on the same agent.
3. Check: `/health` is 200, the three agents show idle in the dashboard, and
   Swarm answers a mention in `#swarm-testing`.
4. If an OAuth MCP server (ClickUp) was reconnected during the upgrade,
   delete `~/.claude/mcp-needs-auth-cache.json` in each agent container, or
   Claude Code skips that server for days (`HANDOFF.md` section 6).

Read the release notes for migrations before bumping; SQLite migrations are
forward-only, so the way back is the latest snapshot.

## Backups and restore

Data Lifecycle Manager snapshots the instance every night at 10:00 UTC and
keeps 14 (`agent-swarm-snapshots`, tagged `Name=agent-swarm`). The state
that matters is the `agent-swarm_swarm_api_data` volume (SQLite, WAL) on the
root disk. A snapshot is crash-consistent, which SQLite recovers from like a
power cut.

The swarm encrypts the secrets it stores in SQLite with
`SECRETS_ENCRYPTION_KEY`. That key lives only in the `AGENT_SWARM` secret.
A snapshot without the key restores everything except those secrets.

To restore: stop the stack (`sudo systemctl stop agent-swarm`), create a
volume from the snapshot, and either swap it in as the root volume (EC2
"Replace root volume" with the snapshot) or attach it and copy
`/var/lib/docker/volumes/agent-swarm_swarm_api_data/` across. Start the
stack.

## Monitoring

- Container logs go to CloudWatch Logs `/agent-swarm/containers`, one
  stream per container, 30 days. `docker compose logs` on the host still
  works.
- `agent-swarm-health.timer` reports three metrics every minute to the
  `AgentSwarm` namespace: `ApiHealthy` (local `/health`), `PublicHealthy`
  (`https://swarm.goodparty.org/health` through Caddy and TLS) and
  `DiskUsedPercent`.
- Alarms post to `#swarm-testing` as the Swarm bot, through SNS topic
  `agent-swarm-alarms` and Lambda `agent-swarm-alarm-notifier`:
  - `agent-swarm-api-unhealthy`: API down 5 minutes, or the host stopped
    reporting
  - `agent-swarm-public-unhealthy`: the public URL down 5 minutes
  - `agent-swarm-disk-80`: root disk over 80%
  - `agent-swarm-system-check`: EC2 recovers the instance automatically
  - `agent-swarm-instance-check`: EC2 reboots the instance automatically
- Anthropic spend: the `agent-swarm` workspace in the Anthropic console,
  which has its own spend limit.

## Google login

Off until the secret holds `OAUTH2_PROXY_CLIENT_ID`,
`OAUTH2_PROXY_CLIENT_SECRET` and `OAUTH2_PROXY_COOKIE_SECRET` (all three or
none; `render-env.sh` refuses a partial set). Then `up.sh` starts
`oauth2-proxy` and Caddy puts every browser path behind Google sign-in for
`goodparty.org`. MCP, `/health`, webhooks and OAuth callbacks stay open
because their callers carry their own credentials. Design and bypass list:
`docs/sso-proposal.md`.

To turn it on:

1. Google Cloud console, APIs and services, Credentials, Create OAuth client
   ID, type Web application. Authorized JavaScript origin
   `https://swarm.goodparty.org`, redirect URI
   `https://swarm.goodparty.org/oauth2/callback`. Make the consent screen
   Internal so only `goodparty.org` accounts can sign in.
2. `./fill-secrets.sh --sso` from this directory. It asks for the client id
   and secret and generates the cookie secret.
3. On the host, `cd /opt/agent-swarm && ./up.sh` (or merge any host change).

Login only gates. The API reads no identity from it, so people still paste
a bearer into the dashboard's setup page: the shared `API_KEY`, or better a
per-user `aswt_` token an admin mints with
`POST /api/users/{id}/mcp-tokens`. Hand the token out on its own, not inside a
`?apiKey=` link: an unauthenticated visit carries the whole link through
Google's sign-in.

## Changing agent behaviour without a deploy

- Souls: `PUT /api/agents/{id}/profile` with the contents of `soul/`.
- MCP servers: `/api/mcp-servers`.
- The global `SETUP_SCRIPT` config (runs as root at every worker container
  start): edit `host/global-setup-script.sh`, merge, then on the host run
  `./apply-global-setup-script.sh` and
  `docker compose restart lead worker-coder worker-reviewer`.

API calls go to `https://swarm.goodparty.org` with
`Authorization: Bearer $API_KEY` (the `API_KEY` key in the secret).

## Agents

| Role | Id | Model |
| --- | --- | --- |
| lead | `9f8efd62-469d-4067-9dca-24d72b13864b` | claude-opus-5-5 |
| coder | `458bcd6d-4384-4366-83fa-63072ef55eab` | claude-sonnet-5-5 |
| reviewer | `a0799d09-6816-445a-957d-1339b672d38b` | claude-sonnet-5-5 |

## MCP servers

- grafana: the `grafana-mcp` sidecar, pinned by digest, id
  `b67d4f9a-fe78-49ba-84af-0af708af3c81`. It has no caller auth; only the
  compose network reaches it and Caddy does not route to it.
- clickup: hosted OAuth, id `965d7f32-6134-4c00-9911-f13a39047fbf`

## Slack

- Gate: `SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org`. This needs the
  `users:read.email` bot scope, which `slack-manifest.json` includes.
- Home channel and alerts channel: `#swarm-testing` (`C0C6RUJ9VMK`).

## AWS access from inside the swarm

The instance role's inline policy `agent-swarm-aws-readonly` grants
read-only CloudWatch, Logs, ECS, ECR, Cost Explorer and Budgets to the
agents. Worker containers reach it through IMDS, so the instance's hop limit
is 2. `host/global-setup-script.sh` installs the AWS CLI into the workers.
The policy documents in `iam/` are what Pulumi applies.

## Rebuilding from nothing

Remove the `import` options and the instance's `protect`, then let Pulumi
create a fresh instance: `ec2-user-data.sh` installs Docker, Compose and bun
on first boot, the association installs `host/`, and `up.sh` builds the
dashboard and starts the stack with the agent ids pinned in `render-env.sh`.
Restore the API volume from a snapshot first, or the swarm starts empty
(`HANDOFF.md` section 5 lists what lives only in SQLite).
