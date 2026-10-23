# gh-runners

Self-hosted GitHub Actions runners on ECS, in the `goodparty-infrastructure`
account. Workflows target them with `runs-on: gp-ecs`. Every job gets a fresh
runner task that exits when the job ends.

Status: prototype. The infrastructure deploys with the scaler switched off
(`SCALER_DESIRED_COUNT = 0` in `deploy-infrastructure/gh-runners.ts`). Nothing
runs until the switch-on steps below are done.

## How it works

```
GitHub runner scale set API
        ^  long poll: "N jobs assigned to gp-ecs"
        |
  scaler (Fargate, 1 task)  --ecs:RunTask + JIT config-->  runner task (EC2)
                                                            one job, then exit
```

- **scaler/** is a Go service built on GitHub's
  [`actions/scaleset`](https://github.com/actions/scaleset) client. It
  registers the `gp-ecs` scale set, long-polls for demand, and starts one ECS
  task per assigned job with a single-use JIT runner config. It adopts running
  tasks on restart, so a deploy does not kill jobs. Polling rather than a
  webhook means no public endpoint, no org webhook, and no jobs stranded by a
  dropped delivery: GitHub reports the live job count on every poll.
- **runner/** is `ghcr.io/actions/actions-runner` plus Docker Engine and the
  tools hosted Ubuntu runners have. Each task runs its own `dockerd`, so
  `services:` containers on `localhost`, `docker build` and `sudo apt-get` work
  as they do on `ubuntu-latest`. See `runner/README.md`.
- **Compute** is an ECS capacity provider over an EC2 Auto Scaling group
  (`m7i.2xlarge`, two 4 vCPU / 14 GiB runners per host, up to 4 hosts). ECS
  managed scaling adds hosts for queued tasks and never removes a host that is
  running one. One host stays warm 06:00-19:00 Pacific on weekdays, so the
  first job of the day does not wait about 3 minutes for a boot and a 2.7 GB
  image pull. Fargate cannot run `dockerd`, which is why runners are on EC2.
- **Images** are tagged with a hash of their directory. `push-images.sh`
  builds and pushes them in `deploy-infrastructure.yml`, and the task
  definitions compute the same tag, so an unchanged image never shows a diff.

## Security model

**omni and ops are public repositories.** Anyone who can get a workflow to run
against `gp-ecs` runs code on our hosts. Read this before pointing any job at
these runners.

- Runner tasks are privileged (dockerd needs it). A job can escape to its
  host, and a host runs two jobs at once. Assume a job can read the other job
  on the same host, including its OIDC-issued deploy credentials.
- Runner tasks have no task role, and IMDS hop limit 1 keeps them off the
  instance role. AWS access comes only from each job's own OIDC token, as on
  hosted runners.
- The JIT config travels as a RunTask env override, so anyone with
  `ecs:DescribeTasks` in this account can read it until the runner uses it.
  It is single-use.

Two rules follow, and both must hold before omni uses `gp-ecs`:

1. Fork PR workflows need approval for **all** outside contributors, not just
   first-time ones. Today both repos are on `first_time_contributors`.
2. Only trusted events reach `gp-ecs`. Fork PRs stay on hosted runners:
   `runs-on: ${{ github.event.pull_request.head.repo.fork && 'ubuntu-latest' || 'gp-ecs' }}`

## Switch-on

Each step needs an org owner or a human approver.

1. Create a GitHub App owned by `thegoodparty` with organization permission
   **Self-hosted runners: read and write** and nothing else. No webhook.
   Install it on the org.
2. Create an org runner group named `gp-ecs`, limited to selected repositories
   (ops first, then omni), with **Allow public repositories** on.
3. Set fork PR approval to all outside contributors on every repo in the group.
4. Fill the secret (the account's admin role, or a break-glass session):

   ```bash
   aws secretsmanager put-secret-value --region us-west-2 \
     --secret-id GH_RUNNERS_GITHUB_APP \
     --secret-string "$(jq -n --arg id <client-id> --arg inst <installation-id> \
       --rawfile key <app>.private-key.pem \
       '{client_id:$id, installation_id:$inst, private_key:$key}')"
   ```

5. PR: set `SCALER_DESIRED_COUNT = 1`. After it deploys, run the
   `gh-runners smoke` workflow in ops.

## Logs

CloudWatch log group `/gh-runners` in 394495727159, stream prefixes `scaler/`
and `runner/`.

## Known gaps

- If RunTask fails after a JIT config is issued, the scaler exits and ECS
  restarts it; the unused runner registration is left for GitHub to expire.
- No spot capacity, one subnet (one AZ), and no shared Docker layer or npm
  cache across hosts yet. Each is a follow-up once the smoke run is green.
