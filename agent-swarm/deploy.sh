#!/bin/bash
set -euo pipefail

# Creates the agent-swarm host and its edge, then pushes the stack to it over
# SSM. Idempotent: every step is create-or-update, so a re-run after a partial
# failure finishes the job rather than colliding with it.
#
# This is a personal playground, not the incident system. It is deliberately
# not wired into Pulumi or CI, and it shares nothing with BugBoss except the
# account and the certificate -- in particular it does NOT add rules to
# BugBoss's ALB, because that ALB carries live alert ingest and a mistake here
# would be a mistake there.

export AWS_PAGER=""

ACCOUNT_ID="333022194791"
DEFAULT_REGION="us-west-2"
VPC_ID="vpc-0763fa52c32ebcf6a"
SUBNETS=(subnet-07984b965dabfdedc subnet-01c540e6428cdd8db)
HOSTED_ZONE_ID="Z10392302OXMPNQLPO07K"
HOSTNAME="agent-swarm.goodparty.org"

BUCKET="agent-swarm-prod"
SECRET_NAME="AGENT_SWARM"

# Sized for the whole stack on one host, not for one container: the API is light,
# the lead mostly waits on model calls, and the two coders burst when a build or
# a test suite runs. Work here is I/O bound, so vCPU is rarely the constraint and
# memory is the thing to keep room in. Upstream publishes no host size, only
# per-container requests (its minimal two-pool example asks for 750m and 1.5 GiB),
# so this is a judgement with headroom rather than a recommendation to honour.
#
# AMD rather than Intel because it is materially cheaper for the same shape, and
# x86 rather than Graviton because both swarm images are built for linux/amd64
# only: on an arm64 host they would run under emulation, which is slow and
# occasionally wrong.
INSTANCE_TYPE="m6a.xlarge"
ROOT_VOLUME_GIB=100
NAME_TAG="agent-swarm"

ALB_NAME="agent-swarm"
ALB_SG_NAME="agent-swarm-alb"
HOST_SG_NAME="agent-swarm-host"
API_TG_NAME="agent-swarm-api"
HOOK_TG_NAME="agent-swarm-hook"
API_PORT=3013
HOOK_PORT=3014

ROLE_NAME="agent-swarm-instance-role"
PROFILE_NAME="agent-swarm-instance-profile"

# The host's own log group. Docker's awslogs driver does not create one, and a
# missing group is a container that starts and logs nowhere, so this script
# creates it up front rather than leaving it to the stack.
LOG_GROUP="/aws/ec2/agent-swarm"

# `Environment: infra` is a protection, not a label -- exactly as in
# deploy/components/bugboss.ts. EngineerAccess grants every engineer
# `Action: ["*"]` on anything tagged `Environment: dev`, so tagging this host
# `dev` would hand the whole engineering org root on a box that holds an
# Anthropic key and a GitHub token. The tag spellings live in RESOURCE_TAGS and
# TAG_MAP below, next to the two shorthand forms AWS asks for.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$SCRIPT_DIR"

# Progress goes to stderr so that helpers whose stdout is captured (a target
# group ARN, a security group id) return only the value.
log() { printf '==> %s\n' "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
report() { printf '  %-8s %s\n' "$1" "$2" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ec2's --tag-specifications wants Tag structs, not the flat map other services
# take, so this keeps the two tags spelled once and identically everywhere.
#
# Project is `bugboss-swarm` rather than `agent-swarm` on purpose: this is the
# second system doing BugBoss's job, and naming it that way is what makes its
# spend separable from BugBoss's in Cost Explorer when both are running.
RESOURCE_TAGS='{Key=Environment,Value=infra},{Key=Project,Value=bugboss-swarm}'
# The flat-map form the same two tags take on iam, elbv2 and logs.
TAG_MAP=("Key=Environment,Value=infra" "Key=Project,Value=bugboss-swarm")

usage() {
  cat <<'EOF'
Usage: deploy.sh [--profile NAME] [--region REGION] [--instance-type TYPE] [--disk-size GIB]

Creates or updates the agent-swarm host, its load balancer and DNS, and then
deploys the stack in this directory to it over SSM.

  --profile NAME       AWS CLI profile to use (default: $AWS_PROFILE)
  --region REGION      AWS region (default: us-west-2)
  --instance-type TYPE EC2 instance type (default: m6a.xlarge, 4 vCPU / 16 GiB)
  --disk-size GIB      Root volume size (default: 100)

Only an existing instance's type is left alone: this refuses to resize a running
host, because that is a stop/start that would interrupt a live incident.
EOF
}

PROFILE=""
REGION="$DEFAULT_REGION"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --region=*) REGION="${1#*=}"; shift ;;
    --instance-type) INSTANCE_TYPE="${2:-}"; shift 2 ;;
    --instance-type=*) INSTANCE_TYPE="${1#*=}"; shift ;;
    --disk-size) ROOT_VOLUME_GIB="${2:-}"; shift 2 ;;
    --disk-size=*) ROOT_VOLUME_GIB="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

