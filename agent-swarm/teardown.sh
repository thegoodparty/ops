#!/bin/bash
set -euo pipefail

# Removes everything deploy.sh created, in reverse dependency order.
#
# The S3 bucket is the one exception: it holds the incident history -- the
# Litestream snapshots of the swarm database and the deploy tarballs -- and that
# record is the only thing here that cannot be recreated by re-running deploy.sh.
# It is retained unless --purge-bucket is passed.

export AWS_PAGER=""

ACCOUNT_ID="333022194791"
DEFAULT_REGION="us-west-2"
HOSTED_ZONE_ID="Z10392302OXMPNQLPO07K"
HOSTNAME="agent-swarm.goodparty.org"

BUCKET="agent-swarm-prod"
NAME_TAG="agent-swarm"
VPC_ID="vpc-0763fa52c32ebcf6a"

ALB_NAME="agent-swarm"
ALB_SG_NAME="agent-swarm-alb"
HOST_SG_NAME="agent-swarm-host"
API_TG_NAME="agent-swarm-api"
HOOK_TG_NAME="agent-swarm-hook"

ROLE_NAME="agent-swarm-instance-role"
PROFILE_NAME="agent-swarm-instance-profile"
LOG_GROUP="/aws/ec2/agent-swarm"

log() { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
skip() { printf '    skip: %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: teardown.sh --yes [--profile NAME] [--region REGION] [--purge-bucket]

Removes the agent-swarm host, its load balancer, DNS, IAM and security groups.

  --yes            Required. Confirms the destructive run.
  --profile NAME   AWS CLI profile to use (default: $AWS_PROFILE)
  --region REGION  AWS region (default: us-west-2)
  --purge-bucket   Also delete s3://agent-swarm-prod, including every version.
                   This destroys the incident history and cannot be undone.
EOF
}

PROFILE=""
REGION="$DEFAULT_REGION"
CONFIRMED=false
PURGE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) CONFIRMED=true; shift ;;
    --purge-bucket) PURGE=true; shift ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --region=*) REGION="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

AWS=(aws --region "$REGION")
if [ -n "$PROFILE" ]; then
  AWS+=(--profile "$PROFILE")
fi

# Destructive and irreversible, so it takes an explicit flag rather than a
# prompt: a prompt is answered by reflex, and a flag is visible in shell history
# and in whatever script called this.
if [ "$CONFIRMED" != "true" ]; then
  usage >&2
  die "refusing to tear down without --yes"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CALLER_ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
if [ "$CALLER_ACCOUNT" != "$ACCOUNT_ID" ]; then
  die "pointed at account $CALLER_ACCOUNT, expected $ACCOUNT_ID. Pass --profile for the right one."
fi

if [ "$PURGE" = "true" ]; then
  printf '\n'
  printf 'WARNING: --purge-bucket deletes s3://%s in full.\n' "$BUCKET"
  printf 'That bucket holds the incident history: the Litestream snapshots of the\n'
  printf 'swarm database and every deploy tarball. Destroying it destroys the record,\n'
  printf 'and nothing here can rebuild it.\n'
  printf '\n'
fi

# ---------------------------------------------------------------------------
# Instance first: it is the only thing holding state, and everything below it
# (target groups, DNS, security groups) still works while it drains.
# ---------------------------------------------------------------------------

log "Instance"
INSTANCE_IDS="$("${AWS[@]}" ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME_TAG" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)"
if [ -n "$INSTANCE_IDS" ] && [ "$INSTANCE_IDS" != "None" ]; then
  "${AWS[@]}" ec2 terminate-instances --instance-ids $INSTANCE_IDS >/dev/null
  info "terminating: $INSTANCE_IDS"
  # Termination also releases the root volume, which is delete-on-termination.
  "${AWS[@]}" ec2 wait instance-terminated --instance-ids $INSTANCE_IDS
  info "terminated"
else
  skip "no instance tagged Name=$NAME_TAG"
fi

# ---------------------------------------------------------------------------
# DNS, then the ALB and everything attached to it.
# ---------------------------------------------------------------------------

log "DNS record $HOSTNAME"
RECORD="$("${AWS[@]}" route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
  --query "ResourceRecordSets[?Name=='${HOSTNAME}.']" --output json 2>/dev/null || true)"
if [ "$RECORD" != "[]" ] && [ -n "$RECORD" ]; then
  # The DELETE action must carry the record exactly as it exists, so it is read
  # back and echoed rather than reconstructed from the ALB.
  python3 -c '
import json, sys
records = json.loads(sys.stdin.read())
change = {"Comment": "teardown", "Changes": [{"Action": "DELETE", "ResourceRecordSet": records[0]}]}
open(sys.argv[1], "w").write(json.dumps(change))
' "$TMP/dns-delete.json" <<<"$RECORD"
  "${AWS[@]}" route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "file://$TMP/dns-delete.json" >/dev/null
  info "deleted A alias $HOSTNAME"
else
  skip "no A record for $HOSTNAME"
fi

