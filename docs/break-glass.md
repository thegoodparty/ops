# Break glass: just-in-time admin access

> **Status: proposal for discussion.** This is a design draft, not an accepted
> plan and not a description of anything that exists. Nothing below is built.
> It is written to be reviewed line by line in a pull request: every decision
> is meant to be arguable, and the ones that are not settled are marked
> **open**. Comment on the line, not the whole document.

The goal is that no person holds standing admin in any AWS account. An engineer
who needs admin asks for it in Slack, a designated approver approves it, and the
tool grants it by moving an IAM Identity Center group membership for a fixed
window. Every request, approval, grant and revocation is logged.

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
no implementation, every step is `todo`. Claim a step by setting it to `doing`
and pushing that change **before** starting, per the convention in
[`workbench-account.md`](./workbench-account.md); make `who` name the session,
not the model.

Ordering matters and is called out per step. The same rule the other plans use
applies here: a step that grants a permission must merge **and finish applying**
before the step that uses it. The extra rule this plan adds is that step 1 is a
hard prerequisite for the audit half of everything after it — a grant that
cannot be audited should not exist yet.

- [ ] 1. Prerequisite: an organization (or at least management-account)
      CloudTrail trail to an immutable archive, with S3 Object Lock and a
      restricted reader. Blocks the audit half of every later step; see
      "CloudWatch audit" and open question 7. `todo`
- [ ] 2. Identity Center and IAM definitions only, no runtime: the `BreakGlass`
      permission set, per-account `BreakGlass-<account>` groups and their
      `AccountAssignment`s in `deploy/components/identity-center.ts`, the
      management-account `break-glass-grant` role and its scoped inline policy
      in `deploy/`, and the approver list (an Identity Store group plus its
      mirror in Slack). `todo`
- [ ] 3. The Lambda, dry: slash command and modal in Slack, a DynamoDB request
      record, the approval post and the button handler, all the way to the
      approval decision — but no grant. This makes the flow visible and
      reviewable before anything can be escalated, and it is the step where the
      Slack app boundary (open question 2) has to be settled. `todo`
- [ ] 4. Wire approval to `identitystore:CreateGroupMembership` through the
      management-account role, with the application audit log, the alarm on any
      grant, and the reconciliation sweeper running. `todo`
- [ ] 5. EventBridge Scheduler revocation at expiry, with retries and a DLQ, on
      top of the sweeper from step 4. `todo`
- [ ] 6. Retire the standing `Admins` `AdministratorAccess` assignments once the
      JIT path is proven, and record the chosen human recovery path from open
      question 1. `todo`

## Goal

Stated as an invariant rather than a feature:

- No human holds standing `AdministratorAccess` in the management account, the
  workbench account, or the infrastructure account.
- Any engineer can request admin for one account, for a bounded duration, with a
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
| Identity Center is fully code-owned | `deploy/components/identity-center.ts`, applied by `github-actions-pulumi-deploy` (which holds `sso:*`) | Adding a `BreakGlass` permission set, groups and `AccountAssignment`s is a normal PR in that file, not new machinery |
| Slack signing and secrets | `delegate/lambdas/verify.ts` (`verifySlackWebhook`), `delegate/lambdas/secrets.ts` (`getSecrets`), `@slack/web-api` in `delegate/lambdas/handler.ts` | The break-glass Lambda verifies Slack the same way, with the same `SLACK_SIGNING_SECRET` |
| Route dispatch on a Function URL | `delegate/lambdas/handler.ts` (`routes`, `rawPath`) | The interactivity endpoint is a new route, not a new service pattern |
| A cross-account assume into the management account | `deploy/components/delegate-swarm-prod-read.ts` (trust by account root plus a `PrincipalArn` condition), assumed from the infrastructure account in `deploy-infrastructure/agent-swarm.ts` | The `break-glass-grant` role is the same pattern with a much narrower policy |
| The infrastructure account and its guardrails | `deploy-infrastructure/`, the `Infrastructure` SCP in `deploy-org/policies.ts` | The Lambda, DynamoDB, scheduler and alarms land there, under that SCP |

