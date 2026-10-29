# Per-user Bifrost virtual keys

> This is the design for how a person gets a key to the Bifrost gateway, how it
> is taken away, and how a coding harness presents it. It is the second half of
> phase E of [`bifrost-gateway.md`](./bifrost-gateway.md), which is the
> gateway's plan and the place to start: this document assumes the gateway, its
> oauth2-proxy admin surface, its RDS config store and the image pinned at
> `v2.3.0` described there. It changes no code and no infrastructure.
> Implementation PRs follow, and a PR names this document and the step it
> implements in its body; progress is derived from those PRs and is not written
> here (decision 11 of [`plan-gated-merges.md`](./plan-gated-merges.md)).

The gateway's plan settled that the human path is **one virtual key per
person**, and then deliberately stopped: "how virtual keys are distributed to
engineer machines and the `gp-pi` container, how they are rotated, and how
offboarding works" was phase E, gated on the gateway being proven out. This is
that design. What has changed since is that the gateway is live
(`/health` answers `200` and an unauthenticated inference call answers `401`,
checked from this container), and the key is the last piece between a person
and their traffic.

Today a key is made by hand: somebody creates it in the dashboard, or declares
it in `config.json` under phase 2 item 14, and its owner is whoever remembers.
That works for a pilot of three and fails the moment the gateway is the
default, in two ways that matter:

- **Nobody can say who spent what.** Cost attribution is only as good as the
  one-key-per-person rule, and a hand-issued key is a key whose owner is
  whoever remembers. A key per *tool* — one for pi, one for Claude Code, one
  for Codex — makes the per-person number worse, not better, and that is the
  shape that grows when issuance is manual.
- **Nobody can widen one person's access without touching the file everyone
  else's key is declared in.** Reaching a higher-grade model is a gateway
  decision, not an AWS one (see "Bedrock stays centralised" below), so it
  should be a per-person record, not an edit to a shared config block.

So: a key is minted on demand from a person's Identity Center membership, and
deactivated when that membership ends. The person never sees a pasted secret,
nobody has to remember to issue one, and the group — not a list in a repository
— is what decides who may have one.

## Bedrock stays centralised, which is why this is a gateway decision

