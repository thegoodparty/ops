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

# GitHub App identity for git and gh. Workers mint a ~1h installation token
# for delegate-gp[bot] from GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY. There is no
# fallback, when minting fails the helper prints a note and no token. Skipped
# without the App keys.
if [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${GITHUB_APP_PRIVATE_KEY:-}" ]; then
  cat >/usr/local/bin/gh-app-token <<'HELPER'
#!/usr/bin/env bash
# gh-app-token [owner]           print an installation token for owner
# gh-app-token credential get    git credential helper protocol (github.com only)
# Needs openssl, curl, jq. On failure prints a stderr note and exits 1. Never prints secrets except the token on stdout.
set -u
umask 077
API=https://api.github.com
DEFAULT_OWNER="${GITHUB_APP_DEFAULT_OWNER:-thegoodparty}"

work=
note() { echo "gh-app-token: $*" >&2; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

fail() {
  note "$1"
  return 1
}

mint() {
  local owner=$1 key now jwt hdr pay sig code inst tok exp
  [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${GITHUB_APP_PRIVATE_KEY:-}" ] || { fail "GitHub App env not set"; return; }
  work=$(mktemp -d) || { fail "mktemp failed"; return; }
  trap 'rm -rf "$work"' EXIT
  key=$work/key.pem
  # Accepts raw PEM or base64 of the PEM.
  if printf '%s' "$GITHUB_APP_PRIVATE_KEY" | grep -q 'BEGIN'; then
    printf '%s\n' "$GITHUB_APP_PRIVATE_KEY" >"$key"
  else
    printf '%s' "$GITHUB_APP_PRIVATE_KEY" | base64 -d >"$key" 2>/dev/null
  fi
  now=$(date +%s)
  hdr=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  pay=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$GITHUB_APP_ID" | b64url)
  sig=$(printf '%s.%s' "$hdr" "$pay" | openssl dgst -sha256 -sign "$key" 2>/dev/null | b64url)
  [ -n "$sig" ] || { fail "could not sign App JWT (bad private key?)"; return; }
  jwt=$hdr.$pay.$sig

  gh_call() { # method url -> body in $work/out, prints http code
    curl -sS -o "$work/out" -w '%{http_code}' --max-time 20 -X "$1" \
      -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' "$2" 2>/dev/null
  }
  code=$(gh_call GET "$API/orgs/$owner/installation")
  [ "$code" = 200 ] || code=$(gh_call GET "$API/users/$owner/installation")
  [ "$code" = 200 ] || { fail "no App installation for '$owner' (HTTP $code)"; return; }
  inst=$(jq -r .id "$work/out")
  code=$(gh_call POST "$API/app/installations/$inst/access_tokens")
  [ "$code" = 201 ] || { fail "token mint failed (HTTP $code)"; return; }
  tok=$(jq -r .token "$work/out")
  exp=$(date -u -d "$(jq -r .expires_at "$work/out")" +%s 2>/dev/null || echo $((now + 3000)))
  [ -n "$tok" ] && [ "$tok" != null ] || { fail "token response had no token"; return; }
  printf '%s %s' "$exp" "$tok" >"$CACHE"
  printf '%s' "$tok"
}

token_for() {
  local owner=$1 dir exp tok
  dir="${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/gh-app-token"
  mkdir -p "$dir" 2>/dev/null && chmod 700 "$dir" 2>/dev/null || dir=$(mktemp -d)
  CACHE=$dir/$(printf '%s' "$owner" | tr -c 'A-Za-z0-9_.-' _)
  if [ -s "$CACHE" ]; then
    read -r exp tok <"$CACHE"
    if [ -n "${tok:-}" ] && [ "$exp" -gt $(($(date +%s) + 300)) ] 2>/dev/null; then
      printf '%s' "$tok"
      return 0
    fi
  fi
  mint "$owner"
}

if [ "${1:-}" = credential ]; then
  [ "${2:-}" = get ] || exit 0
  host= path=
  while IFS='=' read -r k v; do
    case $k in host) host=$v ;; path) path=$v ;; esac
  done
  [ "$host" = github.com ] || exit 0
  owner=${path%%/*}
  [ -n "$owner" ] || owner=$DEFAULT_OWNER
  tok=$(token_for "$owner") || exit 0
  printf 'username=x-access-token\npassword=%s\n' "$tok"
  exit 0
fi

token_for "${1:-$DEFAULT_OWNER}"
HELPER
  chmod 755 /usr/local/bin/gh-app-token

  # gh wrapper: sets GH_TOKEN from the App for the repo's owner, then runs the real gh.
  REAL_GH=$(PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx /usr/local/bin | paste -sd: -) command -v gh || true)
  if [ -n "$REAL_GH" ]; then
    cat >/usr/local/bin/gh <<WRAP
#!/usr/bin/env bash
REAL_GH=$REAL_GH
repo=\${GH_REPO:-}
prev=
for a in "\$@"; do
  case \$prev in -R|--repo) repo=\$a ;; esac
  case \$a in --repo=*) repo=\${a#--repo=} ;; esac
  prev=\$a
done
if [ -z "\$repo" ]; then
  repo=\$(git remote get-url origin 2>/dev/null | sed -E 's#^(https?://[^/]+/|git@[^:]+:|ssh://git@[^/]+/)##' || true)
fi
case \$repo in */*) owner=\${repo%%/*} ;; *) owner= ;; esac
if tok=\$(/usr/local/bin/gh-app-token "\${owner:-}") && [ -n "\$tok" ]; then
  export GH_TOKEN=\$tok
fi
exec "\$REAL_GH" "\$@"
WRAP
    chmod 755 /usr/local/bin/gh
  fi

  git config --system --replace-all 'credential.https://github.com.helper' '!/usr/local/bin/gh-app-token credential'
  git config --system credential.https://github.com.useHttpPath true
  git config --system user.name "${GITHUB_NAME:-delegate-gp[bot]}"
  git config --system user.email "${GITHUB_EMAIL:-268660869+delegate-gp[bot]@users.noreply.github.com}"
fi

# --- pi harness: Fireworks, US-only, exactly one model ----------------------
#
# This script runs as root before the privilege drop, so writing to /root/.pi
# would be invisible to the worker. The pi agent dir is therefore a single
# explicit path, owned by the worker, and PI_CODING_AGENT_DIR in
# docker-compose.yml names the same value (agent-swarm-fireworks-residency.test.ts fails if
# the two drift apart). /workspace/personal is the agent's own persistent
# volume and is already chowned to worker by the entrypoint before this hook
# runs.
PI_AGENT_DIR=/workspace/personal/.pi
# This runs as root, and /workspace/personal is the worker's own volume, which
# the worker is free to write to. `install -d` on an existing path applies the
# owner and mode to it, so a symlink planted at .pi could hand root-chowned
# access to another directory. Refuse anything at that path that is not a
# plain directory (or absent), before root touches it.
if [ -L "$PI_AGENT_DIR" ] || { [ -e "$PI_AGENT_DIR" ] && [ ! -d "$PI_AGENT_DIR" ]; }; then
  echo "setup: $PI_AGENT_DIR is not a plain directory; replacing it" >&2
  rm -rf "$PI_AGENT_DIR"
fi
install -d -o worker -g worker -m 755 "$PI_AGENT_DIR"

# Written every container start, into a temp file and renamed, so a rerun is
# idempotent and a half-written file is never read. Only models.json is
# touched: settings.json, sessions/ and the rest of the agent dir are left
# alone.
#
# US-only inference needs BOTH halves (docs/bifrost-gateway.md, "Inference
# residency"): the endpoint must be the US host, and the model id must be a
# US-only router. Either alone is wrong.
#
# Why a second provider id instead of listing one model under the built-in
# `fireworks` provider: in pi 1.5.0 a `models` entry on a built-in provider is
# ADDED to that provider's catalog, not substituted for it, so declaring only
# the US router under `fireworks` still leaves every global Fireworks model
# selectable. The containment below is what actually works: `fireworks-us`
# lists exactly one model, and the built-in `fireworks` provider is left with
# no usable credential (its apiKey is a variable nothing sets), so no
# global-id model can be resolved or run. Verified with `pi --list-models` and
# an explicit `--model` run, which fails with "No API key found for
# fireworks". That is also why the built-in block below pins the US base URL:
# if a future change ever does give it a key, it still cannot reach the
# global endpoint.
#
# Cost is the US price, not pi's built-in global price for the same model
# family: US-only Serverless is 1.5x, $0.45 in / $0.009 cached / $1.80 out per
# 1M tokens (docs/bifrost-gateway.md "The Fireworks premium"; the same numbers
# are in deploy-workbench/bifrost/config.json). pi's catalog carries
# .3/1.2 for the -1017 entries, which under-reports by a third.
#
# Deliberately plain JSON, not JSONC: agent-swarm reads this file with
# JSON.parse in writeSessionModelsJson, so a comment here would make it drop
# the provider blocks it composes. The rationale lives in this comment instead.
PI_MODELS_TMP=$(mktemp "$PI_AGENT_DIR/.models.json.XXXXXX")
cat >"$PI_MODELS_TMP" <<'PI_MODELS_JSON'
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "fireworks": {
      "baseUrl": "https://us.api.fireworks.ai/inference",
      "apiKey": "$FIREWORKS_WORKER_DISABLED_UNSET"
    },
    "fireworks-us": {
      "name": "Fireworks (US-only)",
      "baseUrl": "https://us.api.fireworks.ai/inference",
      "api": "anthropic-messages",
      "apiKey": "$FIREWORKS_API_KEY",
      "models": [
        {
          "id": "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
          "name": "DeepSeek V4.1 Flash 1017 US",
          "api": "anthropic-messages",
          "reasoning": true,
          "thinkingLevelMap": {
            "off": "none",
            "minimal": null,
            "low": "low",
            "medium": null,
            "high": "high",
            "xhigh": null,
            "max": "max"
          },
          "input": ["text", "image"],
          "inputLimits": {
            "images": {
              "resize": {
                "maxWidth": 2000,
                "maxHeight": 2000,
                "maxBytes": 4718592,
                "jpegQuality": 80
              }
            }
          },
          "cost": {
            "input": 0.45,
            "output": 1.8,
            "cacheRead": 0.009,
            "cacheWrite": 0
          },
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "compat": {
            "allowEmptySignature": true,
            "sendSessionAffinityHeaders": true,
            "supportsEagerToolInputStreaming": false,
            "supportsCacheControlOnTools": false,
            "supportsLongCacheRetention": false,
            "forceAdaptiveThinking": true
          }
        }
      ]
    }
  }
}
PI_MODELS_JSON
chown worker:worker "$PI_MODELS_TMP"
chmod 644 "$PI_MODELS_TMP"
mv -f "$PI_MODELS_TMP" "$PI_AGENT_DIR/models.json"

# A stale per-session catalog cache would keep the provider list from before
# this file existed. It is regenerated from pi.dev, so removing it is safe and
# only costs a refresh.
rm -f "$PI_AGENT_DIR/models-store.json"
