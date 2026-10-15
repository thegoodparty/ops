#!/usr/bin/env bash
# Rebuilds the swarm state that lives only in SQLite: the global SETUP_SCRIPT,
# the grafana and clickup MCP servers, the lead's soul, each agent's
# harness and model, and the runtime pool with its controller.
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

# Runtime pools. Pool workers get none of the compose environment, so the
# credentials they need are copied into secret global config (encrypted with
# SECRETS_ENCRYPTION_KEY), which every worker exports at start. Rerun after
# rotating any of them in the secret.
for pair in ANTHROPIC_API_KEY:ANTHROPIC_API_KEY CLICKUP_API_TOKEN:CLICKUP_API_TOKEN \
  CLICKUP_API_KEY:CLICKUP_API_TOKEN GRAFANA_SERVICE_ACCOUNT_TOKEN:GRAFANA_SERVICE_ACCOUNT_TOKEN \
  GITHUB_APP_ID:GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY:GITHUB_APP_PRIVATE_KEY; do
  IFS=: read -r key from <<<"$pair"
  value="$(sed -n "s/^$from=//p" .env)"
  [[ -n "$value" ]] || continue
  jq -n --arg k "$key" --arg v "$value" \
    '{scope: "global", key: $k, value: $v, isSecret: true,
      description: "From the DELEGATE_SWARM secret, for runtime pool workers"}' \
    | api PUT /api/config -d @- >/dev/null
  echo "pool credentials: $key saved as secret global config"
done
unset value

if ! controllers="$(api GET /api/runtime-controllers 2>/dev/null)"; then
  echo "runtime pools: disabled on the API, skipped"
else
  controller="$(jq -r '[.controllers[] | select(.name == "host-docker")][0].id // ""' <<<"$controllers")"
  if [[ -z "$controller" ]]; then
    controller="$(jq -n '{name: "host-docker", kind: "docker", placement: "remote",
        config: {WORKER_API_URL: "http://api:3013"}}' \
      | api POST /api/runtime-controllers -d @- | jq -r '.controller.id')"
    echo "runtime controller: registered host-docker as $controller"
  else
    echo "runtime controller: host-docker already registered as $controller"
  fi
  status="$(api GET "/api/runtime-controllers/$controller" | jq -r '.controller.status')"
  if [[ "$status" == online && -s controller.env ]]; then
    echo "runtime controller: online"
  else
    # Minting revokes the previous token, so only when the controller is not
    # connected. The token lives only in controller.env.
    install -m 600 /dev/null controller.env.tmp
    api POST "/api/runtime-controllers/$controller/token" \
      | jq -r '"AGENT_SWARM_CONTROLLER_TOKEN=" + .plaintext' >controller.env.tmp
    # up.sh runs compose as the owner of .env, which has to read this file.
    chown --reference=.env controller.env.tmp
    mv -f controller.env.tmp controller.env
    profiles=(--profile tls --profile pools)
    if grep -q '^OAUTH2_PROXY_CLIENT_ID=.' .env; then
      profiles+=(--profile sso)
    fi
    docker compose "${profiles[@]}" up -d --force-recreate swarm-controller >/dev/null
    echo "runtime controller: token minted into controller.env, swarm-controller (re)started"
  fi

  version="$(sed -n 's/^AGENT_SWARM_VERSION=//p' .env)"
  pool_body="$(jq -n --arg c "$controller" --arg v "$version" --arg m "$WORKER_MODEL" \
    --arg gn "$(sed -n 's/^GITHUB_NAME=//p' .env)" --arg ge "$(sed -n 's/^GITHUB_EMAIL=//p' .env)" '
    {name: "workers", kind: "docker", placements: [$c],
     image: ("ghcr.io/desplega-ai/agent-swarm-worker:" + $v),
     delivery: "push", lifecycle: "idle", idleMinutes: 30,
     slotsPerRuntime: 1, minRuntimes: 0, maxRuntimes: 2,
     resources: {cpu: 1, memoryMb: 4096},
     env: {
       ANONYMIZED_TELEMETRY: "false", YOLO: "true",
       MEMORY_RATERS: "implicit-citation,explicit-self",
       MODEL_OVERRIDE: $m,
       GITHUB_NAME: $gn, GITHUB_EMAIL: $ge,
       GRAFANA_URL: "https://goodparty.grafana.net",
       SWARM_URL: "delegate-swarm.infra.goodparty.org",
       APP_URL: "https://delegate-swarm.infra.goodparty.org",
       PUBLIC_MCP_BASE_URL: "https://delegate-swarm.infra.goodparty.org",
       AWS_CONFIG_FILE: "/etc/delegate-swarm/aws-config",
       AWS_SDK_LOAD_CONFIG: "1"}}')"
  pool="$(api GET /api/runtime-pools | jq -r '[.pools[] | select(.name == "workers")][0].id // ""')"
  if [[ -z "$pool" ]]; then
    pool="$(api POST /api/runtime-pools -d "$pool_body" | jq -r '.pool.id')"
    echo "runtime pool: created workers as $pool"
  else
    api PATCH "/api/runtime-pools/$pool" -d "$pool_body" >/dev/null
    echo "runtime pool: workers ($pool) updated to $version"
  fi

  # Installing MCP servers on another agent is lead-only for dashboard users,
  # so the researcher is set up here: same servers as the lead, pi harness.
  researcher="$(api GET '/api/agents?fields=full' | jq -r '[.agents[] | select(.name == "Researcher")][0].id // ""')"
  if [[ -z "$researcher" ]]; then
    researcher="$(jq -n --arg h "$HARNESS" '{name: "Researcher", templateId: "official/researcher",
        harnessProvider: $h, maxTasks: 1}' \
      | api POST "/api/runtime-pools/$pool/agents" -d @- | jq -r '.agent.id')"
    echo "researcher: created on the workers pool as $researcher"
  else
    echo "researcher: already exists as $researcher"
  fi
  jq -n --arg h "$HARNESS" --arg m "$WORKER_MODEL" '{harness_provider: $h, model: $m}' \
    | api PATCH "/api/agents/$researcher/runtime" -d @- >/dev/null
  for server in $(api GET "/api/agents/$LEAD/mcp-servers" | jq -r '.servers[] | select(.scope == "swarm") | .id'); do
    jq -n --arg a "$researcher" '{agentId: $a}' \
      | api POST "/api/mcp-servers/$server/install" -d @- >/dev/null
  done
  echo "researcher: $HARNESS, $WORKER_MODEL, the lead's swarm MCP servers installed"
fi

echo "done. Workers read the setup script and MCP servers at start:"
echo "  cd /opt/agent-swarm && docker compose restart lead worker-coder worker-reviewer"
