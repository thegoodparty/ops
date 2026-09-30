#!/bin/bash
set -euo pipefail

# EC2 cloud-init for the agent-swarm host. Runs once, as root, on first boot.
#
# It installs the container runtime and prepares the directories the stack
# expects. It deliberately carries no secrets and no stack: those arrive over
# SSM in bootstrap.sh, which is re-runnable, whereas user-data runs exactly once
# and is capped at 16 KiB.
#
# Everything here is safe to run twice, because a failure partway through
# leaves a host that never finished booting, and the fix for that is running it
# again by hand over SSM.

exec > >(tee -a /var/log/agent-swarm-user-data.log) 2>&1
printf '\n=== agent-swarm user-data %s ===\n' "$(date -Is)"

# ---------------------------------------------------------------------------
# Docker and the Compose plugin
# ---------------------------------------------------------------------------

# The AL2023 `docker` package does not ship the compose plugin, and the
# `docker compose` subcommand is what the stack is driven with. There is no
# distro package for it, and Docker's own repository is not usable here: the
# centos repo it publishes resolves `$releasever` to `2023` on AL2023, so the
# repo path 404s and `dnf` fails outright.
#
# So the plugin is installed as what it actually is, a single binary the docker
# CLI looks for in its plugin directory. Pin the version: an unpinned download
# in a boot script is a different Compose on every host that boots.
if ! command -v docker >/dev/null 2>&1; then
  dnf install -y docker
fi
if ! docker compose version >/dev/null 2>&1; then
  COMPOSE_VERSION="v5.5.1"
  install -d -m 0755 /usr/libexec/docker/cli-plugins
  curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \
    "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"
  chmod 0755 /usr/libexec/docker/cli-plugins/docker-compose
fi

# Fail here rather than three steps into bootstrap, where a missing plugin reads
# as a stack that will not start rather than a host that was built wrong. This
# script runs once, so a silent failure at this line is permanent until somebody
# notices.
command -v docker >/dev/null 2>&1 || { printf 'FATAL: docker is not installed\n' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { printf 'FATAL: the docker compose plugin is missing at /usr/libexec/docker/cli-plugins/docker-compose\n' >&2; exit 1; }

# Cap the json-file logs Docker keeps per container. The default is unbounded, and
# on a box that runs a chatty agent swarm for weeks that fills the root volume and
# takes the host down with it. Written via a temp file so a re-run that changes
# nothing does not bounce the daemon under running containers.
mkdir -p /etc/docker
cat > /tmp/agent-swarm-daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
JSON
if cmp -s /tmp/agent-swarm-daemon.json /etc/docker/daemon.json; then
  rm -f /tmp/agent-swarm-daemon.json
else
  mv /tmp/agent-swarm-daemon.json /etc/docker/daemon.json
  RESTART_DOCKER=true
fi

systemctl enable --now docker
if [ "${RESTART_DOCKER:-false}" = "true" ]; then
  systemctl restart docker
fi

# ---------------------------------------------------------------------------
# Directories
# ---------------------------------------------------------------------------

# /opt/agent-swarm holds the stack and is replaced wholesale on every deploy.
# /var/lib/agent-swarm holds everything that must survive one: the SQLite
# database Litestream ships to S3, the logs, and each agent's personal
# workspace.
mkdir -p /opt/agent-swarm
mkdir -p /var/lib/agent-swarm/api-data
mkdir -p /var/lib/agent-swarm/logs
mkdir -p /var/lib/agent-swarm/shared
mkdir -p /var/lib/agent-swarm/personal

# ---------------------------------------------------------------------------
# Log rotation for the bind-mounted logs
# ---------------------------------------------------------------------------

# copytruncate because the writers are containers holding an open descriptor on
# a bind mount: they do not reopen on SIGUSR1, so a rename-based rotation would
# keep writing to the renamed file forever.
cat > /etc/logrotate.d/agent-swarm <<'CONF'
/var/lib/agent-swarm/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
CONF

# ---------------------------------------------------------------------------
# Session Manager (the only way in: no key pair, no SSH)
# ---------------------------------------------------------------------------

# The agent ships with AL2023 and is normally already enabled; this is here so
# that "the instance never registered with SSM" has one less cause, given
# deploy.sh blocks on that registration.
if systemctl list-unit-files | grep -q '^amazon-ssm-agent'; then
  systemctl enable --now amazon-ssm-agent
fi

printf '=== agent-swarm user-data done %s ===\n' "$(date -Is)"
