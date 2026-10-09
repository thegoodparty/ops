# Break glass: just-in-time admin access

> **Status: proposal, revised after review.** This is a design draft, not an
> accepted plan, and nothing below is built. Most of the decisions in it were
> settled in review of the first revision and now read as decisions rather than
> options; the few that remain open are marked **open**, and one residual
> ambiguity from review is called out explicitly under "Existing members". It
> is still written to be reviewed line by line.

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

## Progress

One step at a time, one pull request per step. Statuses are `todo`,
`doing (who, date)`, and `done (date, evidence)`. Since this is a proposal with
no implementation, every step is `todo`. Make `who` name the session, not the
model.

Bookkeeping rides in the implementation PR. The convention in
[`workbench-account.md`](./workbench-account.md) is to push a `doing` status
change before starting, but this repo requires human review for most changes,
so a separate bookkeeping PR is a second review for no information. Update the
status in the same PR as the work it describes and say so in the PR body. A
step whose work leaves no PR (a console action, a support case) is the
exception and still gets a small PR of its own.

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
- [ ] 2. Definitions only, no runtime: shorten the existing `administrator`
      permission set's `sessionDuration` from `PT8H` to `PT1H` in
      `deploy/components/identity-center.ts`, and add the management-account
      `break-glass-grant` role and its scoped inline policy in `deploy/`. No new
      permission set and no new group; see "Core mechanism". `todo`
- [ ] 3. The Lambda, dry: a separate Slack app, its own signing secret and bot
      token in the infrastructure account, a new Lambda in
      `deploy-infrastructure/`, the slash command and modal, a DynamoDB request
      record, the approval post and the button handler, all the way to the
      approval decision, but no grant. This makes the flow visible before
      anything can be escalated. `todo`
- [ ] 4. Wire approval to a real grant: assume `break-glass-grant`, call
      `identitystore:CreateGroupMembership`, write the grant, post the SSO link.
      Add the application audit log, the reconciliation sweeper, and the alarm
      on an unexpected membership. `todo`
- [ ] 5. EventBridge Scheduler revocation at expiry, with retries and a DLQ, on
      top of the sweeper from step 4. `todo`

## Goal

Stated as an invariant rather than a feature:

- No one outside the current `Admins` set holds standing `AdministratorAccess`
  in any account, **for now**. This is a deliberate, two-phase softening of the
  original "no person holds standing admin": the members of `Admins` today stay
  as memberships the tool does not manage, and the JIT flow governs everyone
  else. The transition ends when the engineer removes the remaining standing
  members manually and a follow-up PR promotes the sweeper's no-grant-record
  case from informational to an alarm, after which the invariant is the
  original one. See "Existing members".
- Any engineer can request admin, for a bounded duration, with a stated reason.
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
| Slack signing and secret handling | `delegate/lambdas/verify.ts` (`verifySlackWebhook`), `delegate/lambdas/secrets.ts` (`getSecrets`) | The **code patterns** only. The deployed delegate function and its `DELEGATES` secret are not reused; see below. |
| A cross-account assume into the management account | `deploy/components/delegate-swarm-prod-read.ts` (trust by account root plus a `PrincipalArn` condition), assumed from the infrastructure account in `deploy-infrastructure/agent-swarm.ts` | The `break-glass-grant` role is the same pattern with a much narrower policy. |
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
- **Revoke**: `identitystore:DeleteGroupMembership` removes the requester,
  unconditionally at expiry, by the `MembershipId` stored on the grant. It does
  not check whether the tool was the thing that added them. A standing admin who
  drives a request through the tool therefore loses their standing membership
  when the grant ends; the engineer accepts this, and it is what keeps the tool's
  grant set and the group's membership set in agreement without a baseline.
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
- No `BreakGlassApprovers` Identity Store group or Slack mirror. The approver
  list is a hardcoded array of Slack user IDs in the tool's code; see "Approval
  policy".

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
- This shortens **every** `Admins` session, including the standing members, not
  only the JIT grants. That is deliberate and confirmed: it is a feature, not a
  side effect. Nobody, standing admin or not, holds a long session, and the
  escalated window is bounded for everyone. A standing member's long-lived
  access is membership, in that they can sign in again at any time; the session
  itself is one hour.
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
for the approver checks (hardcoded list, not the requester), for the audit, and
for keeping the escalation rare. It is also why the first revision's per-account
groups were attractive and why dropping them is a real change: they were a
blast-radius control that this design gives up. The compensating controls are
the approver gate and the audit, not a narrower grant.

