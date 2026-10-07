# Infrastructure account

This document is the working plan for provisioning a third AWS account to run
internal automation and machinery. It records the decisions and the reasoning
behind them so the work can be picked up across sessions, the same way
[`workbench-account.md`](./workbench-account.md) does for the inner loop.

Read the workbench document first. This one assumes its vocabulary — the
management account is `333022194791` and is also production; the workbench
account is `024901689212`; the `ops` repo holds four Pulumi projects; and the
"apply ordering between workflows" and "cross-project dependencies" sections
there are the rules this plan is staged against. They are not repeated here.

## Progress

One step at a time, one pull request per step. Statuses are `todo`,
`doing (who, date)`, and `done (date, evidence)`. Evidence is a commit SHA for
in-repo work, or an AWS case number or resource id for work done outside git.

Claim a step by setting it to `doing` and pushing that change **before**
starting the work, not after. Make `who` name the *session*, not the model.

- [x] 1. Create and verify the `aws-infrastructure@goodparty.org` group alias:
      done (2026-10-05, jeff, group created and confirmed in session; not
      independently verified from here). Blocking: account creation strands
      without a working address, and the alias is the root-user recovery path.
      It must be a group rather than a person, and it must never have been
      used for any other AWS account.
- [x] 2. Add the `Infrastructure` OU and the `goodparty-infrastructure`
      account in `deploy-org/`: done (2026-10-05, pi-infra-step2, PR #238
      merged as 6609eb9. The `Deploy org` run 37354688503 was green at 18:18
      UTC, created exactly the 2 expected resources and nothing else, and the
      account reached `ACTIVE` at 18:18:31Z with id `394495727159` inside the
      new OU `ou-jqqe-orrk423t`. No grant PR in front of it; the existing
      `github-actions-org-deploy` policy already covered OU and account
      creation and the reads that followed. Ids recorded in the facts below.)
- [x] 3. Record the account id and OU id below, then let it settle: done
      (2026-10-05, pi-infra-step3). Ids recorded in the facts below, and
      `INFRASTRUCTURE_ACCOUNT_ID` added to `utils/accounts.ts`. The apply's
      outputs report `Status` and `State` both `ACTIVE`, so the Organizations
      half of the settle is over. The other half, STS seeing
      `OrganizationAccountAccessRole`, is unverified and cannot be checked from
      the `WorkbenchAccess` session this ran in: the assume is the first thing
      step 7 does, so a transient failure there is the expected place to find
      out, not a permissions bug. Step 4 does not wait on it.
- [x] 4. Widen `github-actions-org-deploy`'s service-control-policy grant to
      the new OU: done (2026-10-05, pi-infra-step4, PR #241 merged as 61a94c9.
      The merge's CI run 37360050783 was green at 19:05 UTC: it updated
      `github-actions-org-deploy`'s inline `OrgDeploy` policy (4 updated, 74
      unchanged) and the applied document carries the Infrastructure OU ARN in
      both `ServiceControlPolicyAttachment` and
      `ServiceControlPolicyListingForTarget`. Read from the apply log rather
      than an `iam:get-role-policy`, because no management-account SSO token
      was live; the log shows the document Pulumi actually sent, which is the
      same read-back shape workbench step 9 part 2 used. That is the evidence
      step 5's attach will not be refused.)
- [x] 5. Add the `Infrastructure` SCP and its attachment in `deploy-org/`: done
      (2026-10-05, pi-infra-step5). `deploy-org/policies.ts` holds
      `infrastructureScp` and `deploy-org/index.ts` the `aws.organizations.Policy`
      and `PolicyAttachment`, following `workbenchScp` and its comments. Three
      statements, per "The infrastructure SCP" below; one is deliberately
      tighter than workbench's, since review pointed out that denying only the
      `Create` actions still lets an existing access key be re-enabled. The
      three denies the
      workbench policy carries that are deliberately absent here are recorded
      as exclusions rather than left to look like omissions. Unprotected,
      deliberately: the failure mode of an SCP is denying something real, and
      the way out sits outside the policy — SCPs never apply to the management
      account, and github-actions-org-deploy can detach from exactly the two
      OUs it can attach to. Marked done in the PR that creates it, per workbench
      step 13: the merge's `Deploy org` run is the read-back, so a red run
      beside this entry means the entry is wrong in the visible way. It has to
      be green before step 7, because this policy binds the in-account
      `pulumi-deploy` role step 7 creates.
