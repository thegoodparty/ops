# gh-runners runner image

Ephemeral self-hosted GitHub Actions runner for ECS-on-EC2. One task runs one job, then exits.

The image is `ghcr.io/actions/actions-runner` plus Docker Engine (docker-ce, containerd, buildx, compose) and the common tools jobs expect from hosted Ubuntu runners. The container runs its own `dockerd`, so `services:` containers, `docker build`, and `sudo apt-get` work, and published service ports (for example `5432:5432`) show up on the container's own `localhost`. No host Docker socket is mounted.

`entrypoint.sh` runs as root. It starts `dockerd` with data root `/var/lib/docker`, waits up to 60s for `docker info`, then runs `/home/runner/run.sh` as `runner`. The runner reads its JIT config from `ACTIONS_RUNNER_INPUT_JITCONFIG`. When the runner exits, the entrypoint stops `dockerd` and exits with the runner's exit code. SIGTERM is passed to the runner, which shuts down cleanly (exit 143).

## What the ECS task needs

- `privileged: true`
- bridge network mode, one container
- a task volume mounted at `/var/lib/docker`, backed by host disk (not overlayfs)
- env `ACTIONS_RUNNER_INPUT_JITCONFIG=<encoded_jit_config>`
- no `user` override: the container has to start as root

## Local test

```bash
docker build -t gh-runner:dev gh-runners/runner

JIT=$(gh api -X POST repos/<owner>/<repo>/actions/runners/generate-jitconfig \
  -f name=smoke-$(date +%s) -F runner_group_id=1 \
  -f 'labels[]=self-hosted' -f 'labels[]=gp-ecs-smoke' --jq .encoded_jit_config)

docker run --rm --privileged -v ghr-docker:/var/lib/docker \
  -e ACTIONS_RUNNER_INPUT_JITCONFIG="$JIT" gh-runner:dev
```

Trigger a workflow with `runs-on: [self-hosted, gp-ecs-smoke]`. The container picks up one job and exits 0. Afterwards, run `docker volume rm ghr-docker`.