Two corrections to the framing above, recorded because the house style is to
ground a plan in what the repo actually says:

- The existing delegate webhook Lambda is created by
  `deploy/components/webhooks.ts`, which is part of the `ops` stack and
  therefore the **management** account, not the infrastructure account. The
  infrastructure account's workload today is the Delegate swarm host
  (`deploy-infrastructure/agent-swarm.ts`). This plan proposes the break-glass
  Lambda run in the infrastructure account, which is where
  `infrastructure-account.md` says privileged automation belongs. Whether it is
  a route on the existing function or a new function in the new account is open
  question 2.
- The infrastructure account's `Infrastructure` SCP denies CloudTrail tampering
  (`StopLogging`, `DeleteTrail`, `UpdateTrail`, `PutEventSelectors`) and IAM
  users and long-lived keys, and has no data-store deny, so Lambda, DynamoDB,
  EventBridge Scheduler and CloudWatch Logs are all permitted there. The management account, where the identity store lives, has
  **no SCP at all** — SCPs do not apply to it. That asymmetry is the reason
  open question 7 is a phase-one dependency rather than a nicety.

## Core mechanism: how to make Identity Center time-bound

Identity Center has no native time-boxed assignment. An `AccountAssignment`
exists until it is deleted. So "temporary" has to be simulated, and there are
three ways to do it.

### Option 1 (recommended): toggle Identity Store group membership

Create one `BreakGlass` permission set carrying the AWS-managed
`AdministratorAccess` policy and a short `sessionDuration`. Assign it **once**,
as a Pulumi resource, to a dedicated `BreakGlass-<account>` Identity Store
group, per account. The tool then adds and removes the requesting user's
membership in that group with `identitystore:CreateGroupMembership` and
`identitystore:DeleteGroupMembership`.

Why this one:

- The permission set and the `AccountAssignment` are provisioned once, by
  Pulumi, and never touched at runtime. There is no drift, no race with CI, and
  no `ProvisionPermissionSet` call in the request path.
- The group is the unit of revocation. Removing a membership is one API call
  and is idempotent, so the revoke path is trivially retryable.
- The blast radius is one account, because a request names one
  `BreakGlass-<account>` group. The permission set is organization-level and
  costs nothing to reuse, so the per-account groups are cheap.
- The approver can see the membership change in Identity Center directly, which
  is a second view of the truth beside the tool's own records.

### Option 2 (rejected): create and delete `AccountAssignment` on demand

The tool would call `sso:CreateAccountAssignment` on approval and
`DeleteAccountAssignment` on expiry. Rejected for two reasons, either of which
is enough:

- `ProvisionPermissionSet` is not instant. It takes tens of seconds to minutes,
  so the grant has an unpredictable start and the revoke has an unpredictable
  end. The whole point is a bounded window.
- The assignments are owned by Pulumi. Mutating them at runtime makes the tool
  and `deploy.yml` fight over the same resources, and the next apply either
  reverts the tool's change or reports drift forever. The infrastructure plan
  already records the general principle: runtime mutation of code-owned
  resources is a fight with CI.

### Option 3 (rejected): STS session credentials instead of Identity Center

The tool could mint temporary credentials with `sts:AssumeRole` and a
`DurationSeconds`, and hand those to the requester. Rejected because it gives no
console or SSO path, and because the request was explicitly for an Identity
Center experience: a role appears in the user's SSO portal and expires on its
own. STS sessions also cannot be revoked before they expire, which is worse
than the Identity Center case, not better. STS is still used, but only for the
tool's own cross-account call into the management account, not to grant the
human.

### The caveat this design has to live with

Removing a group membership does **not** terminate a session that is already
open. A user who signed in while a member keeps the `BreakGlass` role until
that session reaches the permission set's `sessionDuration`. So:

- Set the `BreakGlass` `sessionDuration` short. Identity Center permits 1 to 12
  hours; `PT1H` is the floor and is what this plan assumes. It is a separate
  permission set from the existing `administrator` set (which is `PT8H`) for
  exactly this reason, even though both carry `AdministratorAccess`.