- [x] 6. Create `github-actions-infrastructure-deploy` in `deploy/` with
      Pulumi backend access and the bootstrap `sts:AssumeRole` grant: done
      (2026-10-07, pi-swarm-infra-step6). The role and its inline
      `InfrastructureDeploy` policy are in `deploy/components/ci-roles.ts`
      and `ci-roles/policies.ts`, following the workbench role. One
      difference from that precedent, and it is a simplification: workbench
      step 4 created its role with backend access alone because the account
      id was not known yet, and step 7 added the assume grant in a PR of its
      own. Here the id was recorded at step 3, so the bootstrap grant ships
      with the role and there is no deferred statement. A local preview of
      the `ops` stack planned exactly the two creates, the role and its
      policy, and 84 unchanged. Trusted only by `deploy-infrastructure.yml`
      on `main`, which does not exist yet, so the role is inert on merge and
      step 7 must use exactly that filename. Marked done in the PR that
      creates it, per step 5: the merge's `deploy.yml` run is the read-back,
      so a red run beside this entry means the entry is wrong in the visible
      way. It has to be green before step 7 merges.
- [ ] 7. Add the `deploy-infrastructure/` project and its CI job: doing
      (pi-swarm-infra-step7a, 2026-10-07). Two
      pull requests, forced by bootstrap causality, the same shape as
      workbench steps 7 and 10: the first applies against
      `OrganizationAccountAccessRole` and creates the in-account `pulumi-deploy`
      and `pulumi-preview` roles; the second repoints the provider at
      `pulumi-deploy` and removes the bootstrap grant.
- [ ] 8. Extend `identity-center.ts` to assign `Admins` to
      `AdministratorAccess` in the new account: todo. This is the human admin
      path — the "admin role" a member of the admin group picks at SSO sign-in.
      No grant PR in front of it; the shared deploy role already holds
      `sso:*`.
- [ ] 9. Harden the account's root user, in the console: todo. Enable MFA,
      remove any root access keys, and set the alternate contacts. The group
      alias from step 1 is the recovery path, not the daily driver.
- [ ] 10. Spend threshold alerts by email: todo. One `aws.budgets.Budget` in
      `deploy-infrastructure/` with notifications to the step 1 group alias,
      mirroring workbench step 13.
- [ ] 11. Extend the PR preview role and workflow to cover the new project:
      todo. Design in "PR previews" below.
- [ ] 12. Document how an admin reaches the account, and whether the container
      gets a profile for it: todo.

## Goal

Provision a child AWS account, `goodparty-infrastructure`, to run internal
automation and machinery. The first concrete uses are build automation,
temporary privilege escalation, periodic scans and automated maintenance.

## Why a separate account

The workbench account's justification was the absence of an availability
obligation plus a data boundary. This account's justification is different and
worth stating plainly, because it is the more privileged of the two.

Automation that runs internal processes is exactly the workload that wants
broad permissions. Temporary privilege escalation needs to assume roles
elsewhere. Automated maintenance may need to touch other accounts. Periodic
scans need to read across services and regions. That is a lot of capability to
park next to production.

The management account is both the organization's management account and the
account running production, which the workbench document already flags as
contrary to the usual guidance. Adding privileged automation there compounds
that problem rather than solving it: a compromise or a bad script reaches the
organization itself.

Three things the boundary buys:

1. **A blast radius that is not production.** Automation runs with the
   permissions it needs, and the worst case is the automation account rather
   than the account that can create accounts and edit SCPs.
2. **A credential boundary.** Automation credentials — OIDC sessions, roles
   assumed into other accounts, whatever the scanners hold — live in one
   account that can be reasoned about on its own.
3. **The data boundary still holds.** No product or voter data belongs here
   either. That argument is inherited from the workbench plan and is not
   weakened by this account's higher privilege.

