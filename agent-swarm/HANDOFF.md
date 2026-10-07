# Swarm: handoff for productionizing

Written 2026-10-07 for the agent taking over the agent-swarm pilot. Everything
below was verified against the live host or the v1.163.0 source on 2026-10-05
to 2026-10-07. Where something is a guess it says so. `README.md` in this
directory holds operating procedures; this file holds state, decisions and
history. Read both.

## 1. What this is and why it exists

A self-hosted, unmodified deployment of `desplega-ai/agent-swarm` v1.163.0,
surfaced in Slack as the bot **Swarm**. One lead agent (Claude Opus 5.5) takes
work from Slack, delegates to a coder and a reviewer agent (Claude Sonnet 5.5),
runs schedules, reads our systems, and builds internal apps.

Swain's intent, in his words paraphrased from the kickoff on 2026-10-05:

- A general-purpose "power-up" for engineering first, then product and design,
  then the wider org.
- The first business problem is bugs and incidents: semi-automated handling
  now, humans out of the loop eventually, with rigorous measurement. He built a
  purpose-built system for that (BugBoss, `bugboss/` in this repo) and wants to
  test whether a general runtime does the job with far less code we own.
- The value is "no code to teach it": say "every 10 minutes check the latest
  Grafana alerts" or "build me an app that shows lines of code throughput in
  omni" in Slack, and it happens. Schedules, apps and standing access are the
  three capabilities that make that true.
- Proactivity comes from schedules first. A Grafana webhook into the swarm is
  a later step, not done.
- "Delegate" is the brand he likes and the persona he wants. The Slack app is
  called Swarm for now so the existing delegate bot (`delegate/` in this repo)
  is untouched. The lead's soul says it succeeds delegate.
- He explicitly did not want notes from an earlier agent-swarm attempt
  (2026-09-29/30, torn down) used. They are in his Claude memory `attic/`
  folder. This deployment was built fresh from source and docs.

## 2. Decisions made, and who made them

| Decision | Chosen | By | Notes |
| --- | --- | --- | --- |
| Where it runs | Manual EC2, no IaC, account `333022194791` (ops), `us-west-2` | Swain: "manual EC2 for now is fine"; account picked by the agent | Long-term home undecided. The infrastructure account (`394495727159`, `docs/infrastructure-account.md`) excludes "anything the delegate agents need at runtime", so it was not used. |
| Slack identity | New app named Swarm, not the delegate app | Swain | Socket Mode. A Slack app cannot be shared between two systems. Rename later is a display-name change. |
| Model provider | Anthropic API key in a dedicated Anthropic workspace `agent-swarm` with a spend limit | Swain | No Bedrock. No Claude Code OAuth token (incompatible with multi-worker use). |
| GitHub identity | Swain's own fine-grained PAT, 90 days, repos `omni` + `serve-ops`, Contents/PRs/Issues RW, Actions/Metadata R, no Workflows | Swain, "for the playground" | PRs and comments appear as Swain. A machine user is the intended replacement. Token expires around 2027-01-03. |
| Day-one access | GitHub (above), Grafana read-only, ClickUp. Later the same day: AWS read-only (CloudWatch, Logs, ECS, ECR, Cost Explorer, Budgets) | Swain | No S3, no Secrets Manager beyond its own, no writes to AWS. |
| Embeddings | Local `text-embeddings-inference` container (`nomic-embed-text-v1.5`, 512 dims) | Agent, after Swain asked "can we use AWS?" | Bedrock's OpenAI-compatible API has no `/v1/embeddings`. Summaries use the Anthropic key (Haiku fallback). Workflow LLM nodes still need OpenAI/OpenRouter; not configured. |
| Dashboard | Self-hosted SPA at `swarm.goodparty.org`, built from `apps/ui` | Swain: "I'd want the dashboards to be on our urls" | `app.agent-swarm.dev` still works as a fallback (CORS default left in place). |
| Login in front | Not done. Recommended: `oauth2-proxy` with Google, domain `goodparty.org` | Swain asked for "our oauth"; agent recommended Google | Proposal in `docs/sso-proposal.md`. Needs a Google OAuth client from Swain. See section 8. |
| API exposure | Public 443 with bearer-key auth | Agent, same posture as delegate Lambda URL and BugBoss ALB | VPN-only restriction was offered as a stopgap; not applied. |
| Home channel | `#swarm-testing` (`C0C6RUJ9VMK`) | Swain | Also `SLACK_ALERTS_CHANNEL`. Bot replies only where addressed. |
| Access gate | `SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org` | Agent | Requires the `users:read.email` bot scope; Swain added it by hand after the first message was denied. |
| Minio / agent-fs | Omitted | Agent | Not required; disables "Comb" (file outputs browser). Easy to add. |
| Caddy, TLS | Caddy with Let's Encrypt HTTP challenge on port 80 | Agent | If 80/443 are ever restricted, switch to the DNS challenge. |

