#!/usr/bin/env bash
# Builds the dashboard SPA (apps/ui) of agent-swarm at AGENT_SWARM_VERSION and
# syncs it into ui-dist. ui-dist is a directory bind mount into caddy, so it is
# updated in place rather than replaced, and only from a build that succeeded.
set -euo pipefail
cd /opt/agent-swarm

version="$(sed -n 's/^AGENT_SWARM_VERSION=//p' .env)"
if [[ -z "$version" ]]; then
  echo "build-ui: AGENT_SWARM_VERSION missing from .env" >&2
  exit 1
fi

# The dashboard is built pre-pointed at this API with the operator key, so
# nobody pastes either into the setup page (apps/ui README: VITE_API_URL and
# VITE_API_KEY must be set together). The key is baked into the bundle, so it
# is only safe behind the Google sign-in: refuse to build for an open deploy.
api_key="$(sed -n 's/^API_KEY=//p' .env)"
auth="$(sed -n 's/^SWARM_AUTH=//p' .env)"
if [[ -z "$api_key" ]]; then
  echo "build-ui: API_KEY missing from .env" >&2
  exit 1
fi
if [[ "$auth" != "sso" ]]; then
  echo "build-ui: refusing to bake API_KEY into a bundle served without SSO (SWARM_AUTH=$auth)" >&2
  exit 1
fi

# Not /tmp: it is a RAM-backed tmpfs on AL2023 and node_modules is large.
build="$(mktemp -d /opt/agent-swarm/.ui-build.XXXXXX)"
trap 'rm -rf "$build"' EXIT

git clone --quiet --depth 1 --branch "v$version" \
  https://github.com/desplega-ai/agent-swarm "$build/src"
cd "$build/src/apps/ui"
/usr/local/bin/bun install --frozen-lockfile
VITE_API_URL="https://delegate-swarm.infra.goodparty.org" VITE_API_KEY="$api_key" \
  /usr/local/bin/bun run build

if [[ ! -s dist/index.html ]]; then
  echo "build-ui: build produced no dist/index.html" >&2
  exit 1
fi

mkdir -p /opt/agent-swarm/ui-dist
rsync -a --delete dist/ /opt/agent-swarm/ui-dist/
echo "$version" >/opt/agent-swarm/ui-dist/.agent-swarm-version
# Marker for up.sh: rebuild when the baked key changes (a digest, not the key).
printf '%s' "$api_key" | sha256sum | cut -d' ' -f1 >/opt/agent-swarm/ui-dist/.api-key-sha
echo "build-ui: ui-dist now holds agent-swarm v$version"
