# Narrowing the shared deploy role's trust

`github-actions-pulumi-deploy` is the CI role seven repositories deploy with.
Since PR #102 attached `AdministratorAccess` it carries admin outright, on
the reasoning recorded in `workbench-account.md` under "The deploy role": the
enumerated policy was never a boundary, because the role could already grant
itself anything through `iam:PutRolePolicy` and `sso:*`.

That makes the trust policy the whole control, and today it is not one. Eight
repository subjects are still `repo:thegoodparty/<name>:*`. The wildcard
matches `refs/pull/N/merge`, so a pull request in any of them can assume an
administrator role, running code nobody has reviewed.

This document is the plan for reducing those eight to main-only, and for
giving the workflows that genuinely need credentials on a pull request roles
sized to what they actually do. It is the sibling of
[`pr-previews.md`](./pr-previews.md), which did the same job for this repo's
own subject, and it reuses that plan's roles, helpers and workflow shape
wherever they fit.

## Progress

One step at a time, one pull request per step, with the conventions
[`workbench-account.md`](./workbench-account.md) sets: statuses are `todo`,
`doing (session, date)` and `done (date, evidence)`; claim a step by pushing
the status change **before** starting; name the session, not the model; check
`git branch --show-current` before committing.

Ordering matters, and in the same way it matters in the other two plans. A
step that grants a permission must merge **and finish applying** before the
step that uses it. Here the hazard is sharper than usual, because the grant
lands in this repo and the consumer lands in another one entirely, with
nothing sequencing the two. Narrowing a subject before its replacement role
exists breaks that repo's pull requests; creating the role and pointing the
workflow at it before narrowing breaks nothing. So every repo is done in that
order: role, then workflow, then trust.

- [ ] 1. Record this plan: `doing` (role-assumption-workflow, 2026-09-25).
- [x] 2. Drop the five archived repositories from the trust list: `done`
      (2026-09-25, role-assumption-workflow. `gp-api`, `people-api`,
      `election-api`, `runbooks` and `campaign-plan-service`, all confirmed
      archived against the GitHub API rather than from this table. An archived
      repository cannot run a workflow, so the entries granted nothing. The
      stale notes in `ci-roles/policies.ts` are corrected in the same change,
      and the regression test now names the five so re-adding one is
      deliberate).
- [ ] 3. Remove credentials from the three workflows that should not hold
      them: `todo`. Independent of 4 and 5, and worth doing first because it
      shrinks what the later roles have to cover.
- [ ] 4. Create `github-actions-pulumi-plan`: `todo`. Depends on 3, which
      decides the read surface.
- [ ] 5. Point the plan-only workflows at it: `todo`. Depends on 4 applying.
- [ ] 6. Create `github-actions-preview-deploy`: `todo`. Depends on the
      naming audit in "The preview-deploy role" below.
- [ ] 7. Point `gp-api.yml` and `gp-api-teardown-preview.yml` at it: `todo`.
      Depends on 6 applying.
- [ ] 8. Narrow `omni` and `gp-terraform-dataplatform` to main: `todo`.
      Depends on 5 and 7.
- [ ] 9. Narrow `gpvpn` to main: `todo`. Independent of 4 through 8; its
      workflow is push-only already.

## What actually uses the role

Verified against GitHub on 2026-09-25, by resolving workflow files and
repository variables rather than by code search.

| Repo | State | How it references the role | Credentials on `pull_request`? |
| --- | --- | --- | --- |
| `omni` | live | `vars.AWS_ROLE_ARN`, plus two literal ARNs | Yes, five workflows |
| `gp-terraform-dataplatform` | live | `vars.AWS_ROLE_ARN` | Yes, one workflow |
| `gpvpn` | live | literal ARN in `main.yml` | No, push only |
| `gp-api` | archived | `secrets.AWS_ROLE_ARN` | n/a |
| `people-api` | archived | literal ARN | n/a |
| `election-api` | archived | literal ARN | n/a |
| `runbooks` | archived | literal ARN | n/a |
| `campaign-plan-service` | archived | `secrets.AWS_ROLE_ARN` | n/a |

`vars.AWS_ROLE_ARN` resolves to this role's ARN in both live repositories.

### Two claims this corrects

Both appear in `ci-roles/policies.ts` and `workbench-account.md`, and both
were load bearing for the decision to leave the other eight wildcarded. They
are wrong, and the notes should be fixed in step 2 rather than left to be
believed again.

**"Only `ops` and `omni` reference the role."** Six of the eight do. The
undercount came from searching for the literal ARN: most references go
through `vars.AWS_ROLE_ARN`, which a string search does not see.

