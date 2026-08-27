# Bring IAM Identity Center under IaC, and protect ops-deployed resources

Date: 2026-08-27
Status: Proposed
Repo: `thegoodparty/serve-ops` (`ops`)

## Goal

Three outcomes, in one change:

1. Manage IAM Identity Center permission sets and account assignments as code in `ops`.
2. Retag everything `ops` deploys from `Environment: dev` to `Environment: infra`.
3. Ensure the `EngineerAccess` permission set cannot modify those resources.

## Context

Identity Center is entirely click-ops today. No repo in the org references
`sso-admin`, permission sets, or the identity store. This is greenfield IaC laid
over live, hand-made state, so every resource must be imported rather than
created.

## Findings from live AWS

All of these were verified against the account with the IAM policy simulator on
2026-08-27, not inferred from reading policy.

### Topology narrows the options

`333022194791` is the AWS Organizations management account, and it is the only
account in the org. SCPs are enabled but never apply to the management account,
so they are not available as a control. Permission-set policy is the only lever.

### EngineerAccess is allow-list by tag, not deny-list

The `DevResourceOperations` statement allows `*` on any resource tagged
`Environment=dev`. Prod is protected by omission, not by any deny. The only
explicit prod deny is for `ssm:GetParameter*`, which exists to claw back what
the attached `ReadOnlyAccess` managed policy grants.

The consequence is convenient: **retagging a resource to `infra` is itself the
restriction.** Simulated against `delegate-cluster`:

| `ResourceTag/Environment` | `ecs:DeleteCluster` as engineer |
| --- | --- |
| `dev` (today) | allowed |
| `infra` (proposed) | implicitDeny |

### The retag opens a privilege-escalation path

`DevResourceCreation` allows `*` when the request carries
`RequestTag/Environment=dev` and the resource is not tagged `prod`. Because
`infra != prod`, an engineer can call `ecs:TagResource` on an infra resource
with `Environment=dev`, flip it back, and then own it via
`DevResourceOperations`.

Simulated today: **allowed**. Simulated with `infra` added to the exclusion
list: **implicitDeny**. Without this fix the retag is decorative.

### Two blanket grants ignore tags entirely

`EngineerAccess` carries the `AmazonS3FullAccess` managed policy plus inline
`s3:*` and `sqs:*` on `*`. Tag conditions never enter evaluation.
`s3:DeleteBucket` on `gp-playwright-reports` simulates **allowed** at any tag
value.

### Engineers can escalate to full admin in three calls

A naive simulation of `sso:PutInlinePolicyToPermissionSet`,
`sso:DeletePermissionSet`, and `sso:CreateAccountAssignment` returns
**implicitDeny**, which is misleading. Supplying a `RequestTag` context reveals a
live escalation chain:

1. `sso:TagResource` on any permission set with `Environment=dev`: **allowed**,
   via `DevResourceCreation`.
2. The permission set is now dev-tagged, so `DevResourceOperations` allows `*`
   on it.
3. `sso:PutInlinePolicyToPermissionSet`: **allowed**. The engineer writes
   themselves `*` on `*`.

This predates this work. Step 1 was already allowed against the untagged
permission sets, because `StringNotEquals` evaluates true when the condition key
is absent.

The `DevResourceCreation` fix in this design closes step 1, now that the
permission sets are tagged `infra`. Simulated with the fix: **implicitDeny**.
Closing the account's sharpest escalation path is therefore a direct outcome of
this change, not an incidental one.

Residual, and general rather than Identity Center specific: any **untagged**
resource in the account remains claimable by the same `RequestTag=dev` trick.
Simulated **allowed**. See "Deferred findings".

### Bootstrapping is blocked

`github-actions-pulumi-deploy` has no `sso:*` or `identitystore:*` permissions,
and `GitHubActionsPulumiDeployPolicy` is itself click-ops, outside any repo. It
must be granted by hand before this stack can deploy.

### CI is unaffected by an EngineerAccess deny

