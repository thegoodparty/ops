# Workbench account

This document is the working plan for provisioning a second AWS account to host
developer tooling. It records the decisions and the reasoning behind them so
the work can be picked up across sessions.

## Progress

One step at a time, one pull request per step. Statuses are `todo`, `doing
(who, date)`, and `done (date, evidence)`. Evidence is a commit SHA for
in-repo work, or an AWS case number or resource id for work done outside git.

Claim a step by setting it to `doing` and pushing that change **before**
starting the work, not after. Make `who` name the *session*, not the model:
two concurrent sessions both wrote `claude` on 2026-09-22 across steps 9, 11
and 15, which left no way to tell which claim was whose and would have made
all three look abandoned together once the day-old rule below applied.
Something like `claude-scp` costs nothing. Both sessions also shared one
working tree, so check `git branch --show-current` before committing.

Steps 1, 2, 12 and 16 happen in the console or in
support cases and leave no other trace, so the claim is the only thing stopping
two sessions from doing them twice. Step 11 used to be on that list and is not
any more: it has a script now, though the terms acknowledgement inside it may
still need the console once.

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
- [x] 8. Extend `identity-center.ts` for the new account: done (2026-09-22,
      PR #69, merged as 4b86d20; the `deploy` job in CI run 35729912370
      created exactly the 4 expected resources at 12:55 UTC and deleted
      nothing. Ids recorded below. Single PR, not two: the shared deploy role
      already held `sso:*`, so unlike steps 5, 7 and 9 there was no grant to
      land first. The `dependsOn` added in review worked as intended: the
      Engineers assignment waited for `inlinePolicy-workbench` to finish
      provisioning, while the Admins one, whose set's policies were already in
      state, did not.)
- [ ] 9. Attach SCP to the `Workbench` OU: doing (claude-scp, 2026-09-22.
      Part 1 of 3 done: jeff enabled `SERVICE_CONTROL_POLICY` on root
      `r-jqqe` in the console, confirmed with `list-roots` reporting
      `Status: ENABLED`. `list-policies` returns only the AWS-managed
      `p-FullAWSAccess`, attached to both OUs and both accounts, so nothing
      is constrained and no effective permission changed, as designed.

      Part 2, the grant on `github-actions-org-deploy`, is in this PR along
      with the design revisions steps 11 and 15 forced. Flip part 2 when the
      `Deploy` run is green and `iam:get-role-policy` shows the five
      `ServiceControlPolicy*` statements on the role.

      Part 3, the `aws.organizations.Policy` and its attachment in
      `deploy-org/`, is deliberately **not** here. The grant is applied by
      `deploy.yml` and the policy by `deploy-org.yml`, and a single merge
      starts both with nothing sequencing them; see "Apply ordering between
      workflows". Same shape as #63 before #62. See "The workbench SCP" for
      the full design.)
- [ ] 10. Replace `OrganizationAccountAccessRole` with a scoped in-account role: todo
- [x] 11. Enable Bedrock model access in the new account: done (2026-09-22,
      run 35756509720 created four agreements, and every model in the
      sandbox's list now answers from a pi console. `WorkbenchAccess` holds no
      `aws-marketplace` permissions on purpose, so `scripts/enable-bedrock-models.ts`
      subscribes out of band with an admin role and the sandbox never needs
      that permission itself.

      Two findings worth keeping. The first run of this was green and did
      nothing: the idempotency check read `authorizationStatus`, which
      describes the caller, so running as an administrator made all 26 pairs
      look entitled while the sandbox was refused. `agreementAvailability` is
      the field that answers the question, and every line now prints all four
      so a wrong verdict is visible next to the numbers behind it.

      And subscription propagates across regions: four creates in `us-east-1`
      turned the same models PENDING everywhere else untouched. The region
      walk is therefore a verification pass, not the mechanism.)
