#!/usr/bin/env bash
# Keeps the data volume from filling. Every clone and worktree an agent makes
# gets its own `npm ci` (about 5 GB and 300k files for omni) and nothing ever
# removed them, so on 2026-11-06 the volume ran out of space and inodes and
# SQLite stopped taking writes for 3.5 days. node_modules can always be
# reinstalled; source trees are never touched, so no uncommitted work is lost.
# Runs as root from agent-swarm-disk-cleanup.timer.
set -euo pipefail

DATA=/var/lib/docker
VOLUMES=(agent-swarm_swarm_worker_coder agent-swarm_swarm_worker_reviewer agent-swarm_swarm_lead)
IDLE_MINUTES=2880
TIGHT_IDLE_MINUTES=360
TIGHT_PERCENT=80

# Pulumi resizes the EBS volume in place; XFS sits on the whole device, so
# growing the filesystem is all that is left. A no-op at full size.
xfs_growfs "$DATA" >/dev/null

# up.sh holds this for the length of a deploy. While it does, this reports and
# nothing else: walking the whole volume and pruning images both compete with
# the container swap and with the migrations the new api applies before it
# serves, and a prune can drop an image the deploy pulled but has no container
# for yet. The metrics below are still published, so the alarms keep seeing
# data through a deploy.
exec 9>>/opt/agent-swarm/.deploy.lock
deploy_in_progress=1
if flock -n 9; then
  deploy_in_progress=0
else
  echo "disk-cleanup: deploy in progress, skipping the sweep and the image prune"
fi

used_percent() { df --output=pcent "$DATA" | tail -1 | tr -dc 0-9; }
inodes_percent() { df --output=ipcent "$DATA" | tail -1 | tr -dc 0-9; }

# A checkout counts as idle when nothing outside node_modules and .git has
# changed in it for the given minutes. Nested worktrees are inside their
# parent's tree, so a busy worktree keeps its parent's node_modules too.
clean() {
  local idle="$1" root git tree freed=0
  for v in "${VOLUMES[@]}"; do
    root="$DATA/volumes/$v/_data"
    [[ -d "$root" ]] || continue
    while IFS= read -r -d '' git; do
      tree="$(dirname "$git")"
      if [[ -n "$(find "$tree" -xdev \( -name node_modules -o -name .git \) -prune \
        -o -mmin "-$idle" -print -quit 2>/dev/null)" ]]; then
        continue
      fi
      while IFS= read -r -d '' nm; do
        rm -rf "$nm"
        freed=$((freed + 1))
      done < <(find "$tree" -xdev -type d -name node_modules -prune -print0 2>/dev/null)
    done < <(find "$root" -xdev -name node_modules -prune -o -name .git -print0 2>/dev/null)
  done
  echo "disk-cleanup: removed $freed node_modules idle ${idle}m"
}

if ((deploy_in_progress == 0)); then
  clean "$IDLE_MINUTES"
  if (($(used_percent) >= TIGHT_PERCENT || $(inodes_percent) >= TIGHT_PERCENT)); then
    clean "$TIGHT_IDLE_MINUTES"
  fi

  # Containers keep their own image, so this only drops superseded versions.
  docker image prune -af >/dev/null
  docker builder prune -af >/dev/null
fi

used="$(used_percent)"
inodes="$(inodes_percent)"
echo "disk-cleanup: data volume ${used}% space, ${inodes}% inodes"
aws cloudwatch put-metric-data --region us-west-2 --namespace DelegateSwarm \
  --metric-data \
  "MetricName=DataVolumeUsedPercent,Value=$used,Unit=Percent" \
  "MetricName=DataVolumeInodesUsedPercent,Value=$inodes,Unit=Percent"