AWS=(aws --region "$REGION")
if [ -n "$PROFILE" ]; then
  AWS+=(--profile "$PROFILE")
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

log "Checking caller identity"
CALLER_ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
if [ "$CALLER_ACCOUNT" != "$ACCOUNT_ID" ]; then
  die "pointed at account $CALLER_ACCOUNT, expected $ACCOUNT_ID. Pass --profile for the right one."
fi
info "account $CALLER_ACCOUNT, region $REGION"

# The secret is created and populated by hand -- see docs/secrets.md in omni.
# Nothing here creates it: the account's secret store is clickops, and a stack
# that owned this secret would tie rotating a credential to running a deploy.
log "Checking secret $SECRET_NAME"
if ! SECRET_ARN="$("${AWS[@]}" secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text 2>/dev/null)"; then
  die "secret $SECRET_NAME does not exist. Create it by hand in Secrets Manager with a JSON object holding: ANTHROPIC_API_KEY, API_KEY, SECRETS_ENCRYPTION_KEY, GRAFANA_WEBHOOK_SECRET, GRAFANA_BASIC_AUTH_PASSWORD, GRAFANA_SERVICE_ACCOUNT_TOKEN, GITHUB_TOKEN, SWARM_INCIDENT_CHANNEL, SLACK_BOT_TOKEN, SLACK_APP_TOKEN -- then re-run."
fi
# The keys are checked now because the failure mode otherwise is a host that
# boots, renders a half-empty .env and reports healthy while missing a token.
# Only the names are ever printed, never a value.
#
# Slack is split out from the rest on purpose. Without a model credential or the
# control-plane key nothing works, so those stop the deploy. Without Slack the
# stack still serves its API and can be driven by hand; treating that as fatal
# would mean the host cannot come up and warm its image cache until a person has
# finished installing an app, which is the slowest part of the whole setup.
SECRET_CHECK="$("${AWS[@]}" secretsmanager get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text | python3 -c '
import json, sys

required = [
    "ANTHROPIC_API_KEY", "API_KEY", "SECRETS_ENCRYPTION_KEY",
    "GRAFANA_WEBHOOK_SECRET", "GRAFANA_BASIC_AUTH_PASSWORD",
    "GRAFANA_SERVICE_ACCOUNT_TOKEN", "GITHUB_TOKEN",
]
slack = ["SWARM_INCIDENT_CHANNEL", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]

try:
    d = json.load(sys.stdin)
except ValueError as e:
    print("INVALID " + str(e))
    sys.exit(0)
if not isinstance(d, dict):
    print("INVALID not a JSON object")
    sys.exit(0)
print("MISSING " + " ".join(k for k in required if not d.get(k)))
print("SLACK " + " ".join(k for k in slack if not d.get(k)))
' || true)"

if [ -z "$SECRET_CHECK" ]; then
  die "could not read the value of $SECRET_NAME; check the secret's resource policy and your permissions."
fi
INVALID_MSG="$(printf '%s\n' "$SECRET_CHECK" | sed -n 's/^INVALID //p')"
MISSING_REQUIRED="$(printf '%s\n' "$SECRET_CHECK" | sed -n 's/^MISSING //p')"
MISSING_SLACK="$(printf '%s\n' "$SECRET_CHECK" | sed -n 's/^SLACK //p')"
if [ -n "$INVALID_MSG" ]; then
  die "secret $SECRET_NAME is not a JSON object ($INVALID_MSG). Rewrite it as a JSON object."
fi
if [ -n "$MISSING_REQUIRED" ]; then
  die "secret $SECRET_NAME is missing these keys: $MISSING_REQUIRED. Add them before deploying."
