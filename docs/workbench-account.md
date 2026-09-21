# Workbench account

This document is the working plan for provisioning a second AWS account to host
developer tooling. It records the decisions and the reasoning behind them so
the work can be picked up across sessions.

## Progress

One step at a time, one pull request per step. Statuses are `todo`, `doing
(who, date)`, and `done (date, evidence)`. Evidence is a commit SHA for
in-repo work, or an AWS case number or resource id for work done outside git.

Claim a step by setting it to `doing` and pushing that change **before**
starting the work, not after. Steps 1, 2, 11 and 12 happen in the console or in
support cases and leave no other trace, so the claim is the only thing stopping
two sessions from doing them twice.

- [x] 1. Create and verify `aws-workbench@goodparty.org` group alias: done
      (2026-09-17, jeff, group created and receipt confirmed)
- [x] 2. Grant the deploy policy self-management, in the console: done
      (2026-09-17, policy v18 default as of 19:48 UTC, v13 deleted to stay
      under the five-version cap; recorded from AWS after the fact, so the
      actor is unconfirmed)
- [x] 3. Adopt `github-actions-pulumi-deploy` into Pulumi: done (2026-09-17,
      bbcb8ae, PR #59; apply created no v19 and both documents still match
      AWS exactly, so the capture was clean)
- [x] 4. Create the two scoped CI roles in `deploy/`: done (2026-09-18,
      5f3655e and 9dad234, PR #60; both roles confirmed in AWS with
      `iam:GetRole`, created 18:29 UTC by that merge's apply, each carrying
      its inline policy. ARNs recorded below.)
- [x] 5. Add the `deploy-org/` project (OU + account): done (2026-09-21,
      PR #62, merged as 643c0a7; the `Deploy org` run created 3 resources
      and the account reached ACTIVE at 13:17:15 UTC. `list-accounts` and
      `describe-account` confirm id, email, OU path and `JoinedMethod:
      CREATED`; ids recorded below.)
- [x] 6. Record the account id below, then let it settle: done (2026-09-21,
      this commit. `describe-account` reports `Status` and `State` both
      ACTIVE, so the settling this step waits on is over as far as
      Organizations is concerned. The other half of it, STS seeing
      `OrganizationAccountAccessRole`, is unverified and cannot be checked
      from a ReadOnlyAccess session: the assume is the first thing step 7
      does, so a transient failure there is the expected place to find out,
      not a permissions bug to debug.)
- [x] 7. Add the `deploy-workbench/` project and its CI job: done
      (2026-09-21, both PRs. First, the deferred `sts:AssumeRole` grant:
      PR #67, applied 16:00 UTC, confirmed on the role with
      `iam:get-role-policy`. Second, the project and `deploy-workbench.yml`:
      PR #68, merged as 4c7b731, `Deploy workbench` run 35641993246 green at
      19:01 UTC, 2 resources created, `accountId` output reads 024901689212.
      That output also closes the half of step 6 that could not be checked
      from a ReadOnlyAccess session: the assume into
      `OrganizationAccountAccessRole` worked, so STS sees the role.)
- [ ] 8. Extend `identity-center.ts` for the new account: doing (claude,
      2026-09-21. Single PR, not two: the shared deploy role already holds
      `sso:*`, so unlike steps 5, 7 and 9 there is no grant to land first.
      Flip to done when the `Deploy` run is green, and record the
      `WorkbenchAccess` permission set id below at the same time.)
- [ ] 9. Attach SCP to the `Workbench` OU: todo
- [ ] 10. Replace `OrganizationAccountAccessRole` with a scoped in-account role: todo
- [ ] 11. Enable Bedrock model access in the new account: todo
- [ ] 12. Request quota increases if needed: todo
- [ ] 13. Add budget and cost anomaly detection: todo
- [ ] 14. Point `pi` at the account, document engineer setup: todo

Facts discovered during implementation go here as they are learned:

- Workbench account id: `024901689212`. Created 2026-09-21 13:17:15 UTC,
  ACTIVE, email `aws-workbench@goodparty.org`. This is the
  `WORKBENCH_ACCOUNT_ID` step 7 needs and the assignment target step 8 needs.
- `Workbench` OU: `ou-jqqe-dv88i5zn`, directly under root `r-jqqe`. The
  account's full path is `o-uuiolqc1di/r-jqqe/ou-jqqe-dv88i5zn/024901689212/`.
  The root has one other OU, `ou-jqqe-qxbqugvv` (`ElectionAPI`), which matters
  in step 9: enabling `SERVICE_CONTROL_POLICY` is a root-level change and the
  FullAWSAccess default policy attaches everywhere, so that OU is affected by
  the enablement even though no SCP of ours targets it.
- `github-actions-org-deploy` ARN:
  `arn:aws:iam::333022194791:role/github-actions-org-deploy`, inline policy
  `OrgDeploy`