- Treat the requested duration as the **grant window**, not a guarantee. The
  honest worst case is `requested duration + remaining session`, which with a
  `PT1H` set is at most roughly twice the request. State this in the Slack
  reply rather than implying a hard cutoff.
- A user already signed in has to sign in again to see the new role. The Slack
  reply therefore links the SSO portal and says to sign out and back in.

This caveat is the strongest argument for per-account groups and short
sessions, and it should be in the document a future reader sees, not only in a
Slack message.

### Why the permission set carries no guardrails

`deploy/components/identity-center.ts` composes `adminReservedActions` into
every permission set's inline policy unless `guardrails: false` is set. The
`BreakGlass` set must opt out, for the same reason the existing `administrator`
set does: `adminReservedActions` denies the organization and Identity Center
writes that admin exists to perform, and applying it to the recovery path would
remove the recovery path at the exact moment it is needed. This is a one-line,
reviewable consequence of an existing convention, not a new decision.

## Architecture

```
   Slack                       AWS (infrastructure account 394495727159)
   ─────                       ─────────────────────────────────────────
 /breakglass ──┐
 modal        │  signed      ┌──────────────────────────────────────────┐
 Approve/Deny ├─────────────▶│ Lambda Function URL (verify.ts, secrets) │
              │              └───────────────┬──────────────────────────┘
              │                              │
              │              ┌───────────────┼───────────────┐
              │              ▼               ▼               ▼
              │        DynamoDB         EventBridge     CloudWatch Logs
              │        requests,        Scheduler       structured audit
              │        grants,          one-shot        + metric filters
              │        rate counters    revoke          + alarms
              │                              │
              │                              └── both call the same revoke
              ▼
        Slack post/DM  ◀── sts:AssumeRole ──▶ management account 333022194791
                                              role: break-glass-grant
                                              identitystore:CreateGroupMembership
                                              identitystore:DeleteGroupMembership
                                              scoped to BreakGlass-* group ids
```

**Pulumi (the `ops` stack) owns the durable definitions**, not the runtime
state:

- The `BreakGlass` permission set and each `BreakGlass-<account>` group and
  `AccountAssignment`, in `deploy/components/identity-center.ts`.
- The management-account `break-glass-grant` role and its inline policy, in
  `deploy/`.
- The approver list, as an Identity Store group (and a Slack user group mirror
  for DMs).

**Pulumi (the `infrastructure` stack) owns the runtime**, in
`deploy-infrastructure/`: the Lambda and its execution role, the DynamoDB
table, the EventBridge Scheduler group, the log group, metric filters and
alarms. The Lambda's role gets `sts:AssumeRole` on exactly one ARN
(`break-glass-grant`), plus DynamoDB, logs, scheduler and secrets, and nothing
else. It is still under the `Infrastructure` SCP.

**Two hard rules**, stated here so they are not lost in the detail:

1. **No LLM in the approval path.** The decision to grant is made by a human,
   enforced by a deterministic Lambda. A delegate agent is not in this flow.
   The delegate system is a fine place to build tooling; it is the wrong place
   to put a policy decision with this consequence, because its inputs are
   untrusted text.
2. **The tool can only toggle membership in fixed groups.** It cannot create a
   permission set, cannot create an account assignment, and cannot grant admin
   anywhere except the `BreakGlass-<account>` groups that Pulumi created. The
   inline policy's `Resource` list is the enforcement; see below.

## The Slack flow and the state machine

### Flow

1. `/breakglass` opens a modal: **account** (a select of the three), **duration**
   (a select bounded by the cap), **reason** (free text, required), and an
   **incident or ticket link** (required, so a grant is always attached to
   something).
2. On submit, the Lambda writes a `requested` record and posts a Block Kit
   message to `#break-glass` with **Approve** and **Deny** buttons bound to the
   request id, and DMs the approver group the same message.
