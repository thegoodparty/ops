#!/usr/bin/env bash
# Fills the DELEGATE_SWARM secret in the infrastructure account from your
# laptop. Values are read without echo and never printed.
#
#   AWS_PROFILE=gp-infrastructure ./fill-secrets.sh                  the five services
#   AWS_PROFILE=gp-infrastructure ./fill-secrets.sh --copy-from-old  API_KEY and SECRETS_ENCRYPTION_KEY
#   AWS_PROFILE=gp-infrastructure ./fill-secrets.sh --sso            Google login (optional)
#
# Until there is an SSO profile for the infrastructure account, assume
# OrganizationAccountAccessRole from a management admin session. Add this to
# ~/.aws/config, then `aws sso login --profile gp-admin`:
#
#   [profile gp-infrastructure]
#   source_profile = gp-admin
#   role_arn = arn:aws:iam::394495727159:role/OrganizationAccountAccessRole
#   region = us-west-2
#
# --copy-from-old reads the old secret with OLD_AWS_PROFILE (default gp-admin).
set -euo pipefail

SECRET_ID=DELEGATE_SWARM
ACCOUNT_ID=394495727159
REGION=us-west-2
OLD_SECRET_ID=AGENT_SWARM
OLD_ACCOUNT_ID=333022194791
OLD_AWS_PROFILE="${OLD_AWS_PROFILE:-gp-admin}"
MANIFEST="$(dirname "$0")/slack-manifest.json"

# Only keys set in this run are written, never ones that happen to be in
# your shell's environment.
WRITE_KEYS=()
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
    export "$var=$value"; WRITE_KEYS+=("$var"); echo "  ok (${#value} chars)"; return
  done
}

MODE=services
case "${1:-}" in
  "") ;;
  --sso) MODE=sso ;;
  --copy-from-old) MODE=copy ;;
  *) echo "usage: $0 [--sso | --copy-from-old]"; exit 1 ;;
esac

account="$(aws sts get-caller-identity --query Account --output text)" \
  || { echo "No AWS session. Run: aws sso login --profile gp-admin"; exit 1; }
if [[ "$account" != "$ACCOUNT_ID" ]]; then
  echo "This session is in account $account, not the infrastructure account $ACCOUNT_ID."
  echo "Set AWS_PROFILE to a profile for $ACCOUNT_ID (see the top of this script)."
  exit 1
fi

if [[ $MODE == copy ]]; then

bold "Copy API_KEY and SECRETS_ENCRYPTION_KEY from $OLD_SECRET_ID ($OLD_ACCOUNT_ID, profile $OLD_AWS_PROFILE)"
cat <<'EOF'
  The swarm's SQLite encrypts the secrets it stores with SECRETS_ENCRYPTION_KEY.
  The migrated database is only readable with the same key, and API_KEY keeps
  every existing dashboard login and MCP client working.
EOF
old_account="$(AWS_PROFILE="$OLD_AWS_PROFILE" aws sts get-caller-identity --query Account --output text)" \
  || { echo "No session for $OLD_AWS_PROFILE. Run: aws sso login --profile $OLD_AWS_PROFILE"; exit 1; }
if [[ "$old_account" != "$OLD_ACCOUNT_ID" ]]; then
  echo "Profile $OLD_AWS_PROFILE is in account $old_account, not $OLD_ACCOUNT_ID."
  exit 1
fi
OLD_JSON="$(AWS_PROFILE="$OLD_AWS_PROFILE" aws secretsmanager get-secret-value \
  --secret-id "$OLD_SECRET_ID" --region "$REGION" --query SecretString --output text)"
API_KEY="$(jq -r '.API_KEY // ""' <<<"$OLD_JSON")"
SECRETS_ENCRYPTION_KEY="$(jq -r '.SECRETS_ENCRYPTION_KEY // ""' <<<"$OLD_JSON")"
unset OLD_JSON
if [[ -z "$API_KEY" || -z "$SECRETS_ENCRYPTION_KEY" ]]; then
  echo "$OLD_SECRET_ID is missing API_KEY or SECRETS_ENCRYPTION_KEY; nothing written."
  exit 1
fi
export API_KEY SECRETS_ENCRYPTION_KEY
WRITE_KEYS+=(API_KEY SECRETS_ENCRYPTION_KEY)
echo "  read both (${#API_KEY} and ${#SECRETS_ENCRYPTION_KEY} chars)"

elif [[ $MODE == sso ]]; then

bold "Google SSO (oauth2-proxy)"
cat <<'EOF'
  https://console.cloud.google.com/apis/credentials  (a project in the goodparty.org org)
  a. OAuth consent screen: User type Internal, so only goodparty.org accounts can sign in.
  b. Create credentials -> OAuth client ID -> Web application, name "delegate-swarm".
     Authorized JavaScript origins: https://delegate-swarm.goodparty.org
     Authorized redirect URIs:      https://delegate-swarm.goodparty.org/oauth2/callback
  c. Copy the client ID and the client secret.
  A new cookie secret is generated for you (this signs everyone out once).
