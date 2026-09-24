# Pulumi previews on pull requests

This document is the working plan for running `pulumi preview` on PRs to this
repo and posting the result as a PR comment, using a narrowly scoped read-only
role rather than the admin-equivalent credentials a preview needs today. It
records the decisions and the reasoning so the work can be picked up across
sessions.

## Progress

One step at a time, one pull request per step, with the same conventions as
[`workbench-account.md`](./workbench-account.md): statuses are `todo`,
`doing (session, date)` and `done (date, evidence)`; claim a step by pushing
the status change **before** starting; name the session, not the model; check
`git branch --show-current` before committing.

Ordering matters. Any step that grants a permission must merge **and finish
applying** before the step that uses it, per "Apply ordering between
workflows" in `workbench-account.md`. The grant is applied by `deploy.yml`,
the consumer by a different workflow, and nothing sequences the two.

- [ ] 1. Record this plan: doing (claude-pr-previews, 2026-09-24)
- [ ] 2. Audit the `ops`, `org` and `workbench` stack state for secrets: todo.
      Gate for posting full diffs publicly; see "Secrets in the diff".
- [ ] 3. Stop reading the `DELEGATES` secret value in `deploy/index.ts`: todo.
- [ ] 4. Create the `github-actions-pulumi-preview` role: todo.
- [ ] 5. Preview mode for `deploy.sh` and the preview workflow, for `ops` and
      `org`: todo. Depends on 2, 3 and 4 being applied.
- [ ] 6. Remove AWS credentials from `pull_request` runs of `deploy.yml`:
      todo.
- [ ] 7. Narrow `github-actions-pulumi-deploy`'s ops trust entry to `main`:
      todo. Depends on 6 being merged.
- [ ] 8. Workbench-side preview role, and a configurable provider role: todo.
      Depends on 4 being applied.
- [ ] 9. Workbench previews in the workflow: todo. Depends on 8 being
      applied.
- [ ] 10. Extend the `ReadOnlyAccess` permission set for local previews:
      todo. Depends on 8 being applied.
- [ ] 11. Revisit the workbench preview role at workbench step 10: todo.
      Tracked here so it is not lost; the work happens in that step.

## Why a preview needs admin today

Four independent causes. Each one alone would force admin or near-admin.

1. **`deploy/index.ts` reads the `DELEGATES` secret value at program time.**
   `aws.secretsmanager.getSecretVersion({ secretId: "DELEGATES" })` is an
   invoke, so it runs on preview as well as apply. It fetches every value in
   the secret (Anthropic key, GitHub App private key, Slack signing secret)
   only to derive the ARN and the *key names*, which become the task
   definition's `secrets` list. `workbench-account.md` ("How to resume")
   records this as the reason preview needs `gp-admin`.
2. **`deploy-workbench/` assumes `OrganizationAccountAccessRole`.** The
   explicit provider assumes it at configure time, which happens on preview
   too, and that role is effectively administrator in 024901689212.
3. **`deploy/` requires `workerImageUri`.** PR runs push no image, so there is
   nothing honest to pass without a lookup.
4. **The `deploy.sh` scripts are apply scripts.** With `CI=true` they run
   `stack select --create` (a state write when the stack is missing) and
   `pulumi up --yes`. Keying preview off `CI` would be a single mistyped
   condition away from an apply.

Found alongside, and fixed by this plan (steps 6 and 7): **PR runs already
receive near-admin credentials.** `deploy.yml` configures
`github-actions-pulumi-deploy` on every `pull_request`, only for an ECR login
the build does not need (the base image is public `node:22-alpine`, and the
push is already skipped on PRs). That role trusts `repo:thegoodparty/ops:*`
and holds `sso:*`, `iam:*Role*`, `s3:*` and `secretsmanager:*`. The repo is
public; fork PRs cannot obtain an OIDC token, so the exposure is to anyone
with push access, running unreviewed code.

## What we borrow from omni, and what we do not

