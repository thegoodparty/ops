# Agent-swarm playground host

## What this is

A record of the files on the manually built EC2 host that runs the
[agent-swarm](https://github.com/desplega-ai/agent-swarm) playground
(v1.163.0). It shows up in Slack as the bot "Swarm". Nothing in this
directory deploys anything. The host was built by hand over SSM; these
files exist so the setup outlives one laptop and can become IaC later.

## Where it runs

- AWS account 333022194791, region us-west-2
- Instance `i-04cc03c17787f5d59`, Elastic IP 52.10.75.185, `swarm.goodparty.org`
- Security group `sg-075cb6173b8b55291`
- Instance role `agent-swarm-host`
- Secrets Manager secret `AGENT_SWARM` with keys `ANTHROPIC_API_KEY`,
  `API_KEY`, `CLICKUP_API_TOKEN`, `GITHUB_TOKEN`,
  `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `SECRETS_ENCRYPTION_KEY`,
  `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`

The stack lives in `/opt/agent-swarm` on the host and is managed by the
`agent-swarm` systemd unit, which runs `up.sh`. `up.sh` renders `.env` from
the secret (`render-env.sh`) and brings up `docker-compose.yml` with the
`tls` profile (Caddy terminates TLS per `Caddyfile`).

## Files

| File | Where it lives on the host |
| --- | --- |
| `docker-compose.yml`, `Caddyfile`, `render-env.sh`, `up.sh` | `/opt/agent-swarm/` |
| `agent-swarm.service` | `/etc/systemd/system/` |
| `global-setup-script.sh`, `apply-global-setup-script.sh` | `/opt/agent-swarm/` |
| `ec2-user-data.sh` | the instance's user data (ran once at first boot) |
| `fill-secrets.sh` | your laptop; interactive, writes the secret |
| `slack-manifest.json` | the Slack app definition, pasted into api.slack.com |
| `soul/SOUL.md`, `soul/IDENTITY.md` | agent profiles, applied through the API |

## How to connect

```sh
aws ssm start-session --region us-west-2 --target i-04cc03c17787f5d59
```

## How to deploy a change to these files

1. Copy the changed file to `/opt/agent-swarm/` on the host over SSM
   (`aws ssm start-session` plus a heredoc, or `scp` through an SSM proxy).
2. `sudo systemctl restart agent-swarm`.

Version bump: `sudo systemctl stop agent-swarm`, edit `AGENT_SWARM_VERSION`
in `render-env.sh`, `sudo systemctl start agent-swarm`. In-flight tasks pause
while the stack is down and resume when it is back.

## Changing agent behaviour without a deploy

- Souls: `PUT /api/agents/{id}/profile` with the contents of `soul/`.
- MCP servers: `/api/mcp-servers`.
- The global `SETUP_SCRIPT` config (runs as root at every worker container
  start): edit `global-setup-script.sh`, run `apply-global-setup-script.sh`
  on the host, then `docker compose restart lead worker-coder worker-reviewer`.

All API calls go to `https://swarm.goodparty.org` with
`Authorization: Bearer $API_KEY` (the `API_KEY` key in the secret).

## Agents

| Role | Id | Model |
| --- | --- | --- |
| lead | `9f8efd62-469d-4067-9dca-24d72b13864b` | claude-opus-5-5 |
| coder | `458bcd6d-4384-4366-83fa-63072ef55eab` | claude-sonnet-5-5 |
| reviewer | `a0799d09-6816-445a-957d-1339b672d38b` | claude-sonnet-5-5 |

## MCP servers

- grafana: the `grafana-mcp` sidecar in the compose file, id
  `b67d4f9a-fe78-49ba-84af-0af708af3c81`
- clickup: hosted OAuth, id `965d7f32-6134-4c00-9911-f13a39047fbf`

## Slack

- Gate: `SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org`. This needs the
  `users:read.email` bot scope, which `slack-manifest.json` includes.
- Home channel: `#swarm-testing` (`C0C6RUJ9VMK`).

## Dashboard

Open https://app.agent-swarm.dev, point it at `https://swarm.goodparty.org`,
and sign in with the `API_KEY` value from the secret.

## AWS access from inside the swarm

The instance role carries an inline policy `agent-swarm-aws-readonly` that
grants read-only CloudWatch, Logs, ECS, ECR, Cost Explorer and Budgets.
Worker containers reach it through IMDS, so the instance's IMDS hop limit is
set to 2. `global-setup-script.sh` installs the AWS CLI into the workers.
