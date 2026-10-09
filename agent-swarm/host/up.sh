#!/usr/bin/env bash
set -euo pipefail
cd /opt/agent-swarm
./render-env.sh

version="$(sed -n 's/^AGENT_SWARM_VERSION=//p' .env)"
auth="$(sed -n 's/^SWARM_AUTH=//p' .env)"
built="$(cat ui-dist/.agent-swarm-version 2>/dev/null || true)"
if [[ "$built" != "$version+$auth" ]]; then
  ./build-ui.sh
fi

# Bind-mounted into caddy; it must exist before compose starts it, or docker
# creates a directory in its place.
if [[ ! -e dashboard-tokens.caddy ]]; then
  install -m 600 /dev/null dashboard-tokens.caddy
fi

# The profile set must be identical on every call, or --remove-orphans can
# remove the containers of a profile that was left out.
profiles=(--profile tls)
if grep -q '^OAUTH2_PROXY_CLIENT_ID=.' .env; then
  profiles+=(--profile sso)
fi

docker compose "${profiles[@]}" up -d --remove-orphans

if [[ "$auth" == "sso" ]]; then
  ./sync-dashboard-users.sh
fi

# up -d does not recreate caddy when only the Caddyfile changed. Retry because
# a freshly created caddy may not have its admin endpoint listening yet.
for attempt in 1 2 3 4 5; do
  if docker compose "${profiles[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
    break
  fi
  if ((attempt == 5)); then
    echo "up: caddy reload failed" >&2
    exit 1
  fi
  sleep 3
done

docker compose "${profiles[@]}" ps