The honest counterpoint, recorded so it is not discovered later: build
automation carries an availability obligation that the workbench account
deliberately does not. If the build runners cannot run, releases block. So this
account is closer to operational infrastructure than to the inner loop, and its
guardrails should be reasoned about that way. It is not a sleepy account.

## What belongs here

The test: is it an internal process that runs without a human in the loop,
carries no product data, and does not need to live in production?

Belongs here: CI runners and build automation, build caches, image builds,
temporary privilege escalation / just-in-time access tooling, periodic security
and compliance scans, drift detection, cost scans, automated maintenance and
rotation jobs.

Does not belong here: product environments, the developer inner loop (that is
the workbench account), and anything that holds product or voter data as a
system of record.

The agent-swarm deployment (the Delegate swarm) runs here, by Swain's decision
on 2026-10-07. It reaches production read-only, through a role in the
management account, rather than holding production credentials in this
account.

The failure mode is the same junk drawer the workbench plan names, with a
sharper edge: because this account is expected to hold broad permissions, an
unrelated workload parked here inherits them. The SCP below is the brake, not
the name.

## Naming

| Thing | Value |
|---|---|
| AWS account name | `goodparty-infrastructure` |
| Root email | `aws-infrastructure@goodparty.org` |
| Organizations OU | `Infrastructure` |
| Pulumi project directory | `deploy-infrastructure/` |
| Pulumi project name | `infrastructure` |
| Pulumi stack | `organization/infrastructure/main` |
| Default tags | `Environment: infrastructure`, `Project: infrastructure` |
| CI deploy role | `github-actions-infrastructure-deploy` |
| In-account roles | `pulumi-deploy`, `pulumi-preview` |

Rejected names:

- `platform` and `shared-services`: both are the junk-drawer words again. They
  describe an aspiration rather than a boundary and offer no resistance to
  anything being parked here.
- `automation`: accurate for phase one but narrower than what the account will
  hold; it would read as wrong the first time a scan or a maintenance job lands
  in it.
- `ops`: collides with the existing `ops` Pulumi project and the `ops` stack.
  The account name would be the third meaning of the word in one repo.

One accepted wart: the management account's resources are tagged
`Environment: infra` (the `ops` stack) and the org stack is tagged
`Project: org`. `Environment: infrastructure` is visually close to `infra`.
The two are distinguishable and tags are scoped per account, so this is
recorded rather than solved. If it ever causes a wrong-target mistake, the fix
is to rename the tag on the new stack, which is a one-line change.

## Repo and Pulumi structure

Same repo, four Pulumi projects. The reasoning is unchanged from the workbench
document: which account a resource lands in is the provider's decision, stacks
are state and locking boundaries rather than account boundaries, and Identity
Center permission sets are organization-level and already live here.

| Project | Stack | Account | Role |
|---|---|---|---|
| `deploy/` (existing) | `organization/ops/ops-dev` | `333022194791` | `github-actions-pulumi-deploy` |
| `deploy-org/` (existing) | `organization/org/main` | `333022194791` | `github-actions-org-deploy` |
| `deploy-workbench/` (existing) | `organization/workbench/main` | `024901689212` | `github-actions-workbench-deploy` |
| `deploy-infrastructure/` (new) | `organization/infrastructure/main` | infrastructure | `github-actions-infrastructure-deploy` |

`deploy-infrastructure/` is the second project whose provider points at a
different account than its credentials, so it copies `deploy-workbench/`'s two
guards exactly: `deploy.sh` disables the default AWS provider, so a resource
that omits `{ provider }` fails rather than landing in the management account,
and the provider sets `allowedAccountIds`, so a provider resolving to the wrong
credentials fails before any resource is touched.

## The deploy role

`github-actions-infrastructure-deploy`, created by the `ops` stack, trusted
only for `repo:thegoodparty/ops:ref:refs/heads/main`, holding Pulumi backend
access for the `infrastructure` project and `sts:AssumeRole` into the account.

Two things differ from the workbench role, both because of the SCP:

