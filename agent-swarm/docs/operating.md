# Operating it: day two

For whoever runs this after the observation session. Everything is on one host.
The commands here are real and were checked against
[`../deploy.sh`](../deploy.sh), [`../user-data.sh`](../user-data.sh),
[`../bootstrap.sh`](../bootstrap.sh), [`../docker-compose.yml`](../docker-compose.yml)
and [`../teardown.sh`](../teardown.sh).

## Getting a shell

There is no key pair and no SSH. Session Manager is the only way in.

```bash
aws ssm start-session --target "$(aws ec2 describe-instances --region us-west-2 \
  --filters 'Name=tag:Name,Values=agent-swarm' 'Name=instance-state-name,Values=running' \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
```

Then, on the host:

```bash
cd /opt/agent-swarm
```

The instance profile grants `ssm:GetParameter` on `/agent-swarm/*` and the usual
read-only investigation surface (logs, metrics, ECS describe). It holds no
database credentials, no deploy role, and no merge rights.

## Where things live

| Path | What | Survives a deploy? |
| --- | --- | --- |
| `/opt/agent-swarm` | the stack: compose file, scripts, `.env` | no, replaced wholesale every deploy |
| `/var/lib/agent-swarm/api-data` | the SQLite database and its WAL. The whole incident record | yes |
| `/var/lib/agent-swarm/logs` | session logs, shared by the agent containers | yes |
| `/var/lib/agent-swarm/shared` | the workspace all agents read and write, including the post-mortem staging directory | yes |
| `/var/lib/agent-swarm/personal/<name>` | each agent's private workspace and its persisted `.agent-id` | yes |

`deploy.sh` re-extracts the tar over `/opt/agent-swarm` on every run, and
`bootstrap.sh` re-renders `.env` from the `AGENT_SWARM`
secret. Never edit a file under `/opt/agent-swarm` and expect it to survive: the
source of truth is the repo plus the secret.

## The stack

Six containers: `api`, `litestream`, `lead`, `coder-1`, `coder-2`, `bridge`.

```bash
docker compose ps
docker compose up -d           # apply .env or compose changes
docker compose restart lead    # bounce one service
docker compose stop api        # stop one service
```

Every service is `restart: unless-stopped`, so a container that exits comes back.
Shutdown is graceful with a 60 second grace period: in-progress tasks are paused,
not failed, and resume with their context on the next start. Use stable
`AGENT_ID` values (the default) so resume keeps working after a restart.

## Logs

```bash
docker compose logs -f lead           # watch the incident commander think
docker compose logs -f api            # control plane: tasks, KV, Slack, schedules
docker compose logs -f bridge         # Grafana deliveries: accepted, duplicate, dropped, failed
docker compose logs --tail=200 coder-1
```

Each container's Docker json-file log is capped at 50 MB across 5 files
(`/etc/docker/daemon.json`, written by user-data). The bind-mounted session logs
under `/var/lib/agent-swarm/logs` rotate daily, keep 7 days, and are compressed
(`/etc/logrotate.d/agent-swarm`).

`deploy.sh` creates a CloudWatch log group at `/aws/ec2/agent-swarm`, but no
service in the compose file sets the `awslogs` logging driver, so today the
container logs live on the host only. Read them with `docker compose logs`.

## Restarting

A restart is `docker compose restart <service>`, or `docker compose up -d` to
reconcile the whole stack against the compose file. A restarted agent resumes a
paused task rather than losing it. A restarted `api` does not lose state, because
the state is the SQLite file on the bind mount.

## Upgrading the pinned version

The stack pins both swarm images to `AGENT_SWARM_VERSION` (`1.158.0`). The value
lives in `.env.example` and is rendered into `/opt/agent-swarm/.env`. A blank
value tracks `latest`, which upstream rebuilds on every commit, so keep it pinned.

To upgrade:

```bash
# 1. back up the database first -- see the restore section for a manual copy
cd /opt/agent-swarm
docker run --rm -v /var/lib/agent-swarm/api-data:/data -v "$PWD":/backup alpine \
  sh -c 'cp -a /data/. /backup/api-data-backup-$(date +%Y%m%d)/'

# 2. change the pin, then pull and restart
#    edit .env.example in the repo (and redeploy), or for a one-off on the host:
sed -i 's/^AGENT_SWARM_VERSION=.*/AGENT_SWARM_VERSION=<new>/' .env
docker compose pull
docker compose up -d

# 3. verify with /health AND one completed task, not /health alone
curl -fsS https://agent-swarm.goodparty.org/health
```

**Migrations are forward-only, so re-pinning to an older version is not a
rollback.** The old binary will not un-run a migration the new one applied. Only a
database backup taken before the upgrade, or a Litestream restore to a point
before it, rolls the schema back. This is why step 1 exists.

## Litestream: what is backed up, and how to restore

Litestream replicates one file: `/app/data/agent-swarm-db.sqlite`, which is
`/var/lib/agent-swarm/api-data/agent-swarm-db.sqlite` on the host. That file is
the whole incident record: every `incident:<n>` KV entry, every task, every agent
profile, every schedule, every configuration row.

- **Destination:** `s3://agent-swarm-prod/litestream` (`us-west-2`).
- **Cadence:** continuous WAL shipping, with a full snapshot every `3600s`.
- **Retention:** `720h` (30 days).
- **Credentials:** the instance profile, through the AWS SDK chain. No keys are
  written to the config file. `../litestream.yml` documents the fallback
  (explicit `access-key-id` / `secret-access-key`, passed through the compose
  service) if a container cannot reach the instance metadata service. Litestream
  refuses to start without usable credentials rather than running un-replicated.

