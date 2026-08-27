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

### Lockout risk is low

Engineers already cannot touch Identity Center. `sso:PutInlinePolicyToPermissionSet`,
`sso:DeletePermissionSet`, and `sso:CreateAccountAssignment` all simulate
**implicitDeny**, because permission sets are untagged and so never match the
dev allow. Taking them under management does not change that.

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

Three files change together:

- `deploy/deploy.sh`: `pulumi config set --path aws:defaultTags.tags.Environment infra`
- `deploy/Pulumi.ops-dev.yaml`: same value, so local `pulumi preview` matches CI
- `delegate/lambdas/dispatch.ts`: add `{ key: "Environment", value: "infra" }`
  to the `RunTask` tags. Tasks currently carry only `Project`, which is why a
  live task showed no `Environment` value in the tag scan.

Known wart: roughly 45 historical ECS task-definition revisions keep
`Environment=dev`. Pulumi only tags the revision it creates. They are inactive,
so the residual exposure is an engineer deregistering a dead revision. A sweep
is separate cleanup, not part of this change.

### 5. The two EngineerAccess edits

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

## Deploy ordering

Order matters. Steps 1 and 2 are manual and must precede any deploy.

1. **Grant the deploy role SSO access.** A human with AdministratorAccess adds
   `sso:*` and `identitystore:Describe*`/`List*` to
   `GitHubActionsPulumiDeployPolicy`. Click-ops, because that policy is
   click-ops and out of scope.
2. **Pre-tag the five permission sets** with `Environment=infra`, `Project=ops`
   via `aws sso-admin tag-resource`, so the import is clean.
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

The last three rows are regression guards and matter as much as the first four.
This must not cost engineers their dev workflow or their ability to read
delegate logs.

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
