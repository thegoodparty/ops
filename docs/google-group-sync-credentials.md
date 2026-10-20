# Google Workspace → Identity Center group sync: credentials

> **Status: runbook.** This is the manual half of step 4 in
> [`google-group-sync.md`](./google-group-sync.md): the Google setup, the
> service-account key, the secret and the stack config. The code half is merged
> (`deploy-infrastructure/group-sync-lambda.ts` and
> `deploy-infrastructure/group-sync/`), and nothing here changes it. Every step
> is done by hand in a console or a shell, in the order written, because each
> one's output is the next one's input.

Read `google-group-sync.md` first, at least "IAM", "Google access, read-only"
and "The manual Google setup, which is not a PR". This file is the same content
written as instructions, plus the traps that have cost time.

Placeholders are in angle brackets: `<project>`, `<impersonation-address>`,
`<key-a-id>`, `<management-account-profile>` and
`<infrastructure-account-profile>`. Substitute them; do not paste them.

## Three accounts, and a fourth place

Mixing these up is the most expensive mistake available here, because two of the
three accounts have a Secrets Manager secret and an identity with
`secretsmanager` access that looks right.

- **The management account, `333022194791`**, holds the identity store
  (`d-9267e5cf96`), the `Engineers` group
  (`383193a0-7001-70d9-a321-ffe6d8af7378`) and the `identity-group-sync-grant`
  role. This runbook touches it only for the Pulumi state passphrase in step 6
  and for reading the group afterwards. No Google credential lives there.
- **The infrastructure account, `394495727159`**, holds everything this runbook
  creates in AWS: the `identity-group-sync` Lambda and its execution role of the
  same name, the SSM parameter `/identity-group-sync/pairs`, the secret
  `identity-group-sync/google-service-account` in `us-west-2`, and the log group
  `/aws/lambda/identity-group-sync`.
- **The workbench account, `024901689212`**, has nothing to do with this job at
  all. It exists here in the list only because it is where a session ends up
  after Bifrost work, where `secretsmanager` is administrator, so the wrong
  profile is the likely mistake rather than the unlikely one. Nothing in this
  document belongs in it.
- **The Google Cloud project** is not an AWS account. It holds the service
  account and nothing else this job uses.

Check the caller before any `aws` command below:

```bash
aws sts get-caller-identity --query Account --output text
```

Expect `394495727159` for steps 5 and 7 and `333022194791` for the passphrase in
step 6. If it prints `024901689212`, stop and fix the profile: the next command
would either write the key into the wrong account or leave you looking at an
empty secret in an account the Lambda cannot see.

## 1. The service account

Create a project or reuse one, and a dedicated service account in it. Dedicated
means one service account for this job: revoking it is deleting one identity,
and nothing else shares its OAuth client ID.

```bash
gcloud config set project <project>

gcloud iam service-accounts create identity-group-sync \
  --display-name="Identity Center group sync"
```

Its address is `identity-group-sync@<project>.iam.gserviceaccount.com`. At this
point that is all it is: no GCP IAM role, no project resource, and no GCP-side
grant to the impersonation user. The whole of its authority comes from the Admin
console delegation in step 3 acting as the user from step 2.

Enable the API in the project:

```bash
gcloud services enable admin.googleapis.com --project=<project>
```

In the console it is APIs & Services → Library → **Admin SDK API**. The trap is
the name. The service is `admin.googleapis.com` and the library calls it "Admin
SDK API"; most documentation still calls it "Admin SDK Directory API", which is
what people search for, and the library does not use that name. That reads as
"the API has been withdrawn", and ten minutes later you are reading a Cloud
Identity page and wondering whether the plan is wrong. It is not: there is
also a "Cloud Identity API" in the same library, this job does not use it, and
the plan's open question 1 is about which one the org's edition actually serves
group membership from. Enabling takes a minute or two to propagate, so a `403`
on the first call immediately afterwards is the delay rather than a
misconfiguration.

Get the numeric OAuth client ID:

