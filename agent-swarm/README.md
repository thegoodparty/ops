# Delegate swarm host

## What this is

The deployment of [agent-swarm](https://github.com/desplega-ai/agent-swarm)
v1.163.0 that shows up in Slack as **Delegate** and serves its dashboard at
https://delegate-swarm.infra.goodparty.org. One EC2 host in the infrastructure
account runs the whole stack in Docker Compose. State, decisions and history are in
`HANDOFF.md`; this file is how to operate it.

## How it deploys

The AWS side is Pulumi, in `deploy-infrastructure/` (stack
`organization/infrastructure/main`, account 394495727159), and ships with
every merge to `main` through `.github/workflows/deploy-infrastructure.yml`.

Everything in `host/` is the contents of `/opt/agent-swarm/` on the host
(`host/systemd/` goes to `/etc/systemd/system/`). On deploy, Pulumi uploads
`host/` to `s3://delegate-swarm-config-394495727159/host/` and an SSM
association runs `host/install.sh` on the instance whenever any file
changed. `install.sh` copies the files in place, installs the systemd unit,
and runs `up.sh`, which renders `.env` from the secret, rebuilds the
dashboard if the version changed, and runs `docker compose up -d`. Compose
only recreates the containers whose definition changed. `pulumi up` waits
for the association, so a host that fails to take a change fails the
deploy. `install.sh` never stops the stack.

While the `DELEGATE_SWARM` secret has no value yet (a brand-new host),
`install.sh` installs the files and the unit, does not start the stack,
prints `install: DELEGATE_SWARM has no value yet` and succeeds.

So: to change the host, edit `host/` and merge. Do not edit files on the
host; the next deploy overwrites them.

## Where it runs

- AWS account 394495727159 (infrastructure), region us-west-2
- `delegate-swarm.infra.goodparty.org`
- Docker's state, including every compose volume, lives on a separate EBS
  data volume mounted at `/var/lib/docker`. `ec2-user-data.sh` mounts it
  before docker starts and formats it only if it is blank, so a replacement
  instance picks up the same state. The root disk holds nothing that matters.
- Secrets Manager secret `DELEGATE_SWARM` (filled by hand, never by Pulumi)
  with keys `ANTHROPIC_API_KEY`, `API_KEY`, `CLICKUP_API_TOKEN`,
  `GITHUB_TOKEN`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `SECRETS_ENCRYPTION_KEY`,
  `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, and optionally the three
  `OAUTH2_PROXY_*` keys that turn on Google login
- Container logs: CloudWatch Logs `/delegate-swarm/containers`, one stream
  per container. `docker compose logs` on the host still works.
- GitHub identity: the service user
  [delegate-gp-bot](https://github.com/delegate-gp-bot) and its fine-grained
  PAT. Commits are authored as `delegate` with the user's noreply address
  (`339843712+delegate-gp-bot@users.noreply.github.com`, in `host/render-env.sh`), so GitHub links them to the account.

`fill-secrets.sh` is the interactive way to fill the secret from a laptop.
After a secret change, re-run `up.sh` on the host (or merge any host change).

There is no SSO profile for the infrastructure account yet. Until there is,
assume `OrganizationAccountAccessRole` from a management admin session; the
top of `fill-secrets.sh` has the `~/.aws/config` profile
(`gp-infrastructure`) every command below uses.

## Connect

The instance id is the stack output `delegateSwarmInstanceId`
(`pulumi stack output delegateSwarmInstanceId` in `deploy-infrastructure/`),
or in the EC2 console of the infrastructure account (us-west-2).

```sh
AWS_PROFILE=gp-infrastructure aws ssm start-session --region us-west-2 --target <instance id>
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
   Delegate answers a mention in `#swarm-testing`.

Read the release notes for migrations before bumping; SQLite migrations are
forward-only, so the way back is the latest snapshot.

## Backups and restore

The state that matters is the `agent-swarm_swarm_api_data` volume (SQLite,
WAL) on the data volume, plus the agents' workspaces next to it. Snapshots
of the data volume are the backup; their schedule and retention are defined
with the host in `deploy-infrastructure/`. A snapshot is crash-consistent,
which SQLite recovers from like a power cut.

The swarm encrypts the secrets it stores in SQLite with
`SECRETS_ENCRYPTION_KEY`. That key lives only in the `DELEGATE_SWARM`
secret. A snapshot without the key restores everything except those secrets.

To restore one volume from a snapshot: create an EBS volume from it in the
instance's availability zone and attach it, then on the host:

```sh
sudo systemctl stop agent-swarm
sudo mkdir -p /mnt/restore
# Same filesystem UUID as the live data volume, so XFS needs nouuid.
sudo mount -o ro,nouuid /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_<vol id without dash> /mnt/restore
sudo rsync -a --delete --numeric-ids /mnt/restore/volumes/agent-swarm_swarm_api_data/_data/ \
  /var/lib/docker/volumes/agent-swarm_swarm_api_data/_data/
sudo umount /mnt/restore
sudo systemctl start agent-swarm
```

Then detach and delete the restored volume.

## Google login

Off until the secret holds `OAUTH2_PROXY_CLIENT_ID`,
`OAUTH2_PROXY_CLIENT_SECRET` and `OAUTH2_PROXY_COOKIE_SECRET` (all three or
none; `render-env.sh` refuses a partial set). Then `up.sh` starts
`oauth2-proxy` and Caddy puts every browser path behind Google sign-in for
`goodparty.org`. MCP, `/health`, webhooks and OAuth callbacks stay open
because their callers carry their own credentials. The bypass list is the
`sso` snippet in `host/Caddyfile`.

To turn it on:

1. Google Cloud console, APIs and services, Credentials, Create OAuth client
   ID, type Web application. Authorized JavaScript origin
   `https://delegate-swarm.infra.goodparty.org`, redirect URI
   `https://delegate-swarm.infra.goodparty.org/oauth2/callback`. Make the consent
   screen Internal so only `goodparty.org` accounts can sign in.
2. `AWS_PROFILE=gp-infrastructure ./fill-secrets.sh --sso` from this
   directory. It asks for the client id and secret and generates the cookie
   secret.
3. On the host, `sudo -u ec2-user AWS_REGION=us-west-2 /opt/agent-swarm/up.sh`
   (or merge any host change).

Login only gates. The API reads no identity from it, so people still paste
a bearer into the dashboard's setup page: the shared `API_KEY`, or better a
per-user `aswt_` token an admin mints with
`POST /api/users/{id}/mcp-tokens`. Hand the token out on its own, not inside a
`?apiKey=` link: an unauthenticated visit carries the whole link through
Google's sign-in.

## Changing agent behaviour

What the swarm knows beyond `.env` lives in its SQLite. `host/bootstrap.sh`
rebuilds the part that is in this repo: the global `SETUP_SCRIPT` from
`host/global-setup-script.sh` (runs as root at every agent container start),
the grafana and clickup MCP servers, the lead's soul from `host/soul/`, and
each agent's harness and model from `.env`. To change one, edit the file,
merge, then on the host:

```sh
sudo /opt/agent-swarm/bootstrap.sh
cd /opt/agent-swarm && sudo docker compose restart lead worker-coder worker-reviewer
```

A rerun replaces any edits the lead made to its own soul. If those matter,
read them first from `GET /api/agents/{id}` and copy them into `host/soul/`.

Schedules start empty. `bootstrap.sh` creates none; Swain decides which to
add.

Anything else goes through the dashboard or the API at
`https://delegate-swarm.infra.goodparty.org` (`http://127.0.0.1:3013` on the host)
with `Authorization: Bearer $API_KEY` (the `API_KEY` key in the secret).

## Agents

| Role | Name | Id | Model |
| --- | --- | --- | --- |
| lead | Delegate | `9f8efd62-469d-4067-9dca-24d72b13864b` | anthropic/claude-opus-5-5 |
| coder | Coder | `458bcd6d-4384-4366-83fa-63072ef55eab` | anthropic/claude-sonnet-5-5 |
| reviewer | Reviewer | `a0799d09-6816-445a-957d-1339b672d38b` | anthropic/claude-sonnet-5-5 |

Every agent runs the pi harness. `render-env.sh` sets `HARNESS_PROVIDER=pi`
and the provider-prefixed models as the container defaults; an agent-scope
`HARNESS_PROVIDER` or `MODEL_OVERRIDE` in the swarm's config (dashboard,
agent settings) wins over them. The api container gets no model setting: it
reads none (session summaries use their own pinned model, and workflow LLM
nodes need an OpenRouter or OpenAI key, which this swarm does not have).

