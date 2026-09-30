#!/usr/bin/env bash
# Called as the deploy hook calls it: $1 is the merge SHA, $2 the omni checkout.
exec bash "$(dirname "$0")/../../_lib/setup-omni.sh" "$2"
