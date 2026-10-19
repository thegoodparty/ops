# Google Workspace → IAM Identity Center group sync

> **Status: built through step 3.** The management-account grant, the Google
> read adapter, the pure diff and guards, and the runtime are all in the repo
> and tested; the rollout in step 4 -- a dry run against the real group and the
> reviewed change that flips the first pair to `apply` -- has not happened yet.
> The decisions below were settled in a design review and are recorded as
> decisions rather than options; the few things still genuinely open are in
> "Open questions" at the end and are marked **open**. The steps in
> "Implementation plan" carry their own status; steps 1, 2 and 3 are `done`.

The job is small on purpose: one Lambda, on a schedule, that makes one IAM
Identity Center group a strict mirror of one Google Workspace group. It adds
the people who are in the Google group and not in the Identity Center group,
and removes the people who are in the Identity Center group and not in the
Google group. Nothing else.

The reason for a document is the parts that are not small: a job that can
remove access has to be built so that the most likely failure mode is doing
nothing, not emptying a group; the identity store lives in the management
account and the Lambda does not; and the same Google service account that
makes this possible is the first domain-wide-delegation credential in the
organization, which `agent-swarm/README.md` and `docs/bifrost-gateway.md`
each explicitly declined to create.

## Goal

Stated as an invariant:

- One Identity Center group's membership is exactly the set of `type == USER`
  members of one Google group, lowercased, minus members filtered by the
  allowlist, within one poll interval.
- The job never deletes an Identity Center user, never creates or deletes a
  group, and never touches a group it was not configured for.
- If the source cannot be read completely, the job changes nothing and says
  so loudly.
- A large removal cannot happen without a human deciding it should.

## Scope and non-goals

What it does:

- Polls a Google Workspace group on a schedule.
- Adds missing Identity Center users (creating the user object first, since
  nothing is SCIM-provisioned today).
- Adds and removes group memberships in the configured Identity Center group.
- Writes metrics, structured audit logs and a heartbeat, and alarms on
  silence and on removals.

What it deliberately does not do, and why. Each of these is a fixed decision
from review, not a preference:

1. **No user-object deletion.** The job never calls `DeleteUser`. It creates
   users and adds/removes memberships, nothing more. "Member of no groups" is
   not a safe proxy for "unused": direct user-to-permission-set assignments
   exist outside groups, and any garbage-collection would race every other
   writer to the directory. v1 does not garbage-collect users at all. A user
   the job creates and later stops syncing is left in place, unassigned to
   this group; removing them is a human's job, not this Lambda's.
