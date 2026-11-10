#!/usr/bin/env bash
# Writes the part of the swarm's SQLite state that this repo owns: the global
# SETUP_SCRIPT, the grafana and clickup MCP servers, the model-catalogue overlay
# row for the US-only router, and each agent's harness and model. up.sh runs it
# on every deploy once the stack is up, so a merge is enough to apply a change
# to any of them.
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

# --- model catalogue overlay ------------------------------------------------
#
# agent-swarm's catalogue is models.dev's `fireworks-ai` section, which lists
# neither a `fireworks-us` provider nor the dated US-only router, so the console
# finds no row for the one model every agent runs. The runtime page then says
# "No reasoning effort applies to this model: the catalog does not list it, or
# it does not reason", the effort picker offers nothing to pick, a
# `reasoning_effort` PATCH is rejected, and the context window falls back to
# 200k instead of 1M. The agents think regardless -- pi resolves its default
# level, this model's thinkingLevelMap sends it on to `high`, and sessions run
# with adaptive thinking at high effort -- so the gap is the console's view of
# the model, not the model's configuration.
#
# The fix is an overlay row: hand-verified facts that win over models.dev per
# field and are served next to it (agent-swarm v2.6.0,
# `runbooks/model-catalog.md`, "Overlay write"). It is written here because this
# is the one script that runs on every deploy with an operator-level key, so the
# row survives a redeploy.
#
# The facts are DERIVED from the models.json heredoc in global-setup-script.sh,
# never restated: `reasoning_options` carries that model's thinkingLevelMap
# values, which are already the provider's own effort tokens. That matters --
# the console normalizes `none` to its `off` and maps only
# none/low/medium/high/xhigh/max, so a literal `off` here would be dropped
# silently. A hand-kept second copy of the level list is the drift this avoids.
#
# `expiresWhenUpstreamMatches: false` is deliberate. Expiry needs an upstream
# `model_catalog` row for the same provider and id, and models.dev has no
# `fireworks-us` section at all (that pinned tag's CATALOG_PROVIDER_IDS has no
# such entry), so the condition can never be met; `true` would mark a permanent
# row as temporary.
#
# No `pricing` field. Overlay prices reach the pricing table through the
# models.dev seed projection, which enumerates a fixed set of sections
# (anthropic, openai, google, fireworks-ai, xai, deepseek, openrouter and the
# OpenAI-compatible registry) and has no `fireworks-us` case, so a price here
# would be stored and never used. Sessions stay `costSource: 'unpriced'`; pi's
# own dollar figure from the models.json cost block is what the dashboard shows.
# See README, "Models".

# Prints the overlay body for the model in $1/$2, read from the models.json
# text in $3. A function of its own so model-catalog-overlay.test.ts can run the
# same code the deploy runs against the same heredoc.
model_catalog_overlay_body() {
  local provider=$1 model=$2 models=$3
  jq -n --argjson models "$models" --arg provider "$provider" --arg model "$model" '
    ($models.providers[$provider].models // []
      | map(select(.id == $model)) | first) as $m
    | if $m == null then null else
        {
          provider: $provider,
          modelId: $model,
          reasoning: ($m.reasoning == true),
          reasoningOptions: [{
            type: "effort",
            values: [$m.thinkingLevelMap // {} | to_entries[] | select(.value != null) | .value]
          }],
          reason: "US-only Fireworks router: models.dev lists neither this id nor a fireworks-us provider, so the console could not see or set its reasoning effort. Facts derived from the pi models.json in agent-swarm/host/global-setup-script.sh.",
          verifiedBy: "sync-agent-config.sh",
          expiresWhenUpstreamMatches: false
        }
        + (if $m.name then {name: $m.name} else {} end)
        + (if ($m.contextWindow | type) == "number" then {contextWindow: $m.contextWindow} else {} end)
        + (if ($m.maxTokens | type) == "number" then {maxOutput: $m.maxTokens} else {} end)
      end'
}

# The heredoc body out of global-setup-script.sh, which is what the worker's pi
# actually loads (fireworks-residency.test.ts extracts it the same way).
models_json="$(awk '/^cat >"\$PI_MODELS_TMP" <<.PI_MODELS_JSON.$/{on=1; next}
  /^PI_MODELS_JSON$/{on=0} on' global-setup-script.sh 2>/dev/null || true)"
overlay_provider="${LEAD_MODEL%%/*}"
overlay_model="${LEAD_MODEL#*/}"
# Not fatal, either way: the setup script, the MCP servers and the runtime model
# below are what make the agents run at all, so a catalogue row that cannot be
# written is reported and the sync carries on. The write is an upsert, so
# re-running this script is the retry.
if [[ -z "$models_json" ]]; then
  echo "model catalogue overlay: global-setup-script.sh has no readable models.json heredoc; skipped, so the console cannot see $LEAD_MODEL's reasoning effort" >&2
elif ! overlay="$(model_catalog_overlay_body "$overlay_provider" "$overlay_model" "$models_json")"; then
  echo "model catalogue overlay: could not derive a row from the models.json heredoc; skipped, so the console cannot see $LEAD_MODEL's reasoning effort" >&2
elif [[ -z "$overlay" || "$overlay" == null ]]; then
  echo "model catalogue overlay: models.json does not define $overlay_provider/$overlay_model; skipped, so the console cannot see its reasoning effort" >&2
elif out="$(api PUT /api/models-catalog/overlay -d @- <<<"$overlay" 2>&1)"; then
  echo "model catalogue overlay: $overlay_provider/$overlay_model"
else
  echo "model catalogue overlay: the upsert failed ($out); the agents still run, but the console will show no reasoning effort for $LEAD_MODEL. Re-run this script to retry." >&2
fi

# The model is a custom id as far as agent-swarm is concerned: its catalog
# (models.dev, `fireworks-ai`) lists no US-only router, so the runtime PATCH
# would 400 on "Unknown model" without `allow_custom_model`. The overlay row
# above is what now lists it; `allow_custom_model` stays as the belt to that
# brace, because "Unknown model" is a 400 on this PATCH and a deploy that only
# half-applies is the failure this script exists to avoid. The id is deliberate,
# and models.json in global-setup-script.sh is what makes pi able to run it. The
# harness family guard is unaffected: only claude/claude-managed/codex/grok are
# judged by family, so the `pi` harness takes this id as given on the claim path
# too. The runtime applies to the next session, so it needs no restart.
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
