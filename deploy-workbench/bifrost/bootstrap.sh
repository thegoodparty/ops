#!/bin/sh
# Claims a fresh Bifrost deployment by creating the first admin account, from
# inside the task's own network namespace. Phase 2 item 11 of
# docs/bifrost-gateway.md.
#
# Upstream's bootstrap at the pinned tag (maximhq/bifrost:v2.3.0) is a single
# management call: a `PUT /api/config` whose payload carries `auth_config`
# with `is_enabled`, `admin_username`, `admin_password` and either
# `auth_config.setup_token` in the body or this token in the
# `X-Bifrost-Setup-Token` header (`handlers/config.go`, `updateConfig`). With
# no admin account in the store, that call is the only way one gets created,
# and `CheckBootstrapToken` fails closed without the token. There is no other
# endpoint, and no separate setup step.
#
# It runs as a non-essential one-shot container ordered after the gateway is
# HEALTHY, so it has no public path and never meets oauth2-proxy. It runs on
# every task start, and is convergent rather than one-shot: if dashboard auth
# is already active it exits 0 without writing anything, so a redeploy is a
# no-op and a restore into an empty config store heals itself.
#
# It never prints BIFROST_ADMIN_PASSWORD or BIFROST_SETUP_TOKEN. Only statuses
# and the server's own error text are logged.
set -eu

API="${BIFROST_API_BASE_URL:-http://127.0.0.1:8080}"
SETUP_TOKEN_HEADER="X-Bifrost-Setup-Token"

log() { printf 'bifrost-bootstrap: %s\n' "$*"; }
fail() { printf 'bifrost-bootstrap: error: %s\n' "$*" >&2; exit 1; }

# The three keys come from bifrost/gateway through the task definition's
# `secrets`; ECS would not have started the container if a key were absent, so
# an empty value means the key is present with nothing in it.
for name in BIFROST_SETUP_TOKEN BIFROST_ADMIN_USERNAME BIFROST_ADMIN_PASSWORD; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "$name is empty; fill bifrost/gateway with deploy-workbench/bifrost/fill-secrets.sh"
done

# Whitelisted, so it answers without a credential while the setup lock is on.
state="$(curl -fsS "$API/api/session/is-auth-enabled")" \
  || fail "GET /api/session/is-auth-enabled failed; the gateway is not answering"

if [ "$(printf '%s' "$state" | jq -r '.setup_required')" != "true" ]; then
  log "dashboard auth is already active; nothing to claim"
  exit 0
fi
if [ "$(printf '%s' "$state" | jq -r '.setup_token_configured')" != "true" ]; then
  fail "the API is locked but no setup token is configured; BIFROST_SETUP_TOKEN did not reach the gateway"
fi

# PUT /api/config takes the client and framework config as values, so a payload
# built from config.json would replace whatever the store holds with whatever
# the file says. Take the server's own view and add one field to it instead.
# Providers are not part of this payload at the pinned tag; only client and
# framework config round-trip, and they go back exactly as they arrived.
config="$(curl -fsS -H "$SETUP_TOKEN_HEADER: $BIFROST_SETUP_TOKEN" "$API/api/config")" \
  || fail "GET /api/config was refused; the setup token the process loaded is not the one in the secret"

# An admin account with dashboard auth switched off lands here. Re-enabling it
# is a deliberate act that needs proof of control, so leave it to a human
# rather than silently turning auth back on.
if [ "$(printf '%s' "$config" | jq 'has("auth_config")')" = "true" ]; then
  log "an admin account exists with dashboard auth disabled; leaving it alone"
  exit 0
fi

body="$(printf '%s' "$config" | jq -c \
  --arg u "$BIFROST_ADMIN_USERNAME" --arg p "$BIFROST_ADMIN_PASSWORD" \
  '. + {auth_config: {admin_username: $u, admin_password: $p, is_enabled: true}}')" \
  || fail "could not add auth_config to the config payload"

# The body is written to a file so the password never appears in argv. The
# response is discarded for the same reason: it is the updated config.
umask 077
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
printf '%s' "$body" > "$body_file"

status="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
  -H "$SETUP_TOKEN_HEADER: $BIFROST_SETUP_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$body_file" "$API/api/config")" \
  || fail "PUT /api/config did not complete"
case "$status" in
  2??) ;;
  400) fail "PUT /api/config was rejected (400). If the gateway logged a password policy failure, regenerate BIFROST_ADMIN_PASSWORD with fill-secrets.sh --force" ;;
  *) fail "PUT /api/config returned $status" ;;
esac

# Bifrost clears the bootstrap token once the first admin account exists, so a
# 2xx only means the request was accepted. Read the state back so a claim that
# did not take is a failure rather than a log line nobody reads.
state="$(curl -fsS "$API/api/session/is-auth-enabled")" \
  || fail "GET /api/session/is-auth-enabled failed after the claim"
if [ "$(printf '%s' "$state" | jq -r '.is_auth_enabled')" != "true" ] \
  || [ "$(printf '%s' "$state" | jq -r '.setup_required')" != "false" ]; then
  fail "the admin account was written but dashboard auth is not active"
fi
log "first admin account created; dashboard auth is active"