### Existing members

The `Admins` group has members today. Review confirmed it is repurposed in
place, so those members stay and there is no migration step. The tool manages
**only the memberships it granted**; it keeps no second source of truth about
who was already a member.

An existing member is therefore just a membership with no grant record in any
state, and the sweeper leaves it alone and logs it at informational level. A
grant record in the `granting` state is still a record, so a member the tool is
mid-way through adding is reconciled by "Never leave a grant open", not mistaken
for a pre-existing member. During the transition that is the expected state for
a standing admin, so it is not suspicious and must not page. The engineer will
remove the remaining standing members manually once the rest of the tool is
working; a follow-up PR then promotes the no-grant-record case from
informational to an alarm, at which point any membership the tool cannot explain
is genuinely suspicious.

A standing member who drives a request through the tool is not special. The
grant is recorded, and `CreateGroupMembership` returns a `ConflictException`
because they are already a member; the Lambda catches it, resolves the existing
`MembershipId`, and records the grant. At expiry the revoke removes them by that
`MembershipId` like anyone else. They lose the standing membership when their
grant ends; the engineer accepts this, and it is the point of managing only what
the tool granted.

The invariant is two-phase, and the transition is ended by a manual cleanup plus
a one-line change to the sweeper's treatment of no-grant memberships, not by
emptying a list. Until then it is "no one outside the current `Admins` set holds
standing admin"; after that it is the original "no standing admin".

## Architecture

```
   Slack (separate break-glass app)     AWS (infrastructure account 394495727159)
   ───────────────────────────────      ────────────────────────────────────────
 /breakglass ──┐
 modal        │  signed with the       ┌────────────────────────────────────────┐
 Approve/Deny ├──break-glass secret───▶│ break-glass Lambda (Function URL)      │
 (in channel) │                        │ patterns from delegate/lambdas         │
              │                        └───────────────┬────────────────────────┘
              │                                        │
              │                        ┌───────────────┼───────────────┐
              │                        ▼               ▼               ▼
              │                  DynamoDB         EventBridge     CloudWatch Logs
              │                  requests,        Scheduler       structured audit
              │                  grants,          one-shot        + metric filters
              │                  rate counters    revoke          + alarms
              │                                        │
              ▼                                        └── both call the same revoke
   #devs-only post  ◀── sts:AssumeRole ──▶ management account 333022194791
                                            role: break-glass-grant
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
- The management-account `break-glass-grant` role and its inline policy, in
  `deploy/`.

**Pulumi (the `infrastructure` stack) owns the runtime**, in
`deploy-infrastructure/`: the new break-glass Lambda and its execution role, its
own Slack secret in Secrets Manager, the DynamoDB table, the EventBridge
Scheduler group, the log group, metric filters and alarms. The Lambda's role
gets `sts:AssumeRole` on exactly one ARN (`break-glass-grant`), plus DynamoDB,
logs, scheduler and its own secret, and nothing else. It is still under the
`Infrastructure` SCP.

The **approver list** is a hardcoded array of Slack user IDs in the Lambda's
code, changed only by a reviewed PR.

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
2. On submit, the Lambda writes a `requested` record and posts a Block Kit
   message to a configured channel, defaulting to `#devs-only`, with **Approve**
   and **Deny** buttons bound to the request id. Outcomes go to the same
   channel. There are no DMs; transparency is the point. If an approver ping is
   wanted, it is an in-channel user-group mention, not a DM.