```bash
gcloud iam service-accounts describe \
  identity-group-sync@<project>.iam.gserviceaccount.com \
  --format='value(oauth2ClientId)'
```

In the console it is IAM & Admin → Service Accounts → the account → Details →
Advanced settings → "Client ID". Three identifiers are within reach across
those two panels and only one of them is right. The email is not numeric at all, the "Unique ID"
is a different number, and the client ID is the only one the Admin console will
accept. Pasting the email or the unique ID into step 3 fails at the token
exchange, three steps later, with `unauthorized_client`, which the Lambda reports
as `Google token exchange failed with HTTP 400` and which names neither of them.

## 2. The impersonation admin

Domain-wide delegation gives the service account the ability to act as a user; it
does not give it a user. The job impersonates one dedicated, licensed Workspace
user, for example `identity-sync@goodparty.org` — `<impersonation-address>`
below and in step 6.

It has to be a real licensed user of the same domain, and it cannot be a group or
an alias. It should be dedicated to this job: not a personal admin account, not
a shared one. The reason is revocation. Deleting or disabling one account ends
the job's Google access and touches nothing else, which is not true if the
delegation runs as a person.

It is not a Super Admin. Its only role is **Groups Reader**: Directory → Users →
the user → Admin roles and privileges → Assign roles → Groups Reader. Groups
Reader can read groups and group membership and can change nothing, which is
exactly the two read-only scopes. If the role is assigned with a condition
limiting it to particular group types, check that the source group is one of the
types it covers; an unconditioned role is what the plan assumes.

The account never signs in interactively, and two traps follow from that.

The first is the password. Freshly created users often carry a "change password
at next sign-in" flag, and the obvious way to clear it is to sign in. Do not.
Reset the password from the Admin console with the option that requires a change
at the next sign-in cleared, and do not record the password anywhere: nothing
uses it, and the job only ever obtains tokens issued to this user through
delegation. Google does not need a first interactive sign-in for that; the user
has to exist, be licensed and be active.

The second is dormancy. **Last sign-in stays empty forever** — "Never" in the
user list — which is correct and is not a symptom of a broken account. A
periodic dormancy or inactive-account review will flag precisely this account,
and suspending it breaks the sync: a suspended user cannot be impersonated, so
every pair aborts with `source-read-failed` and nothing is written until it is
restored. Exempt the address by name in that review, and if it is ever
suspended, restore it and confirm a run before looking anywhere else.

## 3. Domain-wide delegation

A Super Admin does this once, in the Google Admin console. It is a Super Admin
action, so if you are not one this is the one step that needs someone else's
account; the impersonation admin cannot grant it to itself.

Admin console → Security → Access and data control → API controls → Manage
Domain Wide Delegation → Add new. The client ID is the numeric `oauth2ClientId`
from step 1. The OAuth scopes are exactly these two, comma-separated, with no
spaces and no trailing comma:

```
https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.group.member.readonly
```

Four traps:

- Adding a third scope "to be safe" is a wider grant, and it is the one thing
  this design deliberately avoided. The two scopes are the whole of the job's
  Google access; a write scope here means the credential can do things the code
  never does, and the read-only decision is only as strong as this field.
- Editing the entry later replaces the whole scope list rather than merging into
  it. Re-paste both.
- Propagation takes a few minutes, so a token exchange immediately after Add new
  can still fail.
- Do not delete and recreate the service account to fix a mistake. A new service
  account has a new OAuth client ID, so the delegation entry has to be redone,
  and until it is, every call fails the same way. Delete keys, not accounts, when
  rotating.

## 4. The key

The Lambda authenticates as the service account with a JSON key. It is the only
long-lived secret in the job and the only part of this setup that has to be
replaced on a schedule.

In the console: IAM & Admin → Service Accounts → the account → Keys → Add key →
Create new key → JSON. The file downloads once, and Google keeps no copy.

With `gcloud`, which is easier to record:

```bash
gcloud iam service-accounts keys create /tmp/identity-group-sync-key.json \
  --iam-account=identity-group-sync@<project>.iam.gserviceaccount.com \
  --project=<project>
```