## 3. AWS inventory (account 333022194791, us-west-2)

Everything is tagged `Name=agent-swarm`, `Environment=infra`, `Project=agent-swarm`.

| Resource | Id / value |
| --- | --- |
| EC2 instance | `i-04cc03c17787f5d59`, m6a.xlarge (4 vCPU, 16 GB), AL2023 `ami-0d53cc9bd365ad65b`, 120 GB gp3 encrypted root, IMDSv2 required, **hop limit 2** (containers need it to assume the role), subnet `subnet-b61a32fd`, default VPC `vpc-12fb466a`, us-west-2a |
| Elastic IP | `52.10.75.185`, `eipalloc-0041bc8ffac0a5efd`. Adopted: it was an unassociated, untagged orphan because the account was at its 130-EIP limit. Quota increase to 160 was requested and is **APPROVED**; a fresh EIP can now be allocated if wanted. |
| Security group | `sg-075cb6173b8b55291`: inbound tcp 80 and 443 from `0.0.0.0/0`. No 22. |
| IAM role + instance profile | `agent-swarm-host`. Managed: `AmazonSSMManagedInstanceCore`. Inline `agent-swarm-host-inline`: `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:us-west-2:333022194791:secret:AGENT_SWARM*`, `logs:*` write on `/agent-swarm/*`. Inline `agent-swarm-aws-readonly`: read-only CloudWatch, Logs (incl. Insights queries), ECS, ECR, Application Auto Scaling describe, Cost Explorer, Budgets, CUR describe, Pricing. Documents in `iam/`. |
| Route53 | `swarm.goodparty.org` A → `52.10.75.185`, zone `Z10392302OXMPNQLPO07K` |
| Secrets Manager | `AGENT_SWARM` (`arn:aws:secretsmanager:us-west-2:333022194791:secret:AGENT_SWARM-3S3N74`). Keys: `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `GITHUB_TOKEN`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `CLICKUP_API_TOKEN` (copied from the `DELEGATES` secret), `API_KEY` (operator bearer, generated), `SECRETS_ENCRYPTION_KEY` (generated; losing it loses every secret the swarm encrypted in its DB). |
| Logs | CloudWatch Logs `/agent-swarm/containers` via the awslogs driver, one stream per container, 30 days. |
| Backups | DLM policy `agent-swarm-snapshots`: nightly instance snapshot at 10:00 UTC, 14 kept. State is the `agent-swarm_swarm_api_data` Docker volume (SQLite + `.page-session-secret`) plus the encryption key in the secret. |
| Access | `aws ssm start-session --region us-west-2 --target i-04cc03c17787f5d59`. No SSH key exists. |

Not in AWS but part of the deployment:

- Slack app **Swarm**, app id `A0C7RNR4N4Q`, bot user `U0C6ZA542JD`, bot id `B0C6R5B21V1`, workspace `TG1ARMPK5`. Created by Swain from `slack-manifest.json`, plus `users:read.email` added by hand (the manifest in this repo now includes it). Slash commands `/agent-swarm-status` and `/agent-swarm-help` are hardcoded in agent-swarm.
- Anthropic workspace `agent-swarm` (Swain created it; spend limit set by him).
- Grafana service account `agent-swarm` (Viewer) with token `agent-swarm-host`, created by Swain in the UI (the existing MCP token lacked `serviceaccounts:create`).
- ClickUp: the hosted MCP at `https://mcp.clickup.com/mcp` authorized by Swain via OAuth (token has `read write`, no refresh token, no expiry reported). Also `CLICKUP_API_TOKEN` in worker env as a fallback.
- GitHub: Swain's fine-grained PAT (section 2).

