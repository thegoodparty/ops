#!/bin/sh
# Runs the GitHub stand-in's tests against the gh BugBoss actually ships.
#
# This builds the `tools` stage of bugboss/Dockerfile, which is where the
# production image pins github-cli, so the gh under test is the production
# pin and not a lookalike. It is also the only honest way to run the suite on
# macOS, where gh cannot be told to trust the test's CA.
#
# The suite runs as root, because the stand-in has to bind 443 and visible CI
# has to be dropped to another user to prove it cannot read the stand-in's
# secrets. openssl (for the test's CA) and tsx are the only things added on
# top, and neither is what is being tested.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
tsx_version=$(node -p 'require(process.argv[1]).packages["node_modules/tsx"].version' "$root/package-lock.json")
tools=bugboss-evals-bugboss-tools
image=bugboss-evals-github-standin-test
docker build -q --target tools -t "$tools" -f "$root/bugboss/Dockerfile" "$root" >/dev/null
docker build -q -t "$image" - >/dev/null <<DOCKERFILE
FROM $tools
RUN apk add --no-cache openssl
RUN npm install -g tsx@$tsx_version
DOCKERFILE
docker run --rm -v "$root":/src:ro -w /src "$image" sh -c \
  'gh --version | head -1 && git --version && tsx --test --test-timeout=120000 bugboss-evals/sim/standins/github/*.test.ts'
