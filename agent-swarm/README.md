# agent-swarm

A second incident system, running alongside [BugBoss](../bugboss) on its own
host, built from [desplega-ai/agent-swarm](https://github.com/desplega-ai/agent-swarm)
rather than from scratch.

> **Status: a playground, deployed by hand, deliberately not merged.** The PR that
> carries this directory exists to be read and demonstrated, not landed. Nothing
> here runs in CI and nothing here is created by a Pulumi apply. See
> [Deploying](#deploying) for what it does create.

## Why this exists

BugBoss is about 24,600 lines of TypeScript and it works. It also had to build
everything an agent system needs: a Slack app and thread relay, a dispatcher and
worker pool, session persistence and resume, a tool surface, a search index over
past incidents, and a scheduler that survives a deploy.

agent-swarm ships all of that. It is an open-source agent operating system with a
lead agent that delegates to workers, persistent memory, key-value state,
schedules, workflows, a Slack app and a task lifecycle. So the question this
directory answers is concrete:

**Can the incident system itself become thin, if the machinery underneath it comes
off the shelf?**

Everything BugBoss encodes in code is here instead expressed as configuration and
one operating prompt: the state machine, the Slack report shapes, the board, the
all-closes rules. [docs/code-comparison.md](./docs/code-comparison.md) measures
what that costs and what it gives up.

## What actually gets deployed

One EC2 host (`m6a.xlarge` by default, Amazon Linux 2023) running six containers:

| Service | What it is |
| --- | --- |
| `api` | agent-swarm's control plane: the task store, KV, schedules and Slack app |
| `litestream` | streams the SQLite database to S3, so the record survives the host |
| `lead` | the incident commander. The only agent with the custom prompt |
| `coder-1`, `coder-2` | two coder agents, so one incident can be worked in parallel |
| `bridge` | turns Grafana alerts into incident tasks |

```
Grafana alert ──► ALB ──► bridge ──► api ──► lead ──► coder-1
                                        │              coder-2
                                        └──► SQLite ──► litestream ──► S3
                                        └──► Slack (#swarm-incidents)
```

Only two host ports exist, 3013 and 3014, and both sit behind the load balancer.
The agents never listen: they poll outbound, which is what lets them run behind a
security group that blocks everything inbound except the ALB.

## The thin layer

Everything that makes this behave like an incident system rather than a general
agent fleet:

| Piece | Size | What it does |
| --- | --- | --- |
| [`bridge/`](./bridge) | 469 lines | Verifies Grafana's signature, de-duplicates by fingerprint, numbers incidents, creates the task |
| [`incident-commander.md`](./incident-commander.md) | 534 lines of prompt | The state machine, the KV schema, the three Slack report shapes, the board, evidence rules |
| [`seed.sh`](./seed.sh) | 219 lines | Creates the three recurring jobs: morning board, all-clear, stale sweep |
| [`deploy.sh`](./deploy.sh) | Infra | Everything in AWS, idempotent |
| [`docker-compose.yml`](./docker-compose.yml) | Config | The stack above |

Those three lines of real code and prompt are the whole incident system: 1,222
lines against BugBoss's 24,594. Everything else in that count is a shell script
that creates AWS resources or a compose file that starts containers.

Incidents live in agent-swarm's key-value store, one key per incident at
`incident:<n>`, with BugBoss's exact status vocabulary:
`INVESTIGATING -> FIXING -> RESOLVED -> CLOSED`, and `MERGED` when one incident
absorbs another. The board and the reports are agent tasks on a schedule. There is
no incident table, no transition function, and no dispatcher, because none of those
had to be written.

## Before you can deploy

Three things only a person can do. Do them first, in any order.

1. **Install the Slack app.** One page of clickops. Follow
   [slack/INSTALL.md](./slack/INSTALL.md). You end up with a bot token, an
   app-level token, and a channel id.
2. **Add the swarm to Grafana's alert path.** A second webhook integration on the
   existing `dev-alerts` contact point, so both systems see every alert and each
   fails independently. Follow [grafana/ADD-INTEGRATION.md](./grafana/ADD-INTEGRATION.md).
3. **Fill in the secret.** The `AGENT_SWARM` secret already exists with an
   Anthropic key, a GitHub token and the bridge's Grafana secrets generated. Add
   the three Slack values from step 1:

```bash
./set-slack-credentials.sh      # prompts with input hidden, prints only lengths
```

## Deploying

```bash
cd agent-swarm
./deploy.sh          # creates the infra, boots the host, starts the stack
```

`deploy.sh` is idempotent and prints what it created versus what it found. It
creates: a security group, an instance role and profile, an S3 bucket, a load
balancer with two target groups and two listener rules, a DNS record, an EC2
instance, and then pushes the stack to the host over SSM and starts it.

It does **not** create the `AGENT_SWARM` secret, because secrets are clickops
here. It fails with a clear message if the secret is missing.

Once it finishes:

```bash
# the recurring jobs, once, from your laptop
SWARM_BASE_URL=https://agent-swarm.goodparty.org \
AGENT_SWARM_API_KEY="$(aws secretsmanager get-secret-value --secret-id AGENT_SWARM \
  --region us-west-2 --query SecretString --output text \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["API_KEY"])')" \
  ./seed.sh

# prove the alert path without touching a real alert rule
./grafana/send-test-alert.sh https://agent-swarm.goodparty.org
```

The test alert opens a real incident and reports it in Slack. That is the thing to
watch: [docs/slack-surface.md](./docs/slack-surface.md) is the reference for what
should appear, in what order, and what would count as wrong.

## Operating it

Day two, with real commands: [docs/operating.md](./docs/operating.md). The short
version is that everything is on one host under `/opt/agent-swarm`, state is under
`/var/lib/agent-swarm`, you reach the host with `aws ssm start-session` and never
with SSH, and `docker compose logs -f lead` is where you watch it think.

## What it is not

- **Not a bugboss replacement, and not wired to be one.** Both systems see every
  alert and both will open pull requests for the same incident. It has its own
  channel and its own identity specifically so the two can be compared.
- **Not as strict as bugboss.** The prompt is the only thing enforcing the state
  machine. There are no database constraints, no guarded writes, and no
  "the model proposes, the rules decide" split. [docs/code-comparison.md](./docs/code-comparison.md)
  says exactly where that floor is missing; the prompt itself closes with the same
  list.
- **Not a long-lived deployment yet.** It is one host with no autoscaling and no
  multi-AZ. If the instance is replaced, the incident history is restored from
  Litestream into a fresh instance, which takes a manual step.

## Cost

The instance is the lever. Defaults are `m6a.xlarge` (4 vCPU, 16 GiB) and a
100 GiB disk, which is about **$135 a month**: roughly $4.15 a day for the host,
$8 for the disk, and $16 to $20 for the load balancer. The load balancer is fixed
whatever the instance size, so the instance is where a saving lives.

| Instance | vCPU / GiB | Per day | Per month |
| --- | --- | --- | --- |
| `m6a.xlarge` (default) | 4 / 16 | $4.15 | $126 |
| `m6a.2xlarge` | 8 / 32 | $8.29 | $252 |
| `m7i.2xlarge` | 8 / 32 | $9.68 | $294 |

Sizes are set by flag, not by editing the script:

```bash
./deploy.sh --instance-type m6a.2xlarge --disk-size 200
```

Two things not to do. Do not use a **Graviton** instance (`m7g`, `m6g`): both
swarm images are built for `linux/amd64` only, so on arm64 they run under
emulation, slowly and occasionally wrongly. And do not expect a **Spot** instance
to keep watching alerts: it is cheap until it is reclaimed, which takes the whole
system down with no restart.

Upstream publishes no host size at all, only per-container requests, and its
minimal two-pool example asks for 750m CPU and 1.5 GiB. The default here is a
judgement with headroom rather than a recommendation being honoured, and the
workload is I/O bound, so memory is the thing to keep room in rather than CPU.

Stopping the instance when you are not watching costs almost nothing but the
swarm stops receiving alerts. `./teardown.sh --yes` removes everything except the
S3 bucket, which holds the incident history; pass `--purge-bucket` only if you
mean to destroy the record.
