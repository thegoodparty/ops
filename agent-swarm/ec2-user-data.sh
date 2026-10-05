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
  fi
}

step "dnf install docker git jq" dnf install -y docker git jq

step "docker daemon.json" bash -c 'mkdir -p /etc/docker && cat >/etc/docker/daemon.json <<EOF
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
EOF'

step "enable+start docker" systemctl enable --now docker
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

step "mkdir /opt/agent-swarm" mkdir -p /opt/agent-swarm
step "chown /opt/agent-swarm" chown ec2-user:ec2-user /opt/agent-swarm

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
