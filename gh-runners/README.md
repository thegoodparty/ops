# gh-runners

GitHub Actions runners hosted by AWS CodeBuild, in the infrastructure account.
The resources are in `deploy-infrastructure/gh-runners.ts`.

## What it is

One CodeBuild project, `gh-runners`, with an organization webhook on
`thegoodparty`. When a job is queued in omni or ops, GitHub sends the
`workflow_job.queued` event to CodeBuild. If the job's `runs-on` names the
project, CodeBuild starts a fresh build environment, registers an ephemeral
runner for that one job, and tears it down when the job ends.

A workflow opts in with:

```yaml
runs-on: codebuild-gh-runners-${{ github.run_id }}-${{ github.run_attempt }}
```

The project name in the label has to match exactly, or CodeBuild ignores the
job and it sits queued. The run id and attempt let CodeBuild stop the build
when the run is cancelled. Jobs without the label keep running on
GitHub-hosted runners.

The build is `BUILD_GENERAL1_LARGE` (8 vCPU, 16 GiB) on
`aws/codebuild/standard:8.0` (Ubuntu 24.04), privileged so it has a Docker
daemon for `services:` containers and `docker build`. A job can override the
size or image with extra labels, such as `instance-size:medium`. See
[label overrides](https://docs.aws.amazon.com/codebuild/latest/userguide/sample-github-action-runners-update-labels.html).

The build role can only write its own logs and use the GitHub connection. A
job that needs AWS assumes its own role through GitHub OIDC, the same way it
does on a hosted runner.

## Why CodeBuild rather than our own ECS fleet

There is no runner image, no scaler, and no Auto Scaling group for us to own.
Our side is a project, a webhook and a connection.

Each job gets its own build environment, isolated by AWS. On a shared host, a
privileged job runs next to another job's credentials. Here it does not.

## Cost

On-demand Linux EC2 compute in us-west-2:

| Compute type | vCPU / memory | Price |
|---|---|---|
| `BUILD_GENERAL1_MEDIUM` | 4 / 8 GiB | $0.01 per minute |
| `BUILD_GENERAL1_LARGE` | 8 / 16 GiB | $0.02 per minute |

A build is billed from when it is submitted until it ends, rounded up to the
nearest minute, so provisioning time is billed too. Sources:
[CodeBuild pricing](https://aws.amazon.com/codebuild/pricing/) and the AWS
price list for CodeBuild in us-west-2
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/CodeBuild/current/us-west-2/index.json`,
usage types `USW2-Build-Min:Linux:g1.medium` and `USW2-Build-Min:Linux:g1.large`,
published 2026-09-11).

## Trade-offs

- Cold start. On-demand builds provision a machine per job, so a job waits
  longer to start than on a warm runner. If that hurts, CodeBuild has reserved
  capacity fleets, billed per instance-minute with a 60 minute minimum per
  instance, and a job picks one with a `fleet:<name>` label.
- Label syntax. `runs-on` has to carry the run id and attempt, not a short
  name like `self-hosted`. When one workflow run has several jobs with
  different label overrides, give each job its own unique label too, or GitHub
  can hand a job to the wrong runner and leave another stuck.
- Price. The per-minute rate is above raw EC2, which is what we pay for not
  running the fleet.
- Concurrency is bounded by the account's CodeBuild concurrent build quota.

## Security

omni and ops are public, so anyone can open a fork PR that runs workflows.

- Before omni uses these runners, change the fork PR approval setting from
  first-time contributors to all outside contributors.
- Keep fork PRs on hosted runners:

  ```yaml
  runs-on: ${{ github.event.pull_request.head.repo.fork && 'ubuntu-latest' || format('codebuild-gh-runners-{0}-{1}', github.run_id, github.run_attempt) }}
  ```

- Privileged mode means a job controls its own build container. That container
  belongs to that one job and is gone when the job ends.
- The AWS Connector for GitHub app asks for write access to administration,
  contents, organization webhooks and organization self-hosted runners. Install
  it on selected repositories only, omni and ops.

## Switch-on

1. Merge. The apply creates the connection in `PENDING`, plus the project, the
   role and the log group. No webhook exists yet, so nothing runs.
2. In the infrastructure account console, under Developer Tools, Settings,
   Connections, open the pending `gh-runners` connection and complete it. This
   needs a GitHub organization owner. Install the AWS Connector for GitHub app
   on the `thegoodparty` org, limited to the selected repositories omni and ops.
3. Set fork PR approval to all outside contributors.
4. Open a PR setting `CONNECTION_READY = true` in
   `deploy-infrastructure/gh-runners.ts`. Its apply creates the org webhook.
5. Dispatch the `gh-runners smoke` workflow. It is the first proof that a
   `services:` container is reachable on localhost inside CodeBuild's container
   mode, alongside `docker build`, buildx and `docker run`.