`omni/.github/workflows/gp-api-infrastructure-diffs.yml` is the reference for
the *mechanics*: `pulumi preview --json` for the change summary and
diagnostics, a second human-readable `--diff` run inside a `<details>` block,
find-and-replace of a single bot comment, deletion of the comment when there
are no changes, failing the job on preview errors, and cancelling superseded
runs.

Not borrowed: its credentials. It assumes `vars.AWS_ROLE_ARN`, which is
`github-actions-pulumi-deploy`, the full deploy role, and its CLI runs
`stack select --create`. That is the model this plan exists to avoid.

## The threat model that shapes the role

In a PR preview, the Pulumi program is PR-authored code executing with the
role's credentials. The workflow file also comes from the PR, so the
`job_workflow_ref` pin that protects the scoped deploy roles would only name
`@refs/pull/N/merge` and constrains nothing. The role therefore has to be safe
to hand to **anyone with push access, unreviewed**. Concretely:

- No secret values. Not `secretsmanager:GetSecretValue`, not SSM parameters
  other than the state passphrase.
- No writes, anywhere, including the state bucket (subject to the lock check
  below).
- State access for exactly the `ops`, `org` and `workbench` projects, never
  bucket-wide.
- **Not** the AWS-managed `ReadOnlyAccess` policy. It carries broad `s3:Get*`
  and `ssm:Get*` (verify against the current policy document when step 4 is
  claimed), which would read every project's state in `goodparty-iac-state`
  plus the shared passphrase, and so decrypt all seven projects' state. The
  explicit policy below is the whole grant.

A consequence worth stating: the role can read the passphrase, which is
shared by every project in the bucket. The object ARN scoping is then the only
thing keeping it from other projects' secrets. That is the same "known wart"
recorded in `ci-roles/policies.ts`; a passphrase per project would make it
defence in depth. Out of scope here, but this role raises its stakes because
it is PR-assumable.

## Design

### Step 3: key list in the repo

Decided: the secret's key names are declared as a constant in the repo, and
the program uses `aws.secretsmanager.getSecret` (metadata only, via
`DescribeSecret`) for the ARN.

- Adding a key becomes a reviewed PR. Today it silently changes the task
  definition on the next deploy, which is arguably worse.
- `delegate/.env.example` already lists the keys; the constant is the source
  of truth and the example should say so.
- Drift guard, main only: a step in `deploy/deploy.sh` (not in the program, so
  preview never needs it) that reads the secret with the deploy role and fails
  if a declared key is missing. A missing key would otherwise surface as an
  ECS task that fails to start. An undeclared extra key is only a warning.
- Acceptance: a local preview against the live stack shows no change to
  `agentTaskDef` beyond what the image URI causes. `secretKeys.sort()` in
  `worker.ts` already makes ordering irrelevant.
- Update "How to resume" in `workbench-account.md`, which currently says
  preview needs `gp-admin`.

### Step 4: `github-actions-pulumi-preview`

Created in `deploy/components/ci-roles.ts`, inline `RolePolicy` like the other
scoped roles (the deploy role cannot manage new managed policies).

Trust: `aud` = `sts.amazonaws.com` and `sub` **StringEquals**
`repo:thegoodparty/ops:pull_request`. Not `:*`, not `main`: main runs have
their own roles, and nothing else should hold this one.

Starting grant, to be widened only by observed failures:

| Statement | Actions | Resource |
| --- | --- | --- |
| State bucket | `s3:ListBucket`, `s3:GetBucketLocation` | the bucket |
| State objects | `s3:GetObject` | `.pulumi/stacks/{ops,org,workbench}/*` |
| State meta | `s3:GetObject` | `.pulumi/meta.yaml` |
| Passphrase | `ssm:GetParameter` | `pulumi-state-config-passphrase` |
| Secret metadata | `secretsmanager:DescribeSecret` | the `DELEGATES` ARN (`-??????` suffix) |
| Current image | `ecs:DescribeTaskDefinition` | `*` (does not accept resource scoping) |