- [ ] 12. Request quota increases if needed: todo
- [ ] 13. Add budget and cost anomaly detection: todo
- [ ] 14. Point `pi` at the account, document engineer setup: todo
- [x] 15. Narrow `WorkbenchAccess` to runtime needs: done (2026-09-22, PR #72.
      Mutations are gone, reads stay wide, and the invoke statement names the
      models from `utils/bedrock-models.ts` as resource ARNs. Both halves are
      confirmed by a sandbox that invokes every model on that list and
      nothing else: the scoped ARNs are right, which was the part most likely
      to break invocation.

      Resources wildcard the region and enumerate the model, deliberately the
      opposite of the shape the original `bedrock:*` comment warned about.
      Fourteen ARNs, composed policy 3698 of the 10240 byte limit.)
- [ ] 16. Raise the Identity Center authentication session duration: todo.
      Console only; there is no Pulumi resource for it, and `ssoadmin` in the
      provider covers permission sets and assignments but not this.

      `identity-center.ts` sets `sessionDuration: "PT12H"` on
      `WorkbenchAccess`, but that is the role session: how long one set of
      credentials lasts once issued. How often a human re-authenticates is
      the Identity Center authentication session, a separate setting under
      Settings then Authentication, and it is unconfigured and so at the 8
      hour default. So the 12 hour intent is only half in place and re-login
      lands mid-afternoon rather than at end of day.

      This matters more than it sounds for the coding sandbox. pi renews role
      credentials and the SSO token itself for as long as the authentication
      session lasts, so this setting, not the permission set, is the real
      ceiling on an unattended run.

Facts discovered during implementation go here as they are learned:

- Workbench account id: `024901689212`. Created 2026-09-21 13:17:15 UTC,
  ACTIVE, email `aws-workbench@goodparty.org`. This is the
  `WORKBENCH_ACCOUNT_ID` step 7 needs and the assignment target step 8 needs.
- `Workbench` OU: `ou-jqqe-dv88i5zn`, directly under root `r-jqqe`. The
  account's full path is `o-uuiolqc1di/r-jqqe/ou-jqqe-dv88i5zn/024901689212/`.
  The root has one other OU, `ou-jqqe-qxbqugvv` (`ElectionAPI`), which
  mattered in step 9: enabling `SERVICE_CONTROL_POLICY` is a root-level
  change, so `FullAWSAccess` attached there too even though no SCP of ours
  targets it. Confirmed after the fact on 2026-09-22:
  `list-policies-for-target` returns `p-FullAWSAccess` for both OUs and both
  accounts. Since `ElectionAPI` holds nothing, the effect was nil.
- `github-actions-org-deploy` ARN:
  `arn:aws:iam::333022194791:role/github-actions-org-deploy`, inline policy
  `OrgDeploy`
- `github-actions-workbench-deploy` ARN:
  `arn:aws:iam::333022194791:role/github-actions-workbench-deploy`, inline
  policy `WorkbenchDeploy`
- **`agreementAvailability` is the field that says whether access exists.**
  Not `entitlementAvailability`, and emphatically not `authorizationStatus`,
  which appears to describe the caller. The first version of the subscription
  script gated on the latter two, so run as an administrator from CI it
  reported 26 of 26 model/region pairs already entitled, created nothing, and
  exited green while the sandbox was being refused for want of a
  subscription. A check that passes because of who is asking is worse than no
  check. The script now prints all four fields on every line, so the next
  disagreement between verdict and reality is visible rather than inferred.
- **Bedrock enables every model by default, so there is no allowlist under
  us.** Access is on in all commercial regions, and Bedrock subscribes in the
  background on first invocation, provided the invoking role holds
  `aws-marketplace:Subscribe`. AWS's guidance is that blocking a model means a
  Deny or a scoped Allow on `bedrock:InvokeModel`, not withholding a
  subscription. That is why `WorkbenchAccess` names its models as resource
  ARNs: that statement is the allowlist, and it is the only one.