## 4. Host layout and the compose stack

`/opt/agent-swarm/` on the host, owned by `ec2-user`. Every file except `.env` and `ui-dist/` comes from `host/` in this directory and is installed by the SSM association on every deploy (README, "How it deploys").

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Services: `api`, `lead`, `worker-coder`, `worker-reviewer`, `tei`, `grafana-mcp`, `caddy` (profile `tls`). Images pinned (`AGENT_SWARM_VERSION=1.163.0`, `caddy:2.11.4@sha256`, `text-embeddings-inference:cpu-1.9`). `grafana/mcp-grafana` is pinned by digest. `api` binds `127.0.0.1:3013` only; no worker ports; no Docker socket anywhere. |
| `render-env.sh` | Reads `AGENT_SWARM` from Secrets Manager via the instance role, merges with static values, writes `.env` (mode 600). Refuses if any secret value is `TODO`. Run after any secret change. |
| `up.sh` | `render-env.sh` then `docker compose --profile tls up -d --remove-orphans`. |
| `agent-swarm.service` | systemd oneshot, enabled. `start` = `up.sh`; `stop` = `docker compose down` (triggers the API drain). |
| `Caddyfile` | `swarm.goodparty.org`: API prefixes (`/api/*`, `/p/*`, `/@swarm/*`, `/mcp`, `/mcp-user`, `/health`, `/status`, `/docs*`, `/openapi.json`, `/x/*`, `/ping`, `/close`) → `api:3013`; everything else serves `/srv/ui` with SPA fallback. `Caddyfile.bak-20261005-214352` is the pre-dashboard version. |
| `global-setup-script.sh`, `apply-global-setup-script.sh` | agent-swarm's admin `SETUP_SCRIPT` global config (id `9a537fcc-5b05-4973-9379-3dd208db93f1`). Runs as root at every agent container start. Installs AWS CLI v2 once into the persistent `swarm_shared` volume and relinks `/usr/local/bin/aws`. Edit the script, run the apply script, restart the agents. |
| `ui-dist/` (host only) | Built dashboard, buildId `f1c9398ccf0be33f`. Mounted read-only into caddy at `/srv/ui`. `build-ui.sh` rebuilds it when `ui-dist/.agent-swarm-version` differs from `AGENT_SWARM_VERSION`. |

Key env (names only; see `render-env.sh` and the compose file for the full set):

- API: `NODE_ENV=production` (Bun defaults to `development`, which **silently blocks Slack Socket Mode**), `CAPABILITIES` unset (defaults include scheduling, pages, slack, mcp, kv, memory, repo), `ALLOW_PRIVATE_NETWORK_URLS=true` (needed to register `http://grafana-mcp:8000/mcp`), `GITHUB_DISABLE=true` (no inbound GitHub webhooks), `SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org`, `SLACK_ALERTS_CHANNEL=C0C6RUJ9VMK`, `APP_URL=https://swarm.goodparty.org`, `MCP_BASE_URL` and `PUBLIC_MCP_BASE_URL=https://swarm.goodparty.org`, `EMBEDDING_API_BASE_URL=http://tei:80/v1`, `EMBEDDING_API_KEY=local`, `EMBEDDING_MODEL=nomic-embed-text-v1.5`, `API_DRAIN_MAX_MS=30000`, `SECRETS_ENCRYPTION_KEY` via env (not a file secret).
- Agents (shared `x-worker-env` anchor): `HARNESS_PROVIDER=claude`, `ANTHROPIC_API_KEY`, `MODEL_OVERRIDE` as a **bare model id** (`claude-opus-5-5` lead, `claude-sonnet-5-5` workers), `MCP_BASE_URL=http://api:3013`, `APP_URL`, `GITHUB_TOKEN`, `GITHUB_NAME=Swarm`, `GITHUB_EMAIL=swarm@goodparty.org`, `CLICKUP_API_TOKEN` and `CLICKUP_API_KEY`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `GRAFANA_URL`. Agent ids are pinned in env so they survive recreation.
- `grafana-mcp`: pinned by digest; `-t streamable-http --address 0.0.0.0:8000 --allowed-hosts grafana-mcp:8000,grafana-mcp` (it rejects non-loopback Host headers otherwise). It has **no caller auth**; only the compose network reaches it.

