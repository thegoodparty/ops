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
pulumi config set --path aws:defaultTags.tags.Environment dev
pulumi config set --path aws:defaultTags.tags.Project ops

if [ "$CI" = "true" ]; then
  pulumi up --diff --yes
else
  pulumi preview --diff
fi