- **"Worked a few times, then AccessDenied" is the documented shape of a
  failed background subscription**, not necessarily a routing problem. AWS:
  during the setup period, up to fifteen minutes, calls may succeed while the
  subscription is finalised, and if a prerequisite is missing the attempt
  fails and subsequent calls return AccessDeniedException. `WorkbenchAccess`
  had no `aws-marketplace` permissions and no managed policies, so the
  prerequisite was missing.

  This was first diagnosed here as cross-region routing, which fits the
  symptom less well: routing would keep flip-flopping rather than settling
  into a steady refusal. Recorded because the wrong diagnosis is plausible
  enough to be reached again.
- **Cross-region inference is still worth knowing about**, even though it was
  not the cause. The `us.` ids route each request across the profile's member
  regions rather than staying in `AWS_REGION`, and member sets differ per
  model: the Anthropic profiles span three regions, `us.moonshotai.kimi-k3`
  spans five. This is why the IAM resources wildcard the region and enumerate
  the model rather than the reverse.
- **Models the coding sandbox uses** live in `utils/bedrock-models.ts`, one
  list imported by both the IAM policy that permits them and the script that
  subscribes to them. Geo profiles unless noted: `anthropic.claude-opus-5`,
  `anthropic.claude-sonnet-5`, `xai.grok-4.6`, `openai.gpt-5.6-sol`,
  `openai.gpt-5.6-terra`, `moonshotai.kimi-k3`, plus `zai.glm-5` and
  `deepseek.v3.2` kept region-pinned by choice.
- **The Anthropic first-time-use form is assumed already submitted.** It is
  required once per account or once at the organization's management account,
  and a submission at the root is inherited by every account in the
  organization. The management account has been using Bedrock, so this should
  be covered; it is an assumption rather than something checked. If it is not,
  `PutUseCaseForModelAccess` takes `companyName`, `companyWebsite`,
  `intendedUsers`, `industryOption`, `otherIndustryOption` and `useCases`.
- **`us.moonshotai.kimi-k3` has no in-region support in any region**, so a geo
  profile is mandatory for it rather than a preference. Its model card also
  lists `ca-central-1` as geo-supported while its prose says the `us.` profile
  routes only among US-geography regions to respect US data residency. Those
  disagree, and the script leaves `ca-central-1` out pending a resolution.
  Worth settling deliberately given what GoodParty holds: if routing does
  reach it, K3 fails intermittently until it is added.
- **Kimi K3 through Converse is documented as broken for multi-turn
  reasoning.** AWS's card says Converse raises `InternalServerException` when
  reasoning content from earlier turns is included, and recommends the
  OpenAI-compatible APIs instead. pi only speaks Converse, so `gp-pi` declares
  the model with reasoning disabled to keep prior thinking blocks out of the
  request. Not an account-side problem; recorded here because it constrains
  which models are worth enabling.
- In-account workbench deploy role ARN: _not yet created_
- `WorkbenchAccess` permission set id: `ps-3aaed742183e3885`, full ARN
  `arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/ps-3aaed742183e3885`.
  Created 2026-09-22 12:55:23 UTC. Unlike every other set in
  `identity-center.ts`, this one is created by Pulumi rather than adopted, so
  its id was not known until step 8 applied. It is recorded here for
  reference only: do **not** add it to the `permissionSets` entry, because an
  `id` there is what switches the resource from create to import, and
  importing a resource Pulumi already owns is not a no-op.
- Workbench account assignments, both created 2026-09-22 12:55 UTC:
  `Engineers` (`383193a0-7001-70d9-a321-ffe6d8af7378`) to `WorkbenchAccess`,
  and `Admins` (`88c1b330-a001-707a-06ca-94e289013bf5`) to
  `AdministratorAccess`, each with `targetId` 024901689212. The `Admins` one
  is a deliberate full-admin grant in the workbench account, kept as a named
  break-glass path so the only way in is not assuming
  `OrganizationAccountAccessRole` by hand; revisit it at step 10.
- SCPs enabled on org root: `SERVICE_CONTROL_POLICY`, since 2026-09-22.
  Enabled by jeff in the console as part 1 of step 9, because it is a
  property of the organization rather than of the OU; see "The workbench SCP"
  for why that was not done in code. The only policy in the organization is
  the AWS-managed `p-FullAWSAccess`, which AWS attached automatically to the
  root, both OUs and both accounts on enablement, so nothing is constrained
  and no effective permission changed.