The first task after switching an agent's harness can fail: the worker
claims it before it reconciles the new harness, about 10 seconds. Re-run it.

`AGENT_NAME=delegate` on the lead only names a newly registered lead. The
existing one is renamed with `PUT /api/agents/{id}/name`.

## MCP servers

Both are scope swarm, installed on all three agents, and registered by
`bootstrap.sh`.

- grafana: the `grafana-mcp` sidecar at `http://grafana-mcp:8000/mcp`,
  pinned by digest. It has no caller auth; only the compose network reaches
  it and Caddy does not route to it.
- clickup: the hosted server at `https://mcp.clickup.com/mcp`, with OAuth.
  `bootstrap.sh` installs it only once it is connected (Bringing it up,
  step 6).

## Slack

- The existing Delegate Slack app, in Socket Mode, configured from
  `slack-manifest.json`. The manifest leaves out `chat:write.customize`, so
  Slack ignores the per-agent name and emoji agent-swarm sends and every
  message shows the Delegate app's own name and icon.
- Gate: `SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org`. This needs the
  `users:read.email` bot scope, which `slack-manifest.json` includes.
- Home channel and alerts channel: `#swarm-testing` (`C0C6RUJ9VMK`). The
  Delegate bot has to be a member to hear messages there.

## AWS access from inside the swarm