Playwright reports are uploaded to `gp-playwright-reports` by the
`web-app-e2e-tests` IAM role from GitHub Actions, not by anyone's SSO session.

## Scope

In scope: Identity Center permission sets and account assignments; the
`Environment: infra` retag; the `EngineerAccess` restriction, infra-tagged
resources only.

Out of scope, by explicit decision: the equivalent prod S3/SQS hole; the
readable Pulumi passphrase; standalone IAM roles including
`github-actions-pulumi-deploy`. See "Deferred findings".

## Design

### 1. Component layout

New `deploy/components/identity-center.ts` exporting `createIdentityCenter()`,
wired into the existing `deploy/index.ts` and the existing `ops-dev` stack.

Instance ARN, identity store ID, and group IDs become module constants with
their resolved names as comments. They are stable: the identity store is native,
with no external IdP issuer on any user, so there is no SCIM sync to drift
against.

The stack name `ops-dev` becomes a misnomer once its tag reads `infra`.
Renaming a Pulumi stack requires a state migration, which is not worth the risk.
Leave the name and note it in `CLAUDE.md`.

### 2. Import, never create

This is the highest-risk part of the change. If Pulumi replaces a permission set
rather than importing it, it deletes it first, and every member of that group
loses access until the create half completes.

Every resource is declared with an inline `import` option and, for the five
permission sets, `protect: true`.

Resource counts: 5 permission sets, 6 managed-policy attachments, 3 inline
policies, 7 account assignments. 21 resources total.

Constants:

- Instance ARN: `arn:aws:sso:::instance/ssoins-790711c2cafff252`
- Identity store: `d-9267e5cf96`
- Account: `333022194791`

Permission set IDs, under `arn:aws:sso:::permissionSet/ssoins-790711c2cafff252/`:

| Name | ID | Session |
| --- | --- | --- |
| EngineerAccess | `ps-209e00e1c6a78a7b` | PT12H |
| AdministratorAccess | `ps-ab3b34dd2d6db1b8` | PT8H |
| ReadOnlyAccess | `ps-790741c400f38152` | PT8H |
| ProductManager | `ps-f75e5d9826239194` | PT8H |
| Billing | `ps-7907e6ad83ceef38` | PT8H |

None have a description or relay state. Do not declare either.

Managed policy attachments. Note `Billing` lives under `job-function/`, which is
the one ARN that is not guessable:

| Permission set | Managed policy ARN |
| --- | --- |
| EngineerAccess | `arn:aws:iam::aws:policy/AmazonS3FullAccess` |
| EngineerAccess | `arn:aws:iam::aws:policy/ReadOnlyAccess` |
| AdministratorAccess | `arn:aws:iam::aws:policy/AdministratorAccess` |
| ReadOnlyAccess | `arn:aws:iam::aws:policy/AWSSecretsManagerClientReadOnlyAccess` |
| ReadOnlyAccess | `arn:aws:iam::aws:policy/ReadOnlyAccess` |
| Billing | `arn:aws:iam::aws:policy/job-function/Billing` |

Inline policies exist on EngineerAccess, ReadOnlyAccess, and ProductManager
only. AdministratorAccess and Billing have none and must not declare one.

Account assignments, all `GROUP` to `AWS_ACCOUNT` `333022194791`:

| Group | ID | Permission set |
| --- | --- | --- |
| Engineers | `383193a0-7001-70d9-a321-ffe6d8af7378` | EngineerAccess |
| Engineers | `383193a0-7001-70d9-a321-ffe6d8af7378` | ReadOnlyAccess |
| Admins | `88c1b330-a001-707a-06ca-94e289013bf5` | AdministratorAccess |
| Admins | `88c1b330-a001-707a-06ca-94e289013bf5` | ReadOnlyAccess |
| Research | `a8011350-50b1-701c-5b41-c0e4c9b30976` | ReadOnlyAccess |
| Product | `2841e390-5011-7007-ad5d-c906acf4807d` | ProductManager |
| Billing Admins | `88313300-9031-70ed-ec00-bb80ba0e94e1` | Billing |