- Organization facts checked while designing step 9, all as of 2026-09-22:
  `FeatureSet` is `ALL`; there are no delegated administrators; `ElectionAPI`
  (`ou-jqqe-qxbqugvv`) holds no accounts and no child OUs; the only account
  directly under root `r-jqqe` is the management account. Together these are
  why enabling the policy type changed nothing anywhere, and why nothing
  inside the workbench account can move itself out of the OU.
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

Step 9 will need the SCP policy actions added to
`github-actions-org-deploy`. The list, and the two scoping checks that grant
has to pass, are in "The workbench SCP" below rather than here. Add them in a
PR of their own that merges and finishes applying **before** the PR that uses
them. Pairing a grant with its consumer is the intuitive thing to do and it
is wrong here; see "Apply ordering between workflows" below for why.

## The workbench SCP

Design for step 9, settled 2026-09-22 before implementation. The plan told
step 9 to decide the enablement question when the step was claimed rather
than mid-PR; this section is that decision, plus the policy shape.

### What an SCP does, and what it does not

A Service Control Policy attaches to a root, an OU, or an account and sets a
ceiling on what IAM inside those accounts may permit. It grants nothing.
Effective permission is the intersection of every SCP down the tree and IAM.

What makes it worth the trouble is that the ceiling cannot be raised from
inside the account. It is set from the management account, so an account
administrator, or that account's root user, can neither edit it nor escape
it.

Two exemptions matter here, both structural rather than configuration:

- **SCPs never apply to the organization's management account.** For us that
  is 333022194791, which is also where production runs. This mechanism will
  never protect prod, and no SCP we write should be reasoned about as though
  it might.
- **They do not apply to service-linked roles.**

### Why the workbench account wants one

The justification for this whole account, in "Why a separate account" above,
is the data argument: that the boundary makes "a coding agent cannot reach
restricted L2 voter data" structurally true rather than a matter of policy.

That is not yet true. What makes it true today is that the account is empty
and nobody has put anything in it. IAM inside the account can grant up to
full administrator, and step 8 deliberately assigned `AdministratorAccess`
there as a named break-glass path. So the present guarantee is a promise, not
a boundary. The SCP is what converts it.

Three concrete things it buys:

1. **A ceiling on the coding agent.** An agent running semi-autonomously with
   credentials in this account is the point of the account. If it, or a
   prompt injection, or a bad script, mints an IAM user with long-lived keys,
   starts compute in a region nobody watches, or stops CloudTrail, the SCP
   refuses regardless of what IAM says.
2. **A ceiling on the step 8 admin grant.** `AdministratorAccess` in the
   workbench account currently has nothing above it. An SCP is the only thing
   that can sit above an account administrator.
3. **A brake on drift.** This is the "once four people depend on the junk it
   becomes impossible" point. Without a ceiling the cheap thing is for
   someone to put a bucket of voter data here next quarter because it was
   convenient, and at that moment the account's reason for existing is gone.

### Enabling the policy type: console, once

`SERVICE_CONTROL_POLICY` is not enabled on the organization root, so no SCP
can attach anywhere until it is. That is a property of the organization
rather than of the `Workbench` OU.

**Decision: a one-time console enablement, recorded here the way step 2 was.
`aws.organizations.Organization` stays unmanaged.**

Rejected: importing that resource with `enabledPolicyTypes` and
`protect: true`. Step 3's instinct, that an unmanaged resource means every
change to it is an unreviewed console change, is right in general and wrong
here for two reasons.

The import has to capture `awsServiceAccessPrincipals` exactly. That list
holds trusted access for `sso.amazonaws.com` among others. An incomplete
capture does not fail loudly; it disables trusted service access on the next
apply, which would break the Identity Center assignments step 8 just created.
That is the same zero-diff-capture hazard step 3 managed, with a much worse
failure mode.

