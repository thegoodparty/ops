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