Import ID formats, confirmed from the `@pulumi/aws` v7 provider SDK source:

- `PermissionSet`: `permissionSetArn,instanceArn`
- `ManagedPolicyAttachment`: `managedPolicyArn,permissionSetArn,instanceArn`
- `PermissionSetInlinePolicy`: `permissionSetArn,instanceArn`
- `AccountAssignment`: `principalId,principalType,targetId,targetType,permissionSetArn,instanceArn`

### 3. Pre-tagging, so the import is clean

All five permission sets currently have zero tags. `PermissionSet` is taggable
and subject to `aws:defaultTags`, so Pulumi would want to add
`Environment=infra` and `Project=ops`, and the import would fail on an input
mismatch rather than import cleanly.

Fix: tag the five permission sets by hand as part of bootstrap, so live state
already matches what `defaultTags` produces. `AccountAssignment`,
`ManagedPolicyAttachment`, and `PermissionSetInlinePolicy` are not taggable and
need nothing.

### 4. The tag flip

Two files change together:

- `deploy/deploy.sh`: `pulumi config set --path aws:defaultTags.tags.Environment infra`
- `delegate/lambdas/dispatch.ts`: add `{ key: "Environment", value: "infra" }`
  to the `RunTask` tags. Tasks currently carry only `Project`, which is why a
  live task showed no `Environment` value in the tag scan.

`deploy/Pulumi.ops-dev.yaml` is deliberately NOT changed. `.gitignore` carries
`Pulumi.*.yaml`, so the stack settings file is untracked; `deploy.sh`
reconstructs every value it needs on each run. A local `pulumi preview` needs
that file copied in from a checkout that has it.

Known wart: roughly 45 historical ECS task-definition revisions keep
`Environment=dev`. Pulumi only tags the revision it creates. They are inactive,
so the residual exposure is an engineer deregistering a dead revision. A sweep
is separate cleanup, not part of this change.

### 5. The three EngineerAccess edits

**(a) Close the retag escalation.** In `DevResourceCreation`, one value becomes
a list:

```json
"StringNotEquals": { "aws:ResourceTag/Environment": ["prod", "infra"] }
```

**(b) Close the S3/SQS blind spot, infra only.** This needs two statements, not
one. Bucket tags do not propagate to objects, so `aws:ResourceTag` never matches
on object-level actions such as `s3:PutObject`. A tag-conditioned deny alone
would silently fail to protect object writes.

```json
{
  "Sid": "DenyInfraBucketAndQueueMutation",
  "Effect": "Deny",
  "Action": ["s3:Put*", "s3:Delete*", "s3:Create*", "s3:Replicate*",
             "sqs:Delete*", "sqs:Purge*", "sqs:Send*", "sqs:Set*",
             "sqs:Create*", "sqs:AddPermission", "sqs:RemovePermission"],
  "Resource": "*",
  "Condition": { "StringEquals": { "aws:ResourceTag/Environment": "infra" } }
},
{
  "Sid": "DenyInfraObjectMutation",
  "Effect": "Deny",
  "Action": ["s3:Put*", "s3:Delete*", "s3:Restore*", "s3:Abort*"],
  "Resource": ["arn:aws:s3:::gp-playwright-reports/*"]
}
```

The second statement is shown above as rendered output. In code the
`Resource` list is built from the stack's own infra bucket ARNs rather than
written as a literal, so it stays correct as ops adds buckets. Today that list
resolves to exactly the one bucket shown.

`s3:Get*` and `s3:List*` are deliberately untouched, so engineers keep reading
Playwright reports.

The SQS half matches nothing today, since ops deploys no queues. It is included
so a future queue is protected on creation rather than silently exposed.

**(c) Backstop the Identity Center escalation, unconditionally.** Edit (a)
closes the escalation chain only while the permission sets stay correctly
tagged. A permission set created later without the `infra` tag silently reopens
it, which is exactly how the hole existed in the first place. Explicit deny wins
over any allow, and does not depend on a tag being right:

