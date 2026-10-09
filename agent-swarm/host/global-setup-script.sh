# shellcheck shell=bash
# Global SETUP_SCRIPT (swarm config, scope=global). Runs as root at every
# worker container start, before the privilege drop. Installs AWS CLI v2 once
# onto the persistent shared volume and relinks it into /usr/local/bin (which
# is on the worker PATH) on every boot since the container rootfs is ephemeral.
AWS_DIR=/workspace/shared/aws-cli
if [ ! -x "$AWS_DIR/v2/current/bin/aws" ]; then
  (
    flock -w 300 9 || exit 1
    if [ ! -x "$AWS_DIR/v2/current/bin/aws" ]; then
      TMP=$(mktemp -d)
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$TMP/awscliv2.zip"
      unzip -q "$TMP/awscliv2.zip" -d "$TMP"
      "$TMP/aws/install" --install-dir "$AWS_DIR" --bin-dir /usr/local/bin --update
      rm -rf "$TMP"
    fi
  ) 9>"$AWS_DIR.lock"
fi
ln -sf "$AWS_DIR/v2/current/bin/aws" /usr/local/bin/aws
ln -sf "$AWS_DIR/v2/current/bin/aws_completer" /usr/local/bin/aws_completer

# Git over SSH as delegate-gp-bot: the same ed25519 key pushes and signs commits.
# gh keeps using GITHUB_TOKEN for API calls. The key arrives base64-encoded in
# GIT_SSH_PRIVATE_KEY_B64 (see fill-secrets.sh).
if [ -n "${GIT_SSH_PRIVATE_KEY_B64:-}" ]; then
  WORKER_HOME=$(getent passwd worker | cut -d: -f6)
  WORKER_HOME=${WORKER_HOME:-/home/worker}
  SSH_DIR="$WORKER_HOME/.ssh"
  mkdir -p "$SSH_DIR"
  umask 077
  printf '%s' "$GIT_SSH_PRIVATE_KEY_B64" | base64 -d >"$SSH_DIR/id_ed25519"
  chmod 600 "$SSH_DIR/id_ed25519"
  ssh-keygen -y -f "$SSH_DIR/id_ed25519" >"$SSH_DIR/id_ed25519.pub"
  # GitHub's published ed25519 host key (docs.github.com, "GitHub's SSH key fingerprints").
  echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' >"$SSH_DIR/known_hosts"
  printf 'Host github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n' "$SSH_DIR/id_ed25519" >"$SSH_DIR/config"
  chown -R worker:worker "$SSH_DIR" 2>/dev/null || chown -R "$(stat -c %u:%g "$WORKER_HOME")" "$SSH_DIR"
  # System scope so it survives whatever the entrypoint writes to the user's
  # gitconfig. Rewriting https to ssh means the gh credential helper is never
  # asked for a push.
  git config --system url."git@github.com:".insteadOf https://github.com/
  git config --system gpg.format ssh
  git config --system user.signingkey "$SSH_DIR/id_ed25519.pub"
  git config --system commit.gpgsign true
  git config --system tag.gpgsign true
fi