3. The interactivity endpoint is a **new route on the existing handler**, reusing
   `verifySlackWebhook`. Slack sends interactivity as
   `application/x-www-form-urlencoded` with a `payload=<json>` field rather than
   the JSON body the events route parses, so the route has to decode that before
   it can read the action — this is the one real difference from the existing
   `/slack` handler and is worth calling out in review.
4. The handler re-verifies the Slack signature and checks the clicking user is
   on the code-owned approver list. Anyone else gets an ephemeral "not an
   approver".
5. On **Deny**: write `denied`, post the outcome, done.
6. On **Approve**: enforce the policy checks (not self-approval, duration within
   cap, per-user rate limit, request not already decided), then assume
   `break-glass-grant`, call `CreateGroupMembership`, write the grant with its
   expiry, schedule the one-shot revoke, and post the SSO portal link and the
   expiry to the channel and to the requester.
7. At expiry, EventBridge Scheduler invokes the same Lambda with a `revoke`
   event. It calls `DeleteGroupMembership`, writes `revoked`, and posts to the
   channel.

### States

```
requested ──approve──▶ approved ──grant──▶ granted ──expiry──▶ revoked
    │                                            │
    ├──deny───────────▶ denied                   └──expired (sweeper found it)
    └──timeout────────▶ expired-unapproved

any state ──error────▶ failed
```

DynamoDB is a single table: request items, active-grant items, and per-user rate
counters. The grant item carries the request id, the account, the group id, the
requester, the approver, the granted-at and expires-at timestamps, and the
scheduler's schedule name so the revoke can be idempotent.

**TTL is for retention only.** DynamoDB TTL deletion can lag by up to 48 hours,
so it must never be the mechanism that ends a grant. Revocation is the
scheduler plus the sweeper; TTL only cleans up records nobody needs to read
anymore.

## The tool's own privilege, which is the crown jewels

The most sensitive object this plan creates is not the `BreakGlass` permission
set — it is the role that lets the tool add and remove memberships.

### `break-glass-grant`, in the management account

- **Trust**: only the Lambda execution role ARN in the infrastructure account,
  following the `delegate-swarm-prod-read` pattern (account root as principal
  plus an `ArnEquals` `aws:PrincipalArn` condition, because IAM rejects a trust
  naming a role that may not exist at apply time). Nothing else can assume it.
- **A fixed `sts:AssumeRole` session name** (for example
  `break-glass-grant-tool`) so CloudTrail records every assume under one
  distinguishable name rather than `AWS-Reserved-Session` or a random string.
- **Inline policy, scoped by resource**, to the identity store id and the
  specific `BreakGlass-*` group ids:
  `identitystore:CreateGroupMembership`, `identitystore:DeleteGroupMembership`,
  `identitystore:ListGroupMemberships`, `identitystore:DescribeGroup`,
  `identitystore:ListUsers`, `identitystore:DescribeUser`.
- **Not granted**: any `sso:*`, `CreateAccountAssignment`,
  `CreatePermissionSet`, `sso-directory:AddMemberToGroup`, or anything that
  could grant admin outside the fixed groups. `sso-directory` is worth naming
  explicitly: `adminReservedActions` records that it carries its own
  `AddMemberToGroup`, so a policy that allowed `sso-directory:*` would be a
  second, unnoticed path to the same directory mutation. The tool gets only the
  `identitystore` namespace, scoped to resources.

The identity store id is not recorded in this repo today. It is a literal the
policy's `Resource` needs, and step 2 has to record it the way the other ids in
`utils/accounts.ts` and the progress sections are recorded.

### The Lambda's role, in the infrastructure account

`sts:AssumeRole` on the one `break-glass-grant` ARN, plus DynamoDB on the one
table, CloudWatch Logs on the one group, EventBridge Scheduler on the one
schedule group, and the `DELEGATES` secret read it needs for the Slack token and
signing secret. Nothing else. It is still bound by the `Infrastructure` SCP, and
`DenyCloudTrailTampering` in that SCP is inert today because the account has no
trail — which is the point of step 1.

### The honest residual risk

