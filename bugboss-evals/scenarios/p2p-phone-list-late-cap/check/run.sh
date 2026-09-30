#!/usr/bin/env bash
# Called as the deploy hook calls it: $1 is the merge SHA, $2 the omni checkout.
exec node "$(dirname "$0")/../../_lib/vitest-check.mjs" "$2" packages/gp-api "$(dirname "$0")/phone-list-deadline.vitest.ts"
