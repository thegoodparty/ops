#!/usr/bin/env bash
# Makes an omni checkout able to run a gp-api vitest file. Deliberately not
# omni's scripts/worktree-setup.sh: that copies the untracked .env files from
# the main checkout, which would put real dev credentials into a check.
set -euo pipefail

OMNI="${1:?usage: setup-omni.sh <omni checkout>}"
cd "$OMNI"

npm ci --prefer-offline --no-audit --no-fund
npm run build -w packages/contracts
if [ -f packages/nest-common/package.json ]; then
  npm run build -w packages/nest-common
fi
npm run generate -w packages/gp-api
