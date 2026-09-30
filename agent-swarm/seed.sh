#!/usr/bin/env bash
#
# Install the recurring incident-swarm jobs.
#
# Run this from an operator's laptop against the swarm API. It is idempotent:
# each schedule is looked up by name first, so re-running prints "found" instead
# of creating a second copy or failing on a duplicate.
#
#   export AGENT_SWARM_API_KEY=...
#   export SWARM_BASE_URL=https://agent-swarm.goodparty.org   # optional
#   ./seed.sh
#
# The jobs it creates only describe themselves. What each job must actually do
# lives in the lead agent's system prompt (incident-commander.md, "Between
# incidents: the scheduled jobs"), so the two stay in one place and the task text
# cannot drift into a second, weaker copy of the rules.

set -euo pipefail

SWARM_BASE_URL="${SWARM_BASE_URL:-https://agent-swarm.goodparty.org}"
SWARM_BASE_URL="${SWARM_BASE_URL%/}"

KV_NAMESPACE="shared/incidents"
CHANNEL_ENV="\$SWARM_INCIDENT_CHANNEL"

if [ -z "${AGENT_SWARM_API_KEY:-}" ]; then
  echo "error: AGENT_SWARM_API_KEY is not set" >&2
  exit 1
fi

RESP_STATUS=""
RESP_BODY=""

fail() {
  echo "error: $*" >&2
  exit 1
}

# curl exits 0 on an HTTP error response, so the status code is read off the
# response rather than off the exit code. A transport failure still aborts the
# script through `set -e`.
request() {
  local method="$1" path="$2" body="${3:-}"
  local out
  if [ -n "$body" ]; then
    out=$(curl -sS -X "$method" "$SWARM_BASE_URL$path" \
      -H "Authorization: Bearer $AGENT_SWARM_API_KEY" \
      -H "Content-Type: application/json" \
      -w $'\n%{http_code}' \
      --data "$body") || fail "curl failed: $method $path"
  else
    out=$(curl -sS -X "$method" "$SWARM_BASE_URL$path" \
      -H "Authorization: Bearer $AGENT_SWARM_API_KEY" \
      -w $'\n%{http_code}') || fail "curl failed: $method $path"
  fi
  RESP_STATUS="${out##*$'\n'}"
  RESP_BODY="${out%$'\n'*}"
}

# Returns the id of a schedule with this exact name, or nothing. The API's name
# filter is a partial match, so the exact comparison happens here.
find_schedule_id() {
  local name="$1" out
  out=$(curl -sS -G "$SWARM_BASE_URL/api/schedules" \
    -H "Authorization: Bearer $AGENT_SWARM_API_KEY" \
    -w $'\n%{http_code}' \
    --data-urlencode "name=$name") || fail "curl failed: GET /api/schedules"
  RESP_STATUS="${out##*$'\n'}"
  RESP_BODY="${out%$'\n'*}"
  [ "$RESP_STATUS" = "200" ] ||
    fail "GET /api/schedules returned $RESP_STATUS: $RESP_BODY"
  BODY="$RESP_BODY" NAME="$name" python3 - <<'PY'
import json, os
data = json.loads(os.environ["BODY"])
for row in data.get("schedules") or []:
    if row.get("name") == os.environ["NAME"]:
        print(row.get("id") or "")
        break
PY
}

# The board, the all-clear and the stale sweep all post to Slack, and
# slack-post requires lead privileges. Resolving the lead here is what makes the
# scheduled tasks runnable at all.
resolve_lead_agent_id() {
  if [ -n "${LEAD_AGENT_ID:-}" ]; then
    printf '%s' "$LEAD_AGENT_ID"
    return 0
  fi
  request GET "/api/agents?fields=slim"
  [ "$RESP_STATUS" = "200" ] ||
    fail "GET /api/agents returned $RESP_STATUS: $RESP_BODY"
  BODY="$RESP_BODY" python3 - <<'PY'
import json, os
data = json.loads(os.environ["BODY"])
leads = [a for a in (data.get("agents") or []) if a.get("isLead")]
if len(leads) == 1:
    print(leads[0].get("id") or "")
PY
}

