#!/bin/sh
# Prints the Postgres master password on stdout, for Bifrost's
# `password_command` (step 6 of docs/bifrost-zero-downtime-deploys.md, decision
# 20).
#
# Why a command and not a `password` reference: Bifrost reads an injected
# `PG_PASSWORD` once, when the process starts, so an RDS rotation left the
# running gateway holding the previous password. Every new physical connection
# then failed with `SQLSTATE 28P01`, `/health` pings the stores, the container
# went unhealthy and ECS replaced the task — 2 min 50 s of outage after about
# 7 h 20 min in which inference worked while request logging and usage
# accounting failed silently. At the pinned tag (`transports/v2.4.0`)
# `framework/postgresconn/postgresconn.go` runs this command from an
# `OptionBeforeConnect` for every new physical connection, behind a
# `singleflight` group and a TTL cache whose failures are never cached, so a
# rotation now heals within `cache_ttl` instead of until the next task start.
#
# RDS owns the secret (`manageMasterUserPassword: true` in `rds.ts`) and writes
# a rotated password as the `AWSCURRENT` version of the same secret, so reading
# `AWSCURRENT` and pulling `password` out of it converges on its own. Nothing
# here needs `AWSPENDING` or the version list.
#
# The ARN arrives in the environment (`PG_SECRET_ARN`, set by the task
# definition from `database.secretArn`), not in the command's arguments:
# `password_command.command` and `.args` are literal strings at the pinned tag
# (`PasswordCommandConfig.Command string`, `Args []string` filled by
# `json.Unmarshal`), and nothing expands an `env.` reference inside them. The
# same environment carries what the CLI needs to sign the call: `AWS_REGION`
# from the task definition, and the ECS container-credential chain
# (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`) handed in by the platform, which is
# the task role's identity — not the execution role's.
#
# That inheritance is a dependency on upstream, not an accident, so it is named
# here where a change to it would be read. At the pinned tag
# (`transports/v2.4.0`) `RunPasswordCommand` in
# `framework/postgresconn/postgresconn.go` builds the command at line 563 with
# `cmd := exec.Command(config.Command, config.Args...)` and never assigns
# `cmd.Env`. In Go a nil `cmd.Env` means the child inherits the parent's
# environment (`os.Environ()` is implied); a version that built its own list
# there would drop both `PG_SECRET_ARN` and the container credentials, and
# every dial would fail with this script's own "PG_SECRET_ARN is not set" or
# the CLI's credential-chain error. Re-read those three lines on a tag bump.
# Deliberately no fallback to `PGPASSWORD` or a second credential source: the
# only thing one would buy is a slower, less obvious failure.
#
# stdout is the password and nothing else; Bifrost trims the trailing newline.
# Errors go to stderr, which Bifrost includes in the dial error rather than
# swallowing. The value is never echoed, logged or traced.
set -eu

: "${PG_SECRET_ARN:?PG_SECRET_ARN is not set; the task definition did not pass the RDS-managed secret's ARN}"

# Fail immediately rather than waiting on an unreachable metadata endpoint if
# the container credential environment is ever missing: the task definition
# gives the container a task role, and a Fargate task has no IMDS to fall back
# to, so the only thing a fallback would buy is a slower failure.
AWS_EC2_METADATA_DISABLED=true
# Never a pager: the caller is a pipe in another process, and a pager that read
# stdout would leave Bifrost waiting on a command that never exits.
AWS_PAGER=""
export AWS_EC2_METADATA_DISABLED AWS_PAGER

fail() { printf 'pg-password: error: %s\n' "$*" >&2; exit 1; }

secret="$(aws secretsmanager get-secret-value \
  --secret-id "$PG_SECRET_ARN" \
  --version-stage AWSCURRENT \
  --query SecretString \
  --output text)" \
  || fail "GetSecretValue failed for $PG_SECRET_ARN"

# `-e` so a missing or empty password is a non-zero exit rather than an empty
# line Bifrost would try to authenticate with.
printf '%s' "$secret" \
  | jq -er '.password | select(type == "string" and length > 0)' \
  || fail "the secret has no non-empty password key"
