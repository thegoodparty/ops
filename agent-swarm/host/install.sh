#!/usr/bin/env bash
# Installs a staged copy of agent-swarm/host/ (aws s3 sync of the config
# bucket) onto this host and brings the stack up. Runs as root from the SSM
# association whenever a file changes; must be idempotent and fail loudly.
set -euo pipefail

STAGE="${1:?usage: install.sh <stage dir>}"
DEST=/opt/agent-swarm

# On a brand-new instance this can run before user-data has installed docker,
# compose and bun. Exit 2 means done with recoverable errors.
rc=0
cloud-init status --wait >/dev/null || rc=$?
if ((rc != 0 && rc != 2)); then
  echo "install: cloud-init status exited $rc" >&2
  exit 1
fi

install -d -o ec2-user -g ec2-user "$DEST"
cd "$STAGE"
while IFS= read -r -d '' f; do
  f="${f#./}"
  install -d -o ec2-user -g ec2-user "$DEST/$(dirname "$f")"
  # cp onto an existing file rewrites it in place. The Caddyfile is a
  # single-file bind mount, so a replaced inode would stay invisible to caddy.
  cp "$f" "$DEST/$f"
  chown ec2-user:ec2-user "$DEST/$f"
  if [[ "$f" == *.sh ]]; then chmod 755 "$DEST/$f"; else chmod 644 "$DEST/$f"; fi
done < <(find . -path ./systemd -prune -o -type f -print0)

install -m 644 "$STAGE"/systemd/*.service "$STAGE"/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable agent-swarm.service
systemctl enable --now agent-swarm-health.timer

# Leftovers from the hand-built host: the pre-dashboard Caddyfile, the unit
# file's old copy, and the clone build-ui.sh no longer uses.
rm -rf "$DEST"/Caddyfile.bak-* "$DEST/agent-swarm.service" "$DEST/src"

# Never restart the unit: that would stop the whole stack. If it is not active
# yet (new instance), start it so its ExecStop drains the stack on shutdown.
if systemctl is-active --quiet agent-swarm.service; then
  runuser -u ec2-user -- env AWS_REGION=us-west-2 HOME=/home/ec2-user "$DEST/up.sh"
elif ! systemctl start agent-swarm.service; then
  journalctl -u agent-swarm.service -n 100 --no-pager >&2
  exit 1
fi
echo "install: done"
