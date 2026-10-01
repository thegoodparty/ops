#!/usr/bin/env bash
# Makes an omni checkout able to run a gp-api vitest file. Deliberately not
# omni's scripts/worktree-setup.sh: that copies the untracked .env files from
# the main checkout, which would put real dev credentials into a check.
set -euo pipefail

OMNI="${1:?usage: setup-omni.sh <omni checkout>}"
cd "$OMNI"

# OMNI_PREBUILT is the same base with its dependencies installed, built once
# per job. When the lockfile is unchanged its node_modules are hardlinked in,
# seconds instead of minutes. Caches written in place are dropped so no run
# edits another's copy.
if [ -n "${OMNI_PREBUILT:-}" ] && cmp -s "$OMNI_PREBUILT/package-lock.json" package-lock.json; then
  (cd "$OMNI_PREBUILT" && find . -name .git -prune -o -name node_modules -type d -print -prune) | while read -r dir; do
    mkdir -p "$(dirname "$dir")"
    cp -al "$OMNI_PREBUILT/$dir" "$dir"
  done
  rm -rf node_modules/.vite node_modules/.cache packages/*/node_modules/.vite packages/*/node_modules/.cache
else
  npm ci --prefer-offline --no-audit --no-fund
fi
npm run build -w packages/contracts
if [ -f packages/nest-common/package.json ]; then
  npm run build -w packages/nest-common
fi
npm run generate -w packages/gp-api
