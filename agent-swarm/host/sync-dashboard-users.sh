#!/usr/bin/env bash
# Gives every address in allowed-emails.txt an agent-swarm user with its own
# dashboard token, and revokes the dashboard token of anyone no longer listed.
# Caddy maps the signed-in address to that token (Caddyfile, sso snippet), so
# the swarm attributes each person's dashboard actions to them.
# The tokens live only in dashboard-tokens.caddy: owner-only, not in git, not
# in the config bucket. Run by up.sh with Google login on; safe to run again.
set -euo pipefail
cd /opt/agent-swarm
umask 077

API=http://127.0.0.1:3013
LABEL=dashboard-sso
OUT=dashboard-tokens.caddy

# Bearers go to curl through files, not argv, so ps never shows them.
AUTH="$(mktemp)"
TRY="$(mktemp)"
NEW="$(mktemp)"
trap 'rm -f "$AUTH" "$TRY" "$NEW"' EXIT
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^API_KEY=//p' .env)" >"$AUTH"

api() {
  local method=$1 path=$2
  shift 2
  curl -sS --fail-with-body -X "$method" -H @"$AUTH" -H 'Content-Type: application/json' \
    "$API$path" "$@"
}

for _ in $(seq 60); do
  if curl -fsS "$API/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

touch "$OUT"
users="$(api GET '/api/users?recentEvents=0')"
kept=()

while IFS= read -r email; do
  match="$(jq -r --arg e "$email" '
    [.users[] | select(. != null)] as $u
    | ([$u[] | select((.email // "" | ascii_downcase) == $e)]
       + [$u[] | select(any(.emailAliases[]?; ascii_downcase == $e))])[0]
    | if . == null then "" else "\(.id) \(.status)" end' <<<"$users")"
  if [[ -z "$match" ]]; then
    id="$(jq -n --arg e "$email" '{name: ($e | split("@")[0]), email: $e}' \
      | api POST /api/users -d @- | jq -r '.user.id')"
    status=active
    echo "dashboard users: $email created as $id"
  else
    read -r id status <<<"$match"
  fi
  # A suspended user keeps no dashboard token; the API would refuse it anyway.
  if [[ "$status" != active ]]; then
    echo "dashboard users: $email is $status, no dashboard access"
    continue
  fi

  read -r token tokenid < <(awk -v e="$email" '$1 == e { print $2, $4 }' "$OUT") || true
  current=""
  if [[ -n "${token:-}" ]]; then
    printf 'Authorization: Bearer %s\n' "$token" >"$TRY"
    if [[ "$(curl -sS -H @"$TRY" "$API/api/whoami" | jq -r '.user.id // ""')" == "$id" ]]; then
      current="$tokenid"
    fi
  fi
  if [[ -z "$current" ]]; then
    minted="$(jq -n --arg l "$LABEL" '{label: $l}' | api POST "/api/users/$id/mcp-tokens" -d @-)"
    token="$(jq -r '.plaintext' <<<"$minted")"
    current="$(jq -r '.token.id' <<<"$minted")"
    echo "dashboard users: $email minted a dashboard token"
  else
    echo "dashboard users: $email kept its dashboard token"
  fi
  printf '\t%s %s # %s\n' "$email" "$token" "$current" >>"$NEW"
  kept+=("$current")
  token=""
  tokenid=""
done < <(sed -e 's/#.*//' -e 's/[[:space:]]//g' allowed-emails.txt | tr '[:upper:]' '[:lower:]' | grep . | sort -u)

# Rewritten in place: it is a single-file bind mount into caddy, so a new
# inode would stay invisible to the container.
chmod 600 "$OUT"
cat "$NEW" >"$OUT"
echo "dashboard users: $(grep -c . "$OUT" || true) with dashboard access"

# Every other dashboard token goes: those of anyone removed from
# allowed-emails.txt, and any replaced one (its plaintext is gone).
while IFS=' ' read -r id tokenid email; do
  if [[ " ${kept[*]} " == *" $tokenid "* ]]; then
    continue
  fi
  api DELETE "/api/users/$id/mcp-tokens/$tokenid" >/dev/null
  echo "dashboard users: ${email:-$id} revoked a dashboard token no longer in use"
done < <(api GET '/api/users?recentEvents=0' | jq -r --arg l "$LABEL" '
  .users[] | select(. != null) | . as $u
  | .tokens[] | select(.label == $l and .revokedAt == null)
  | "\($u.id) \(.id) \($u.email // "")"')