To restore, stop the API so it is not holding the database open, restore over it,
then start the stack again:

```bash
cd /opt/agent-swarm
docker compose stop api
docker run --rm --network host -v /var/lib/agent-swarm/api-data:/data \
  -e AWS_REGION=us-west-2 litestream/litestream:0.3.13 \
  restore -o /data/agent-swarm-db.sqlite s3://agent-swarm-prod/litestream
docker compose up -d
```

`--network host` is deliberate: it puts the restore container on the instance
network so it reaches the instance metadata service the same way the host does.
For a point-in-time restore, add `-timestamp <RFC3339>`.

Restoring into a fresh instance (a replaced host) is a manual step: boot the host
with `deploy.sh`, then run the restore above before the swarm has any data worth
keeping.

## What to back up beyond the database

**The encryption key.** The API encrypts its stored secrets with it, and Litestream
replicates only the database. Losing the key makes every encrypted secret in a
restored database unrecoverable, so the database backup is worthless without it.
This is why the key is not auto-generated on the host: it lives in
`SECRETS_ENCRYPTION_KEY` in the `AGENT_SWARM` secret and reaches the API as an
environment variable, so the same secret restores the database's readability as
well as its contents. Back up the secret, not anything on the box, and never
regenerate that value while a database exists.

**The agent workspaces.** `/var/lib/agent-swarm/personal` and
`/var/lib/agent-swarm/shared` hold each agent's private files, its persisted
agent id, and the shared workspace the post-mortem is written into. None of it is
in the database. Backing it up is optional; losing it loses an agent's scratch
work, not the incident record.

## Adding a worker

Workers poll outbound and publish no host port, so adding one is a compose edit.

1. Copy the `coder-1` service block in `docker-compose.yml` to a new block, for
   example `coder-3`.
2. Keep `TEMPLATE_ID=official/coder`, `AGENT_ROLE=worker`, and
   `MCP_BASE_URL=http://api:3013`.
3. Add a personal bind mount:
   `/var/lib/agent-swarm/personal/coder-3:/workspace/personal`. Reuse the shared
   `logs` and `shared` mounts as they are.
4. Leave `AGENT_ID` blank. The entrypoint generates a UUID on first boot and
   persists it at `/var/lib/agent-swarm/personal/coder-3/.agent-id`; the id is
   reused on every later start.
5. Do not add a `ports:` block.
6. Make the edit in the repo, not only on the host, or the next deploy removes it.
   Then `docker compose up -d`.

## Changing the model

Model and harness are per service, set from `.env`.

- **All agents:** edit `HARNESS_PROVIDER` and `MODEL_OVERRIDE`. This build runs
  `HARNESS_PROVIDER=pi` with `MODEL_OVERRIDE=anthropic/claude-sonnet-5`. Then
  `docker compose up -d`.
- **One agent:** `PATCH /api/agents/{id}/runtime` on the API, or
  `PUT /api/config` with an agent scope. The worker reconciles the change within
  about one poll cycle; an in-flight task stays on the old model.
- Do not also set `CLAUDE_CODE_OAUTH_TOKEN`. `pi` alongside a Claude OAuth token is
  documented as wrong. `ANTHROPIC_API_KEY` is what resolves the native Anthropic
  provider here.
- Workflow LLM nodes do not support Anthropic on this deployment. Do not build
  workflows with LLM nodes.

## Reaching the API and the dashboard

- **API:** `https://agent-swarm.goodparty.org`, the ALB origin. Every path except
  `/grafana` goes to the API; `/grafana` goes to the bridge. `GET /health` is
  unauthenticated. `/docs` and `/openapi.json` describe the HTTP API. Requests
  authenticate with `Authorization: Bearer $API_KEY`.
- **Dashboard:** `https://app.agent-swarm.dev`, pointed at the API URL above.
  `PUBLIC_MCP_BASE_URL` is the origin OAuth redirects and webhooks come back to.
  If you self-host the UI instead, set `CORS_ALLOWED_ORIGINS` to its origin.

## Tearing the whole thing down

```bash
cd agent-swarm
./teardown.sh --yes
```

`--yes` is required on purpose: a destructive run takes an explicit flag rather
than a prompt a tired operator answers by reflex.

It removes, in reverse dependency order:

- the EC2 instance, and with it the root volume (delete-on-termination)
- the Route 53 `A` record for `agent-swarm.goodparty.org`
- the load balancer, its listener and the two listener rules
- the two target groups
- the IAM role and instance profile
- the two security groups
- the CloudWatch log group `/aws/ec2/agent-swarm`

It **retains** the S3 bucket `agent-swarm-prod`, because that bucket holds the
incident history: every Litestream snapshot of the swarm database, plus the deploy
tarballs. Nothing can rebuild it. To destroy it as well:

```bash
./teardown.sh --yes --purge-bucket
```

That deletes every object version in the bucket and cannot be undone. Run it only
when you mean to lose the record.

Note what teardown does not touch: the `AGENT_SWARM` secret, the Slack app, and the
Grafana contact point integration. Those are clickops, they outlive the host, and
they are yours to remove by hand if you want the system to stop receiving alerts.