**Whoever controls the tool's code controls admin.** The human approver is the
control, but the tool is what enforces the approver, so a compromised or
malicious change to the Lambda bypasses the approval entirely and calls
`CreateGroupMembership` for anyone. This is inherent to the design and should
not be papered over. The mitigations are:

- The code is deployed by CI from a reviewed branch, and `deploy/` and
  `deploy-infrastructure/` are owned paths requiring human review.
- An alarm fires on **every** `CreateGroupMembership`, so a grant that did not
  go through a Slack approval is loud.
- The reconciliation sweeper catches memberships with no matching grant.
- The audit trail is immutable (step 1), so a bad grant cannot be hidden after
  the fact, only seen.
- The blast radius of the tool is the fixed groups in the three named accounts,
  not the organization.

The tool does not protect against someone with write access to its own code and
the ability to wait for a deploy. That is a statement about who has repo write
access, not about the tool, and it belongs in the threat model.

## CloudWatch audit: two layers, two different questions

### Application audit

A structured-JSON CloudWatch Logs group, written by the Lambda, with one event
per transition: `request.created`, `request.approved`, `request.denied`,
`grant.created`, `grant.revoked`, `grant.expired`, and `grant.failed`. Each
carries the request id, requester, approver, account, group, reason, ticket
link, and timestamps.

Metric filters turn those into a metric, and the important alarm is the loud
one: **any** `grant.created` pages or posts, because a grant is a rare,
high-consequence event and the human approver should be told out of band that
their approval actually took effect. This layer answers *who asked, who
approved, why, how long*.

### AWS audit

CloudTrail. `CreateGroupMembership` and `DeleteGroupMembership` are management
events in the **management account**, because that is where the identity store
lives, and `sts:AssumeRole` into `break-glass-grant` is a management event there
too. This layer answers *what did the tool actually do to AWS*, independently of
the tool's own logs, and it is the layer a compromised tool cannot rewrite.

### The gap, which is why step 1 exists

[`infrastructure-account.md`](./infrastructure-account.md) lists
"Organization-wide CloudTrail" as an open question, and the `Infrastructure`
SCP's `DenyCloudTrailTampering` statement is inert until a trail exists. The
management account has no SCP protection at all. So today there may be no
durable trail covering the account where every grant actually lands, and even if
there is one, an actor in the management account can turn it off.

A trail covering the management account — ideally every member account —
shipping to an S3 bucket with Object Lock and a restricted reader is therefore a
**phase-one dependency, not a follow-up**. Without it, the application audit is
the only record, and the application audit is written by the tool being
audited. That is the difference between a log and an audit.

## Approval policy (mostly open)

- **Who approves.** A code-owned list is better than a self-service Slack group,
  because changing the approver list is a reviewed PR rather than an invite.
  The source of truth should be an Identity Store group (`BreakGlassApprovers`),
  which the tool reads through the scoped `identitystore:ListGroupMemberships`
  and `ListUsers` grants, mirrored to a Slack user group so the DM can reach the
  right people. This is a **proposed** decision.
- **How many.** One approver for a normal request. For the **management
  account**, consider two, because admin there is effectively org admin: SCPs do
  not apply to it, and it can create accounts and edit SCPs. Two-person approval
  is a real usability cost and should be justified explicitly, not adopted by
  default.
- **Availability fallback.** If no approver is online the flow stalls. The
  options are paging an on-call approver (there is a `slack-bugduty-oncall-rotation`
  workflow in this repo that already rotates a Slack user group) or a documented
  manual path. **Do not self-approve after a timeout.** A timeout that grants
  access is not an approval policy; it is an outage that escalates.
- **Rate limit.** A per-user cap on requests per day, and a global cap on
  concurrent grants, both enforced before the grant call. The exact numbers are
  **open**.

## Reliability invariants

- **Never leave a grant open.** Two independent mechanisms: an EventBridge
  Scheduler one-shot at the exact expiry, with retries and a dead-letter queue,
  and a periodic reconciliation sweeper. The sweeper lists the current
  `BreakGlass-*` group memberships, compares them against active grants, revokes
  anything expired, and alarms on any membership with no matching grant. The
  scheduler is the normal path; the sweeper is what catches a failed schedule
  and a membership the tool did not create.