- The bootstrap target is `OrganizationAccountAccessRole`, which the
  Organizations-planted role trusts to the management account **root**. The
  first apply needs it because no in-account role exists yet. Step 7's second
  PR replaces it with an in-account `pulumi-deploy` whose trust names exactly
  this CI role, and removes the bootstrap grant. That narrowing is the security
  content, and it matters more here than it did for workbench.
- The in-account `pulumi-deploy` role is subject to the Infrastructure SCP.
  Anything the SCP denies is denied to the pipeline that maintains the account,
  so every future addition to the SCP has to be checked against what
  `deploy-infrastructure.yml` does, not only against what a person does. The
  workbench plan learned this the hard way with `aws-marketplace`; the baseline
  below is written with it in mind.

The same `pulumiBackendStatements("infrastructure")` helper the other projects
use, scoped to the `infrastructure` state prefixes only. Do not widen it to the
bucket.

## The infrastructure SCP

Design settled before implementation, in the same spirit as "The workbench
SCP": a deny list layered on top of the AWS-managed `FullAWSAccess`, attached
to the `Infrastructure` OU so any future automation account placed there
inherits it. Not an allow-list. The reasoning for that shape — diagnose-ability,
and the fact that detaching `FullAWSAccess` turns one refused service into a
dead account — is in the workbench document and applies unchanged.

The SCP is written now, while the account is empty, for the reason the workbench
plan gives: once several automations depend on it, tightening becomes a
negotiation with a working system.

### What is different from the workbench policy

The workbench SCP could afford to be aggressive because the account is
deliberately sleepy and holds nothing. This account is not that, and three of
the workbench denies would be actively wrong here. Recording them as
deliberate exclusions, rather than omissions:

- **No region restriction.** Periodic scans and cross-region maintenance
  enumerate or act in regions outside `us-west-2`, and temporary privilege
  escalation may need to act wherever the target account lives. A
  `DenyOutsideHomeRegion` statement of the workbench shape would refuse exactly
  the work this account exists to do. Revisit once the first scans have a known
  region footprint; a region deny that names the exempt services is easy to add
  later and hard to debug when it is wrong.
- **No cross-account S3 deny.** The workbench deny was scoped by resource owner
  so a coding agent could not reach the management account's voter data. Here
  the same statement would block automation that legitimately reads or writes
  buckets in other accounts. If a narrower version is wanted later, scope it to
  the specific resource accounts automation must not reach rather than to "not
  us".
- **No data-store deny.** The workbench denies `rds:*`, `dynamodb:*` and
  `redshift:*` because nothing about running coding agents needs them. Build
  automation and maintenance jobs plausibly do — DynamoDB for locking and
  coordination, RDS for reporting. Denying them up front would be a guess, and
  the wrong guess breaks a job rather than a coding session.

### The baseline

Three statements, all universal rather than workload-specific, all in
`deploy-org/policies.ts` alongside `workbenchScp`:

1. **`DenyLeaveOrganization`** — `organizations:LeaveOrganization`. Leaving
   strands the account outside consolidated billing and every governance
   control at once.
2. **`DenyIamUsersAndLongLivedKeys`** — `iam:CreateUser`,
   `iam:CreateAccessKey`, `iam:CreateLoginProfile`, `iam:UpdateAccessKey`,
   `iam:UpdateLoginProfile`. Access here is federated through Identity Center
   or assumed, and a long-lived key in an account that exists to hold
   privileged automation is the credential most likely to end up somewhere it
   cannot be revoked from. Deliberately not `iam:CreateRole`: the deploy roles
   and any scanner roles are created by IAM, and denying role creation breaks
   the pipeline. This is the statement most likely to need loosening if a
   third-party tool insists on an IAM user; loosen it deliberately, in a PR
   that names the tool.

   The two `Update` actions are a deliberate tightening beyond the workbench
   policy, which denies only the three `Create` actions. Review of the first
   version pointed out that it stopped new credentials but not the re-enabling
   of an existing one, which is not what the Sid says. The reachable set is
   small while the account is empty — no IAM user can be created, so no key
   can exist — but the deny is meant to hold as the account fills and it costs
   nothing to make it complete. `UpdateAccessKey` is also how a key is
   deactivated, so remediation becomes `DeleteAccessKey`, which is stronger.
   The workbench policy is left alone: that account is deliberately sleepy and
   this one is not, and changing a live guardrail there belongs in its own PR.
