#!/bin/bash
set -euo pipefail

# Static checks for the scripts in this directory.
#
# These exist because two real bugs got through both review and `bash -n`:
#
#   1. Ten AWS calls were missing the service name, so they invoked
#      `aws create-role` instead of `aws iam create-role`. Valid syntax,
#      not a valid command, and the deploy died three steps in.
#   2. A comment sat inside a backslash line continuation. The `#` started a
#      comment mid-command, every argument after it was swallowed, and the next
#      line became a command of its own. `bash -n` calls that clean.
#
# Both are decidable without touching AWS, which is the point: this runs in a
# second and needs no credentials. `--deep` additionally asks the CLI whether
# each service and subcommand exists, which needs the CLI but still no AWS calls.
#
# Usage: ./check-scripts.sh [--deep]

cd "$(dirname "${BASH_SOURCE[0]}")"

DEEP=false
[ "${1:-}" = "--deep" ] && DEEP=true

failures=0
fail() { printf 'FAIL  %s\n' "$*" >&2; failures=$((failures + 1)); }
pass() { printf 'ok    %s\n' "$*"; }

# Services the AWS CLI exposes at the top level, restricted to the ones these
# scripts are allowed to use. A call that names something else is a bug.
SERVICES="sts secretsmanager ec2 iam s3api s3 logs elbv2 acm route53 ssm"

printf '== every aws call names a service ==\n'
for f in deploy.sh teardown.sh bootstrap.sh; do
  [ -f "$f" ] || continue
  while IFS= read -r token; do
    if ! printf '%s\n' $SERVICES | grep -qx "$token"; then
      fail "$f: \"\${AWS[@]}\" $token is not a service name"
    fi
  done < <(grep -oE '"\$\{AWS\[@\]\}" [a-z0-9-]+' "$f" | sed -E 's/.*\}" //' | sort -u)
done
[ "$failures" -eq 0 ] && pass "every call names a service"

printf '== no comment inside a backslash continuation ==\n'
before=$failures
bad_continuations="$(python3 - <<'PY'
import pathlib, sys

bad = 0
for p in sorted(pathlib.Path('.').glob('*.sh')):
    lines = p.read_text().splitlines()
    for i, line in enumerate(lines[:-1]):
        if line.rstrip().endswith('\\') and lines[i + 1].lstrip().startswith('#'):
            print(f"FAIL  {p}:{i + 1} is continued by a comment on line {i + 2}")
            bad += 1
sys.exit(1 if bad else 0)
PY
)" || true
if [ -n "$bad_continuations" ]; then
  printf '%s\n' "$bad_continuations" >&2
  failures=$((failures + 1))
else
  pass "no comment breaks a continuation"
fi

printf '== every script parses ==\n'
before=$failures
for f in *.sh grafana/*.sh bridge/*.sh; do
  [ -f "$f" ] || continue
  bash -n "$f" || fail "$f does not parse"
done
[ "$failures" -eq "$before" ] && pass "all scripts parse"

if [ "$DEEP" = true ]; then
  printf '== every service and subcommand exists (asking the CLI) ==\n'
  before=$failures
  for f in deploy.sh teardown.sh; do
    [ -f "$f" ] || continue
    while read -r svc sub; do
      aws "$svc" "$sub" help >/dev/null 2>&1 || fail "$f: aws $svc $sub is not a command"
    done < <(grep -ohE '"\$\{AWS\[@\]\}" [a-z0-9]+ [a-z0-9-]+' "$f" | sed -E 's/.*\}" //' | sort -u)
  done
  [ "$failures" -eq "$before" ] && pass "every service and subcommand exists"
fi

printf '\n'
if [ "$failures" -gt 0 ]; then
  printf '%s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'all checks passed\n'
