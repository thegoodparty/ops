# Break glass: just-in-time admin access

> **Status: live.** This is the only way anyone gets admin in AWS. No one holds
> standing admin: the standing `Admins` members were removed by hand once the
> tool was working (by 2026-10-21). Steps 2 through 5 are built and deployed;
> step 1 (CloudTrail) is not, and is a known and time-boxed gap. One follow-up
> is still open: the sweeper logs an `Admins` membership with no grant record at
> informational level, and should now alarm on it. See "Existing members".

The goal is that admin in AWS is granted just in time rather than held. An
engineer who needs it requests it in Slack, a designated approver approves, and
the tool grants it by adding the requester to the existing `Admins` Identity
Store group for a fixed window. Every request, approval, grant and revocation
is logged.

This document is the sibling of
[`infrastructure-account.md`](./infrastructure-account.md), which names
"temporary privilege escalation / just-in-time access tooling" as something the
`goodparty-infrastructure` account (`394495727159`) exists to hold. That
document is the account's plan; this one is the tooling's. Read it first for the
account vocabulary and the guardrails this plan has to live under.

The shape of this proposal is deliberately boring. It is a deterministic Lambda
plus a state machine, not an agent. There is no model anywhere in the approval
path, and there is no reason for one: the whole value is that a human decided,
and that decision is recorded.

## Getting admin access

1. In Slack, run `/breakglass`. Pick a duration (1 to 4 hours), give a reason,
   and paste an incident or ticket link. You must be in the `Engineers`
   Identity Center group to ask.
2. The request posts to `#sensitive-access-requests`. An approver other than
   you approves or denies it there. An approver is anyone in the `Approvers`
   Identity Center group, which the group-sync job mirrors from the
   `Engineering Admin` Workspace group (`eng-admin@goodparty.org`). Their
   membership is resolved live from Identity Center when they click, not from a
   list in the code; see "Approval policy".
3. Once approved, sign out of the AWS access portal and back in, then pick
   `AdministratorAccess`. One grant covers the management, workbench and
   infrastructure accounts. From the CLI, `aws sso login` with a profile whose
   `sso_role_name` is `AdministratorAccess` (for example `gp-admin`, which
   `omni/packages/gp-api/scripts/aws-setup.sh` writes).
4. Access ends on its own when the window closes. A session you already opened
   can last up to one hour past that, because the permission set's session
   length is one hour. Each session is one hour regardless, so a longer grant
   means signing in again.

If Slack or the tool is down, the recovery path is the management-account root
user with MFA (open question 1).

## Progress

One step at a time, one pull request per step. The implementation plan below is
a spec, frozen when it merged, and a step's status is derived from the pull
requests that name it rather than written here; the convention is spelled out
under "Progress" in [`workbench-account.md`](./workbench-account.md) and
decided in decision 11 of [`plan-gated-merges.md`](./plan-gated-merges.md). A
merged PR naming the step is `done`, with its merge date and a link to that PR
as the evidence. Failing that, an open PR naming it is `doing`, with its author
and open date. A step with neither is `todo`, whether it never had a PR or its
only one was closed unmerged.

A pull request says which plan it implements, and which numbered step it
closes, in its body, each on its own line:

```
Plan: docs/sheriff.md
Step: 3
```

The `Step:` line is deliberately not part of the merge gate: a missing,
malformed or duplicated one never flags a PR, it only leaves that step's status
where it was. The checklists below keep the statuses and evidence they were
written with, and are not updated. They are the record of how each step was
tracked up to the merge, which for a console action or a support case is the
only record there is.

"Bookkeeping rides in the implementation PR" is replaced by that, not extended
by it. It existed only because the claim convention in `workbench-account.md`
asked for a `doing` status push before work started, and this repo's review
requirements turned that into a second review for no information. With status
derived from the PRs that name a step there is no separate bookkeeping to ride
along: the implementation PR is the status. The rule that `who` name the
session rather than the model goes with it, because `who` is now the PR author.

Ordering matters and is called out per step. The same rule the other plans use
applies here: a step that grants a permission must merge **and finish applying**
before the step that uses it. CloudTrail (step 1) is deliberately not in that
chain. It can land before, alongside, or after the runtime, and until it lands
the application audit is the only record, which is a known and time-boxed gap;
see "The CloudTrail gap" and open question 7.

- [ ] 1. CloudTrail to an immutable archive: an organization (or at minimum
      management-account) trail to an S3 bucket with Object Lock and a
      restricted reader. Not a blocker; can land in parallel with or after the
      runtime. `todo`
- [x] 2. Definitions only, no runtime: shorten the existing `administrator`
      permission set's `sessionDuration` from `PT8H` to `PT1H` in
      `deploy/components/identity-center.ts`, and add the management-account
      `sheriff-grant` role and its scoped inline policy in `deploy/`. No new
      permission set and no new group; see "Core mechanism".
      `done (2026-10-12, break-glass-step2, PR #280, Deploy run 38252435639)`
- [x] 3. The Lambda, dry: a separate Slack app, its own signing secret and bot
      token in the infrastructure account, a new Lambda in
      `deploy-infrastructure/`, the slash command and modal, a DynamoDB request
      record, the approval post and the button handler, all the way to the
      approval decision, but no grant. This makes the flow visible before
      anything can be escalated.
      `done (2026-10-13, break-glass-step3, PRs #293/#294/#297/#298/#299, Deploy infrastructure green on #298)`
- [x] 4. Wire approval to a real grant: assume `sheriff-grant`, call
      `identitystore:CreateGroupMembership`, write the grant, post the SSO link.
      Add the application audit log, the reconciliation sweeper, and the alarm
      on an unexpected membership.
      `done (2026-10-13, sheriff-step4, PR #302, Deploy infrastructure run 38447135678; PR #306 fixes the listing policy and is pending merge)`
- [x] 5. EventBridge Scheduler revocation at expiry, with retries and a DLQ, on
      top of the sweeper from step 4.
      `done (2026-10-13, sheriff-step5, PR #310, Deploy infrastructure on merge)`

## Goal

Stated as an invariant rather than a feature:

- No one holds standing `AdministratorAccess` in any account. Every member of
  `Admins` is there because of a live, approved grant. The launch-time standing
  members were removed by hand. Until the sweeper alarms on a membership with
  no grant record, this is observed rather than enforced. See "Existing
  members".
- Any member of `Engineers` can request admin, for a bounded duration, with a
  stated reason.
- A designated human approver, not the requester, must approve it.
- The grant is time-boxed and revoked without anyone remembering to revoke it.
- Who asked, who approved, why, what was granted, and when it ended are all
  recorded, and the record cannot be edited by whoever held the admin.