It also means granting `github-actions-org-deploy` write over the whole
Organization resource, `DisableAWSServiceAccess` included. That is far
broader than anything it holds today, and it is granted permanently in order
to flip one boolean once.

Against that cost, what code management buys here is close to nothing: one
attribute, flipped a single time, whose value never changes again.

Enablement must be done from an `AdministratorAccess` session.
`adminReservedActions` denies `organizations:Enable*` to every other
permission set, `EngineerAccess` included. That is the guardrail working as
designed, not an obstacle to route around.

### Blast radius of the enablement: verified nil

Enabling attaches AWS's managed `FullAWSAccess` policy to the root, every OU
and every account automatically, which is what makes the enablement itself a
no-op. Checked against AWS on 2026-09-22 with `gp-readonly` rather than
reasoned about:

- `Organization.FeatureSet` is `ALL`, so SCPs are available and no
  enable-all-features handshake is needed first. Had it been consolidated
  billing only, the handshake would still have been a non-issue, since the
  only member account has `JoinedMethod: CREATED` and created accounts do not
  approve.
- `ElectionAPI` (`ou-jqqe-qxbqugvv`) contains no accounts and no child OUs. It
  is an empty branch.
- The only account directly under root `r-jqqe` is the management account,
  333022194791.
- Root `PolicyTypes` is still `[]`.

So after enabling, every account in the organization is either exempt by rule
(the management account) or carries `FullAWSAccess` (the workbench account).
No account's effective permissions change. This is a safer console change
than step 2, which actually granted something.

It is also reversible: the policy type can be disabled again once every
non-default policy is detached.

### Policy shape: deny list alongside FullAWSAccess

**Decision: attach a deny-list SCP to the `Workbench` OU, leaving
`FullAWSAccess` in place. Not an allow-list that replaces it.**

Two reasons, and the second is the one that changed the answer.

SCP denials are hard to diagnose. The `AccessDenied` does not always name the
SCP, and the person hitting it usually has correct IAM permissions and no
idea why they are being refused. A deny list fails in a small number of
predictable places; an allow-list fails everywhere it forgot about.

More importantly, an allow-list means detaching `FullAWSAccess`, and
enablement has just made that policy a thing that can be detached. Remove it
without a complete replacement and every member account loses everything at
once. Keeping it attached and layering denies on top means the failure mode
of a mistake in our policy is one service refused, not an account that
stopped working.

Attach to the OU, not the account, so a second workbench account inherits it.

### What the policy denies

Written to bound the account, not to minimise it. The tightening pass belongs
after step 14, when we know what the inner loop actually uses.

Revised 2026-09-22 after steps 11 and 15 landed in PR #72. Two of the entries
below changed as a direct result, and both changes are the same lesson: this
policy binds `OrganizationAccountAccessRole`, which is the identity CI itself
uses inside the account, so a guardrail written carelessly does not merely
inconvenience an engineer, it breaks the pipeline that maintains the account.
Check any future addition against what `deploy-workbench.yml` does, not only
against what a person does.

- `organizations:LeaveOrganization`. Leaving strands the account outside
  consolidated billing and outside every governance control at once.
- `iam:CreateUser`, `iam:CreateAccessKey`, `iam:CreateLoginProfile`. Access
  here is federated through Identity Center; long-lived keys in an account
  aimed at autonomous agents are the credential most likely to escape it.
  Deliberately not `iam:CreateRole`: step 10 creates a scoped in-account
  deploy role and needs it.
- `cloudtrail:StopLogging`, `DeleteTrail`, `UpdateTrail`,
  `PutEventSelectors`. There may be no trail in this account yet, which makes
  these inert today and correct the moment there is one.
- `rds:*`, `dynamodb:*`, `redshift:*`. The data argument, made structural.
  These are the stores that would make the account worth attacking, and
  nothing about running coding agents needs them.
- S3 against buckets this account does not own, conditioned on
  `aws:ResourceAccount` not equal to 024901689212. See below: this replaces
  an earlier decision to leave S3 alone.
