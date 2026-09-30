#!/bin/bash
set -euo pipefail

# Patches the three Slack values into the AGENT_SWARM secret.
#
# It prompts silently rather than taking arguments on purpose: a token passed as
# an argument lands in your shell history and in the process list, and these are
# the credentials a compromised agent would most like to find. Nothing is echoed,
# and only lengths are printed afterwards.
#
# bootstrap.sh re-renders .env from this secret on every deploy, so this is the
# only place a Slack credential is set. Rotating one is this script plus a deploy.

SECRET_NAME="${SECRET_NAME:-AGENT_SWARM}"
REGION="${AWS_REGION:-us-west-2}"
export AWS_PAGER=""

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "aws CLI not found"
command -v python3 >/dev/null || die "python3 not found"

printf 'Slack bot token (xoxb-...), input hidden: '
read -rs SLACK_BOT_TOKEN
printf '\nSlack app-level token (xapp-...), input hidden: '
read -rs SLACK_APP_TOKEN
printf '\nIncident channel id (C..., right-click the channel then Copy link), input hidden: '
read -rs SWARM_INCIDENT_CHANNEL
printf '\n'

case "$SLACK_BOT_TOKEN" in xoxb-*) : ;; *) die "the bot token should start with xoxb-, got '${SLACK_BOT_TOKEN:0:5}...'" ;; esac
case "$SLACK_APP_TOKEN" in xapp-*) : ;; *) die "the app-level token should start with xapp-, got '${SLACK_APP_TOKEN:0:5}...'" ;; esac
case "$SWARM_INCIDENT_CHANNEL" in C*) : ;; *) die "the channel id should start with C, got '${SWARM_INCIDENT_CHANNEL:0:5}...'" ;; esac

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

if ! aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" \
  --query SecretString --output text > "$TMP/secret.json" 2>"$TMP/err"; then
  cat "$TMP/err" >&2
  die "could not read $SECRET_NAME in $REGION"
fi
chmod 600 "$TMP/secret.json"

SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" \
SLACK_APP_TOKEN="$SLACK_APP_TOKEN" \
SWARM_INCIDENT_CHANNEL="$SWARM_INCIDENT_CHANNEL" \
python3 - "$TMP/secret.json" <<'PY'
import json, os, sys

path = sys.argv[1]
with open(path) as f:
    d = json.load(f)
if not isinstance(d, dict):
    sys.exit("ERROR: AGENT_SWARM is not a JSON object")

for key in ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SWARM_INCIDENT_CHANNEL"):
    d[key] = os.environ[key]

with open(path, "w") as f:
    json.dump(d, f)
PY

aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --region "$REGION" \
  --secret-string "file://$TMP/secret.json" >/dev/null

printf '\nUpdated %s in %s:\n' "$SECRET_NAME" "$REGION"
printf '  SLACK_BOT_TOKEN        %s chars, %s...\n' "${#SLACK_BOT_TOKEN}" "${SLACK_BOT_TOKEN:0:5}"
printf '  SLACK_APP_TOKEN        %s chars, %s...\n' "${#SLACK_APP_TOKEN}" "${SLACK_APP_TOKEN:0:5}"
printf '  SWARM_INCIDENT_CHANNEL %s chars, %s...\n' "${#SWARM_INCIDENT_CHANNEL}" "${SWARM_INCIDENT_CHANNEL:0:5}"
printf '\nNext: run deploy.sh, or re-deploy if the stack is already up.\n'
