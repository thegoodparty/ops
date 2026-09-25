#!/bin/sh
set -e

if [ -z "$IMAGE_URI" ]; then
  echo "Error: IMAGE_URI is not set"
  exit 1
fi

PULUMI_CONFIG_PASSPHRASE=$(aws ssm get-parameter \
  --name "pulumi-state-config-passphrase" \
  --with-decryption \
  --query "Parameter.Value" \
  --output text)

if [ -z "$PULUMI_CONFIG_PASSPHRASE" ]; then
  echo "Error: Failed to pull pulumi state config passphrase from SSM"
  exit 1
fi

export PULUMI_CONFIG_PASSPHRASE

pulumi login s3://goodparty-iac-state
pulumi stack select "organization/ops/ops-dev" --create
pulumi config set aws:region "$AWS_REGION"
pulumi config set workerImageUri "$IMAGE_URI"
pulumi config set --path aws:defaultTags.tags.Environment infra
pulumi config set --path aws:defaultTags.tags.Project ops

if [ "$CI" = "true" ]; then
  # Apply only. The task definition's key list now comes from the repo
  # (`delegate-secret.ts`), so confirm the live secret still matches it before
  # changing anything. Not run on preview: preview must not read the secret's
  # value. See docs/pr-previews.md, step 3.
  ../node_modules/.bin/tsx check-secret-keys.ts
  pulumi up --diff --yes
else
  pulumi preview --diff
fi
