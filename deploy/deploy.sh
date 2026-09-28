#!/bin/sh
set -e

# `PULUMI_MODE=preview` is set only by `.github/workflows/pulumi-preview.yml`.
# It is an explicit variable rather than derived from `CI` on purpose: a
# preview must never be one mistyped condition away from `pulumi up`. A local
# run leaves it unset and previews against whatever `IMAGE_URI` the caller
# exported.
#
# Preview mode never writes: no `stack select --create`, no `up`, and no
# `DELEGATES` drift check, which needs `GetSecretValue` the preview role does
# not hold. See `docs/pr-previews.md`, step 5.
PREVIEW=false
if [ "$PULUMI_MODE" = "preview" ]; then
  PREVIEW=true
fi

# A PR has no images, and inventing them makes every code-only PR look like a
# task-definition change. Worse for BugBoss: `deploy/index.ts` gates its
# resources on `bugbossImageUri` being set, so leaving it unset would preview
# them as destroyed. In preview mode, reuse the images the `delegate` and
# `bugboss` tasks are actually running. An explicit value still wins, for
# previewing an image-specific change locally.
resolve_image() {
  aws ecs describe-task-definition \
    --task-definition "$1" \
    --query "taskDefinition.containerDefinitions[0].image" \
    --output text
}

if [ -z "$IMAGE_URI" ]; then
  if [ "$PREVIEW" = "true" ]; then
    IMAGE_URI=$(resolve_image delegate)
    if [ -z "$IMAGE_URI" ] || [ "$IMAGE_URI" = "None" ]; then
      echo "Error: could not resolve the deployed delegate image" >&2
      exit 1
    fi
  else
    echo "Error: IMAGE_URI is not set" >&2
    exit 1
  fi
fi

if [ -z "$BUGBOSS_IMAGE_URI" ]; then
  if [ "$PREVIEW" = "true" ]; then
    BUGBOSS_IMAGE_URI=$(resolve_image bugboss)
    if [ -z "$BUGBOSS_IMAGE_URI" ] || [ "$BUGBOSS_IMAGE_URI" = "None" ]; then
      echo "Error: could not resolve the deployed BugBoss image" >&2
      exit 1
    fi
  else
    echo "Error: BUGBOSS_IMAGE_URI is not set" >&2
    exit 1
  fi
fi

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

  # --create only when applying in CI. Preview must not write state, and a
  # local run against a missing stack should fail honestly rather than create
  # one.
  if [ "$CI" = "true" ] && [ "$PREVIEW" != "true" ]; then
    pulumi stack select "organization/ops/ops-dev" --create
  else
    pulumi stack select "organization/ops/ops-dev"
  fi

  pulumi config set aws:region "$AWS_REGION"
  pulumi config set workerImageUri "$IMAGE_URI"
  pulumi config set bugbossImageUri "$BUGBOSS_IMAGE_URI"
  pulumi config set --path aws:defaultTags.tags.Environment infra
  pulumi config set --path aws:defaultTags.tags.Project ops
} 1>&2

if [ "$PREVIEW" = "true" ]; then
  # Both passes in one invocation, after one setup, so the images resolved
  # above are the ones both passes use. `--json` for the summary and
  # diagnostics (written where `PULUMI_PREVIEW_JSON` says), `--diff` for the
  # human-readable body. Never `up`.
  if [ -n "$PULUMI_PREVIEW_JSON" ]; then
    # A failed JSON pass still lets the diff pass run; the workflow reads the
    # JSON to decide what the comment says.
    pulumi preview --json > "$PULUMI_PREVIEW_JSON" || true
  fi
  pulumi preview --diff
  exit $?
fi

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
