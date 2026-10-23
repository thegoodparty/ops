#!/bin/bash
set -euo pipefail

# Usage: push-images.sh build | push
#
# build: docker build the runner image under its content-hash tag. Needs no AWS
#   credentials, and runs before the workflow assumes any.
# push: push the image if its tag is not already in ECR. Needs credentials in
#   the infrastructure account. A missing repository (the first deploy, before
#   Pulumi creates it) is a warning, not a failure; the workflow calls push
#   again after the deploy.

MODE=${1:?usage: push-images.sh build|push}
ACCOUNT=394495727159
REGION=${AWS_REGION:-us-west-2}
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
cd "$(dirname "$0")/.."

for IMAGE in runner; do
  TAG=$(npx tsx -e "console.log(require('./deploy-infrastructure/gh-runners').imageTag('$IMAGE'))")
  URI="$REGISTRY/gh-runners/$IMAGE:$TAG"

  if [ "$MODE" = "build" ]; then
    docker build --platform linux/amd64 -t "$URI" "gh-runners/$IMAGE"
    continue
  fi

  if ! aws ecr describe-repositories --repository-names "gh-runners/$IMAGE" >/dev/null 2>&1; then
    echo "::warning::gh-runners/$IMAGE has no ECR repository yet; skipping push"
    continue
  fi
  if aws ecr describe-images --repository-name "gh-runners/$IMAGE" --image-ids "imageTag=$TAG" >/dev/null 2>&1; then
    echo "gh-runners/$IMAGE:$TAG already in ECR"
    continue
  fi
  aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  docker push "$URI"
done
