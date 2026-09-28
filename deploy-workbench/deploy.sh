#!/bin/sh
set -e

# See deploy/deploy.sh for why preview mode is an explicit variable and never
# writes. This project has no image to resolve. The one preview-specific
# setting is which role the provider assumes: the read-only `pulumi-preview`
# instead of the admin `pulumi-deploy`. See docs/pr-previews.md, step 8.
PREVIEW=false
if [ "$PULUMI_MODE" = "preview" ]; then
  PREVIEW=true
fi

# Mirrors deploy-org/deploy.sh, plus the role names below.
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

# Setup writes to stderr so that, in the JSON preview pass, stdout carries only
# the JSON document. `pulumi login` in particular prints a banner to stdout,
# which otherwise corrupts it.
{
  pulumi login s3://goodparty-iac-state

  # --create only in CI. Without this guard, running the script locally to
  # "just preview" writes a new stack into the shared state bucket before
  # reaching the preview at all — a side effect that has to be dodged by hand,
  # by pointing PULUMI_BACKEND_URL at a throwaway local backend, which is what
  # was done to check this project before it first merged. Raised in review.
  #
  # Locally, against a stack that does not exist yet, `stack select` now fails
  # with "no stack named organization/workbench/main found". That is the honest
  # outcome: there is nothing to preview against, and the way to see the plan
  # before the stack exists is the throwaway backend, not a write to the
  # shared one. Once CI has created the stack, local previews work normally.
  if [ "$CI" = "true" ] && [ "$PREVIEW" != "true" ]; then
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

  # Set in both modes, not left to the program's default. The config file is
  # local and persists, so a local preview that set `pulumi-preview` and did
  # not set it back would repoint the next apply at the read-only role. The
  # names match `PREVIEW_ROLE_NAME` in preview-role.ts and `DEPLOY_ROLE_NAME`
  # in deploy-role.ts.
  if [ "$PREVIEW" = "true" ]; then
    pulumi config set providerRoleName pulumi-preview
  else
    pulumi config set providerRoleName pulumi-deploy
  fi
} 1>&2

if [ "$PREVIEW" = "true" ]; then
  # Same single-invocation, two-pass contract as deploy/deploy.sh; see
  # docs/pr-previews.md, step 5.
  if [ -n "$PULUMI_PREVIEW_JSON" ]; then
    pulumi preview --json > "$PULUMI_PREVIEW_JSON" || true
  fi
  pulumi preview --diff
  exit $?
fi

if [ "$CI" = "true" ]; then
  pulumi up --diff --yes
else
  pulumi preview --diff
fi