`pulumiBackendStatements` in `ci-roles/policies.ts` grants read-write; add a
read-only variant rather than parameterising the existing one into something
that can silently widen.

Verify before relying on, and record the result here:

- **Does a DIY-backend preview take the state lock?** Expected not. If it
  does, add `s3:PutObject`/`s3:DeleteObject` on
  `.pulumi/locks/organization/<project>/*` and nothing wider. Also decides
  whether `cancel-in-progress: true` is safe (step 5).
- **Does the `org` preview need any Organizations reads?** Expected not: no
  invokes, and a preview without `--refresh` does not read resources.
- Previews are state-vs-code, not drift detection. `--refresh` would need
  broad reads across every service in the stack and is deliberately not part
  of this.

### Step 5: preview mode and the workflow

Preview mode is an explicit variable (for example `PULUMI_MODE=preview`), not
derived from `CI`, and in that mode each `deploy.sh`:

- runs `stack select` **without** `--create`;
- sets config as today (local `Pulumi.*.yaml`, gitignored, not state);
- for `ops`, resolves `IMAGE_URI` to the currently deployed image from the
  `delegate` task definition, so code-only PRs show no task-definition diff;
- runs `pulumi preview` (`--json` for the summary, `--diff` for the body) and
  never `up`.

New workflow `.github/workflows/pulumi-preview.yml` (filename is not load
bearing, since trust is by `sub` only, but keep it stable):

- `on: pull_request` only. Never `pull_request_target`.
- Skip when `github.event.pull_request.head.repo.full_name !=
  github.repository`; forks cannot get an OIDC token anyway, so this makes the
  skip explicit instead of a confusing failure.
- `permissions: contents: read, id-token: write, pull-requests: write`.
- `actions/checkout` with `persist-credentials: false`.
- One job per project with path filters, each writing its own section of one
  comment (or one comment per project; decide when implementing).
- Concurrency per PR with `cancel-in-progress: true`, only if the lock check
  in step 4 confirms preview is read-only.
- Comment handling as omni does it. Pin third-party actions by SHA: this is a
  public repo and the job holds AWS credentials.