3. The interactivity endpoint is a route on the new break-glass function, which
   uses the same verification pattern as the delegate handler. Slack sends
   interactivity as `application/x-www-form-urlencoded` with a `payload=<json>`
   field rather than the JSON body the delegate events route parses, so the
   route decodes that before reading the action.
4. The handler re-verifies the Slack signature with the break-glass secret and
   checks that the clicking user is on the hardcoded approver list **and** is
   not the requester. Anyone else gets an ephemeral "not an approver".
5. On **Deny**: write `denied`, post the outcome to the channel, done.
6. On **Approve**: enforce the remaining checks (duration within cap, per-user
   rate limit, request not already decided), then assume `break-glass-grant` and
   **write the grant record first, in a `granting` state**, carrying the request
   id, requester, approver, group id, and the computed expires-at (granted-at
   plus the requested duration). Only then call `CreateGroupMembership`. A
   `ConflictException` means the requester is already a member, so the Lambda
   resolves the existing `MembershipId` with `ListGroupMembershipsForMember` and
   continues; any other error sends the request to `failed`. It then flips the
   record to `granted` with the `membershipId`, schedules the one-shot revoke,
   and posts the SSO portal link and the expiry, with the session caveat, to the
   channel and to the requester.
7. At expiry, EventBridge Scheduler invokes the same Lambda with a `revoke`
   event. It calls `DeleteGroupMembership` with the grant's `MembershipId`,
   unconditionally. A `ResourceNotFoundException` means the membership is
   already gone, so it is treated as success; either way the grant is written
   `revoked` and the channel is posted.

### States

```
requested ──approve──▶ approved ──▶ granting ──▶ granted ──expiry──▶ revoked
    │
    ├──deny───────────▶ denied
    ├──timeout────────▶ expired-unapproved
    └──(any state)────▶ failed

granting ──member absent────────────▶ failed
granting ──member present───────────▶ granted (sweeper schedules the revoke)
granting ──expired, member present───▶ orphaned (revoke + alarm)
```

`granting` is the state between "the approver said yes" and "the membership
exists and its revoke is scheduled". The record is written before the membership
so the state is never invisible, and the sweeper resolves it:

- **member absent**: the grant never completed; the record goes to `failed`.
- **member present**: the grant is live. The `granting` record has no stored
  `membershipId`, because the crash happened before the flip, so the sweeper
  first calls `ListGroupMembershipsForMember` to resolve the existing
  membership's `MembershipId` (matching on the `Admins` group), writes it onto
  the record, and flips the record to `granted`. It then schedules the revoke if
  the schedule is missing.
- **member present past expiry**: the normal path did not finish. The sweeper
  resolves the `MembershipId` the same way, then revokes and alarms (`orphaned`).

DynamoDB is a single table: request items, grant items, and per-user rate
counters. The grant item carries a **`state`** (`granting` or `granted`), the
request id, the group id (`Admins`, which implies all three accounts), the
requester, the approver, the granted-at and expires-at timestamps, and the
scheduler's schedule name. It also carries **`membershipId`**, the opaque
membership id `DeleteGroupMembership` requires, which is absent while the record
is `granting` and set to the value returned by `CreateGroupMembership` (or
resolved with `ListGroupMembershipsForMember` when that call returns
`ConflictException` because the member already existed) when the record becomes
`granted`. The record is written in the `granting` state **before** the
membership is created, which is what guarantees that a membership the tool
created always has a grant record behind it; see "Never leave a grant open". A
`granting` record the sweeper recovers has its `membershipId` backfilled with
`ListGroupMembershipsForMember` before it flips to `granted`.

**TTL is for retention only.** DynamoDB TTL deletion can lag by up to 48 hours,
so it must never be the mechanism that ends a grant. Revocation is the scheduler
plus the sweeper; TTL only cleans up records nobody needs to read anymore.