# Emits the JSON body for one schedule. Values arrive through the environment so
# a task template containing quotes cannot break the request.
build_schedule_body() {
  NAME="$1" DESC="$2" TTYPE="$3" CRON="$4" INTERVAL="$5" TEMPLATE="$6" LEAD="$7" \
    python3 - <<'PY'
import json, os
body = {
    "name": os.environ["NAME"],
    "description": os.environ["DESC"],
    "taskType": os.environ["TTYPE"],
    "taskTemplate": os.environ["TEMPLATE"],
    "targetType": "agent-task",
    "scheduleType": "recurring",
    "priority": 60,
    "tags": ["incident-swarm", "scheduled"],
    "enabled": True,
}
if os.environ.get("CRON"):
    body["cronExpression"] = os.environ["CRON"]
    body["timezone"] = "America/New_York"
if os.environ.get("INTERVAL"):
    body["intervalMs"] = int(os.environ["INTERVAL"])
if os.environ.get("LEAD"):
    body["targetAgentId"] = os.environ["LEAD"]
print(json.dumps(body))
PY
}

ensure_schedule() {
  local name="$1" body="$2" id
  id="$(find_schedule_id "$name")"
  if [ -n "$id" ]; then
    printf '  found    %-32s %s\n' "$name" "$id"
    return 0
  fi

  request POST "/api/schedules" "$body"
  case "$RESP_STATUS" in
    201)
      id="$(BODY="$RESP_BODY" python3 -c 'import json,os; print(json.loads(os.environ["BODY"]).get("id",""))')"
      printf '  created  %-32s %s\n' "$name" "$id"
      ;;
    409)
      # A concurrent create won the race between the lookup and the POST. The
      # name exists, which is the outcome this script wanted, so re-read it.
      id="$(find_schedule_id "$name")"
      [ -n "$id" ] || fail "$name returned 409 but cannot be found by name"
      printf '  found    %-32s %s\n' "$name" "$id"
      ;;
    *)
      fail "POST /api/schedules for $name returned $RESP_STATUS: $RESP_BODY"
      ;;
  esac
}

read -r -d '' BOARD_TEMPLATE <<EOF || true
Scheduled job: MORNING BOARD for the incident swarm. This is a reporting job, not an investigation.

Follow "Morning board" in your system prompt exactly. Read board:index and every incident:<n> from the KV namespace ${KV_NAMESPACE} (pass the namespace explicitly; the default is your task context and holds nothing), keep the incidents that are not CLOSED or MERGED, and post one line per open incident to the incident channel ${CHANNEL_ENV}.

If nothing is open, post nothing. The all-clear is a separate job with its own rule and the two must not both fire. Do not open an incident. Do not investigate. Finish the task once the board is posted, or once you have confirmed there is nothing to post.
EOF

read -r -d '' ALL_CLEAR_TEMPLATE <<EOF || true
Scheduled job: ALL-CLEAR for the incident swarm. This is a reporting job, not an investigation.

Follow "All-clear" in your system prompt exactly. Read board:index and every incident:<n> from the KV namespace ${KV_NAMESPACE} (pass the namespace explicitly; the default is your task context and holds nothing) and count the open incidents. Then apply the two date keys clear:zeroSince and clear:lastPostedDate in the same namespace, and post the all-clear only when the rules in your prompt say to.

Both keys are dates, never timestamps: this job runs hourly, so a timestamp would let a restart or a clock change post twice for one clear period. Do not open an incident. Do not investigate. Finish the task once you have either posted the all-clear or decided, by the rules, not to.
EOF

read -r -d '' STALE_SWEEP_TEMPLATE <<EOF || true
Scheduled job: STALE SWEEP for the incident swarm. This is a reporting job, not an investigation.

Follow "Stale sweep" in your system prompt exactly. Read board:index and every incident:<n> from the KV namespace ${KV_NAMESPACE} (pass the namespace explicitly; the default is your task context and holds nothing). For each open incident whose updatedAt is more than 24 hours old, post a nudge in that incident's own thread, then post one summary line in the incident channel ${CHANNEL_ENV} naming how many are stale and which ones.

