#!/bin/bash
LOG=/var/log/agent-swarm-userdata.log
exec >>"$LOG" 2>&1
echo "=== agent-swarm user-data start $(date -u +%FT%TZ) ==="

FAILED=0
step() {
  local name="$1"; shift
  echo "--- $name"
  if "$@"; then
    echo "OK: $name"
  else
    echo "FAIL: $name (exit $?)"
    FAILED=1
    return 1
  fi
}

# Docker's state (images, and the volumes that hold the swarm's SQLite and
# workspaces) lives on its own EBS volume, so a replacement instance keeps it.
# Pulumi attaches it after boot and substitutes its id below.
DATA_VOLUME_ID=__DATA_VOLUME_ID__
mount_data_volume() {
  if [[ "$DATA_VOLUME_ID" != vol-* ]]; then
    echo "DATA_VOLUME_ID is not a volume id: $DATA_VOLUME_ID"
    return 1
  fi
  # Nitro exposes EBS as NVMe with the volume id, minus its dash, as serial.
  local dev="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${DATA_VOLUME_ID/-/}"
  local i
  for ((i = 0; i < 120; i++)); do
    [[ -b "$dev" ]] && break
    sleep 5
    udevadm settle
  done
  if [[ ! -b "$dev" ]]; then
    echo "$DATA_VOLUME_ID did not appear at $dev within 10 minutes"
    return 1
  fi
  echo "found $DATA_VOLUME_ID at $dev -> $(readlink -f "$dev")"

  # blkid -p exits 2 only when the device carries no signature at all. Any
  # filesystem or partition table means existing data: never format it.
  local rc=0
  blkid -p "$dev" || rc=$?
  if ((rc == 2)); then
    echo "no filesystem on $dev, creating xfs"
    mkfs.xfs "$dev" || return 1
    udevadm settle
  elif ((rc != 0)); then
    echo "blkid -p $dev exited $rc"
    return 1
  fi

  local uuid
  uuid="$(blkid -p -s UUID -o value "$dev")"
  if [[ -z "$uuid" ]]; then
    echo "no filesystem UUID on $dev"
    return 1
  fi
  mkdir -p /var/lib/docker
  if ! grep -q "^UUID=$uuid " /etc/fstab; then
    echo "UUID=$uuid /var/lib/docker xfs defaults,nofail 0 2" >>/etc/fstab
  fi
  systemctl daemon-reload
  if ! mountpoint -q /var/lib/docker; then
    mount /var/lib/docker || return 1
  fi
  # Docker never starts on the root disk, where a later mount would hide it.
  mkdir -p /etc/systemd/system/docker.service.d
  printf '[Unit]\nRequiresMountsFor=/var/lib/docker\n' \
    >/etc/systemd/system/docker.service.d/data-volume.conf
  systemctl daemon-reload
  findmnt /var/lib/docker
}

step "dnf install docker git jq" dnf install -y docker git jq

step "docker daemon.json" bash -c 'mkdir -p /etc/docker && cat >/etc/docker/daemon.json <<EOF
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
EOF'

# On a replacement instance the data volume already holds the stack's
# containers, and docker restarts them on start. Their bind-mount sources must
# exist by then, or docker creates root-owned directories in their place.
step "mkdir /opt/agent-swarm" mkdir -p /opt/agent-swarm/ui-dist
step "placeholder bind-mount files" touch /opt/agent-swarm/Caddyfile /opt/agent-swarm/aws-config /opt/agent-swarm/allowed-emails.txt /opt/agent-swarm/dashboard-tokens.caddy
step "chown /opt/agent-swarm" chown -R ec2-user:ec2-user /opt/agent-swarm

if step "mount data volume at /var/lib/docker" mount_data_volume; then
  step "enable+start docker" systemctl enable --now docker
else
  echo "SKIP: enable+start docker, not without its data volume"
fi
step "ec2-user in docker group" usermod -aG docker ec2-user

COMPOSE_VERSION=v2.39.4
step "mkdir cli-plugins" mkdir -p /usr/libexec/docker/cli-plugins
step "download docker compose $COMPOSE_VERSION" curl -fsSL --retry 5 --retry-delay 3 \
  -o /usr/libexec/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"
step "chmod docker compose" chmod +x /usr/libexec/docker/cli-plugins/docker-compose

step "install bun" bash -c 'export HOME=/root BUN_INSTALL=/opt/bun; curl -fsSL --retry 5 --retry-delay 3 https://bun.sh/install | bash'
step "symlink bun" ln -sfn /opt/bun/bin/bun /usr/local/bin/bun
step "symlink bunx" ln -sfn /opt/bun/bin/bun /usr/local/bin/bunx
step "bun world-readable" chmod -R a+rX /opt/bun

echo "--- verify"
if docker compose version && /usr/local/bin/bun --version; then
  echo "OK: verify"
else
  echo "FAIL: verify"
  FAILED=1
fi

echo "=== agent-swarm user-data end $(date -u +%FT%TZ) failed=$FAILED ==="
if [ "$FAILED" -eq 0 ]; then
  echo READY
else
  echo NOT_READY
fi