Resource use on 2026-10-07: 15 GB of 120 GB disk, 2.9 GB of 15.6 GB RAM. TEI holds about 1.85 GB.

## 5. State inside the swarm (SQLite, not in git)

This is what a rebuild has to recreate or restore. Ids as of 2026-10-07.

**Agents** (ids pinned in compose): Lead `9f8efd62-469d-4067-9dca-24d72b13864b` (isLead), Coder `458bcd6d-4384-4366-83fa-63072ef55eab`, Reviewer `a0799d09-6816-445a-957d-1339b672d38b`. Templates `official/lead`, `official/coder`, `official/reviewer`.

**Lead persona**: `soul/SOUL.md` and `soul/IDENTITY.md` in this directory, installed via `PUT /api/agents/{lead}/profile` (3,130 and 3,215 chars). The lead may have edited them since (it is told to self-correct); read the live versions from `GET /api/agents/{lead}` before overwriting.

**MCP servers** (scope swarm, installed on all three agents): `grafana` `b67d4f9a-fe78-49ba-84af-0af708af3c81` (static, sidecar); `clickup` `965d7f32-6134-4c00-9911-f13a39047fbf` (OAuth, 61 tools).

**Global config**: `SETUP_SCRIPT` (above), `SWARM_ORG_NAME`, telemetry keys agent-swarm writes itself. Per-agent `AGENT_MAX_TASKS`.

**Schedules** (all `agent-task`): 8 enabled as of 2026-10-07: `omni-merged-prs-refresh` (23:55 UTC daily, created by the lead for the app), `clickup-swain-snark` (every 15 min, 07:00 to 20:00 PT, weekdays), `daily-org-changes-summary` (08:00 ET weekdays), `daily-usage-summary-slack` (07:30 ET), `daily-swarm-update-check` (09:00 UTC), `daily-workflow-health-audit` (08:00 UTC), `daily-status-report` (02:15 UTC), `daily-blocker-digest` (02:05 UTC). 7 disabled (weekly DORA, harness upgrade check, code health, dependabot triage, GTM review, HN briefing, compounding reflection). Most of the daily audits were created by the lead or seeded by its template, not asked for explicitly; review them with Swain before productionizing since each is model spend and may post to Slack.

**Apps and pages**: app `Omni merged PRs` `09829706-da62-4af8-82c7-1ff889ebb1c3` (the first thing Swain asked it to build; daily heatmap, nightly refresh). Pages (all `authed`): two `Task Failure Audit`, two `Schedule Health Audit`, one `AWS spend, last 14 days`. 100 tasks run, 99 completed, 1 failed.

**Memory**: searchable memory with 512-dim vectors from the local TEI model. Changing the embedding model to a different width means dropping `memory_vec` and re-embedding (`POST /api/memory/re-embed`); same-width swaps silently mix vectors.

## 6. Gotchas learned the hard way