3. **`DenyCloudTrailTampering`** — `cloudtrail:StopLogging`, `DeleteTrail`,
   `UpdateTrail`, `PutEventSelectors`. Inert until there is a trail, and
   correct the moment there is one. This matters more here than in the workbench
   account: an attacker who reaches privileged automation would want the audit
   trail off, and a tamper deny written before the trail exists is what makes
   the trail trustworthy afterwards.

### Open question this policy does not settle

Whether the account runs, or is covered by, GuardDuty, Security Hub and AWS
Config. If the organization has a delegated administrator for them, the new
account is covered automatically and a tamper deny is worth adding. If it does
not, that is a larger gap than this plan should quietly absorb, and it belongs
in the open questions below rather than in an SCP statement for a service
nobody runs.

### The grant this needs first

`github-actions-org-deploy`'s `ServiceControlPolicyAttachment` and
`ServiceControlPolicyListingForTarget` statements are scoped to
`WORKBENCH_OU_ARN` today. Attaching a second policy to a second OU needs the new
OU's ARN added to both statements' resource lists, and nothing else: the policy
writes (`CreatePolicy`, `UpdatePolicy`, `DeletePolicy`) and reads already cover
every SCP in this organization's namespace.

The new OU's ARN does not exist until step 2 applies, so the literal is
recorded at step 3 and the grant PR is step 4. This is the workbench step 9
pattern exactly: a grant applied by `deploy.yml`, a consumer applied by
`deploy-org.yml`, and a hard ordering between them.

Do not widen the grant to a pattern that matches every OU. The workbench grant
was praised in review for being unable to name `FullAWSAccess`; the equivalent
property here is that this role can attach a policy only to the two OUs it is
responsible for.

## PR previews

The preview path is worth having here for the same reason as everywhere else:
the account holds privileged automation and a PR should not need admin in it to
see a plan. The workbench plan's step 8 and [`pr-previews.md`](./pr-previews.md)
carry the design; this is the third copy of it.

Three changes, and the ordering between them matters:

1. **In-account `pulumi-preview` role** — a sibling of `pulumi-deploy` in
   `deploy-infrastructure/preview-role.ts`, trusted by
   `github-actions-pulumi-preview` in the management account and by the
   management account's `ReadOnlyAccess` SSO session for local previews. It
   starts with no permissions, because the program's only AWS call is
   `sts:GetCallerIdentity`. Applied by `deploy-infrastructure.yml` at step 7.
2. **Management-account grant** — `AssumeInfrastructurePreviewRole` on
   `github-actions-pulumi-preview`, plus `"infrastructure"` in its
   `pulumiBackendReadStatements` list. Applied by `deploy.yml`.
3. **Workflow** — `deploy-infrastructure/**` added to the `pulumi-preview.yml`
   path filter, to the shared-input regex where appropriate, and a
   `{ project: "infrastructure", dir: "deploy-infrastructure", build: false }`
   entry to the matrix.

Ordering: the in-account role must exist before a preview can assume it, but the
management grant can name it before it exists (IAM allows a grant on a
non-existent role ARN). So the safe order is apply step 7, then land the grant,
then the workflow change. Landing the workflow last is what keeps a preview from
failing on a role that does not exist yet.

`deploy-infrastructure/deploy.sh` sets `providerRoleName` to `pulumi-preview`
in preview mode and `pulumi-deploy` otherwise, exactly as `deploy-workbench`
does, so a local preview that forgets to set it back cannot repoint an apply at
the read-only role.

## Implementation plan

The Progress list above is the checklist; this is the detail behind each step.
Steps are staged so no cross-stack reads are ever needed and so every grant
finishes applying before its consumer merges.

