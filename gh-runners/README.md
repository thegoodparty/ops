# gh-runners

Self-hosted GitHub Actions runners on ECS, in the `goodparty-infrastructure`
account. Workflows target them with `runs-on: gp-ecs`. Every job gets a fresh
runner task that exits when the job ends.

Status: prototype. The infrastructure deploys inert: nothing runs until the
GitHub App's webhook points at the dispatch URL (switch-on steps below).

## How it works

```
GitHub App webhook (workflow_job, action=queued)
        |
        v
Lambda Function URL (gh-runners-dispatch)
        |  verify X-Hub-Signature-256, filter labels and repo
        |  POST /orgs/thegoodparty/actions/runners/generate-jitconfig
        |  ecs:RunTask with the JIT config as an env override
        v
runner task (ECS on EC2)  one job, then exit
```

- **Dispatch** is `deploy-infrastructure/gh-runners-dispatch/handler.ts`,
  bundled by esbuild in `deploy-infrastructure/gh-runners.ts`. It acts only on
  a `workflow_job` `queued` event from `thegoodparty/ops` or
  `thegoodparty/omni` whose labels include `gp-ecs` and are all among the
  runner's labels (`self-hosted`, `linux`, `x64`, `gp-ecs`). Everything else
  gets a 200 and is ignored. It mints a single-use JIT runner config in the
  `gp-ecs` runner group and starts one runner task with it. A failure returns
  500, so the delivery shows as failed in GitHub and can be redelivered. Logs
  are one JSON line per decision in `/gh-runners/dispatch`.
- **runner/** is `ghcr.io/actions/actions-runner` plus Docker Engine and the
  tools hosted Ubuntu runners have. Each task runs its own `dockerd`, so
  `services:` containers on `localhost`, `docker build` and `sudo apt-get` work
  as they do on `ubuntu-latest`. A runner that is not assigned a job within
  15 minutes exits on its own. See `runner/README.md`.
- **Compute** is an ECS capacity provider over an EC2 Auto Scaling group
  (`m7i.2xlarge`, two 4 vCPU / 14 GiB runners per host, up to 4 hosts). ECS
  managed scaling adds hosts for queued tasks and never removes a host that is
  running one. One host stays warm 06:00-19:00 Pacific on weekdays, so the
  first job of the day does not wait about 3 minutes for a boot and a 2.7 GB
  image pull. Fargate cannot run `dockerd`, which is why runners are on EC2.
- **Images** are tagged with a hash of their directory. `push-images.sh`
  builds and pushes the runner image in `deploy-infrastructure.yml`, and the
  task definition computes the same tag, so an unchanged image never shows a
  diff.

## Security model

**omni and ops are public repositories.** Anyone who can get a workflow to run
against `gp-ecs` runs code on our hosts. Read this before pointing any job at
these runners.

- Runner tasks are privileged (dockerd needs it). A job can escape to its
  host, and a host runs two jobs at once. Assume a job can read the other job
  on the same host, including its OIDC-issued deploy credentials.
- Runner tasks have no task role. IMDS hop limit 1 stops casual access from
  the nested job containers, but a privileged runner can enter the host's
  network namespace and reach IMDS directly, so assume every job holds the
  instance role (`AmazonEC2ContainerServiceforEC2Role` and
  `AmazonSSMManagedInstanceCore`). That role must stay minimal: grant it
  nothing else. A job's own AWS access should come only from its OIDC token,
  as on hosted runners.
- The JIT config travels as a RunTask env override, so anyone with
  `ecs:DescribeTasks` in this account can read it until the runner uses it.
  It is single-use.
- The dispatch endpoint is a public Function URL. Its only authentication is
  the webhook HMAC (`X-Hub-Signature-256` with the App's webhook secret); a
  request without a valid signature gets a 401 before anything else happens.
  The Lambda's role can only start `gh-runner` tasks in this cluster, tag them
  at launch, and pass the runner execution role.

Two rules follow, and both must hold before omni uses `gp-ecs`:

1. Fork PR workflows need approval for **all** outside contributors, not just
   first-time ones. Today both repos are on `first_time_contributors`.
2. Only trusted events reach `gp-ecs`. Fork PRs stay on hosted runners:
   `runs-on: ${{ github.event.pull_request.head.repo.fork && 'ubuntu-latest' || 'gp-ecs' }}`

## Switch-on

Each step needs an org owner or a human approver. No follow-up PR is needed.

1. Create a GitHub App owned by `thegoodparty` with organization permission
   **Self-hosted runners: read and write** and nothing else. Subscribe it to
   **Workflow job** events. Set the webhook URL to the stack output
   `ghRunnersWebhookUrl` and the webhook secret to a generated value
   (`openssl rand -hex 32`). Install it on the org.
2. Create an org runner group named `gp-ecs`, limited to selected repositories
   (ops first, then omni), with **Allow public repositories** on.
3. Set fork PR approval to all outside contributors on every repo in the group.
4. Fill the secret (the account's admin role, or a break-glass session):

   ```bash
   aws secretsmanager put-secret-value --region us-west-2 \
     --secret-id GH_RUNNERS_GITHUB_APP \
     --secret-string "$(jq -n --arg id <app-id> --arg inst <installation-id> \
       --rawfile key <app>.private-key.pem --arg hook <webhook-secret> \
       '{app_id:$id, installation_id:$inst, private_key:$key, webhook_secret:$hook}')"
   ```

5. Run the `gh-runners smoke` workflow in ops.

## Logs

CloudWatch in 394495727159: `/gh-runners/dispatch` for the Lambda, and
`/gh-runners` with stream prefix `runner/` for runner tasks.

## Known gaps

- A dropped webhook delivery leaves its job queued until someone redelivers it
  by hand from the App's advanced settings (Recent Deliveries).
- A double delivery starts an extra runner; the idle timeout reaps it after
  15 minutes.
- If RunTask fails after a JIT config is issued, the unused runner
  registration is left for GitHub to expire.
- No spot capacity, one subnet (one AZ), and no shared Docker layer or npm
  cache across hosts yet. Each is a follow-up once the smoke run is green.
