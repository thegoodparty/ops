#!/bin/sh
# Runs the GitHub stand-in's tests against the gh BugBoss actually ships.
#
# bugboss/Dockerfile installs `github-cli` from Alpine on node:22-alpine, so
# this builds the same base with the same packages and runs the suite there.
# That is the only honest way to run it on macOS, where gh cannot be told to
# trust the test's CA, and it is the pin: whatever gh that image resolves is
# the gh these tests prove the stand-in against.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
tsx_version=$(node -p 'require(process.argv[1]).packages["node_modules/tsx"].version' "$root/package-lock.json")
image=bugboss-evals-github-standin-test
docker build -q -t "$image" - >/dev/null <<DOCKERFILE
FROM node:22-alpine
RUN apk add --no-cache git curl github-cli bash openssl
RUN npm install -g tsx@$tsx_version
DOCKERFILE
docker run --rm -v "$root":/src:ro -w /src "$image" sh -c \
  'gh --version | head -1 && git --version && tsx --test --test-timeout=120000 bugboss-evals/sim/standins/github/*.test.ts'
