# Workbench account

This document is the working plan for provisioning a second AWS account to host
developer tooling. It records the decisions and the reasoning behind them so
the work can be picked up across sessions.

## Progress

One step at a time, one pull request per step. Statuses are `todo`, `doing
(who, date)`, and `done (date, evidence)`. Evidence is a commit SHA for
in-repo work, or an AWS case number or resource id for work done outside git.

Claim a step by setting it to `doing` and pushing that change **before**
starting the work, not after. Steps 1, 9 and 10 happen in the console or in
support cases and leave no other trace, so the claim is the only thing stopping
two sessions from doing them twice.

- [ ] 1. Create and verify `aws-workbench@goodparty.org` group alias — todo
- [ ] 2. Add `deploy/components/organizations.ts` (OU + account) — todo
- [ ] 3. Run `pulumi up` on `ops-dev`, record account id here — todo
- [ ] 4. Extend `identity-center.ts` for the new account — todo
- [ ] 5. Attach SCP to the `Workbench` OU — todo
- [ ] 6. Create the `deploy-workbench/` project — todo
- [ ] 7. Replace `OrganizationAccountAccessRole` with a scoped deploy role — todo
- [ ] 8. Add CI job with `deploy-workbench/**` path filter — todo
- [ ] 9. Enable Bedrock model access in the new account — todo
- [ ] 10. Request quota increases if needed — todo
- [ ] 11. Add budget and cost anomaly detection — todo
- [ ] 12. Point `pi` at the account, document engineer setup — todo

Facts discovered during implementation go here as they are learned:

- Workbench account id: _not yet created_
- Workbench deploy role ARN: _not yet created_

## How to resume

Trust AWS over this checklist. The checklist can be stale (a session may have
died mid-step); AWS cannot. Before starting anything, reconcile:

```bash
aws organizations list-accounts --query "Accounts[].[Id,Name,Status]" --output table
pulumi stack select organization/ops/ops-dev && pulumi stack output
git log --oneline -15 -- docs/workbench-account.md deploy/ deploy-workbench/
```

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

Decision: same repo, second Pulumi project. Account lifecycle lives with the
existing organization code; account contents live in their own project.

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

## Implementation plan

1. Create the `aws-workbench@goodparty.org` group alias and confirm mail is
   received. Blocking: account creation strands without a working address, and
   it is the break-glass recovery path, so it must be a group rather than a
   person. The address must never have been used for another AWS account.

2. Add `deploy/components/organizations.ts` creating the `Workbench` OU and the
   account, called from `deploy/index.ts`. This goes in the existing `ops`
   stack because that stack already runs with credentials that can act on the
   organization.

   ```ts
   const workbench = new aws.organizations.Account("workbench", {
     name: "goodparty-workbench",
     email: "aws-workbench@goodparty.org",
     parentId: workbenchOu.id,
     iamUserAccessToBilling: "ALLOW",
   }, { protect: true });
   ```

   `protect: true` is not optional. Removing this resource tells Pulumi to
   close the account, and a closed AWS account sits in a 90 day suspension
   window.

3. Run `pulumi up` on `organization/ops/ops-dev`. Record the new account id.

4. Extend `deploy/components/identity-center.ts` to assign permission sets to
   the new account. Today `ACCOUNT_ID` is a hardcoded const used as every
   assignment's `targetId`, so this needs parameterizing to iterate over
   accounts. New assignments must not carry the `import:` option that the
   existing ones use, since there is no pre-existing AWS state to adopt.

5. Attach an SCP to the `Workbench` OU allowing Bedrock, CloudWatch, and little
   else. Write it now while the account is nearly empty. Once four people
   depend on the junk it becomes impossible.

6. Create the `deploy-workbench/` project: `Pulumi.yaml` with `name: workbench`,
   `index.ts`, and either its own deploy script or a parameterized version of
   the existing one. Its provider is explicit:

   ```ts
   const provider = new aws.Provider("workbench", {
     region: "us-west-2",
     assumeRole: { roleArn: `arn:aws:iam::${accountId}:role/OrganizationAccountAccessRole` },
     defaultTags: { tags: { Environment: "workbench", Project: "workbench" } },
   });
   ```

7. Replace the bootstrap role. `OrganizationAccountAccessRole` is created
   automatically when Organizations provisions a member account, but it is
   effectively administrator. Use it to stand the account up, then create
   `github-actions-workbench-deploy` in-account and point the provider at that.
   The existing `github-actions-pulumi-deploy` role needs `sts:AssumeRole` for
   whichever role the provider targets.

8. Add a CI job with a path filter on `deploy-workbench/**` so workbench
   deploys are independent of the delegate image build.

9. Enable Bedrock model access in the new account. This is per account and per
   region, so it must be done again here. Enable only the models needed.

10. Request quota increases if the defaults are insufficient. These are per
    account, and a new account may start lower than our matured account.
    Budget lead time.

11. Add a budget and cost anomaly detection before handing the account to
    engineers.

12. Point `pi` at the new account and document engineer setup.

## Open questions

- **Which permission set.** Reusing `EngineerAccess` is tempting since it
  already carries `bedrock:*`, but it also carries `AmazonS3FullAccess` and
  `ReadOnlyAccess`, which is the wrong shape for an account that should hold
  nothing but model access. Leaning toward a new `WorkbenchAccess` set scoped
  to Bedrock plus CloudWatch read.
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
