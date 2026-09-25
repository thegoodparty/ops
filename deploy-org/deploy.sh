#!/bin/sh
set -e

# See deploy/deploy.sh for why preview mode is an explicit variable and never
# writes. This project has no image, so there is nothing to resolve.
PREVIEW=false
if [ "$PULUMI_MODE" = "preview" ]; then
  PREVIEW=true
fi

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
  # with "no stack named organization/org/main found". That is the honest
  # outcome: there is nothing to preview against, and the way to see the plan
  # before the stack exists is the throwaway backend, not a write to the
  # shared one. Once CI has created the stack, local previews work normally.
  if [ "$CI" = "true" ] && [ "$PREVIEW" != "true" ]; then
    pulumi stack select "organization/org/main" --create
  else
    pulumi stack select "organization/org/main"
  fi
  pulumi config set aws:region "${AWS_REGION:-us-west-2}"
  pulumi config set --path aws:defaultTags.tags.Environment infra
  pulumi config set --path aws:defaultTags.tags.Project org
} 1>&2

# Creating the account is asynchronous and polls for minutes. --diff is worth
# the noise here: this is the one stack where an unexpected replace would
# close a real account.
if [ "$PREVIEW" = "true" ]; then
  # Same two-pass contract as deploy/deploy.sh; see docs/pr-previews.md,
  # step 5. --diff above applies to both passes.
  if [ "$PULUMI_PREVIEW_FORMAT" = "json" ]; then
    pulumi preview --json
  else
    pulumi preview --diff
  fi
  exit $?
fi

if [ "$CI" = "true" ]; then
  pulumi up --diff --yes
else
  pulumi preview --diff
fi
