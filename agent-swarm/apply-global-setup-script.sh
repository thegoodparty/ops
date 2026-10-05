#!/usr/bin/env bash
# Upserts global-setup-script.sh as the swarm's global SETUP_SCRIPT config.
# Workers pick it up on their next container start:
#   docker compose restart lead worker-coder worker-reviewer
set -euo pipefail
cd /opt/agent-swarm
set -a; . ./.env; set +a
jq -n --rawfile v ./global-setup-script.sh \
  '{scope:"global",key:"SETUP_SCRIPT",value:$v,description:"Root hook: AWS CLI v2 on /workspace/shared, linked into /usr/local/bin"}' \
  | curl -sS -f -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
      -X PUT http://127.0.0.1:3013/api/config -d @- \
  | jq '{id,scope,key,lastUpdatedAt}'