fi
if [ -n "$MISSING_SLACK" ]; then
  log "WARNING: $SECRET_NAME is missing $MISSING_SLACK"
  info "the stack will come up and serve its API, but it cannot report to Slack"
  info "until the app is installed and those three values are added and re-deployed"
fi
info "secret present with every key the stack needs to boot"

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

find_sg() {
  "${AWS[@]}" ec2 describe-security-groups \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$1" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null
}

# Adding a rule that already exists fails with InvalidPermission.Duplicate, and
# that is the only failure these treat as fine. Everything else propagates.
authorize_ingress_cidr() {
  local sg="$1" port="$2" cidr="$3"
  local perms="[{\"IpProtocol\":\"tcp\",\"FromPort\":$port,\"ToPort\":$port,\"IpRanges\":[{\"CidrIp\":\"$cidr\"}]}]"
  if "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions "$perms" >/dev/null 2>&1; then
    report created "ingress $port/tcp from $cidr on $sg"
  else
    report found "ingress $port/tcp from $cidr on $sg"
  fi
}

# A version-independent way to say "from that security group": the CLI shortcut
# for this has changed spelling across releases, and --ip-permissions is the
# documented shape both accept.
authorize_ingress_sg() {
  local sg="$1" port="$2" source="$3"
  local perms="[{\"IpProtocol\":\"tcp\",\"FromPort\":$port,\"ToPort\":$port,\"UserIdGroupPairs\":[{\"GroupId\":\"$source\"}]}]"
  if "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions "$perms" >/dev/null 2>&1; then
    report created "ingress $port/tcp from $source on $sg"
  else
    report found "ingress $port/tcp from $source on $sg"
  fi
}

authorize_egress_all() {
  local sg="$1"
  local perms='[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]'
  if "${AWS[@]}" ec2 authorize-security-group-egress --group-id "$sg" --ip-permissions "$perms" >/dev/null 2>&1; then
    report created "unrestricted egress on $sg"
  else
    report found "unrestricted egress on $sg"
  fi
}

log "Security groups"
ALB_SG="$(find_sg "$ALB_SG_NAME")"
if [ -z "$ALB_SG" ] || [ "$ALB_SG" = "None" ]; then
  ALB_SG="$("${AWS[@]}" ec2 create-security-group \
    --group-name "$ALB_SG_NAME" \
    --description "Public HTTPS ingress to the agent-swarm ALB" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$ALB_SG_NAME},$RESOURCE_TAGS]" \
    --query GroupId --output text)"
  report created "$ALB_SG_NAME ($ALB_SG)"
else
  report found "$ALB_SG_NAME ($ALB_SG)"
fi
# A found resource keeps whatever tags it already had, and no modify call can
# change them, so enforcement has to be its own step or a resource created
# before a tag change keeps the old value forever.
"${AWS[@]}" ec2 create-tags --resources "$ALB_SG" --tags "${TAG_MAP[@]}" >/dev/null
authorize_ingress_cidr "$ALB_SG" 443 0.0.0.0/0
authorize_egress_all "$ALB_SG"

HOST_SG="$(find_sg "$HOST_SG_NAME")"
if [ -z "$HOST_SG" ] || [ "$HOST_SG" = "None" ]; then
  HOST_SG="$("${AWS[@]}" ec2 create-security-group \
    --group-name "$HOST_SG_NAME" \
    --description "agent-swarm host: ALB ingress on 3013/3014, unrestricted egress" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$HOST_SG_NAME},$RESOURCE_TAGS]" \
    --query GroupId --output text)"
  report created "$HOST_SG_NAME ($HOST_SG)"
else
  report found "$HOST_SG_NAME ($HOST_SG)"
fi
"${AWS[@]}" ec2 create-tags --resources "$HOST_SG" --tags "${TAG_MAP[@]}" >/dev/null
# Only the ALB may reach the containers. They publish to the host's network, so
# a wider rule would put an unauthenticated API on the internet twice over.
authorize_ingress_sg "$HOST_SG" "$API_PORT" "$ALB_SG"
authorize_ingress_sg "$HOST_SG" "$HOOK_PORT" "$ALB_SG"
# Unrestricted egress: the host pulls images, clones repos, and calls Anthropic,
# Slack and Grafana. There is no NAT here, so the instance also needs a public
# address (set below) to reach any of them.
authorize_egress_all "$HOST_SG"

# ---------------------------------------------------------------------------
# IAM role and instance profile
# ---------------------------------------------------------------------------

