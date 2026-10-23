#!/bin/bash
set -euo pipefail

if [[ -z "${ACTIONS_RUNNER_INPUT_JITCONFIG:-}" ]]; then
  echo "entrypoint: ACTIONS_RUNNER_INPUT_JITCONFIG is empty" >&2
  exit 1
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "entrypoint: must run as root to start dockerd" >&2
  exit 1
fi

# cgroup v2 nesting (same as moby's hack/dind): move our processes out of the
# root cgroup so dockerd can enable controllers for its child cgroups.
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control || true
fi

rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid
mkdir -p /var/lib/docker
dockerd --data-root /var/lib/docker --group docker > /var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!

stop_dockerd() {
  if kill -0 "$DOCKERD_PID" 2>/dev/null; then
    kill -TERM "$DOCKERD_PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$DOCKERD_PID" 2>/dev/null || return 0
      sleep 1
    done
    kill -KILL "$DOCKERD_PID" 2>/dev/null || true
  fi
}

ready=0
for _ in $(seq 1 60); do
  if docker info > /dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$ready" != "1" ]]; then
  echo "entrypoint: dockerd did not become ready within 60s" >&2
  cat /var/log/dockerd.log >&2
  stop_dockerd
  exit 1
fi

chgrp docker /var/run/docker.sock
chmod 660 /var/run/docker.sock
echo "entrypoint: dockerd ready ($(docker info --format '{{.ServerVersion}} {{.Driver}} cgroup{{.CgroupVersion}}'))"

export RUNNER_MANUALLY_TRAP_SIG=1
# Without job control, bash starts background jobs with SIGINT ignored, and
# run.sh delivers our SIGTERM to the listener as SIGINT.
set -m
setpriv --reuid=runner --regid=runner --init-groups \
  env HOME=/home/runner USER=runner LOGNAME=runner \
  /home/runner/run.sh &
RUNNER_PID=$!

forward_term() {
  echo "entrypoint: forwarding SIGTERM to runner"
  kill -TERM "$RUNNER_PID" 2>/dev/null || true
}
trap forward_term TERM INT

set +e
while true; do
  wait "$RUNNER_PID"
  RUNNER_EXIT=$?
  kill -0 "$RUNNER_PID" 2>/dev/null || break
done
set -e

echo "entrypoint: runner exited with $RUNNER_EXIT, stopping dockerd"
stop_dockerd
exit "$RUNNER_EXIT"
