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
