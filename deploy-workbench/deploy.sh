#!/bin/sh
set -e

# Resolve the script's own directory so the pre-apply check below works no
# matter which directory the workflow invokes this from.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# See deploy/deploy.sh for why preview mode is an explicit variable and never
# writes. This project has no image to resolve. The one preview-specific
# setting is which role the provider assumes: the read-only `pulumi-preview`
# instead of the admin `pulumi-deploy`. See docs/pr-previews.md, step 8.
PREVIEW=false
if [ "$PULUMI_MODE" = "preview" ]; then
  PREVIEW=true
fi

# Restrict the apply to a subset of the stack, for `deploy-workbench.yml`.
#
# The workflow has to push the images the task definition names before the apply
# that can drain the running task (see its header comment), and the ECR
# repositories those images are pushed into are created by this same stack. A
# stack that has never been applied, or that just gained an image, therefore has
# nowhere to push until something creates the repository -- and a full apply
# would create it while also rolling the service onto an image that does not
# exist yet, which is the outage this exists to prevent. So the workflow runs
# this script once in a constrained mode that holds the service back: the push
# that follows has somewhere to go, and the task is not rolled onto an image ECR
# does not have. The full apply runs afterwards, with the images already in ECR.
#
# The constraint is `--exclude`, NOT `--target`, and that is a workaround for a
# Pulumi engine bug, not a preference. A `--target`ed `up`/`preview` intermittently
# fails with "Duplicate resource URN ..." naming a resource registered exactly
# once, which nobody targeted, under a diagnostic that reads as a duplicate
# declaration in our program (pulumi/pulumi#24359). The trigger is an untargeted
# dependency edge that differs between the state and the program; the victim is
# whatever bystander the step generator happens to lose a race over, so it moves
# from run to run. It is upstream's, partly fixed in #24801 (merged 2026-10-06)
# and open in #25434 and #24381, and no released version dodges it: 3.255.0,
# 3.260.0, 3.267.0, 3.268.0, 3.272.0 and 3.273.0 all fail on the local repro, at
# 10/15 to 20/20.
#
# The engine path that corrupts is `queueUntargetedDependencySames`, which is
# entered only when `opts.Targets.IsConstrained()` or `TargetSnippets` is
# non-empty (step_generator.go, v3.273.0). It pre-stamps URNs into the step
# generator's seen-set and queues "untargeted same" steps for old-state
# dependencies of a targeted resource; the duplicate is a resource that gets a
# step through that path and then registers itself. Constraining by `--exclude`
# leaves `Targets` unconstrained, so the function returns immediately and the
# path is never taken.
#
# The numbers, from a local repro shaped like this pass (`--yes`, one repository
# to create, one untargeted dependency edge changed between state and program,
# and an ECS-service-shaped resource whose inputs change, so an arm that "passed"
# by rolling it can be told apart). 25 trials per arm unless marked:
#
#   --target, type glob (what this used to be)   25 trials, 25 duplicated
#   --target, explicit full URNs                 25 trials, 25 duplicated
#   --target --skip-preview                      25 trials, 25 duplicated
#   --target --continue-on-error                  7 trials,  7 duplicated
#   --target --parallel 1                         9 trials,  9 duplicated
#   --exclude service + task definition          25 trials,  0 duplicated,
#                                                22 clean, 3 CLI crashes in the
#                                                qemu-emulated binary (exit -1
#                                                inside the CLI's own heap,
#                                                unrelated to this bug)
#
# All 22 clean ones left the excluded service and task definition untouched in
# the resulting snapshot -- their `length` input still held the old value, not
# the new one -- which is the property this pass depends on. Constraining by
# `--exclude` and completing was the only construction that did not duplicate,
# out of everything tried; the arms with fewer than 25 trials were cut short once
# they had clearly reproduced.
#
# It must be `--exclude` of both the service AND the task definition. Excluding
# only the task definition is not enough: the service's diff reads the task
# definition, so the service comes out as a create-replacement and drains the
# task -- reproduced, not assumed. `--exclude-dependents` is not used and must
# not be: it would exclude everything the service depends on, which is the
# stack.
#
# Both patterns are matched by *type and name* with a glob over the stack and
# project, for the same reason the repositories' target glob was: renaming the
# stack does not silently stop matching. `deploy-workflow-order.test.ts` checks
# these against the logical names `ecs.ts` declares, and checks that the ECR
# repositories are not excluded, so a future edit cannot quietly let the service
# into the pass or a repository out of it.
#
# Ignored in preview mode: a preview is not a write, and a constrained preview
# would be a plan for something this script does not do.
DEPLOY_EXCLUDE_SERVICE=${DEPLOY_EXCLUDE_SERVICE:-}
DEPLOY_EXCLUDE_TASK_DEFINITION=${DEPLOY_EXCLUDE_TASK_DEFINITION:-}

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
  if [ -n "$DEPLOY_EXCLUDE_SERVICE" ] || [ -n "$DEPLOY_EXCLUDE_TASK_DEFINITION" ]; then
    # Both must be set or neither: excluding one without the other is the
    # silent drain described above, so a half-configured pair is an error rather
    # than a pass that touches the service. Quoted, because each glob contains
    # `*` and `:` and the shell must not expand or split on either.
    if [ -z "$DEPLOY_EXCLUDE_SERVICE" ] || [ -z "$DEPLOY_EXCLUDE_TASK_DEFINITION" ]; then
      echo "Error: set both DEPLOY_EXCLUDE_SERVICE and DEPLOY_EXCLUDE_TASK_DEFINITION, or neither" >&2
      exit 1
    fi
    pulumi up --diff --yes \
      --exclude "$DEPLOY_EXCLUDE_SERVICE" \
      --exclude "$DEPLOY_EXCLUDE_TASK_DEFINITION"
  else
    # The pre-apply secret check. It runs here, after the stack has been
    # selected and configured and immediately before the apply that can drain
    # the running task, because ECS does not resolve a task definition's
    # `secrets` until the task launches: an apply that names a JSON key a
    # secret does not contain succeeds, drains the old task and leaves the
    # service empty. That is the 2026-10-26 outage, when `bifrost:3` named
    # `BIFROST_SETUP_TOKEN` and `bifrost/gateway` did not have it.
    #
    # The database password is checked here for the same reason, and because
    # nothing else does since it stopped being a `secrets` entry: the
    # container resolves it per connection with the task role, so a bad ARN or
    # a secret without a `password` key is a store init failure after the
    # drain rather than a task that never starts. The ARN comes from the
    # gateway's `PG_SECRET_ARN` environment entry in the same synthesized
    # definition, and the check is an AWS API read (the secret is RDS's, not a
    # Pulumi resource).
    #
    # The required keys are derived from the task definition Pulumi is about
    # to deploy, not from a list in the repo. The preview JSON is the
    # synthesized state; the stack export is the fallback for an unchanged
    # task definition, which can be absent from preview's steps. Neither is
    # printed: the check reports key names only, and a secret value never
    # reaches the log. Anything that stops the comparison -- a preview that
    # has no task definition, a missing permission, a secret that is not JSON
    # -- exits non-zero under `set -e` rather than being read as success.
    PREFLIGHT_DIR=$(mktemp -d)
    trap 'rm -rf "$PREFLIGHT_DIR"' EXIT
    pulumi preview --json > "$PREFLIGHT_DIR/preview.json"
    pulumi stack export > "$PREFLIGHT_DIR/stack.json"
    npx --no-install tsx "$SCRIPT_DIR/scripts/preflight-secrets.ts" \
      --preview "$PREFLIGHT_DIR/preview.json" \
      --stack-export "$PREFLIGHT_DIR/stack.json"

    pulumi up --diff --yes
  fi
else
  pulumi preview --diff
fi