- Everything outside `us-west-2`, conditioned on `aws:RequestedRegion`, with
  a `NotAction` exemption for global services (`iam`, `sts`, `organizations`,
  `account`, `support`, `budgets`, `ce`, `cloudfront`, `route53`) and for
  `bedrock` and `aws-marketplace`. Without the global exemption the region
  deny refuses global calls, which are recorded against `us-east-1`. The
  other two are explained next.

#### The two region exemptions, both load-bearing

`bedrock` was exempted on suspicion when this section was first written: the
reasoning was that cross-region inference profiles route internally, that the
caller's `aws:RequestedRegion` should therefore still be `us-west-2`, and
that "should" was doing too much work to risk it.

Step 11 turned that suspicion into evidence. A sandbox session invoked
Bedrock successfully several times and then failed with AccessDenied from
identical input, because `us.`-prefixed model ids are geo profiles that route
each request across member regions by capacity. That is not proof about the
SCP condition key specifically, since model entitlement is checked by the
service in the destination region rather than against the caller's request
context. It is proof that this workload genuinely spans regions and that the
failure mode is intermittent, which is the worst kind to introduce with a
guardrail. Keep the exemption.

`aws-marketplace` is the entry that was missing, and it would have bitten.
Step 11's `scripts/enable-bedrock-models.ts` subscribes to model agreements,
which needs `aws-marketplace:Subscribe`, and it walks `us-east-1`,
`us-east-2`, `us-west-1` and `us-west-2`. `deploy-workbench.yml` runs it with
`APPLY=1` after every apply. So the region deny as first drafted would have
refused the subscribe call in three of the four regions.

This is live, not latent, which is worth pinning down because the first
version of this paragraph got it wrong. The pre-#73 script reported all 26
model/region pairs `already-entitled` by reading the wrong field, so the
subscribe path looked dormant and the gap looked like something that would
bite months later. #73 fixed the check, and the next run created 4
agreements with 12 more pending propagation, in `us-east-1`, `us-east-2` and
`us-west-1` as well as `us-west-2`. The region deny as first drafted would
have broken the running pipeline on its first apply.

Even had it been dormant it would have been worth fixing: the same shape as
the `TagResource` without `UntagResource` defect from the step 4 review, a
write set complete for today's state that fails partway once the state
moves. The correction here is only about how quickly it would have shown up.

#### S3: denied cross-account, which resolves an earlier deferral

The first draft of this section left S3 alone and said to revisit at step 11,
on the grounds that Bedrock uses S3 for batch inference and invocation
logging and a blanket deny would block features we might want.

Step 11 is now done and needs no S3 at all. So the deferral resolves, and it
resolves toward denying, because the thing worth protecting against was never
this account's own buckets. It was reaching the management account's.

The deny is therefore scoped by resource owner rather than by service:
`s3:*` on resources whose `aws:ResourceAccount` is not 024901689212. The
account keeps full use of buckets it owns, so batch inference and invocation
logging remain available if step 11's follow-ups want them, and "a coding
agent cannot reach restricted L2 voter data" stops depending on anyone's
judgement about which buckets exist.

Two caveats to check when writing it rather than at review.
`aws:ResourceAccount` is not honoured by every service and AWS documents
exceptions, notably for some AWS-owned resources accessed on the caller's
behalf; the exceptions published for S3 are what matter here. And a
cross-account deny of this shape blocks reading public buckets too, which is
fine for this account and would not be for a general-purpose one.

Jeff's call on 2026-09-22, in his words, was to do the deny now and loosen
later if needed. That direction is the right way round for this account: a
loosening is a reviewed PR against a working system, while the absence of the
deny is invisible until it matters.

Deliberately **not** denied:

- **GuardDuty tamper protection.** Standard in a policy like this, omitted
  only because it is unclear whether we run GuardDuty at all. Add it if we
  do; a deny for a service nobody runs is harmless but so is leaving it out.

SCPs cap at 5120 bytes including whitespace. The list above is nowhere near
it, but an allow-list version would have been closer, which is one more small
argument for the shape chosen.