2. **No nested-group flattening, and no silent drop of a domain-wide
   membership.** The Directory API's `Member.type` is one of `USER`, `GROUP`,
   `CUSTOMER` and `EXTERNAL`; the reference's own wording is that `CUSTOMER`
   is "the member represents all users in a domain. An email address is not
   returned and the ID returned is the customer ID", `EXTERNAL` is "a user or
   group from outside the domain" (documented but not currently used),
   `GROUP` is "another group", and `USER` is "a user". Only `type == "USER"`
   members are synced. `GROUP` and `EXTERNAL` are skipped and logged with
   their type and reason; a nested group is not an error, it is out of scope.
   A `CUSTOMER` member is **not** skipped: it carries no email, so it cannot
   be expanded into the source set, and dropping it would compute a source
   set that omits the whole domain and then mass-remove the target. It aborts
   the pair with `sync.aborted` (`reason: "domain-wide-membership"`) and
   alarms. Refusing is the only handling that keeps the "never empty a group
   by accident" property; expanding it would mean enumerating every user in
   the domain, which is out of scope. A `USER` member can also be outside the
   domain (the reference says a member "can be inside or outside of your
   account's domains"), so an outside address is caught by the allowlist and
   logged as `not-allowlisted`.
3. **No SCIM.** Nothing is SCIM-provisioned today, so the job creates the
   Identity Center user objects it needs. **Adopting SCIM later conflicts with
   this job and is a migration concern**, not a config change: if SCIM starts
   creating the same users, two writers race the same unique attributes, and
   the `ConflictException`-is-success path here will paper over the collision
   instead of surfacing it. Recorded under "Open questions" as a follow-up,
   and called out in the user-creation code comment.
4. **One-way only.** Google is the source of truth. The job has read-only
   access to Google and never writes to Workspace. A membership added directly
   in Identity Center is removed on the next apply; that is what "strict
   mirror" means.
5. **Never target the `Admins` group or any group `sheriff` manages.** This is
   an invariant, stated here and in the config comments, and enforced in code
   by a denylist (see "The reserved-target guard"). `sheriff` grants
   time-boxed access by adding `Admins` memberships (`docs/sheriff.md`); a
   strict mirror over `Admins` would revert every grant on its next poll. The
   denylist is the `Admins` group id today, and a new sheriff-managed group
   has to be added to it in the same PR that teaches sheriff about it.
6. **User creation is idempotent and deduped on the user's email.** Before
   creating, the job calls `identitystore:GetUserId` with the `emails.value`
   alternate identifier — the path this repo already uses in
   `deploy-infrastructure/sheriff/identity.ts`, and one of the two the API
   documents as valid (`userName` and `emails.value`). `userName` is a
   separate attribute and is not guaranteed to hold the email, so a
   `userName` lookup would miss a real member and could create a duplicate.
   `ResourceNotFoundException` means "create it"; `ConflictException` on
   `CreateUser` means the attribute is already in use and is treated as
   success, with a re-resolve. The zero/one/many-match rule is in "Resolve
   source emails to Identity Store users".
7. **Group existence is not this job's business.** The target group is owned
   by the identity-center program in `deploy/components/identity-center.ts`,
   which records its id and its account assignments; the group itself is
   created out of band today, as every Identity Center group in this repo is.
   The Lambda only manages membership. It never creates or deletes a group.
   It does create users (non-goal 3), but never deletes them (non-goal 1). If
   the group is later brought under Pulumi as a resource, the config's
   `targetGroupId` switches to an `Output` and nothing else changes.

## Architecture

```
   Google Workspace                    AWS infrastructure account 394495727159
   ────────────────                    ────────────────────────────────────────
   goodparty.org                       EventBridge rule  rate(<poll interval>)
   source group  ──read-only────────┐        │
                                    │        ▼
   service account                  │  ┌───────────────────────────────────┐
   + domain-wide delegation         │  │ identity-group-sync Lambda        │
   + impersonated admin ────────────┘  │ concurrency 1, timeout < interval │
                                       └───────────────┬───────────────────┘
                                                       │ sts:AssumeRole
                                                       │ (fixed session name)
                                                       ▼
                                       AWS management account 333022194791
                                       ┌───────────────────────────────────┐
                                       │ role: identity-group-sync-grant   │
                                       │ identitystore:GetUserId/CreateUser│
                                       │ .../CreateGroupMembership         │
                                       │ .../DeleteGroupMembership         │
                                       │ .../ListGroupMemberships          │
                                       │ identity store d-9267e5cf96,      │
                                       │ home region us-west-2             │
                                       └───────────────────────────────────┘

   Config:  SSM Parameter Store  /identity-group-sync/pairs   (Pulumi-written)
   Secret:  Secrets Manager      identity-group-sync/google-service-account
   Observe: CloudWatch metrics + structured logs + heartbeat alarm
```

**Schedule → Lambda → `sts:AssumeRole` → Identity Store.** An EventBridge
rule invokes the Lambda in the infrastructure account on a fixed interval.
The Lambda reads its config from SSM, reads the Google group through the
Admin SDK Directory API, assumes `identity-group-sync-grant` in the management
account, and calls the Identity Store API in the Identity Center home region.
The Lambda's own role holds **no** `identitystore` action; every directory
call goes through the assumed role, which is the scoped one. That is the
`sheriff` pattern exactly (`deploy-infrastructure/sheriff/identity.ts`,
`deploy/components/sheriff-grant.ts`) and this plan reuses it rather than
inventing one.

**Why the infrastructure account.** It exists to run internal automation with
a blast radius that is not production (`docs/infrastructure-account.md`). A
scheduled job that can remove access belongs there, not in the management
account, and the `Infrastructure` SCP permits Lambda, EventBridge, SSM,
Secrets Manager and CloudWatch Logs while denying CloudTrail tampering.

**Why the management account.** The identity store is there. There is exactly
one Identity Center instance for the organization, it lives in the management
account, and there is no way to reach its identity store from another account
except by assuming a role into it. The `identity-group-sync-grant` role is
that door, and its inline policy is the boundary.

**Region.** The Identity Store API must be called in the Identity Center home
region. `deploy-infrastructure/sheriff/identity.ts` uses `us-west-2` with a
comment that Identity Center is global but the SDK needs a region to pick an
endpoint; that is the value this job uses too. The home region is `us-west-2`
-- confirmed by the engineer when step 3 was built, and the runtime names it in
one constant (`deploy-infrastructure/group-sync/identity.ts`).

**Google API.** The plan is written against the Admin SDK Directory API
(`admin.directory.group.member.readonly` and `admin.directory.group.readonly`,
delegated), because it is the API whose group-member listing carries the
`type` field this job filters on and it is the one most Workspace tenants
have enabled. If the organization's Workspace/Cloud Identity edition serves
group membership only through the Cloud Identity API, the fetch layer changes
and the rest of this document does not. Which API this org actually uses is
still **open**, and the design keeps the Google read behind a small adapter so
the choice is one module, not a rewrite. Step 3 implements the Admin SDK
branch in `deploy-infrastructure/group-sync/google.ts`; it is the file to
change if the answer is Cloud Identity.

## Configuration

Configuration is a Pulumi-managed list of pairs written to a single SSM
Parameter Store parameter, and read by the Lambda at each run. Adding a pair
takes two changes, not one: the pair in the list, and the new target group's
ARN in the management-account grant role's policy. It never needs a Lambda
code change or a redeploy of the function. The steps are under "Adding a
pair".

### Schema

```ts
type SyncMode = "dry-run" | "apply";

type SyncPair = {
  /** Stable id. The config key, the metric dimension and the log field. */
  id: string;
  /** The Google group whose `type == USER` members are the source of truth. */
  sourceGroupEmail: string;
  /** The Identity Store group that mirrors it. Owned elsewhere; never created here. */
  targetGroupId: string;
  /** `dry-run` computes and logs the diff and applies nothing. */
  mode: SyncMode;
  /**
   * Blast-radius cap. The run refuses to remove when either bound is exceeded
   * without an explicit manual override. Both are checked; the stricter wins.
   */
  removalCap: {
    maxCount: number;     // absolute removals per run
    maxFraction: number;  // 0..1 of the current target membership
  };
  /**
   * Emails or domains (`@goodparty.org`) eligible to be provisioned into the
   * target. A member outside the list is logged and skipped.
   */
  allowlist: string[];
  /** Page on more than this many removals in one run; 0 pages on any. */
  removalAlertThreshold: number;
};

type SyncConfig = {
  /**
   * The poll interval the heartbeat alarm is sized against, in seconds. It
   * must be a multiple of 60 (CloudWatch's alarm period floor), and the
   * Lambda's timeout is set below it so a run cannot overlap the next one.
   */
  pollIntervalSeconds: number;
  pairs: SyncPair[];
};
```

The first pair is the one the engineer named when step 3 was built: the
`engineering@goodparty.org` Workspace group mirrors the `Engineers` Identity
Center group. Its target group id is a literal from
`deploy/components/identity-center.ts`, and the matching ARN is already in the
merged grant:

```ts
{
  id: "engineers-google",
  sourceGroupEmail: "engineering@goodparty.org",
  targetGroupId: "383193a0-7001-70d9-a321-ffe6d8af7378", // Engineers
  mode: "dry-run",
  removalCap: { maxCount: 5, maxFraction: 0.1 },
  allowlist: ["@goodparty.org"],
  removalAlertThreshold: 0,
}
```

The id keeps the plan's worked-example shape (`<target>-google`) rather than
following the source group's spelling: the source is `engineering@` (the
Workspace group's name) and the target is `Engineers` (the Identity Center
group's name). The pair ships `dry-run`, per "Rollout"; the cap and the alert
threshold are still the placeholders of open question 5. Any future pair is
subject to the reserved-target invariant: it may not be `Admins`
(`88c1b330-a001-707a-06ca-94e289013bf5`) or any future sheriff-managed group.

### Where it lives

- **The list**: `deploy-infrastructure/group-sync/config.ts`, as a typed
  `SyncPair[]` constant with the comments above. It is a constant rather than
  Pulumi config because it is policy, not per-stack state, and it should be
  reviewable in the same diff as the code that consumes it.
- **The parameter**: `deploy-infrastructure/group-sync-lambda.ts`, an
  `aws.ssm.Parameter` named `/identity-group-sync/pairs`, type `String`
  (the config is not secret; it holds group emails and group ids), whose
  `value` is `JSON.stringify(config)`. Pulumi owns it, so a change is a
  reviewed apply and the live value cannot drift from the repo.
- **The reserved-target guard**: a `RESERVED_TARGET_GROUP_IDS` constant in
  `deploy-infrastructure/group-sync/config.ts`, initially
  `["88c1b330-a001-707a-06ca-94e289013bf5"]` (the `Admins` group id), and the
  same list in the handler. The handler refuses a pair whose `targetGroupId`
  is on it, logs `sync.aborted` with `reason: "reserved-target"`, and changes
  nothing. A test reads `deploy/components/identity-center.ts` and pins the
  `Admins` literal, the way `deploy/sheriff-grant.test.ts` pins it, so the two
  cannot drift silently.
- **The runtime**: `deploy-infrastructure/group-sync-lambda.ts` (the function,
  role, SSM parameter, secret, log group, schedule, metric filters and alarms)
  and `deploy-infrastructure/group-sync/handler.ts`, which is the thin AWS
  shell around `run.ts` (the algorithm), `identity.ts` (the assumed-role
  Identity Store calls), `google.ts` (the read adapter's transport),
  `metrics.ts` and `log.ts`. The tests are
  `deploy-infrastructure/group-sync-runtime.test.ts`.

The `targetGroupId` is a literal rather than a Pulumi `Output` for the same
reason `sheriff-grant.ts` records: the group is created out of band, there is
no Pulumi resource to read it from, and the identity store id and group ids
are stable. If a future change makes the group Pulumi-created, the config must
use an `Output<string>` so the engine orders the dependency, rather than
recording a literal that needs a two-pass apply.

### Adding a pair

A pair is not config-only, and the earlier claim that it was is wrong. The
assumed role scopes `CreateGroupMembership`, `DeleteGroupMembership` and
`ListGroupMemberships` to the target group ARN, so a new group is not
authorized until that ARN is in the policy. Adding a pair is:

1. Add the `SyncPair` to `deploy-infrastructure/group-sync/config.ts`. The
   `deploy-infrastructure` apply writes the updated JSON to SSM, and the
   Lambda picks it up on its next run with no redeploy.
2. Add the new target group's ARN to the `identity-group-sync-grant` inline
   policy in `deploy/components/`, on the three membership actions. This is a
   management-account (`deploy/`) change, applied by `deploy.yml` — a
   different stack and workflow from the config.
3. Ordering: the grant must finish applying before the Lambda first uses the
   new pair. If the config lands first, the run fails closed with an
   `AccessDenied` abort and changes no membership; that is safe but noisy, so
   land the grant first.
4. Start the pair in `dry-run` and follow "Rollout".

No Lambda code change is needed for a new pair. What does not scale
gracefully: the grant policy's group resource list grows one ARN per pair, and
every pair shares the one role, so the role's reach is the union of all
configured groups. If the number of pairs grows enough for that to matter,
the follow-up is a role per pair (or per group family) rather than widening
the one policy to `group/*`. That is a deliberate follow-up, not part of v1,
and the current scoping stays as it is.

## The sync algorithm

One invocation handles every configured pair, sequentially, each in its own
try/catch so one pair's failure does not stop the others. Each pair is
independent: its own diff, its own guards, its own metrics and its own
abort.

### 1. Read and validate config

Read `/identity-group-sync/pairs` from SSM and parse it. For each pair:
validate `id` is unique, `sourceGroupEmail` is a syntactically valid address,
`mode` is one of the two literals, `targetGroupId` is not reserved, and the
cap and allowlist are well-formed. A pair that fails validation is skipped
with `sync.aborted` (`reason: "invalid-config"`); it is never silently
ignored. An SSM read failure aborts the whole invocation, since running with
no config is indistinguishable from running with an empty one.

### 2. Fetch the source, completely or not at all

- `groups.get` on `sourceGroupEmail`. A miss aborts the pair: a typo in the
  config must not read as "the group is empty".
- `members.list` with the `pageToken` loop, following `nextPageToken` until
  it is absent. Collect `{ email, type }`.
- Partition by `Member.type`. `USER` members are kept. `GROUP` and `EXTERNAL`
  members are logged as `member.skipped` with their type and reason; they are
  out of scope and do not fail the run. A `CUSTOMER` member, or any member
  with no email, aborts the pair with `sync.aborted`
  (`reason: "domain-wide-membership"`) — see non-goal 2. The source set is
  defined by email, so a member that has none cannot be represented in it.
- Lowercase and dedupe the emails.
- **Any error, any non-2xx, or a page chain that ends without exhausting the
  token aborts the pair with `sync.aborted` (`reason: "source-read-failed"`)
  and applies nothing.** A failed or partially paginated read is never
  treated as an empty group. This is the guard the whole job hangs on: the
  only way a strict mirror empties a group is if the source read says the
  group is empty, and this rule is what makes that trustworthy.
- Apply the allowlist: a member whose email is not covered is logged as
  `member.skipped` (`reason: "not-allowlisted"`) and removed from the
  effective source set. Because the mirror is strict, a skipped member who is
  already in the target is removed; the allowlist must therefore be a
  superset of intended target membership, and it defaults to the
  organization's domain.

### 3. Resolve source emails to Identity Store users

For each lowercased email, `GetUserId` with the `emails.value` alternate
identifier — the call `deploy-infrastructure/sheriff/identity.ts` already
makes. `emails.value` is one of the two paths the API documents as valid for
this lookup (`userName` and `emails.value`); `userName` is a distinct
attribute and is not used. `GetUserId` returns a single user id or throws; it
has no multi-match response, so the rule is:

- **Zero matches** (`ResourceNotFoundException`): the user does not exist
  yet, so the email is a candidate for creation.
- **One match**: use that user id.
- **More than one match**: `emails.value` is a declared unique attribute and
  the built-in store holds one email per user (`User.Emails` is fixed to one
  item), so this should not occur. The job cannot enumerate users to detect
  it (`ListUsers` is deliberately not granted), so it is caught on the create
  path: if `CreateUser` returns `ConflictException` for a uniqueness
  violation but re-resolving the same email still finds no user, the pair
  aborts with `sync.aborted` (`reason: "ambiguous-user"`) rather than adding
  a duplicate. The email is lowercased before both the lookup and the create,
  so case is normalized on this side; the identity store's own case handling
  for `emails.value` is not documented, and the create-conflict abort is the
  backstop if a mismatch ever slips through.

**Any other error aborts the pair** — it is not "no user". The result is a
list of `{ email, userId: string | null }`.

### 4. Fetch the target memberships

`ListGroupMemberships` with the `NextToken` loop, collecting
`{ userId, membershipId }`. It is paginated for the same reason
`deploy-infrastructure/sheriff/identity.ts` paginates it: a large group's
membership can be past the first page, and a single-page read would compute a
diff against a truncated target. An error here aborts the pair.

No target email is read. The diff is computed on Identity Store user ids, so
the job needs no `DescribeUser` or `ListUsers`, which keeps the assumed
role's policy to the five actions in "IAM".

### 5. Compute the diff

A pure function, no AWS and no Google, so it is what the tests exercise
directly:

```ts
type SourceMember = { email: string; userId: string | null };
type TargetMembership = { userId: string; membershipId: string };

type Diff = {
  /** Source emails with no Identity Store user yet. */
  toCreate: string[];
  /** Source members absent from the target; `userId` is null for a to-create. */
  add: SourceMember[];
  /** Target memberships whose user is not in the source. */
  remove: TargetMembership[];
};

export const diff = (
  source: SourceMember[],
  target: TargetMembership[],
): Diff => {
  const targetIds = new Set(target.map((m) => m.userId));
  const sourceIds = new Set(
    source.flatMap((m) => (m.userId ? [m.userId] : [])),
  );
  return {
    toCreate: source.filter((m) => !m.userId).map((m) => m.email),
    add: source.filter((m) => !m.userId || !targetIds.has(m.userId)),
    remove: target.filter((m) => !sourceIds.has(m.userId)),
  };
};
```

`add` includes the to-create members, because they are not in the target
either; the handler materializes their user ids after creation. `remove` is by
`membershipId`, which is what `DeleteGroupMembership` takes. The function is
total and pure: same inputs, same diff, no clock, no I/O.

### 6. Guards

- **Dry-run.** If `mode === "dry-run"`, log the diff (counts and ids, never a
  member list) and emit the dry-run metrics, then return without a single
  write. The rollout starts here against the real group. It still evaluates
  the removal cap and reports whether the run would have tripped it, so the
  rollout review sees both the diff and whether an apply would have been
  allowed.
- **Removal cap.** Let `n = remove.length` and `t = target.length`. The cap
  trips when `n > maxCount` **or** `n > ceil(maxFraction * t)`. On a trip the
  pair aborts with `sync.aborted` (`reason: "removal-cap"`), applies nothing —
  including the adds — and emits `RemovalCapTripped` and the removals alarm.
  Aborting the whole pair rather than only skipping removals is deliberate: a
  large removal means the source is not what we think it is, and the safe
  action is to change nothing. It is stricter than the letter of the guard and
  simpler to reason about.
  - **Override.** A manual invocation may carry
    `{"action":"sync","pairId":"...","overrideRemovalCap":true}`. The override
    is an invocation payload, not a config field, so it cannot be left on by
    accident; it requires `lambda:InvokeFunction` on the function and is
    recorded in the audit log with the operator's identity from CloudTrail.
    The cap still trips and still alarms; the override only lets that run
    through.
- **Reserved target.** Already checked at step 1; re-asserted here so the
  guard is adjacent to the writes it protects.

### 7. Apply, in order, idempotently

1. **Create missing users.** `GetUserId` on `emails.value` immediately before
   each create, so a user that appeared since step 3 is reused rather than
   duplicated. `CreateUser` with `UserName` = the lowercased email,
   `DisplayName`, `Name`, and `Emails` (one item, primary, work).
   `ConflictException` on the create is success, and the handler re-resolves
   the id with `GetUserId`; if the re-resolve still misses, the pair aborts
   with `ambiguous-user` rather than proceeding. Throttling is retried with
   exponential backoff.
2. **Add memberships.** `CreateGroupMembership` for every entry in `add`
   (existing users and newly created ones). `ConflictException` means the
   member is already there and is success.
3. **Remove memberships.** `DeleteGroupMembership` by `membershipId` for
   every entry in `remove`. `ResourceNotFoundException` means it is already
   gone and is success.

**Ordering: create → add → remove.** Adding before removing means the group is
never temporarily smaller than the union of source and target during the run,
so a crash partway leaves extra access, not missing access. Every step is
idempotent, so a whole-run retry after a partial failure converges: a created
user is found by `GetUserId`, an existing membership returns
`ConflictException`, and a removed membership returns
`ResourceNotFoundException`.

The ordering is also why the user creation happens before the add even though
the diff does not need it: a member cannot be added before their user object
exists, and the create is the step that can race SCIM.

### 8. Record the run

On success, emit the per-pair metrics (including zeros), the `sync.completed`
audit event with counts and duration, and the heartbeat. On abort, emit
`sync.aborted` with the reason and the `Aborted` metric, and do not emit the
heartbeat — the heartbeat's absence is the dead-man's switch, and an aborted
run is exactly what it is for.

## IAM

Two roles, in two accounts, each scoped to the calls it makes. Neither gets
`DeleteUser`, `CreateGroup`, or `DeleteGroup`, and neither gets any `sso:*`
action: the Identity Store API is not the SSO admin API, the identity store id
and group ids are literals, and there is nothing here that needs to enumerate
instances.

### The Lambda execution role, infrastructure account (`identity-group-sync`)

| Sid | Actions | Resource |
|---|---|---|
| `AssumeSyncGrant` | `sts:AssumeRole` | `arn:aws:iam::333022194791:role/identity-group-sync-grant` |
| `ReadGoogleSecret` | `secretsmanager:GetSecretValue` | the one service-account secret ARN, `-*` suffix |
| `ReadConfig` | `ssm:GetParameter` | `arn:aws:ssm:us-west-2:394495727159:parameter/identity-group-sync/pairs` |
| `PutSyncMetrics` | `cloudwatch:PutMetricData` | `*`, conditioned on `cloudwatch:namespace = IdentityGroupSync` |
| `OwnLogs` | `logs:CreateLogStream`, `logs:PutLogEvents` | the one log group, `:*` |

No `kms:Decrypt` is needed: the secret and the parameter use the account's
default `aws/secretsmanager` and `aws/ssm` keys, whose policies admit the
account, which is the same reasoning `deploy-infrastructure/sheriff-lambda.ts`
records. The log group is created by Pulumi, so no `logs:CreateLogGroup`.

### The assumed role, management account (`identity-group-sync-grant`)

Trust follows `sheriff-grant` exactly: the infrastructure account root as
principal plus an `ArnEquals` `aws:PrincipalArn` condition naming the Lambda's
execution role, because IAM rejects a trust naming a role that does not exist
at apply time. A fixed session name (`identity-group-sync`) so CloudTrail
records every assume under one distinguishable name.

| Sid | Action | Resource |
|---|---|---|
| `ResolveUser` | `identitystore:GetUserId` | identity store ARN, `arn:aws:identitystore:::user/*` |
| `CreateMissingUser` | `identitystore:CreateUser` | identity store ARN |
| `AddMembership` | `identitystore:CreateGroupMembership` | target group ARN, identity store ARN, `user/*` |
| `RemoveMembership` | `identitystore:DeleteGroupMembership` | target group ARN, identity store ARN, `user/*`, `membership/*` |
| `ListMemberships` | `identitystore:ListGroupMemberships` | target group ARN, identity store ARN, `membership/*` |

The resource forms mirror the reasoning in `deploy/components/sheriff-grant.ts`:
the group and identity store are literals, while the user id and the returned
membership id do not exist when the policy is written, so those two are
wildcards scoped to their resource types rather than `*`. The actions are
split one per statement so each statement's `Resource` list contains only
types that action supports.

Because three of these statements name the target group ARN, a new pair is
not authorized until that group's ARN is added here. That is why "Adding a
pair" lists two changes rather than one: the config cannot widen the grant.

**Deliberately absent, and asserted by a test:**

- `identitystore:DeleteUser`, `identitystore:UpdateUser`,
  `identitystore:DescribeUser`, `identitystore:ListUsers`. No described
  operation reads user metadata, and `ListUsers` would enumerate the whole
  identity store, which is more than this job's rule allows. The absence of
  `DeleteUser` is the executable form of non-goal 1.
- `identitystore:CreateGroup`, `identitystore:DeleteGroup`,
  `identitystore:UpdateGroup`, `identitystore:DescribeGroup`. Group existence
  is not this job's business (non-goal 7); the group id is a config literal.
- every `sso:*`, `sso-directory:*` and `sso-oauth:*` action. `sso-directory`
  in particular carries its own `AddMemberToGroup`, a second path to the same
  directory mutation (`deploy/components/identity-center/policies.ts`,
  `adminReservedActions`).
- `identitystore:IsMemberInGroups` and `ListGroupMembershipsForMember`. The
  first is sheriff's requester gate, not this job's; the second is not needed
  because the job lists the whole target group rather than one member's
  memberships.

### Google access, read-only

The service account's scopes are exactly:

- `https://www.googleapis.com/auth/admin.directory.group.readonly` (resolve
  the source group), and
- `https://www.googleapis.com/auth/admin.directory.group.member.readonly`
  (list its members).

Both are delegated to a dedicated impersonation admin account, and the
domain-wide delegation entry in the Google Admin console names the service
account's client id and exactly these two scopes. There is no Google write
scope anywhere in the job; if a future change needs one, it is a separate PR
and a separate consent decision.

### The manual Google setup, which is not a PR

Out of band, and documented here because it is the part of this job that
cannot be code:

1. Create a Google Cloud project (or reuse one) and a dedicated service
   account, e.g. `identity-group-sync@<project>.iam.gserviceaccount.com`.
2. Enable the Admin SDK Directory API (or the Cloud Identity API, per the open
   question).
3. In the Google Admin console, grant the service account's client id
   domain-wide delegation for the two read-only scopes above.
4. Create a dedicated impersonation admin account (not a personal admin
   account) whose only purpose is this delegation, so revoking it is one
   account. Its address is deployment state, not policy: the Lambda reads it
   from `GOOGLE_IMPERSONATION_EMAIL`, which `deploy-infrastructure` fills from
   the `googleImpersonationEmail` stack config key. Until the key is set the
   handler aborts every pair with `source-read-failed` and writes nothing.
5. Create the service account key, put it in the Secrets Manager secret below,
   and never commit it.

**This reverses a decision recorded elsewhere.** `agent-swarm/README.md`
declined to create a Workspace service account with domain-wide delegation,
preferring a file allowlist over group membership, and
`docs/bifrost-gateway.md` records the same decision. This job is the first
thing in the organization that needs it, and it needs it because the
requirement is precisely "mirror a Workspace group", which a file cannot do.
The reversal is scoped: read-only, two group scopes, one impersonation
account. It should be recorded as a decision, not discovered by a reader who
remembers the earlier one.

## Observability

Two signals, deliberately different in loudness, plus the dead-man's switch.

### CloudWatch metrics

Namespace `IdentityGroupSync`, dimension `PairId`, emitted every run for every
pair. Zeros are emitted, not omitted, so an alarm on `Removed > 0` has data to
evaluate.

| Metric | Meaning |
|---|---|
| `Success` | 1 on a completed apply or dry-run; absent on an abort |
| `Added` | memberships added |
| `Removed` | memberships removed |
| `Failed` | individual add/remove/create calls that failed after retries |
| `ToCreate` | users the run created |
| `Skipped` | source members filtered (nested, external, not allowlisted) |
| `SourceMemberCount` | effective source size |
| `TargetMemberCount` | target size before the run |
| `Aborted` | 1 with a `Reason` dimension when a guard or read failed |
| `RemovalCapTripped` | 1 when the cap aborted the pair |
| `RunDurationMs` | wall-clock duration |

### Structured logging

One JSON object per line, with an `audit` field so a metric filter can key on
it (the `sheriff` convention, `{ $.audit = "..." }`). Events: `sync.started`,
`sync.completed`, `sync.aborted`, `member.added`, `member.removed`,
`member.skipped`, `user.created`, `removal_cap.tripped`.

**Membership is personal data, and the logs say so by not containing it.** A
per-member event logs the pair id, the group id, the opaque Identity Store
user id, and a truncated SHA-256 of the email when a stable human-readable
reference is needed. It never logs a list of member email addresses, and the
`sync.completed` event logs counts, not members. `member.skipped` logs the
domain (not the local part), the Google member type and the reason, so a
misconfiguration is debuggable without putting addresses in CloudWatch. The
GoodParty data rules apply to this job the same way they apply to everything
else in this container.

### The dead-man's switch

The alarm is the absence of the heartbeat, not an error:

```ts
new aws.cloudwatch.MetricAlarm("groupSyncHeartbeat", {
  namespace: "IdentityGroupSync",
  metricName: "Success",
  dimensions: { PairId: pair.id },
  statistic: "Sum",
  // One period is one poll interval; two of them is "no success in 2x the
  // poll interval", which is the requirement.
  period: pollIntervalSeconds,
  evaluationPeriods: 2,
  threshold: 1,
  comparisonOperator: "LessThanThreshold",
  // The point: a run that never happened is a breach. The metric does not
  // exist until the first success, so this fires from the first interval on
  // an account that has never synced, which is correct.
  treatMissingData: "breaching",
  alarmActions: [alertTopic.arn],
});
```

The removals alarm is separate, because removals are not errors and an error
alarm would never see them:

```ts
new aws.cloudwatch.MetricAlarm("groupSyncRemovals", {
  namespace: "IdentityGroupSync",
  metricName: "Removed",
  dimensions: { PairId: pair.id },
  statistic: "Sum",
  period: pollIntervalSeconds,
  evaluationPeriods: 1,
  threshold: pair.removalAlertThreshold, // default 0: any removal pages
  comparisonOperator: "GreaterThanThreshold",
  // Zeros are emitted, so there is always data; this is only for the window
  // before the first run.
  treatMissingData: "notBreaching",
  alarmActions: [alertTopic.arn],
});
```

A third alarm on `RemovalCapTripped > 0` and on `Aborted` makes the guards
visible rather than silent. All three publish to an SNS topic subscribed to
`aws-infrastructure@goodparty.org`, the same address the infrastructure budget
and `sheriff` use; the subscription stays unconfirmed until someone accepts
the email, which is called out in the PR body like the `sheriff` one.

## Secrets

- **The Google service account key** lives in a Secrets Manager secret named
  `identity-group-sync/google-service-account` in the infrastructure account,
  holding the key JSON. Pulumi creates the container empty and never sets its
  value; the value is filled by hand, exactly like the `sheriff` secret
  (`deploy-infrastructure/sheriff-lambda.ts`), and the PR body says so. The
  secret is not `protect`ed: Pulumi owns its lifecycle, only its value is
  out-of-band.
- **Rotation.** A service-account key is long-lived, so the plan is a 90-day
  rotation with two keys overlapping: create key B, update the secret, confirm
  a sync succeeds, then delete key A. That is a manual runbook step until it
  is automated. The secret's ARN wildcard in the Lambda policy survives a
  delete-and-recreate rotation, the same seam the Brave Search key records.
- **Workload Identity Federation, as a future option.** GCP Workload Identity
  Federation can trust an AWS IAM role and mint a short-lived credential with
  no static key, then impersonate the service account. That removes the key
  entirely, which is strictly better on the day it is built; it is recorded
  here as the follow-up, not the v1, because it adds a second identity
  provider and an impersonation chain to debug. It does not change the
  domain-wide delegation or the scopes.

## Rollout and test plan

### Rollout

1. Land the management-account role and the infrastructure Lambda with every
   pair in `mode: "dry-run"`.
2. Let it run against the real group for several poll intervals. Review the
   logged diff: the adds and removes are counts and hashed ids, and the
   `sync.completed` event carries the counts. The point is to see the diff a
   human would have to approve before it can happen.
3. Confirm the heartbeat alarm is green (a success is being recorded) and that
   the dry-run removals are what a human expects.
4. Flip the first pair to `mode: "apply"` in a reviewed Pulumi change. The
   removals alarm is on from the start, so the first real removal pages.
5. Add further pairs the same way, one at a time, each starting dry-run.

### Tests

The unit tests below live next to the code they exercise:
`deploy-infrastructure/group-sync.test.ts` for the diff, the guards and the
read adapter (step 2), `deploy-infrastructure/group-sync-runtime.test.ts` for
the handler, the algorithm, the Identity Store idempotency and the Lambda's
role and wiring (step 3). Both are `node --test` via `tsx`, picked up by
`npm test`.

- **Unit, pure diff.** `node --test` with fixtures for: add only, remove only,
  both, no-op, empty source (all target removed, and the cap must trip on a
  non-empty target), empty target (all added), case and whitespace
  normalization, dedupe, a nested `GROUP` member skipped, an `EXTERNAL`
  member skipped, a `CUSTOMER` member aborting the pair, a member with no
  email aborting the pair, an allowlist skip, and a to-create member
  appearing in both `toCreate` and `add`.
- **Unit, email resolution.** `GetUserId` on `emails.value`: zero matches
  creates, one match reuses, and a `ConflictException` on create followed by a
  failed re-resolve aborts with `ambiguous-user` rather than duplicating.
- **Unit, removal cap.** Both bounds, the boundary (`n == maxCount` passes,
  `n == maxCount + 1` trips), the fraction rounding, and the override path.
- **Unit, incomplete-read abort.** Mock the Google client so the member
  pagination throws on the second page, and assert that the handler makes
  **no** `CreateUser`, `CreateGroupMembership` or `DeleteGroupMembership`
  call. This is the single most important test in the job and it is called out
  separately because a regression here is the one that empties a group.
- **Unit, idempotency.** `ConflictException` on create-user and on
  create-membership, and `ResourceNotFoundException` on delete-membership, are
  each treated as success, and a re-run of the same diff is a no-op.
- **Unit, reserved target.** A pair naming the `Admins` group id aborts with
  `reason: "reserved-target"` and no writes.
- **Integration, against a scratch identity store.** Run the fetch → diff →
  apply path end to end against a scratch Google group and a scratch Identity
  Center group, asserting the membership after a run. Whether "scratch
  identity store" means a scratch group in the existing store or a dedicated
  test account is **open**: Identity Center is one instance per account per
  region, so a truly separate identity store needs a separate account. The
  minimum viable version is a `group-sync-test` group in the existing store
  and a scratch Google group, with the job configured for that pair only; the
  stronger version is a dedicated account.
- **Test-only IAM.** The assumed role's policy is asserted by a test that pins
  the exact action list and asserts the absence of `DeleteUser`,
  `CreateGroup`, `DeleteGroup` and every `sso:*` action, the way
  `deploy/sheriff-grant.test.ts` pins its list.

## Implementation plan

One step at a time, one pull request per step. Statuses are `todo`, `doing`,
and `done`. The order matters at one point: the management-account role must
merge and finish applying before the Lambda that assumes it merges, because
the Lambda's first run is an `AssumeRole` and a missing role is an
`AccessDenied`, not an apply-time error.

- [x] 1. Definitions only, no runtime: the `identity-group-sync-grant` role
      and its inline policy in `deploy/components/`, registered in
      `deploy/index.ts` next to `createSheriffGrant()`, with the trust and
      policy tests. No Lambda yet. `done`
- [x] 2. The Google read adapter and the pure `diff`, with the unit tests for
      the diff and the incomplete-read abort. No AWS resources, no schedule.
      This is where the correctness of the job lives and it is reviewable
      without any infrastructure. `done`
- [x] 3. The runtime in `deploy-infrastructure/group-sync-lambda.ts`: the
      Lambda, its execution role and inline policy, the SSM parameter, the
      secret container, the log group, the EventBridge rule with reserved
      concurrency 1, the metric filters and the three alarms. Every pair ships
      `dry-run`. `done`
      (The alarms are the dead-man's heartbeat, the failures alarm on
      `Aborted` and the removal-cap alarm, plus the plan's separate removals
      alarm per pair, which the rollout leans on. The handler itself lives in
      `deploy-infrastructure/group-sync/`, beside the step 2 modules.)
- [ ] 4. The integration test and the rollout: dry-run against the real group,
      review the diff, then the Pulumi change that flips the first pair to
      `apply`. `todo`

## Open questions

Each of these is genuinely undecided and is separated from the fixed design
above.

1. **Which Google API, and does this org's edition serve it?** The plan is
   written against the Admin SDK Directory API. If the organization uses
   Cloud Identity (or a Workspace edition whose group membership is only in
   the Cloud Identity API), the fetch adapter changes and the scopes with it.
   The design keeps this behind one module so the answer is a one-file change.
2. **The Identity Center home region.** `us-west-2` is the value
   `deploy-infrastructure/sheriff/identity.ts` uses and the value assumed
   here. Confirm it is the home region before implementation, because calling
   the Identity Store API in the wrong region fails in a way that reads as a
   permissions problem. **Resolved:** the engineer confirmed `us-west-2` when
   step 3 was built, and the runtime names it in one constant.
3. **User display names.** The job only reads group membership, so it has the
   email and not the person's name. Identity Store `CreateUser` needs a
   `DisplayName` and a `Name`. The default is to derive both from the email
   local part and let a human correct them later, which keeps the Google scope
   to group reads only. The alternative is to add
   `admin.directory.user.readonly` and enrich from the Google profile, which
   is a wider scope for a cosmetic field. Which way is a decision, not a
   default. Step 3 implements the derived default
   (`deriveDisplayName` in `deploy-infrastructure/group-sync/identity.ts`):
   tokens split on `.`, `_` and `-`, capitalized, with `FamilyName` omitted
   when the local part is a single token. Nothing is created while the pair is
   `dry-run`, so the decision can still be revisited before the first apply.
4. **The integration-test environment.** A scratch group in the existing
   identity store is cheap but not isolated; a dedicated test account is
   isolated but is a new account. Which one is acceptable is open.
5. **The poll interval and the cap defaults.** The plan uses an interval
   expressed in the config and cap defaults of `maxCount: 5` and
   `maxFraction: 0.1`, with `removalAlertThreshold: 0`. The interval and the
   numbers are placeholders until the first real group's size is known. Step 3
   ships the placeholders: a 15-minute interval
   (`POLL_INTERVAL_SECONDS` in `deploy-infrastructure/group-sync/config.ts`,
   with the function timeout and every alarm period derived from it) and the
   plan's cap numbers unchanged. Nothing here is settled by having built it;
   step 4's dry run is what should settle them.
6. **SCIM adoption.** If SCIM is adopted later, this job's user creation
   conflicts with it (non-goal 3). The migration is to let SCIM own user
   creation and drop `CreateUser` from this job's role and code, which is a
   deliberate follow-up, not something this plan decides now.
7. **The first pair's actual source and target.** This plan names no real
   group. The engineer picks the source Google group and the target Identity
   Center group, subject to the reserved-target invariant. **Resolved:** the
   `engineering@goodparty.org` Workspace group mirrors the `Engineers` Identity
   Center group (`383193a0-7001-70d9-a321-ffe6d8af7378`), whose ARN is already
   in the merged grant. The pair ships `dry-run`.

## Grounding: the files this touches

For a reviewer checking the plan against the repo:

- `deploy/components/identity-center.ts` — the `groups` map holds the group
  ids. The target group is created out of band and its id recorded here; the
  `Admins` id (`88c1b330-a001-707a-06ca-94e289013bf5`) is the reserved-target
  literal.
- `deploy/components/identity-center/policies.ts` — `adminReservedActions`,
  which records that `sso-directory` carries its own `AddMemberToGroup` and
  is why the assumed role gets only `identitystore` actions.
- `deploy/components/sheriff-grant.ts` — the cross-account role pattern this
  plan's `identity-group-sync-grant` copies: account-root principal plus
  `ArnEquals aws:PrincipalArn`, and one statement per action so each names
  only the resource types it supports.
- `deploy-infrastructure/sheriff/identity.ts` — the existing Lambda's
  Identity Store calls and its cross-account assume, including the pagination
  on `ListGroupMemberships` this plan reuses.
- `deploy-infrastructure/sheriff-lambda.ts` — the runtime-resource pattern:
  explicit provider, `aws.ssm.Parameter`/`aws.secretsmanager.Secret` created
  empty, log group, `aws.cloudwatch.EventRule`, `LogMetricFilter` and
  `MetricAlarm` with an SNS topic.
- `deploy-infrastructure/group-sync-lambda.ts` and
  `deploy-infrastructure/group-sync/` — the runtime step 3 built: the function
  and its role, policy, parameter, secret, schedule, filters and alarms, plus
  the handler, the algorithm, the Identity Store adapter and the Google
  transport.
- `deploy-infrastructure/index.ts` — where `createGroupSync` is registered,
  and the `allowedAccountIds` and explicit-provider rules every resource must
  follow.
- `utils/accounts.ts` — `MANAGEMENT_ACCOUNT_ID`, `INFRASTRUCTURE_ACCOUNT_ID`,
  `IDENTITY_STORE_ID` and `IDENTITY_STORE_ARN`, which the policy names.
- `deploy/sheriff-grant.test.ts` and `deploy-infrastructure/sheriff.test.ts` —
  the tests that pin a policy's action list and a group literal by reading the
  source file; this plan's tests follow them.
- `docs/sheriff.md` — the access model this job must not fight, and the reason
  `Admins` is reserved.
- `docs/infrastructure-account.md` — the account this Lambda runs in and the
  `Infrastructure` SCP it lives under.
- `agent-swarm/README.md` and `docs/bifrost-gateway.md` — where the
  organization declined domain-wide delegation and the decision was recorded,
  which this plan deliberately reverses for this job.