- Update `CLAUDE.md` ("PRs run type-checking and builds but skip the deploy
  step") and the `CODEOWNERS` comment's list of permission-bearing paths.

### Secrets in the diff

Decided: post the full diff, provided it contains no secrets. PR comments on
this repo are public.

- Step 2 audits each stack with `pulumi stack export --show-secrets` (human,
  admin session) for any secret-typed values or plaintext credentials in
  state. Anything found is either removed from state or its project is
  excluded from full diffs.
- Pulumi masks secret-typed values as `[secret]` in diffs. What it cannot
  mask is a credential stored as a plain string, which is what the audit is
  for.
- Remember the role can print anything it can read into the job log, which is
  public too. The audit covers that, and so does the scoped grant.

### Steps 6 and 7: close the existing PR credential path

6. In `deploy.yml`, make "Configure AWS Credentials" and "Login to Amazon
   ECR" `if: github.event_name != 'pull_request'`. The docker build still runs
   on PRs.
7. Then change `repo:thegoodparty/ops:*` in `githubActionsPulumiDeployTrust`
   to `repo:thegoodparty/ops:ref:refs/heads/main`. It is a tightening, but of
   the role CI itself assumes, so its own PR, after 6 has merged; a PR run
   still assuming it would otherwise fail. Moving that entry out of the
   `StringLike` list into an exact match is fine, but keep the other eight
   repos untouched: omni's `publish-experiments.yml` needs `pull_request`.

### Steps 8, 9 and 11: workbench

Decided: ship now, and adjust at workbench step 10.

8. In `deploy-workbench/`, create an in-account role `pulumi-preview` whose
   trust names the step 4 role's ARN (which must exist first, since IAM
   validates principal ARNs), holding no permissions beyond what observed
   previews need. `aws.getCallerIdentityOutput` needs none. Grant the step 4
   role `sts:AssumeRole` on exactly that ARN, in the `ops` stack.
   The trust also admits the management account's `ReadOnlyAccess` SSO role,
   for step 10. Its role name carries a random suffix and sits under
   `aws-reserved/sso.amazonaws.com/`, so match it with an `ArnLike`
   condition on `aws:PrincipalArn` against the account root principal, not
   with a literal principal ARN.
   Make the provider's `assumeRoles[0].roleArn` come from stack config
   (defaulting to today's `OrganizationAccountAccessRole`), set by preview
   mode.
   **Check before merging:** a provider input change must show as at most an
   update of the `workbench` provider, never a replacement cascading to every
   resource. If it cascades, the alternative is CI doing the second hop
   itself (role chaining in `configure-aws-credentials`) with no
   `assumeRoles` on the provider, relying on `allowedAccountIds`; that also
   changes the apply path, so it needs its own review.
9. Add `workbench` to the preview workflow.
11. At workbench step 10, re-check the preview role's shape. If step 10's
   scoped deploy role changes how the provider reaches the account (for
   example, chaining in CI instead of `assumeRoles`), the preview path must
   change with it. A cross-reference sits in step 10's entry in
   `workbench-account.md`.

### Step 10: humans

Decided: extend the existing `ReadOnlyAccess` permission set (`gp-readonly`)
rather than add a new `PulumiPreview` one.

Why that is enough: the step 4 grant is a strict subset of what
`ReadOnlyAccess` already holds in the management account. The AWS-managed
`ReadOnlyAccess` policy covers the state bucket (`s3:Get*`, `s3:List*`), the
passphrase (`ssm:GetParameter`; the set's inline policy denies only
`Environment=prod`-tagged parameters, so confirm the passphrase is not tagged
that way) and `ecs:DescribeTaskDefinition`. `AWSSecretsManagerClientReadOnlyAccess`
covers `DescribeSecret`. So `ops` and `org` previews should already work
under `gp-readonly` once step 3 lands, with no change to the set.

Why not a separate set: the step 4 role is narrow because it is
PR-assumable, and that threat model does not apply to a human session. A
narrow human set would be a third read-only option alongside `EngineerAccess`
and `ReadOnlyAccess`, held by the same groups (Engineers, Admins, Research),
and would protect nothing the other two do not already expose to them.

The one gap is `workbench`: `ReadOnlyAccess` is deliberately not assigned in
024901689212, and the managed policy has no `sts:AssumeRole`. So the change is:

- Add a statement to `readOnlyAccess` in `identity-center/policies.ts`
  allowing `sts:AssumeRole` on exactly the step 8 `pulumi-preview` role ARN.
- Step 8's trust admits the `ReadOnlyAccess` SSO role (see there). No new
  assignment in the workbench account.
- Research holds `ReadOnlyAccess` too and so gains this hop. Acceptable:
  the role it reaches holds only what a preview needs.
- Update "How to resume" in `workbench-account.md` to say previews run under
  `gp-readonly`, and drop the `gp-admin` advice.

Verify then, and record the finding: whether
`AWSSecretsManagerClientReadOnlyAccess` includes
`secretsmanager:GetSecretValue`. If it does, `gp-readonly` can run an `ops`
preview even before step 3, the "How to resume" claim that preview needs
`gp-admin` is already stale, and the set is broader than its name suggests.
That last point is worth its own follow-up, but it does not change this
decision: step 10 adds only the workbench hop.

## Open questions

- Does a DIY-backend preview lock? (step 4)
- Does a change to the workbench provider's role ARN cascade? (step 8)
- One comment per project or one combined comment? (step 5)
- Is the passphrase parameter tagged `Environment=prod`? If so,
  `ReadOnlyAccess`'s inline deny blocks it and step 10 needs an exception.
  (step 10)