log "Load balancer $ALB_NAME"
ALB_ARN="$("${AWS[@]}" elbv2 describe-load-balancers --names "$ALB_NAME" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)"
if [ -n "$ALB_ARN" ] && [ "$ALB_ARN" != "None" ]; then
  # Rules and the listener go with the load balancer, so only the rules that
  # would otherwise block a re-create are named explicitly.
  LISTENER_ARNS="$("${AWS[@]}" elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
    --query 'Listeners[].ListenerArn' --output text 2>/dev/null || true)"
  for listener in $LISTENER_ARNS; do
    for priority in 5 6; do
      rule_arn="$("${AWS[@]}" elbv2 describe-rules --listener-arn "$listener" \
        --query "Rules[?Priority=='$priority'].RuleArn | [0]" --output text 2>/dev/null || true)"
      if [ -n "$rule_arn" ] && [ "$rule_arn" != "None" ]; then
        "${AWS[@]}" elbv2 delete-rule --rule-arn "$rule_arn" >/dev/null
        info "deleted rule priority $priority"
      fi
    done
    "${AWS[@]}" elbv2 delete-listener --listener-arn "$listener" >/dev/null
    info "deleted listener $listener"
  done
  "${AWS[@]}" elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN" >/dev/null
  # No waiter here: there is no "deleted" waiter, and the ALB releases its ENIs
  # asynchronously, which is the only thing the target group deletion below
  # actually waits on.
  info "deleting load balancer (waits for it to release its ENIs)"
  for _ in $(seq 1 60); do
    if ! "${AWS[@]}" elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done
  info "load balancer gone"
else
  skip "no load balancer named $ALB_NAME"
fi

log "Target groups"
for tg in "$API_TG_NAME" "$HOOK_TG_NAME"; do
  TG_ARN="$("${AWS[@]}" elbv2 describe-target-groups --names "$tg" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
  if [ -n "$TG_ARN" ] && [ "$TG_ARN" != "None" ]; then
    # The ALB must be fully gone first, or this fails with ResourceInUse.
    "${AWS[@]}" elbv2 delete-target-group --target-group-arn "$TG_ARN" >/dev/null
    info "deleted target group $tg"
  else
    skip "no target group named $tg"
  fi
done

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------

log "Instance profile $PROFILE_NAME"
if "${AWS[@]}" iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  "${AWS[@]}" iam remove-role-from-instance-profile --instance-profile-name "$PROFILE_NAME" \
    --role-name "$ROLE_NAME" >/dev/null 2>&1 || true
  "${AWS[@]}" iam delete-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
  info "deleted instance profile"
else
  skip "no instance profile named $PROFILE_NAME"
fi

log "Role $ROLE_NAME"
if "${AWS[@]}" iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  "${AWS[@]}" iam detach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" >/dev/null 2>&1 || true
  "${AWS[@]}" iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "inline" >/dev/null 2>&1 || true
  "${AWS[@]}" iam delete-role --role-name "$ROLE_NAME" >/dev/null
  info "deleted role"
else
  skip "no role named $ROLE_NAME"
fi

# ---------------------------------------------------------------------------
# Security groups, after the ALB that references the ALB group.
# ---------------------------------------------------------------------------

log "Security groups"
delete_sg() {
  local name="$1"
  local sg
  sg="$("${AWS[@]}" ec2 describe-security-groups \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$name" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
  if [ -n "$sg" ] && [ "$sg" != "None" ]; then
    if "${AWS[@]}" ec2 delete-security-group --group-id "$sg" >/dev/null 2>&1; then
      info "deleted $name ($sg)"
    else
      info "could not delete $name ($sg) yet -- a dependent ENI is probably still releasing; re-run in a minute"
    fi
  else
    skip "no security group named $name"
  fi
}
delete_sg "$HOST_SG_NAME"
delete_sg "$ALB_SG_NAME"

# ---------------------------------------------------------------------------
# Log group
# ---------------------------------------------------------------------------

log "Log group $LOG_GROUP"
EXISTING_LOG_GROUP="$("${AWS[@]}" logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" \
  --query "logGroups[?logGroupName=='$LOG_GROUP'].logGroupName" --output text 2>/dev/null || true)"
if [ "$EXISTING_LOG_GROUP" = "$LOG_GROUP" ]; then
  "${AWS[@]}" logs delete-log-group --log-group-name "$LOG_GROUP" >/dev/null
  info "deleted $LOG_GROUP"
else
  skip "no log group $LOG_GROUP"
fi

# ---------------------------------------------------------------------------
# Bucket
# ---------------------------------------------------------------------------

log "Bucket $BUCKET"
if [ "$PURGE" != "true" ]; then
  info "retained (holds the incident history)"
  info "to destroy it: teardown.sh --yes --purge-bucket"
else
  if ! "${AWS[@]}" s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
    skip "no bucket named $BUCKET"
  else
    # A versioned bucket cannot be removed with `s3 rb`; every version and
    # delete marker has to go first, in batches, until the listing is empty.
    while :; do
      listing="$("${AWS[@]}" s3api list-object-versions --bucket "$BUCKET" \
        --max-keys 1000 --output json)"
      count="$(python3 -c '
import json, sys
d = json.load(sys.stdin)
objs = [{"Key": o["Key"], "VersionId": o["VersionId"]} for o in d.get("Versions", [])]
objs += [{"Key": o["Key"], "VersionId": o["VersionId"]} for o in d.get("DeleteMarkers", [])]
json.dump({"Objects": objs, "Quiet": True}, open(sys.argv[1], "w"))
print(len(objs))
' "$TMP/delete-objects.json" <<<"$listing")"
      if [ "$count" -eq 0 ]; then
        break
      fi
      "${AWS[@]}" s3api delete-objects --bucket "$BUCKET" \
        --delete "file://$TMP/delete-objects.json" >/dev/null
      info "deleted $count object versions"
    done
    "${AWS[@]}" s3api delete-bucket --bucket "$BUCKET"
    info "deleted bucket $BUCKET"
  fi
fi

printf '\n'
log "teardown complete"
