#!/bin/sh
set -e

# Mirrors deploy-org/deploy.sh. The differences are the stack, and the two
# provider lines below.
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

# --create only in CI, for the reason review raised on deploy-org: running
# this locally to "just preview" would otherwise write a new stack into the
# shared bucket before reaching the preview. Locally, before CI has created
# the stack, `stack select` fails with "no stack named
# organization/workbench/main found", which is the honest outcome; preview
# against a throwaway local backend instead.
if [ "$CI" = "true" ]; then
  pulumi stack select "organization/workbench/main" --create
else
  pulumi stack select "organization/workbench/main"
fi

# Every resource in this project must name the provider in index.ts, which
# assumes a role into 024901689212. The default provider does not, so a
# resource that omits `{ provider }` would be created in the management
# account instead: a wrong-account create that looks like a clean apply.
# This makes Pulumi refuse it, with "Default provider for 'aws' disabled.
# <urn> must use an explicit provider."
#
# Verified against pulumi 3.x with @pulumi/aws 7.23.0 rather than taken from
# the docs, both directions: a resource without a provider errors at preview,
# and one with an explicit provider applies normally.
pulumi config set --path 'pulumi:disable-default-providers[0]' aws

# Only for the region default; the tags are set on the provider in index.ts,
# because aws:defaultTags applies to the default provider and this stack has
# none.
pulumi config set aws:region "${AWS_REGION:-us-west-2}"

if [ "$CI" = "true" ]; then
  pulumi up --diff --yes
else
  pulumi preview --diff
fi
