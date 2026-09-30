#!/usr/bin/env bash
exec node "$(dirname "$0")/../../_lib/vitest-check.mjs" "$1" packages/gp-api "$(dirname "$0")/phone-list-deadline.vitest.ts"