## The tool's own privilege, which is the crown jewels

The most sensitive object this plan creates is not the permission set, which
already exists. It is the role that lets the tool add and remove memberships.

### `break-glass-grant`, in the management account

- **Trust**: only the break-glass Lambda execution role ARN in the
  infrastructure account, following the `delegate-swarm-prod-read` pattern
  (account root as principal plus an `ArnEquals` `aws:PrincipalArn` condition,
  because IAM rejects a trust naming a role that may not exist at apply time).
  Nothing else can assume it.
- **A fixed `sts:AssumeRole` session name** (for example
  `break-glass-grant-tool`) so CloudTrail records every assume under one
  distinguishable name rather than `AWS-Reserved-Session` or a random string.
- **Inline policy, scoped by resource**, to the identity store id and the
  `Admins` group id: `identitystore:CreateGroupMembership`,
  `identitystore:DeleteGroupMembership`, `identitystore:ListGroupMemberships`,
  `identitystore:ListGroupMembershipsForMember`, `identitystore:DescribeGroup`,
  `identitystore:ListUsers`, `identitystore:DescribeUser`.
  `ListGroupMembershipsForMember` is needed in two places: to resolve the
  `MembershipId` of a pre-existing member when `CreateGroupMembership` returns
  `ConflictException`, and to resolve it for a `granting` record that the
  sweeper or the revoke handler recovers, which has no stored id. The exact
  resource ARN form is confirmed at implementation; the point is that it names
  the one group and the one identity store, not `*`.
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

`sts:AssumeRole` on the one `break-glass-grant` ARN, plus DynamoDB on the one
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
`grant.created`, `grant.revoked`, `grant.expired`, `grant.failed`,
`membership.orphaned` and `membership.unmanaged` from the sweeper. Each carries
the request id, requester, approver, group, reason, ticket link, and timestamps.

There are two signals, and they are deliberately different in loudness:

- **Every `grant.created` writes one low-severity informational audit event**,
  non-paging. This is the durable record of the grant, independent of the tool's
  own approval logic having behaved correctly; it is what a future reader
  reconstructs the history from, and it is what makes the time-boxed gap while
  CloudTrail is absent survivable. It also posts to the channel so the approver
  can see their approval took effect.
- **The loud alarm is on `membership.orphaned`**: an expired grant, in either
  the `granting` or `granted` state, whose member is still in the group, which
  is the signal that the normal revoke path did not run. When the record is
  `granting` and has no stored `MembershipId`, the sweeper resolves it with
  `ListGroupMembershipsForMember` before revoking. Only that pages. A membership
  with no grant record in any state emits `membership.unmanaged` at
  informational level and does not page; see "Existing members".

Metric filters turn those events into metrics. This layer answers *who asked,
who approved, why, how long*.

### AWS audit

CloudTrail. `CreateGroupMembership` and `DeleteGroupMembership` are management
events in the **management account**, because that is where the identity store
lives, and `sts:AssumeRole` into `break-glass-grant` is a management event there
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

- **Who approves.** The approver list is a **hardcoded array of Slack user IDs
  in the tool's code**, changed only by a reviewed PR. There is no Identity
  Store approver group and no Slack mirror; a reviewed PR is a better control
  than a self-service group, and it removes a resource. This is settled.
- **How many.** One approver per request, and the approver must not be the
  requester. For a global escalation that reaches the management account, a
  second approver is tempting, but review settled on one for now; two-person
  approval is a usability cost that should be added deliberately if it is
  wanted, not assumed.
- **Notifications.** A configured channel, default `#devs-only`. The request and
  every outcome are posted there. No DMs. An optional in-channel user-group
  mention can serve as the ping.
- **Availability fallback.** If no approver is online the flow stalls. The
  options are paging an on-call approver (there is a
  `slack-bugduty-oncall-rotation` workflow in this repo that already rotates a
  Slack user group) or a documented manual path. **Do not self-approve after a
  timeout.** A timeout that grants access is not an approval policy; it is an
  outage that escalates. **Open** (open question 6).