log "IAM role $ROLE_NAME"
cat > "$TMP/assume-role.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" }
    }
  ]
}
JSON

if "${AWS[@]}" iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  report found "role $ROLE_NAME"
  "${AWS[@]}" iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "file://$TMP/assume-role.json" >/dev/null
else
  "${AWS[@]}" iam create-role --role-name "$ROLE_NAME" \
    --description "agent-swarm host: S3 state, its own secret, and read-only investigation" \
    --assume-role-policy-document "file://$TMP/assume-role.json" \
    --tags "Key=Name,Value=$ROLE_NAME" "${TAG_MAP[@]}" >/dev/null
  report created "role $ROLE_NAME"
fi

# The policy mirrors BugBoss's task role (deploy/components/bugboss.ts), which
# is the shape an agent needs to investigate an incident: read its own state,
# read its own secret, and read the observability surface. Deliberately absent
# are Bedrock (we use Anthropic credentials), RDS, and anything that could
# deploy, merge or assume another role -- the box runs arbitrary agent code and
# must not hold a path to production.
cat > "$TMP/role-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StateAndDeployArtifacts",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::${BUCKET}",
        "arn:aws:s3:::${BUCKET}/*"
      ]
    },
    {
      "Sid": "OwnSecret",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": ["${SECRET_ARN}"]
    },
    {
      "Sid": "OwnLogGroup",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": [
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*"
      ]
    },
    {
      "Sid": "ConfigParameters",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": [
        "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/agent-swarm/*"
      ]
    },
    {
      "Sid": "DeploymentState",
      "Effect": "Allow",
      "Action": ["ecs:Describe*", "ecs:List*"],
      "Resource": ["*"]
    },
    {
      "Sid": "ApplicationLogContent",
      "Effect": "Allow",
      "Action": [
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": [
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/ecs/*",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/ecs/*",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/sst/cluster/*",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/*"
      ]
    },
    {
      "Sid": "LogGroupDiscovery",
      "Effect": "Allow",
      "Action": ["logs:DescribeLogGroups"],
      "Resource": ["*"]
    },
    {
      "Sid": "Metrics",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics"
      ],
      "Resource": ["*"]
    }
  ]
}
JSON

if "${AWS[@]}" iam get-role-policy --role-name "$ROLE_NAME" --policy-name "inline" >/dev/null 2>&1; then
  POLICY_STATE="found  "
else
  POLICY_STATE="created"
fi
"${AWS[@]}" iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "inline" --policy-document "file://$TMP/role-policy.json" >/dev/null
report "$POLICY_STATE" "inline policy on $ROLE_NAME"
# Session Manager is the only way in -- there is no key pair and no SSH.
if "${AWS[@]}" iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" >/dev/null 2>&1; then
  report created "managed policy AmazonSSMManagedInstanceCore"
else
  report found "managed policy AmazonSSMManagedInstanceCore"
fi

log "Instance profile $PROFILE_NAME"
if "${AWS[@]}" iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  report found "instance profile $PROFILE_NAME"
else
  "${AWS[@]}" iam create-instance-profile --instance-profile-name "$PROFILE_NAME" \
    --tags "Key=Name,Value=$PROFILE_NAME" "${TAG_MAP[@]}" >/dev/null
  report created "instance profile $PROFILE_NAME"
fi
if "${AWS[@]}" iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" \
  --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  report created "role $ROLE_NAME attached to $PROFILE_NAME"
else
  report found "role $ROLE_NAME attached to $PROFILE_NAME"
fi

# ---------------------------------------------------------------------------
# Bucket
# ---------------------------------------------------------------------------

log "Bucket $BUCKET"
if "${AWS[@]}" s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  report found "bucket $BUCKET"
else
  "${AWS[@]}" s3api create-bucket --bucket "$BUCKET" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  report created "bucket $BUCKET"
fi
"${AWS[@]}" s3api put-bucket-tagging --bucket "$BUCKET" --tagging \
  "TagSet=[{Key=Name,Value=$BUCKET},$RESOURCE_TAGS]"
"${AWS[@]}" s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
"${AWS[@]}" s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration "Status=Enabled"

# Versioning plus Litestream's whole-object PUT on every committed write means
# thousands of noncurrent versions a day against a database that stays small.
# Ten retained noncurrent versions is the rollback window; anything older than
# a day beyond that is gone. The rule is bucket-wide rather than prefix-scoped
# the way BugBoss's is, because the prefix layout belongs to the stack's
# litestream.yml rather than to this script. Aborted multipart uploads are the
# other half of the same problem and expire on the same schedule BugBoss uses.
cat > "$TMP/lifecycle.json" <<'JSON'
{
  "Rules": [
    {
      "ID": "expire-noncurrent-state",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 1, "NewerNoncurrentVersions": 10 }
    },
    {
      "ID": "abort-incomplete-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
JSON
"${AWS[@]}" s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration "file://$TMP/lifecycle.json"
report created "versioning, public-access block and lifecycle on $BUCKET"

# ---------------------------------------------------------------------------
# Log group
# ---------------------------------------------------------------------------

log "Log group $LOG_GROUP"
# Compared with = rather than piped into `grep -q`: an early-exiting grep closes
# the pipe, the CLI dies on SIGPIPE, and pipefail turns that into a false
# "missing" that then tries to create a group that already exists.
EXISTING_LOG_GROUP="$("${AWS[@]}" logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" \
  --query "logGroups[?logGroupName=='$LOG_GROUP'].logGroupName" --output text 2>/dev/null || true)"
if [ "$EXISTING_LOG_GROUP" = "$LOG_GROUP" ]; then
  report found "log group $LOG_GROUP"
else
  "${AWS[@]}" logs create-log-group --log-group-name "$LOG_GROUP" \
    --tags "Environment=infra,Project=bugboss-swarm" >/dev/null
  report created "log group $LOG_GROUP"
fi
"${AWS[@]}" logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30

# ---------------------------------------------------------------------------
# Load balancer
# ---------------------------------------------------------------------------

log "Load balancer $ALB_NAME"
ALB_ARN="$("${AWS[@]}" elbv2 describe-load-balancers --names "$ALB_NAME" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)"
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  ALB_ARN="$("${AWS[@]}" elbv2 create-load-balancer \
    --name "$ALB_NAME" \
    --type application \
    --scheme internet-facing \
    --subnets "${SUBNETS[@]}" \
    --security-groups "$ALB_SG" \
    --tags "Key=Name,Value=$ALB_NAME" "${TAG_MAP[@]}" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
  report created "$ALB_NAME ($ALB_ARN)"
else
  report found "$ALB_NAME ($ALB_ARN)"
fi

ALB_DNS="$("${AWS[@]}" elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text)"
ALB_ZONE="$("${AWS[@]}" elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" \
  --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)"

log "Target groups"
ensure_target_group() {
  local name="$1" port="$2"
  local arn
  arn="$("${AWS[@]}" elbv2 describe-target-groups --names "$name" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    arn="$("${AWS[@]}" elbv2 create-target-group \
      --name "$name" \
      --protocol HTTP \
      --port "$port" \
      --vpc-id "$VPC_ID" \
      --target-type instance \
      --health-check-path /health \
      --health-check-interval-seconds 15 \
      --health-check-timeout-seconds 5 \
      --healthy-threshold-count 2 \
      --unhealthy-threshold-count 3 \
      --matcher HttpCode=200 \
      --tags "Key=Name,Value=$name" "${TAG_MAP[@]}" \
      --query 'TargetGroups[0].TargetGroupArn' --output text)"
    report created "target group $name (port $port)"
  else
    report found "target group $name (port $port)"
  fi
  printf '%s' "$arn"
}
API_TG_ARN="$(ensure_target_group "$API_TG_NAME" "$API_PORT")"
HOOK_TG_ARN="$(ensure_target_group "$HOOK_TG_NAME" "$HOOK_PORT")"

# Explicit rather than implicit, so the number cannot move underneath a design
# that assumes it, and so the certificate a mistake would harden here is the
# shared wildcard rather than a new one we do not own.
CERT_ARN="$("${AWS[@]}" acm list-certificates --certificate-statuses ISSUED \
  --query "CertificateSummaryList[?DomainName=='*.goodparty.org'].CertificateArn | [0]" --output text 2>/dev/null || true)"
if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  CERT_ARN="$("${AWS[@]}" acm list-certificates --certificate-statuses ISSUED \
    --query "CertificateSummaryList[?DomainName=='goodparty.org'].CertificateArn | [0]" --output text)"
fi
if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  die "no ISSUED certificate for goodparty.org or *.goodparty.org. $HOSTNAME is a single label under goodparty.org, so a deeper wildcard would not cover it."
fi
report found "certificate $CERT_ARN"

log "HTTPS listener"
LISTENER_ARN="$("${AWS[@]}" elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
  --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text 2>/dev/null || true)"
# Default action is a 404: the rules below are an allowlist, so a path that is
# not routed never reaches a container.
DEFAULT_ACTIONS="Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=not found}"
if [ -z "$LISTENER_ARN" ] || [ "$LISTENER_ARN" = "None" ]; then
  LISTENER_ARN="$("${AWS[@]}" elbv2 create-listener \
    --load-balancer-arn "$ALB_ARN" \
    --port 443 \
    --protocol HTTPS \
    --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
    --certificates "CertificateArn=$CERT_ARN" \
    --default-actions "$DEFAULT_ACTIONS" \
    --query 'Listeners[0].ListenerArn' --output text)"
  report created "listener 443 ($LISTENER_ARN)"
else
  "${AWS[@]}" elbv2 modify-listener --listener-arn "$LISTENER_ARN" \
    --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
    --certificates "CertificateArn=$CERT_ARN" \
    --default-actions "$DEFAULT_ACTIONS" >/dev/null
  report found "listener 443 ($LISTENER_ARN)"
fi
# modify-listener cannot carry tags either, so this is the one place they are set.
"${AWS[@]}" elbv2 add-tags --resource-arns "$LISTENER_ARN" \
  --tags "Key=Name,Value=$ALB_NAME-listener" "${TAG_MAP[@]}" >/dev/null

log "Listener rules"
ensure_rule() {
  local priority="$1" conditions="$2" actions="$3" label="$4"
  local arn
  arn="$("${AWS[@]}" elbv2 describe-rules --listener-arn "$LISTENER_ARN" \
    --query "Rules[?Priority=='$priority'].RuleArn | [0]" --output text 2>/dev/null || true)"
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    arn="$("${AWS[@]}" elbv2 create-rule --listener-arn "$LISTENER_ARN" \
      --priority "$priority" --conditions "$conditions" --actions "$actions" \
      --query 'Rules[0].RuleArn' --output text)"
    report created "rule $priority ($label)"
  else
    "${AWS[@]}" elbv2 modify-rule --rule-arn "$arn" \
      --conditions "$conditions" --actions "$actions" >/dev/null
    report found "rule $priority ($label)"
  fi
  # Same reason as the listener: neither create nor modify carries tags here.
  "${AWS[@]}" elbv2 add-tags --resource-arns "$arn" \
    --tags "Key=Name,Value=$ALB_NAME-rule-$priority" "${TAG_MAP[@]}" >/dev/null
}
# Grafana's webhook path goes to the hook bridge, which listens on its own port
# so a slow or wedged bridge cannot take the API down with it.
ensure_rule 5 "Field=path-pattern,Values=/grafana*" "Type=forward,TargetGroupArn=$HOOK_TG_ARN" "grafana -> hook"
ensure_rule 6 "Field=path-pattern,Values=/*" "Type=forward,TargetGroupArn=$API_TG_ARN" "everything else -> api"

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------

log "DNS $HOSTNAME"
cat > "$TMP/dns.json" <<JSON
{
  "Comment": "agent-swarm ALB alias",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${HOSTNAME}.",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_ZONE}",
          "DNSName": "${ALB_DNS}",
          "EvaluateTargetHealth": true
        }
      }
    }
  ]
}
JSON
"${AWS[@]}" route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch "file://$TMP/dns.json" >/dev/null
report created "A alias $HOSTNAME -> $ALB_NAME"

# ---------------------------------------------------------------------------
# Instance
# ---------------------------------------------------------------------------

log "Instance"
find_instance() {
  "${AWS[@]}" ec2 describe-instances \
    --filters "Name=tag:Name,Values=$NAME_TAG" \
      "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null
}
INSTANCE_ID="$(find_instance)"
if [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "None" ]; then
  # More than one match means a half-finished teardown or a renamed host, and
  # every step below would then operate on the wrong one of them.
  case "$INSTANCE_ID" in
    *" "*|*$'\n'*|*$'\t'*) die "more than one instance is tagged Name=$NAME_TAG ($INSTANCE_ID). Terminate the strays first, or tear down with teardown.sh." ;;
  esac
  # Re-running must not silently resize a host that is mid-incident, and a type
  # change needs a stop/start this script will not do behind your back.
  CURRENT_TYPE="$("${AWS[@]}" ec2 describe-instances --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].InstanceType' --output text)"
  if [ "$CURRENT_TYPE" != "$INSTANCE_TYPE" ]; then
    report found "instance $INSTANCE_ID ($CURRENT_TYPE, left as-is)"
    info "you asked for $INSTANCE_TYPE, and resizing is a stop/start, so it is not done here."
    info "to change it: aws ec2 stop-instances --instance-ids $INSTANCE_ID, then modify-instance-attribute, then start-instances"
  else
    report found "instance $INSTANCE_ID ($CURRENT_TYPE)"
  fi
else
  AMI_ID="$("${AWS[@]}" ssm get-parameter \
    --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --query 'Parameter.Value' --output text)"
  # gp3 because the box holds several agent workspaces plus a Docker image cache,
  # which is the only reason a disk this size exists: the images alone are about
  # 13 GB across the API, the worker and Litestream. The root volume is
  # delete-on-termination so a teardown leaves nothing billable behind.
  cat > "$TMP/block-devices.json" <<JSON
[
  {
    "DeviceName": "/dev/xvda",
    "Ebs": {
      "VolumeSize": ${ROOT_VOLUME_GIB},
      "VolumeType": "gp3",
      "DeleteOnTermination": true
    }
  }
]
JSON
  # Hop limit 2 rather than the hardened 1: a request from inside a container
  # crosses the docker bridge before it reaches IMDS, which is one more hop than
  # the limit counts at 1. At 1 the instance role is unreachable from every
  # container, which silently breaks the agents' aws CLI and Litestream's S3
  # replication. It is not a boundary either way, because the containers run on
  # this host and share its identity, so this makes the granted permissions
  # usable rather than widening anything.
  #
  # This comment sits above the whole invocation rather than beside the argument
  # it explains, and that placement is load-bearing: a comment inside a backslash
  # continuation starts a comment mid-command, so every argument after it is
  # swallowed and the next line becomes a command of its own. `bash -n` reports
  # that as clean, and it only shows up when the script runs.
  INSTANCE_ID="$("${AWS[@]}" ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --subnet-id "${SUBNETS[0]}" \
    --security-group-ids "$HOST_SG" \
    --iam-instance-profile "Name=$PROFILE_NAME" \
    --block-device-mappings "file://$TMP/block-devices.json" \
    --user-data "file://$SCRIPT_DIR/user-data.sh" \
    --associate-public-ip-address \
    --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME_TAG},$RESOURCE_TAGS]" \
      "ResourceType=volume,Tags=[{Key=Name,Value=$NAME_TAG},$RESOURCE_TAGS]" \
    --query 'Instances[0].InstanceId' --output text)"
  report created "instance $INSTANCE_ID ($INSTANCE_TYPE, AL2023, ${ROOT_VOLUME_GIB} GiB gp3, no key pair)"
fi

# `instance` target groups route to an instance id, so the ALB will not serve a
# byte until both are registered. Registration before SSM is online is fine and
# keeps this from needing a second pass after the wait below.
#
# A just-launched instance is not immediately registerable. elbv2 answers
# InvalidTarget with "the following instances do not exist" until EC2's launch
# has propagated, which is its own documented lag rather than flakiness here, so
# the real fix is to wait on the dependency: the instance actually running. The
# bounded loop after that only covers the window between running and elbv2
# agreeing, and it gives up out loud rather than proceeding to a load balancer
# with no targets.
log "Waiting for $INSTANCE_ID to be running"
"${AWS[@]}" ec2 wait instance-running --instance-ids "$INSTANCE_ID"

register_target() {
  local tg="$1" port="$2" attempt
  for attempt in 1 2 3 4 5 6; do
    if "${AWS[@]}" elbv2 register-targets --target-group-arn "$tg" \
      --targets "Id=$INSTANCE_ID,Port=$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 10
  done
  die "could not register $INSTANCE_ID:$port with $tg after $((6 * 10))s. Check the instance is running and in $VPC_ID."
}
register_target "$API_TG_ARN" "$API_PORT"
register_target "$HOOK_TG_ARN" "$HOOK_PORT"
report created "instance $INSTANCE_ID registered with both target groups"

log "Waiting for SSM to register $INSTANCE_ID"
SSM_STATUS=""
for _ in $(seq 1 60); do
  SSM_STATUS="$("${AWS[@]}" ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  if [ "$SSM_STATUS" = "Online" ]; then break; fi
  sleep 10
done
if [ "$SSM_STATUS" != "Online" ]; then
  die "instance $INSTANCE_ID never registered with SSM (last status: ${SSM_STATUS:-none}). Check the instance profile and that user-data.sh finished."
fi
info "SSM online"

# ---------------------------------------------------------------------------
# Ship the stack
# ---------------------------------------------------------------------------

log "Uploading stack to s3://$BUCKET/deploy/stack.tar.gz"
# Excludes are doubled (bare and ./-prefixed) because the operator runs this on
# macOS, whose bsdtar matches the pattern against the archived name while GNU
# tar also applies it as a component; one form alone silently ships node_modules
# on one of them.
TAR_EXCLUDES=(
  --exclude='./.git' --exclude='.git'
  --exclude='./node_modules' --exclude='node_modules'
  --exclude='./.worktrees' --exclude='.worktrees'
  --exclude='./.DS_Store' --exclude='.DS_Store'
  --exclude='*.tar.gz'
)
tar -czf "$TMP/stack.tar.gz" -C "$STACK_DIR" "${TAR_EXCLUDES[@]}" .
"${AWS[@]}" s3 cp "$TMP/stack.tar.gz" "s3://$BUCKET/deploy/stack.tar.gz" >/dev/null
info "uploaded $(du -h "$TMP/stack.tar.gz" | cut -f1)"

# The stack travels by S3 rather than by user-data because user-data is capped
# at 16 KiB and only runs on instance creation, neither of which works for a
# deploy that has to be repeatable against a running host.
cat > "$TMP/remote.sh" <<REMOTE
#!/bin/bash
set -euo pipefail
aws s3 cp "s3://${BUCKET}/deploy/stack.tar.gz" /tmp/agent-swarm-stack.tar.gz --region ${REGION}
mkdir -p /opt/agent-swarm
rm -rf /opt/agent-swarm/*
tar -xzf /tmp/agent-swarm-stack.tar.gz -C /opt/agent-swarm
chmod +x /opt/agent-swarm/bootstrap.sh
chmod +x /opt/agent-swarm/*.sh 2>/dev/null || true
AWS_DEFAULT_REGION=${REGION} /opt/agent-swarm/bootstrap.sh
rm -f /tmp/agent-swarm-stack.tar.gz
REMOTE

PARAMS="$(python3 -c 'import json, sys; print(json.dumps({"commands": [open(sys.argv[1]).read()]}))' "$TMP/remote.sh")"

log "Running bootstrap over SSM"
COMMAND_ID="$("${AWS[@]}" ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "agent-swarm bootstrap" \
  --timeout-seconds 3600 \
  --parameters "$PARAMS" \
  --query 'Command.CommandId' --output text)"
info "command $COMMAND_ID"

COMMAND_STATUS="Pending"
# Outlasts the 3600s command timeout, so a long image pull reports as a timeout
# rather than as this loop giving up while the host is still working.
for _ in $(seq 1 400); do
  COMMAND_STATUS="$("${AWS[@]}" ssm get-command-invocation \
    --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || true)"
  case "$COMMAND_STATUS" in
    Success|Failed|TimedOut|Cancelled) break ;;
  esac
  sleep 10
done

# Both dumps go to stderr so stdout stays the two URL lines.
"${AWS[@]}" ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text >&2 || true
if [ "$COMMAND_STATUS" != "Success" ]; then
  printf '\n' >&2
  "${AWS[@]}" ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
    --query 'StandardErrorContent' --output text >&2 || true
  die "bootstrap on $INSTANCE_ID ended as ${COMMAND_STATUS} (command $COMMAND_ID). Full output: aws ssm get-command-invocation --command-id $COMMAND_ID --instance-id $INSTANCE_ID"
fi
info "bootstrap succeeded"

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

URL="https://$HOSTNAME"
log "Waiting for $URL/health"
HEALTHY=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "$URL/health" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 10
done
if [ "$HEALTHY" != "true" ]; then
  die "$URL/health did not answer 200 within ten minutes. The stack may still be pulling images: check 'docker compose ps' on the host over SSM, and the target group health in the console."
fi

printf '\n'
log "agent-swarm is up"

# stdout carries only these two lines, so `deploy.sh | tail -1` is the URL.
printf '%s\n' "$URL"
printf '%s\n' "$URL/health"