1. **Group alias.** Console. `aws-infrastructure@goodparty.org`, a group. AWS
   requires the root email to be globally unique across all AWS accounts, so
   confirm it has never been used before creating the account. Blocking: an
   account whose recovery address does not work is an account nobody can
   recover.

2. **OU and account.** In `deploy-org/index.ts`, alongside `workbenchOu` and
   `workbench`:

   ```ts
   const infrastructureOu = new aws.organizations.OrganizationalUnit(
     "infrastructure",
     { name: "Infrastructure", parentId: "r-jqqe" },
   );

   const infrastructure = new aws.organizations.Account(
     "infrastructure",
     {
       name: "goodparty-infrastructure",
       email: "aws-infrastructure@goodparty.org",
       parentId: infrastructureOu.id,
       iamUserAccessToBilling: "ALLOW",
       closeOnDeletion: false,
     },
     { protect: true },
   );
   ```

   `protect: true`, `closeOnDeletion: false` and the absence of
   `organizations:CloseAccount` and `organizations:RemoveAccountFromOrganization`
   in the CI policy are the same four independent guards the workbench account
   has. Do not add either action to make a destroy work.

   `CreateAccount` is asynchronous and Pulumi polls `DescribeCreateAccountStatus`,
   so expect the apply to take minutes. The most likely failure is
   `EMAIL_ALREADY_EXISTS`. Organizations does not enforce unique OU names under
   a parent, so check for an orphaned OU before rerunning a failed apply.

3. **Record the ids.** `INFRASTRUCTURE_ACCOUNT_ID` in `utils/accounts.ts` (and
   note it there is imported by `deploy-org/policies.ts` for the SCP, by
   `deploy-infrastructure/`, and by `identity-center.ts`), plus the OU id and
   ARN in the facts below. Let it settle before step 7.

4. **Widen the SCP grant.** Add `INFRASTRUCTURE_OU_ARN` to the `Resource` of
   `ServiceControlPolicyAttachment` and `ServiceControlPolicyListingForTarget`
   in `deploy/components/ci-roles/policies.ts`, next to `WORKBENCH_OU_ARN`.
   This PR must merge and its `deploy` job must finish before step 5 merges.

5. **The SCP.** Add `infrastructureScp` to `deploy-org/policies.ts` and the
   `aws.organizations.Policy` + `PolicyAttachment` to `deploy-org/index.ts`,
   following `workbenchScp` and its comments. Unprotected, deliberately: the
   failure mode of an SCP is denying something real, and the fix is to withdraw
   it quickly. The way out sits outside the policy — SCPs never apply to the
   management account, and `github-actions-org-deploy` can detach from exactly
   the OUs it can attach to.

6. **CI deploy role.** `github-actions-infrastructure-deploy` in
   `deploy/components/ci-roles.ts` and `ci-roles/policies.ts`, with
   `pulumiBackendStatements("infrastructure")` and a bootstrap
   `sts:AssumeRole` on
   `arn:aws:iam::${INFRASTRUCTURE_ACCOUNT_ID}:role/OrganizationAccountAccessRole`.
   Inline `RolePolicy`, not a managed policy, matching the other scoped roles.
   Applied by `deploy.yml`; must finish applying before step 7.

7. **The project, then the cutover.** `deploy-infrastructure/` with
   `Pulumi.yaml` (`name: infrastructure`), `index.ts`, `deploy.sh` and
   `deploy-role.ts`, plus `.github/workflows/deploy-infrastructure.yml` and a
   `tsconfig.json` entry so `deploy.yml` type-checks it on every PR. The first
   apply's provider assumes `OrganizationAccountAccessRole` and creates the
   in-account `pulumi-deploy` and `pulumi-preview` roles. A second PR repoints
   the provider at `pulumi-deploy` and removes the bootstrap grant, exactly the
   two-PR shape of workbench step 10, forced by the same causality: the apply
   that creates the role cannot assume it.

   The workflow filename is load bearing for the same reason as
   `deploy-workbench.yml`: the CI role's trust pins `job_workflow_ref` to this
   path. It has no `pull_request` trigger and cannot have one.