- **Idempotent revoke.** `DeleteGroupMembership` on a non-member is a no-op
  worth tolerating, and the grant record's state makes a double revoke
  harmless. Both the scheduler and the sweeper may fire for the same grant.
- **Fail closed on grant, not on revoke.** If the approval checks or the
  `CreateGroupMembership` call fail, no access is granted and the request goes
  to `failed`. If a revoke fails, retry and alarm; never leave it.
- **The sweeper is read-heavy and cheap.** It is a periodic `ListGroupMemberships`
  per `BreakGlass-*` group plus a DynamoDB query. It should run often enough
  that drift is measured in minutes, not hours.

## Rejected alternatives

Collected here so the mechanism section stays readable:

- **Create/delete `AccountAssignment` on demand** — rejected under Option 2
  above: provisioning latency and a fight with Pulumi over code-owned
  resources.
- **STS session credentials instead of Identity Center** — rejected under
  Option 3: no console/SSO path, and STS sessions cannot be revoked early.
- **An LLM agent as the approver or the gate** — rejected by the first hard
  rule. The decision has to be a human's and the enforcement has to be
  deterministic; a prompt-injectable input must not be able to grant admin.
- **A standing admin group as the normal path** — that is what exists today,
  and it is the thing this plan is trying to remove. It survives only, if at
  all, as the audited recovery path in open question 1.
- **A shared `BreakGlass` group across accounts** — rejected in favor of
  per-account groups so one request grants one account and the blast radius is
  one account.

## Open questions

Each of these is a decision this draft does not make. They are numbered so a
reviewer can comment on one.

1. **Standing admin already exists, and it contradicts the goal.** The `Admins`
   group holds a permanent `AdministratorAccess` assignment in the management
   account, the workbench account **and** the infrastructure account
   (`deploy/components/identity-center.ts`), and
   `infrastructure-account.md` calls that the break-glass recovery route that
   does not depend on CI. If no standing admin is the goal, those assignments
   must be retired (step 6), but that removes the recovery path when this tool
   is down. What is the human recovery path if the tool breaks? Options:
   **(a)** keep one audited standing admin group as break-glass-of-the-break-glass;
   **(b)** management-account root with MFA and a two-person runbook;
   **(c)** a manual `sso` call by a CI role. Recommend exactly one, document it,
   and alarm on its use, with the JIT flow as the normal path.
2. **Slack app boundary.** Reuse the existing delegate Slack app and its signing
   secret, or stand up a separate app with its own scopes? The lean answer is
   the same app (interactivity and a slash command are app settings, not a new
   app) with a separate Lambda and IAM role so the privileged code is not the
   code that handles `@mention`s. Whether the interactivity route lives on the
   existing function or a new one is part of this.
3. **Identity mapping.** How does a Slack user map to an Identity Store user
   id? If the directory is SCIM-provisioned from an IdP, the mapping may already
   exist; if not, a maintained mapping is a prerequisite for step 3. Nothing in
   this repo records SCIM today, so this is a check to run before building.
4. **Account scope for phase one.** Management and production only, or all
   three accounts? The management account is the one with no SCP and the
   highest consequence, which is an argument for doing it first and carefully;
   the other two are lower risk and easier to test.
5. **Duration caps.** Default and maximum. This draft assumes default `PT1H`,
   max `PT4H`, and a `PT1H` permission-set session. Whether the cap differs per
   account (management tighter) is open.
6. **Tool availability and SLA, and the manual path.** What is the availability
   target, and what happens when Slack or the Lambda is down? This is entangled
   with open question 1: the manual path and the standing-admin decision are the
   same question asked twice.
7. **CloudTrail immutability.** Retention period, whether the archive bucket
   uses S3 Object Lock (governance or compliance mode), and who can read the
   audit log. A trail nobody can read is not an audit; a trail everyone can read
   is a data-exposure problem. This is step 1 and blocks the audit half of the
   plan.

