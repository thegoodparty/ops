# Delegate swarm host

## What this is

The deployment of [agent-swarm](https://github.com/desplega-ai/agent-swarm)
v2.6.0 that shows up in Slack as **Delegate** and serves its dashboard at
https://delegate-swarm.infra.goodparty.org. One EC2 host in the infrastructure
account runs the whole stack in Docker Compose. This file is how to operate it.

## How it deploys

The AWS side is Pulumi, in `deploy-infrastructure/` (stack
`organization/infrastructure/main`, account 394495727159), and ships with
every merge to `main` through `.github/workflows/deploy-infrastructure.yml`.

Everything in `host/` except `scripts/` and `skills/` (see "Panel
hand-offs") is the contents of `/opt/agent-swarm/` on the host
(`host/systemd/` goes to `/etc/systemd/system/`). On deploy, Pulumi uploads
`host/` to `s3://delegate-swarm-config-394495727159/host/` and an SSM
association runs `host/install.sh` on the instance whenever any file
changed. `install.sh` copies the files in place, installs the systemd unit,
and runs `up.sh`, which renders `.env` from the secret, rebuilds the
dashboard if the version or login mode changed, builds the worker image if
the version or `host/worker-patch/` changed (see "Upgrade agent-swarm"),
runs `docker compose up -d`, with Google login on syncs the dashboard
users (below), and last runs `sync-agent-config.sh` (see "Swarm state this
repo owns"). Compose
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
  `FIREWORKS_API_KEY`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`,
  `SECRETS_ENCRYPTION_KEY`, `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, and
  optionally the three `OAUTH2_PROXY_*` keys that turn on Google login
- Container logs: CloudWatch Logs `/delegate-swarm/containers`, one stream
  per container. `docker compose logs` on the host still works.
- Memory: m6a.2xlarge (32 GB, no swap). The three agents are capped at
  26 GB together in `docker-compose.yml` (coder 12g, reviewer 6g, lead 8g)
  so the API, embeddings and proxies always keep the rest. The lead runs up
  to 10 tasks at once (`MAX_CONCURRENT_TASKS`, default 2) so background
  triggers cannot queue Slack mentions; its cap is sized for that. An agent that
  hits its cap has its biggest process OOM-killed in its own container. If
  the host itself runs short, the API is the last thing the kernel kills.
  The symptom of running short is both EBS volumes reading at their
  125 MB/s cap and `[db-client] slow sync statement blocked the event
  loop` lines in the api stream, while Delegate ignores Slack.
- GitHub identity: commits and PRs are authored by the `delegate-gp[bot]`
  App (see "Git identity"). There is no PAT.

`fill-secrets.sh` is the interactive way to fill the secret from a laptop.
After a secret change, re-run `up.sh` on the host (or merge any host change).

There is no SSO profile for the infrastructure account yet. Until there is,
assume `OrganizationAccountAccessRole` from a management admin session; the
top of `fill-secrets.sh` has the `~/.aws/config` profile
(`gp-infrastructure`) every command below uses.

## Disk

The 500 GB data volume fills from the agents' own clones and worktrees:
each gets its own `npm ci`, about 5 GB and 300k files for omni, and agents
never delete them. When the volume runs out of space or inodes, SQLite
rejects every write (`SQLITE_FULL` in the api stream), Delegate stops
answering Slack and tasks cannot be cancelled, while `/health` stays 200.

`disk-cleanup.sh` runs every 15 minutes as root from
`agent-swarm-disk-cleanup.timer`. In the coder, reviewer and lead volumes it
deletes `node_modules` from any checkout where nothing else has changed for
48 hours, or 6 hours once the volume is past 80%. Source trees, `.git` and
uncommitted work are never touched; the next task in that checkout reinstalls.
Each run first grows the filesystem to the volume's size (`xfs_growfs`), so
resizing the volume is only a change to `size` in
`deploy-infrastructure/agent-swarm.ts`.
It also prunes unused images and build cache, except while `up.sh` holds
`/opt/agent-swarm/.deploy.lock`: a worker image it just built has no container
yet and cannot be pulled back. Then it reports
`DataVolumeUsedPercent` and `DataVolumeInodesUsedPercent` to the CloudWatch
namespace `DelegateSwarm`.

The alarms `delegate-swarm-data-volume-space` and
`delegate-swarm-data-volume-inodes` fire at 85%, or when the metric stops
arriving, and email `aws-infrastructure@goodparty.org` through the SNS topic
`delegate-swarm-alerts`. To see what is using space:

```sh
sudo du -xsh /var/lib/docker/volumes/* | sort -h
sudo df -h /var/lib/docker; sudo df -i /var/lib/docker
sudo systemctl start agent-swarm-disk-cleanup; journalctl -u agent-swarm-disk-cleanup -n 5
```

## Connect

The instance id is the stack output `delegateSwarmInstanceId`
(`pulumi stack output delegateSwarmInstanceId` in `deploy-infrastructure/`),
or in the EC2 console of the infrastructure account (us-west-2).

```sh
AWS_PROFILE=gp-infrastructure aws ssm start-session --region us-west-2 --target <instance id>
```

## Shared files (agent-fs)

Agents and catalog scripts share files through agent-fs. Scripts see it at
`/afs`; agents use the agent-fs CLI with drive paths, which are the same path
without `/afs`. It is served by
[agent-fs](https://github.com/desplega-ai/agent-fs) with a local MinIO behind
it, both in the compose file. Nothing is published outside the compose
network and nothing is stored in AWS. On boot the API registers with agent-fs
and writes the shared org, drive and each agent's key into swarm config
(`AGENT_FS_DEFAULT_ORG_ID`, `AGENT_FS_DEFAULT_DRIVE_ID`, `API_AGENT_FS_API_KEY`);
only `AGENT_FS_API_URL` is set in compose. The panel-wave scripts pass the
recipient CSV, screenshots and the replies export through it. Bucket
versioning is off on purpose, so a delete is a delete. When you bump
agent-swarm, take the agent-fs image tag from the new
`docker-compose.example.yml`.

## Upgrade agent-swarm

The lead and both workers do not run the upstream worker image directly.
`up.sh` builds `delegate-swarm-worker:<version>-<patch hash>` from
`host/worker-patch/Dockerfile`, which starts from
`ghcr.io/desplega-ai/agent-swarm-worker:<version>` and upgrades Node to
22.23.4 (the [October 2026 security
release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases));
upstream images up to v2.4.5 still ship 22.23.3. The build fails if Node is
still older than v22.23.4. `render-env.sh` writes the patch hash to `.env`
as `WORKER_PATCH_HASH`, so the tag changes, and the agents are rebuilt and
recreated, only when the version or the Dockerfile changes. A deploy that
changes neither builds nothing and restarts no agent. The API image has no
Node and is used as is.

1. Edit `AGENT_SWARM_VERSION` in `host/render-env.sh`. It is the only place
   the version lives.
2. Check the new worker's Node:
   `docker run --rm --entrypoint node ghcr.io/desplega-ai/agent-swarm-worker:<version> -v`.
   If it is v22.23.4 or later, delete `host/worker-patch/`, point
   `x-worker-base` in `host/docker-compose.yml` back at that image, and
   drop the build from `up.sh` and `WORKER_PATCH_HASH` from
   `render-env.sh`.
3. Merge. `up.sh` sees the dashboard marker
   (`ui-dist/.agent-swarm-version`) is stale and rebuilds the UI from the new
   tag, builds the worker image, then compose pulls the new API image and
   recreates every agent-swarm container. The API drains for up to 30
   seconds; a task still running is superseded into a resume task on the
   same agent.
4. Check: `/health` is 200, the three agents show idle in the dashboard, and
   Delegate answers a mention in `#swarm-testing`.

Read the release notes for migrations before bumping; SQLite migrations are
forward-only, so the way back is the latest snapshot.

## Backups and restore

The state that matters is the `agent-swarm_swarm_api_data` volume (SQLite,
WAL) on the data volume, plus the agents' workspaces next to it. The
agent-fs volumes (`agent_fs_data`, `agent_fs_minio`) hold only working files
that scripts delete after use; nothing needs restoring from them. Snapshots
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
`oauth2-proxy` and Caddy puts every browser path behind Google sign-in. MCP, `/health`, webhooks and OAuth callbacks stay open
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

Only the addresses in `host/allowed-emails.txt`, one per line, get past
the sign-in. Grant or revoke access with a PR to that file; the deploy
rewrites it in place and oauth2-proxy picks the change up without a
restart. A removed address loses the dashboard as soon as the deploy
revokes its token (below), and the login itself at its next hourly session
refresh (`OAUTH2_PROXY_COOKIE_REFRESH`). Revoke any other `aswt_` token that
person holds by hand. Google group membership would need a Workspace service
account with domain-wide delegation, which we chose not to create.

With login on, nobody pastes a key, and each person acts as themselves.
The API reads no identity from the login and only takes bearers, so:

- `up.sh` runs `sync-dashboard-users.sh` once the API is healthy. For each
  address in `allowed-emails.txt` it finds the agent-swarm user with that
  email (or alias), creating one if needed, and mints that user an `aswt_`
  token labelled `dashboard-sso`. It keeps a token that still works and
  revokes the `dashboard-sso` tokens of anyone no longer listed. A suspended
  user gets none.
- The tokens live only in `/opt/agent-swarm/dashboard-tokens.caddy`
  (owner-only, not in git or the config bucket), as Caddy `map` entries.
- Caddy maps the signed-in address (`X-Auth-Request-Email` from
  oauth2-proxy, ignoring case; any copy the client sends is dropped) to
  that token and
  sends it as the `Authorization` header on the login-gated API paths. A
  signed-in address with no token gets a 403.
- `build-ui.sh` builds the dashboard locked to this API with a placeholder
  key (`VITE_API_URL`, `VITE_API_KEY=aswt_sso_gateway`). The `aswt_` prefix
  makes the dashboard read its identity from `/api/whoami` instead of asking
  who you are. It is rebuilt whenever the login mode changes
  (`ui-dist/.agent-swarm-version` records version and mode).

Machine clients on the bypass paths (`/mcp`, `/mcp-user`, webhooks) keep
their own bearer.

What a person can do is what agent-swarm lets a user token do, which
depends on their role. `host/admin-emails.txt` is the admin list: after the
token sync, `sync-dashboard-users.sh` gives those addresses the built-in
`admin` role and every other swarm user, including people the swarm only
knows from Slack, `requester` (create, steer and cancel their own tasks; no
config changes, no answering approvals). Grant or revoke admin with a PR to
that file; an address there also needs to be in `allowed-emails.txt` to
sign in. Roles set by hand in the API are overwritten on the next deploy.

An admin can do nearly everything the operator key can do, with tasks,
config and token changes attributed to them. On v2.6.0 a user token cannot create or edit swarm-scope MCP servers (lead only),
steer a task someone else requested, refresh the model catalog, or read the
asset key audit. Do those with `API_KEY` from the host (as
`sync-agent-config.sh` does).

## GitHub App

Off until the secret holds `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` (all three or none; `render-env.sh` refuses a partial
set). Then it renders `GITHUB_DISABLE=false` and the API accepts GitHub App
webhooks at `/api/github/webhook`: `@`-mentions of the bot start tasks and
the bot reacts to the comment. The same App keys also let agents push and
open PRs as `delegate-gp[bot]` (see "Git identity" below). The webhook path is open in both Caddy modes
(the signature is the credential).

1. Create the App in the thegoodparty org with webhook URL
   `https://delegate-swarm.infra.goodparty.org/api/github/webhook`, Issues and
   Pull requests Read and write, and the comment, review, issue and pull
   request events. Install it on all repositories in the org, which is what it
   is today; the ones that matter are `omni`, `ops` and `gp-pi`, the last for
   the merge exception in the lead's soul. Download a private key.
2. `AWS_PROFILE=gp-infrastructure ./fill-secrets.sh --github-app` from this
   directory. It generates the webhook secret if the secret has none (read it
   from Secrets Manager and paste it into the App), asks for the App id,
   takes the path to the `.pem` and stores it base64 on one line (the API
   accepts base64 or raw PEM; raw does not survive `.env`), and asks for the
   bot name (the App slug). `GITHUB_BOT_ALIASES` is set to `delegate-gp-bot`.
3. On the host, `sudo -u ec2-user AWS_REGION=us-west-2 /opt/agent-swarm/up.sh`.

### Git identity

With the App keys in the secret, workers author git pushes and `gh` calls as
`delegate-gp[bot]`. The agent containers receive `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY`; `host/global-setup-script.sh` (root, every container
start) installs `/usr/local/bin/gh-app-token`, a system git credential helper
for `github.com` and a `gh` wrapper that sets `GH_TOKEN`. The helper signs an
App JWT with openssl, resolves the installation for the repo owner, mints a
~1h installation token and caches it per owner under `~/.cache/gh-app-token`
(refreshed within 5 minutes of expiry). If anything fails (no installation for
that owner, bad key, GitHub down) it prints a one-line note on stderr, never a
secret, and returns no token (there is no PAT fallback). Commits are authored
`delegate-gp[bot] <268660869+delegate-gp[bot]@users.noreply.github.com>`
(268660869 is the bot user id, not the App id; GitHub links the email to the
App by user id). The App only
reaches repos it is installed on, which today is every repo in the org;
`omni`, `ops` and `gp-pi` are the ones it is used on.

A merge that changes `global-setup-script.sh` restarts the agents on deploy
(see "Swarm state this repo owns"). Check from a worker: `gh-app-token >/dev/null`
prints no note, and `gh api repos/thegoodparty/ops --jq .full_name` works.

### Hill-climb permissions

The swarm proposes delegate reviewer changes and measures them with
`delegate-eval-run.yml`; it never merges them. These settings live in GitHub,
not in this repo, so they are recorded here. Checked 2026-11-06.

- `delegate-gp` has `actions: write` on its installation, which is what
  `gh workflow run delegate-eval-run.yml --ref main ...` and `gh run download`
  need. It also lets the App re-run or cancel any ops workflow, and it holds
  `workflows: write`; both are accepted for now. A workflow it pushes to a
  branch gets no AWS access, because the eval roles trust only the workflow
  files on ops `main` (`job_workflow_ref` in `deploy/components/ci-roles/policies.ts`).
- Merging needs a human. The eval reads only
  `delegate/agents/pr-reviewer.ts` and `pr-reviewer-subagents.ts` from a
  candidate branch, but nothing stops a PR from touching more. What guards it
  is `.github/CODEOWNERS`: its `*` default gives every path, `delegate/`
  included, to `@thegoodparty/gp-contrib`. The
  `main` ruleset requires a code-owner review, and its only bypass actor is
  an organization admin. An App can't be a code owner, so neither
  `delegate-gp` nor `delegate-reviewer` can approve one of these PRs in a
  human's place. Never add either App as a bypass actor or move `delegate/`
  to the CODEOWNERS opt-out list.
- The swarm can't run as the eval. `DELEGATE_EVAL_APP_PRIVATE_KEY` is an
  Actions secret on ops, outside the `DELEGATE_SWARM` keys, and Actions
  secrets can't be read back through the API. The eval roles trust only
  GitHub's OIDC provider, so the host role can't assume them.

## What lives in this repo and what lives in the swarm

The swarm keeps scripts, skills, schedules, souls, identities and plain
config in its own database, and the lead has a tool for each. Set those up by
asking Delegate in Slack, not with a PR. Nothing in this repo writes them, so
a change made from Slack or the dashboard survives every deploy.

- Scripts: ask Delegate to save the script to the global catalog
  (`script-upsert`). It typechecks on save.
- Skills: ask Delegate to create the skill and install it on the agent that
  needs it (`skill-create`, `skill-install`).
- Schedules: ask Delegate to create, disable or delete the schedule
  (`create-schedule`, `update-schedule`, `delete-schedule`). Do not use
  `POST /api/schedules`: that route does not record which agent created the
  schedule, so a script schedule runs as an agent that does not exist.
- Souls and identities: ask Delegate to update its own or another agent's
  (`update-profile`).
- Config: ask Delegate to set plain keys (`set-config`). Secrets are the
  exception: set them yourself in the dashboard as secret config, and never
  paste a secret into Slack.

A PR is the way to change anything else: the host (`docker-compose.yml`,
`Caddyfile`, `render-env.sh`, the worker image), AWS access
(`deploy-infrastructure/`), the Slack manifest, the login and admin lists,
and the three pieces of swarm state below. If a new script needs one of
those, for example an S3 permission or a Slack scope, only that part is a PR.

### Swarm state this repo owns

`host/sync-agent-config.sh` writes three things into the swarm's database.
`up.sh` runs it on every deploy, after the stack is up, so merging is all a
change to them needs:

- the global `SETUP_SCRIPT` config, from `host/global-setup-script.sh` (runs
  as root at every agent container start)
- the grafana and clickup MCP servers, installed on all three agents
- each agent's harness and model, from `HARNESS_PROVIDER` and the
  `*_MODEL_OVERRIDE` values `render-env.sh` writes

It restarts the lead and both workers only when the setup script changed or
an MCP server was newly installed, because agents read those at start. A
model change applies to the next session without a restart. A harness or
model set by hand in the dashboard is replaced on the next deploy.

To apply them without a deploy, on the host:

```sh
sudo -u ec2-user /opt/agent-swarm/sync-agent-config.sh
```

### Panel hand-offs

The panel-wave scripts and the `scale-to-win-panel-wave` skill keep their
source and tests in `host/scripts/` and `host/skills/`, but the deploy does not
ship them (`hostFiles` in `deploy-infrastructure/agent-swarm.ts` leaves both
directories out), and nothing pushes them into the swarm. The swarm's copies
are the live ones. To put an edit live, merge it, then ask Delegate to save the
script to the global catalog, or update the coder's skill, from the file on
`main`.

`s2w-2fa-code` computes the Scale to Win sign-in code from the config key
`S2W_TOTP_SEED`, which a human sets at agent scope on the coder agent. It
returns only the 6-digit code, and waits for the next 30-second step when under
5 seconds remain. A rejected code usually means worker clock drift, so check
NTP before touching the seed.

The hand-off scripts find work in the `#tevyn-api` posts gp-api writes for an
agent wave and send replies back through S3. They read these global config
keys (not secret except the token): `SLACK_BOT_TOKEN` (needs `channels:history`
and `files:read`), `TEVYN_API_CHANNEL_ID`, `PANEL_WAVE_AGENT_ID` (the coder's id;
`panel-waves-tick` sends its tasks to it), `HANDOFF_ENV` (`dev` or `prod`; dev
and prod share the channel, so only posts whose block `env` matches are taken)
and `REPLIES_BUCKET` (`tevyn-poll-csvs-develop` for dev, `-master` for prod;
optional `REPLIES_BUCKET_REGION`, default `us-west-2`). They live in the
swarm, so switching to prod is setting `HANDOFF_ENV` and `REPLIES_BUCKET` in
the dashboard or asking Delegate. The token is the existing global
`SLACK_BOT_TOKEN` secret (the Delegate bot's token). The host role may
only `s3:PutObject` under `agent-replies/` in the two buckets; gp-api's bucket
policy grants the other half.

- `tevyn-handoffs-new` returns the hand-off posts it has not returned before,
  as compact JSON (outreachId, sendAt, timeZone, mode, repliesKey, message,
  recipientCount, channel, ts). It keeps a cursor in KV (`tevyn:cursor`) and
  claims each outreach id as `handoff:<outreachId>` = `{ state: 'new', slackTs,
  channel, sendAt, timeZone, mode, message, recipientCount }`, so an id is
  returned once and can still be handled from KV if nobody got its output. Posts without the "Delegate is handling this wave"
  note or with an invalid machine block are skipped.
- `tevyn-handoff-csv` (`channel`, `ts`) saves the post's recipient CSV under
  `/afs/tevyn-handoffs/` and returns only that path, never the Slack URL.
- `s2w-replies-upload` (`outreachId`, `exportPath`) PUTs the export to
  `agent-replies/<outreachId>.csv` in `REPLIES_BUCKET`, signed with SigV4 from
  the instance role's IMDS credentials (the swarm API container reaches IMDS
  at hop limit 2), returns the key and byte count, then deletes the export from
  agent-fs. A failed PUT keeps the export.

- `tevyn-thread-reply` (`channel`, `ts`, `text`, optional `filePath`) replies in a
  hand-off post's thread with `chat.postMessage`, or, with a png or jpg under
  `/afs/`, uploads it into the thread (`files.getUploadURLExternal` and
  `files.completeUploadExternal`, text as the comment) and deletes it from
  agent-fs. Worker agents have no Slack tools in agent-swarm (posting and
  uploading are lead-only), so the coder uses this script. It refuses text that
  looks like a phone number. The script filesystem is text only, so the image
  is read through `ctx.sh('base64 ...')`; smoke-test one upload on the host
  after the first deploy.
- `panel-waves-tick` is the dispatcher, meant to run on a schedule (below). Each
  run it (1) runs `tevyn-handoffs-new` through `ctx.swarm.script_run`, because
  catalog scripts cannot import each other, only to trigger the claim (the claim
  record already holds the hand-off, so the output is ignored and a failed run
  still leaves the KV scan, flagged as `triggerFailed`); (2) lists
  KV by the `handoff:` prefix; (3) for each record it should act on, writes
  `lease:<outreachId>` with a one hour expiry and bumps `attempts` (counted per action, with `attemptsFor`), then creates
  one coder task, "Handle <id> (schedule|export_replies) following the
  scale-to-win-panel-wave skill", `modelTier: regular`, carrying the hand-off
  fields as JSON. A record with a live lease is skipped, so a slow task is not
  started twice; if the task cannot be created the lease is dropped so the next
  run retries. It acts on `new` records, on `building` records with no live
  lease (a task that died mid-run), and on `scheduled` and `built` records past
  `repliesDueAt` (a shadow wave is scheduled by a person but exported by the
  agent). It leaves `replies_uploaded` and `needs_human` alone,
  and stops at 5 attempts per action. Its result lists `dispatched`, `skipped` (records
  with no stored details, exhausted attempts, unreadable) and `failed`; look
  there when a wave seems stuck. It sends with `allowDuplicate: true` because two
  waves posted together read as near-copies to the duplicate check.

### KV states

`handoff:<outreachId>` is shared by the scripts and the skill:

| state | meaning |
| --- | --- |
| `new` | claimed by `tevyn-handoffs-new`, waiting for a schedule task |
| `building` | a schedule task is working in S2W; a rerun resumes it |
| `built` | `mode: shadow`, campaign built, a person schedules it; replies due at `sendAt` + 48h |
| `scheduled` | `mode: auto`, scheduled and read back; replies due at `repliesDueAt` |
| `replies_uploaded` | replies export is in S3 |
| `needs_human` | the skill escalated in the post's thread; nothing touches it until a person clears the record |

`lease:<outreachId>` is `{ expiresAt }` with a one hour KV expiry. To release a
stuck item early, delete the `lease:` key; to retry an escalated one, set its
state back (`new` for a schedule, `scheduled` for an export) and clear
`needsHumanStep` and `needsHumanCause`.

### Scale to Win skill

`host/skills/scale-to-win-panel-wave/SKILL.md` is the coder's instructions for
building and scheduling a wave in Scale to Win with `agent-browser` and for
exporting its replies. It is installed on the coder. It needs these agent-scope config keys on the
coder, set by a human: `S2W_USERNAME`, `S2W_PASSWORD` and `S2W_TOTP_SEED`
(exported to the environment for the first two). The browser profile lives at
`/workspace/personal/s2w-browser-profile` on the coder's volume.

### Schedules

Nothing in this repo creates schedules; Swain decides which to add. To run the dispatcher every 5 minutes, ask Delegate in Slack to create a
recurring script schedule for `panel-waves-tick` every 300000 ms. From the
host, make the same call through the MCP bridge as the lead. Do not use
`POST /api/schedules`: the REST route does not record which
agent created the schedule, so the script would run as a placeholder agent that
does not exist and could not run `tevyn-handoffs-new` or create tasks.

```sh
cd /opt/agent-swarm
KEY="$(sed -n 's/^API_KEY=//p' .env)"; LEAD="$(sed -n 's/^LEAD_AGENT_ID=//p' .env)"
curl -sS --fail-with-body -X POST http://127.0.0.1:3013/api/mcp-bridge \
  -H "Authorization: Bearer $KEY" -H "X-Agent-ID: $LEAD" -H 'Content-Type: application/json' \
  -d '{"tool":"create-schedule","args":{"name":"panel-waves-tick","scheduleType":"recurring","targetType":"script","scriptName":"panel-waves-tick","intervalMs":300000}}'
```

The same call as a tool is `create-schedule` with `targetType: "script"`,
`scriptName: "panel-waves-tick"`, `intervalMs: 300000`. Disable the schedule
to pause all panel waves.

Anything else goes through the dashboard or the API at
`https://delegate-swarm.infra.goodparty.org` (`http://127.0.0.1:3013` on the host)
with `Authorization: Bearer $API_KEY` (the `API_KEY` key in the secret).

## Agents

| Role | Name | Id | Model |
| --- | --- | --- | --- |
| lead | Delegate | `9f8efd62-469d-4067-9dca-24d72b13864b` | fireworks-us/accounts/fireworks/routers/deepseek-v4p1-flash-1017-us |
| coder | Coder | `458bcd6d-4384-4366-83fa-63072ef55eab` | fireworks-us/accounts/fireworks/routers/deepseek-v4p1-flash-1017-us |
| reviewer | Reviewer | `a0799d09-6816-445a-957d-1339b672d38b` | fireworks-us/accounts/fireworks/routers/deepseek-v4p1-flash-1017-us |

Every agent runs the pi harness. `render-env.sh` sets `HARNESS_PROVIDER=pi`
and the provider-prefixed models as the container defaults, and
`sync-agent-config.sh` writes the same values as each agent's runtime on
every deploy. That runtime is agent-scope config, which wins over the
container defaults, so a model changed in the dashboard lasts only until the
next deploy. The api container gets no model setting: it
reads none (session summaries use their own pinned model, and workflow LLM
nodes need an OpenRouter or OpenAI key, which this swarm does not have).

The first task after switching an agent's harness can fail: the worker
claims it before it reconciles the new harness, about 10 seconds. Re-run it.

`AGENT_NAME=delegate` on the lead only names a newly registered lead. The
existing one is renamed with `PUT /api/agents/{id}/name`.

### Models

The swarm runs **Fireworks US-only**, on exactly one model: the DeepSeek V4.1
Flash **1017 US** router,
`accounts/fireworks/routers/deepseek-v4p1-flash-1017-us`. There is no second
model and no fallback model.

**US-only takes both halves, and either one alone is wrong.** The endpoint must
be the US host, `https://us.api.fireworks.ai/inference`, and the model id must
be a US-only router (`accounts/fireworks/routers/<model>-us`). A US router
addressed at the global endpoint, or a global model id at the US endpoint, is
a global request that looks configured and logs nothing unusual. The rule and
the reason are in `docs/bifrost-gateway.md`, "Inference residency";
`host/scripts/fireworks-residency.test.ts` enforces it for this host.

Where it lives:

- `host/global-setup-script.sh` writes `models.json` into
  `/workspace/personal/.pi` on every container start, as root, before the
  privilege drop, and chowns it to the worker. `PI_CODING_AGENT_DIR` in
  `docker-compose.yml` names the same directory, and the test fails if the two
  drift. Nothing writes to `/root/.pi`: that would be invisible to the worker.
- The provider id is `fireworks-us`, not pi's built-in `fireworks`. On pi
  1.5.0 a `models` entry on a built-in provider is **added** to that
  provider's catalogue rather than substituted for it, so listing only the US
  router under `fireworks` still leaves every global Fireworks model
  selectable. The separate id is what makes the one-model rule real; the
  built-in `fireworks` block is left with an `apiKey` that resolves to nothing,
  so pi refuses a global id with "No API key found for fireworks".
- Cost is the US-only price, $0.45 in / $0.009 cached / $1.80 out per 1M
  tokens, 1.5x the global endpoint. pi's built-in catalogue carries
  .3 / .006 / 1.2 for the `-1017` entries, so the file overrides it; without
  that the dashboard under-reports the bill by a third.

**Adding a model is a reviewed change, not an automatic upgrade.** Adding one
means minting a new dated US router id with Fireworks and editing
`host/global-setup-script.sh` and `host/render-env.sh` together, in one PR that
re-opens the residency and cost decision. Bumping the release (say `1017` to a
later date) is the same edit; there is no `-latest` US router to track it, which
is why the dated id is pinned deliberately.

`FIREWORKS_API_KEY` is a key in the `DELEGATE_SWARM` secret (see "Where it
runs"). `ANTHROPIC_API_KEY` stays in the secret and in the worker env for the
api service and as a fallback path, but no agent runs an Anthropic model.

## MCP servers

Both are scope swarm, installed on all three agents, and registered by
`sync-agent-config.sh`.

- grafana: the `grafana-mcp` sidecar at `http://grafana-mcp:8000/mcp`,
  pinned by digest. It has no caller auth; only the compose network reaches
  it and Caddy does not route to it.
- clickup: the hosted server at `https://mcp.clickup.com/mcp`, with OAuth.
  `sync-agent-config.sh` installs it only once it is connected (Bringing it
  up, step 6).

## Slack

- The existing Delegate Slack app, in Socket Mode, configured from
  `slack-manifest.json`. The manifest leaves out `chat:write.customize`, so
  Slack ignores the per-agent name and emoji agent-swarm sends and every
  message shows the Delegate app's own name and icon.
- Gate: `SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org`. This needs the
  `users:read.email` bot scope, which `slack-manifest.json` includes.
- Channel threads: Delegate answers only when @mentioned
  (`SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION=true` on the api service). Without
  it, agent-swarm routes every untagged reply in a thread it was ever tagged
  in back to the agent. DMs and the assistant pane do not need a mention.
- Panel hand-offs: `slack-manifest.json` already lists `chat:write`,
  `chat:write.public`, `files:read`, `files:write` and `channels:history`, which
  the hand-off scripts need. If the
  app was installed before those scopes were added, a human must reinstall it
  (Settings, Install App, Reinstall to GoodParty; the bot token stays the same
  unless Slack rotates it), and the bot must be a member of `#tevyn-api`
  (`/invite @delegate`), or uploads into the thread fail with `not_in_channel`.
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

The swarm starts with fresh state. In order:

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
   start pulls the images (the worker image is about 5 GB), builds the
   patched worker image and the dashboard. Check `curl -s http://127.0.0.1:3013/health` and
   `cd /opt/agent-swarm && sudo docker compose ps`.
4. **Agent config.** The start ends with `sync-agent-config.sh`, which waits
   up to 5 minutes for the three agents to register, then prints one line
   per item (`journalctl -u agent-swarm`). ClickUp shows as not connected;
   that is step 6.
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
   `sudo -u ec2-user /opt/agent-swarm/sync-agent-config.sh`, which installs
   it on the three agents and restarts them.
   Connect before install: an agent session that meets the server before it
   is authorized skips it for days.
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
agent ids. Starting from a blank data volume gives an empty swarm with only
what `sync-agent-config.sh` writes; scripts, skills, schedules, souls and
config come back only from a snapshot.