- **Rate limit.** A per-user cap on requests per day, and a global cap on
  concurrent grants, both enforced before the grant call. The exact numbers are
  **open**.

## Reliability invariants

- **Never leave a grant open.** Two independent mechanisms: an EventBridge
  Scheduler one-shot at the exact expiry, with retries and a dead-letter queue,
  and a periodic reconciliation sweeper. The sweeper reconciles the tool's own
  grant records, in both the `granting` and `granted` states, against the
  group's current memberships. For a `granting` record it must resolve the
  membership before it can act, because the record has no stored `membershipId`:
  it calls `ListGroupMembershipsForMember` to find the member's membership in
  the `Admins` group, writes that `MembershipId` onto the record, and flips the
  record to `granted`. If the member is absent, the grant never completed and
  the record goes to `failed`, with no alarm. If the member is present, the
  grant is live: the sweeper schedules the revoke if the schedule is missing. If
  the member is present past expiry, it is an **orphaned grant**: the sweeper
  revokes it (with the resolved `MembershipId`) and alarms, because the normal
  revoke path did not run. An active `granted` record is left alone. A
  membership with **no grant record at all** is left alone and logged
  informationally; the sweeper never removes it, because that is the only shape
  a pre-existing standing member can take. The scheduler is the normal path; the
  sweeper is what catches a failed schedule or a grant path that stopped
  partway.
- **The grant record exists before the membership can.** The grant path writes a
  `granting` record first, then calls `CreateGroupMembership`, then flips the
  record to `granted`. If the Lambda dies between the call and the flip, the
  `granting` record is what the sweeper reconciles, so the partial-grant case (a
  member added with no record and no scheduled revoke) cannot occur.
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
  handler treats that as success and marks the grant revoked. Both the scheduler
  and the sweeper use this path, so a double revoke is harmless.
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
3. **Identity mapping for the requester.** How does a Slack user map to an
   Identity Store user id? The approver is now a hardcoded Slack ID, so this is
   needed only for the **requester**, at grant time. If the directory is
   SCIM-provisioned from an IdP, the mapping may already exist; if not, a
   maintained mapping is a prerequisite for step 3. Nothing in this repo records
   SCIM today, so this is a check to run before building.
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
   existing `Admins` members stay and are not removed by the sweeper; they will
   be removed manually in a follow-up PR, which also promotes the sweeper's
   no-grant-record case from informational to an alarm. See "Existing
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
   `deploy/`, add the `break-glass-grant` role and its scoped inline policy. The
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
   the hardcoded approver check, the state machine up to and including the
   decision, but no `CreateGroupMembership`. This is where the requester
   identity mapping has to be settled (open question 3), and where the flow
   becomes reviewable by people who will never read the IAM policy.

4. **Approval wired to a real grant.** Assume `break-glass-grant`, write the
   grant record in the `granting` state, call `CreateGroupMembership`, flip the
   record to `granted`, and post the SSO link and the session caveat to the
   channel. Add the application audit log, the reconciliation sweeper, and the
   alarm on an unexpected membership. The sweeper ships in the same step as the
   first grant, not after it: the thing that cleans up must exist before the
   thing that creates, and it reconciles `granting` records so a crash mid-grant
   cannot strand a membership.

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
- `utils/accounts.ts` — `MANAGEMENT_ACCOUNT_ID`, `WORKBENCH_ACCOUNT_ID`,
  `INFRASTRUCTURE_ACCOUNT_ID`, and the pattern for recording the identity store
  id.
- `docs/infrastructure-account.md` — the account plan, and its open questions on
  organization-wide CloudTrail and on what temporary privilege escalation
  assumes into.

A new Slack app is a configuration artifact outside the repo; it needs its
signing secret and bot token placed in Secrets Manager in the infrastructure
account, and its interactivity and slash-command request URLs pointed at the new
function.
