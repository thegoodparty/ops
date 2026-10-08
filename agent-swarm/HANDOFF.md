# Delegate swarm: handoff for productionizing

Written 2026-10-07 for the agent taking over the agent-swarm pilot, and
updated the same day for its move to the infrastructure account, the
Delegate name, and a fresh start with no state carried over. Everything below was verified against the live host or the
v1.163.0 source on 2026-10-05 to 2026-10-07. Where something is a guess it
says so. `README.md` in this
directory holds operating procedures; this file holds state, decisions and
history. Read both.

## 1. What this is and why it exists

A self-hosted, unmodified deployment of `desplega-ai/agent-swarm` v1.163.0,
surfaced in Slack as **Delegate**. One lead agent, named Delegate (Claude Opus
5.5), takes work from Slack, delegates to a coder and a reviewer agent (Claude
Sonnet 5.5), runs schedules, reads our systems, and builds internal apps. All
three run on the pi harness.

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
- "Delegate" is the brand he likes and the persona he wants. The swarm now
  runs on the existing Delegate Slack app, which takes over from the delegate
  bot (`delegate/` in this repo) in Slack. It started as a separate app named
  Swarm so delegate stayed untouched during the pilot. The lead's soul says it
  succeeds delegate.
- He explicitly did not want notes from an earlier agent-swarm attempt
  (2026-09-29/30, torn down) used. They are in his Claude memory `attic/`
  folder. This deployment was built fresh from source and docs.

## 2. Decisions made, and who made them

| Decision | Chosen | By | Notes |
| --- | --- | --- | --- |
| Where it runs | EC2 in account `394495727159` (infrastructure), `us-west-2`, Pulumi in `deploy-infrastructure/`. Hostname `delegate-swarm.infra.goodparty.org` | Swain | It started as a hand-built host in `333022194791` (the management account) at `swarm.goodparty.org`. `docs/infrastructure-account.md` records why it lives in the infrastructure account. |
| The move | Fresh state, no migration. The old host is torn down once the new one is live | Swain | `host/bootstrap.sh` rebuilds what the repo defines; schedules, apps, pages and memory start empty. |
| State | Docker's whole state on a separate EBS data volume at `/var/lib/docker` | Swain | A replacement instance mounts it and keeps the swarm. `ec2-user-data.sh` formats it only if blank. |
| Slack identity | The existing Delegate app, Socket Mode, without `chat:write.customize` | Swain | Replaces the Swarm app and the delegate bot's use of the Delegate app. Without the scope Slack ignores the per-agent username and emoji agent-swarm sends (the lead's would be a crown), so every message is the Delegate app's own name and icon. |
| Model provider | Anthropic API key in a dedicated Anthropic workspace `agent-swarm` with a spend limit | Swain | No Bedrock. No Claude Code OAuth token (incompatible with multi-worker use). |
| Harness | pi for all three agents, models `anthropic/claude-opus-5-5` (lead) and `anthropic/claude-sonnet-5-5` (workers) | Swain | Set in env by `render-env.sh`, and per agent by `bootstrap.sh`. |
| GitHub identity | A service user's fine-grained PAT, repos `omni` + `ops`, Contents/PRs/Issues RW, Actions/Metadata R, no Workflows, longest lifetime allowed | Swain | Replaces Swain's own 90-day PAT. Commit name and email are placeholders (`Delegate`, `delegate@goodparty.org`) until the user exists. |
| Day-one access | GitHub (above), Grafana read-only, ClickUp. AWS: production read-only through `arn:aws:iam::333022194791:role/delegate-swarm-prod-read` | Swain | Agents assume the role through `host/aws-config`. The api container has no AWS access. |
| Embeddings | Local `text-embeddings-inference` container (`nomic-embed-text-v1.5`, 512 dims) | Agent, after Swain asked "can we use AWS?" | Bedrock's OpenAI-compatible API has no `/v1/embeddings`. Summaries use the Anthropic key (Haiku fallback). Workflow LLM nodes still need OpenAI/OpenRouter; not configured. |
| Dashboard | Self-hosted SPA at `delegate-swarm.infra.goodparty.org`, built from `apps/ui` | Swain: "I'd want the dashboards to be on our urls" | `app.agent-swarm.dev` still works as a fallback (CORS default left in place). |
| Login in front | `oauth2-proxy` with Google, domain `goodparty.org`; built, off until the client exists | Swain asked for "our oauth"; agent recommended Google | The bypass list is the `sso` snippet in `host/Caddyfile`. Needs a Google OAuth client from Swain. See section 8. |
| API exposure | Public 443 with bearer-key auth | Agent, same posture as delegate Lambda URL and BugBoss ALB | VPN-only restriction was offered as a stopgap; not applied. |
| Home channel | `#swarm-testing` (`C0C6RUJ9VMK`) | Swain | Also `SLACK_ALERTS_CHANNEL`. Bot replies only where addressed. |
| Access gate | `SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org` | Agent | Requires the `users:read.email` bot scope; Swain added it by hand after the first message was denied. |
| Minio / agent-fs | Omitted | Agent | Not required; disables "Comb" (file outputs browser). Easy to add. |
| Caddy, TLS | Caddy with Let's Encrypt HTTP challenge on port 80 | Agent | If 80/443 are ever restricted, switch to the DNS challenge. |