- `github-actions-workbench-deploy` ARN:
  `arn:aws:iam::333022194791:role/github-actions-workbench-deploy`, inline
  policy `WorkbenchDeploy`
- In-account workbench deploy role ARN: _not yet created_
- `WorkbenchAccess` permission set id: _not yet created_. Unlike every other
  set in `identity-center.ts`, this one is created by Pulumi rather than
  adopted, so its id is not known until step 8 applies. Record it here for
  reference, but do **not** add it to the `permissionSets` entry: an `id`
  there is what switches the resource from create to import, and importing a
  resource Pulumi already owns is not a no-op.
- SCPs enabled on org root: none. Root `r-jqqe` reports an empty
  `PolicyTypes`, so `SERVICE_CONTROL_POLICY` has never been enabled. See
  step 9: enabling it is a property of the organization, not of the OU.
- `GitHubActionsPulumiDeployPolicy` version at adoption: v18, the default
  since 2026-09-17. Step 2 deleted v13 to stay under the five-version cap,
  so the surviving versions are v14 through v18. Adoption added the stack's
  default tags (`Environment: infra`, `Project: ops`), which the policy did
  not carry before; it made no change to the document itself.
- The five-version cap does not need managing by hand from here on. The first
  in-repo edit to that policy (v19, PR #65, adding `iam:UpdateRoleDescription`)
  hit the cap and the provider pruned the oldest non-default version itself;
  v15 through v19 survive, v14 is gone. So the console deletion step 2 had to
  do was a one-off, not a recurring chore.
- Repos that actually reference `github-actions-pulumi-deploy`: only `ops` and
  `omni`. The other seven in its trust policy have no reference anywhere. Of
  the two, only `omni/.github/workflows/publish-experiments.yml` needs it on
  `pull_request`. Relevant to tightening trust later; not part of this plan.

## How to resume

Trust AWS over this checklist. The checklist can be stale (a session may have
died mid-step); AWS cannot. Before starting anything, reconcile:

```bash
aws organizations list-accounts --query "Accounts[].[Id,Name,Status]" --output table
pulumi stack select organization/ops/ops-dev && pulumi stack output
pulumi stack select organization/org/main && pulumi stack output
pulumi stack select organization/workbench/main && pulumi stack output
git log --oneline -15 -- docs/workbench-account.md deploy/ deploy-org/ deploy-workbench/
```

Read-only AWS calls are enough for all of that, so reconcile with the
`gp-readonly` profile rather than reaching for `gp-admin`. A preview needs
`gp-admin` because `deploy/index.ts` reads the `DELEGATES` secret at preview
time; reading state does not.

If a step is marked `doing` with a date more than a day old, assume the session
that claimed it is gone. Verify actual state with the commands above, then
either finish it or reset it to `todo`.

Concurrent `pulumi up` is already safe: the S3 backend takes a state lock, and
`.github/workflows/deploy.yml` serializes main-branch deploys through the
`deploy-${{ github.ref }}` concurrency group. Note the failure mode documented
in that workflow, though: cancelling a run mid-`pulumi up` orphans the lock and
leaves a `pending_operations` entry. Let queued runs finish.

## Goal

Provision a child AWS account, `goodparty-workbench`, to host developer tooling
for the coding phase of engineering work. The first concrete use is running
coding agents (for example `pi`) against Bedrock as an alternative to Claude
Code.

## Why a separate account

The line is not dev versus prod. It is whether a workload carries an
availability obligation.

Product environments carry one, including the dev environment: if dev Bedrock
throttles, releases block and CI goes red. The `delegate` agents carry one too.
They are Slack-triggered Fargate tasks with real users, so despite being AI
workloads they belong with operational infrastructure, not here.

Developer inner-loop tooling carries no availability obligation. If it
throttles, an engineer waits. Nobody is paged. That difference drives
everything else: credentials belong to individual humans rather than services,
load is bursty and scales with headcount rather than traffic, cost is per seat,
and the process holding the credentials is an agent that can take arbitrary
actions.

So the taxonomy is three buckets, not two: product environments, operational
infrastructure, and the inner loop.

### The Bedrock quota argument

Bedrock on-demand invocation quotas (requests per minute and tokens per minute,
per model) are enforced per account, per region. There is no per-principal rate
limiting inside an account, so a separate account is the only way to give the
inner loop its own capacity rather than rationing a shared pool.

Coding agents are close to the worst possible Bedrock neighbor: long contexts,
many turns per task, parallel subagents, and consumption that grows with how
many engineers we hire rather than with product traffic.

Two things that look like fixes but are not:

- Application inference profiles give per-team cost attribution through tags.
  They do not isolate quota.
- A gateway with per-engineer keys stops one engineer starving the others, but
  does not raise the ceiling. It is a rationing tool, not a capacity tool.

To check whether we are actually throttled today:

```
aws cloudwatch get-metric-statistics --namespace AWS/Bedrock \
  --metric-name InvocationThrottles --start-time 2026-08-17T00:00:00Z \
  --end-time 2026-09-17T00:00:00Z --period 86400 --statistics Sum \
  --region us-west-2
```

### The data argument

This is the stronger justification. We handle L2 voter data, which is
restricted. An account boundary turns "a coding agent should not be able to
reach restricted data" from a policy into something structurally true. No
product or voter data enters this account.

## What belongs here

The test: is it driven by a human writing code, with no uptime obligation?

Belongs here: Bedrock model access for coding agents, any future shared
gateway or metering proxy for those agents, MCP servers that serve the inner
loop, agent-related caches.

Does not belong here: anything in `delegate/`, CI/CD runners for product
deploys, any product environment, anything holding product or voter data,
anything with an SLO.

The failure mode for an account like this is the junk drawer. In eighteen
months it holds a Postgres instance from a spike, a stray Lambda, and half a
staging environment. The SCP below is what prevents that, not the name.

## Naming

| Thing | Value |
|---|---|
| AWS account name | `goodparty-workbench` |
| Root email | `aws-workbench@goodparty.org` |
| Organizations OU | `Workbench` |
| Pulumi project directory | `deploy-workbench/` |
| Pulumi project name | `workbench` |
| Pulumi stack | `organization/workbench/main` |
| Default tags | `Environment: workbench`, `Project: workbench` |
| CI deploy role | `github-actions-workbench-deploy` |

Rejected names and why:

- `tooling` / `devtools`: this repo's first line calls itself "operations
  tooling", so `tooling` is ambiguous between the two accounts. It is also the
  junk drawer word, offering no resistance to unrelated things being parked
  here.
- anything with `dev`: `EngineerAccess` grants blanket mutate on `dev`-tagged
  resources, and the existing stack is named `ops-dev` but tagged
  `Environment: infra`. The word is already overloaded here.
- `sandbox`: AWS uses it as a term of art for per-engineer throwaway accounts,
  which is a different pattern. This is a shared daily driver that engineers
  cannot work without.
- `inner-loop`: most precise, but jargon, and reads badly as an account alias
  and email address.

On the stack name: `main` rather than `prod` or `workbench-dev`. It matches the
branch that deploys it and makes no claim about environment. The existing
`ops-dev` stack is tagged `Environment: infra` precisely because its name made
a claim that turned out to be wrong, and renaming it now needs a state
migration.

## Repo and Pulumi structure

Three decisions that are easy to conflate:

- Which AWS account a resource lands in is determined by its **provider**.
  `deploy/index.ts` has no explicit `aws.Provider`, so everything uses the
  default provider, which takes its region from `pulumi config set aws:region`
  in `deploy/deploy.sh` and its credentials from the OIDC role assumption in
  `.github/workflows/deploy.yml`.
- **Stacks** are state and locking boundaries, not account boundaries.
- **Repos** are orthogonal to both.

Decision: same repo, three Pulumi projects.

| Project | Stack | Account | Role |
|---|---|---|---|
| `deploy/` (existing) | `organization/ops/ops-dev` | `333022194791` | `github-actions-pulumi-deploy` |
| `deploy-org/` (new) | `organization/org/main` | `333022194791` | `github-actions-org-deploy` |
| `deploy-workbench/` (new) | `organization/workbench/main` | workbench | `github-actions-workbench-deploy` |

Organization-level resources get their own project rather than living in the
`ops` stack as originally planned. See the deploy role section below for why.

Why not the alternatives:

- Second provider in the existing stack: one state file and one lock means
  every `pulumi up` touches both accounts. Worse, main-branch deploys are gated
  behind `docker build` and `docker push` of the delegate worker, so workbench
  changes would queue behind and fail with an image build they have nothing to
  do with. Also `aws:defaultTags` is stack config applied to the default
  provider, so a second provider needs its tags set in code, splitting the
  tagging mechanism in two.
- Second stack of the same project: `deploy/index.ts` unconditionally builds
  the worker, webhook, and Playwright bucket, and `deploy.sh` requires
  `workerImageUri`. A second stack would need `pulumi.getStack()` branching to
  skip all of it, which is a Pulumi anti-pattern.
- Second repo: justified only if the access boundary differs (different people
  merging, different CODEOWNERS). It does not here. It would also be actively
  harmful, because Identity Center permission sets are org-level and already
  live in `deploy/components/identity-center.ts`. The workbench account's
  `AccountAssignment` resources belong next to them, and splitting repos means
  cross-repo coordination every time access changes.

## The deploy role

`github-actions-pulumi-deploy` cannot provision the account today. As of policy
version v17 it has no `organizations:` statement and no `sts:AssumeRole`
statement. Its attached `ReadOnlyAccess` covers every Organizations read we
need, including `DescribeCreateAccountStatus`, but no writes.

We are not widening it. Its trust policy accepts nine repositories, each as
`repo:thegoodparty/<name>:*`, which matches any ref including `pull_request`
refs:

```
gp-api, people-api, election-api, gp-terraform-dataplatform,
campaign-plan-service, ops, gpvpn, runbooks, omni
```

Granting `organizations:CreateAccount` there would let nine repositories' CI
create AWS accounts, and the SCP work in step 9 would add `DetachPolicy`, which
would let them remove org guardrails.

Honest caveat: that role already holds `sso:*` on `*`, and anything that can
call `sso:*` can assign itself `AdministratorAccess` through Identity Center.
So it is already effectively organization-admin from nine repos, and the
Organizations writes would not be a new category of risk. The reason to split
anyway is that this project exists to make a boundary structurally real, and
v17 suggests the drift has been steady, and v17 landed by console edit on
the same day this plan was written. This is the moment to stop adding to
the pile, not an emergency.

Instead, two purpose-built roles, both created by the `ops` stack in step 4
(which already holds `iam:CreateRole`). Trust for both is scoped to
`repo:thegoodparty/ops:ref:refs/heads/main`, not `:*`, so PR branches cannot
assume them.

`github-actions-org-deploy` needs the writes:

```
organizations:CreateOrganizationalUnit
organizations:CreateAccount
organizations:MoveAccount
organizations:TagResource
organizations:UntagResource
```

`UntagResource` is paired with `TagResource` deliberately. Removing or
renaming a tag on the OU or the account calls it, and without it step 5 fails
partway through an apply that has already created a real account.

and, because a scoped role does not inherit the shared role's
`ReadOnlyAccess`, the reads must be spelled out explicitly:

```
organizations:DescribeOrganization
organizations:DescribeOrganizationalUnit
organizations:DescribeAccount
organizations:DescribeCreateAccountStatus
organizations:ListRoots
organizations:ListAccounts
organizations:ListParents
organizations:ListOrganizationalUnitsForParent
organizations:ListTagsForResource
```

Never grant `organizations:CloseAccount`. Nothing in this plan needs it, and
omitting it is a second independent barrier alongside `protect: true` against
a resource deletion closing a real account.

`github-actions-workbench-deploy` needs `sts:AssumeRole` on the target role in
the workbench account, and nothing else in the management account.

Both roles also need Pulumi backend access, which the shared role never had to
think about because it holds `s3:*` on `*`. Scope it per project, not to the
bucket. `goodparty-iac-state` is shared by seven projects today (`gp-api`,
`people-api`, `election-api`, `delegates`, `gpvpn`, `campaign-plan-service`
and `ops`), all encrypted with the single passphrase below, so a bucket-wide
object grant would let either of these roles decrypt and rewrite any of them,
and the victim project would apply the rewritten state on its next deploy.

The backend's layout is per project, checked against the live bucket:

```
.pulumi/stacks/<project>/<stack>.json          and .bak
.pulumi/locks/organization/<project>/<stack>/  "organization" is literal
.pulumi/backups/<project>/<stack>/
.pulumi/history/<project>/<stack>/
.pulumi/meta.yaml                              bucket-wide, read only
```

So each role gets `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on the
four prefixes for its own project only, `s3:GetObject` on `meta.yaml`, and:

```
s3:ListBucket, s3:GetBucketLocation on arn:aws:s3:::goodparty-iac-state
ssm:GetParameter on arn:aws:ssm:us-west-2:333022194791:parameter/pulumi-state-config-passphrase
```

Keep the trailing slash in each prefix. `.pulumi/stacks/org` without one also
matches `.pulumi/stacks/organization-anything`.

`ListBucket` is left unconditioned. Pulumi enumerates stacks by listing
`.pulumi/stacks/`, so an `s3:prefix` condition tight enough to be worth having
risks breaking `stack select` in a way nothing can verify until step 5 runs,
and what it would protect is key names we already publish here. The content
boundary is the object statements.

Known wart: every project shares one passphrase, so that separation rests on
the object ARNs alone rather than on defence in depth. A passphrase per
project would be better and is a change to the existing stacks, not to this
work.

Missing the passphrase grant produces a state decryption error that does not
obviously point at IAM.

No `kms:Decrypt` grant is needed despite the parameter being a `SecureString`.
It is encrypted under the AWS-managed `alias/aws/ssm` key, whose key policy
admits callers in this account through the `ssm` service. Confirmed
empirically rather than assumed: the shared role decrypts it on every deploy
today holding `ssm:GetParameter` and nothing else, and `ReadOnlyAccess` does
not grant `kms:Decrypt`. This would change if the parameter were ever moved to
a customer-managed key.

Step 9 will need the SCP policy actions (`CreatePolicy`, `AttachPolicy`,
`DescribePolicy`, `ListPoliciesForTarget` and friends) added to
`github-actions-org-deploy`. Add them in a PR of their own that merges and
finishes applying **before** the PR that uses them. Pairing a grant with its
consumer is the intuitive thing to do and it is wrong here; see "Apply
ordering between workflows" below for why.

## Apply ordering between workflows

Not a Pulumi dependency, a GitHub Actions one, and it is easy to miss because
the two workflows look independent.

`deploy.yml` has no path filter, so it runs on *every* push to main.
`deploy-org.yml` runs on pushes touching `deploy-org/**`. A merge that touches
both therefore starts them at the same moment, in separate concurrency groups,
with nothing sequencing them.

That is fine as long as they are genuinely independent, and they are not
whenever a PR grants `github-actions-org-deploy` a new permission. The grant
lives in `deploy/components/ci-roles/policies.ts` and is applied by the `ops`
stack, which is `deploy.yml`'s job; the code that needs the grant is applied by
`deploy-org.yml`. If the latter wins the race, it runs against the old policy
and fails with AccessDenied.

So the rule is: **a PR that widens `github-actions-org-deploy` must merge
before, and finish applying before, the PR that depends on the widening.** Same
staging reasoning step 4 already gives for role existence, extended to role
permissions. Step 4 got away with pairing the two only because the roles it
created had no consumer yet.

An earlier draft of this plan told step 9 to add its grants in the PR that
uses them. That instruction has been corrected where it appears rather than
just contradicted here, because the nearest imperative is the one a future
session will follow.

Failure here is not clean. `CreateOrganizationalUnit` succeeds and the
follow-up read fails, leaving an OU in AWS that may not be in state, and
Organizations permits duplicate OU names under one parent, so a rerun makes a
second `Workbench` rather than erroring.

## Cross-project dependencies

Pulumi resolves dependencies automatically **within** a stack, from Output
dataflow. It does nothing across stacks. Each stack is an independent state
file applied by its own `pulumi up`, and nothing sequences them or warns you
about the order.

The dependency here is one immutable string. `deploy-org/` creates the account;
`deploy-workbench/` and `identity-center.ts` both need its id.

Decision: hardcode it as a `WORKBENCH_ACCOUNT_ID` constant, and stage the PRs.
Do not use `StackReference`.

`StackReference` reads another stack's exported outputs from the backend. It
creates a data dependency inside the consuming stack, but it does not trigger
the producing stack, does not wait for it, and yields a missing output rather
than a useful error if the producer was never applied. Its only real benefit is
automatic propagation when the upstream value changes, and an account id cannot
change for the life of the account. It would also require every consuming
project to hold backend read access and the state passphrase purely to fetch a
constant.

Hardcoding also matches house style: `identity-center.ts:10` hardcodes
`ACCOUNT_ID`, and `deploy/index.ts` hardcodes subnet ids, a security group id,
the Identity Center instance ARN, and every permission set id.

Revisit `StackReference` only if a consuming project comes to need upstream
values that genuinely move.

## Implementation plan

One step per pull request. Steps are staged so no cross-stack reads are ever
needed, and so the asynchronous parts have a human gap after them.

1. Create the `aws-workbench@goodparty.org` group alias and confirm mail is
   received. Blocking: account creation strands without a working address, and
   it is the break-glass recovery path, so it must be a group rather than a
   person. The address must never have been used for another AWS account.

2. In the console, add a `SelfManageDeployPolicy` statement to
   `GitHubActionsPulumiDeployPolicy` granting `iam:CreatePolicyVersion`,
   `DeletePolicyVersion`, `SetDefaultPolicyVersion`, `TagPolicy` and
   `UntagPolicy`, scoped to that one policy ARN.

   This is unavoidably a console step. Step 3 makes Pulumi the owner of this
   policy, and Pulumi cannot grant itself the permission it needs in order to
   grant itself permissions. It should be the last console edit this policy
   ever receives.

   Not granted: `iam:CreatePolicy`, so the role cannot mint managed policies at
   all, and `iam:DeletePolicy`, a second independent barrier alongside
   `protect: true`, on the same reasoning as never granting
   `organizations:CloseAccount`.

   Scoped to one ARN rather than `*` because the program has no
   `aws.iam.Policy` resources at all: its IAM idiom is roles with inline
   policies, already covered by the unscoped `iam:PutRolePolicy`. The adopted
   policy is a standalone managed policy only because it was hand-created
   before any of this was code. If that idiom ever changes, widen to an IAM
   path prefix such as `arn:aws:iam::333022194791:policy/ops/*` rather than to
   `*`. Do not give the adopted policy a path: changing one forces a
   replacement of the policy that grants CI its permissions.

   IAM caps a policy at five versions and this one is at the cap, so delete
   v13, the oldest non-default, in order to save.

3. Adopt `github-actions-pulumi-deploy` into Pulumi, using the `import:` plus
   `protect: true` pattern that `components/identity-center.ts` already uses
   for pre-existing resources. Four resources: the role, its customer-managed
   policy, and the two `RolePolicyAttachment`s. It is currently unmanaged,
   appearing only as a string in `deploy.yml:42`, so every grant to it is an
   unreviewed console change.

   A clean no-op preview is the acceptance test, so the captured trust policy
   and document have to match AWS. Capture the document late: it changed on
   2026-09-17 while this plan was being written, adding `alert-filter-*` SNS
   and DynamoDB resources. If it drifts again between capture and merge,
   Pulumi silently reverts that change on the next apply, possibly during an
   unrelated PR.

   Do not tighten the nine-repo trust policy here. Adoption must be a
   zero-diff capture, or a clean preview stops being a meaningful check.

   Caveat: Pulumi managing the role Pulumi assumes is a bootstrapping hazard.
   `protect: true` blocks destroy and replace but not update, so a bad trust
   policy update can still lock CI out. The real mitigation is the
   `AdministratorAccess` permission set, a break-glass path that does not
   depend on CI.

4. In `deploy/`, create `github-actions-org-deploy` and
   `github-actions-workbench-deploy` with the trust and actions described in
   the deploy role section. Pure IAM, makes no Organizations calls, and applies
   with the permissions the shared role already has. This has to land before
   the projects that use them, because a CI job cannot assume a role that does
   not exist. Give both inline policies via `aws.iam.RolePolicy` rather than
   managed ones, so that step 2's statement needs no additions.

   `github-actions-workbench-deploy` ships with Pulumi backend access only.
   Its `sts:AssumeRole` statement names a role in an account that does not
   exist until step 5 and whose id is unknown until step 6, and the two ways
   to write it early are both bad: a wildcard account in the resource ARN, or
   a placeholder that rots silently. Step 7 adds the statement once the id is
   known, in the first of its two PRs, with the id written out: the
   `WORKBENCH_ACCOUNT_ID` constant lives in the other project and the grant
   has to be applied before that project exists. The role is still created
   here so both trust policies can be reviewed side by side.

5. Add the `deploy-org/` project: `Pulumi.yaml` with `name: org`, the
   `Workbench` OU, the account, and a CI job assuming
   `github-actions-org-deploy`.

   Known gap, blocking this step: the role is missing
   `organizations:ListAccountsForParent`. The OU resource exposes a computed
   `accounts` attribute, so the provider's read-back after
   `CreateOrganizationalUnit` lists the OU's children, and the role granted in
   step 4 cannot. Granted in PR #63, which has to merge and finish applying
   before this step's PR does; see the apply-ordering section above for why
   that grant cannot ride along in the same PR.

   The CI job is its own workflow file, `.github/workflows/deploy-org.yml`,
   not a second job in `deploy.yml`. Path filters are per workflow rather than
   per job, and the filter is the point: organization changes should not queue
   behind the delegate image build. It has no `pull_request` trigger either,
   and cannot have one. `github-actions-org-deploy` is trusted only for the
   subject `repo:thegoodparty/ops:ref:refs/heads/main`, so a pull_request run
   presents a ref that cannot match and the role assumption fails by design.
   The new project is added to `tsconfig.json` instead, so `deploy.yml`
   type-checks it on every PR even though it never applies it.

   ```ts
   const workbench = new aws.organizations.Account("workbench", {
     name: "goodparty-workbench",
     email: "aws-workbench@goodparty.org",
     parentId: workbenchOu.id,
     iamUserAccessToBilling: "ALLOW",
     closeOnDeletion: false,
   }, { protect: true });
   ```

   `protect: true` is not optional; it is what blocks the delete.

   Correction to an earlier draft of this plan, which claimed that removing
   the resource closes the account. It does not, by default. What a delete
   does is governed by `closeOnDeletion`, which the provider defaults to
   `false`: the account is removed from the organization and left standalone,
   not closed. Only `true` calls `CloseAccount` and starts the 90 day
   suspension window. Set it explicitly anyway. Neither outcome is quick to
   undo, since rejoining an organization needs a fresh invitation and a
   standalone account has no consolidated billing or SCP governance in the
   interim, and an implicit default is the wrong thing to be relying on.

   `CreateAccount` is asynchronous and takes minutes. Pulumi polls
   `DescribeCreateAccountStatus`. Expect the job to be slow, and expect
   failures if the email is already in use anywhere in AWS.

6. Record the new account id in the Progress section above. Then stop and let
   it settle. The account needs time to reach ACTIVE and for STS to see
   `OrganizationAccountAccessRole`; a step 7 that runs immediately can fail
   transiently in a way that looks like a permissions bug.

7. Add the `deploy-workbench/` project: `Pulumi.yaml` with `name: workbench`, a
   `WORKBENCH_ACCOUNT_ID` constant, and a CI job with a `deploy-workbench/**`
   path filter so its deploys are independent of the delegate image build.

   Two pull requests, not one, and in this order. The `sts:AssumeRole`
   statement that step 4 deferred on `github-actions-workbench-deploy` lives
   in `deploy/components/ci-roles/policies.ts` and is applied by `deploy.yml`;
   everything else here is applied by `deploy-workbench.yml`. That is the
   cross-workflow case in "Apply ordering between workflows" exactly, so the
   grant ships first and finishes applying before the project PR merges, the
   same shape as #63 before #62. Scope it to
   `arn:aws:iam::024901689212:role/OrganizationAccountAccessRole`, and revisit
   it at step 10 when that role is replaced.

   Correction to an earlier draft of this step, which had the grant riding
   along with its consumer. Noticed while recording the account id, not by
   the deploy failing, which is the cheap way to find it.

   The workflow file must be named exactly
   `.github/workflows/deploy-workbench.yml`. `github-actions-workbench-deploy`
   pins `job_workflow_ref` to that path, so any other name cannot assume the
   role, and the failure reads as a trust problem rather than a typo. Its
   provider is explicit:

   ```ts
   const provider = new aws.Provider("workbench", {
     region: "us-west-2",
     assumeRoles: [{
       roleArn: `arn:aws:iam::${WORKBENCH_ACCOUNT_ID}:role/OrganizationAccountAccessRole`,
       sessionName: "pulumi-deploy-workbench",
     }],
     allowedAccountIds: [WORKBENCH_ACCOUNT_ID],
     defaultTags: { tags: { Environment: "workbench", Project: "workbench" } },
   });
   ```

   `assumeRoles`, plural and an array, is the @pulumi/aws v7 spelling. An
   earlier draft of this snippet used the v6 singular `assumeRole`, which no
   longer type checks. The array exists for role chaining; one element is the
   ordinary case.

   This is the first project whose provider points somewhere other than the
   account its credentials belong to, which makes a new mistake possible:
   omit `{ provider }` on a resource and it lands in the *management* account
   while the apply looks clean. Two independent guards, both verified against
   pulumi 3.x and @pulumi/aws 7.23.0 rather than taken from the docs:

   - `deploy.sh` disables the default AWS provider for this stack, so a
     resource that names no provider fails with "Default provider for 'aws'
     disabled. <urn> must use an explicit provider" instead of being created
     in the management account.
   - `allowedAccountIds` on the provider catches the same error arriving the
     other way, the provider itself resolving to the wrong credentials. It
     fails with "AWS account ID not allowed: 333022194791" at provider
     configuration, before any resource is touched.

   Also settled by testing, because it changes what the project needs: an
   explicit provider that no resource uses is still registered and still
   validates its credentials, so the role is assumed on every apply whether
   or not anything consumes it. The `accountId` export is therefore evidence
   for this checklist rather than the thing that exercises the chain.

   `aws:defaultTags` stack config applies to the default provider, which this
   project disables. Tags go on the provider in code, or they silently apply
   to nothing.

8. Extend `deploy/components/identity-center.ts` to assign permission sets to
   the new account. Today `ACCOUNT_ID` is a hardcoded const used as every
   assignment's `targetId`, so this needs parameterizing to iterate over
   accounts. New assignments must not carry the `import:` option that the
   existing ones use, since there is no pre-existing AWS state to adopt.

   No grant PR in front of this one. `githubActionsPulumiDeploy` already holds
   `sso:*` on `*`, which covers creating a permission set, putting its inline
   policy, provisioning it, and creating an assignment, along with the tag and
   describe calls the provider makes around them. Checked rather than assumed,
   because steps 5, 7 and 9 all need a grant landed first and the pattern
   invites assuming this one does too.

   **Which sets.** Settled, closing the open question below. A new
   `WorkbenchAccess` set, Bedrock plus CloudWatch read, no managed policies,
   assigned to `Engineers`. Not `EngineerAccess`, which would work on day one
   since it already carries `bedrock:*`, but which also drags
   `AmazonS3FullAccess`, `ReadOnlyAccess` and two tag-conditioned
   `Action: ["*"]` statements into the account whose entire purpose is that a
   coding agent's credentials cannot reach data. Harmless while the account is
   empty, wrong the moment it is not.

   `AdministratorAccess`, the existing set, is also assigned here, to `Admins`.
   That is a real grant of full admin in the workbench account, not a
   formality, and it is worth stating plainly rather than leaving to be
   discovered. The alternative is worse: without it the only human path into
   the account is assuming `OrganizationAccountAccessRole` from the management
   account by hand, which is a shared role attributable to a person only by
   correlating CloudTrail, and which step 10 exists to retire. The permission
   set resource itself is untouched, still imported and still protected; only
   a second `AccountAssignment` is added.

   **Three things in the refactor that are not parameterization.**

   The new set's ARN is an `Output`, not a string. Every ARN in this file is
   built today as `${PS_PREFIX}/${set.id}`, which works only because every set
   already exists. A set Pulumi creates has no id until apply time, so the
   loop keeps a key-to-ARN map of type `pulumi.Input<string>` and everything
   downstream reads from it. That also supplies the ordering: the assignment
   referencing the set's `.arn` depends on the set automatically. Import
   strings are built before the apply and cannot hold an `Output`, so a second
   map holds literal ARNs for the adopt paths only, and an assignment marked
   adopted whose set has no id throws rather than importing `undefined`.

   Existing resource names must not change. A logical name is part of the URN,
   so renaming `assignment-Engineers-engineer` to
   `assignment-main-Engineers-engineer` reads as a delete plus a create, and
   `protect: true` refuses the delete and fails the apply. So the account
   entry carries a `namePrefix`, empty for the management account and
   `workbench-` for the new one. The asymmetry is ugly and deliberate; the
   alternative is an `aliases` entry on each of the eight existing
   assignments, which has to be right the first time or produces exactly the
   failure it was added to avoid.

   `protect: true` stops being conditional on `import:`. It read that way
   only because every resource in the file was adopted, and the two answer
   different questions: import is whether the resource already exists in AWS,
   protect is whether destroying it should need its own pull request.
   Deleting a permission set or an assignment revokes real access either way.
   So the new set and the new assignments are protected too, which means
   backing step 8 out is an explicit unprotect PR rather than a deletion that
   rides along in something else. Inline policies stay unprotected, as before.

   The `adopted` flag is a per-account approximation of a per-assignment fact.
   It is uniform today because every assignment in the management account
   predates Pulumi and none in the workbench account exist. Add a sixth group
   to the management account and the flag will claim the new assignment is
   importable. Split it per assignment at that point; the comment on the field
   says so too.

9. Attach an SCP to the `Workbench` OU allowing Bedrock, CloudWatch, and little
   else. Needs the policy actions added to `github-actions-org-deploy` first,
   in a separate PR that has finished applying before this one merges, per
   "Apply ordering between workflows". Write the SCP now while the account is
   nearly empty. Once four people depend on the junk it becomes impossible.

   `SERVICE_CONTROL_POLICY` is not enabled on the org root, so this step has
   to enable it first. That is a property of the organization itself rather
   than of the `Workbench` OU, so the choice is between importing the
   existing `aws.organizations.Organization` with `enabledPolicyTypes` and
   `protect: true`, or a one-time console enablement of the kind step 2 was.
   Decide that when the step is claimed, not mid-PR.

10. Replace the bootstrap role. `OrganizationAccountAccessRole` is created
   automatically when Organizations provisions a member account, but it is
   effectively administrator. Use it to stand the account up, then create a
   scoped deploy role inside the workbench account and point the
   `deploy-workbench/` provider at that instead.

11. Enable Bedrock model access in the new account. This is per account and per
   region, so it must be done again here. Enable only the models needed.

12. Request quota increases if the defaults are insufficient. These are per
    account, and a new account may start lower than our matured account.
    Budget lead time.

13. Add a budget and cost anomaly detection before handing the account to
    engineers.

14. Point `pi` at the new account and document engineer setup.

## Open questions

- ~~**Which permission set.**~~ Settled 2026-09-21 in step 8: a new
  `WorkbenchAccess` set for `Engineers`, plus the existing
  `AdministratorAccess` for `Admins` as a named break-glass path. Reasoning
  is recorded in the step rather than here.
- **Removing `bedrock:*` from `EngineerAccess` in the main account.** This is
  the actual payoff of the exercise, and it is a follow-up rather than part of
  this work. Needs care, since something may depend on it.
- **Cross-region inference profiles.** Probably worth enabling here given that
  burstiness is the defining characteristic of the workload.
- **Per-engineer cost visibility.** Application inference profiles tagged per
  engineer, or a gateway. Defer until the account exists and we can see whether
  the aggregate number is enough.
- **Region.** `us-west-2` to match the rest of our footprint. A separate region
  is no longer needed for quota isolation now that the account provides it, but
  model availability differs by region and is worth checking against the models
  we want.

## Context: the management account

Account `333022194791` is both the organization management account and the
account running production workloads. It holds the Identity Center instance and
manages permission sets and account assignments, and it also runs the delegate
Fargate cluster and the webhook Lambda.

This is contrary to the usual guidance of keeping the management account empty,
since it is the account with power to create accounts and modify SCPs. Fixing
it is a large project with no user-visible payoff and is explicitly out of
scope. It is noted here for two reasons: it is why creating this child account
is straightforward today, and the workbench account is a step in a direction we
may eventually want to keep walking.