The last point is the one that makes the rest worth doing. A JIT tool with a
mutable log is a tool that launders admin.

## What already exists, and what this builds on

This plan deliberately rebuilds almost nothing. Each of these is real in the
repo today.

| Existing thing | Where | What this plan reuses |
|---|---|---|
| Identity Center is fully code-owned | `deploy/components/identity-center.ts`, applied by `github-actions-pulumi-deploy` (which holds `sso:*`) | The existing `administrator` permission set (shortened) and the existing `Admins` group and its three `AccountAssignment`s. No new resources. |
| `Admins` already holds admin in all three accounts | `deploy/components/identity-center.ts`: `main`, `workbench` and `infrastructure` all map `Admins` to `administrator` | The escalation target itself. The grant is a group membership, not a new assignment. |
| The `Approvers` group is synced from a Workspace group | `deploy-infrastructure/group-sync/config.ts` (`approvers-google`) mirrors `eng-admin@goodparty.org` into it | The decision-time approver set, read live through `GetUserId` and `IsMemberInGroups` on each click. No list in this repo and no mirror to keep current. |
| Slack signing and secret handling | `delegate/lambdas/verify.ts` (`verifySlackWebhook`), `delegate/lambdas/secrets.ts` (`getSecrets`) | The **code patterns** only. The deployed delegate function and its `DELEGATES` secret are not reused; see below. |
| A cross-account assume into the management account | `deploy/components/delegate-swarm-prod-read.ts` (trust by account root plus a `PrincipalArn` condition), assumed from the infrastructure account in `deploy-infrastructure/agent-swarm.ts` | The `sheriff-grant` role is the same pattern with a much narrower policy. |
| The infrastructure account and its guardrails | `deploy-infrastructure/`, the `Infrastructure` SCP in `deploy-org/policies.ts` | The new Lambda, DynamoDB, scheduler and alarms land there, under that SCP. |

Three things worth stating plainly, because the first revision got them wrong:

- **The automation is a new function in the infrastructure account.** The
  existing delegate webhook Lambda is created by `deploy/components/webhooks.ts`,
  which is part of the `ops` stack and therefore the **management** account.
  Review asked to move incrementally away from the management account, so this
  plan does not route on the delegate function at all. It reuses the signing and
  secrets **code patterns**, not the deployed function.
- **A separate Slack app, with its own secret.** The plan uses a new Slack app
  with its own signing secret and bot token, stored in Secrets Manager in the
  infrastructure account. It does **not** reuse `SLACK_SIGNING_SECRET` from the
  `DELEGATES` secret. Two reasons, and the first is a security finding from
  review: every delegate worker holds `DELEGATES` while processing untrusted
  text, and function-URL auth is signature-only, so that secret is enough to
  forge an `Approve` as any approver and grant admin. Second, `DELEGATES` lives
  in the management account, so the infrastructure Lambda could not read it as
  written anyway.
- **The `Infrastructure` SCP asymmetry.** The SCP denies CloudTrail tampering
  (`StopLogging`, `DeleteTrail`, `UpdateTrail`, `PutEventSelectors`) and IAM
  users and long-lived keys, and has no data-store deny, so Lambda, DynamoDB,
  EventBridge Scheduler and CloudWatch Logs are all permitted in the
  infrastructure account. The management account, where the identity store
  lives, has **no SCP at all**; SCPs do not apply to it. That is why the audit
  trail matters, and why it is a gap rather than a hard prerequisite.

## Core mechanism: reuse `Admins`, shorten the session

Identity Center has no native time-boxed assignment. An `AccountAssignment`
exists until it is deleted, so "temporary" has to be simulated. Review settled
the mechanism: reuse the existing `administrator` permission set and the
existing `Admins` Identity Store group, and toggle the requester's membership in
that group.

### The decision

- **Grant**: `identitystore:CreateGroupMembership` adds the requester to
  `Admins` and returns the new `MembershipId`. If the requester is already a
  member, AWS returns a `ConflictException` rather than succeeding; the Lambda
  catches it, resolves the existing `MembershipId` with
  `ListGroupMembershipsForMember`, and treats the grant as successful, because
  the member is in the group regardless of who added them. Either way the grant
  is recorded with its expiry and its `MembershipId`. Any other error sends the
  request to `failed`.