Every request reaches AWS as the gateway's own task role, so the person's model
access is purely a gateway decision (the key's `provider_configs`), never an
IAM one. That is already true of the gateway's plan and it is the fact this
design leans on: widening one person's access is an allowlist on their key, and
nothing about `WorkbenchAccess`, `EngineerAccess` or the Bedrock task role
changes. This document does not touch the Bedrock IAM either: that grant is
merged (#396, `bifrost-bedrock-iam`), and this design neither depends on it nor
modifies it.

## Goals

1. **Attribution per person.** A request is attributable to a person because
   the key belongs to that person, not because a convention says so.
2. **Provisioning and retrieval without a human in the loop.** Nobody pastes a
   key anywhere, and nothing has to be re-issued when a container is rebuilt.
3. **Revocation when someone leaves the group.** Leaving the group stops the
   traffic, with a bounded delay, without a person remembering to do anything.
4. **A gate on who can obtain a key.** Being able to mint is a consequence of
   group membership and nothing else.

## Non-goals, for pass one

- **Scheduled key rotation.** Endpoints exist (see "Deferred"), the design does
  not use them yet.
- **Per-person tier expression** — "who may use the higher-grade models". The
  data model already supports it; the choice of how a person is designated is
  deferred, not designed.
- **Non-engineer onboarding.** The design must not *prevent* it, and it does
  not: a key belongs to a person, a person belongs to a group, and a tier is
  data. But the first group is `Engineers`, and nothing here names a
  non-engineer path.
- **A hard security boundary against an engineer sharing their own key.** A key
  belongs to a person, not a machine, so a copy is undetectable. This is a cost
  and access-attribution control, not a DRM scheme; see "What this is not".

## Anti-goals

These are the mistakes this design is shaped to avoid, stated so a later change
can be measured against them:

- **A design where the Google group is decorative.** If membership is checked
  once at issuance and never again, the group is a comment. It is checked at
  mint time (the caller's SSO role is the membership proof) and at every
  janitor run, and the janitor is what makes the second half true.
- **Per-tool keys for one person.** One person, one key, whatever harnesses
  they run. Three keys per person triples the keys and divides the number the
  attribution exists to produce.
- **Any path where a person can obtain someone else's key.** The mint endpoint
  serves exactly one key — the caller's — and no endpoint or command accepts
  somebody else's email.

## Decisions

### 1. Who a key belongs to: the Identity Center group

The source of truth for *who* is the Identity Center group — `Engineers`, whose
members hold `WorkbenchAccess` in the workbench account
(`deploy/components/identity-center.ts`). It is the same group the Google
Workspace sync already maintains: `engineering@goodparty.org` is mirrored into
`Engineers` every fifteen minutes by the job in
[`google-group-sync.md`](./google-group-sync.md). So "leaving the group" means
leaving the Workspace group, and no second Google integration is needed — which
matters, because domain-wide delegation is a credential this organization
grants sparingly and a second consumer of it would be a new decision.

**Being able to call the mint endpoint is the first half of the membership
check.** An engineer's session in the container is
`arn:aws:sts::024901689212:assumed-role/AWSReservedSSO_WorkbenchAccess_<hash>/<email>`
(verified in this container with `aws sts get-caller-identity`). A person who
is not in `Engineers` cannot assume `WorkbenchAccess`, so they cannot reach the
endpoint at all. There is no separate allowlist to drift, and the caller's
identity is not something they can assert.

**It is only half, because a session outlives a membership.** A
`WorkbenchAccess` session lasts up to 12 hours (`PT12H` in
`deploy/components/identity-center.ts`), so somebody removed from `Engineers`
keeps a working session until it expires — and a session that can reach the
endpoint can re-mint. Review caught exactly that, and without a second check the
janitor's deactivation would be undone by one `--refresh` from the old session.
So the mint **also checks live membership on every call**: resolve the session
name to a user id with `GetUserId` on `emails.value`, list the group's
memberships, and refuse with `403` when the caller is not in it — failing
closed on a read error. The gate is "whose session is this" *and* "is that
person in the group now", and the second half is what makes revocation stick.

### 2. Mint on demand, through a Lambda the caller cannot lie to

A Lambda with a **Function URL** and `AuthType: "AWS_IAM"`. The function
receives a SigV4-signed request that AWS has already verified, so the caller's
identity arrives as data AWS vouches for (`requestContext.authorizer.iam`), not
as a header the caller set.

- **The function uses only that verified identity and ignores any email in the
  request body.** The request body carries nothing the function reads; a caller
  who posts `{"email": "someone@goodparty.org"}` gets their own key.
- **The email is the session name** in the assumed-role ARN. The function takes
  it from `requestContext.authorizer.iam.userArn`, and additionally requires
  that ARN to name an `AWSReservedSSO_WorkbenchAccess_` role in the workbench
  account. That second check is not decoration: any other role in the account
  can pick its own session name, so without it a role that is *not* the
  `WorkbenchAccess` set — the gateway's own task role, a deploy role — could
  mint a key named as somebody else.
- **Direct `lambda:Invoke` is refused**, and for a reason rather than a
  preference: the Invoke API delivers only the payload, so the function cannot
  see who called it and cannot honour "your own key only". The grant is
  therefore shaped so that only the URL path works: `WorkbenchAccess` gets
  `lambda:InvokeFunctionUrl` (condition `lambda:FunctionUrlAuthType: AWS_IAM`)
  and `lambda:InvokeFunction` (condition `lambda:InvokedViaFunctionUrl: true`),
  and never a bare `lambda:InvokeFunction` on the function. AWS's own note is
  that new function URLs require both permissions from October 2025; the
  conditions are what keep the second one from also opening the Invoke API.
- **The Function URL is public and IAM-gated**, which is the same shape the
  gateway's own inference endpoint chose: reachable from anywhere a harness
  runs, and refused without a credential. Nothing about the endpoint is
  reachable anonymously.
- **It reads the directory through the same small cross-account role the
  janitor uses** (decision 6): `GetUserId` on `emails.value` and
  `ListGroupMemberships` on `Engineers`, read-only, no `DescribeUser`. That
  grant is the second half of the membership check, and the only reason the
  mint function reaches the management account at all.

### 3. The Lambda holds the gateway's setup token, and that is a real credential

The function talks to the Bifrost admin API, not to the database. The database
is the wrong door — OSS keeps governance state in memory and a direct row
insert would not become a live key (`bifrost-gateway.md`, "One node, because
OSS is one node") — so the only supported path is `/api/governance/virtual-keys`.

At the pinned tag that path needs no session login, because dashboard auth is
off by decision, and it needs the OSS setup lock's header on every non-public
`/api` call: `X-Bifrost-Setup-Token`. So **the "setup key" the Lambda holds is
the setup token** — the same value `deploy-workbench/bifrost/fill-secrets.sh`
generates into `bifrost/gateway` and the oauth2-proxy sidecar injects for a
human (`bifrost-gateway.md`, "Protecting the admin surface").

State plainly what that means: **this is a deployment-wide, effectively
admin-level credential.** It is the proof of operator control the OSS setup
lock is built around, and it also unlocks re-enabling dashboard auth. Two
consequences, both requirements rather than advice:

- **The Lambda must be small and boring.** It reads a name, a template and the
  setup token; it makes one or two calls; it returns a key. It must not log
  request or response bodies — a virtual key appears in both, in plaintext —
  and a thrown error must not carry the body into CloudWatch.
- **Only the mint Lambda, the janitor (decision 6) and the oauth2-proxy
  sidecar may read the secret.** No human, no other task, no CI job.
  `bifrost/gateway` also holds the encryption key and the Fireworks key, so the
  Lambda's `secretsmanager:GetSecretValue` grant on that container reaches more
  than the token it uses; a dedicated `bifrost/vk-mint` container holding only
  `BIFROST_SETUP_TOKEN` would close that gap, at the cost of a second copy of
  one credential the design never rotates. Recorded as an open item rather than
  decided here.

**The function must reach Bifrost from inside the VPC.** The ALB routes `/api`
through oauth2-proxy and Google SSO, which a Lambda cannot pass; there is no
public path to the management API and there should not be one. So the function
is VPC-attached to the gateway's private subnets and calls the task on
`8080` directly, which requires a security-group rule that does not exist
today: `bifrostTaskSecurityGroup` accepts 8080 and 4180 from the ALB's group and
from nothing else (`deploy-workbench/network.ts`). That rule is the first
exception to that invariant and it belongs in the PR that adds the function,
documented where the rule is written. The function addresses the task as
`bifrost.workbench.local`, the private Cloud Map name step 3 registers: a
task's address changes on every replacement and its `privateDnsName` is just
that address, so the name is what makes the 8080 path stable. Step 5's janitor
makes the same calls against the same name.

**Not verified, and the whole of step 3 depends on it:** that a Lambda attached
to those subnets can reach the task on 8080 at all, and that the gateway
answers a setup-token request on that path. See "Open items".

### 4. Idempotent minting, and the key name is the person's lowercase email

The invariant: **for every person there is at most one Lambda-managed key, and
calling the mint endpoint twice returns the same key rather than a second one.**
Every part of that is checked against the pinned source rather than assumed:

- **Bifrost is the only store for the key.** `GET /api/governance/virtual-keys`
  returns each key's plaintext `value`
  (`TableVirtualKey.MarshalJSON` emits the resolved secret as a string), so the
  Lambda can return an existing key without keeping a copy anywhere. No SSM
  parameter, no Secrets Manager entry, no second source of truth to drift.
- **The `search` parameter is a case-insensitive substring**, not an exact
  match: `VirtualKeySearchConditions` ORs a `LOWER(name) LIKE %term%` with the
  key's team name and customer name. So `search=jeff@goodparty.org` also
  matches `xjeff@goodparty.org`, and **the Lambda must filter for an exact name
  match itself.** This is the one line a reader will otherwise assume is
  redundant.
- **Names are unique.** `idx_virtual_key_name` is a unique index on the key's
  `Name`, and the create path answers `409 A virtual key with this name already
  exists`. So a concurrent first call is safe: the loser's create fails on the
  index, and the Lambda re-reads and returns the winner's key. That is the
  second half of idempotency, and it is why the idempotency does not rest on a
  lock the Lambda cannot take.
- **An inactive key still holds its name**, so a returning user is a
  reactivation, not a create: `PUT /api/governance/virtual-keys/{vk_id}` with
  `is_active: true`, rather than a delete-and-recreate that would lose the
  key's budgets and spend history. The same call **clears the janitor's
  deletion timer** — `expires_at: ""` (the update path reads an empty string as
  "no expiry") and `delete_after_expire: null` (back to inheriting
  `client.delete_expired_virtual_keys`) — because an expiry that has passed
  rejects the key whatever `is_active` says, and the deletion would take the
  history the reactivation exists to keep. A reactivation only ever happens for
  a caller the membership check has just admitted (decision 1), so a
  deactivated key is never a way back in for someone who has left.
- **A create takes effect immediately**, not at the next restart: the handler
  reloads the key into the running gateway's governance manager before it
  answers.

Routes, at `transports/v2.3.0`
(`transports/bifrost-http/handlers/governance.go`):

| Call | Route |
| --- | --- |
| list, with `search`, `limit`, `offset`, `export` | `GET /api/governance/virtual-keys` |
| create | `POST /api/governance/virtual-keys` |
| read one | `GET /api/governance/virtual-keys/{vk_id}` |
| update (activate, deactivate, expiry) | `PUT /api/governance/virtual-keys/{vk_id}` |
| delete | `DELETE /api/governance/virtual-keys/{vk_id}` |

The key name is the **lowercase email**, which is the same string the Identity
Store holds as the user's `userName` and the same string the janitor resolves
back to a user id. One string, three systems, no mapping table.

### 5. The default key shape — the author's call, flagged

**Decided here, and marked as the author's call rather than something review
settled.** One default tier for everyone for now, so that a first key is
uniform and a mistake is uniform:

- **`provider_configs` is pinned explicitly** to the models already allowed in
  `deploy-workbench/bifrost/config.json` and `utils/bedrock-models.ts`.
  `provider_configs` empty is deny-by-default, so the template never relies on
  an empty list, and it never says `"*"` for a Bedrock model list — "all
  Bedrock" is exactly the widening this design exists to make deliberate.
  Each provider entry also carries `key_ids: ["*"]`, because a provider config
  with no keys allows none: empty is deny, `"*"` is "use the provider's keys",
  and the gateway's keys are the deployment's, not the person's.
- **No `budgets` and no `rate_limit` on the key.** Decided in review on this
  PR: per-person budgets and rate limits are skipped for now, because AWS and
  Fireworks already impose provider-level limits that act as the stopgap, and a
  number chosen before there is any usage data is as likely to starve a person
  mid-task as to catch anything. What stays is attribution, which is what the
  key is for. What this gives up is stated in "Deferred": nothing stops one
  person's runaway loop except the provider's own limit, and the account
  budget alerts rather than binds.
- **A marker in `description`** identifies the key as Lambda-managed. It is the
  janitor's only input, and it is what keeps a hand-made key — a test key, an
  experiment, a key a human created in the dashboard — out of reach of a job
  that deactivates things. The exact string is the implementer's, in one
  constant, matched by both Lambdas.
- **The template is a file, not a code path.** A committed JSON template beside
  the Lambda, stored by Pulumi as an SSM `String` parameter and read at run
  time, the same shape the group-sync job uses for its pair list. Widening a
  model list is then a reviewed file change and an apply, with no Lambda code
  change — which is what "the tier is data" has to mean if a non-engineer is
  later to be a record rather than a branch. A test fails if the template names
  a model the gateway's `config.json` does not allow, since a model in one and
  not the other is a `404` or an `AccessDenied` at runtime. When budgets come
  back, they come back through this file.

### 6. The janitor: a scheduled reconcile loop

**Agreed in review, the engineer's idea.** A second Lambda on an EventBridge
schedule, roughly hourly, that makes the set of Lambda-managed keys follow the
group:

1. List the `Engineers` group's members from the Identity Store.
2. List every virtual key in the gateway and keep the ones carrying the
   description marker.
3. Deactivate a managed key whose owner is not a member.

Rules, each of which is a decision:

- **Deactivate first, delete later.** Deactivating is one field and is
  reversible; deleting cascades in the database and takes the key's budgets and
  its spend history with it. A key that is deactivated also gets
  `expires_at` set to a retention window and `delete_after_expire: true`, so
  Bifrost's own daily cleanup deletes it rather than the janitor growing a
  delete path. **The timer is set once, on the transition**, and the janitor
  leaves a key that is already inactive with an expiry set alone — otherwise an
  hourly run pushes the window forward every hour and nothing is ever
  deleted. **The retention window is 90 days**, matching the gateway's own log
  retention: past that point the request records that make the history worth
  keeping have rolled off anyway, and a returning person is a reactivation
  rather than a resurrection.
- **The janitor only ever takes access away; the mint gives it back.** It never
  reactivates a key, including when the owner is a member again. Getting a key
  back is a mint, which is the path that also clears the deletion timer
  (decision 4), so there is one code path that grants and one that revokes and
  neither undoes the other by accident.
- **Touch only marker-bearing keys.** Not "keys that look like emails": a
  person's own test key, or a key a human made in the dashboard, is never
  deactivated by a job. The marker is the whole safety property.
- **Fail closed.** If the Identity Store read errors, or returns an empty
  group, the run does nothing and says so. "The group is empty" is
  indistinguishable from "the read failed" at the far end, and the safe reading
  of a mass removal is to not do it — the same guard, for the same reason, as
  the incomplete-read abort in `google-group-sync.md`.
- **Revocation takes effect at the next run**, so the interval is a choice and
  not a detail: hourly means traffic stops within about an hour and a quarter of
  the person leaving the *Workspace* group, counting the fifteen-minute
  Workspace→Identity Center sync. That bound holds only because the mint also
  checks membership (decision 1): the janitor deactivates, and a session the
  person still holds cannot undo it by minting again. Without that check the
  real bound would be the session's 12 hours, and every revocation would be
  reversible. An hour, and not five minutes, because a person who has left is
  not a five-minute emergency and a job that runs often enough to page on is a
  job that pages for a bad reason.
- **The janitor is in the workbench account and reads the directory
  cross-account, through the same role the mint uses.** It has to be in the
  workbench account — it is the second caller of the VPC-internal admin API —
  and the Identity Store lives in the management account. Both Lambdas
  therefore assume one small role there, in the shape
  `deploy/components/identity-group-sync-grant.ts` already establishes: the
  same account-root-plus-`aws:PrincipalArn` trust (two trusted roles), the same
  fixed session name, and two actions rather than five — `ListGroupMemberships`
  on the group and `GetUserId` on the store, with nothing that writes to the
  directory. One role rather than two because the read is identical and the
  audit story is better with a single name in CloudTrail.
  `ListGroupMemberships` returns user ids and not emails, and neither job gains
  `DescribeUser`: each resolves the email it already has with `GetUserId` on
  `emails.value` (the lookup `deploy-infrastructure/sheriff/identity.ts`
  already makes) and intersects on user id. A key whose owner resolves to no
  user is not a member, and is deactivated — the fail-closed direction.
- **The janitor holds the setup token too**, for the same reason the mint
  function does (decision 3): it is the second caller of the admin API, so it
  reads the same secret, is granted the same one container, and is under the
  same rule about never logging a body. It only ever sends `is_active` and
  expiry fields, so its blast radius is narrower than the mint path's even
  though its credential is not.

**Revocation on offboarding is in pass one even though rotation is not.** They
look like the same feature and they are not: rotation is scheduled hygiene with
no incident behind it, while offboarding is the difference between a
deactivated key and an active one held by someone who left.

### 7. Distribution: `gp-pi bifrost-key`

The interface is one command in the **`thegoodparty/gp-pi`** repository, in a
later PR; this document only specifies it. **The name is the interface, not yet
a command that exists in the image** — checked against the `gp-pi` code and
recorded at the end of this decision, because `gp-pi` is a host-side launcher
there. The gateway's provider entry in Pi's `models.json` is:

```json
"bifrost": {
  "baseUrl": "https://bifrost.workbench.goodparty.org/v1",
  "api": "openai-completions",
  "apiKey": "!gp-pi bifrost-key"
}
```

Pi runs a leading `!command` **at request time and does not cache it** (Pi's
`docs/models.md`, "Configure a compatible endpoint"), which turns "nobody pastes
a key" into "the key is fetched whenever it is needed". That also means the
command runs on every model request, so its own caching is a requirement rather
than an optimisation — a command that minted on every turn would put a
`GetCallerIdentity` and often a Lambda call in front of every prompt. The base
URL and `openai-completions` shape were exercised in this container with a
hand-issued key before this document was written.

The command, in order:

1. **Read the cache.** `~/.pi/agent/bifrost-key.json`, mode `600`, on the
   `gp-pi-home` volume: the key, the email it was minted for, and when it was
   fetched. `gp-pi-home` is the same trust class as the GitHub token, the SSH
   key and the SSO token that already live there, and it survives image
   rebuilds; `/tmp` was the alternative and would refetch after every restart.
2. **Check identity, then the TTL.** Serve the cached key only when the entry's
   email matches the current SSO identity and the entry is younger than **12
   hours**. Keys do not rotate in pass one, so the TTL only bounds
   "the key was recreated, the cache is stale", and 12 hours is short enough
   for that and long enough to be invisible.
3. **On a miss, take a single-flight lock** (`flock`) and mint. Up to eight
   agents share one container and would otherwise all mint at once on the first
   turn after a rebuild; the lock makes that one mint and seven reads.
4. **Mint**: export the SSO session's credentials, sign a `POST` to the
   function URL with SigV4, and print the returned key. The key exists in the
   function's response, in the cache file, and nowhere else.
5. **Cache, then print.** The key goes to stdout and nothing else does, so Pi's
   command substitution gets a key and not a paragraph.
6. **`--refresh` drops the cache first.** A `401` from the gateway cannot be
   seen by the command — Pi calls the command before the request — so the
   gateway's rejection is answered by documentation: the `401` handling note
   says to run `gp-pi bifrost-key --refresh`. **Do not cache a failure beyond a
   few seconds**, and make an expired SSO session one clear message ("run `aws
   sso login`") rather than a Lambda call per turn.

**Where the identity check actually comes from — the engineer's assumption, and
the correction.** The brief for this design said to read the current SSO
identity "cheaply from the local SSO cache rather than an STS call". That is
not available in this container, and it is worth recording because it changes
step 1's cost: the SSO cache (`~/.aws/sso/cache/*.json`) holds the client
registration and the access token (`startUrl`, `region`, `accessToken`,
`expiresAt`, `clientId`, `clientSecret`, `refreshToken`) and **no user
identity at all**, and the CLI's credential cache (`~/.aws/cli/cache/*.json`)
holds only credentials, `Expiration` and `AccountId`. So the identity check is
`aws sts get-caller-identity`, cached in the same file with its own short TTL
(a few minutes), which makes a normal request path zero extra calls, a cold
path one identity call plus one mint, and a lapsed session a `GetCallerIdentity`
error that is exactly the "run `aws sso login`" message. It costs one STS call
per container per few minutes and buys a check that cannot be wrong.

**Properties this buys, stated so nobody has to infer them:**

- **A stale cache cannot grant access.** Bifrost checks `is_active` on every
  request, and the Lambda only gates *minting*. A cached key for someone the
  janitor deactivated simply fails at the gateway.
- **A brief Lambda outage does not interrupt existing sessions.** A container
  with a cached key keeps working; only a cold cache needs the function.
- **The live-SSO gate applies at mint time only.** A lapsed AWS session does
  not cut off the holder of a cached key, because the credential that matters
  is the gateway key. Revocation is Bifrost-side `is_active` plus the janitor,
  which is the design and not a gap: a `WorkbenchAccess` session lasts up to 12
  hours (`PT12H` in `deploy/components/identity-center.ts`), far longer than the
  janitor's hour, so "the session will expire" was never going to be a
  revocation mechanism — and the mint's live membership check (decision 1) is
  what closes the re-mint path a live session would otherwise leave open.

**Rejected alternative: export the key into the environment at session start.**
It never updates mid-session, so a recreated key or a reactivation is invisible
until the container restarts, and it leaks into the environment of every child
process — an agent that runs `env` in a tool call has printed its owner's key.
The command form keeps the key in one file the process that needs it reads.

**One naming thing to settle in the `gp-pi` PR.** Inside the container there is
no `gp-pi` executable: the launcher `bin/gp-pi` is a host-side script, and the
image's own helpers are `etc/gp-delegate` and `etc/gp-connect` copied to
`/usr/local/bin`. So `gp-pi bifrost-key` as written is the design's name for
the interface, and the implementer either adds a small `gp-pi` dispatcher to the
image or names the helper `gp-bifrost-key` in the repo's existing idiom. Either
way the `models.json` entry names whichever exists; recorded as an open item,
not decided here.

### 8. Caveats, stated honestly

- **A key belongs to a person, not a machine.** An engineer who copies their
  own key to a laptop, a CI job or another container is undetectable, and that
  is fine: the key's purpose is attribution and a per-person gate on access,
  not a boundary against the person it was issued to. The number is only wrong
  if someone deliberately misuses their own key, and the misuse is theirs.
- **A person's cost is only as good as the one-key-per-person rule.** One key
  per person is the anti-goal above; the moment a person holds two, the
  per-person number is split and the total is only recoverable by summing what
  is left. Nothing enforces it, so the janitor's marker and the description are
  what let a human notice.

## How it fits together

```
   engineer's container (WorkbenchAccess, session name = email)
   ┌──────────────────────────────────────────────────────────────────────┐
   │  pi ── models.json apiKey "!gp-pi bifrost-key"                       │
   │        │                                                             │
   │        ▼                                                             │
   │  gp-pi bifrost-key ── cache 600 on gp-pi-home (email, key, fetched)  │
   │        │ cold: sts:GetCallerIdentity, then SigV4 POST                │
   └────────┼─────────────────────────────────────────────────────────────┘
            │
            ▼  Function URL, AuthType AWS_IAM (public endpoint, signed caller)
   workbench account ┌────────────────────────────────────────────────┐
                     │ vk-mint Lambda  (in the gateway's private VPC) │
                     │  X-Bifrost-Setup-Token from bifrost/gateway    │
                     │  read-only role -> identity store (Engineers)  │
                     └───────────────┬────────────────────────────────┘
                                     │ http://bifrost.workbench.local:8080/api/governance/virtual-keys
                                     ▼
                     ┌────────────────────────────────────────────────┐
                     │ Bifrost task (8080) ──> Bedrock as bifrost-task│
                     └────────────────────────────────────────────────┘
```

**First call, cold cache.**

1. Pi evaluates `apiKey`, runs `gp-pi bifrost-key`.
2. The command finds no fresh cache entry, takes the lock, and asks
   `sts:GetCallerIdentity` who it is.
3. It exports the session's credentials and `POST`s (SigV4) to the function URL.
4. The Lambda verifies the `userArn` is `AWSReservedSSO_WorkbenchAccess_*` in
   the workbench account, takes the session name as the email, and **ignores
   the request body**.
5. It checks that email against the group: `GetUserId` on `emails.value`, then
   the group's memberships through the read-only role. Not a member is a `403`;
   a directory read that fails is a `503`; neither one mints.
6. It searches the gateway for that exact name; if a key exists and is
   inactive, it reactivates it and returns it; if none exists, it creates one
   from the template and returns the created key. A `409` on create means
   another call won the race, so it re-reads and returns that key.
7. The Lambda returns `{ "key": "sk-bf-…", "email": "…" }` and logs neither.
8. The command writes the cache `600`, prints the key, and exits.
9. Pi sends the request to `/v1` with that key; Bifrost checks `is_active` and
   the key's provider allowlist, and invokes Bedrock as the task role.

**Later calls, warm cache.**

1. Pi runs `gp-pi bifrost-key`.
2. The command reads the cache, confirms the email still matches the SSO
   identity (a cached `GetCallerIdentity` result for a few minutes), confirms
   the entry is under 12 hours old, prints the key.
3. No Lambda call, and no network call at all on the common path.

**The janitor, hourly.**

1. EventBridge invokes the janitor Lambda.
2. It assumes the read-only role in the management account — the same role the
   mint uses (decision 2).
3. `ListGroupMemberships` on `Engineers`, every page; the user ids are the
   member set.
4. It reads the gateway's keys (`GET /api/governance/virtual-keys`, `export`
   for one large page) and keeps the ones with the description marker.
5. For each managed key it resolves the owner email to a user id with
   `GetUserId` on `emails.value`, and checks the member set.
6. A key whose owner is not a member **and which is still active** gets one
   `PUT`: `is_active: false`, `expires_at: now + 90 days`,
   `delete_after_expire: true`. A key that is already inactive with an expiry
   set is skipped, so an hourly run does not restart the 90-day clock.
7. Nothing else is touched, and a failed or empty group read means no writes.

## The key, as the Lambda sends it

```json
{
  "name": "jeff@goodparty.org",
  "description": "<marker> per-user key, minted from Identity Center membership",
  "team_id": "<engineering team id, phase 2 item 14>",
  "is_active": true,
  "provider_configs": [
    { "provider": "bedrock",   "allowed_models": ["…"], "key_ids": ["*"] },
    { "provider": "fireworks", "allowed_models": ["…"], "key_ids": ["*"] }
  ]
}
```

The model lists are the gateway's own, copied by the template test from
`deploy-workbench/bifrost/config.json`; the team is the one item 14 creates.
There is deliberately no `budgets` or `rate_limit` entry (decision 5): adding
one later is adding a field here.

## Deferred, recorded and not designed

- **Per-person tier expression.** "Who may use the higher-grade models" is a
  decision the engineer chose to skip for pass one, and it is recorded here as
  an open decision rather than an oversight. The data model already supports
  it: a tier *is* a key's `provider_configs` (and, when budgets come back, its
  budget), so a second template plus a mapping from group membership to
  template is the whole mechanism, and the Lambda would pick the template from
  the group that admitted the caller. The two candidate shapes are a second
  Identity Center group (tiers as membership, one more group to maintain, no
  per-person state) and an edited per-person record (tiers as data, one row per
  exception, no new group). Both are compatible with everything above; neither
  is designed here.
- **Per-key budgets and rate limits.** Decided in review on this PR to skip them
  for pass one: AWS and Fireworks already impose provider-level limits that act
  as the stopgap, and a per-person number chosen before there is any usage data
  is a guess that can starve a person mid-task as easily as catch a runaway.
  **What this costs is real and worth knowing:** the key gives attribution and
  no cap, so a runaway loop spends the team's provider quota rather than
  tripping a gateway limit, and the account budget alerts rather than binds.
  Coming back is cheap — `budgets` and `rate_limit` are fields on the key's
  template (decision 5) and the key is already attributable, which is what
  makes a number possible to choose from evidence rather than by guessing.
- **Scheduled rotation.** The endpoints exist at the pinned tag —
  `POST /api/governance/virtual-keys/{vk_id}/rotate` and the bulk
  `POST /api/governance/virtual-keys/rotate` — and a rotated key keeps its
  previous value valid for a grace window (`previous_value_expires_at`, with
  the cooldown in `client.vk_rotation_cooldown`) so a harness holding the old
  value does not break mid-request. Adding rotation later is therefore a
  schedule and a call, not a redesign; what it would need from this design is
  the cache to notice, which is what the 12-hour TTL and `--refresh` are for.
- **Non-engineer onboarding.** Design-shaped for it, not designed: a second
  group (or an edited record) is the whole change, and no code path names
  "engineer".
- **Non-human callers.** A CI job or a shared worker is not a person, so its
  key has no owner to attribute to and no group to revoke by. One key per
  person is the rule; a non-human caller is a separate decision with its own
  attribution story, deliberately not smuggled into this one.

## What this is not

- **Not a security boundary against the person it issues to.** See caveat 1.
- **Not a replacement for `WorkbenchAccess`.** The gateway's Bedrock IAM stays
  the task role's; this only decides which models a person's key may reach.
- **Not a per-request check of group membership.** Membership is checked when a
  key is minted, `is_active` is checked on every request, and the janitor
  reconciles the two hourly. The gateway itself knows nothing about the group.

## Implementation plan

One step per pull request. A PR names this plan and its step in its body, each
on its own line, the way `plan-gated-merges.md` decides:

```
Plan: docs/bifrost-virtual-keys.md
Step: 2
```

1. **The default template, as data.** A committed JSON template beside the
   mint Lambda, with the test that pins it to
   `deploy-workbench/bifrost/config.json`'s model lists. No infrastructure, no
   code path — reviewable on its own. It carries no budget or rate limit
   (decision 5).
2. **The read-only membership role.** In `deploy/`: `bifrost-vk-reader`, a
   management-account role trusting the two workbench Lambdas' roles by
   account-root-plus-`aws:PrincipalArn`, in the shape of
   `deploy/components/identity-group-sync-grant.ts`. Two actions and no
   writing: `GetUserId` on `emails.value` and `ListGroupMemberships` on the
   `Engineers` group. **Both Lambdas depend on it** (3 and 5): without it they
   fail closed with `AccessDenied`, which is safe and noisy. It can land
   before, after or at the same time as either function, because the trust and
   the ARNs are literals.
3. **The mint Lambda.** In `deploy-workbench/`: the function, its execution
   role (`sts:AssumeRole` on step 2's role), the Function URL with
   `AuthType: AWS_IAM`, its VPC attachment to the private subnets, its own
   security group, the new ingress rule on `bifrostTaskSecurityGroup` for 8080,
   a private Cloud Map name for the task (`workbench.local` namespace, `bifrost`
   service, A records registered by the ECS service, so the function calls
   `http://bifrost.workbench.local:8080` rather than an address that changes on
   every deploy), the SSM-backed template, the read grant on `bifrost/gateway`
   (or a dedicated `bifrost/vk-mint`, per the open item), the log group, the
   membership check, and the idempotency logic with its unit tests
   (exact-match filter, reactivation that also clears `expires_at` and
   `delete_after_expire`, `409`-then-reread, a non-member refused, a directory
   read error refused).
   **Depends on steps 1 and 2 and the gateway being deployed**; the network
   path is the thing to prove first, because everything else is ordinary.
4. **The invoke grant for people.** In `deploy/`: `WorkbenchAccess` gets
   `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the function ARN
   with the `FunctionUrlAuthType` and `InvokedViaFunctionUrl` conditions, and
   the test that pins the absence of a bare `InvokeFunction`. **Depends on step
   3 existing** (the ARN is a literal, so the two applies may land in either
   order; the permission is useless until the function does). This is the step
   that lets a person reach the mint at all, and the one that needs a human's
   sign-off, because it is an identity-policy change.
5. **The janitor.** The Lambda plus its hourly `EventBridge` rule in
   `deploy-workbench/`, assuming step 2's read-only role. **Depends on step 2**;
   before it the first run is an `AccessDenied` that does nothing (fail closed),
   so the two may land in either order and the schedule absorbs the race.
6. **`gp-pi bifrost-key` and the `models.json` entry**, in
   `thegoodparty/gp-pi`: the command, the cache, the lock, the identity check,
   `--refresh`, and the provider entry. **Depends on steps 3 and 4** — before
   them there is nothing to call or no permission to call it. It also settles
   the command's name in the image, per decision 7.

## Cited so the next session can check

In Bifrost, at the pinned tag `transports/v2.3.0`:

| Fact | Source |
| --- | --- |
| A key's plaintext `value` is returned by the list API | `framework/configstore/tables/virtualkey.go`, `TableVirtualKey.MarshalJSON` (value emitted as a resolved plain string) |
| Key names are unique; an inactive key keeps its name; `is_active` nil means true | same file, `idx_virtual_key_name` on `Name`, `IsActive`/`IsActiveValue` |
| `expires_at`, `delete_after_expire`, and a daily cleanup job that deletes expired keys | `transports/config.schema.json` (`client.delete_expired_virtual_keys`, virtual-key `delete_after_expire`) |
| Search is a case-insensitive substring over name, team name and customer name | `framework/configstore/rdb.go`, `VirtualKeySearchConditions` and `VirtualKeySearchTerm` |
| The virtual-key routes | `transports/bifrost-http/handlers/governance.go`, route table at lines 1806–1814 |
| Create body and response; duplicate name is `409` | same file, `CreateVirtualKeyRequest` (~371) and `createVirtualKey` (~2067); the response is `{"virtual_key": …}` |
| A create is live immediately | same handler, `h.governanceManager.ReloadVirtualKey` before it answers |
| Provider config with no keys allows none; `"*"` allows all | `framework/configstore/tables/virtualkey.go`, `TableVirtualKeyProviderConfig` (`AllowAllKeys`, `Keys`) |
| Update accepts `is_active`, `expires_at`, `delete_after_expire` (tri-state; an empty `expires_at` clears the expiry, a null `delete_after_expire` returns to inheriting) | `transports/bifrost-http/handlers/governance.go`, `UpdateVirtualKeyRequest` (~426) |
| Rotation endpoints and the previous-value grace window | routes 1808 and 1811; `PreviousValue`, `PreviousValueExpiresAt`, `HasActivePreviousValue` in `virtualkey.go` |
| The OSS setup lock needs `X-Bifrost-Setup-Token` on non-public `/api` calls | `transports/bifrost-http/handlers/middlewares.go`, `SetupLockMiddleware`; `bifrost-gateway.md`, "Protecting the admin surface" |

Everything else:

| Fact | Where to check |
| --- | --- |
| The caller's ARN is `assumed-role/AWSReservedSSO_WorkbenchAccess_<hash>/<email>` | verified in this container with `aws sts get-caller-identity` |
| A Function URL with `AWS_IAM` passes the caller in `requestContext.authorizer.iam` (`userArn`, `callerId`, `accountId`) | AWS Lambda docs, "Invoking Lambda function URLs" (payload format 2.0) |
| A same-account caller needs **both** `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` | AWS Lambda docs, "Control access to Lambda function URLs" |
| The `Engineers` group id and the `WorkbenchAccess` assignment | `deploy/components/identity-center.ts` |
| `engineering@goodparty.org` mirrors `Engineers` on a 15-minute interval | `docs/google-group-sync.md`; `deploy-infrastructure/group-sync/config.ts` (`POLL_INTERVAL_SECONDS`) |
| The cross-account Identity Store read pattern and its action set | `deploy/components/identity-group-sync-grant.ts` |
| A task's inbound rules today: 8080 and 4180 from the ALB only | `deploy-workbench/network.ts` |
| Pi runs `apiKey: "!command"` at request time and does not cache it | Pi's `docs/models.md`, "Configure a compatible endpoint" |
| Pi's provider entry shape (`baseUrl`, `api`, `apiKey`) | same page, the Ollama example |
| The local SSO cache carries no user identity | `~/.aws/sso/cache/*.json` keys: `startUrl`, `region`, `accessToken`, `expiresAt`, `clientId`, `clientSecret`, `refreshToken`; `~/.aws/cli/cache/*.json` carries credentials, `Expiration`, `AccountId` |
| The image's helper-command idiom: `etc/gp-*` copied to `/usr/local/bin` | `thegoodparty/gp-pi`, `Dockerfile`, `etc/gp-delegate`, `etc/gp-connect` |
| The gateway is live: `/health` `200`, unauthenticated `/v1/models` `401` | checked from this container |

## Open items, and what is not yet verified

1. **The Lambda-to-Bifrost network path.** Not verified, and step 3 cannot land
   without it. To check: that a Lambda attached to the gateway's private
   subnets can open 8080 on the task (a new ingress rule on
   `bifrostTaskSecurityGroup`, and the task's own egress already allows what it
   needs), that the private subnets' NAT gives the function Secrets Manager and
   CloudWatch Logs, and that the gateway accepts a `GET /api/governance/virtual-keys`
   with the setup token over that path. The way to find out is a one-off
   invocation of a hello-world function with the real security groups, not a
   reading of the route table.
2. **The create call against the deployed gateway.** The request and response
   shapes are read from the pinned source and recorded above; nobody has
   exercised them against `bifrost.workbench.goodparty.org`. Step 3 proves
   three things with a hand-written request before the code depends on them:
   the `409` on a duplicate name, that a created key authenticates against
   `/v1` immediately, and that `key_ids: ["*"]` is what makes a pinned
   `provider_configs` entry usable.
3. **The janitor interval.** Hourly is this document's choice. It is worth
   revisiting if the gateway's request logs show a revoked key still being used
   after an hour, or if the janitor's own runs turn out to be the noisiest
   thing in the account.
4. **Which secret the mint Lambda reads.** `bifrost/gateway` is one read grant
   and one copy of the token, but it also makes the encryption key and the
   Fireworks key readable by the function. A dedicated `bifrost/vk-mint`
   container holding only `BIFROST_SETUP_TOKEN` closes that at the cost of a
   second copy. The engineer's call; the design works either way.
5. **The command's name inside the container.** `gp-pi bifrost-key` is the
   design's name for the interface; the image has no `gp-pi` executable, so
   decision 7's two options are a new dispatcher or the `gp-bifrost-key` idiom.
   Settled in the `gp-pi` PR, not here.
6. **A user whose `userName` is not their email.** The session name is the
   Identity Center `userName`, and in this identity store that is the email
   (`deploy-infrastructure/group-sync/identity.ts` creates users that way), so
   the key name and the janitor's `GetUserId(emails.value)` lookup agree. If a
   future identity has a `userName` that is not its email, that person mints a
   key the janitor cannot match and it is deactivated on the next run — wrong
   for them, fail-closed for the design. Worth a one-line guard or a note in
   the janitor when a name does not resolve.