## Implementation plan

The Progress list is the checklist; this is the detail behind each step.

1. **CloudTrail prerequisite.** An organization trail (preferred) or at minimum
   a management-account trail, to an S3 bucket with Object Lock, a retention
   policy, and a read role that is not the tool's role and not
   `AdministratorAccess`. This is the same gap `infrastructure-account.md`
   records, promoted here to a blocker because a JIT grant without an
   independent trail is a grant with only the tool's word for it. Where the
   trail is defined (org stack, `deploy/`, or console) is part of the step.

2. **Definitions, no runtime.** In `deploy/components/identity-center.ts`: add a
   `breakGlass` entry to `permissionSets` with `AdministratorAccess`,
   `sessionDuration: "PT1H"` and `guardrails: false`; add `BreakGlass-Main`,
   `BreakGlass-Workbench` and `BreakGlass-Infrastructure` to the `groups` map
   (with ids recorded once they exist) and the matching
   `AccountAssignment`s. In `deploy/`: the `break-glass-grant` role and its
   scoped inline policy, plus the `BreakGlassApprovers` group and its Slack
   mirror. Nothing here changes runtime behavior; it only makes the groups and
   the role exist.

3. **The Lambda, dry.** Slash command, modal, DynamoDB request records, the
   approval post and the button handler, the approver check, the state machine
   up to and including the decision — but no `CreateGroupMembership`. This is
   where the Slack app boundary and the identity mapping have to be settled
   (open questions 2 and 3), and where the flow becomes reviewable by people who
   will never read the IAM policy.

4. **Approval wired to a real grant.** Assume `break-glass-grant`, call
   `CreateGroupMembership`, write the grant, post the SSO link. Add the
   application audit log, the alarm on any grant, and the reconciliation
   sweeper. The sweeper ships in the same step as the first grant, not after it:
   the thing that cleans up must exist before the thing that creates.

5. **Scheduled revocation.** EventBridge Scheduler one-shot at expiry, invoking
   the same Lambda with a `revoke` event, retries and a DLQ, and the channel
   post on revoke. The sweeper from step 4 is the backstop.

6. **Retire the standing admin.** Remove the `Admins` `AdministratorAccess`
   assignments in the three accounts, and record the chosen recovery path from
   open question 1. This is last on purpose: it is the step that removes the
   thing that currently works, and it should not happen until the replacement is
   proven in production and the recovery path is documented and alarmed.

## Grounding: the files this touches

For a reviewer checking the plan against the repo:

- `deploy/components/identity-center.ts` — the `permissionSets`, `groups` and
  `accounts` maps; `guardrails`; `sessionDuration`. Step 2 edits this file.
- `deploy/components/identity-center/policies.ts` — `adminReservedActions`,
  which the `BreakGlass` set opts out of, and the `sso-directory` /
  `identitystore` distinction the scoped role policy depends on.
- `delegate/lambdas/verify.ts`, `delegate/lambdas/secrets.ts`,
  `delegate/lambdas/handler.ts` — the Slack substrate reused by the tool.
- `deploy/components/webhooks.ts` — where the existing delegate Lambda is
  created (management account, `ops` stack), which is the correction in "What
  already exists".
- `deploy/components/delegate-swarm-prod-read.ts` and
  `deploy-infrastructure/agent-swarm.ts` — the established cross-account assume
  pattern into the management account.
- `deploy-infrastructure/index.ts` — the infrastructure-account project the
  runtime lands in, and its explicit-provider rule.
- `deploy-org/policies.ts` — the `Infrastructure` SCP, which permits this
  workload's services and denies CloudTrail tampering.
- `utils/accounts.ts` — `MANAGEMENT_ACCOUNT_ID`, `WORKBENCH_ACCOUNT_ID`,
  `INFRASTRUCTURE_ACCOUNT_ID`.
- `docs/infrastructure-account.md` — the account plan, and its open questions on
  organization-wide CloudTrail and on what temporary privilege escalation
  assumes into.