## 3. Where things are

### New home: account 394495727159 (infrastructure), us-west-2

Defined in `deploy-infrastructure/` (stack `organization/infrastructure/main`);
instance, volume and address ids are in the stack outputs and the EC2 console.

| Resource | Value |
| --- | --- |
| EC2 instance | AL2023, IMDSv2 required, **hop limit 2** (containers need it to assume the prod-read role) |
| Data volume | Separate EBS volume mounted at `/var/lib/docker` by `ec2-user-data.sh` (the script's `DATA_VOLUME_ID=__DATA_VOLUME_ID__` line is filled in by Pulumi). Holds images and every compose volume. |
| Secrets Manager | `DELEGATE_SWARM`. Created empty by Pulumi, filled by `fill-secrets.sh`, which generates `API_KEY` and `SECRETS_ENCRYPTION_KEY` when they are absent and never replaces them. |
| Config bucket | `delegate-swarm-config-394495727159`: `host/` (deployed files), `ssm-output/` (association runs) |
| Logs | CloudWatch Logs `/delegate-swarm/containers` via the awslogs driver, one stream per container |
| Production read | `arn:aws:iam::333022194791:role/delegate-swarm-prod-read`, assumed by the agents with the instance role's credentials |
| DNS | A record `delegate-swarm.infra.goodparty.org` → the Elastic IP, in the infrastructure account's own zone `infra.goodparty.org` (`deploy-infrastructure/dns.ts`). The `goodparty.org` zone (`Z10392302OXMPNQLPO07K`) in the management account delegates it with one NS record in `deploy/`, added by a follow-up PR (section 8). |
| Access | `aws ssm start-session` with a profile for the infrastructure account (README, "Connect") |

### Old home: account 333022194791, to tear down

Nothing on it is kept. Once the new host is live, delete: instance
`i-04cc03c17787f5d59`, Elastic IP `52.10.75.185`
(`eipalloc-0041bc8ffac0a5efd`), security group `sg-075cb6173b8b55291`, role
and instance profile `agent-swarm-host`, secret `AGENT_SWARM`, log group
`/agent-swarm/containers`, config bucket `agent-swarm-config-333022194791`,
DLM policy `agent-swarm-snapshots` and its snapshots, the old hostname's A
record in the `goodparty.org` zone, the Slack app Swarm, and the pilot's
Grafana service account `agent-swarm`.

### Not in AWS

- Slack: the existing **Delegate** app, reconfigured from `slack-manifest.json`
  (Socket Mode). The old app **Swarm** (`A0C7RNR4N4Q`, bot user
  `U0C6ZA542JD`, workspace `TG1ARMPK5`) goes with the old host. Slash
  commands `/agent-swarm-status` and `/agent-swarm-help` are hardcoded in
  agent-swarm.
- Anthropic workspace `agent-swarm` (Swain created it; spend limit set by him).
- Grafana service account `delegate` (Viewer), token without expiry.
- ClickUp: a service seat's personal API token as `CLICKUP_API_TOKEN`, plus the
  hosted MCP at `https://mcp.clickup.com/mcp`, connected with OAuth in the
  dashboard (README, "Bringing it up", step 6). The token lives in the swarm's
  SQLite, encrypted with `SECRETS_ENCRYPTION_KEY`.
- GitHub: the service user's fine-grained PAT (section 2).

## 4. Host layout and the compose stack

`/opt/agent-swarm/` on the host, owned by `ec2-user`. Every file except `.env` and `ui-dist/` comes from `host/` in this directory and is installed by the SSM association on every deploy (README, "How it deploys"). The compose project name is fixed to `agent-swarm`, so volumes are `agent-swarm_<name>` wherever the files live.

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | Services: `api`, `lead`, `worker-coder`, `worker-reviewer`, `tei`, `grafana-mcp`, `caddy` (profile `tls`). Images pinned (`AGENT_SWARM_VERSION=1.163.0`, `caddy:2.11.4@sha256`, `text-embeddings-inference:cpu-1.9`). `grafana/mcp-grafana` is pinned by digest. `api` binds `127.0.0.1:3013` only; no worker ports; no Docker socket anywhere. |
| `render-env.sh` | Reads `DELEGATE_SWARM` from Secrets Manager via the instance role, merges with static values, writes `.env` (mode 600). Refuses if any secret value is `TODO`. Run after any secret change. |
| `up.sh` | `render-env.sh` then `docker compose --profile tls up -d --remove-orphans`. |
| `agent-swarm.service` | systemd oneshot, enabled. `start` = `up.sh`; `stop` = `docker compose down` (triggers the API drain). `install.sh` leaves it stopped while the secret has no value. |
| `Caddyfile` | `delegate-swarm.infra.goodparty.org`: API prefixes (`/api/*`, `/p/*`, `/@swarm/*`, `/mcp`, `/mcp-user`, `/health`, `/status`, `/docs*`, `/openapi.json`, `/x/*`, `/ping`, `/close`) → `api:3013`; everything else serves `/srv/ui` with SPA fallback. |
| `aws-config` | AWS shared config mounted read-only into the lead and both workers (`AWS_CONFIG_FILE`): default profile assumes `delegate-swarm-prod-read` with the instance's IMDS credentials. |
| `global-setup-script.sh` | agent-swarm's admin `SETUP_SCRIPT` global config. Runs as root at every agent container start. Installs AWS CLI v2 once into the persistent `swarm_shared` volume and relinks `/usr/local/bin/aws`. Edit the script, merge, run `bootstrap.sh`, restart the agents. |
| `bootstrap.sh` | Run as root after the stack is up; idempotent. Rebuilds the SQLite state the repo defines (section 5) through the API on `127.0.0.1:3013`, reading `API_KEY` from `.env` without printing it. |
| `soul/` | The lead's `SOUL.md` and `IDENTITY.md`, which `bootstrap.sh` installs. |
| `ui-dist/` (host only) | Built dashboard. Mounted read-only into caddy at `/srv/ui`. `build-ui.sh` rebuilds it when `ui-dist/.agent-swarm-version` differs from `AGENT_SWARM_VERSION`. |

Key env (names only; see `render-env.sh` and the compose file for the full set):

- API: `NODE_ENV=production` (Bun defaults to `development`, which **silently blocks Slack Socket Mode**), `CAPABILITIES` unset (defaults include scheduling, pages, slack, mcp, kv, memory, repo), `ALLOW_PRIVATE_NETWORK_URLS=true` (needed to register `http://grafana-mcp:8000/mcp`), `GITHUB_DISABLE=true` (no inbound GitHub webhooks), `SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org`, `SLACK_ALERTS_CHANNEL=C0C6RUJ9VMK`, `APP_URL=https://delegate-swarm.infra.goodparty.org`, `MCP_BASE_URL` and `PUBLIC_MCP_BASE_URL=https://delegate-swarm.infra.goodparty.org`, `EMBEDDING_API_BASE_URL=http://tei:80/v1`, `EMBEDDING_API_KEY=local`, `EMBEDDING_MODEL=nomic-embed-text-v1.5`, `API_DRAIN_MAX_MS=30000`, `SECRETS_ENCRYPTION_KEY` via env (not a file secret). No `MODEL_OVERRIDE`: the API reads none.
- Agents (shared `x-worker-env` anchor): `HARNESS_PROVIDER=pi`, `ANTHROPIC_API_KEY`, `MODEL_OVERRIDE` **provider-prefixed** (`anthropic/claude-opus-5-5` lead, `anthropic/claude-sonnet-5-5` workers), `MCP_BASE_URL=http://api:3013`, `APP_URL`, `GITHUB_TOKEN`, `GITHUB_NAME=Delegate`, `GITHUB_EMAIL=delegate@goodparty.org` (placeholders), `CLICKUP_API_TOKEN` and `CLICKUP_API_KEY`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `GRAFANA_URL`, `AWS_CONFIG_FILE`, `AWS_SDK_LOAD_CONFIG=1`. The lead also has `AGENT_NAME=Delegate`. Agent ids are pinned in env so they survive recreation. Agent-scope `HARNESS_PROVIDER` and `MODEL_OVERRIDE` rows in the swarm's config win over these env values.
- `grafana-mcp`: pinned by digest; `-t streamable-http --address 0.0.0.0:8000 --allowed-hosts grafana-mcp:8000,grafana-mcp` (it rejects non-loopback Host headers otherwise). It has **no caller auth**; only the compose network reaches it.

Resource use on the old host on 2026-10-07: 15 GB of 120 GB disk, 2.9 GB of 15.6 GB RAM. TEI holds about 1.85 GB.

## 5. State inside the swarm (SQLite, not in git)

The swarm starts fresh. `host/bootstrap.sh` rebuilds everything below that
the repo defines; the rest starts empty.

**Agents** (ids pinned in `render-env.sh`, so they are the same on every host): Lead `9f8efd62-469d-4067-9dca-24d72b13864b` (isLead), Coder `458bcd6d-4384-4366-83fa-63072ef55eab`, Reviewer `a0799d09-6816-445a-957d-1339b672d38b`. Templates `official/lead`, `official/coder`, `official/reviewer`. `bootstrap.sh` sets each one's harness (pi) and model from `.env` through `PATCH /api/agents/{id}/runtime`, so the agent-scope config matches env.

**Lead persona**: `host/soul/SOUL.md` and `host/soul/IDENTITY.md`, installed by `bootstrap.sh` via `PUT /api/agents/{lead}/profile`. The lead may edit them later (it is told to self-correct); a rerun of `bootstrap.sh` overwrites those edits, so read the live versions from `GET /api/agents/{lead}` first.

**MCP servers** (scope swarm, installed on all three agents, registered by `bootstrap.sh`): `grafana` (static, the sidecar at `http://grafana-mcp:8000/mcp`); `clickup` (`https://mcp.clickup.com/mcp`, OAuth). `bootstrap.sh` installs clickup only once it is connected in the dashboard.

**Global config**: `SETUP_SCRIPT` from `host/global-setup-script.sh`, set by `bootstrap.sh`. agent-swarm writes `SWARM_ORG_NAME` and its telemetry keys itself.

**Schedules**: none. They start empty and `bootstrap.sh` creates none; Swain decides which to add. Each one is model spend and may post to Slack.

**Apps, pages, tasks**: none at the start.

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
- **Re-registering does not rename an agent.** `AGENT_NAME` names a new agent only; rename an existing one with `PUT /api/agents/{id}/name`.
- **A harness switch can fail the next task.** The worker can claim a task before it reconciles the new harness (about 10 seconds).
- **Restoring a data volume snapshot on the same host** needs `mount -o nouuid`: the clone has the live volume's XFS UUID.
- **Agents' own `/workspace/start-up.sh` exits 243** as the worker user (non-fatal warning, `STARTUP_SCRIPT_STRICT=false`). Not investigated.

## 7. agent-swarm facts that constrain the production design

Verified in the v1.163.0 source; cite `src/...` paths from a checkout of the tag.

- Control plane is **SQLite** (`/app/data/agent-swarm-db.sqlite`, WAL), no Postgres option. Backup = copy the volume + the encryption key. Migrations are forward-only.
- **Restart semantics**: compose `stop_grace_period: 60s`; with `API_DRAIN_MAX_MS` set the API refuses new claims on SIGTERM; a task still running after `SHUTDOWN_TIMEOUT` (30s) is superseded into a resume task on the same agent. No per-agent pause or drain endpoint exists. Upgrade = `systemctl stop`, bump `AGENT_SWARM_VERSION`, rebuild `ui-dist`, `systemctl start`.
- **GitHub**: workers push with a static `GITHUB_TOKEN`; the GitHub App env (`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`) is inbound-reactions only, so the delegate GitHub App cannot be reused for pushes without a credential-helper workaround. **No repo allowlist**: the token's scope is the only fence. Branch protection is what makes "never merge" true.
- **Slack**: Socket Mode only (HTTP receiver not implemented). One bot token per swarm; agents would differ by display name and emoji via `chat:write.customize` (`src/slack/responses.ts` `getAgentEmoji`: a crown for the lead). Our manifest leaves that scope out, and Slack then ignores `username`/`icon_emoji` on `chat.postMessage` instead of failing the call. If it ever did fail, `sendWithPersona` throws and its callers log and drop the message, so a missing reply in Slack with `[Slack] Failed` in the api log is the symptom to look for. Self-message detection matches on bot user id or bot id, so it works either way (`src/slack/handlers.ts` `isSwarmThreadRoot`). Thread replies route to the active worker; `@mention` goes to the lead.
- **Auth**: single bearer. `API_KEY` = operator (bypasses RBAC). `aswt_*` per-user tokens exist (`POST /api/users/{id}/mcp-tokens`) and the dashboard accepts them. RBAC has `admin` and `requester` roles but no UI/API to assign them; everyone is admin. **The API does not read proxy identity headers** (`SSO_TRUSTED_HEADER` is "proposed, not implemented"), so oauth2-proxy can gate but cannot log users in.
- **Pages/apps**: `authed` pages need a `page_session` cookie minted by a bearer-authed launch; `public` and `password` modes exist. Apps are `/api/apps*` routes on the bearer principal. Served same-origin; SPA routes and API prefixes do not collide.
- **Webhook ingress**: `POST /api/webhooks/{workflowId}` (HMAC/shared-token when configured) starts a workflow; `POST /api/tasks` with the operator key creates tasks and has no idempotency. A Grafana alert hook would be a workflow with an `agent-task` node.
- **Models**: `MODEL_OVERRIDE` is passed verbatim to `claude --model` on the claude harness; pi wants a provider-prefixed id (`anthropic/...`). Only the worker reads it (`src/commands/runner.ts`); the API never does. Workflow LLM nodes take the node's own model or a default per credential kind (`src/workflows/executors/workflow-llm.ts`). `modelTier` (`smol|regular|smart|ultra`) via `MODEL_TIER_MAP` is the provider-agnostic alternative. Session summaries/memory rating use OpenRouter → Anthropic → OpenAI in that precedence; workflow LLM nodes accept only `openrouter`/`openai`.
- **Images**: worker is 5.4 GB unpacked (full toolchain + Playwright). `pull_policy: always` was removed since the tag is pinned.

## 8. Productionization status (updated 2026-10-07)

Done, in the PR that moves the host:

1. **Infrastructure as code** in `deploy-infrastructure/`, account
   `394495727159`. Host files reach the host through S3 and an SSM
   association on every deploy; `pulumi up` waits for it. The secret is
   created empty and filled by hand. A new host installs its files and waits
   for the secret before it starts anything.
2. **State on its own volume** at `/var/lib/docker`, so a replacement
   instance keeps the swarm. Backups are snapshots of that volume.
3. **Fresh state from the repo**: `host/bootstrap.sh` rebuilds the setup
   script, MCP servers, lead soul and agent runtimes. No migration from the
   old host.
4. **Production access** read-only through `delegate-swarm-prod-read`.
5. **Delegate name**: Slack app, lead name, hostname.
6. **pi harness** for every agent.
7. **`grafana/mcp-grafana` pinned** to a digest.
8. **Version bumps** are a one-line PR (README, "Upgrade agent-swarm"); the
   dashboard rebuilds itself when the version changes.

Open, waiting on Swain (README, "Bringing it up", has the order):

1. **GitHub service user**: the account, its PAT, and its real login and
   email in `host/render-env.sh` (now placeholders).
2. **ClickUp service seat** and its token; then connect the clickup MCP
   server as that seat.
3. **Grafana service account** `delegate` and its token.
4. **DNS delegation**: after the first apply, a one-time PR in `deploy/`
   adds the NS record for `infra.goodparty.org` with the four
   `infraZoneNameServers` stack outputs as constants. That is the last DNS
   change the management account ever needs for this account; the
   `delegate-swarm` A record and every later one live in the zone in the
   infrastructure account.
5. **Delegate Slack switch**: manifest, Socket Mode, reinstall, invite the
   bot to its channels.
6. **Google OAuth client** for login. oauth2-proxy and the SSO Caddy routes
   switch on when the secret holds the three `OAUTH2_PROXY_*` keys (README,
   "Google login").
7. **Schedules**: none exist. Swain decides which to add.
8. **Old host teardown** once the new one is live (section 3).

Not started, by choice:

- **Grafana ingress**: a workflow with a webhook trigger plus a second
  contact-point integration, when proactivity beyond schedules is wanted.

## 9. Where everything the agent wrote lives

- **This directory** (`agent-swarm/` on branch `feat/agent-swarm-host`, draft PR [#245](https://github.com/thegoodparty/ops/pull/245)): compose, Caddyfile, `aws-config`, scripts, systemd unit, Slack manifest, EC2 user-data, `fill-secrets.sh`, the soul files (`host/soul/`), `README.md` (procedures), this file, `iam/agent-swarm-aws-readonly.json` (the production read-only policy; `deploy/components/delegate-swarm-prod-read.ts` applies it). Nothing here is application code; it is config.
- **On the host** `/opt/agent-swarm/`: the same files plus `.env` (rendered, never commit) and `ui-dist/`.
- **Pilot guide for users** (Claude artifact, private, Swain owns it): https://claude.ai/artifact/S1oPLMimpwCfGuN2f5sEzu . Source HTML was in the job's tmp dir and is not in git; the content is a prose version of sections 1 to 7.
- **Swain's Claude memory** (`~/.claude/projects/-Users-swain-Repos-thegoodparty-omni/memory/swarm-playground-2026-10.md`): a shorter record of the same facts for his future sessions. `memory/attic/agent-swarm-*.md` is the earlier attempt he asked not to be used.
- **Not in git** (ephemeral, in a Claude job tmp dir that is deleted with the job): SSM helper scripts, the read-only IAM policy JSON (copied to `iam/` here), probe scripts. Nothing of value that is not also in this directory or on the host.
- **No changes were made to omni, gp-api, or any product repo.** The AWS side lives in `deploy-infrastructure/`; nothing in `delegate/` or `bugboss/` was touched.

## 10. Working with Swain on this

From his standing instructions, the parts that bit during this build: lead with what changed and what he must decide; never merge a PR he did not name; never ask for AWS credentials or console access (he has admin SSO and ran the AWS steps himself through the agent); secrets never pass through chat (he fills Secrets Manager from his own terminal; `fill-secrets.sh` is how); plain English, sentence case, no em dashes, no emoji. When unsure and the cost is low, decide and tell him the assumption in one line.