The agents read production AWS (account 333022194791) through the role
`arn:aws:iam::333022194791:role/delegate-swarm-prod-read`. `host/aws-config`
is mounted read-only into the lead and both workers, and
`AWS_CONFIG_FILE` points at it: the default profile assumes that role with
the instance's own credentials from IMDS (the instance's hop limit is 2 so
containers can reach IMDS). The api container has no AWS access.
`host/global-setup-script.sh` installs the AWS CLI into the workers.

## Bringing it up

The swarm starts with fresh state. Nothing carries over from the old host in
the management account, which is torn down once this one is live. In order:

1. **Merge.** The deploy applies `deploy-infrastructure/`. The host installs
   `host/` and does not start the stack, because the secret has no value
   yet. The association output in
   `s3://delegate-swarm-config-394495727159/ssm-output/` ends with
   `install: DELEGATE_SWARM has no value yet; files installed, stack not
   started.`
2. **Fill the secret.** From this directory on a laptop:
   `AWS_PROFILE=gp-infrastructure ./fill-secrets.sh`. It asks for the Slack,
   Anthropic, GitHub, ClickUp and Grafana tokens, generates `API_KEY` and
   `SECRETS_ENCRYPTION_KEY` when the secret lacks them, and never prints
   either. Losing `SECRETS_ENCRYPTION_KEY` loses every secret the swarm
   stores. It ends by listing any required key still missing.
3. **Start.** On the host: `sudo systemctl start agent-swarm`. The first
   start pulls the images (the worker image is about 5 GB) and builds the
   dashboard. Check `curl -s http://127.0.0.1:3013/health` and
   `cd /opt/agent-swarm && sudo docker compose ps`.
4. **Bootstrap.** On the host: `sudo /opt/agent-swarm/bootstrap.sh`. It waits
   up to 5 minutes for the three agents to register, then prints one line
   per item. ClickUp shows as not connected; that is step 6.
5. **DNS.** The first apply creates the `infra.goodparty.org` zone in this
   account and the A record for `delegate-swarm.infra.goodparty.org` in it,
   but nothing resolves until `goodparty.org` delegates the zone. That
   zone is in the management account, so this is a one-time PR in
   `deploy/`: an NS record for `infra.goodparty.org` with the four name
   servers from the `infraZoneNameServers` stack output, written as
   constants. It is the last DNS change the management account ever needs
   for this account; every later record goes in the zone here. Until it
   merges the dashboard is not reachable and Caddy keeps retrying its
   certificate; the OAuth callback in step 6 needs it too.
6. **Connect ClickUp.** In the dashboard, MCP servers, clickup, Connect, and
   sign in to ClickUp as the Delegate service seat. Then on the host run
   `sudo /opt/agent-swarm/bootstrap.sh` again, which installs it on the
   three agents, and
   `cd /opt/agent-swarm && sudo docker compose restart lead worker-coder worker-reviewer`.
   Connect before install: an agent session that meets the server before it
   is authorized skips it for days (`HANDOFF.md`, gotchas).
7. **Switch Slack.** Saving the manifest moves the Delegate app to Socket
   Mode: from then on the old delegate bot gets no Slack events and the
   swarm answers instead.
   1. `pbcopy < slack-manifest.json`, then api.slack.com/apps, Delegate,
      App Manifest. Switch the editor to JSON, paste over everything, Save
      Changes, accept the scope prompt.
   2. Settings, Basic Information, Display Information: upload the app
      icon (square PNG or JPG, 512 to 2000 px). Every message the swarm posts
      carries it, because the manifest has no `chat:write.customize` and so
      agents cannot set their own name or icon per message.
   3. Settings, Socket Mode: turn on Enable Socket Mode.
   4. Settings, Install App, Reinstall to GoodParty, Allow. If the Bot User
      OAuth Token changed, run `./fill-secrets.sh` again with the new one
      and `sudo -u ec2-user AWS_REGION=us-west-2 /opt/agent-swarm/up.sh` on
      the host.
   5. On the host, `cd /opt/agent-swarm && sudo docker compose restart api`
      so it connects in Socket Mode.
   6. `/invite @delegate` in `#swarm-testing` and every other channel it
      should hear, then mention it there.

## Replacing the instance

The data volume outlives the instance. A new instance's user-data waits for
the volume, mounts it without formatting, and starts docker; the
association installs `host/`, and since the secret already has a value,
`up.sh` builds the dashboard and starts the stack with the same state and
agent ids. Starting from a blank data volume gives an empty swarm; run
`bootstrap.sh` (above) to rebuild what is in this repo.