Write it under `/tmp`: not the repository, not a synced folder, not
`~/Downloads`. Open it once to record the `private_key_id` and the date for the
rotation record, then close it and do not open it again except to put it into
the secret.

**The org policy wall.** Some Google Cloud organizations deny service-account key
creation outright, and the error names
`constraints/iam.disableServiceAccountKeyCreation` and says it is enforced. It is
worth checking before creating the key rather than after:

```bash
gcloud resource-manager org-policies describe \
  constraints/iam.disableServiceAccountKeyCreation --project=<project>
```

If the constraint is enforced, the console's "Add key" fails with the same
message. Do not work around it: not by disabling the constraint for the
organization or the folder, which weakens every project to get one key, and not
by uploading a key created elsewhere, which `iam.disableServiceAccountKeyUpload`
usually blocks anyway and which hides where the key came from. The two honest
options are a project-level override with enforcement off, added by the policy
owner and recorded like any other exception, or building the Workload Identity
Federation path under "Rotation" and never creating a key at all. Some
organizations have migrated to the managed constraint
`constraints/iam.managed.disableServiceAccountKeyCreation`, which behaves the
same and is described with `gcloud org-policies describe`; the console lists
whichever one applies under IAM & Admin → Organization Policies.

## 5. Into the secret

The secret container already exists, created empty by Pulumi
(`aws.secretsmanager.Secret` in `deploy-infrastructure/group-sync-lambda.ts`):
`identity-group-sync/google-service-account` in `us-west-2`. Pulumi never puts a
value in it, and the Lambda's policy reads
`secret:identity-group-sync/google-service-account-*`.

That is why this is a `put-secret-value` and never a `create-secret`. A second
secret with a similar name is invisible to the function, because the function
reads the ARN Pulumi wrote into its environment, so a hand-made secret is dead
weight that feels like progress.

Confirm the account is `394495727159`, then:

```bash
aws secretsmanager put-secret-value \
  --secret-id identity-group-sync/google-service-account \
  --secret-string file:///tmp/identity-group-sync-key.json \
  --region us-west-2 \
  --profile <infrastructure-account-profile>
```

The `file://` prefix matters: without it the CLI stores the literal path as the
secret's value, and the Lambda's first abort is "service-account secret is not
valid JSON". The absolute path matters too, because a relative one is resolved
against wherever the shell happens to be.

In the console it is Secrets Manager → `identity-group-sync/google-service-account`
→ Secret value → Set secret value → the **Plaintext** tab → paste the whole JSON
document → Save. Use Plaintext, not the key/value editor: the key/value view
splits the document into rows and the first thing it loses is the private key's
line breaks, so the value either stops parsing as JSON or parses and cannot
sign.

Verify it without printing the key:

```bash
aws secretsmanager get-secret-value \
  --secret-id identity-group-sync/google-service-account \
  --query SecretString --output text \
  --region us-west-2 \
  --profile <infrastructure-account-profile> | jq -r .client_email
```

That prints the service account's address. `jq -r .private_key_id` is equally
safe and is what the rotation record wants. **The same command without the
filter prints the private key** into the terminal, the scrollback buffer and any
transcript or `tee` that is running. There is no reason to run it unfiltered,
and if it happens, treat it as an exposure and rotate rather than deleting the
output.

Then destroy the local copy:

```bash
rm -f /tmp/identity-group-sync-key.json
```

and check `~/Downloads` if you used the console route. Deleting the file is the
point; the copy on disk is the entire risk of a static key.

## 6. The stack config

The Lambda reads the impersonation address from `GOOGLE_IMPERSONATION_EMAIL`,
which `deploy-infrastructure/group-sync-lambda.ts` fills from the
`googleImpersonationEmail` key of the `organization/infrastructure/main` stack.
It is stack config rather than a handler literal because the address is
deployment state: the deploy script declares it (below) and the handler only
reads the environment it lands in. The pair list beside it is
different: `/identity-group-sync/pairs` is written by the same stack from
`deploy-infrastructure/group-sync/config.ts`. Do not edit it by hand: either the
next apply replaces your value with the reviewed one, or the live value quietly
disagrees with the repo and the next reader of the config is looking at the wrong
thing.