### What this does not protect

Worth stating plainly so the control is not credited with more than it does.

It does nothing for the management account, which is where production runs.
It does not apply to service-linked roles. And it constrains principals in
the account, not the account's exposure to the outside: a resource policy
that shares something publicly is a different control.

It also stops applying if the account leaves the OU, which is worth being
explicit about because attaching at the OU is what buys inheritance for a
second workbench account later. Checked on 2026-09-22 rather than assumed:
nothing inside the workbench account can perform that move. Organizations
write actions are callable only from the management account or a delegated
administrator, and `list-delegated-administrators` returns empty, so a
coding agent holding credentials in 024901689212, which is the threat this
policy exists for, cannot move itself out from under it.

Moving it needs management-account admin, and that principal can detach the
policy outright, so the move grants no capability that was not already
there. The one path worth naming is CI:
`github-actions-org-deploy` holds `organizations:MoveAccount` on `*`, so a
merged PR touching `deploy-org/` could move the account out of the OU. That
is the same bar as editing the SCP itself, since CODEOWNERS gates that path
and the workflow directory both, so it is a fact to know rather than a gap
to close. Revisit if that role's trust or the CODEOWNERS gate ever loosens.

### The grant this needs first

Written and landed as part 2 of step 9. `github-actions-org-deploy` held OU
and account actions only, nothing about policies.

Added, all five statements conditioned on
`organizations:PolicyType` equal to `SERVICE_CONTROL_POLICY`, so enabling tag
policies or backup policies on the root later does not silently widen this
role: those are the same API with a different policy type, and an
ARN-scoped grant would pick them up for free.

- `CreatePolicy`, `UpdatePolicy`, `DeletePolicy`, scoped to this
  organization's SCP namespace.
- `AttachPolicy`, `DetachPolicy`, scoped to that namespace **and** the
  `Workbench` OU.
- `DescribePolicy`, `ListTargetsForPolicy`, the provider's read-backs, same
  namespace.
- `ListPoliciesForTarget`, scoped to the OU.
- `ListPolicies`, unscopable and therefore `*`.

Not `EnablePolicyType` or `DisablePolicyType`. Enablement is the console step
above, and the role that applies the policy should not be able to turn off
the mechanism the policy depends on.

The two review checks this grant was written against, and what each turned up:

**The paired-action check.** `CreatePolicy` without `UpdatePolicy` fails the
first time the document changes, which for an SCP is the first tightening
pass and therefore close to certain. `AttachPolicy` without `DetachPolicy`
fails the first time the attachment moves. `DeletePolicy` is included even
though nothing in the plan deletes a policy, because removing the resource
from the program is how a bad SCP gets withdrawn and discovering a missing
grant at that moment is discovering it at the worst one. That reasoning does
not extend to `CloseAccount` or `RemoveAccountFromOrganization`, which stay
absent: deleting a service control policy destroys nothing and is undone by
reapplying.

**The self-undermining check.** `AttachPolicy` and `DetachPolicy` on `*`
would let this role detach `FullAWSAccess` from the root, the one action that
breaks every member account at once, using a role whose purpose is to apply a
policy constraining a lower-trust account.

Checking the resource types rather than assuming them, as this section
originally said to, changed the answer twice.

First, the actions are scopable. Verified against AWS's machine-readable
service reference, the source `adminReservedActions` was built from:
`AttachPolicy` and `DetachPolicy` accept `account`, `organizationalunit`,
`policy` and `root`, and a request naming both a policy and a target must be
permitted for both. So listing only our namespace and only the `Workbench` OU
is two independent bounds at once. This role cannot attach our policy to the
root, and it cannot touch a policy we do not own.

Second, and better than the scoping: AWS-managed policies are not in this
organization's namespace at all. `FullAWSAccess` is
`arn:aws:organizations::aws:policy/service_control_policy/p-FullAWSAccess`,
with `aws` where the account id belongs and no `o-` segment. Confirmed with
`describe-policy` against live AWS, because the published ARN format string
does not show this case. So the pattern
`arn:aws:organizations::333022194791:policy/o-uuiolqc1di/service_control_policy/*`
cannot match it under any wildcard. The role is structurally unable to name
the dangerous policy rather than merely scoped away from it.

