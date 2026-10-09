#!/usr/bin/env bash
# Rebuilds the swarm state that lives only in SQLite: the global SETUP_SCRIPT,
# the grafana and clickup MCP servers, the lead's soul, and each agent's
# harness and model.
# Run as root on the host once the stack is up. Safe to run again, but a rerun
# replaces any edits the lead made to its own SOUL.md and IDENTITY.md with the
# copies in soul/.
set -euo pipefail
cd /opt/agent-swarm

API=http://127.0.0.1:3013
LEAD="$(sed -n 's/^LEAD_AGENT_ID=//p' .env)"
CODER="$(sed -n 's/^CODER_AGENT_ID=//p' .env)"
REVIEWER="$(sed -n 's/^REVIEWER_AGENT_ID=//p' .env)"
HARNESS="$(sed -n 's/^HARNESS_PROVIDER=//p' .env)"
LEAD_MODEL="$(sed -n 's/^LEAD_MODEL_OVERRIDE=//p' .env)"
WORKER_MODEL="$(sed -n 's/^WORKER_MODEL_OVERRIDE=//p' .env)"
for v in LEAD CODER REVIEWER HARNESS LEAD_MODEL WORKER_MODEL; do
  if [[ -z "${!v}" ]]; then
    echo "bootstrap: $v is empty; is .env rendered?" >&2
    exit 1
  fi
done

# The key goes to curl through a file, not argv, so ps never shows it.
AUTH="$(mktemp)"
trap 'rm -f "$AUTH"' EXIT
chmod 600 "$AUTH"
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^API_KEY=//p' .env)" >"$AUTH"

api() {
  local method=$1 path=$2
  shift 2
  curl -sS --fail-with-body -X "$method" -H @"$AUTH" -H 'Content-Type: application/json' \
    "$API$path" "$@"
}

# A worker seeds its template profile right after it registers, filling only
# the fields that were empty when it read them. Waiting for the lead's soul to
# be non-empty keeps that seed from landing on top of the PUT below.
ready=0
for _ in $(seq 60); do
  if api GET '/api/agents?fields=full' 2>/dev/null | jq -e \
    --arg lead "$LEAD" --arg coder "$CODER" --arg reviewer "$REVIEWER" '
      [.agents[] | select(.id == $coder or .id == $reviewer
        or (.id == $lead and (.soulMd // "") != ""))] | length == 3' >/dev/null; then
    ready=1
    break
  fi
  sleep 5
done
if ((ready == 0)); then
  echo "bootstrap: the three agents did not register within 5 minutes" >&2
  exit 1
fi
echo "agents: lead, coder and reviewer registered"

jq -n --rawfile v global-setup-script.sh \
  '{scope: "global", key: "SETUP_SCRIPT", value: $v,
    description: "Root hook: AWS CLI v2, GitHub App token helper for git and gh"}' \
  | api PUT /api/config -d @- \
  | jq -r '"setup script: saved as global config \(.id)"'

grafana="$(api GET '/api/mcp-servers?scope=swarm' | jq -r '[.servers[] | select(.name == "grafana")][0].id // ""')"
if [[ -n "$grafana" ]]; then
  echo "grafana mcp: already registered as $grafana"
else
  grafana="$(jq -n '{name: "grafana", transport: "http", scope: "swarm",
      url: "http://grafana-mcp:8000/mcp",
      description: "Grafana Cloud, read-only, through the grafana-mcp sidecar"}' \
    | api POST /api/mcp-servers -d @- | jq -r '.server.id')"
  echo "grafana mcp: registered as $grafana"
fi
for agent in "$LEAD" "$CODER" "$REVIEWER"; do
  jq -n --arg a "$agent" '{agentId: $a}' \
    | api POST "/api/mcp-servers/$grafana/install" -d @- >/dev/null
done
echo "grafana mcp: installed on lead, coder and reviewer"

# An agent session that meets clickup before it is authorized skips it for
# days, so it is installed only once it is connected.
clickup="$(api GET '/api/mcp-servers?scope=swarm' | jq -r '[.servers[] | select(.name == "clickup")][0].id // ""')"
if [[ -n "$clickup" ]]; then
  echo "clickup mcp: already registered as $clickup"
else
  clickup="$(jq -n '{name: "clickup", transport: "http", scope: "swarm",
      url: "https://mcp.clickup.com/mcp", description: "ClickUp hosted MCP, OAuth"}' \
    | api POST /api/mcp-servers -d @- | jq -r '.server.id')"
  echo "clickup mcp: registered as $clickup"
fi
if api GET "/api/mcp-oauth/$clickup/status" | jq -e '.connected' >/dev/null; then
  for agent in "$LEAD" "$CODER" "$REVIEWER"; do
    jq -n --arg a "$agent" '{agentId: $a}' \
      | api POST "/api/mcp-servers/$clickup/install" -d @- >/dev/null
  done
  echo "clickup mcp: connected, installed on lead, coder and reviewer"
else
  echo "clickup mcp: not connected, not installed; Connect it in the dashboard (MCP servers, clickup), then run bootstrap.sh again"
fi

if api GET "/api/agents/$LEAD" | jq -e --rawfile s soul/SOUL.md --rawfile i soul/IDENTITY.md \
  '.soulMd == $s and .identityMd == $i' >/dev/null; then
  echo "lead profile: already matches soul/"
else
  jq -n --rawfile s soul/SOUL.md --rawfile i soul/IDENTITY.md \
    '{soulMd: $s, identityMd: $i, changeSource: "api", changeReason: "bootstrap.sh from soul/"}' \
    | api PUT "/api/agents/$LEAD/profile" -d @- >/dev/null
  echo "lead profile: SOUL.md and IDENTITY.md set from soul/"
fi

for pair in "lead:$LEAD:$LEAD_MODEL" "coder:$CODER:$WORKER_MODEL" "reviewer:$REVIEWER:$WORKER_MODEL"; do
  IFS=: read -r name agent model <<<"$pair"
  jq -n --arg h "$HARNESS" --arg m "$model" '{harness_provider: $h, model: $m}' \
    | api PATCH "/api/agents/$agent/runtime" -d @- >/dev/null
  echo "$name runtime: $HARNESS, $model"
done

echo "done. Workers read the setup script and MCP servers at start:"
echo "  cd /opt/agent-swarm && docker compose restart lead worker-coder worker-reviewer"