- **At most one active grant per user**: before it writes the `granting` record
  or calls `CreateGroupMembership`, the Lambda checks for an existing
  `granting` or `granted` record for the requester, and rejects the approval
  with an ephemeral message to the approver ("a grant for this user is already
  active") if one exists. This is what stops two approved requests from
  collapsing onto one membership: the second `CreateGroupMembership` would
  return `ConflictException`, both grants would resolve the same
  `MembershipId`, and the first expiry would silently end the second grant
  early. The guard is race-safe, not a read-then-write: it is a conditional
  DynamoDB write keyed by the requester (an `attribute_not_exists` condition, or
  a transaction), so two concurrent approvals cannot both write a `granting`
  record. A new grant is allowed once the active one is revoked or expires.
- **Revoke**: `identitystore:DeleteGroupMembership` removes the requester,
  unconditionally at expiry, by the `MembershipId` stored on the grant. It does
  not check whether the tool was the thing that added them. With no standing
  members left, every membership should be one the tool granted, which is what
  keeps the tool's grant set and the group's membership set in agreement
  without a baseline.
- The `Admins` group is already assigned `AdministratorAccess` in the
  management, workbench and infrastructure accounts
  (`deploy/components/identity-center.ts`), so one membership grants admin in
  all three at once. No new permission set, no new group, no new
  `AccountAssignment`.
- The existing `administrator` permission set's `sessionDuration` changes from
  `PT8H` to `PT1H`.

The reasoning is that the permission set and the delegation into the subaccounts
already exist. The first revision proposed a parallel `BreakGlass` permission
set and per-account `BreakGlass-<account>` groups, which duplicated a working
arrangement and created resources to keep in sync. Reusing `Admins` reduces the
runtime to one API call in each direction, and the group is the unit of
revocation.

### What changed from the first revision

Recorded so a reader of the diff is not confused by the review thread:

- No `BreakGlass` permission set. The existing `administrator` set is reused.
- No `BreakGlass-<account>` groups. The existing `Admins` group is reused.
- No per-account escalation. A single membership is global; see "Single global
  escalation" below.
- No `BreakGlassApprovers` Identity Store group and no Slack mirror. The first
  revision checked a hardcoded array of Slack user IDs in the tool's code. That
  is reversed: the approver set is now the existing `Approvers` Identity Center
  group, resolved live at decision time (not the `BreakGlassApprovers` group
  this revision rejected, and not a code list). See "Approval policy" for the
  decision and the security trade-off it accepts.

### Option 2 (rejected): create and delete `AccountAssignment` on demand

The tool would call `sso:CreateAccountAssignment` on approval and
`DeleteAccountAssignment` on expiry. Rejected, and the reviewer agreed, for two
reasons, either of which is enough:

- `ProvisionPermissionSet` is not instant. It takes tens of seconds to minutes,
  so the grant has an unpredictable start and the revoke an unpredictable end.
  The whole point is a bounded window.
- The assignments are owned by Pulumi. Mutating them at runtime makes the tool
  and `deploy.yml` fight over the same resources, and the next apply either
  reverts the tool's change or reports drift forever. The infrastructure plan
  already records the general principle: runtime mutation of code-owned
  resources is a fight with CI.

### Option 3 (rejected): STS session credentials instead of Identity Center

The tool could mint temporary credentials with `sts:AssumeRole` and a
`DurationSeconds`, and hand those to the requester. Rejected, and the reviewer
agreed, because it gives no console or SSO path, and because the request was
explicitly for an Identity Center experience: a role appears in the user's SSO
portal and expires on its own. STS sessions also cannot be revoked before they
expire, which is worse than the Identity Center case, not better. STS is still
used, but only for the tool's own cross-account call into the management
account, not to grant the human.

### The session-duration caveat

Removing a group membership does **not** terminate a session that is already
open. A user who signed in while a member keeps the `administrator` role until
that session reaches the permission set's `sessionDuration`. So:

- The existing `administrator` `sessionDuration` drops from `PT8H` to `PT1H`.
  Identity Center permits 1 to 12 hours, so `PT1H` is the floor.
- This shortens **every** `Admins` session. That is deliberate and confirmed:
  nobody holds a long session, and the escalated window is bounded for
  everyone.
- Treat the requested duration as the **grant window**, not a guarantee. The
  honest worst case is `requested duration + remaining session`, which with a
  `PT1H` set is at most roughly twice the request. The Slack reply must say
  this rather than implying a hard cutoff.
- A user already signed in has to sign in again to see the role. The Slack reply
  therefore links the SSO portal and says to sign out and back in.

### Why the permission set carries no guardrails

The existing `administrator` set already sets `guardrails: false`, and this plan
does not change that. `deploy/components/identity-center.ts` composes
`adminReservedActions` into every permission set's inline policy unless that
flag is set, and the flag is off here for the reason recorded in the file: the
denies cover the organization and Identity Center writes that admin exists to
perform, and applying them to the recovery path would remove the recovery path
at the exact moment it is needed. Reusing the set means this decision is already
made and needs no new line.

### Single global escalation, and its blast radius

There is no per-account escalation and no per-account group. Because `Admins` is
assigned `AdministratorAccess` in all three accounts, one approved membership
grants admin in the management account, the workbench account and the
infrastructure account **at once**.

The blast radius, stated plainly rather than buried: the management account is
both production and the organization's management account. SCPs do not apply to
it, and it can create accounts and edit SCPs. An approved break-glass request is
therefore effectively an organization-admin grant, and the human approval is the
only thing standing between a request and that. That is the strongest argument
for the approver checks (the `Approvers` group at decision time, and the
approver must not be the requester), for the audit, and
for keeping the escalation rare. It is also why the first revision's per-account
groups were attractive and why dropping them is a real change: they were a
blast-radius control that this design gives up. The compensating controls are
the approver gate and the audit, not a narrower grant.

### Existing members

`Admins` has no standing members. The group was repurposed in place, and the
members it had at launch were removed by hand once the tool was working. The
tool manages **only the memberships it granted**; it keeps no second source of
truth about who else is a member.

A membership with no grant record in any state is therefore one the tool cannot
explain. The sweeper still leaves it alone and logs `membership.unmanaged` at
informational level, which was right while standing members existed and is now
too quiet. The remaining follow-up is to promote that case to an alarm, at which
point any membership the tool cannot explain pages. A grant record in the
`granting` state is still a record, so a member the tool is mid-way through
adding is reconciled by "Never leave a grant open", not mistaken for an
unexplained member.

If someone is ever added to `Admins` by hand and then requests through the tool,
`CreateGroupMembership` returns a `ConflictException`; the Lambda catches it,
resolves the existing `MembershipId`, and records the grant. At expiry the
revoke removes them by that `MembershipId` like anyone else.

## Architecture

```
   Slack (separate break-glass app)     AWS (infrastructure account 394495727159)
   ───────────────────────────────      ────────────────────────────────────────
 /breakglass ──┐
 modal        │  signed with the       ┌────────────────────────────────────────┐
 Approve/Deny ├──sheriff secret───────▶│ break-glass Lambda (Function URL)      │
 (in channel) │                        │ patterns from delegate/lambdas         │
              │                        └───────────────┬────────────────────────┘
              │                                        │
              │                        ┌───────────────┼───────────────┐
              │                        ▼               ▼               ▼
              │                  DynamoDB         EventBridge     CloudWatch Logs
              │                  requests,        sweep rule      structured audit
              │                  grants,          + Scheduler     + metric filters
              │                  rate counters    one-shot        + alarms
              │                                        │
              ▼                                        └── both call the same revoke
   #sensitive-access-requests post  ◀── sts:AssumeRole ──▶ management account 333022194791
                                            role: sheriff-grant
                                            identitystore:CreateGroupMembership
                                            identitystore:DeleteGroupMembership
                                            scoped to the Admins group id
```

**Pulumi (the `ops` stack) owns the durable definitions**, not the runtime
state:

- The existing `administrator` permission set, with its `sessionDuration`
  shortened to `PT1H`, in `deploy/components/identity-center.ts`. Nothing else
  in that file changes: the `Admins` group and its three assignments already
  exist.
- The management-account `sheriff-grant` role and its inline policy, in
  `deploy/`.

**Pulumi (the `infrastructure` stack) owns the runtime**, in
`deploy-infrastructure/`: the new break-glass Lambda and its execution role, its
own Slack secret in Secrets Manager, the DynamoDB table, the step-4 EventBridge
sweep rule, the step-5 Scheduler one-shot with its schedule group, DLQ and
schedule-execution role, the log group, metric filters and the
orphaned-membership alarm. The Lambda's role
gets `sts:AssumeRole` on exactly one ARN (`sheriff-grant`), plus DynamoDB,
logs, scheduler and its own secret, and nothing else. It is still under the
`Infrastructure` SCP.

The **approver set** is the `Approvers` Identity Center group, checked live on
every click (`GetUserId` on the clicker's Slack email, then
`IsMemberInGroups`), the same way the requester's `Engineers` membership is
checked at submission. There is no list in the Lambda's code and no mirrored
copy in DynamoDB or SSM, so there is no sync lag and a removed approver loses
the ability to approve on their next click. See "Approval policy".

**Two hard rules**, stated here so they are not lost in the detail:

1. **No LLM in the approval path.** The decision to grant is made by a human,
   enforced by a deterministic Lambda. A delegate agent is not in this flow.
   The delegate system is a fine place to build tooling; it is the wrong place
   to put a policy decision with this consequence, because its inputs are
   untrusted text.
2. **The tool can only toggle membership in the one `Admins` group.** It cannot
   create a permission set, cannot create an account assignment, and cannot
   grant admin anywhere except by adding a member to `Admins`. The inline
   policy's `Resource` list is the enforcement; see below.

## The Slack flow and the state machine

### Flow

1. `/breakglass` opens a modal: **duration** (a select bounded by the cap),
   **reason** (free text, required), and an **incident or ticket link**
   (required, so a grant is always attached to something). There is no account
   field: the escalation is global by design.
2. On submit, the Lambda first runs the requester gate: it resolves the
   requester's Slack email with `users.info`, maps it to an Identity Store user
   with `GetUserId(emails.value)`, and checks the `Engineers` membership with
   `IsMemberInGroups`. A miss is an inline modal error keyed to `reason_block`
   and no record is written. Only then does it write a `requested` record and
   post a Block Kit message to a configured channel, defaulting to
   `#sensitive-access-requests`, with **Approve** and **Deny** buttons bound to the request id.
   Outcomes go to the same channel. There are no DMs; transparency is the point.
   If an approver ping is wanted, it is an in-channel user-group mention, not a
   DM.
3. The interactivity endpoint is a route on the new break-glass function, which
   uses the same verification pattern as the delegate handler. Slack sends
   interactivity as `application/x-www-form-urlencoded` with a `payload=<json>`
   field rather than the JSON body the delegate events route parses, so the
   route decodes that before reading the action.
4. The handler re-verifies the Slack signature with the sheriff secret, then
   resolves the clicking user live: `slack.users.info` for their Slack email,
   `identitystore:GetUserId` on `emails.value`, and `IsMemberInGroups` against
   the `Approvers` group, the same resolution the requester gate uses. They
   must also not be the requester. Anyone else gets an ephemeral refusal, and
   if Slack or Identity Store cannot answer, the decision is refused with an
   explicit message rather than allowed (fail closed).
5. On **Deny**: write `denied`, post the outcome to the channel, done.
6. On **Approve**: enforce the remaining checks (duration within cap, per-user
   rate limit, request not already decided, and **no other active grant for the
   requester**, enforced with the conditional write described under "The
   decision"). If any check fails, post the reason to the approver and write no
   grant. Then assume `sheriff-grant` and **write the grant record first, in
   a `granting` state**, carrying the request id, requester, approver, group id,
   and the computed expires-at (granted-at plus the requested duration). Only
   then call `CreateGroupMembership`. A
   `ConflictException` means the requester is already a member, so the Lambda
   resolves the existing `MembershipId` with `ListGroupMembershipsForMember` and
   continues; any other error sends the request to `failed`. It then flips the
   record to `granted` with the `membershipId` and posts the SSO portal link and
   the expiry, with the session caveat, to the channel and to the requester. The
   one-shot scheduler created with the grant is the revoke path; the periodic
   sweeper is the backstop.
7. At expiry, the revocation path calls `DeleteGroupMembership` with the
   grant's `MembershipId`, unconditionally. A `ResourceNotFoundException` means
   the membership is already gone, so it is treated as success; either way the
   grant is written `revoked`. The one-shot fires this from an EventBridge
   Scheduler schedule with retries and a DLQ; the sweeper does it on its next
   pass as the backstop.

### States

```
requested ──approve──▶ granting ──▶ granted ──expiry──▶ revoked
    │
    ├──deny───────────▶ denied
    ├──timeout────────▶ expired-unapproved
    └──(any state)────▶ failed

granting ──member absent────────────▶ failed
granting ──member present───────────▶ granted (sweeper revokes at expiry)
granting ──expired, member present───▶ granted, then revoked
granted ──expired, revoke fails──────▶ orphaned (alarm)
```

`granting` is the state between "the approver said yes" and "the membership
exists". The record is written before the membership so the state is never
invisible, and the sweeper resolves it:

- **member absent**: the grant never completed; the record goes to `failed`.
- **member present**: the grant is live. The `granting` record has no stored
  `membershipId`, because the crash happened before the flip, so the sweeper
  first calls `ListGroupMembershipsForMember` to resolve the existing
  membership's `MembershipId` (matching on the `Admins` group), writes it onto
  the record, and flips the record to `granted`.
- **member present past expiry**: the normal path did not finish. The sweeper
  resolves the `MembershipId` the same way and then revokes. A successful
  sweep-and-revoke is expected and silent; only a revoke that **fails** leaves
  the member present and is an orphan (`membership.orphaned`, alarm). That is
  the whole definition of `orphaned` in step 4: an expired grant whose member is
  still present *after* the sweeper's revoke attempt.

DynamoDB is a single table: request items, grant items, per-user active-grant
locks and per-user rate counters. The grant item carries a **`state`**
(`granting`, `granted`, `revoked` or `failed`), the request id, the group id
(`Admins`, which implies all three accounts), the requester, the approver, the
granted-at and expires-at timestamps, and the scheduler's
schedule name. It also carries **`membershipId`**, the opaque
membership id `DeleteGroupMembership` requires, which is absent while the record
is `granting` and set to the value returned by `CreateGroupMembership` (or
resolved with `ListGroupMembershipsForMember` when that call returns
`ConflictException` because the member already existed) when the record becomes
`granted`. The record is written in the `granting` state **before** the
membership is created, which is what guarantees that a membership the tool
created always has a grant record behind it; see "Never leave a grant open". A
`granting` record the sweeper recovers has its `membershipId` backfilled with
`ListGroupMembershipsForMember` before it flips to `granted`. The at-most-one
active-grant guard keys on the requester, so the table also holds a per-user
item (or a key on the grant item) whose conditional write is what makes that
rule race-safe; see "The decision".

**TTL is for retention only.** DynamoDB TTL deletion can lag by up to 48 hours,
so it must never be the mechanism that ends a grant. Revocation is the scheduler
plus the sweeper; TTL only cleans up records nobody needs to read anymore.

## The tool's own privilege, which is the crown jewels

The most sensitive object this plan creates is not the permission set, which
already exists. It is the role that lets the tool add and remove memberships.

### `sheriff-grant`, in the management account

- **Trust**: only the break-glass Lambda execution role ARN in the
  infrastructure account, following the `delegate-swarm-prod-read` pattern
  (account root as principal plus an `ArnEquals` `aws:PrincipalArn` condition,
  because IAM rejects a trust naming a role that may not exist at apply time).
  Nothing else can assume it.
- **A fixed `sts:AssumeRole` session name** (for example
  `sheriff-grant-tool`) so CloudTrail records every assume under one
  distinguishable name rather than `AWS-Reserved-Session` or a random string.
- **Inline policy, scoped by resource**, to the identity store id, the
  `Admins` group id, the `Engineers` group id and the `Approvers` group id:
  `identitystore:CreateGroupMembership`,
  `identitystore:DeleteGroupMembership`, `identitystore:ListGroupMemberships`,
  `identitystore:ListGroupMembershipsForMember`, plus step 4's
  `identitystore:GetUserId` and `identitystore:IsMemberInGroups`. Each maps to a
  described operation: `CreateGroupMembership` and `DeleteGroupMembership` are
  the grant and the revoke, `ListGroupMembershipsForMember` resolves the
  `MembershipId` of a pre-existing member when `CreateGroupMembership` returns
  `ConflictException` and of a `granting` record that the sweeper or the revoke
  handler recovers, and `ListGroupMemberships` is the sweeper's full-group scan.
  `GetUserId` resolves a Slack email on `emails.value`, and
  `IsMemberInGroups` is both membership gates: `Engineers` for the requester and
  `Approvers` for the clicker. The exact resource ARN form is
  confirmed at implementation; the point is that it names the one identity
  store and the three groups it acts on, not `*`.

  Deliberately absent: `identitystore:DescribeGroup`,
  `identitystore:ListUsers` and `identitystore:DescribeUser`. No described
  operation reads group or user metadata. The group ids are static literals
  from `deploy/components/identity-center.ts` and the runtime config, so no
  runtime group-existence check is needed, and every call the tool makes is
  membership- or requester-scoped. `ListUsers` in particular would allow
  enumerating every user in the identity store, which is more than the tool's
  rule allows. Open question 3 was settled by the engineer in favour of the
  email lookup, so `GetUserId` and `IsMemberInGroups` are the two additions;
  the policy is no longer "unchanged from step 2".
- **Not granted**: any `sso:*`, `CreateAccountAssignment`,
  `CreatePermissionSet`, `sso-directory:AddMemberToGroup`, or anything that
  could grant admin outside `Admins`. `sso-directory` is worth naming
  explicitly: `adminReservedActions` records that it carries its own
  `AddMemberToGroup`, so a policy that allowed `sso-directory:*` would be a
  second, unnoticed path to the same directory mutation. The tool gets only the
  `identitystore` namespace, scoped to resources.

**No bootstrapping dependency, and a rule to keep it that way.** Because the
plan reuses existing resources, the inline policy references only literals: the
`Admins` group id is already in `deploy/components/identity-center.ts`, and the
identity store id is a stable literal that should be recorded in the repo the
way `utils/accounts.ts` records account ids. There is no Pulumi-created group
whose id has to exist before the policy can name it, which is the bootstrapping
problem the delegate reviewer flagged in the first revision. If a future change
does need the policy to reference a Pulumi-created resource, it must use a
Pulumi `Output<string>` reference so the engine resolves the dependency, rather
than recording a literal that requires a two-pass apply. That rule is recorded
here so the class of bug cannot come back.

### The Lambda's role, in the infrastructure account

`sts:AssumeRole` on the one `sheriff-grant` ARN, plus DynamoDB on the one
table, CloudWatch Logs on the one group, EventBridge Scheduler on the one
schedule group, and a read of the tool's **own** secret for the Slack token and
signing secret. It does **not** read `DELEGATES`. Nothing else. It is still
bound by the `Infrastructure` SCP, and `DenyCloudTrailTampering` in that SCP is
inert until the trail from step 1 exists.

### The honest residual risk

**Whoever controls the tool's code controls admin.** The human approver is the
control, but the tool is what enforces the approver, so a compromised or
malicious change to the Lambda bypasses the approval entirely and calls
`CreateGroupMembership` for anyone. This is inherent to the design and should
not be papered over. The mitigations are:

- The code is deployed by CI from a reviewed branch, and `deploy/` and
  `deploy-infrastructure/` are owned paths requiring human review.
- The reconciliation sweeper catches an **orphaned grant**: an expired grant
  whose member is still in the group, meaning the normal revoke path did not
  run. That is what alarms. Every grant also writes a low-severity informational
  record, not a page; paging on every grant is alert fatigue and would train
  people to ignore it.
- The audit trail, once step 1 lands, is independent of the tool and cannot be
  rewritten by it, so a bad grant cannot be hidden after the fact, only seen.
- The blast radius of the tool is `Admins` in all three accounts, which is the
  same org-admin reach a grant gives the requester; there is no narrower grant
  to fall back to, which is why the approver gate carries the weight.

The tool does not protect against someone with write access to its own code and
the ability to wait for a deploy. That is a statement about who has repo write
access, not about the tool, and it belongs in the threat model.

## CloudWatch audit: two layers, two different questions

### Application audit

A structured-JSON CloudWatch Logs group, written by the Lambda, with one event
per transition: `request.created`, `request.approved`, `request.denied`,
`grant.created`, `grant.revoked`, `grant.failed`, `membership.orphaned` and
`membership.unmanaged` from the sweeper. Each carries the request id, requester,
approver, group, reason, ticket link, and timestamps. The expiry revoke emits
`grant.revoked`; there is no separate `grant.expired` event.

There are two signals, and they are deliberately different in loudness:

- **Every `grant.created` writes one low-severity informational audit event**,
  non-paging. This is the durable record of the grant, independent of the tool's
  own approval logic having behaved correctly; it is what a future reader
  reconstructs the history from, and it is what makes the time-boxed gap while
  CloudTrail is absent survivable. It also posts to the channel so the approver
  can see their approval took effect.
- **The loud alarm is on `membership.orphaned`**: an expired grant, in either
  the `granting` or `granted` state, whose member is **still** in the group
  after the sweeper's revoke attempt, which is the signal that the normal
  revoke path did not run or the state is stuck. When the record is `granting`
  and has no stored `MembershipId`, the sweeper resolves it with
  `ListGroupMembershipsForMember` before revoking. A successful sweep-and-revoke
  is expected and does not page. A membership with no grant record in any state
  emits `membership.unmanaged` at informational level and does not page; see
  "Existing members".

Metric filters turn those events into metrics. This layer answers *who asked,
who approved, why, how long*.

### AWS audit

CloudTrail. `CreateGroupMembership` and `DeleteGroupMembership` are management
events in the **management account**, because that is where the identity store
lives, and `sts:AssumeRole` into `sheriff-grant` is a management event there
too. This layer answers *what did the tool actually do to AWS*, independently of
the tool's own logs, and it is the layer a compromised tool cannot rewrite.

### The CloudTrail gap

[`infrastructure-account.md`](./infrastructure-account.md) lists
"Organization-wide CloudTrail" as an open question, and the `Infrastructure`
SCP's `DenyCloudTrailTampering` statement is inert until a trail exists. The
management account has no SCP protection at all. So today there may be no
durable trail covering the account where every grant actually lands, and even if
there is one, an actor in the management account can turn it off.

Review agreed the trail is needed but not that it blocks the build, and this
document follows that. It is a first-class step (step 1) that can land before,
alongside, or after the runtime. Until it lands, the application audit is the
only record, and the application audit is written by the tool being audited.
That is a known and time-boxed gap, and it should be closed as soon as the trail
can be built; it is not a reason to hold the tool back, but it is the reason the
tool's own records are structured for export and retention from day one.

## Approval policy

- **Who approves.** Membership in the `Approvers` Identity Center group,
  resolved live at decision time. The clicking user's Slack profile email is
  mapped with `identitystore:GetUserId` on `emails.value` and checked with
  `identitystore:IsMemberInGroups` against the `Approvers` group id, exactly as
  the requester's `Engineers` membership is checked at submission. There is no
  hardcoded Slack id list in the code and no mirrored copy in DynamoDB, SSM or
  Slack: the directory is the source of truth, so there is no sync lag, no new
  copy to keep current, and revoking someone from the group takes effect on
  their next click. The group is the same `Approvers` group the group-sync job
  mirrors from the `Engineering Admin` Workspace group
  (`eng-admin@goodparty.org`); adding or removing an approver is a Workspace
  group change, not a code change.
- **Fail closed.** If Slack returns no email, no Identity Center user matches
  it, `IsMemberInGroups` answers false, or Identity Store cannot answer at all,
  the decision is refused with an explicit ephemeral message and nothing is
  decided or granted. An Identity Store outage never reads as an approval.
- **The decision this reverses, and its security trade-off.** The previous
  policy was a hardcoded array of Slack user IDs, changed only by a reviewed
  PR, and it was recorded here as settled because a reviewed PR is a stronger
  control than self-service group membership. This PR reverses that
  deliberately, which weakens that specific control and the trade-off is not
  argued away. The `Approvers` group is synced from
  `eng-admin@goodparty.org`, so whoever administers that Workspace group can
  confer approval authority without a code review — and because approval
  authority is the human gate on an org-admin grant, it is effectively admin
  authority. The residual mitigations are: the approver must not be the
  requester, every request and outcome is posted to the channel, and the audit
  record and the grant record name the approver (their Slack id) alongside the
  requester, reason and ticket. A notification when the sync job adds or
  removes an approver would put group changes in front of the channel and is a
  sensible follow-up; it is not part of this change.
- **How many.** One approver per request, and the approver must not be the
  requester. For a global escalation that reaches the management account, a
  second approver is tempting, but review settled on one for now; two-person
  approval is a usability cost that should be added deliberately if it is
  wanted, not assumed.
- **Notifications.** A configured channel, default `#sensitive-access-requests`. The request and
  every outcome are posted there. No DMs. An optional in-channel user-group
  mention can serve as the ping.
- **Availability fallback.** If no approver is online the flow stalls. The
  options are paging an on-call approver (there is a
  `slack-bugduty-oncall-rotation` workflow in this repo that already rotates a
  Slack user group) or a documented manual path. **Do not self-approve after a
  timeout.** A timeout that grants access is not an approval policy; it is an
  outage that escalates. **Open** (open question 6).
- **Rate limit.** A per-user cap on requests per day, and a global cap on
  concurrent grants, both enforced before the grant call. The current enforced
  per-user value is **20 per UTC day**; the global concurrent-grant cap and
  whether these numbers are final are still **open**. These are separate from the
  hard **one active grant per user** rule, which is decided rather than open and
  is enforced with a conditional write; see "The decision".

## Reliability invariants

- **Never leave a grant open.** Step 5 has two mechanisms. The EventBridge
  Scheduler one-shot at the exact expiry, with retries and a dead-letter queue,
  is the normal path; the periodic reconciliation sweeper is the backstop, so
  if the schedule fails or the grant path stopped partway, every expired grant
  is still revoked on the sweeper's next pass. The sweeper reconciles the tool's
  own grant records, in both the
  `granting` and `granted` states, against the group's current memberships. For
  a `granting` record it must resolve the membership before it can act, because
  the record has no stored `membershipId`: it calls
  `ListGroupMembershipsForMember` to find the member's membership in the
  `Admins` group, writes that `MembershipId` onto the record, and flips the
  record to `granted`. If the member is absent, the grant never completed and
  the record goes to `failed`, with no alarm. If the member is present, the
  grant is live; if it is also past expiry the sweeper revokes it. A successful
  sweep-and-revoke is expected and does not page. Only a revoke that fails, or a
  state that stays stuck, leaves an **orphaned grant**: the member is still
  present **after** the sweeper's revoke attempt, which is `membership.orphaned`
  and the alarm. An active `granted` record is left alone. A membership with
  **no grant record at all** is left alone and logged informationally; the
  sweeper never removes it. That shape used to mean a pre-existing standing
  member; with none left it should alarm, which is the open follow-up under
  "Existing members". The scheduler is the normal path and the sweeper is
  what catches a failed schedule or a grant path that stopped partway.
- **The grant record exists before the membership can.** The grant path writes a
  `granting` record first, then calls `CreateGroupMembership`, then flips the
  record to `granted`. If the Lambda dies between the call and the flip, the
  `granting` record is what the sweeper reconciles, so the partial-grant case (a
  member added with no record and no revoke path) cannot occur.
- **At most one active grant per user.** The grant path refuses to write a new
  `granting` record while the requester has a `granting` or `granted` one, and
  the check is a conditional DynamoDB write rather than a read-then-write, so
  two concurrent approvals cannot both pass it. Without this, the second grant
  would share the first's `MembershipId` and lose access at the first expiry.
  A new grant is allowed once the active one is revoked or expires.
- **Expected is defined by the tool's own grant records, not by a baseline.**
  The tool manages only what it granted, so there is no second source of truth.
  Drift is an orphaned grant, which is actionable without knowing who was a
  member before the tool existed.
- **Idempotent revoke.** At grant time the `MembershipId` returned by
  `CreateGroupMembership` is stored on the grant record. At revoke time
  `DeleteGroupMembership(MembershipId)` is called. If the grant record has no
  stored `membershipId` (a `granting` record the sweeper is recovering), the
  revoke handler first resolves it with `ListGroupMembershipsForMember`, and a
  missing membership is the already-gone case. If `DeleteGroupMembership`
  throws `ResourceNotFoundException` because the membership is already gone, the
  handler treats that as success and marks the grant revoked. The sweeper and
  the scheduler both use this path, so a double revoke is harmless; the revoke
  post is claimed with a conditional write, so exactly one revoker posts.
- **Fail closed on grant, not on revoke.** If the approval checks fail, or
  `CreateGroupMembership` fails with anything other than the `ConflictException`
  that means "already a member", no access is granted and the request goes to
  `failed`. If a revoke fails for any reason other than
  `ResourceNotFoundException`, retry and alarm; never leave it.
- **The sweeper is read-heavy and cheap.** It is a periodic
  `ListGroupMemberships` on the one group, a `ListGroupMembershipsForMember` for
  each `granting` record it recovers, plus a DynamoDB query. It should run often
  enough that drift is measured in minutes, not hours.

## Rejected alternatives

Collected here so the mechanism section stays readable:

- **Create/delete `AccountAssignment` on demand** — rejected under Option 2
  above: provisioning latency and a fight with Pulumi over code-owned
  resources.
- **STS session credentials instead of Identity Center** — rejected under
  Option 3: no console/SSO path, and STS sessions cannot be revoked early.
- **A new `BreakGlass` permission set and per-account `BreakGlass-<account>`
  groups** — proposed in the first revision and rejected in review. `Admins`
  already delegates `AdministratorAccess` into every account, so the new
  resources duplicated a working arrangement and added state to keep in sync for
  a blast-radius separation the single group does not have.
- **Per-account escalation** — considered in the first revision and dropped for
  the same reason: `Admins` is one group assigned everywhere, so per-account
  groups would be new resources that grant the same global reach.
- **Retiring `Admins`** — considered in the first revision and rejected in
  review. Repurposing it in place avoids a migration, keeps the current members
  working, and preserves a path in if the tool is down.
- **An LLM agent as the approver or the gate** — rejected by the first hard
  rule. The decision has to be a human's and the enforcement has to be
  deterministic; a prompt-injectable input must not be able to grant admin.
- **Reusing the delegate Slack app, its function, or the `DELEGATES` secret** —
  rejected. `DELEGATES` is held by every delegate worker while it processes
  untrusted text, so a forged signature could grant admin, and it lives in the
  management account anyway. A separate app, secret and function is the fix.

## Open questions

Each of these is a decision this draft does not make. They are numbered so a
reviewer can comment on one. Items marked settled record the review decision
rather than staying open.

1. ~~**Human recovery path if the tool is down.**~~ **Settled in review:** the
   management-account root, with MFA, which is in place today. It is the
   documented recovery path, and it removes the first revision's option of
   keeping an audited standing admin group. The `Admins` group's existing
   members are covered separately, under "Existing members".
2. ~~**Slack app boundary.**~~ **Settled in review:** a separate Slack app with
   its own signing secret and bot token, stored in Secrets Manager in the
   infrastructure account, served by a new Lambda in the infrastructure account.
   The delegate app, function and `DELEGATES` secret are not reused.
3. ~~**Identity mapping for the requester.**~~ **Settled by the engineer,
   differently from the first revision:** the requester is resolved at request
   time from their Slack email. The Lambda calls `slack.users.info` for
   `user.profile.email`, then `identitystore:GetUserId` on the
   `emails.value` alternate identifier, and gates the request on the resolved
   user being a member of the `Engineers` group
   (`identitystore:IsMemberInGroups`). The hard-coded Slack-to-Identity-Store
   map in `deploy-infrastructure/sheriff/config.ts` is gone, and the
   `sheriff-grant` role's inline policy gains `GetUserId` and
   `IsMemberInGroups`; it is no longer "unchanged from step 2". A requester with
   no Slack email, no matching Identity Store user, or no `Engineers` membership
   gets an immediate, distinct inline error, keyed to `reason_block`, before any
   request is written. No negative cache: a user created after a failed request
   works on the next one.
4. ~~**Account scope for phase one.**~~ **Settled in review:** single global
   escalation. One membership grants admin in all three accounts; there is no
   per-account scope and no per-account group.
5. ~~**Duration caps.**~~ **Settled in review:** default `PT1H`, max `PT4H`,
   with the existing `administrator` permission set shortened to `PT1H`.
6. **Tool availability and SLA, and the manual path.** What is the availability
   target, and what happens when Slack or the Lambda is down? The manual path is
   now the management-account root (question 1), but whether an approver is
   paged and who that is remains open.
7. **CloudTrail immutability.** Retention period, whether the archive bucket
   uses S3 Object Lock (governance or compliance mode), and who can read the
   audit log. A trail nobody can read is not an audit; a trail everyone can read
   is a data-exposure problem. This is step 1 and no longer blocks the runtime,
   so the gap is known and time-boxed rather than a prerequisite.
8. ~~**Existing members before manual cleanup.**~~ **Settled by the engineer:**
   existing `Admins` members were not removed by the sweeper; they were removed
   by hand once the tool was working. The sweeper's no-grant-record case is
   still informational and should be promoted to an alarm. See "Existing
   members".

## Implementation plan

The Progress list is the checklist; this is the detail behind each step.

1. **CloudTrail.** An organization trail (preferred) or at minimum a
   management-account trail, to an S3 bucket with Object Lock, a retention
   policy, and a read role that is not the tool's role and not
   `AdministratorAccess`. This is the gap `infrastructure-account.md` records,
   and review agreed it can land in parallel with or after the runtime. Where
   the trail is defined (org stack, `deploy/`, or console) is part of the step.

2. **Definitions, no runtime.** In `deploy/components/identity-center.ts`,
   change the existing `administrator` permission set's `sessionDuration` from
   `PT8H` to `PT1H`. That is the only change in that file: the `Admins` group
   and its three `AccountAssignment`s already exist and are untouched. In
   `deploy/`, add the `sheriff-grant` role and its scoped inline policy. The
   policy names the existing identity store id and the existing `Admins` group
   id, both literals; record the identity store id in the repo the way
   `utils/accounts.ts` records account ids. No new group resources, so the
   create-order dependency the delegate reviewer flagged in the first revision
   does not arise; if a future edit does reference a Pulumi-created resource, it
   must use an `Output` reference (see "The tool's own privilege").

3. **The Lambda, dry.** A separate Slack app, its own signing secret and bot
   token in Secrets Manager in the infrastructure account, and a new Lambda in
   `deploy-infrastructure/`. Slash command, modal (duration, reason, ticket; no
   account), DynamoDB request records, the channel post and the button handler,
   the approver check (a hardcoded Slack id list at the time; since replaced by
   the `Approvers` group, see "Approval policy"), the state machine up to and
   including the decision, but no `CreateGroupMembership`. The requester
   identity mapping is
   settled (open question 3) as a hard-coded Slack-to-Identity-Store map in the
   Lambda; step 4 replaces it with the email lookup. This is where the flow
   becomes reviewable by people who will never read the IAM policy. `done`.

4. **Approval wired to a real grant.** Resolve the requester from their Slack
   email and gate on the `Engineers` group at request time, then on approval
   assume `sheriff-grant`, write the grant record in the `granting` state, call
   `CreateGroupMembership`, flip the record to `granted`, and post the SSO link
   and the session caveat to the channel. Add the application audit log, the
   reconciliation sweeper, and the alarm on an unexpected membership. The
   sweeper ships in the same step as the first grant, not after it: the thing
   that cleans up must exist before the thing that creates, and it reconciles
   `granting` records so a crash mid-grant cannot strand a membership. Step 5
   adds the one-shot scheduler on top; the sweeper remains the backstop.

5. **Scheduled revocation.** EventBridge Scheduler one-shot at expiry, invoking
   the same Lambda with a `revoke` event, retries and a DLQ, and the channel
   post on revoke. The sweeper from step 4 is the backstop.

There is no separate step to retire `Admins`; it is repurposed in place, and the
existing members are simply memberships the tool did not grant, left alone and
logged informationally rather than reconciled against a baseline. Removing them,
and promoting the no-grant-record case to an alarm, is a deliberate follow-up PR
once the rest of the tool is working, not part of this plan's steps.

## Grounding: the files this touches

For a reviewer checking the plan against the repo:

- `deploy/components/identity-center.ts` — the `permissionSets`, `groups` and
  `accounts` maps. Step 2 changes one field: the `administrator` set's
  `sessionDuration`, from `PT8H` to `PT1H`. The `Admins` group id
  (`88c1b330-a001-707a-06ca-94e289013bf5`) is the literal the grant role's
  policy names, and it is already here.
- `deploy/components/identity-center/policies.ts` — `adminReservedActions`,
  which the reused `administrator` set opts out of, and the `sso-directory` /
  `identitystore` distinction the scoped role policy depends on.
- `delegate/lambdas/verify.ts`, `delegate/lambdas/secrets.ts` — the Slack
  signing and secret-reading **code patterns** the new Lambda follows. Not the
  deployed delegate function and not the `DELEGATES` secret.
- `deploy/components/webhooks.ts` — where the existing delegate Lambda is
  created (management account, `ops` stack). It is the thing this plan
  deliberately does **not** route on.
- `deploy/components/delegate-swarm-prod-read.ts` and
  `deploy-infrastructure/agent-swarm.ts` — the established cross-account assume
  pattern into the management account.
- `deploy-infrastructure/index.ts` — the infrastructure-account project the new
  Lambda, DynamoDB table, scheduler and alarms land in, and its
  explicit-provider rule.
- `deploy-org/policies.ts` — the `Infrastructure` SCP, which permits this
  workload's services and denies CloudTrail tampering.
- `deploy-infrastructure/sheriff-lambda.ts` — the runtime Pulumi
  resources: the Lambda, its execution role and inline policy, the DynamoDB
  table, the log group, the Function URL, the sheriff Slack secret, and step
  4's sweep rule, metric filter, SNS topic and orphaned-membership alarm. The
  explicit-provider rule and `allowedAccountIds` are in
  `deploy-infrastructure/index.ts`.
- `deploy-infrastructure/sheriff/` — the handler itself (`handler.ts`,
  `policy.ts`, `blocks.ts`, `store.ts`, `config.ts`, `identity.ts`), including
  the `Engineers` and `Approvers` gate group ids and the live approver
  resolution.
- `utils/accounts.ts` — `MANAGEMENT_ACCOUNT_ID`, `WORKBENCH_ACCOUNT_ID`,
  `INFRASTRUCTURE_ACCOUNT_ID`, and the pattern for recording the identity store
  id.
- `docs/infrastructure-account.md` — the account plan, and its open questions on
  organization-wide CloudTrail and on what temporary privilege escalation
  assumes into.

### Manual setup (out of band)

The code and the infrastructure are in this repo, but a few things are manual
and are deliberately neither created by Pulumi nor committed:

1. **The Slack app.** Create a separate break-glass app, not the delegate app.
   Add a `/breakglass` slash command and an interactivity request URL, both
   pointed at the `sheriffFunctionUrl` output of the `infrastructure` stack.
   The bot token needs `commands` and `chat:write`, plus `chat:write.public` if
   the app is not a member of the configured channel. No Events API
   subscription is needed; interactivity arrives on the same function.
2. **The secret.** The stack creates an empty Secrets Manager secret named
   `sheriff` in the infrastructure account (394495727159). Populate it by
   hand, never from Pulumi and never in the repo:

   ```sh
   aws secretsmanager put-secret-value \
     --secret-id sheriff \
     --secret-string '{"SLACK_SIGNING_SECRET":"...","SLACK_BOT_TOKEN":"..."}'
   ```

   **Let the stack create it; do not create it first.** A secret that already
   exists when the resource first applies makes `CreateSecret` fail with
   `ResourceExistsException`, and the resource never enters Pulumi state, so
   every later apply fails the same way. `sheriffSlackSecret` carries an
   `import` option for exactly that case: an apply adopts the existing secret
   in place instead of creating a second one, and because the import reads the
   container's metadata and never its value, the credentials stay untouched.
   The option is a one-time adoption -- once the resource is in state Pulumi
   ignores it -- but creating the secret with the stack is still the clean
   path. If you do create one by hand, expect the next apply to adopt it and
   diff only its description and tags against the declaration.

3. **Approvers.** There is nothing to list in this repo. Approval authority is
   membership in the `Approvers` Identity Center group, which the group-sync
   job mirrors from the `Engineering Admin` Workspace group
   (`eng-admin@goodparty.org`). Add or remove an approver in that Workspace
   group; no code change, Pulumi change or redeploy is involved.
4. **The alarm email subscription.** The stack creates the `sheriff-alerts`
   SNS topic and subscribes `aws-infrastructure@goodparty.org`, but the
   subscription stays unconfirmed until someone accepts the AWS email. Until
   then the orphaned-membership alarm fires into a topic with no confirmed
   subscriber.

The configured channel is `#sensitive-access-requests` by default, overridable with the
`APPROVAL_CHANNEL` environment variable on the function.
