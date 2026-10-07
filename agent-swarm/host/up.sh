#!/usr/bin/env bash
set -euo pipefail
cd /opt/agent-swarm
./render-env.sh
docker compose --profile tls up -d --remove-orphans
docker compose --profile tls ps
