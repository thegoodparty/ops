#!/usr/bin/env bash
# Builds the dashboard SPA (apps/ui) of agent-swarm at AGENT_SWARM_VERSION and
# syncs it into ui-dist. ui-dist is a directory bind mount into caddy, so it is
# updated in place rather than replaced, and only from a build that succeeded.
set -euo pipefail
cd /opt/agent-swarm

version="$(sed -n 's/^AGENT_SWARM_VERSION=//p' .env)"
auth="$(sed -n 's/^SWARM_AUTH=//p' .env)"
app_url="$(sed -n 's/^APP_URL=//p' .env)"
if [[ -z "$version" ]]; then
  echo "build-ui: AGENT_SWARM_VERSION missing from .env" >&2
  exit 1
fi

# Not /tmp: it is a RAM-backed tmpfs on AL2023 and node_modules is large.
build="$(mktemp -d /opt/agent-swarm/.ui-build.XXXXXX)"
trap 'rm -rf "$build"' EXIT

git clone --quiet --depth 1 --branch "v$version" \
  https://github.com/desplega-ai/agent-swarm "$build/src"
cd "$build/src/apps/ui"
/usr/local/bin/bun install --frozen-lockfile
# Behind Google login the dashboard is built locked to this API with a
# placeholder key, so nobody pastes one; Caddy replaces it with the signed-in
# person's own token (Caddyfile, sso snippet). The aswt_ prefix makes the
# dashboard take its identity from /api/whoami instead of offering a picker.
if [[ "$auth" == "sso" ]]; then
  VITE_API_URL="$app_url" VITE_API_KEY=aswt_sso_gateway /usr/local/bin/bun run build
else
  /usr/local/bin/bun run build
fi

if [[ ! -s dist/index.html ]]; then
  echo "build-ui: build produced no dist/index.html" >&2
  exit 1
fi

mkdir -p /opt/agent-swarm/ui-dist
rsync -a --delete dist/ /opt/agent-swarm/ui-dist/
echo "$version+$auth" >/opt/agent-swarm/ui-dist/.agent-swarm-version
echo "build-ui: ui-dist now holds agent-swarm v$version ($auth)"