Change no incident state. A nudge is a report, not a transition. If nothing is stale, post nothing. Do not open an incident. Do not investigate. Finish the task once the nudges are posted, or once you have confirmed there are none.
EOF

echo "seeding incident-swarm schedules at $SWARM_BASE_URL"

LEAD="$(resolve_lead_agent_id)"
[ -n "$LEAD" ] ||
  fail "no lead agent found (set LEAD_AGENT_ID to override). Scheduled tasks post to Slack and slack-post requires lead privileges."

printf '  lead agent %s\n' "$LEAD"

ensure_schedule "swarm-incident-morning-board" \
  "$(build_schedule_body \
    "swarm-incident-morning-board" \
    "Posts a status board of all open incidents at 07:00 America/New_York." \
    "report" \
    "0 7 * * *" \
    "" \
    "$BOARD_TEMPLATE" \
    "$LEAD")"

ensure_schedule "swarm-incident-all-clear" \
  "$(build_schedule_body \
    "swarm-incident-all-clear" \
    "Posts once when the open-incident count reaches zero and stays there." \
    "report" \
    "" \
    "3600000" \
    "$ALL_CLEAR_TEMPLATE" \
    "$LEAD")"

ensure_schedule "swarm-incident-stale-sweep" \
  "$(build_schedule_body \
    "swarm-incident-stale-sweep" \
    "Nudges any incident whose updatedAt is older than 24 hours." \
    "maintenance" \
    "" \
    "14400000" \
    "$STALE_SWEEP_TEMPLATE" \
    "$LEAD")"

# ---------------------------------------------------------------------------
# The lead's identity
# ---------------------------------------------------------------------------
#
# This is the step that makes the swarm behave like an incident system rather
# than a general agent fleet.
#
# The operating procedure travels in the lead's operator prompt
# (SYSTEM_PROMPT_FILE, incident-commander.md). But agent-swarm APPENDS that prompt
# below a base it builds from the agent's persona and its 52 seeded skills, and in
# practice the base framing won: with only the appended procedure, the lead worked
# incidents by returning a text output. It never opened a Slack thread and never
# wrote incident state.
#
# SOUL.md is section A of that base prompt, so the identity belongs there and the
# procedure stays as the detail it defers to. It has to fit 10,000 characters:
# above that agent-swarm accepts only updates that do not grow the stored value,
# so a longer identity is refused rather than truncated.
IDENTITY_FILE="$(cd "$(dirname "$0")" && pwd)/incident-commander-soul.md"
if [ ! -f "$IDENTITY_FILE" ]; then
  printf '  skipped    %s not found; the lead keeps whatever identity it has\n' "$IDENTITY_FILE"
else
  IDENTITY_CHARS="$(wc -m < "$IDENTITY_FILE" | tr -d ' ')"
  if [ "$IDENTITY_CHARS" -ge 10000 ]; then
    fail "$IDENTITY_FILE is $IDENTITY_CHARS characters. agent-swarm refuses a profile update that grows a stored value past 10000, so trim it before seeding."
  fi
  IDENTITY_BODY="$(IDENTITY_FILE="$IDENTITY_FILE" python3 - <<'PY'
import json, os
soul = open(os.environ["IDENTITY_FILE"]).read()
print(json.dumps({
    "description": "Incident commander for GoodParty production alerts. Owns each incident end to end and reports it in Slack.",
    "soulMd": soul,
    "changeSource": "seed.sh",
    "changeReason": "Install the incident-commander identity so it sits at the top of the base prompt rather than below it",
}))
PY
)"
  request PUT "/api/agents/$LEAD/profile" "$IDENTITY_BODY"
  [ "$RESP_STATUS" = "200" ] ||
    fail "PUT /api/agents/$LEAD/profile returned $RESP_STATUS: $RESP_BODY"
  printf '  installed  incident-commander identity on the lead (%s chars)\n' "$IDENTITY_CHARS"
fi

echo "done. schedules are enabled and will dispatch tasks to the lead agent."