8. **Identity Center.** Add an `infrastructure` entry to the `accounts` map in
   `deploy/components/identity-center.ts`, `namePrefix: "infrastructure-"`,
   `adopted: false`, with `Admins: ["administrator"]` and no `Engineers` entry
   yet. This is the human admin path: a member of `Admins` signs in through
   Identity Center and picks the `AdministratorAccess` role for this account.
   It is also the break-glass path if the SCP or a bad deploy role locks CI out.
   No grant PR: `githubActionsPulumiDeploy` already holds `sso:*` on `*`.

   The `adopted` flag's documented wart applies: it is a fact about the
   account, not each assignment, and it is uniform here only because the
   account is new and empty.

9. **Root user.** Console, after the account exists. Enable MFA on the root
   user, remove any root access keys, and set the alternate contacts. AWS now
   requires root access management for some actions, so confirm the recovery
   path works from the group alias rather than assuming it does.

10. **Budget.** One `aws.budgets.Budget` in `deploy-infrastructure/`, taking
    the explicit provider, with actual and forecasted notifications by email to
    `aws-infrastructure@goodparty.org`. The workbench caveats hold: forecasted
    alerts are silent until there is enough history, and every budget alert
    lags billing data by hours. A green apply proves the budget exists, not that
    mail arrives.

11. **Previews.** As described under "PR previews".

12. **Access documentation.** How an admin reaches the account (Identity
    Center), and whether `gp-pi` gets a profile for it the way it did for the
    workbench account. The workbench step 14 is the template. If the only human
    need is break-glass through Identity Center, this can be a paragraph rather
    than a container change.

## Open questions

- **Organization-wide CloudTrail.** Does the organization have a trail that
  covers member accounts? If not, this account — which runs privileged
  automation — is unauditable, and an account trail or an org trail is a
  phase-one gap rather than a follow-up. Check before step 5, because it may
  change the SCP.
- **GuardDuty, Security Hub, AWS Config.** Same question: is there a delegated
  administrator? If yes, the account is covered and a tamper deny is worth
  adding to the SCP. If no, that is a larger decision than this plan.
- **What "temporary privilege escalation" assumes into.** If the account holds
  a role that assumes into production, that role and its trust are a design of
  their own, and they are the most sensitive thing that will ever live here.
  Name it before building it.
- **Build automation shape.** If this means self-hosted GitHub Actions
  runners, they hold credentials and run PR-authored code, which is a threat
  model distinct from a scheduled scan. The `ops` repo's own
  `deploy.yml` ordering comment (install, test and build strictly before the
  credentials step) is the local precedent for how much that matters.
- **Moving the Pulumi state bucket.** `goodparty-iac-state` lives in the
  management account today. This account is a plausible future home for it, but
  moving state is a migration across every project and is explicitly out of
  scope for phase one.
- **Tag collision.** `Environment: infrastructure` next to the existing
  `Environment: infra`. Accepted for now; see "Naming".

## Facts discovered during implementation

- Infrastructure account id: `394495727159`. Created 2026-10-05 18:18:31
  UTC, `ACTIVE`, email `aws-infrastructure@goodparty.org`, joined with
  `JoinedMethod: CREATED`. This is the `INFRASTRUCTURE_ACCOUNT_ID` step 3 adds
  to `utils/accounts.ts`, the account step 7 deploys into, and the assignment
  target step 8 needs.
- `Infrastructure` OU: `ou-jqqe-orrk423t`, directly under root `r-jqqe`, ARN
  `arn:aws:organizations::333022194791:ou/o-uuiolqc1di/ou-jqqe-orrk423t`. The
  account's full path is
  `o-uuiolqc1di/r-jqqe/ou-jqqe-orrk423t/394495727159/`. That ARN is the
  literal step 4 adds to the two `github-actions-org-deploy` statements scoped
  to `WORKBENCH_OU_ARN` today.

## Context: the management account

Unchanged from the workbench document and repeated only because it shapes this
plan too: `333022194791` is both the organization management account and the
account running production, it holds the Identity Center instance, and SCPs
never apply to it. This account does not fix that; it is one more step away
from putting new workloads there.
