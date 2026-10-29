#!/usr/bin/env bash
# Fills the Bifrost gateway secrets in the workbench account from your laptop or
# from the gp-pi container. Values are read without echo or from a mode-600 env
# file, and are never printed. Only key names are reported.
#
#   ./fill-secrets.sh --generated-only   the keys that need no human
#   ./fill-secrets.sh                    generated keys, then prompt for the rest
#   ./fill-secrets.sh --env-file FILE    generated keys, then read the rest from FILE
#   ./fill-secrets.sh --check            list the key names present, print nothing else
#
# Add --dry-run to any filling mode to print the key names it would write
# without writing them.
#
# The containers are the ones phase 1 and 2 create (Pulumi owns the read
# grants; this script only writes values):
#
#   bifrost/gateway        BIFROST_ENCRYPTION_KEY, BIFROST_ADMIN_USERNAME,
#                          BIFROST_ADMIN_PASSWORD, BIFROST_SETUP_TOKEN,
#                          FIREWORKS_API_KEY
#   bifrost/oauth2-proxy   OAUTH2_PROXY_CLIENT_ID, OAUTH2_PROXY_CLIENT_SECRET,
#                          OAUTH2_PROXY_COOKIE_SECRET
#   bifrost/vk-mint        BIFROST_SETUP_TOKEN
#
# bifrost/vk-mint is the setup-token copy the vk-mint Lambda reads (step 3 of
# docs/bifrost-virtual-keys.md, decision 3). It is a separate container so the
# request-facing function can read the token without also being able to read
# bifrost/gateway's encryption key and Fireworks key. The value has to be the
# *same* token the gateway was started with, so this script copies it and
# reports a mismatch rather than asking a human to paste it twice.
#
# `VK_*` virtual key values are deliberately not handled here: they arrive with
# the `engineering` team in phase 2 item 14, and their names depend on the keys
# `config.json` declares. RDS master credentials are managed by RDS itself.
#
# The session needs to be able to write Secrets Manager in the workbench
# account. `WorkbenchAccess` (the workbench account's normal engineer set)
# deliberately cannot; use an admin session in 024901689212. Nobody holds
# admin standing: get it with `/breakglass` in Slack first (docs/sheriff.md).
#
#   aws sso login --profile <profile for AdministratorAccess in 024901689212>
#   AWS_PROFILE=<profile> ./fill-secrets.sh
#
# `--force` overwrites the values this run supplies (the admin password and the
# cookie secret are regenerated, which signs the admin UI out once). It never
# rotates BIFROST_ENCRYPTION_KEY, because that invalidates every provider key
# already stored in the config store; rotating it is `--force
# --rotate-encryption-key`, a deliberate act, not a side effect.
set -euo pipefail

GATEWAY_SECRET="bifrost/gateway"
OAUTH_SECRET="bifrost/oauth2-proxy"
# The mint Lambda's setup-token copy. The name is also a constant in
# deploy-workbench/bifrost-vk-mint.ts (VK_MINT_SECRET_NAME), which grants read
# on this pattern; the two have to agree.
VK_MINT_SECRET="bifrost/vk-mint"
ACCOUNT_ID="024901689212"
REGION="us-west-2"
ADMIN_USERNAME="bifrost-admin"

GATEWAY_DESCRIPTION="Bifrost gateway runtime secrets. Filled out of band with deploy-workbench/bifrost/fill-secrets.sh."
OAUTH_DESCRIPTION="oauth2-proxy credentials for the Bifrost admin surface. Filled out of band with deploy-workbench/bifrost/fill-secrets.sh."
VK_MINT_DESCRIPTION="The Bifrost setup token, for the vk-mint Lambda only (docs/bifrost-virtual-keys.md decision 3). A copy of bifrost/gateway's BIFROST_SETUP_TOKEN; filled out of band with deploy-workbench/bifrost/fill-secrets.sh."