- **Slack gate denies everyone without `users:read.email`.** The repo's own `slack-manifest.json` lacks it; ours has it now. `SLACK_ALLOWED_USER_IDS` is a fast path that needs no scope.
- **OAuth MCP ordering.** A session that gets a 401 from an http MCP server makes Claude Code inside the worker write `~/.claude/mcp-needs-auth-cache.json` and skip that server for days, keyed by server name, even after the token is valid. Authorize first, install second; or recreate the agents after connecting. agent-swarm never clears that cache.
- **IMDS hop limit.** Containers on the bridge network cannot get instance-role credentials with the default hop limit of 1. It is set to 2.
- **No AWS CLI in the worker image.** The `SETUP_SCRIPT` global config is the right place to add tooling; it runs as root at every container start, before the privilege drop.
- **`mcp-grafana` needs `--allowed-hosts`** for a non-loopback bind.
- **`NODE_ENV=development` kills Slack quietly** (`SOCKET MODE BLOCKED` in logs, nothing in Slack).
- **`POST /api/tasks` takes `task`, not `title`/`description`,** and needs `routingReason` (e.g. `human_pinned`) when `agentId` is set.
- **Compose `${VAR:-default}` treats empty as unset.** `render-env.sh` must write real values, not empty strings.
- **cloud-init runs without `HOME`.** The bun installer failed on first boot; `ec2-user-data.sh` now exports `HOME=/root`.
- **The lead will guess URLs if `APP_URL` is empty** on the agents. It posted a dashboard link with no host. Fixed.
- **Agents' own `/workspace/start-up.sh` exits 243** as the worker user (non-fatal warning, `STARTUP_SCRIPT_STRICT=false`). Not investigated.

## 7. agent-swarm facts that constrain the production design

Verified in the v1.163.0 source; cite `src/...` paths from a checkout of the tag.

