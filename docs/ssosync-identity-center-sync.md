# Syncing a Google Workspace group into IAM Identity Center with ssosync

> **Status: proposal, plan only. Nothing is deployed by this document.**
> It is written to be reviewed line by line. The one Google group in scope is
> `engineering@goodparty.org`; the one Identity Center group is `Engineers`,
> id `383193a0-7001-70d9-a321-ffe6d8af7378`. The tool under evaluation is
> [`awslabs/ssosync`](https://github.com/awslabs/ssosync), Apache-2.0, current
> release **v2.9.0** (2026-09-28).
>
> This document is the sibling of
> [`infrastructure-account.md`](./infrastructure-account.md), which names
> `goodparty-infrastructure` (`394495727159`) as the home for periodic
> maintenance and automation. It is the first workload proposed for that
> account that reads the management account's Identity Center directory
> rather than only assuming a scoped management-account role.

The goal is that membership in one Google Workspace group is reflected in one
existing IAM Identity Center group, on a schedule, without a human copying
people in and out. The Identity Center group already carries the permission
set assignments (`EngineerAccess`, `ReadOnlyAccess` in the management account;
`WorkbenchAccess` in the workbench account), so the only thing that needs to
change is its membership.

The shape is deliberately boring: a scheduled Lambda, a service account, a
secrets manager entry, an IAM role. There is no model in the path.

The plan surfaces three things that are load bearing and are easy to miss:

1. **ssosync matches Identity Center groups by display name, not email.** As
   released, `--sync-method groups` matches an existing Identity Center group
   whose `DisplayName` equals the Google group's *display name* (its `name`
   field), and otherwise **creates a second group**. The Google group is
   addressed by its email in `--group-match`, but the email is only the
   Google-side filter; it is not what ssosync writes. The reconciliation is in
   ["The group-matching problem"](#the-group-matching-problem-the-critical-one).
2. **ssosync writes through the Identity Center SCIM endpoint, and reads
   through the Identity Store API.** It needs *both* a SCIM bearer token and
   Identity Store read permissions. The commonly repeated summary that "v2.0+
   uses the Identity Store API" is half true: the reads moved there, the
   writes did not. See ["Architecture"](#architecture).
3. **The infrastructure account is not the Identity Center delegated
   administrator.** There are no delegated administrators at all. A principal
   in another member account cannot call the Identity Store API for the
   management account's instance without that registration. See
   ["Delegated administration"](#delegated-administration-the-blocking-prerequisite).

## Progress

One step at a time, one pull request per step. Statuses are `todo`,
`doing (who, date)`, and `done (date, evidence)`. Nothing here is `done`; this
document is the plan. `who` names the session, not the model.

- [ ] 1. **Verify the prerequisites in AWS and Google before writing any
      code.** The two that can invalidate the whole plan are the Identity
      Center identity source (is there a SCIM endpoint at all?) and the
      delegated-administrator decision. See "Prerequisites to verify first".
- [ ] 2. **Reconcile the group name** so ssosync adopts the existing group
      rather than creating a second one. One Google-side rename, or one
      Identity Center rename; see the reconciliation section. Do this before
      the first real run, and prove it with a dry run.
- [ ] 3. **Create the secrets** (Google service-account JSON, Google admin
      email, SCIM endpoint, SCIM access token) in the infrastructure account,
      filled by hand. Pulumi owns the containers only.
- [ ] 4. **Land the Lambda and its schedule** in `deploy-infrastructure/`,
      following `sheriff-lambda.ts`: function, execution role, log group,
      EventBridge rule, secret containers. Deploy with `DRY_RUN=true` and
      `RETAIN_UNMATCHED=true`.
- [ ] 5. **Validate the dry run** against the expected diff; fix any
      surprise.
- [ ] 6. **Flip `DRY_RUN` to false**, invoke once by hand, verify, then let
      the schedule take over.
- [ ] 7. **Record the outcome and the invariant** (the Google group's display
      name is authoritative for the Identity Center group's name) in this
      document.

If the prerequisites in step 1 fail, steps 2-7 do not happen and this becomes
a different plan; that is the point of checking first.

## Prerequisites to verify first

These are not implementation steps; they are facts that decide whether the
plan is viable at all. Two of them cannot be read from this container.

### 1. Is there a SCIM endpoint? (potential blocker)

ssosync's write path is the IAM Identity Center **SCIM v2 endpoint**,
authenticated by a SCIM bearer token. This is not incidental: the write
methods in `internal/aws/client.go` (`CreateGroup`, `UpdateGroup`,
`AddUserToGroup`, `RemoveUserFromGroup`, `CreateUser`, `DeleteUser`) are all
HTTP calls to the SCIM base URL, and the SAM template's execution-role policy
grants only *read* Identity Store actions plus `sso:ListInstances` — writes are
authorized by the bearer token, not by IAM. `--endpoint` and
`--access-token` are required by `config.Validate()`.

The SCIM endpoint is generated by **enabling automatic provisioning**, which
AWS documents under *external identity providers*
([Provision users and groups from an external identity provider using SCIM](https://docs.aws.amazon.com/singlesignon/latest/userguide/provision-automatically.html)).
If goodparty's Identity Center uses the **built-in Identity Store** as its
identity source, there is no SCIM endpoint to copy, and ssosync cannot write
at all.

Verify in the management account console: **IAM Identity Center → Settings →
Identity source**. If it says *Identity Center directory* (the built-in store),
stop and treat this as the blocking question it is. Changing the identity
source to an external IdP is a destructive migration of the directory — it is
not a configuration toggle — and is out of scope for this plan. If it already
names an external IdP (for example Google Workspace over SAML), then
*Automatic provisioning* is available and the SCIM endpoint and a token can be
generated.

This is the single fact most likely to kill the plan, so it is checked first.
It is also consistent with the AWS guidance that *"some IdPs such as Google
Workspace do not support SCIM group provisioning, and require you to create and
manage groups manually through the Identity Store APIs"* — goodparty's groups
are manually managed, which is the expected shape either way.

### 2. Which identity source, and is there a delegated administrator?

`list-delegated-administrators` returned empty on 2026-09-22 (recorded in
`workbench-account.md`), so there are none. The infrastructure account is
therefore **not** the Identity Center delegated administrator. This is
re-checked as part of step 1; see "Delegated administration" for what follows
from it.

### 3. The Google side

- A Google Cloud service account with **domain-wide delegation**, and its JSON
  key.
- The delegation scopes, exactly as ssosync requires:
  - `https://www.googleapis.com/auth/admin.directory.group.readonly`
  - `https://www.googleapis.com/auth/admin.directory.group.member.readonly`
  - `https://www.googleapis.com/auth/admin.directory.user.readonly`
- A Google Workspace **super-admin email** to impersonate
  (`--google-admin`).
- The `engineering@goodparty.org` group's **`name`** (display name) and
  **`id`**, read from the Admin console or the Admin SDK. The display name is
  what ssosync matches on; the id is what it stores as `ExternalId`. The email
  is only the filter.

## Architecture

```
Google Admin SDK (read-only)
  service account + domain-wide delegation
  admin.directory.group.readonly
  admin.directory.group.member.readonly
  admin.directory.user.readonly
        |
        |  HTTPS, service-account JSON from Secrets Manager
        v
ssosync Lambda  (provided.al2023, arm64, us-west-2, 394495727159)
  EventBridge rule, hourly
        |
        |  reads:  Identity Store API  (ListGroups, ListUsers,
        |          ListGroupMemberships, IsMemberInGroups,
        |          GetGroupMembershipId) + sso:ListInstances
        |  writes: Identity Center SCIM v2 endpoint
        |          (bearer token from Secrets Manager)
        v
IAM Identity Center Identity Store (management account 333022194791)
  group Engineers 383193a0-7001-70d9-a321-ffe6d8af7378
        ^
        |  permission set assignments already reference this group id
        |
  EngineerAccess / ReadOnlyAccess (management), WorkbenchAccess (workbench)
```

Two facts about the arrows are worth stating because they shape the IAM policy
and the prerequisites:

- The **reads** are the Identity Store API. They are what makes the delegated
  administration account matter, and what `sso:ListInstances` is for
  (`configLambda()` resolves the identity store id from the instance rather
  than from configuration).
- The **writes** are SCIM. The bearer token is a directory-wide write
  credential: it can create and delete users and groups. It is the most
  sensitive thing this deployment holds, and it is the reason
  `--retain-unmatched` is mandatory.

### Where this wires into `deploy-infrastructure/index.ts`

One new file and two edits to `index.ts`, mirroring the sheriff exactly:

- New `deploy-infrastructure/ssosync-lambda.ts`, exporting
  `createSsosync({ provider })` and its constants (role name, secret names,
  log group name, schedule expression), following `sheriff-lambda.ts`. Every
  resource takes the explicit `{ provider }` from `index.ts`; `deploy.sh`
  disables the default provider, so a resource that omits it fails the apply
  rather than landing in the management account.
- `deploy-infrastructure/index.ts`, after the sheriff block:

  ```ts
  import { createSsosync } from "./ssosync-lambda";
  // ... existing imports and resources ...
  // The ssosync Lambda: engineering@goodparty.org -> the Engineers Identity
  // Center group, hourly. Plan: docs/ssosync-identity-center-sync.md.
  const ssosync = createSsosync({ provider });

  export const ssosyncFunctionName = ssosync.fn.name;
  export const ssosyncSecretArns = ssosync.secretArns;
  ```

  The wiring point is deliberate: after the sheriff block, before the exports,
  so the schedule and the function read top to bottom with the rest of the
  account's contents. Nothing in the sheriff path is touched.

- No change to `deploy.sh`, `Pulumi.yaml` or the provider. The new resources
  take the existing `provider` like every other resource in the project.

The function is invoked by a plain **EventBridge rule** (`aws.cloudwatch.EventRule`
+ `aws.cloudwatch.EventTarget` + `aws.lambda.Permission` for
`events.amazonaws.com`), following the sheriff sweep rule rather than the
scheduler, because this is one fixed recurring schedule and not a
per-invocation one-shot. Proposed interval: **`rate(1 hour)`**. Justification:
group membership changes are not latency-sensitive, an hour bounds staleness
well below the time it takes anyone to notice, and it keeps the Google Admin
API and SCIM call volume low. The SAM template's `rate(15 minutes)` default is
for directories where many groups change often; it is unnecessary here. Set
`reservedConcurrentExecutions: 1` so two runs can never overlap (the SAM
template does the same). `timeout: 300`, `memorySize: 256`.

If the schedule is wanted off during validation, the rule can be created with
`enabled: false` and turned on in the step-6 PR; the function can be invoked by
hand meanwhile.

### Secrets

Following the sheriff pattern: Pulumi creates the secret *containers*, and the
values are set by hand, never by Pulumi and never committed. ssosync's Lambda
config accepts a Secrets Manager **ARN** as the value of each of these
environment variables and resolves it at start-up (`getEnvSensitive` in
`cmd/root.go`), so the ARNs go in the environment and the values never appear
in the task definition.

| Secret | Environment variable | Contents |
|---|---|---|
| `ssosync-google-credentials` | `GOOGLE_CREDENTIALS` | the service-account JSON key |
| `ssosync-google-admin` | `GOOGLE_ADMIN` | the super-admin email to impersonate |
| `ssosync-scim-endpoint` | `SCIM_ENDPOINT` | the Identity Center SCIM URL |
| `ssosync-scim-token` | `SCIM_ACCESS_TOKEN` | the SCIM bearer token |

`CUSTOMER_ID` stays the literal `my_customer`; the service account's domain is
goodparty.org. (ssosync also accepts a secret ARN for it, but there is nothing
secret to store.)

The SCIM token is the crown jewel. It is a directory-wide write credential, it
expires (Identity Center warns ahead of expiry), and it must be rotated. Rotation
is an operational runbook item, not something this plan automates.

## The ssosync invocation

The exact flags, their environment-variable equivalents, and why each is set.

| Flag | Env var | Value | Why |
|---|---|---|---|
| `--sync-method` | `SYNC_METHOD` | `groups` | The group-driven path: it discovers the members of the matched Google group and syncs them, which is what "sync one group" means. It is the default and the non-legacy path (`users_groups` is the legacy one). |
| `--group-match` | `GROUP_MATCH` | `email=engineering@goodparty.org` | Filters the Google side to exactly one group, by email. Exact match, not a prefix, so a future `engineering-*@` group is not swept in. This is a **Google-side** filter; it is not what ssosync matches against the Identity Center group. |
| `--user-match` | `USER_MATCH` | *(unset)* | With `groups`, members are discovered from the group. A separate user query is unnecessary and would widen the blast radius. |
| `--dry-run` | `DRY_RUN` | `true` first, then `false` | First run must make no changes. v2.9.0 is chosen partly because the dry-run group-membership bug (#281) was fixed in v2.7.1. |
| `--retain-unmatched` | `RETAIN_UNMATCHED` | `true`, always | **Mandatory.** Without it, syncing a single group deletes every Identity Center group and user not in scope — `Admins`, `Research`, `Product`, `Billing Admins`, and every user who is not a member of this one group. See below. |
| `--log-level` | `LOG_LEVEL` | `info` scheduled, `debug` for the dry run | `info` gives the change summary and each create/add/remove. `debug` additionally prints the per-object matching decisions, which is what the dry-run review needs. |
| `--log-format` | `LOG_FORMAT` | `json` | Structured logs so CloudWatch Logs Insights can query the change summary and failures. The SAM default is `json`. |
| `--suspended` | `SYNC_SUSPENDED` | *(unset)* | Suspended users are excluded by default. Syncing a suspended engineer into the group would leave them with access; leave the default. |
| `--precache-ous` | `PRECACHE_ORG_UNITS` | *(unset)* | Disables precaching the whole directory. For one group, fetching members on the fly is less API work and less memory. The SAM default of `/` precaches every user. |
| `--force-externalid-update` | `FORCE_EXTERNAL_ID_UPDATE` | *(unset)* | Users with no `ExternalId` are adopted by email match regardless of this flag. It only matters for a user whose Identity Store `ExternalId` is already set to something else, where the default is delete-and-recreate; that is a per-case decision, recorded as a risk, not a blanket flag. |
| `--customer-id` | `CUSTOMER_ID` | `my_customer` | The default; resolves to the domain of the service account. |

`--ignore-groups` is deliberately **not** used. It filters Google groups on the
source side; it does not protect Identity Center objects from deletion.
`--retain-unmatched` is the protection, and adding an ignore list here would
suggest a safety it does not provide.

## The group-matching problem (the critical one)

This is the part that decides whether memberships land in the group that holds
the permission set assignments, or in a duplicate group that holds nothing.

### What the source actually does

For `--sync-method groups`, the group diff is `getGroupOperations()` in
`internal/sync.go` (v2.9.0, commit `1b39874`; the same function is in the
tagged release). For each Google group in scope it does, in order:

1. **Match by `ExternalId`.** If an Identity Center group has `ExternalId`
   equal to the Google group's `id`, it is the same group. If its
   `DisplayName` differs from the Google group's `name`, the `DisplayName` is
   **overwritten** with the Google group's `name`.
2. **Match by `DisplayName`.** Otherwise, if an Identity Center group has
   `DisplayName` equal to the Google group's `name`, it is adopted: ssosync
   backfills `ExternalId` with the Google group's `id`.
3. **Create.** Otherwise ssosync creates a new Identity Center group with
   `DisplayName = googleGroup.Name` and `ExternalId = googleGroup.Id`
   (`aws.NewGroup(g.Email, g.Id)` is the older `SyncGroups` path; the
   `groups` path uses `gGroup.Name`).

The mapping is by the Google group's **display name** (`name`), not its email.
This is the maintainer's own answer to the exact question, in
[awslabs/ssosync#363](https://github.com/awslabs/ssosync/issues/363): *"ssosync
creates groups based on the Display Name of the group"*, and in
[#364](https://github.com/awslabs/ssosync/issues/364): *"if a group name
matches between Google Workspace Directory and IAM Identity Store, it will be
preserved and the group Id from google will be added/updated"*. The README's
older warning that "groups are synced by their email address" describes the
legacy `users_groups`/`SyncGroups` path, which is not the path selected here.

### What that means for `Engineers`

The existing group is `DisplayName = "Engineers"`, id
`383193a0-7001-70d9-a321-ffe6d8af7378`, with no `ExternalId` (it was created
in the Identity Store, not provisioned). The Google group is addressed as
`engineering@goodparty.org`, and its `name` is whatever the Google Workspace
group's display name is — which is **not** necessarily the email.

- If the Google group's `name` is exactly `Engineers`, ssosync matches the
  existing group by display name, backfills `ExternalId`, and syncs members
  into id `383193a0-...`. No duplicate, assignments intact.
- Otherwise (the likely case, and the one this plan is written around),
  ssosync **creates a second Identity Center group** whose `DisplayName` is the Google
  group's `name`, and puts the memberships there. The existing `Engineers`
  group keeps its permission set assignments but loses its members, so nobody
  in the group has the access those assignments grant.

Either way, `--retain-unmatched` must be set. Without it, step 3 of the
unmatched-object pass deletes every Identity Center group whose `ExternalId`
and `DisplayName` are not in scope — that is `Admins`, `Research`, `Product`
and `Billing Admins` — and every user who is not a member of the one group.
This is the exact failure recorded in
[awslabs/ssosync#88](https://github.com/awslabs/ssosync/issues/88), where a run
deleted the Control Tower groups. `--retain-unmatched` was added in v2.8.0 for
this reason.

### The reconciliation

**Read the Google group's `name` first.** It is one API call
(`groups.get`) or one look in the Admin console. Then pick one:

**Recommended: make the Google group's display name `Engineers`.** Set the
Google Workspace group's `name` to `Engineers` (its email stays
`engineering@goodparty.org`). The first run then matches the existing Identity
Center group by display name, backfills `ExternalId`, and syncs memberships
into `383193a0-...`. Nothing in Identity Center changes except membership, so
the permission set assignments are untouched, and the name engineers see at
the SSO portal stays `Engineers`. This is the smaller change and it keeps the
name the repo and the break-glass tooling already use.

The cost, stated plainly: ssosync treats the Google group's display name as
authoritative from then on. If someone renames the Google group, the next run
renames the Identity Center group to match (step 1 or 2 above). That is the
tool's unidirectional model, and it is an operational invariant to record, not
a bug to work around. Keep the Google group's display name `Engineers`.

**Alternative: rename the Identity Center group.** If the Google group's
display name must not change, set the Identity Center group's `DisplayName` to
exactly the Google group's `name` before the first run (Identity Store
`UpdateGroup`, `displayName` path). Permission set assignments reference the
group **id**, not its name, so they survive a rename. The costs: the
user-facing group name changes to whatever Google calls the group (possibly an
email-shaped string), and the `groups` map in
`deploy/components/identity-center.ts` — whose keys are display names — becomes
misleading. Do **not** rename that map key: the key is embedded in the
assignment resource name (`assignment-Engineers-engineer`), and those resources
are `protect`ed, so a rename reads as a delete-plus-create that the apply will
refuse. Leave the key, update its comment.

**Belt and braces, either way:** pre-setting the existing group's `ExternalId`
to the Google group's `id` (Identity Store `UpdateGroup`) makes the match
unambiguous on the first run, but it does not avoid the display-name overwrite
in step 1, so it is only worth doing alongside the name reconciliation, not
instead of it.

## Delegated administration (the blocking prerequisite)

ssosync reads the Identity Store through the Identity Store API. AWS is
explicit that when SCIM provisioning is configured, *"principals in the
management account and the delegated administrator account can call"* the
Identity Store APIs. A role in an arbitrary member account cannot. The
infrastructure account is not that account: `list-delegated-administrators`
returns empty (recorded 2026-09-22 in `workbench-account.md`), and the
infrastructure account's plan does not register one. `sso:ListInstances` is
also only useful from the account that can see the instance.

So there is a decision, and it is an org-level one, not a `deploy-infrastructure`
change.

**Option A — register `394495727159` as the IAM Identity Center delegated
administrator (recommended).** One `organizations:RegisterDelegatedAdministrator`
for service principal `sso.amazonaws.com`, from the management account. It
keeps the Lambda, its schedule, the SCIM token and the service-account key in
the automation account, which is the whole reason that account exists, and it
is what ssosync documents. It belongs in `deploy-org/`, with a grant to
`github-actions-org-deploy` for the `organizations:Register/Deregister/ListDelegatedAdministrators`
actions (which it does not hold today), and it should be its own PR, applied
before the Lambda merges.

The cost, stated plainly: delegated administration grants principals in the
infrastructure account administrative control over Identity Center — permission
sets and assignments in member accounts, though not permission sets in the
management account. That is a real expansion of what the account can reach, and
it should be a deliberate decision by whoever owns the org. If it is taken, the
Lambda's execution role is scoped to reads only (below); the broad reach comes
from the *account* being the delegated administrator, not from the Lambda's
policy, and the account's admin path is already the `Admins` break-glass group.

**Option B — run the Lambda in the management account.** No delegated admin,
no org change, technically the simplest. It puts a scheduled job holding a
directory-wide SCIM token in the production/management account, which is
exactly what `infrastructure-account.md` says not to do ("Adding privileged
automation there compounds that problem rather than solving it"). The fallback
if Option A is refused.

**Option C — assume a scoped management-account role (rejected).** This is the
sheriff pattern and would be the most consistent with the repo's existing
boundary. It is rejected because ssosync builds its Identity Store client from
the default credential chain and offers no way to assume a role for it; making
it work needs a wrapper or a fork around the Lambda entrypoint, which turns a
configuration deployment into maintained code. Revisit only if a wrapper is
wanted for another reason.

Whichever is chosen, **step 1 must confirm the identity source and whether a
SCIM endpoint exists**, because that decides whether any option works.

## Least-privilege IAM

The Lambda execution role gets reads and logging, and no Identity Store write
action at all — writes are authorized by the SCIM bearer token, not IAM, which
is exactly the split the SAM template uses.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSsosyncSecrets",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      "Resource": "arn:aws:secretsmanager:us-west-2:394495727159:secret:ssosync-*"
    },
    {
      "Sid": "ListIdentityCenterInstances",
      "Effect": "Allow",
      "Action": "sso:ListInstances",
      "Resource": "*"
    },
    {
      "Sid": "ReadIdentityStore",
      "Effect": "Allow",
      "Action": [
        "identitystore:ListGroups",
        "identitystore:ListUsers",
        "identitystore:ListGroupMemberships",
        "identitystore:IsMemberInGroups",
        "identitystore:GetGroupMembershipId"
      ],
      "Resource": "arn:aws:identitystore::333022194791:identitystore/d-9267e5cf96"
    },
    {
      "Sid": "OwnLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:us-west-2:394495727159:log-group:/aws/lambda/ssosync:*"
    }
  ]
}
```

Notes on each statement:

- `sso:ListInstances` does not support resource-level permissions, so it is
  `*`. It is a read.
- The Identity Store reads are scoped to the one identity store ARN
  (`IDENTITY_STORE_ARN` already exists in `utils/accounts.ts`). The SAM
  template uses `*` for these; if any action in the list turns out not to
  support the identitystore resource type, fall back to `*` for that action
  and say why in the comment. All five are reads.
- No `identitystore:Create*`, `Update*`, `Delete*` action. Deliberately absent,
  and the test should assert it, following `sheriff.test.ts`'s "holds no
  identitystore action" style.
- No `kms:Decrypt` if the secrets use the AWS-managed
  `aws/secretsmanager` key. Add it only if a customer-managed key is used.
- The log group is created by Pulumi, so no `logs:CreateLogGroup`.

## Packaging the Lambda

ssosync is a Go binary, not a Node bundle, so `sheriff-lambda.ts`'s esbuild
step does not apply. The function is:

- `runtime: aws.lambda.Runtime.CustomAL2023` (`provided.al2023`, or the string
  `"provided.al2023"` if the provider's enum lags),
- `handler: "bootstrap"`,
- `architectures: ["arm64"]`,
- `code` from a pinned v2.9.0 binary.

The custom runtime requires the executable to be named exactly `bootstrap` at
the root of the deployment package. The v2.9.0 release asset
`ssosync_Linux_arm64.tar.gz` contains a binary named `ssosync`, not
`bootstrap`; upstream's own `make go-build-lambda` renames it. So a native
Pulumi function cannot consume the release archive directly — the rename has
to happen somewhere, and this is the one place the deployment deviates from
the sheriff's in-program bundle.

Recommended: a small, idempotent **prepare step** that downloads the pinned
release, verifies its SHA-256 against `ssosync_checksums.txt`, extracts it and
writes `deploy-infrastructure/.artifacts/ssosync/bootstrap`. The Pulumi
program uses `new pulumi.asset.FileArchive(".artifacts/ssosync")`. The prepare
step runs in the `deploy-infrastructure` workflow and in `deploy.sh` in CI,
before `pulumi`, so previews and applies see the same artifact. It is a few
lines of shell and a checksum, and the version is pinned in one place.

This does add a build step to a workflow that currently has none, which
`docs/pr-previews.md` records as a property of the project. The alternative —
committing the binary, or using `pulumi.asset.RemoteArchive` on the release
`tar.gz` and hoping Lambda finds a `bootstrap` that is not there — is worse.
The version is pinned to v2.9.0 and the pin is the thing to bump,
deliberately, in its own PR.

## Rollout

### 1. Dry-run validation

Deploy with `DRY_RUN=true`, `RETAIN_UNMATCHED=true`, `LOG_LEVEL=debug`, and the
schedule disabled (or invoke by hand). Read the CloudWatch log for the change
summary and the per-object decisions.

Expected, after the name reconciliation:

- **Groups:** zero `creating group`, zero `deleting group`, and the
  `Engineers` group reported as matched/updated (not added). If the log says
  `creating group`, the reconciliation did not take — stop and fix it.
- **Users:** some `creating user` for members not yet in the Identity Store.
  Zero `deleting user` (retain). If any `deleting user` appears, stop; that is
  the delete-to-match semantics reaching something it should not.
- **Memberships:** `adding user to group` for the members missing from
  `Engineers`; no `removing user from group` on the first run (a group matched
  by name is treated as an update and only additions are applied on the first
  pass — see the note below).

### 2. First real run

Flip `DRY_RUN=false` (a one-line config change and its own PR), keep the
schedule off, and invoke once by hand. The expected diff is the dry run's,
minus nothing.

Note the two-pass convergence: a group matched by display name on the first
run is an *update*, and the update loop adds members but does not remove the
ones no longer in Google. The removal pass runs for groups that are already
*equal*, which happens on the second run once `ExternalId` has been backfilled.
So the first live run may leave a stale member in place; the next run removes
it. Verify after the second run, or run twice.

### 3. Verification

- `aws identitystore list-groups --identity-store-id d-9267e5cf96` shows
  exactly the same groups as before; no new `engineering@goodparty.org` (or
  Google-display-name) group.
- `aws identitystore list-group-memberships --identity-store-id d-9267e5cf96
  --group-id 383193a0-7001-70d9-a321-ffe6d8af7378` matches the Google group's
  member list (compare against the Admin console).
- The Identity Center console still shows the `Engineers` group assigned to
  its permission sets in the management and workbench accounts — the
  assignments are keyed on the group id, which did not change.
- The group's `ExternalId` is now the Google group's id (visible in the log
  and in the Identity Store group read).
- CloudWatch has no `error`/`fatal` entries, and the change summary on the
  next run is all `unchanged`.

### 4. Rollback

- **Stop it:** disable the EventBridge rule (or remove its target). Nothing is
  lost; the function and role stay.
- **Undo the data change:** ssosync only changed group memberships and created
  Identity Store users. Removing the memberships is manual
  (`delete-group-membership`) or a one-off run with the group empty in Google;
  created users are retained and can be left or deleted by hand. There is no
  destructive cleanup to reverse, by construction, because `retain-unmatched`
  is on.
- **Remove it:** revert the `deploy-infrastructure/` change. The SCIM token
  should be deleted or rotated in Identity Center as part of removal, since it
  remains valid otherwise.

## Risks and open questions

- **No support SLA.** ssosync is an AWS Labs community tool under Apache-2.0,
  not a supported AWS service. It is maintained by a small number of
  contributors and the README says the project is intended to be retired once
  Identity Center's native Google integration covers groups. There is no
  enterprise support path and no compatibility guarantee across releases.
  Pin v2.9.0, read the changelog before bumping, and treat an upstream
  abandonment as a real possibility (the fallback is a small purpose-built
  Lambda, which is not in scope here).
- **The SCIM identity-source prerequisite.** If Identity Center uses the
  built-in directory, there is no SCIM endpoint and the plan does not work
  without a destructive identity-source migration. Checked in step 1. This is
  the biggest single risk.
- **Delegated administration is a broad grant.** Option A makes the whole
  infrastructure account an Identity Center delegated administrator. That is
  an org-level decision with a security cost, not a mechanical step.
- **Display-name coupling.** The Google group's display name becomes the
  Identity Center group's name. Renaming the Google group renames the Identity
  Center group on the next run. Record the invariant and keep the two in step.
- **User identity matching is by email, and `ExternalId` mismatches are
  destructive by default.** A user whose Identity Store record has an
  `ExternalId` pointing at a different Google user is deleted and recreated by
  default (v2.7.0+), which would drop that user's direct assignments. Users
  with no `ExternalId` are adopted. Before the first live run, check the
  members' Identity Store records for an existing `ExternalId`; if any
  mismatch, decide per user whether `--force-externalid-update` is warranted
  for a controlled run.
- **`retain-unmatched` means leavers are not fully cleaned up.** A user
  removed from the Google group has the group membership removed (the user is
  matched, the membership is not), but a user deleted or suspended in Google
  entirely is retained in Identity Center because they are unmatched. That is
  the safe default for a directory that also holds manually managed accounts,
  but it is a real gap in offboarding and should be named.
- **The SCIM token is a directory-wide write credential** with an expiry. It
  needs rotation and expiry monitoring; an expired token stops the sync
  silently from the user's point of view until the logs are read. An alarm on
  repeated Lambda errors is the minimum.
- **One group, one direction, no partial sync.** ssosync has no notion of a
  subset of members; it makes the group's membership match Google's. Any
  manually added member of `Engineers` who is not in the Google group is
  removed on the second run. That is intended here, but it should be explicit:
  Google becomes the source of truth for this group's membership.
- **The first run's non-removal.** As noted, a group matched by display name is
  an update on the first run and removals wait for the second. Verify after
  two runs.
- **Open: is there a CloudTrail/audit trail for Identity Store writes?** The
  break-glass plan's CloudTrail gap applies here too; the application log is
  the only record until a trail exists.
- **Open: should the schedule be hourly or daily?** Hourly is proposed; a
  daily window is defensible if API quota or cost matters more than staleness.

## Rejected alternatives

- **SAM / Serverless Application Repository deployment.** The account's
  provider is Pulumi and its default provider is disabled, so a SAM stack would
  be a second tool and a second state for one Lambda. Native Pulumi resources
  following `sheriff-lambda.ts` keep the account in one place.
- **Cloud Posse's Terraform component.** Same reason, plus a third tool.
- **`--sync-method users_groups`.** The legacy path. It matches groups by
  email (`SyncGroups`) rather than display name, and it needs a separate
  `--user-match` to populate the user set. It is not what the release
  recommends and it does not change the fundamental problem: it still creates a
  second group if the Identity Center name does not match what it expects.
- **`--ignore-groups` instead of `--retain-unmatched`.** Filters the source
  side only; does not protect Identity Center objects from deletion.
- **`--force-externalid-update` as a blanket flag.** It trades a real
  protection (against email reuse inheriting privileges) for convenience.
  Decide per user.

## Verification log

What was checked for this plan, and how, so a reviewer can re-run it.

- **ssosync release and version.** `gh release view v2.9.0 --repo
  awslabs/ssosync`: `v2.9.0`, published 2026-09-28. `v2.9.0` is the latest
  release. License Apache-2.0, per `LICENSE`.
- **Group matching.** Read `internal/sync.go` `getGroupOperations()` at the
  v2.9.0 tag (commit `1b39874`), and cross-checked against the maintainer's
  answers in issues
  [#363](https://github.com/awslabs/ssosync/issues/363) and
  [#364](https://github.com/awslabs/ssosync/issues/364). Display name is the
  key; `ExternalId` takes precedence once set; otherwise a new group is
  created.
- **Write path.** Read `internal/aws/client.go` (`CreateGroup`, `UpdateGroup`,
  `AddUserToGroup`, `RemoveUserFromGroup`, `CreateUser`, `DeleteUser` — all
  SCIM HTTP calls) and `internal/sync.go` `DoSync` (the SCIM client is what is
  passed as `s.aws`; the Identity Store client is used for reads). Confirmed
  against `template.yaml`'s execution-role policy, which grants only Identity
  Store *reads* plus `sso:ListInstances`.
- **`retain-unmatched`.** `internal/config/config.go` and `template.yaml`;
  added in v2.8.0 per the maintainer in
  [#366](https://github.com/awslabs/ssosync/issues/366) and the README's
  "Retaining unmatched users and groups".
- **Dry-run fix.** `CHANGELOG.md`: the dry-run group-membership bug (#281) was
  fixed in v2.7.1.
- **Flags.** `cmd/root.go` `addFlags()` and `configLambda()`;
  `internal/config/config.go` defaults; `README.md` configuration table.
- **Delegated administration.** `docs/workbench-account.md` (checked
  2026-09-22, `list-delegated-administrators` empty) and `docs/infrastructure-account.md`.
  A re-check from the workbench account was denied
  (`AccessDeniedException`), so the recorded fact stands and is re-verified in
  step 1 from an account that can see it.
- **Identity source / SCIM.** AWS docs, *Provision users and groups from an
  external identity provider using SCIM* and *Delegated administration*. The
  identity source itself was not readable from this container; it is the first
  thing step 1 checks.
- **Identity Center group id.** `383193a0-7001-70d9-a321-ffe6d8af7378` is the
  `Engineers` id already in `deploy/components/identity-center.ts` and
  `deploy-infrastructure/sheriff/config.ts`.
