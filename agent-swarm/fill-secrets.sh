#!/usr/bin/env bash
set -euo pipefail

SECRET_ID=AGENT_SWARM
REGION=us-west-2
MANIFEST="$(dirname "$0")/slack-manifest.json"

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

SSO=false
case "${1:-}" in
  "") ;;
  --sso) SSO=true ;;
  *) echo "usage: $0 [--sso]"; exit 1 ;;
esac

aws sts get-caller-identity --query Account --output text >/dev/null \
  || { echo "AWS SSO session expired. Run: aws sso login"; exit 1; }

if $SSO; then

bold "Google SSO (oauth2-proxy)"
cat <<'EOF'
  https://console.cloud.google.com/apis/credentials  (a project in the goodparty.org org)
  a. OAuth consent screen: User type Internal, so only goodparty.org accounts can sign in.
  b. Create credentials -> OAuth client ID -> Web application, name "swarm".
     Authorized JavaScript origins: https://swarm.goodparty.org
     Authorized redirect URIs:      https://swarm.goodparty.org/oauth2/callback
  c. Copy the client ID and the client secret.
  A new cookie secret is generated for you (this signs everyone out once).
EOF
ask OAUTH2_PROXY_CLIENT_ID ""
ask OAUTH2_PROXY_CLIENT_SECRET ""
OAUTH2_PROXY_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"
export OAUTH2_PROXY_COOKIE_SECRET
echo "  cookie secret generated"

else

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

fi

bold "Writing to Secrets Manager ($SECRET_ID)"
TMP=$(mktemp); chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text \
| jq '
  def put(k): if (env[k] // "") != "" then .[k] = env[k] else . end;
  put("SLACK_APP_TOKEN") | put("SLACK_BOT_TOKEN") | put("ANTHROPIC_API_KEY")
  | put("GITHUB_TOKEN") | put("GRAFANA_SERVICE_ACCOUNT_TOKEN")
  | put("OAUTH2_PROXY_CLIENT_ID") | put("OAUTH2_PROXY_CLIENT_SECRET")
  | put("OAUTH2_PROXY_COOKIE_SECRET")' > "$TMP"
sso_count=$(jq '[has("OAUTH2_PROXY_CLIENT_ID", "OAUTH2_PROXY_CLIENT_SECRET", "OAUTH2_PROXY_COOKIE_SECRET") | select(.)] | length' "$TMP")
if [[ "$sso_count" != 0 && "$sso_count" != 3 ]]; then
  echo "Not writing: SSO needs all three of client id, client secret and cookie secret."
  exit 1
fi
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --secret-string "file://$TMP" --query VersionId --output text >/dev/null

echo
echo "Secret now holds (key: length):"
aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text \
| jq -r 'to_entries[] | "  \(.key): \(.value | length)\(if .value == "TODO" then "  <- still TODO" else "" end)"'
echo
if $SSO; then
  echo "Done. SSO turns on the next time up.sh runs on the host (it re-renders .env):"
  echo "  sudo -u ec2-user AWS_REGION=us-west-2 /opt/agent-swarm/up.sh"
else
  echo "Done. Tell Claude the secrets are in."
fi