```json
{
  "Sid": "DenyIdentityCenterMutation",
  "Effect": "Deny",
  "Action": ["sso:Create*", "sso:Delete*", "sso:Update*", "sso:Put*",
             "sso:Attach*", "sso:Detach*", "sso:Provision*", "sso:Tag*",
             "sso:Untag*", "sso:Associate*", "sso:Disassociate*",
             "sso-directory:Create*", "sso-directory:Delete*",
             "sso-directory:Update*", "sso-directory:Add*",
             "sso-directory:Remove*", "identitystore:Create*",
             "identitystore:Delete*", "identitystore:Update*"],
  "Resource": "*"
}
```

Deliberately enumerated rather than written as `NotAction` with a read
allowlist. A `Deny` with `NotAction` on `Resource: "*"` would deny every action
in every service that is not on the list, which is catastrophic rather than
restrictive.

Engineers retain full Identity Center read via the attached `ReadOnlyAccess`
managed policy. Admins are unaffected: they use the separate
`AdministratorAccess` permission set.

### 6. Keep delegate from ever approving permission changes

Three layers. Each is independently insufficient.

**Layer 1: explicit reviewer gate.** The reviewer prompt already forces
comment-only via `SELF_REVIEW` for any `thegoodparty/ops` PR matching
`^(delegate/|deploy/|\.github/workflows/delegate)`. Our files are under
`deploy/`, so this change is already gated today.

That protection is incidental, though. The gate's stated rationale is "changes
to the bot's own system", not "permission changes", so narrowing `deploy/` later
would silently un-protect IAM. Add a separate `PERMISSION_CHANGE` gate in
`delegate/agents/pr-reviewer.ts` keyed on the identity and policy paths, with
its own rationale, and force comment-only on it in step 8 exactly as
`SELF_REVIEW` does.

**Layer 2: CODEOWNERS.** Add `.github/CODEOWNERS` covering the identity
component, the deploy config, and CODEOWNERS itself.

Owner is `@thegoodparty/gp-contrib`. This is deliberate. `gp-secops` holds only
`pull` on `serve-ops`, and GitHub ignores code owners without write access, so
naming it would be silently ineffective, and with layer 3 enabled would deadlock
those PRs instead of protecting them. `gp-admins` has no repo access at all.
`gp-contrib` has `push` and is humans only.

**Layer 3: require code owner reviews.** `develop` currently requires 1 approval
with `require_code_owner_reviews: false`, so `delegate[bot]`'s approval alone can
satisfy the merge gate on any PR the self-gate misses. Flip
`require_code_owner_reviews` to `true`. Without this, CODEOWNERS is advisory and
layer 2 does nothing.

Scope note: the requirement applies only to paths listed in CODEOWNERS, so other
ops PRs are unaffected.

**Why this actually binds.** Delegate approves as `delegate[bot]`, a GitHub App.
Apps cannot be members of teams, so a code-owner requirement naming a team is
unsatisfiable by the bot structurally, not by prompt behavior. Layer 1 depends on
the bot following its prompt; layers 2 and 3 do not.

Follow-up, not in this change: grant `gp-secops` `push` on `serve-ops` and make
it the owner of the IAM paths. That is the semantically correct owner and gives
real gatekeeping rather than "any engineer". It needs an org-admin change.

## Deploy ordering

Order matters. Steps 1 and 2 are manual and must precede any deploy.

1. **Grant the deploy role SSO access.** A human with AdministratorAccess adds
   `sso:*` and `identitystore:Describe*`/`List*` to
   `GitHubActionsPulumiDeployPolicy`. Click-ops, because that policy is
   click-ops and out of scope.
2. ~~**Pre-tag the five permission sets**~~ Done 2026-08-27. All five verified
   carrying exactly `Environment=infra`, `Project=ops`, matching what
   `defaultTags` will produce, so the import is clean.
2b. **Enable `require_code_owner_reviews`** on `develop`. Repo settings, needs
   admin. Without it the CODEOWNERS layer is advisory.