Until the key is set, every pair aborts with `reason: "source-read-failed"` and
the detail `no impersonation admin configured (GOOGLE_IMPERSONATION_EMAIL)`, and
writes nothing. That is the expected first-run failure, and the detail string
names it, so it is only indistinguishable from the other credential failures if
you skipped this step.

**The value is set by `deploy-infrastructure/deploy.sh`, not by hand.** The
script runs `pulumi config set googleImpersonationEmail
svc-identity-group-sync@goodparty.org` before every preview and every apply, the
same way it sets `providerRoleName`, because the address has to survive into the
apply rather than sit in one person's checkout. `docs/google-group-sync.md`
records that under "Deployment state: the impersonation admin", and a test in
`deploy-infrastructure/group-sync-runtime.test.ts` pins both ends: that line in
`deploy.sh` and the `get("googleImpersonationEmail")` in
`deploy-infrastructure/group-sync-lambda.ts` that reads it.

Two traps.

The address must be the account's **primary** address, not an alias. An alias can
exist in the directory and still not be impersonable; the token exchange then
fails with HTTP 400 and no further detail.

Setting a key by hand neither deploys it nor keeps it. This stack uses the S3
DIY backend, where stack config lives in the local, gitignored
`Pulumi.<stack>.yaml` and not in the state bucket — the stack's checkpoint
carries no config — so a `pulumi config set` from a scratch checkout is
invisible to CI, and the next apply overwrites `googleImpersonationEmail` from
`deploy.sh` regardless. The function's environment changes only when the program
runs, and `.github/workflows/deploy-infrastructure.yml` applies on a push to
`main` under `deploy-infrastructure/**` (or its own file, `utils/accounts.ts`,
`agent-swarm/**`) and has no `workflow_dispatch`. A value-only change therefore
needs a commit under one of those paths; `deploy.sh` is the natural one.

So this failure is diagnosed against the deployed function, not the config:

```bash
aws lambda get-function-configuration \
  --function-name identity-group-sync \
  --region us-west-2 \
  --profile <infrastructure-account-profile> \
  --query '{LastModified:LastModified,Env:Environment.Variables}'
```

The trigger is a plain `rate(15 minutes)` rule targeting the function's
unqualified ARN, with no alias and no published version, so the next scheduled
invocation picks up a new environment with no further action. An empty
`GOOGLE_IMPERSONATION_EMAIL` whose `LastModified` predates the `deploy.sh` line
means no apply has run since that line landed; an abort logged *before*
`LastModified` is a stale line from the old environment, not a live failure.

## 7. What working looks like

The shipped pair is `mode: "dry-run"` in
`deploy-infrastructure/group-sync/config.ts`. It reads the source, resolves
users, reads the target, computes and logs the diff, evaluates the removal cap,
and returns before any write. Nothing in this runbook changes that to `apply`:
that is a separate reviewed change and it is not needed to prove the credentials
work.

Give the apply time to finish, then wait for the 15-minute schedule or invoke it
by hand from the infrastructure account:

```bash
aws lambda invoke \
  --function-name identity-group-sync \
  --payload '{"action":"sync"}' \
  --cli-binary-format raw-in-base64-out \
  --region us-west-2 \
  --profile <infrastructure-account-profile> \
  /tmp/group-sync-out.json && jq . /tmp/group-sync-out.json
```

The scheduled rule passes the same `{"action":"sync"}` payload, so this is the
same run a poll would do. The response is the per-pair outcome, `aborted`
included, so a credential failure is visible without opening CloudWatch.

The success shape is one `sync.completed` line per pair in
`/aws/lambda/identity-group-sync` with `mode: "dry-run"`, non-zero
`sourceMembers` and `targetMembers`, `added: 0` and `removed: 0`, and the would-be
work in `toCreate`, `wouldAdd` and `wouldRemove`. In CloudWatch Logs Insights:

