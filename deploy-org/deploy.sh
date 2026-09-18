#!/bin/sh
set -e

# Mirrors deploy/deploy.sh, minus the image plumbing: this project builds no
# container, so it takes no IMAGE_URI and has no config to set beyond region
# and tags.
#
# The passphrase is the same one every stack in this backend uses. The role
# running this holds ssm:GetParameter on exactly this parameter and nothing
# else; see the PulumiStatePassphrase statement in
# deploy/components/ci-roles/policies.ts.

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
pulumi stack select "organization/org/main" --create
pulumi config set aws:region "${AWS_REGION:-us-west-2}"
pulumi config set --path aws:defaultTags.tags.Environment infra
pulumi config set --path aws:defaultTags.tags.Project org

# Creating the account is asynchronous and polls for minutes. --diff is worth
# the noise here: this is the one stack where an unexpected replace would
# close a real account.
if [ "$CI" = "true" ]; then
  pulumi up --diff --yes
else
  pulumi preview --diff
fi