- Control plane is **SQLite** (`/app/data/agent-swarm-db.sqlite`, WAL), no Postgres option. Backup = copy the volume + the encryption key. Migrations are forward-only.
- **Restart semantics**: compose `stop_grace_period: 60s`; with `API_DRAIN_MAX_MS` set the API refuses new claims on SIGTERM; a task still running after `SHUTDOWN_TIMEOUT` (30s) is superseded into a resume task on the same agent. No per-agent pause or drain endpoint exists. Upgrade = `systemctl stop`, bump `AGENT_SWARM_VERSION`, rebuild `ui-dist`, `systemctl start`.
- **GitHub**: workers push with a static `GITHUB_TOKEN`; the GitHub App env (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`) is inbound-reactions only, so the delegate GitHub App cannot be reused for pushes without a credential-helper workaround. **No repo allowlist**: the token's scope is the only fence. Branch protection is what makes "never merge" true.
- **Slack**: Socket Mode only (HTTP receiver not implemented). One bot token per swarm; agents differ by display name via `chat:write.customize`. Thread replies route to the active worker; `@mention` goes to the lead.
- **Auth**: single bearer. `API_KEY` = operator (bypasses RBAC). `aswt_*` per-user tokens exist (`POST /api/users/{id}/mcp-tokens`) and the dashboard accepts them. RBAC has `admin` and `requester` roles but no UI/API to assign them; everyone is admin. **The API does not read proxy identity headers** (`SSO_TRUSTED_HEADER` is "proposed, not implemented"), so oauth2-proxy can gate but cannot log users in.
- **Pages/apps**: `authed` pages need a `page_session` cookie minted by a bearer-authed launch; `public` and `password` modes exist. Apps are `/api/apps*` routes on the bearer principal. Served same-origin; SPA routes and API prefixes do not collide.
- **Webhook ingress**: `POST /api/webhooks/{workflowId}` (HMAC/shared-token when configured) starts a workflow; `POST /api/tasks` with the operator key creates tasks and has no idempotency. A Grafana alert hook would be a workflow with an `agent-task` node.
- **Models**: `MODEL_OVERRIDE` is passed verbatim to `claude --model` on the claude harness. `modelTier` (`smol|regular|smart|ultra`) via `MODEL_TIER_MAP` is the provider-agnostic alternative. Session summaries/memory rating use OpenRouter → Anthropic → OpenAI in that precedence; workflow LLM nodes accept only `openrouter`/`openai`.
- **Images**: worker is 5.4 GB unpacked (full toolchain + Playwright). `pull_policy: always` was removed since the tag is pinned.

## 8. Productionization status (updated 2026-10-07)

Account: stays in `333022194791`, where it already ran. Revisit only if the
long-term home moves.

Done in the PR that adopted the host into Pulumi:

1. **Infrastructure as code.** `deploy/components/agent-swarm.ts` in the `ops`
   stack imports the instance, EIP, security group, role, instance profile,
   inline policies and DNS record, and protects the stateful ones. Host files
   live in `host/` and reach the host through S3 and an SSM association on
   every deploy; `pulumi up` waits for it. The secret stays clickops.
2. **Backups.** Nightly DLM instance snapshot, 14 kept.
5. **Observability.** Container logs to CloudWatch; a minutely health timer
   reports `ApiHealthy`, `PublicHealthy`, `DiskUsedPercent`; five alarms post
   to `#swarm-testing` through `agent-swarm-alarm-notifier`; EC2 status
   checks recover or reboot automatically. Anthropic spend stays a console
   read on the `agent-swarm` workspace.
6. **`grafana/mcp-grafana` pinned** to the digest that was running. No bearer
   added in front of it: only the compose network reaches it.
9. **Version bumps** are a one-line PR (README, "Upgrade agent-swarm"); the
   dashboard rebuilds itself when the version changes.
10. **Cleanups.** `Caddyfile.bak-*`, the stale `/opt/agent-swarm/src` clone
   and the old unit copy are removed by `install.sh`; `.worktrees/` is in
   `.gitignore`.

Built and waiting on Swain:

3. **Login.** oauth2-proxy and the SSO Caddy routes are in place and switch
   on when the secret holds the three `OAUTH2_PROXY_*` keys. Needs a Google
   OAuth client (README, "Google login"). A hand-out link carrying an
   `aswt_` token passes through Google's `state` on an unauthenticated
   visit, so hand tokens out separately once login is on.
4. **GitHub machine user.** Needs a bot account in `gp-contrib`. Rotate
   Swain's PAT before 2027-01-03 regardless.
7. **Schedules.** 8 enabled, 7 disabled; most daily audits were seeded by the
   lead's template, not asked for. Swain decides which stay.

Not started, by choice:

8. **Grafana ingress**: a workflow with a webhook trigger plus a second
   contact-point integration, when proactivity beyond schedules is wanted.

## 9. Where everything the agent wrote lives

- **This directory** (`agent-swarm/` on branch `feat/agent-swarm-host`, draft PR [#245](https://github.com/thegoodparty/ops/pull/245)): compose, Caddyfile, scripts, systemd unit, Slack manifest, EC2 user-data, `fill-secrets.sh`, the soul files, `README.md` (procedures), this file, `docs/sso-proposal.md`, `iam/` (role trust, inline policies). Nothing here is application code; it is config.
- **On the host** `/opt/agent-swarm/`: the same files plus `.env` (rendered, never commit), `ui-dist/`, `src/`.
- **Pilot guide for users** (Claude artifact, private, Swain owns it): https://claude.ai/artifact/S1oPLMimpwCfGuN2f5sEzu . Source HTML was in the job's tmp dir and is not in git; the content is a prose version of sections 1 to 7.
- **Swain's Claude memory** (`~/.claude/projects/-Users-swain-Repos-thegoodparty-omni/memory/swarm-playground-2026-10.md`): a shorter record of the same facts for his future sessions. `memory/attic/agent-swarm-*.md` is the earlier attempt he asked not to be used.
- **Not in git** (ephemeral, in a Claude job tmp dir that is deleted with the job): SSM helper scripts, the read-only IAM policy JSON (copied to `iam/` here), probe scripts. Nothing of value that is not also in this directory or on the host.
- **No changes were made to omni, gp-api, or any product repo.** The AWS side lives in `deploy/components/agent-swarm.ts`; nothing in `delegate/` or `bugboss/` was touched.

## 10. Working with Swain on this

From his standing instructions, the parts that bit during this build: lead with what changed and what he must decide; never merge a PR he did not name; never ask for AWS credentials or console access (he has admin SSO and ran the AWS steps himself through the agent); secrets never pass through chat (he fills Secrets Manager from his own terminal; `fill-secrets.sh` is how); plain English, sentence case, no em dashes, no emoji. When unsure and the cost is low, decide and tell him the assumption in one line.