The same check found that the two pre-existing writes are scopable too and
are not scoped. `CreateOrganizationalUnit` accepts `organizationalunit` and
`root`; `MoveAccount` accepts `account`, `organizationalunit` and `root`;
only `CreateAccount` genuinely takes no resource. That is a known wart rather
than a considered choice, and narrowing `MoveAccount` to the `Workbench` OU
would also close the move vector recorded under "What this does not protect".
Worth its own PR, one that can check the exact ARNs the provider sends
against existing state, rather than riding along with step 9.

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

   Assignments must wait for their set's policy resources. Creating a
   `ManagedPolicyAttachment` or a `PermissionSetInlinePolicy` calls
   `ProvisionPermissionSet`, and creating an `AccountAssignment` provisions
   the set into its account with whatever is attached at that moment. All
   three take only `permissionSetArn`, so the Output graph makes them
   siblings and Pulumi runs them in parallel. The end state converges
   regardless, because the policy resources re-provision to every assigned
   account, so the failure is not a permanently empty permission set. It is
   two provisioning operations in flight on one set, which Identity Center
   answers with a ConflictException, and which reads as a deploy that failed
   for no reproducible reason. An explicit `dependsOn` serializes them.
   Raised by Bugbot on PR #69; it never bit before because every resource in
   this file was adopted and nothing was ever created.

   The `adopted` flag is a per-account approximation of a per-assignment fact.
   It is uniform today because every assignment in the management account
   predates Pulumi and none in the workbench account exist. Add a sixth group
   to the management account and the flag will claim the new assignment is
   importable. Split it per assignment at that point; the comment on the field
   says so too.

9. Attach an SCP to the `Workbench` OU. Designed in full in "The workbench
   SCP" above; read that section before starting, not this summary. Write it
   now while the account is nearly empty. Once four people depend on the junk
   it becomes impossible.

   Three parts, in this order:

   1. A console enablement of `SERVICE_CONTROL_POLICY` on root `r-jqqe`, from
      an `AdministratorAccess` session, since `adminReservedActions` denies
      `organizations:Enable*` everywhere else. Verified nil blast radius: no
      account in the organization changes effective permissions. Record it in
      Progress above the way step 2 was recorded, since it leaves no git
      trace.
   2. A grant PR adding the policy actions to `github-actions-org-deploy`,
      merged **and finished applying** before the third part, per "Apply
      ordering between workflows".
   3. The `aws.organizations.Policy` and its attachment to the `Workbench`
      OU, in `deploy-org/`.

   Corrections to an earlier draft of this step, both now resolved in the
   design section rather than left open. It said to decide the enablement
   question when the step was claimed: decided, console, with the import of
   `aws.organizations.Organization` rejected because capturing
   `awsServiceAccessPrincipals` wrong would disable trusted access for
   Identity Center. And it described the policy as "allowing Bedrock,
   CloudWatch, and little else", which is an allow-list: rejected in favour
   of a deny list layered on top of `FullAWSAccess`, because an allow-list
   means detaching `FullAWSAccess` and any gap in it takes the account out
   entirely.

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
- ~~**Cross-region inference profiles.**~~ Settled by circumstance rather than
  by decision: the model ids pi ships are already geo profiles, so we are
  using them. The cost is in the facts above, and it is that enablement is per
  member region and getting it wrong fails intermittently.
- **Per-engineer cost visibility.** Application inference profiles tagged per
  engineer, or a gateway. Defer until the account exists and we can see whether
  the aggregate number is enough.
- ~~**Region.**~~ Settled. `us-west-2` is where requests are sent and where the
  two region-pinned models live, matching the rest of our footprint. The check
  this asked for mattered more than expected: availability does differ by
  region, and because the geo profiles route away from `us-west-2` anyway,
  "the region" is a set rather than one place. See the facts above.

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