EOF
ask OAUTH2_PROXY_CLIENT_ID ""
ask OAUTH2_PROXY_CLIENT_SECRET ""
OAUTH2_PROXY_COOKIE_SECRET="$(openssl rand -base64 32 | tr -- '+/' '-_')"
export OAUTH2_PROXY_COOKIE_SECRET
WRITE_KEYS+=(OAUTH2_PROXY_COOKIE_SECRET)
echo "  cookie secret generated"

else

bold "1/5  Delegate Slack app"
pbcopy < "$MANIFEST"
cat <<'EOF'
  The app manifest is on your clipboard.
  Saving it moves the Delegate app to Socket Mode: from that moment the old
  delegate bot stops receiving Slack events and the swarm answers instead.
  Do it right before starting the stack (README, "Moving from the old host").
  Not ready yet: press Enter twice to skip, and run the script again later.
  a. https://api.slack.com/apps -> Delegate -> left nav Features -> App Manifest.
     Switch the editor to JSON, select all, paste, Save Changes. Accept the
     prompt about changed scopes.
  b. Left nav Settings -> Socket Mode. "Enable Socket Mode" must be on; turn it
     on if it is not.
  c. Left nav Settings -> Basic Information -> App-Level Tokens -> Generate Token
     and Scopes. Name "delegate-swarm", Add Scope connections:write, Generate.
     Copy the xapp- token.
  d. Left nav Settings -> Install App -> Reinstall to GoodParty -> Allow.
     Copy the Bot User OAuth Token (xoxb-).
EOF
ask SLACK_APP_TOKEN xapp-
ask SLACK_BOT_TOKEN xoxb-

bold "2/5  Anthropic key"
cat <<'EOF'
  https://console.anthropic.com -> Settings -> API keys. Pick the existing
  "agent-swarm" workspace (it carries the spend limit), Create Key, name
  "delegate-swarm", Add. Copy the sk-ant- key; it is shown once.
EOF
ask ANTHROPIC_API_KEY sk-ant-

bold "3/5  GitHub fine-grained PAT (service user)"
cat <<'EOF'
  Signed in to GitHub as the Delegate service user:
  https://github.com/settings/personal-access-tokens/new
  a. Token name "delegate-swarm". Resource owner: thegoodparty.
  b. Expiration: the longest the org allows (No expiration if offered, else Custom
     with the latest date).
  c. Repository access: Only select repositories -> omni, ops.
  d. Repository permissions: Contents Read and write, Pull requests Read and write,
     Issues Read and write, Actions Read-only. Metadata Read-only is added for you.
  e. Generate token, copy the github_pat_ token. If the org requires approval, an
     owner approves it in github.com/organizations/thegoodparty/settings ->
     Personal access tokens -> Pending requests.
  Commits use GITHUB_NAME and GITHUB_EMAIL from host/render-env.sh; set them to
  this user's login and email there (README, TODO under "Where it runs").
EOF
ask GITHUB_TOKEN github_pat_

bold "4/5  ClickUp personal API token (service seat)"
cat <<'EOF'
  Signed in to ClickUp as the Delegate service seat: avatar (top right) ->
  Settings -> Apps -> API Token -> Generate (or Regenerate). Copy the pk_ token.
EOF
ask CLICKUP_API_TOKEN pk_

bold "5/5  Grafana read-only service account"
cat <<'EOF'
  https://goodparty.grafana.net/org/serviceaccounts -> Add service account.
  Display name "delegate", role Viewer, Create. Then Add service account token,
  name "delegate-swarm", Expiration No expiration, Generate token. Copy the glsa_ token.
EOF
ask GRAFANA_SERVICE_ACCOUNT_TOKEN glsa_

fi

if ((${#WRITE_KEYS[@]} == 0)); then
  echo "Nothing to write."
  exit 0
fi

bold "Writing to Secrets Manager ($SECRET_ID in $ACCOUNT_ID)"
TMP=$(mktemp); chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
# Pulumi creates the secret with no value; the first write creates it.
if ! current="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text 2>"$TMP")"; then
  if grep -q ResourceNotFoundException "$TMP"; then
    current='{}'
  else
    cat "$TMP" >&2
    exit 1
  fi
fi
jq 'reduce $ARGS.positional[] as $k (.; .[$k] = env[$k])' --args "${WRITE_KEYS[@]}" \
  <<<"$current" > "$TMP"
unset current
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
missing=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text \
| jq -r '["ANTHROPIC_API_KEY","API_KEY","CLICKUP_API_TOKEN","GITHUB_TOKEN","GRAFANA_SERVICE_ACCOUNT_TOKEN","SECRETS_ENCRYPTION_KEY","SLACK_APP_TOKEN","SLACK_BOT_TOKEN"] - keys | join(" ")')
echo
if [[ -n "$missing" ]]; then
  echo "Still missing before the stack can start: $missing"
elif [[ $MODE == sso ]]; then
  echo "Done. SSO turns on the next time up.sh runs on the host (it re-renders .env):"
  echo "  sudo -u ec2-user AWS_REGION=us-west-2 /opt/agent-swarm/up.sh"
else
  echo "Done. Every required key is present. On the host, if the stack is not running yet:"
  echo "  sudo systemctl start agent-swarm"
  echo "If it is running, re-render .env and apply:"
  echo "  sudo -u ec2-user AWS_REGION=us-west-2 /opt/agent-swarm/up.sh"
fi