3. **Import pass.** Merge the component with `import` options and the tag flip.
   Gate: `pulumi preview --diff` must show the 21 resources importing with no
   replacements and no property drift. Do not run `up` until that is true.
4. **Policy pass.** Apply the two `EngineerAccess` edits.
5. **Verify.** Run the simulator matrix below.
6. **Cleanup.** Remove the `import` options in a follow-up commit once state is
   settled. Leave `protect: true` in place.

Splitting 3 and 4 matters: if the import misbehaves, the blast radius stays at
"tags changed" rather than "tags changed and everyone's permissions changed".

## Verification

Re-run the simulator against
`arn:aws:iam::333022194791:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_EngineerAccess_7125dde72761a2e6`.

| Action | Resource | Before | Expected after |
| --- | --- | --- | --- |
| `ecs:DeleteCluster` | delegate-cluster | allowed | implicitDeny |
| `ecs:TagResource` (RequestTag=dev) | delegate-cluster | allowed | implicitDeny |
| `s3:DeleteBucket` | gp-playwright-reports | allowed | explicitDeny |
| `s3:PutObject` | gp-playwright-reports/* | allowed | explicitDeny |
| `s3:GetObject` | gp-playwright-reports/* | allowed | allowed |
| `logs:GetLogEvents` | /aws/ecs/delegate | allowed | allowed |
| `ecs:DeleteCluster` | any dev-tagged resource | allowed | allowed |
| `sso:TagResource` | EngineerAccess permission set | allowed | explicitDeny |
| `sso:PutInlinePolicyToPermissionSet` | EngineerAccess permission set | allowed | explicitDeny |
| `sso:CreateAccountAssignment` | any | allowed | explicitDeny |
| `sso:DescribePermissionSet` | any | allowed | allowed |
| `identitystore:ListUsers` | any | allowed | allowed |

The `allowed -> allowed` rows are regression guards and matter as much as the
denials. This must not cost engineers their dev workflow, their ability to read
delegate logs, or their Identity Center visibility.

Edit (c) was verified in isolation before being written into this document:
every escalation verb returns `explicitDeny`, every `sso`/`identitystore` read
returns `allowed`, and `s3`, `ecs`, and `logs` actions are unaffected.

Also confirm after deploy that the delegate webhook still dispatches a Fargate
task end to end, since the task definition is replaced by the tag change.

## Risks and rollback

**Permission set replaced instead of imported.** Highest severity: revokes
access for a whole group. Mitigated by `protect: true`, by the zero-drift
preview gate, and by Pulumi refusing an import whose inputs do not match.
Rollback: recreate from the values recorded in this document, which is why the
policy contents and ARNs are written down here in full.

**Deny is broader than intended.** Rollback is removing the two statements and
redeploying. Reads are untouched throughout, so the worst case is engineers
losing writes they had, not losing visibility.

**Tag flip breaks a runtime path.** Nothing in `delegate/` reads the
`Environment` tag; the only tag logic is cost attribution in `dispatch.ts`.
Low likelihood, caught by the end-to-end dispatch check.

## Deferred findings

Two confirmed live findings this change deliberately does not address. Recorded
so they are not lost.

1. **Prod S3 and SQS are not protected.** Every engineer can `s3:DeleteBucket` a
   `prod`-tagged bucket. Simulated allowed. Same blanket-grant root cause as the
   infra hole this change closes.
2. **The Pulumi state passphrase is readable by every engineer.**
   `ssm:GetParameter` on `/pulumi-state-config-passphrase` simulates allowed:
   the parameter is untagged and the SSM deny is prod-only. That passphrase
   decrypts ops Pulumi state.
3. **Untagged resources are claimable.** `DevResourceCreation` grants `*` when
   the caller supplies `RequestTag/Environment=dev` and the resource is not
   tagged `prod` or `infra`. An absent tag satisfies `StringNotEquals`, so any
   untagged resource in the account can be tagged into an engineer's control and
   then fully operated on. This change closes the case that matters most
   (permission sets, now `infra`-tagged) but not the general pattern. The real
   fix is requiring `Environment` on creation, which is a broader policy change.
