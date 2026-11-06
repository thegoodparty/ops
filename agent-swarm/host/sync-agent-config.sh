#!/usr/bin/env bash
# Writes the part of the swarm's SQLite state that this repo owns: the global
# SETUP_SCRIPT, the grafana and clickup MCP servers, and each agent's harness
# and model. up.sh runs it on every deploy once the stack is up, so a merge is
# enough to apply a change to any of them.
#
# It touches nothing the swarm owns (scripts, skills, schedules, souls,
# identities, other config), so changes made from Slack or the dashboard
# survive every deploy. Restarts the agents only when what they read at start
# changed: the setup script or an MCP server install.
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
    echo "sync-agent-config: $v is empty; is .env rendered?" >&2
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

ready=0
for _ in $(seq 60); do
  if api GET '/api/agents' 2>/dev/null | jq -e \
    --arg lead "$LEAD" --arg coder "$CODER" --arg reviewer "$REVIEWER" '
      [.agents[] | select(.id == $lead or .id == $coder or .id == $reviewer)]
      | length == 3' >/dev/null; then
    ready=1
    break
  fi
  sleep 5
done
if ((ready == 0)); then
  echo "sync-agent-config: the three agents did not register within 5 minutes" >&2
  exit 1
fi
echo "agents: lead, coder and reviewer registered"

restart=0

if api GET '/api/config?scope=global&key=SETUP_SCRIPT' \
  | jq -e --rawfile v global-setup-script.sh '.configs[0].value == $v' >/dev/null; then
  echo "setup script: unchanged"
else
  jq -n --rawfile v global-setup-script.sh \
    '{scope: "global", key: "SETUP_SCRIPT", value: $v,
      description: "Root hook: AWS CLI v2, GitHub App token helper, pi models.json"}' \
    | api PUT /api/config -d @- >/dev/null
  echo "setup script: saved as global config"
  restart=1
fi

# Installs a server on each agent that lacks it. Installing is an upsert, but
# checking first is what tells us whether the agents need a restart.
install_mcp() {
  local name=$1 server=$2 agent
  for agent in "$LEAD" "$CODER" "$REVIEWER"; do
    if api GET "/api/agents/$agent/mcp-servers" | jq -e --arg s "$server" \
      'any(.servers[]; .id == $s)' >/dev/null; then
      continue
    fi
    jq -n --arg a "$agent" '{agentId: $a}' \
      | api POST "/api/mcp-servers/$server/install" -d @- >/dev/null
    echo "$name mcp: installed on $agent"
    restart=1
  done
}

grafana="$(api GET '/api/mcp-servers?scope=swarm' | jq -r '[.servers[] | select(.name == "grafana")][0].id // ""')"
if [[ -z "$grafana" ]]; then
  grafana="$(jq -n '{name: "grafana", transport: "http", scope: "swarm",
      url: "http://grafana-mcp:8000/mcp",
      description: "Grafana Cloud, read-only, through the grafana-mcp sidecar"}' \
    | api POST /api/mcp-servers -d @- | jq -r '.server.id')"
  echo "grafana mcp: registered as $grafana"
fi
install_mcp grafana "$grafana"

# An agent session that meets clickup before it is authorized skips it for
# days, so it is installed only once it is connected.
clickup="$(api GET '/api/mcp-servers?scope=swarm' | jq -r '[.servers[] | select(.name == "clickup")][0].id // ""')"
if [[ -z "$clickup" ]]; then
  clickup="$(jq -n '{name: "clickup", transport: "http", scope: "swarm",
      url: "https://mcp.clickup.com/mcp", description: "ClickUp hosted MCP, OAuth"}' \
    | api POST /api/mcp-servers -d @- | jq -r '.server.id')"
  echo "clickup mcp: registered as $clickup"
fi
if api GET "/api/mcp-oauth/$clickup/status" | jq -e '.connected' >/dev/null; then
  install_mcp clickup "$clickup"
else
  echo "clickup mcp: not connected, not installed; Connect it in the dashboard (MCP servers, clickup), then run sync-agent-config.sh"
fi

# The model is a custom id as far as agent-swarm is concerned: its catalog
# (models.dev, `fireworks-ai`) lists no US-only router, so the runtime PATCH
# would 400 on "Unknown model" without `allow_custom_model`. The id is not
# merely uncatalogued either -- it is deliberate, and models.json in
# global-setup-script.sh is what makes pi able to run it. The harness family
# guard is unaffected: only claude/claude-managed/codex/grok are judged by
# family, so the `pi` harness takes this id as given on the claim path too.
# The runtime applies to the next session, so it needs no restart.
for pair in "lead:$LEAD:$LEAD_MODEL" "coder:$CODER:$WORKER_MODEL" "reviewer:$REVIEWER:$WORKER_MODEL"; do
  IFS=: read -r name agent model <<<"$pair"
  jq -n --arg h "$HARNESS" --arg m "$model" \
    '{harness_provider: $h, model: $m, allow_custom_model: true}' \
    | api PATCH "/api/agents/$agent/runtime" -d @- >/dev/null
  echo "$name runtime: $HARNESS, $model"
done

if ((restart == 1)); then
  docker compose restart lead worker-coder worker-reviewer
  echo "agents: restarted to pick up the setup script and MCP servers"
fi
