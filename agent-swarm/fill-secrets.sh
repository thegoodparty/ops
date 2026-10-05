#!/usr/bin/env bash
set -euo pipefail

SECRET_ID=AGENT_SWARM
REGION=us-west-2
MANIFEST=/Users/swain/.claude/jobs/6b936fd3/tmp/swarm-slack-manifest.json

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ask() {
  local var=$1 prefix=$2 value
  while true; do
    printf '%s (paste, Enter to keep current): ' "$var"
    IFS= read -rs value
    echo
    if [[ -z "$value" ]]; then echo "  keeping current value"; return; fi
    if [[ -n "$prefix" && "$value" != $prefix* ]]; then
      echo "  that doesn't start with '$prefix', try again"; continue
    fi
    export "$var=$value"; echo "  ok (${#value} chars)"; return
  done
}

aws sts get-caller-identity --query Account --output text >/dev/null \
  || { echo "AWS SSO session expired. Run: aws sso login"; exit 1; }

bold "1/5  Slack app"
pbcopy < "$MANIFEST"
cat <<'EOF'
  The app manifest is on your clipboard.
  a. Open https://api.slack.com/apps  ->  Create New App  ->  From an app manifest
  b. Pick the GoodParty workspace, switch the editor to JSON, paste, Next, Create.
  c. Left nav: Basic Information -> scroll to App-Level Tokens -> Generate Token and Scopes
     name it "socket", add scope connections:write, Generate. Copy the xapp- token.
  d. Left nav: Install App -> Install to Workspace -> Allow. Copy the xoxb- Bot User OAuth Token.
EOF
ask SLACK_APP_TOKEN xapp-
ask SLACK_BOT_TOKEN xoxb-

bold "2/5  Anthropic key"
cat <<'EOF'
  https://console.anthropic.com  ->  Settings -> Workspaces -> Create workspace "agent-swarm"
  (set a monthly spend limit, $500 to start)  ->  in that workspace, API Keys -> Create Key.
EOF
ask ANTHROPIC_API_KEY sk-ant-

bold "3/5  GitHub fine-grained PAT"
cat <<'EOF'
  https://github.com/settings/personal-access-tokens/new
  Resource owner: thegoodparty.  Only select repositories: omni, serve-ops.  Expiration: 90 days.
  Repository permissions: Contents RW, Pull requests RW, Issues RW, Actions R, Metadata R.
EOF
ask GITHUB_TOKEN github_pat_

bold "4/5  Grafana read-only service account"
cat <<'EOF'
  https://goodparty.grafana.net/org/serviceaccounts  ->  Add service account
  Display name "agent-swarm", role Viewer, Create.  Then Add service account token,
  name "agent-swarm-host", no expiry, Generate. Copy the glsa_ token.
EOF
ask GRAFANA_SERVICE_ACCOUNT_TOKEN glsa_

bold "5/5  Writing to Secrets Manager ($SECRET_ID)"
TMP=$(mktemp); chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text \
| jq '
  def put(k): if (env[k] // "") != "" then .[k] = env[k] else . end;
  put("SLACK_APP_TOKEN") | put("SLACK_BOT_TOKEN") | put("ANTHROPIC_API_KEY")
  | put("GITHUB_TOKEN") | put("GRAFANA_SERVICE_ACCOUNT_TOKEN")' > "$TMP"
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --secret-string "file://$TMP" --query VersionId --output text >/dev/null

echo
echo "Secret now holds (key: length):"
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text \
| jq -r 'to_entries[] | "  \(.key): \(.value | length)\(if .value == "TODO" then "  <- still TODO" else "" end)"'
echo
echo "Done. Tell Claude the secrets are in."