**"`omni`'s `publish-experiments.yml` needs it on `pull_request`."** It does
not, and has not since the single-trunk cutover in August. Its `publish` job
is gated `if: (push && ref == refs/heads/main) || workflow_dispatch`. Only the
`validate` job runs on a pull request, and it touches no AWS. This was the
single stated reason for keeping `omni` wildcarded.

The real pull-request consumers are five other `omni` workflows and one in
`gp-terraform-dataplatform`, and one of them applies infrastructure.

## Two classes of consumer

The distinction that shapes every role below is whether a job **plans** or
**changes** things. It is not the same as whether the job is important.

### Plan only

Nothing in these creates, mutates or destroys an AWS resource. They are the
case [`pr-previews.md`](./pr-previews.md) already solved.

| Workflow | Deciding command | Note |
| --- | --- | --- |
| `omni/gp-api-infrastructure-diffs.yml` | `pulumi preview --json`, `ecs:DescribeServices`, `ecs:DescribeTaskDefinition` | `infra-cli.ts` runs `stack select --create` on every command, including `diff`. A write capability on a read path. |
| `omni/gp-ai.yml`, `terraform-plan` job | `terraform plan -lock=false` | `-lock=false`, so it does not write the lock object either. |
| `gp-terraform-dataplatform/on-pull-request.yaml` | `terraform plan -lock-timeout=5m` | No `-lock=false`, so this one **does** take the state lock and needs write on exactly the lock object. |

`tf-apply.yaml` in `gp-terraform-dataplatform` is `workflow_call`-only,
reachable solely from `deploy.yaml` behind a `workflow_dispatch` condition and
pinned to the `production` GitHub environment. A pull request cannot reach it.

### Preview deploys

These apply. Both run PR-authored Pulumi against a PR-authored workflow file.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `omni/gp-api.yml`, `preview` job | `if: github.event_name == 'pull_request'`, so PR-only | Pushes a SHA-tagged image to ECR, then `pulumi up`: an ECS service, ALB, Route53 record, security groups and a database on the shared preview Aurora cluster. Reads secrets and the state passphrase from SSM. |
| `omni/gp-api-teardown-preview.yml` | `pull_request: types: [closed]` | `pulumi destroy`, `pulumi stack rm`, and an `ecs run-task` on the dev cluster's task definition that drops the preview database. |

There is no read-only role that covers these. That is the substance of this
plan, and the reason it is not simply "copy the ops preview role."

## Why not reuse `github-actions-pulumi-preview`

Considered and rejected. Technically it composes: the state bucket
`goodparty-iac-state` is shared by every project, so
`pulumiBackendReadStatements` takes `omni`'s project names as readily as
`ops`'s, and adding a subject to a trust policy is two lines.

Three reasons not to.

**The blast radius becomes the union, and the passphrase is shared.** The
preview role holds `ssm:GetParameter` on `pulumi-state-config-passphrase`,
which decrypts every project's state in the bucket. The only separation left
is the per-project object ARN scoping, a wart `ci-roles/policies.ts` already
records. One shared role means any `omni` pull request author can read `ops`,
`org` and `workbench` state, and the reverse. Two roles keep that scoping
meaningful.

**The populations differ.** `ops` is a small infrastructure repository with
`CODEOWNERS` over the whole tree. `omni` is the product monorepo. Sharing the
identity raises the `ops` threat model to `omni`'s population and buys
nothing.

**A write grant would contaminate both.** The `ops` role is defensible
precisely because it is read-only end to end. The moment one statement in a
shared document is a write, that property is gone for every subject on it.

Against this the only argument is duplication, and a sibling role is about
fifteen lines in the same `ci-roles.ts`, built from the same helpers. Reuse
the code, not the identity.

## Design: `github-actions-pulumi-plan`

Trust: `aud` = `sts.amazonaws.com`, and `sub` **StringEquals** a two-element
list of `repo:thegoodparty/omni:pull_request` and
`repo:thegoodparty/gp-terraform-dataplatform:pull_request`. Multiple values
for one key under one operator are ORed, so this is a single statement. Not
`:*`; main runs keep the deploy role.

Two subjects on one role is the opposite of the argument made above, so state
why it is right here: both are plan-only, both are read-only, and neither
reads the other's state. The separation that matters is plan versus apply, not
repository.

Starting grant, widened only by observed failures, the discipline
`pr-previews.md` step 4 set and PR #103 exercised:

| Statement | Actions | Resource |
| --- | --- | --- |
| Pulumi state | `pulumiBackendReadStatements` | `omni`'s project prefixes |
| Terraform state | `s3:GetObject`, `s3:ListBucket` | the dataplatform backend, scoped to its key prefix |
| Terraform lock | `s3:PutObject`, `s3:DeleteObject` | the lock object only, for `gp-terraform-dataplatform` |
| Current image | `ecs:DescribeServices`, `ecs:DescribeTaskDefinition` | `*`, which these do not scope |
| Planned services | describe and list only | per observed plan failures |

