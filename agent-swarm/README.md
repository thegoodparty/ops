# Delegate swarm host

## What this is

The deployment of [agent-swarm](https://github.com/desplega-ai/agent-swarm)
v1.163.0 that shows up in Slack as **Delegate** and serves its dashboard at
https://delegate-swarm.goodparty.org. The old name, swarm.goodparty.org,
redirects to the same path there. One EC2 host in the infrastructure account
runs the whole stack in Docker Compose. State, decisions and history are in
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
- `delegate-swarm.goodparty.org`, and `swarm.goodparty.org` as a redirect
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
- GitHub identity: a service user's fine-grained PAT. TODO: `GITHUB_NAME`
  and `GITHUB_EMAIL` in `host/render-env.sh` are the placeholders
  `Delegate` and `delegate@goodparty.org`; set them to the service user's
  real login and email once it exists.

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
because their callers carry their own credentials. Design and bypass list:
`docs/sso-proposal.md`.

To turn it on:

1. Google Cloud console, APIs and services, Credentials, Create OAuth client
   ID, type Web application. Authorized JavaScript origin
   `https://delegate-swarm.goodparty.org`, redirect URI
   `https://delegate-swarm.goodparty.org/oauth2/callback`. Make the consent
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

## Changing agent behaviour without a deploy

- Souls: `PUT /api/agents/{id}/profile` with the contents of `soul/`.
- MCP servers: `/api/mcp-servers`.
- The global `SETUP_SCRIPT` config (runs as root at every worker container
  start): edit `host/global-setup-script.sh`, merge, then on the host run
  `./apply-global-setup-script.sh` and
  `docker compose restart lead worker-coder worker-reviewer`.

API calls go to `https://delegate-swarm.goodparty.org` with
`Authorization: Bearer $API_KEY` (the `API_KEY` key in the secret).

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

`AGENT_NAME=Delegate` on the lead only names a newly registered lead. The
existing one is renamed with `PUT /api/agents/{id}/name`.

## MCP servers

- grafana: the `grafana-mcp` sidecar, pinned by digest, id
  `b67d4f9a-fe78-49ba-84af-0af708af3c81`. It has no caller auth; only the
  compose network reaches it and Caddy does not route to it.
- clickup: hosted OAuth, id `965d7f32-6134-4c00-9911-f13a39047fbf`

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

## Moving from the old host

The swarm used to run on `i-04cc03c17787f5d59` in account 333022194791 as
the Slack app Swarm. Moving it carries the SQLite state, the workspaces and
the Caddy certificates across. In order:

### 1. Apply the infrastructure

Merge the PR that adds the host to `deploy-infrastructure/`. The first boot
mounts the empty data volume, and the association installs `host/` and
stops there, because the secret has no value yet. Its output in
`s3://delegate-swarm-config-394495727159/ssm-output/` ends with
`install: DELEGATE_SWARM has no value yet; files installed, stack not
started.`

### 2. Restore the volumes onto the new host

On the old host (`AWS_PROFILE=gp-admin aws ssm start-session --region
us-west-2 --target i-04cc03c17787f5d59`), stop the stack for good and pack
the volumes that hold state:

```sh
sudo systemctl stop agent-swarm
sudo systemctl disable agent-swarm
cd /var/lib/docker/volumes
sudo tar --numeric-owner -czpf /var/tmp/volumes.tar.gz \
  agent-swarm_swarm_api_data agent-swarm_swarm_shared agent-swarm_swarm_lead \
  agent-swarm_swarm_worker_coder agent-swarm_swarm_worker_reviewer agent-swarm_caddy_data
ls -lh /var/tmp/volumes.tar.gz
```

The old host's role cannot write to the new account, so upload through a
presigned URL made on a laptop. `aws s3 presign` only makes GET URLs, so
use boto3 (`uv run --with boto3 python3 -c ...` if boto3 is not installed):

```sh
AWS_PROFILE=gp-infrastructure python3 -c 'import boto3; from botocore.config import Config; print(boto3.client("s3", region_name="us-west-2", config=Config(signature_version="s3v4")).generate_presigned_url("put_object", Params={"Bucket": "delegate-swarm-config-394495727159", "Key": "migration/volumes.tar.gz"}, ExpiresIn=3600))'
```

The URL is valid for an hour at most (less if the session expires first).
Back on the old host:

```sh
curl -fsS --upload-file /var/tmp/volumes.tar.gz '<presigned url>'
```

On the new host, before the stack has ever started. The six volumes must
not exist yet (`sudo docker volume ls`); if they do, the stack has run here,
so first `cd /opt/agent-swarm && sudo docker compose --profile '*' down`
and `sudo docker volume rm` them.

```sh
sudo systemctl stop agent-swarm
sudo aws s3 cp --region us-west-2 \
  s3://delegate-swarm-config-394495727159/migration/volumes.tar.gz /var/tmp/volumes.tar.gz
for v in swarm_api_data swarm_shared swarm_lead swarm_worker_coder swarm_worker_reviewer caddy_data; do
  sudo docker volume create \
    --label com.docker.compose.project=agent-swarm \
    --label com.docker.compose.volume="$v" "agent-swarm_$v"
done
sudo tar --numeric-owner -xzpf /var/tmp/volumes.tar.gz -C /var/lib/docker/volumes
sudo ls -ln /var/lib/docker/volumes/agent-swarm_swarm_api_data/_data \
  /var/lib/docker/volumes/agent-swarm_swarm_lead/_data
sudo rm /var/tmp/volumes.tar.gz
```

The SQLite files belong to uid 0 and the agents' workspaces to uid 1001, as
on the old host. The compose project name is fixed to `agent-swarm` at the
top of `docker-compose.yml`, which is what makes these volume names line up.

Delete the copy in S3 from the laptop; it holds the whole database:

```sh
AWS_PROFILE=gp-infrastructure aws s3 rm s3://delegate-swarm-config-394495727159/migration/volumes.tar.gz
```

### 3. Fill the secret

From this directory on a laptop:

```sh
AWS_PROFILE=gp-infrastructure ./fill-secrets.sh --copy-from-old
AWS_PROFILE=gp-infrastructure ./fill-secrets.sh
```

`--copy-from-old` copies `API_KEY` and `SECRETS_ENCRYPTION_KEY` from the old
`AGENT_SWARM` secret (with the `gp-admin` profile; set `OLD_AWS_PROFILE` to
use another) without printing them. It has to be the same encryption key:
the migrated database's stored secrets are unreadable with any other.

The second run walks through the Delegate Slack app, Anthropic, GitHub,
ClickUp and Grafana. Saving the manifest in the Delegate app is the moment
the old delegate bot stops receiving Slack events, so do that step right
before step 4. The script ends by listing any required key still missing.

### 4. Start the stack

On the new host:

```sh
sudo systemctl start agent-swarm
sudo journalctl -u agent-swarm -f
```

The first start pulls the images (the worker image is about 5 GB) and, since
`ui-dist/` is empty and has no version marker, builds the dashboard before
`docker compose up`. Check `curl -s http://127.0.0.1:3013/health`,
`cd /opt/agent-swarm && sudo docker compose ps`, then in Slack
`/invite @Delegate` in `#swarm-testing` and mention it.

### 5. DNS and Slack

DNS is a follow-up PR: the `goodparty.org` zone is in the management
account, and both `delegate-swarm.goodparty.org` and `swarm.goodparty.org`
point at the new host's Elastic IP. Until it merges, the dashboard is not
reachable by name and Caddy keeps retrying its certificates; Slack and the
agents work without it. After it, swarm.goodparty.org answers with a 308 to
the same path on delegate-swarm.goodparty.org.

Slack switch order, end to end: the old Swarm app goes quiet in step 2 when
the old stack stops; the Delegate app moves to Socket Mode in step 3; the
swarm answers as Delegate from step 4. Once Delegate has answered, delete
the old Swarm app (api.slack.com/apps, Swarm, Basic Information, Delete
App). Threads Swarm started are not recognised as the swarm's own any more,
so replies there need an @mention.

Leave the old host stopped until the new one has run cleanly for a while,
then tear it down (`HANDOFF.md` section 3 lists what is there).

## Replacing the instance

The data volume outlives the instance. A new instance's user-data waits for
the volume, mounts it without formatting, and starts docker; the
association installs `host/`, and since the secret already has a value,
`up.sh` builds the dashboard and starts the stack with the same state and
agent ids. Starting from a blank data volume gives an empty swarm
(`HANDOFF.md` section 5 lists what lives only in SQLite).
