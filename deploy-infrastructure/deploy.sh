#!/bin/sh
set -e

# Mirrors deploy-workbench/deploy.sh as it was before PR previews: no
# PULUMI_MODE and no providerRoleName config yet. Both arrive with step 11 of
# docs/infrastructure-account.md, once the provider has a deploy role and a
# preview role to choose between.
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
  echo "Error: Failed to pull pulumi state config passphrase from SSM" >&2
  exit 1
fi

export PULUMI_CONFIG_PASSPHRASE

pulumi login s3://goodparty-iac-state

# --create only in CI, so running this locally to "just preview" cannot write
# a new stack into the shared bucket. Locally, before CI has created the
# stack, `stack select` fails with "no stack named
# organization/infrastructure/main found", which is the honest outcome;
# preview against a throwaway local backend instead.
if [ "$CI" = "true" ]; then
  pulumi stack select "organization/infrastructure/main" --create
else
  pulumi stack select "organization/infrastructure/main"
fi

# Every resource in this project must name the provider in index.ts, which
# assumes a role into 394495727159. The default provider does not, so a
# resource that omits `{ provider }` would be created in the management
# account instead. This makes Pulumi refuse it, with "Default provider for
# 'aws' disabled. <urn> must use an explicit provider."
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