**Resolve before step 4:** whether `gp-terraform-dataplatform` uses
`goodparty-iac-state` or its own bucket, and whether its lock is S3-native or
DynamoDB. The lock grant differs, and a DynamoDB lock needs its own statement.

**Also before step 4:** `infra-cli.ts` runs `stack select --create` on the
`diff` path. For stacks that exist this is a read, but the capability is on
the path, and a plan role must not carry `s3:PutObject` on state. Either the
CLI grows a mode that skips `--create`, mirroring `PULUMI_MODE=preview` in
this repo's `deploy.sh`, or the grant is added and the role stops being
read-only. Prefer the first. It is an `omni` change and belongs in step 5.

## Design: `github-actions-preview-deploy`

The hard one. Trusted by `repo:thegoodparty/omni:pull_request` alone, and by
nothing else ever.

State the threat model honestly rather than implying this role is safe. It is
assumable by anyone with push access to `omni`, running unreviewed code, and
it must be able to create ECS services, load balancers, DNS records and
databases, because that is what a preview environment is. It cannot be made
harmless. It can be made much smaller than administrator, and that is the
whole goal: not a boundary against a determined insider, but a boundary that
keeps a preview deploy from reaching production.

What it must not hold, and these are the ones worth naming:

- No `sso:*`. This is the action that makes the current role admin-equivalent
  regardless of anything else in its document.
- No `iam:PutRolePolicy`, `iam:AttachRolePolicy` or `iam:CreatePolicyVersion`
  on `*`. Self-escalation.
- No `secretsmanager:GetSecretValue` on `*`. Scoped to exactly the preview
  secrets the stack reads, by ARN.
- No write to any resource carrying the production tags.

**The audit that decides feasibility, and step 6 does not start without it:**
whether the resources the preview stack creates carry a predictable name
prefix or tag. ECS services, target groups, security groups and Route53
records are all scopable by ARN pattern if the names are prefixed, and by
`aws:ResourceTag` if the stack tags them. If they are not prefix-predictable,
say so and change the Pulumi program to make them so, because a scoped write
role is not otherwise expressible and the alternative is admitting the role
stays broad.

`rds:*` on the shared preview cluster deserves its own decision. The cluster
is shared across previews, so a grant that lets a preview create a database on
it also lets one drop the cluster. Scope to `rds:CreateDBInstance` and the
specific cluster ARN, with no `Delete` on the cluster itself, and let the
teardown path use the existing `ecs run-task` route for dropping the database.

## Design: the workflows that should not hold credentials at all

Three cases, all of them the pattern PR #90 applied to this repo's
`deploy.yml`: a job holds credentials it does not use, or uses far fewer than
it holds. These are the cheapest wins in the plan and they come first, because
every one of them shrinks what steps 4 and 6 have to cover.

**`omni/verify-vercel-registrar-token.yml`.** A secret-reading job that also
triggers on `pull_request`, under a role holding `secretsmanager:*`. A job
that reads secrets has no business running on an event where the job
definition itself comes from the pull request, whatever care the committed
version takes. The `pull_request` trigger exists only to test edits to the
file; the scheduled and dispatch runs are what it is for. Removed ahead of
this plan rather than in step 3, since it needs none of the roles below.

**`omni/gp-ai.yml`, `build` job.** Configures credentials and runs an ECR
login on every pull request, but the push is gated to
`push && ref_name == 'main'`. On a pull request it builds the image to
validate the Dockerfile and discards it, so it needs
`ecr:GetAuthorizationToken` and nothing else. Same shape as PR #90.

**`omni/election-api.yml`.** Declares `id-token: write` and never assumes a
role. Stray permission, no effect, remove it.

## Ordering

The rule from `workbench-account.md` applies, with one addition. Cross-repo
steps have a second hazard: the grant is applied by this repo's `deploy.yml`,
and the consumer is a workflow in a repository this stack does not deploy. So
a step is only unblocked once the applying run here is green, not once its
pull request merges.

Per repository the order is always: create the role, apply it, point the
workflow at it, merge that, then narrow the subject. Narrowing first breaks
every open pull request in that repository, and unlike a broken deploy it
breaks them for everyone at once.

Step 2 sits outside this. Removing an archived repository's subject has no
consumer to sequence against.

## Open questions

- Which backend and lock type does `gp-terraform-dataplatform` use? (step 4)
- Does the `omni` infra CLI need a preview mode to drop `stack select
  --create`, or does the plan role carry state writes? (steps 4 and 5)
- Are the preview stack's resources prefix-predictable or tagged? (step 6)
- Does `gpvpn` still deploy anything, or is step 9 a removal rather than a
  narrowing? Last push was June.