# Keys a human supplies. Never required by --generated-only, and never taken
# from argv: a value in argv is visible in `ps` and in shell history.
HUMAN_KEYS=(
  OAUTH2_PROXY_CLIENT_ID
  OAUTH2_PROXY_CLIENT_SECRET
  FIREWORKS_API_KEY
  ANTHROPIC_API_KEY
  OPENAI_API_KEY
)
# The plan names Fireworks as the provider. ANTHROPIC_API_KEY and
# OPENAI_API_KEY above are only accepted if a harness needs those direct
# providers later (see "Provider configuration" in the plan), so they are
# never reported as missing.
REQUIRED_KEYS=(
  BIFROST_ENCRYPTION_KEY
  BIFROST_ADMIN_USERNAME
  BIFROST_ADMIN_PASSWORD
  BIFROST_SETUP_TOKEN
  FIREWORKS_API_KEY
  OAUTH2_PROXY_CLIENT_ID
  OAUTH2_PROXY_CLIENT_SECRET
  OAUTH2_PROXY_COOKIE_SECRET
)

MODE=fill
FORCE=0
ROTATE_ENCRYPTION_KEY=0
DRY_RUN=0
ENV_FILE=""

# Only keys set in this run are written, never ones that happen to be in your
# shell's environment.
WRITE_KEYS=()
SUPPLIED=()

usage() {
  sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p}' "$0"
}

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }

die() { echo "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --generated-only) MODE=generated-only ;;
    --check) MODE=check ;;
    --force) FORCE=1 ;;
    --rotate-encryption-key) ROTATE_ENCRYPTION_KEY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --env-file)
      [[ $# -ge 2 ]] || die "--env-file needs a path"
      ENV_FILE="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

if [[ $ROTATE_ENCRYPTION_KEY == 1 && $FORCE == 0 ]]; then
  die "--rotate-encryption-key only applies together with --force."
fi
if [[ -n "$ENV_FILE" && $MODE != fill ]]; then
  die "--env-file is only meaningful when filling (not with --generated-only or --check)."
fi

command -v aws >/dev/null 2>&1 || die "aws CLI not found."
command -v jq >/dev/null 2>&1 || die "jq not found."
command -v openssl >/dev/null 2>&1 || die "openssl not found."

# ---------------------------------------------------------------- environment

account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || {
  echo "No AWS session. Sign in first, then re-run:" >&2
  echo "  aws sso login --profile <profile for the workbench account>" >&2
  exit 1
}
if [[ "$account" != "$ACCOUNT_ID" ]]; then
  echo "This session is in account $account, not the workbench account $ACCOUNT_ID." >&2
  echo "Set AWS_PROFILE to a profile for $ACCOUNT_ID and try again. The Bifrost" >&2
  echo "secrets belong in the workbench account and nowhere else." >&2
  exit 1
fi

configured_region="$(aws configure get region 2>/dev/null || true)"
configured_region="${AWS_REGION:-${configured_region:-}}"
if [[ -z "$configured_region" ]]; then
  echo "No region is configured for this session; using $REGION explicitly."
elif [[ "$configured_region" != "$REGION" ]]; then
  echo "This session's region is $configured_region, not $REGION." >&2
  echo "The Bifrost secrets live in $REGION. Set AWS_REGION=$REGION and try again." >&2
  exit 1
fi

TMP="$(mktemp)"; chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT

# ---------------------------------------------------------------- helpers

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

file_mode() {
  local f="$1"
  if stat -c '%a' "$f" >/dev/null 2>&1; then
    stat -c '%a' "$f"
  else
    stat -f '%Lp' "$f"   # macOS
  fi
}

# A container Pulumi created but never wrote to has no AWSCURRENT version, so
# get-secret-value reports ResourceNotFoundException for it exactly as it does
# for a name that does not exist. describe-secret tells the two apart, which is
# what keeps the first fill from calling create-secret on a name that is
# already there.
secret_exists() {
  local id="$1" err
  err="$(mktemp)"
  if aws secretsmanager describe-secret --secret-id "$id" --region "$REGION" \
      --query ARN --output text >/dev/null 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  if grep -q ResourceNotFoundException "$err"; then
    rm -f "$err"
    return 1
  fi
  cat "$err" >&2
  rm -f "$err"
  die "Could not describe secret $id, so cannot tell whether it exists."
}

# A single JSON object per container. Sets CURRENT and CURRENT_EXISTS; a secret
# Pulumi created with no value, or one that does not exist yet, is `{}`.
fetch_current() {
  local id="$1" err out
  err="$(mktemp)"
  if out="$(aws secretsmanager get-secret-value --secret-id "$id" --region "$REGION" \
      --query SecretString --output text 2>"$err")"; then
    CURRENT_EXISTS=1
  else
    if grep -q ResourceNotFoundException "$err"; then
      # No value, not necessarily no container: an empty container is created
      # by Pulumi (phase 2 item 11) and reports the same error.
      out='{}'
      if secret_exists "$id"; then CURRENT_EXISTS=1; else CURRENT_EXISTS=0; fi
    else
      cat "$err" >&2
      if grep -q AccessDenied "$err"; then
        echo "This session cannot read Secrets Manager in $ACCOUNT_ID." >&2
        echo "WorkbenchAccess deliberately cannot; use an admin session (see the header)." >&2
      fi
      rm -f "$err"
      exit 1
    fi
  fi
  rm -f "$err"
  if [[ -z "$out" || "$out" == "None" ]]; then out='{}'; fi
  jq -e 'type == "object"' <<<"$out" >/dev/null \
    || die "Secret $id does not hold a JSON object; refusing to touch it."
  CURRENT="$out"
}

has_current() { jq -e --arg k "$1" 'has($k)' <<<"$CURRENT" >/dev/null; }

is_supplied() {
  local want="$1" k
  for k in "${SUPPLIED[@]:-}"; do
    [[ "$k" == "$want" ]] && return 0
  done
  return 1
}

gen_secret() { openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n'; }

# Bifrost's first-admin request enforces a password policy. At the pinned tag
# (`transports/v2.3.0`, `getPasswordPolicyFailures`) it is at least 12
# characters with an uppercase letter, a lowercase letter, a digit and a
# special character. `gen_secret`'s base64url alphabet does not reliably carry
# a special character (about a quarter of values have none), so the admin
# password is the random value plus a fixed suffix that supplies every class.
# The entropy is the random prefix; the suffix is not a secret. The claim
# container sends this value in a `PUT /api/config`, which is where the policy
# is enforced, so generating it to policy is what makes the claim automatic.
gen_password() { printf '%sAa1!' "$(gen_secret)"; }

ask() {  # key, prefix, hint, keep_current
  local key="$1" prefix="${2:-}" hint="${3:-}" keep="${4:-0}" value
  while true; do
    printf '%s (%s): ' "$key" "$hint"
    IFS= read -rs value
    echo
    if [[ -z "$value" ]]; then
      if [[ "$keep" == 1 ]]; then echo "  keeping current value"; else echo "  left unset"; fi
      return 0
    fi
    if [[ -n "$prefix" && "$value" != $prefix* ]]; then
      echo "  that doesn't start with '$prefix', try again"
      continue
    fi
    export "$key=$value"
    SUPPLIED+=("$key")
    echo "  ok (${#value} chars)"
    return 0
  done
}

read_env_file() {
  local file="$1" mode line key value
  [[ -f "$file" ]] || die "No such env file: $file"
  mode="$(file_mode "$file")" || die "Could not read the mode of $file."
  if (( 8#$mode & 8#077 )); then
    die "Refusing $file: mode $mode is readable by group or others. Run: chmod 600 $file"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "${line%$'\r'}")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || { echo "  ignoring a line without '=' in $file" >&2; continue; }
    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"
    if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    fi
    case " ${HUMAN_KEYS[*]} " in
      *" $key "*) ;;
      *) echo "  ignoring $key: not a key this script fills" >&2; continue ;;
    esac
    if [[ -z "$value" ]]; then
      echo "  ignoring $key: empty value" >&2
      continue
    fi
    export "$key=$value"
    SUPPLIED+=("$key")
  done < "$file"
  echo "Read ${#SUPPLIED[@]} value(s) from $file (mode $mode)."
}

# Create-if-absent. With --force, regenerate only when $3 is 1.
ensure_generated() {  # key, value, regenerate_on_force
  local key="$1" value="$2" regen="${3:-1}"
  if has_current "$key"; then
    if [[ $FORCE == 1 && "$regen" == 1 ]]; then
      export "$key=$value"
      WRITE_KEYS+=("$key")
      echo "  $key: regenerated (the previous value stops working)"
    else
      echo "  $key: already set, keeping"
    fi
  else
    export "$key=$value"
    WRITE_KEYS+=("$key")
    echo "  $key: generated"
  fi
}

# Fill the human-supplied keys for the container in $CURRENT. A key that is
# already present is kept unless --force; a key with no value is left absent,
# never written empty.
collect_human() {
  local key hint current_value
  for key in "$@"; do
    if has_current "$key" && [[ $FORCE == 0 ]]; then
      echo "  $key: already set, keeping"
      continue
    fi
    if has_current "$key"; then
      hint="paste, Enter to keep current"
    else
      hint="paste, Enter to skip"
    fi
    if [[ -n "$ENV_FILE" ]]; then
      if is_supplied "$key"; then
        current_value="${!key}"
        WRITE_KEYS+=("$key")
        echo "  $key: read from $ENV_FILE (${#current_value} chars)"
      elif has_current "$key"; then
        echo "  $key: not in $ENV_FILE, already set, keeping"
      else
        echo "  $key: not in $ENV_FILE, left unset"
      fi
    else
      if has_current "$key"; then ask "$key" "" "$hint" 1; else ask "$key" "" "$hint" 0; fi
      # ask() records the value in SUPPLIED; commit() writes WRITE_KEYS. The
      # env-file branch above enqueues it itself, and so must this one, or a
      # prompted value is confirmed and then dropped.
      if is_supplied "$key"; then WRITE_KEYS+=("$key"); fi
    fi
  done
}

commit() {  # secret id, description
  local id="$1" description="$2" json key
  if [[ ${#WRITE_KEYS[@]} -eq 0 ]]; then
    echo "  nothing to write"
    unset CURRENT
    return 0
  fi
  json="$(jq 'reduce $ARGS.positional[] as $k (.; .[$k] = env[$k])' \
    --args "${WRITE_KEYS[@]}" <<<"$CURRENT")"
  if [[ $DRY_RUN == 1 ]]; then
    echo "  dry run: would write ${WRITE_KEYS[*]} to $id"
    for key in "${WRITE_KEYS[@]}"; do unset "$key" || true; done
    unset CURRENT
    return 0
  fi
  printf '%s' "$json" > "$TMP"
  if [[ $CURRENT_EXISTS == 1 ]]; then
    aws secretsmanager put-secret-value --secret-id "$id" --region "$REGION" \
      --secret-string "file://$TMP" --query VersionId --output text >/dev/null
  else
    aws secretsmanager create-secret --name "$id" --description "$description" \
      --region "$REGION" --secret-string "file://$TMP" \
      --query ARN --output text >/dev/null
  fi
  echo "  wrote to $id: ${WRITE_KEYS[*]}"
  for key in "${WRITE_KEYS[@]}"; do unset "$key" || true; done
  unset CURRENT
}

# Names only. Never a value, never a length.
report() {  # returns 1 if a container is missing
  local id key missing=0 unset_keys=() oauth_have=0
  local vmint_json vmint_exists gateway_token mint_token
  for id in "$GATEWAY_SECRET" "$OAUTH_SECRET" "$VK_MINT_SECRET"; do
    bold "$id"
    fetch_current "$id"
    if [[ $CURRENT_EXISTS == 0 ]]; then
      echo "  (does not exist)"
      missing=1
      continue
    fi
    if [[ "$(jq 'keys | length' <<<"$CURRENT")" == 0 ]]; then
      echo "  (no keys)"
    else
      jq -r 'keys[]' <<<"$CURRENT" | sed 's/^/  /'
    fi
  done

  local gateway_json oauth_json gateway_exists oauth_exists
  fetch_current "$GATEWAY_SECRET"
  gateway_json="$CURRENT"; gateway_exists="$CURRENT_EXISTS"
  fetch_current "$OAUTH_SECRET"
  oauth_json="$CURRENT"; oauth_exists="$CURRENT_EXISTS"
  fetch_current "$VK_MINT_SECRET"
  vmint_json="$CURRENT"; vmint_exists="$CURRENT_EXISTS"

  for key in "${REQUIRED_KEYS[@]}"; do
    case "$key" in
      OAUTH2_PROXY_*)
        if [[ $oauth_exists == 1 ]] && jq -e --arg k "$key" 'has($k)' <<<"$oauth_json" >/dev/null; then
          continue
        fi
        ;;
      *)
        if [[ $gateway_exists == 1 ]] && jq -e --arg k "$key" 'has($k)' <<<"$gateway_json" >/dev/null; then
          continue
        fi
        ;;
    esac
    unset_keys+=("$key")
  done

  echo
  if [[ ${#unset_keys[@]} -gt 0 ]]; then
    echo "Still unset (${#unset_keys[@]}): ${unset_keys[*]}"
  else
    echo "Every required key is present."
  fi

  # The mint's token must be the gateway's own, or the gateway refuses it as a
  # wrong setup token, a failure that only shows up on the first mint. The
  # values are compared in memory and never printed.
  if [[ $vmint_exists == 0 ]]; then
    echo "bifrost/vk-mint does not exist: the vk-mint Lambda has no setup token."
    missing=1
  else
    gateway_token="$(jq -r '.BIFROST_SETUP_TOKEN // empty' <<<"$gateway_json")"
    mint_token="$(jq -r '.BIFROST_SETUP_TOKEN // empty' <<<"$vmint_json")"
    if [[ -z "$mint_token" ]]; then
      echo "bifrost/vk-mint has no BIFROST_SETUP_TOKEN: the vk-mint Lambda will fail closed."
      missing=1
    elif [[ -n "$gateway_token" && "$mint_token" != "$gateway_token" ]]; then
      echo "bifrost/vk-mint's setup token differs from the gateway's; the gateway will refuse it."
      echo "Re-run with --generated-only to copy the gateway's token across."
      missing=1
    fi
  fi

  if [[ $oauth_exists == 1 ]]; then
    for key in OAUTH2_PROXY_CLIENT_ID OAUTH2_PROXY_CLIENT_SECRET OAUTH2_PROXY_COOKIE_SECRET; do
      if jq -e --arg k "$key" 'has($k)' <<<"$oauth_json" >/dev/null; then
        oauth_have=$((oauth_have + 1))
      fi
    done
    if [[ $oauth_have -ne 0 && $oauth_have -ne 3 ]]; then
      echo "oauth2-proxy has $oauth_have of 3 credentials. The task definition (phase 1"
      echo "item 9) must carry all three or none, so the admin surface stays off until"
      echo "the Google pair is filled."
    fi
  fi

  unset CURRENT
  if [[ $missing == 1 ]]; then return 1; fi
  return 0
}

# ---------------------------------------------------------------- main

if [[ $MODE == check ]]; then
  bold "Bifrost secrets in $ACCOUNT_ID ($REGION)"
  if report; then exit 0; else exit 2; fi
fi

if [[ $MODE == fill ]]; then
  if [[ -n "$ENV_FILE" ]]; then
    read_env_file "$ENV_FILE"
  elif [[ ! -t 0 ]]; then
    die "No terminal to prompt on. Use --env-file FILE (mode 600), or --generated-only to fill only the generated keys."
  fi
fi

bold "1/3  $GATEWAY_SECRET"
fetch_current "$GATEWAY_SECRET"
if [[ $CURRENT_EXISTS == 1 ]]; then
  echo "  container exists"
else
  echo "  container does not exist; it will be created"
fi
WRITE_KEYS=()

# 32 bytes, urlsafe base64. The single most important secret here: losing it
# means re-entering every provider key stored in the config store.
if has_current BIFROST_ENCRYPTION_KEY; then
  if [[ $FORCE == 1 && $ROTATE_ENCRYPTION_KEY == 1 ]]; then
    ensure_generated BIFROST_ENCRYPTION_KEY "$(gen_secret)" 1
    echo "  ^ rotating BIFROST_ENCRYPTION_KEY invalidates every provider key already" >&2
    echo "    stored in the config store; re-enter them after this run." >&2
  else
    echo "  BIFROST_ENCRYPTION_KEY: already set, keeping (rotation needs --force --rotate-encryption-key)"
  fi
else
  ensure_generated BIFROST_ENCRYPTION_KEY "$(gen_secret)" 1
fi

if has_current BIFROST_ADMIN_USERNAME; then
  echo "  BIFROST_ADMIN_USERNAME: already set, keeping"
else
  export BIFROST_ADMIN_USERNAME="$ADMIN_USERNAME"
  WRITE_KEYS+=("BIFROST_ADMIN_USERNAME")
  echo "  BIFROST_ADMIN_USERNAME: set to $ADMIN_USERNAME (safe to print; the password is not)"
fi

ensure_generated BIFROST_ADMIN_PASSWORD "$(gen_password)" 1

# The bootstrap secret a fresh deployment is claimed with, generated here and
# only ever read back from Secrets Manager. Stored rather than generated per
# process, which upstream warns against: every node has to read the identical
# value from its own config/env. It is kept for three reasons:
#
# - Nothing can be claimed without it. `CheckBootstrapToken` fails closed, so an
#   instance with no admin account and no setup token has an /api surface
#   nobody can finish setting up.
# - Restore. A rebuilt task against an empty config store has no admin account,
#   so a token nobody retained is a gateway nobody can administer. That is why
#   this value survives setup instead of being deleted once auth is on.
# - `auth_config` changes made while dashboard auth is disabled need it as the
#   operator's proof of control (`CheckConfiguredSetupToken`). Dashboard auth is
#   disabled in this deployment, so this is the live one: the OSS setup lock
#   requires the token on every non-public `/api` call, the sidecar presents it
#   from this secret, and anything scripted against the management API has to
#   send `X-Bifrost-Setup-Token` itself -- `POST /api/session/login` answers
#   403 while auth is off.
#
# It is not a bearer token for inference. Once dashboard auth is active
# `APIMiddleware` never consults it, `ClearBootstrapToken` nils the first-admin
# half after the first admin account exists, and the token's only role is the
# proof of operator control for later `auth_config` changes.
#
# Same idempotency as the admin password: generated when absent, kept when
# already set, and regenerated by `--force`, which is deliberate and leaves the
# new value in Secrets Manager by the end of the run.
ensure_generated BIFROST_SETUP_TOKEN "$(gen_secret)" 1

# The value this run leaves in $GATEWAY_SECRET, captured before commit()
# unsets the variables: the mint's copy has to be exactly this string.
#
# Which value depends on whether this run writes the key, not on whether the
# variable happens to be set: `ensure_generated` exports BIFROST_SETUP_TOKEN
# only when it is creating or (`--force`) regenerating it, and $CURRENT is
# stale after that — it is assigned only inside `fetch_current`. So a rewritten
# token comes from the variable (which is the generated one, never an ambient
# one: `ensure_generated` overwrites it), and a kept token comes from $CURRENT.
# Reading $CURRENT first is wrong on `--force`; reading the variable first
# unconditionally is wrong because it trusts the operator's shell.
gateway_token_rewritten=0
for key in "${WRITE_KEYS[@]:-}"; do
  if [[ "$key" == "BIFROST_SETUP_TOKEN" ]]; then gateway_token_rewritten=1; fi
done
if [[ $gateway_token_rewritten == 1 ]]; then
  gateway_setup_token="${BIFROST_SETUP_TOKEN:-}"
else
  gateway_setup_token="$(jq -r '.BIFROST_SETUP_TOKEN // empty' <<<"$CURRENT")"
fi

# Whether this run rewrote the gateway's token. If it did, bifrost/vk-mint must
# follow it whatever --force says, or the mint starts sending a token the
# gateway no longer accepts. Computed above, beside the value it selects.

if [[ $MODE == fill ]]; then
  collect_human FIREWORKS_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
else
  echo "  FIREWORKS_API_KEY: skipped (--generated-only)"
fi

commit "$GATEWAY_SECRET" "$GATEWAY_DESCRIPTION"

bold "2/3  $OAUTH_SECRET"
fetch_current "$OAUTH_SECRET"
if [[ $CURRENT_EXISTS == 1 ]]; then
  echo "  container exists"
else
  echo "  container does not exist; it will be created"
fi
WRITE_KEYS=()

# 32 bytes, base64url, the same shape agent-swarm generates. Rotating it signs
# everyone out of the admin surface once.
ensure_generated OAUTH2_PROXY_COOKIE_SECRET "$(gen_secret)" 1

if [[ $MODE == fill ]]; then
  collect_human OAUTH2_PROXY_CLIENT_ID OAUTH2_PROXY_CLIENT_SECRET
else
  echo "  OAUTH2_PROXY_CLIENT_ID: skipped (--generated-only)"
  echo "  OAUTH2_PROXY_CLIENT_SECRET: skipped (--generated-only)"
fi

commit "$OAUTH_SECRET" "$OAUTH_DESCRIPTION"

bold "3/3  $VK_MINT_SECRET"
fetch_current "$VK_MINT_SECRET"
if [[ $CURRENT_EXISTS == 1 ]]; then
  echo "  container exists"
else
  echo "  container does not exist; it will be created"
fi
WRITE_KEYS=()

if [[ -z "$gateway_setup_token" ]]; then
  echo "  BIFROST_SETUP_TOKEN: $GATEWAY_SECRET has no token yet, so there is nothing to copy"
else
  existing_token="$(jq -r '.BIFROST_SETUP_TOKEN // empty' <<<"$CURRENT")"
  if [[ "$existing_token" == "$gateway_setup_token" ]]; then
    echo "  BIFROST_SETUP_TOKEN: already matches the gateway's, keeping"
  else
    # A copy that differs from the token this run leaves in $GATEWAY_SECRET is
    # stale, and overwriting it is safe: the gateway's own value is not changing,
    # so nothing needs rotating. `--force` is *not* the repair -- it regenerates
    # BIFROST_ADMIN_PASSWORD, BIFROST_SETUP_TOKEN and OAUTH2_PROXY_COOKIE_SECRET,
    # signing everyone out of the admin UI and rotating the gateway's token out
    # from under the running task, which keeps the old one until it is redeployed
    # -- and the fresh copy then gives the mint a token the gateway refuses. A
    # plain re-run (or --generated-only) is the repair, and it copies without
    # touching anything else. That is why this branch has no $FORCE condition.
    export BIFROST_SETUP_TOKEN="$gateway_setup_token"
    WRITE_KEYS+=("BIFROST_SETUP_TOKEN")
    if [[ $gateway_token_rewritten == 1 ]]; then
      echo "  BIFROST_SETUP_TOKEN: copied from $GATEWAY_SECRET (which this run rewrote)"
    elif [[ -n "$existing_token" ]]; then
      echo "  BIFROST_SETUP_TOKEN: replaced the stale copy with $GATEWAY_SECRET's"
    else
      echo "  BIFROST_SETUP_TOKEN: copied from $GATEWAY_SECRET"
    fi
    commit "$VK_MINT_SECRET" "$VK_MINT_DESCRIPTION"
  fi
fi

bold "Result"
if report; then
  :
fi

echo
if [[ $MODE == generated-only ]]; then
  echo "Generated pass done. The Google pair and the provider keys are the two"
  echo "remaining human steps. Fill them with no arguments (prompts) or:"
  echo "  $0 --env-file ~/.bifrost-secrets.env"
else
  echo "Done. Re-run with --check at any time to see key names (never values)."
fi
