#!/bin/bash
set -euo pipefail

# Runs on the host, from /opt/agent-swarm, once deploy.sh has extracted the
# stack there. It turns the AGENT_SWARM secret into the .env the compose file
# reads, and starts the stack.
#
# Re-runnable: it regenerates .env from the secret every time, so rotating a
# credential is a secret update plus a deploy, not an edit on the box that
# drifts from the source of truth.

STACK_DIR="/opt/agent-swarm"
SECRET_NAME="AGENT_SWARM"
REGION="${AWS_DEFAULT_REGION:-us-west-2}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cd "$STACK_DIR" || die "no $STACK_DIR"

if [ ! -f .env.example ]; then
  die "$STACK_DIR/.env.example is missing -- the deploy tarball did not extract cleanly."
fi

TMP="$(mktemp -d)"
# The secret is written to a private temp file rather than passed as an
# argument, so it never appears in the process list, and it is removed on the
# way out however this exits.
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

log "Reading $SECRET_NAME"
if ! aws secretsmanager get-secret-value \
  --secret-id "$SECRET_NAME" \
  --region "$REGION" \
  --query SecretString \
  --output text > "$TMP/secret.json" 2>"$TMP/secret.err"; then
  cat "$TMP/secret.err" >&2
  die "could not read secret $SECRET_NAME in $REGION. The instance role grants GetSecretValue on that one secret only."
fi
chmod 600 "$TMP/secret.json"

cat > "$TMP/render.py" <<'PY'
"""Render .env from .env.example, substituting only the keys the secret holds.

Keys the secret does not carry keep the example's value, so optional settings
(GITHUB_EMAIL, agent-id overrides, version pins) stay editable in the example
without this script having an opinion about them.
"""
import json
import os
import sys

secret_path, example_path, env_path = sys.argv[1:4]

try:
    with open(secret_path) as f:
        secrets = json.load(f)
except ValueError as e:
    sys.exit("ERROR: AGENT_SWARM is not valid JSON: %s" % e)

if not isinstance(secrets, dict) or not secrets:
    sys.exit("ERROR: AGENT_SWARM must be a non-empty JSON object")

# Env key -> the secret key that fills it, for names that ever differ. Empty
# today: every secret key is spelled the same as the env var it fills, and that
# is the invariant worth keeping, because renaming one side and not the other
# yields an empty value and a stack that boots healthy while missing a credential.
ALIASES = {}


def resolve(env_key):
    """The secret value for an env key, or None if the secret has nothing."""
    if env_key in secrets:
        return secrets[env_key]
    source = ALIASES.get(env_key)
    if source is not None and source in secrets:
        return secrets[source]
    return None


def quote(value):
    """Double-quote a value the way dotenv reads it back.

    Values can contain '#' or spaces (a password, a token), which an unquoted
    dotenv value would truncate at the '#'. Only \\, " and $ are escaped,
    because those are the ones compose's double-quote unescaping recognises;
    escaping a backtick (a shell habit) would put a literal backslash in the
    value, which was verified against `docker compose config`.
    """
    text = str(value)
    for ch in ("\\", '"', "$"):
        text = text.replace(ch, "\\" + ch)
    return '"' + text + '"'


lines = []
consumed = set()
with open(example_path) as f:
    for raw in f:
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            lines.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        value = resolve(key)
        if value is None:
            lines.append(line)
            continue
        lines.append("%s=%s" % (key, quote(value)))
        consumed.add(ALIASES.get(key, key))

with open(env_path, "w") as f:
    f.write("\n".join(lines) + "\n")
os.chmod(env_path, 0o600)

unused = sorted(k for k in secrets if k not in consumed)
if unused:
    # Not fatal: a secret key can legitimately be consumed by something other
    # than the .env render, and a stale key is worth a note rather than a stop.
    print("    note: secret keys not referenced by .env.example: " + ", ".join(unused), file=sys.stderr)

if not secrets.get("SECRETS_ENCRYPTION_KEY"):
    sys.exit("ERROR: AGENT_SWARM has no SECRETS_ENCRYPTION_KEY; the API cannot decrypt its stored secrets without one.")
PY

log "Rendering $STACK_DIR/.env"
python3 "$TMP/render.py" "$TMP/secret.json" "$STACK_DIR/.env.example" "$STACK_DIR/.env"

# Belt and braces: the renderer chmods it too, and this makes the intent obvious
# to anyone reading the box, since .env holds every credential the stack has.
chmod 600 "$STACK_DIR/.env"

log "Pulling images"
# Checked before the pull rather than left to fail inside it: "compose is not a
# docker command" arrives as an opaque one-liner in the middle of a wall of
# image-pull output, and the cause is a host built without the plugin.
command -v docker >/dev/null 2>&1 || die "docker is not installed on this host"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing. user-data.sh installs it to /usr/libexec/docker/cli-plugins/docker-compose; run that script again on this host, then re-deploy."
docker buildx version >/dev/null 2>&1 || die "the docker buildx plugin is missing. user-data.sh installs it to /usr/libexec/docker/cli-plugins/docker-buildx; the bridge is built from source on this host, so compose cannot start without it."
docker compose pull

log "Starting the stack"
# --build, because the bridge is built from source that arrived in this tarball.
# Plain `up -d` reuses an image that already exists, so a change to the bridge
# would deploy, report success, and keep running the previous code.
docker compose up -d --build

log "Running services"
docker compose ps