```
fields @timestamp, pairId, mode, sourceMembers, targetMembers, toCreate, wouldAdd, wouldRemove, removalCapTripped
| filter audit = "sync.completed"
| sort @timestamp desc
| limit 20
```

The matching metrics are in the `IdentityGroupSync` namespace with dimension
`PairId`: `Success` goes to 1 on a completed dry run, and `SourceMemberCount`,
`TargetMemberCount`, `ToCreate`, `Added` and `Removed` carry the numbers. An
abort emits `Aborted = 1` with a `Reason` dimension and no `Success`.

**The diff is counts, not a member list.** Dry-run writes no `member.added` or
`member.removed` lines — those belong to the apply path — and the plan keeps
member addresses out of CloudWatch on purpose. So "the diff appears" means
counts, `member.skipped` lines carrying the domain and reason and not the local
part, and a `removal_cap.tripped` line if the cap would have fired. If a human
needs to know who, compare the Google group with the `Engineers` group in the
management account by hand; the job will not put the list in the log, and that is
a data rule rather than a missing feature.

Two things outside the code also have to be true before the job is working. The
SNS topic `identity-group-sync-alerts` subscribes
`aws-infrastructure@goodparty.org` and stays `PendingConfirmation` until someone
clicks the link in AWS's email, so until then the heartbeat, failure and removal
alarms fire into nothing. And the heartbeat is `Success` with
`treatMissingData: breaching` over two poll intervals, so green means two
successes in a row: green within half an hour of the first good run is the
signal, and a red alarm beside a `sync.completed` line is a metric or topic
problem rather than a credential one.

## Rotation

A service-account key is long-lived and Google never expires it, so the plan is a
90-day rotation with two keys overlapping. The overlap is the point: the old key
keeps working until a run has succeeded on the new one, so there is no window in
which the sync is broken.

1. Create key B the way step 4 does, to a new path. Record its `private_key_id`
   and the date.
2. Put it into the secret with `put-secret-value` as in step 5. That creates a
   new version and moves `AWSCURRENT` to it; the old one becomes `AWSPREVIOUS`.
3. Wait for a successful run. The handler reads the secret once per invocation,
   so the next scheduled run is enough — there is no cache to clear and no
   redeploy. Confirm a `sync.completed` line that is later than the version
   change, not just that the put succeeded.
4. Only then delete key A:

```bash
gcloud iam service-accounts keys list \
  --iam-account=identity-group-sync@<project>.iam.gserviceaccount.com \
  --format='table(name.basename(), validAfterTime, validBeforeTime)'

gcloud iam service-accounts keys delete <key-a-id> \
  --iam-account=identity-group-sync@<project>.iam.gserviceaccount.com
```

Record, in the ticket or the rotation log rather than in this repository: the
`private_key_id` of the key in use, the date it was created, the date the
previous one was deleted, and therefore the next rotation date. The key id is the
only thing that distinguishes the two keys in `keys list`; they are otherwise the
same account with the same scopes.

Four notes for when this is done in a hurry:

- The Lambda's policy names the secret `identity-group-sync/google-service-account-*`
  with the wildcard, so a delete-and-recreate of the *secret* needs no policy
  change. That is not a reason to recreate it: deleting a Pulumi-managed
  resource is a state problem, the ARN in the function's environment outlives the
  secret, and nothing recreates the value. Rotate by putting a new value, never by
  recreating the container.
- `put-secret-value` leaves the old key in the previous version, still readable
  under the `AWSPREVIOUS` label. There is no per-version delete: `aws
  secretsmanager` has no such operation, and Secrets Manager exposes no call
  that purges one version on demand. The only handle you have is the label:
  `aws secretsmanager list-secret-version-ids` lists the versions, and
  `aws secretsmanager update-secret-version-stage --secret-id
  identity-group-sync/google-service-account --version-stage AWSPREVIOUS
  --remove-from-version-id <old-version-id>` strips it from the old one. That
  leaves the version deprecated and eligible for Secrets Manager to remove, but
  it does not remove it, and purging every version means deleting the whole
  secret, which the previous point rules out. The mitigation that actually ends
  an exposure is on the Google side: delete key A, and the material left in the
  secret authenticates nothing.
