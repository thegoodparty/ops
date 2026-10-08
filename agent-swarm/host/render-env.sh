#!/usr/bin/env bash
set -euo pipefail
umask 077

SECRET_ID="${DELEGATE_SWARM_SECRET_ID:-DELEGATE_SWARM}"
REGION="${AWS_REGION:-us-west-2}"
OUT="/opt/agent-swarm/.env"
TMP="$(mktemp /opt/agent-swarm/.env.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

SECRET_JSON="$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text)"

REQUIRED_KEYS=(
  ANTHROPIC_API_KEY
  API_KEY
  CLICKUP_API_TOKEN
  GITHUB_TOKEN
  GRAFANA_SERVICE_ACCOUNT_TOKEN
  SECRETS_ENCRYPTION_KEY
  SLACK_APP_TOKEN
  SLACK_BOT_TOKEN
)

missing=()
for k in "${REQUIRED_KEYS[@]}"; do
  if ! jq -e --arg k "$k" 'has($k)' <<<"$SECRET_JSON" >/dev/null; then
    missing+=("$k")
  fi
done
if ((${#missing[@]})); then
  echo "render-env: secret $SECRET_ID is missing keys: ${missing[*]}" >&2
  exit 1
fi

SSO_KEYS=(
  OAUTH2_PROXY_CLIENT_ID
  OAUTH2_PROXY_CLIENT_SECRET
  OAUTH2_PROXY_COOKIE_SECRET
)

sso_present=0
for k in "${SSO_KEYS[@]}"; do
  if jq -e --arg k "$k" 'has($k)' <<<"$SECRET_JSON" >/dev/null; then
    sso_present=$((sso_present + 1))
  fi
done
if ((sso_present == ${#SSO_KEYS[@]})); then
  SWARM_AUTH=sso
elif ((sso_present == 0)); then
  SWARM_AUTH=open
else
  echo "render-env: secret $SECRET_ID has some but not all of: ${SSO_KEYS[*]}" >&2
  exit 1
fi

todo="$(jq -r 'to_entries[] | select((.value|tostring) == "TODO" or (.value|tostring) == "") | .key' <<<"$SECRET_JSON")"
if [[ -n "$todo" ]]; then
  echo "render-env: secret $SECRET_ID still has TODO/empty values for:" >&2
  printf '  %s\n' $todo >&2
  exit 1
fi

{
  echo "# Rendered by render-env.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ) from Secrets Manager:$SECRET_ID. Do not edit."
  echo
  echo "# --- secrets ---"
  jq -r 'to_entries[]|"\(.key)=\(.value)"' <<<"$SECRET_JSON"
  echo
  echo "# --- static ---"
  cat <<'EOF'
AGENT_SWARM_VERSION=1.163.0
NODE_ENV=production
HARNESS_PROVIDER=pi
LEAD_MODEL_OVERRIDE=anthropic/claude-opus-5-5
WORKER_MODEL_OVERRIDE=anthropic/claude-sonnet-5-5

LEAD_AGENT_ID=9f8efd62-469d-4067-9dca-24d72b13864b
CODER_AGENT_ID=458bcd6d-4384-4366-83fa-63072ef55eab
REVIEWER_AGENT_ID=a0799d09-6816-445a-957d-1339b672d38b

SWARM_API_DOMAIN=delegate-swarm.infra.goodparty.org
MCP_BASE_URL=https://delegate-swarm.infra.goodparty.org
PUBLIC_MCP_BASE_URL=https://delegate-swarm.infra.goodparty.org
APP_URL=https://delegate-swarm.infra.goodparty.org
API_DRAIN_MAX_MS=30000

EMBEDDING_API_BASE_URL=http://tei:80/v1
EMBEDDING_API_KEY=local
EMBEDDING_MODEL=nomic-embed-text-v1.5

SLACK_ALLOWED_EMAIL_DOMAINS=goodparty.org
SLACK_ALERTS_CHANNEL=C0C6RUJ9VMK

GITHUB_DISABLE=true
GITHUB_NAME=delegate
GITHUB_EMAIL=delegate@goodparty.org

GRAFANA_URL=https://goodparty.grafana.net
EOF
  echo
  echo "SWARM_AUTH=$SWARM_AUTH"
} >"$TMP"

chmod 600 "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT
echo "render-env: wrote $OUT ($(grep -c '=' "$OUT") keys, SWARM_AUTH=$SWARM_AUTH)"