- Deleting a key that is still the one in the secret breaks every run on the next
  poll, with `source-read-failed` and an `invalid_grant` at the token exchange. If
  it happens, create a key, put it in the secret, and confirm a run.
- The 90 days is a manual discipline until it is automated. Nothing expires a
  key, so a lapsed rotation is silent.

**Workload Identity Federation is the documented future option**, and it removes
the static key entirely: GCP trusts the Lambda's AWS IAM role and mints a
short-lived credential, which then impersonates the service account. It changes
neither the delegation nor the two scopes, and it is not v1 because it adds a
second identity provider and an impersonation chain to debug. When it is built,
this whole section collapses to checking the pool's trust of the execution role.

## When it aborts

Every credential failure is a per-pair `sync.aborted` with
`reason: "source-read-failed"`, no writes and no `Success` metric, so read the
`detail` field first:

- `the service-account secret has no value yet` — step 5 has not been done, or
  was done to a different secret.
- `service-account secret is not valid JSON`, `has no client_email` or
  `has no private_key` — the value is the path, or the key/value editor mangled
  the document. Put it again as plaintext.
- `no impersonation admin configured` — the function ran with an empty
  `GOOGLE_IMPERSONATION_EMAIL`. `deploy.sh` sets it on every apply, so compare
  the log line's timestamp with the function's `LastModified` before changing
  anything: an abort from before the last apply is stale, and the next
  `rate(15 minutes)` invocation uses the new value. Only if it recurs after an
  apply is the deployed environment wrong, and then step 6's
  `get-function-configuration` is what to read.
- `Google token exchange failed with HTTP 400` — the delegation entry does not
  match. The usual causes are the wrong numeric ID (the email or the unique ID
  instead of the client ID), a scope list that is not exactly the two above, an
  impersonation address that is an alias or not a licensed active user, or a
  delegation added seconds ago.
- `Google Directory request failed with HTTP 403` — the API is not enabled in the
  project the key belongs to, is still propagating, or the impersonated user
  cannot see the group.
- `Google Directory request failed with HTTP 404` — the source group address in
  the config does not exist. `groups.get` is the check the plan relies on so a
  typo cannot read as an empty group.

`reason: "identity-read-failed"` is the other half and is not a Google problem:
the Lambda could not assume `identity-group-sync-grant` in the management
account. Check the Lambda role's name and the grant's trust, not the key.

The Lambda logs the HTTP status and not Google's response body, deliberately,
because the body can echo request detail. For a persistent 400 or 403, reproduce
the token exchange or the `groups.get` with the key from a laptop to read
Google's own message; the status alone says which of the two calls failed, not
why.

## What this runbook does not settle

**Which API the org's edition serves group membership from** is open question 1
in the plan. This runbook assumes the Admin SDK Directory API. If the answer is
the Cloud Identity API, `deploy-infrastructure/group-sync/google.ts` changes, the
two scopes change with it, and steps 1 and 3 change to match.

**Whether the impersonation address is the right mailbox** is not something this
repository can check. The address the deploy intends is in
`deploy-infrastructure/deploy.sh` and in `docs/google-group-sync.md`, so it is
recoverable from a checkout; what the live function actually has, and the only
value that matters to a running sync, is its environment:

```bash
aws lambda get-function-configuration \
  --function-name identity-group-sync \
  --region us-west-2 \
  --profile <infrastructure-account-profile> \
  --query Environment.Variables
```

Recording it in the ticket that closes this work is still worth doing, even
though the value is not secret, because the mailbox's existence and its Groups
Reader role are not verifiable from here.

**Whether the key-creation constraint applies** to the project is an organization
decision that this repository does not record. Step 4 says how to check and what
the honest options are; it cannot say which one is available.

**Turning the pair to `apply`** is deliberately not here. It is a reviewed change
to `deploy-infrastructure/group-sync/config.ts`, it should follow a dry run whose
counts a human has approved, and the removals alarm pages on the first real
removal.
