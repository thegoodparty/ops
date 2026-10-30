# Zero-downtime Bifrost deploys: a config store per colour

> This is the plan for taking the gateway out of a deploy, which is a different
> problem from making it highly available: it is one serving task before and
> after, with a brief second task while the replacement is promoted. It extends
> [`bifrost-gateway.md`](./bifrost-gateway.md), the gateway's plan, and assumes
> the task definition, service and database that plan describes. It changes no
> code and no infrastructure. A PR that implements a step of it names this
> document and the step in its body; progress is derived from those PRs and is
> not written here (decision 11 of
> [`plan-gated-merges.md`](./plan-gated-merges.md)).

Every deploy of the gateway is an outage measured in minutes. The one measured
end to end in `deploy-workbench/ingress.ts` took seven and a half minutes, and
shortening the target group's then-default 300-second deregistration delay to
30 removed four and a half of them; the rest is the boot and the promotion, and
no constant lowers it without the overlap this document is about. The service
is stop-before-start on purpose, and the reason it is stopped before it is
started
is the one thing about OSS Bifrost that cannot be worked around: it holds
provider config, virtual keys, budgets and usage in memory, and two processes
sharing one config store do not share that state — they overwrite each other's
numbers in it.

The fix is not to make two nodes safe. It is to stop sharing the thing that
they overwrite, and to make the migration race disappear rather than manage it:
each deploy gets its own copy of the config store, the outgoing task keeps
serving on the old one until the new one is healthy, and the copy means the new
task's startup migrations never touch the schema the old task is running
against.

## Objective and success criteria

Deploy the gateway without a failed request, without giving up the single-node
invariant that keeps its state coherent.

Success, in the order it should be proven:

1. **A deploy answers requests throughout.** An inference call made every two
   seconds across a deploy — through the promotion of the replacement task, the
   store migrations on the fresh copy, and the drain of the old task — never
   gets a `503` from the ALB
   and never gets a connection reset. The existing rollout is the baseline:
   `DEPLOYMENT_MINIMUM_HEALTHY_PERCENT = 0` with
   `DEPLOYMENT_MAXIMUM_PERCENT = 100` in `deploy-workbench/ecs.ts` drains the
   only task before starting its replacement, and the constant's own comment
   records the shape of the gap: seven and a half minutes end to end on
   2026-10-26, of which the target group's then-default 300-second
   deregistration delay was the largest single term, and `ingress.ts` records
   that shortening it removed four and a half of those minutes.
2. **A bad image rolls back by itself.** A task definition that cannot become
   healthy returns the service to the previous revision with no human, which is
   `deploymentCircuitBreaker { enable: true, rollback: true }` and does not
   exist today.
3. **A rollback of a good deploy is a repoint.** Repointing the service at the
   previous colour's database restores the previous running state in one apply,
   without a snapshot restore and without losing usage recorded since the
   deploy. The gateway plan's current rollback rule is the RDS snapshot, which
   is slower and loses everything since it was taken.
4. **Budgets and keys survive it.** A virtual key that existed before the deploy
   works after it, and its recorded usage is the usage it had before the
   deploy, carried across by the seed. Nothing is re-minted as part of a
   deploy.
5. **A key minted during the window is recovered automatically.** If the key is
   minted into the outgoing colour inside the window and disappears with it, a
   `gp-pi` session recovers in the same turn with no user action (see
   "Client-side recovery from the overlap window").
6. **The schema is never migrated underneath a serving task.** The startup
   migrations for a new image run against a copy, never against the database a
   running task has open.

Explicitly not a success criterion: high availability. There is one serving
task at steady state. A deploy briefly runs two, which is a property of the
deployment and not of the topology.

## What makes the obvious fix unsafe

Flipping to `minimumHealthyPercent: 100` / `maximumPercent: 200` against the
current single config store is the change that is obviously wrong and
occasionally tempting, and the reason is worth recording before the fix that
replaces it:

- **Usage is loaded once and written back as an absolute number.** A node loads
  budgets into memory at startup and never re-reads them. The usage tracker's
  periodic pass calls `DumpBudgets(ctx, nil)`
  (`plugins/governance/tracker.go`, on a `workerInterval` of `10 * time.Second`)
  and `snapshotBudgetRows` turns each in-memory budget into a row whose
  `CurrentUsage` is that node's own number
  (`plugins/governance/store.go`); `writeBudgetBatch` then writes
  `current_usage` from those values. It is a snapshot assignment, not an
  increment, so the last writer wins outright.
- **Enforcement reads the same in-memory number.** `CheckBudget` compares
  `budget.CurrentUsage + baseline` against the limit. The baseline is the
  cross-node term, and nothing in the OSS tree fills it: `framework/kvstore`
  describes its `SyncDelegate` as the "cluster sync" hook, `SetDelegate` has no
  caller outside tests, and every in-tree `CheckBudgets` / `DumpBudgets` call
  passes `nil` (`plugins/governance/resolver.go`, `tracker.go`,
  `store.go`). There is therefore no reconciliation
  between two OSS nodes — the arithmetic that would combine their views is the
  enterprise path, and the OSS tree has no caller for it.
- **The consequence is not drift, it is a key that can overspend.** Two nodes
  alternately overwrite the same `current_usage` with their own smaller numbers,
  so the persisted total falls back to whichever node dumped last while both
  keep admitting requests against their own memory. The write is guarded on
  `last_reset` so an operator reset cannot be undone, and a deadlock between
  concurrent dumpers is retried; neither of those combines two nodes' usage.
  A prior investigation reached the same conclusion, and the two paragraphs
  above are the code it rests on.
- **The schema is migrated at startup.** Bifrost runs its config-store
  migrations every time a process starts (`framework/configstore/migrations.go`,
  a serialized `pg_advisory_lock`). An overlap without a copy means the new
  process runs a migration on the same database the old process is using, which
  is the second half of "multiple OSS nodes with Postgres is not supported"
  (`docs/deployment-guides/how-to/multinode.mdx` at the pinned tag, quoted in
  the gateway plan under "One node, because OSS is one node").

So the invariant to keep is *one writer per config store*, and the way to keep
it while two tasks exist is to give each task its own store.

## The design

Split by lifetime, not by process.

### `logs_store` stays shared and continuous

The log store never needed to be single-writer. At the pinned tag it is built
for concurrent writers: rows are appended, schema changes are taken under an
advisory lock keyed apart from the config store's
(`framework/logstore/migrations.go`: `migrationAdvisoryLockKey = 1000011`
against `framework/configstore/migrations.go`: `1000001`), and background
writers consult a maintenance gate so a migration on one node does not queue
every other node's appends behind an `ALTER TABLE`
(`framework/logstore/maintenancegate.go`, and the batch writer's pause in
`plugins/logging/main.go`). Two colours logging into the same database is the
case that code is written for, and a task replacement changes nothing about it.

So `logs_store` keeps pointing at the existing database for the whole of this
design, and it is the one store whose `db_name` does not follow the colour.

Two things about the pair change, and both are harmless — recorded so the next
reader does not think they were missed:

- **The config store's materialized-view pause becomes a no-op.**
  `configstore` passes the log store's `migration_matview_cancel_after` into its
  own migrations because "the config store usually shares its database with the
  log store" (`framework/configstore/storeoptions.go`,
  `WithMigrationMatViewPause`). Once they are in different databases, the config
  store's migration has no views to pause. It stays as it is; it is a lock on a
  database with nothing behind it.
- **The distributed locker stays unused, which is the SQL case already.** Only a
  ClickHouse log store takes the config store as a distributed lock
  (`transports/bifrost-http/lib/config.go`, `attachWarpHistoryLock`); the SQL
  stores use row locks. This deployment uses Postgres, so the split does not
  reach that path. It is the one place the split would matter if the log store
  ever moved to ClickHouse: two colours would then be locking on two different
  databases and stop serializing each other, so that migration would have to
  keep the lock on a shared database (or pick a different one) rather than
  following the colour.

### `config_store` becomes per-colour

Two databases on the existing instance — `bifrost_blue` and `bifrost_green` —
and the task definition names one of them. Both live on the single
`db.t4g.micro` from `deploy-workbench/rds.ts`
(`DATABASE_INSTANCE_CLASS = aws.rds.InstanceType.T4G_Micro`, 20 GiB gp3,
single-AZ, PostgreSQL 16), because the store's `db_name` is the only thing
that has to differ: `config_store.config.db_name` and
`logs_store.config.db_name` are separate `env.` references in
`deploy-workbench/bifrost/config.json`, and nothing validates one against the
other (the two `type` enums are independent — `sqlite | postgres` for the
config store, `sqlite | postgres | clickhouse` for the log store — in
`transports/config.schema.json` at the pinned tag). There is
no second instance, no read replica and no promotion step, because there is no
second *database server* involved.

The colour reaches the container as a plain environment variable in the task
definition. `PG_DATABASE` already exists there
(`PG_DATABASE_ENV_NAME` in `deploy-workbench/ecs.ts`, injected as
`value: DATABASE_NAME`), and today both stores in `config.json` resolve it
(`config.test.ts` asserts `db_name === "env.PG_DATABASE"` for both).

### A deploy, in order

1. **Seed the inactive database from the active one.** A consistent dump of the
   active colour's config store, restored into the inactive database. For the
   first flip the source is the existing `bifrost` database, which is the only
   one that exists.
2. **Point a new task definition at the seeded database** and update the
   service. The colour is an environment value, so this registers a new task
   definition revision and the service rolls.
3. **The scheduler starts the new task** while the old one is still serving,
   because `minimumHealthyPercent: 100` / `maximumPercent: 200` permits one
   extra task at `desiredCount: 1`. The new task's startup migrations run
   against the copy.
4. **The ALB promotes the new task** after the target group's two successes
   (`TARGET_GROUP_HEALTHY_THRESHOLD = 2` at
   `TARGET_GROUP_HEALTH_CHECK_INTERVAL_SECONDS = 10` in
   `deploy-workbench/ingress.ts`), and ECS ignores its failures until
   `BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS` (160, derived in `ecs.ts` and
   pinned by a test) has passed.
5. **ECS deregisters the old task**, which keeps serving the connections it has
   for `TARGET_GROUP_DEREGISTRATION_DELAY_SECONDS = 30`, then stops it. Its
   shutdown takes a final `DumpBudgets(context.Background(), nil)` in the
   governance plugin's cleanup (`plugins/governance/tracker.go`, called from
   `core/bifrost.go`), which is the last write to the old colour's database.
6. **The old database is kept for one cycle** as the rollback, then dropped at
   the next deploy.

The migration race stops existing at step 3: the new schema is applied to a
database the old task has never opened, so there is no sequence of two
migrations against one schema, and no downgrade to plan for when the old task
keeps running on the old one.

### Rollback

Repoint the service at the previous colour's database, which is untouched at
the schema it was serving. That is a task-definition change and a service
update, and it is faster than the snapshot restore the gateway plan names today
("Upgrade": snapshot, new task definition, watch `/health`; rollback is the
previous digest plus the snapshot if the schema moved), and it loses less: the
snapshot is as of the last automated backup, the old database is as of the
moment the old task stopped.

The direction is deliberately asymmetric and worth stating as a rule:

| Operation | Direction | What it costs |
|---|---|---|
| Deploy | seed inactive from active | the old colour's writes after the seed, until it drains |
| Rollback | repoint at the previous colour | what was written into the new colour since the seed |

A rollback therefore loses anything minted into the new colour since the seed —
symmetrically to what a deploy loses. It works only while the previous colour's
database exists, which is why it is kept for one cycle. After it is dropped, the
rollback is the RDS snapshot again.

### Consequences, stated rather than buried

- **The config store is eventually consistent across a colour swap.** Any write
  to the old colour between the seed and its drain is lost: the seed happened
  before it, and the old database is dropped a cycle later. The window runs from
  the start of the seed to the old task's stop, so it includes the dump itself
  (whose length is open item 8), and then — by the constants above — roughly
  a minute to a minute and a half: the new task's boot (23.1s measured on
  2026-10-26 for an empty store, and this is a copy of a populated one), the
  target group's promotion window (about 20s), and the deregistration delay
  (30s). Everything but the dump is arithmetic from the constants, and none of
  it is a measurement.
- **There is one writer today, and one is enough to care about.** The vk-mint
  Lambda creates a virtual key in the store at runtime, not in
  `deploy-workbench/bifrost/config.json` (whose `governance` block holds only
  `auth_config`), so a key minted inside the window can be lost. What a lost key
  costs is one failed request and a re-mint, and "Client-side recovery from the
  overlap window" is the cure.
- **Spend during the overlap is under-counted, permanently.** The new colour's
  usage starts at the seed and never learns what the old colour spent before it
  drained, because the next seed reads the new colour. The under-count is
  bounded by the same window. Nothing enforces a budget today — per-key budgets
  and rate limits were dropped by agreement on #404, and the account budget is
  the only cap (`bifrost-gateway.md`, "Budgets and alerts") — so this is a
  number to know rather than one to act on, and it becomes load-bearing in the
  same PR that brings budgets back.
- **The copy carries the claim state, so nothing re-claims.**
  `deploy-workbench/bifrost/bootstrap.sh` runs in a one-shot container on every
  task start and does nothing when the store already has an admin account with
  auth disabled — which the copy does, because it is a copy. The overlap
  therefore does not put two claim attempts against anything.
- **Both colours mix in the shared log store.** Request records from the old and
  new task land in one `logs` database with no colour column, which is what
  makes "which node served this" unanswerable from the logs alone. It is
  already true across a replacement today, so it is not a regression; if it
  matters, the log store's `selected_key_id` and the task's log stream are the
  nearest answer.
- **The old colour is a second copy of sensitive state for one cycle.** Virtual
  keys, provider keys and the encryption key's ciphertext exist twice on the
  same encrypted instance. The window is one cycle and the copy is
  access-controlled by the same security group as the original
  (`deploy-workbench/network.ts`: 5432 from the task group only), but it is a
  copy and the plan should say so rather than let a reader find it.

## Decisions

Each decision carries the alternative that was rejected, so a later reader can
see what was considered rather than re-deriving it.

### 1. Split the stores by lifetime, not the whole service

`logs_store` shared, `config_store` per colour. The rejected alternative is the
symmetric one — a per-colour database for both stores — which would fork the
request log at every deploy, break "who spent what" across a colour boundary,
and pay a copy for a store that is already multi-writer safe. It also gives up
the one place where two nodes are demonstrably fine.

The other rejected alternative is a per-colour *instance*: a second RDS
instance, or a read replica promoted at cutover. It buys nothing the database
name does not, triples the monthly cost, and adds a promotion step that can
fail mid-deploy — the exact class of failure this design removes.

### 2. Two databases on the existing instance, never two processes on one

`bifrost_blue` and `bifrost_green`, both on the single `db.t4g.micro`. The
invariant is preserved in the form that matters: one writer per config store.
Two processes stay unsupported, and are only briefly two processes.

Rejected: two tasks against one store with `maximumPercent: 200` and no copy
(unsafe for the reasons in "What makes the obvious fix unsafe"); and a shared
store with a per-colour table prefix or schema, which Bifrost cannot express —
the store's identity is `db_name` and there is no table-prefix setting in
`transports/config.schema.json`.

### 3. Seed, never migrate in place

The inactive database is created from the active one before the new task
starts. Rejected: letting the new task migrate the shared schema and accepting
an overlap, which is the race this design exists to delete; and a blue/green
deployment with ECS's `CODE_DEPLOY` controller, which would still put two
processes on one config store unless the store were split anyway, so it moves
the problem rather than solving it.

`CREATE DATABASE bifrost_green TEMPLATE bifrost_blue` is the cheap server-side
copy and is **not usable here**: Postgres refuses it while any session is
connected to the template database, and the template is the database the
serving task has open. A logical dump taken in one repeatable-read transaction
is a consistent snapshot of a database in use, which is what the seed needs; it
is not free, and the copy's size is an open item.

### 4. Rolling update at 100/200, which the copy is what makes safe

`deploymentMinimumHealthyPercent: 100`, `deploymentMaximumPercent: 200`
(`DEPLOYMENT_MINIMUM_HEALTHY_PERCENT` / `DEPLOYMENT_MAXIMUM_PERCENT` in
`deploy-workbench/ecs.ts`, today 0 and 100). The constant's comment block —
which explains the current stop-before-start value and cites the 2026-10-26
seven-and-a-half-minute gap — is rewritten by the same step, because it is the
argument for the value being changed.

Two points that the change must not lose:

- **The single-node invariant moves to the config store.** One writer per store
  is still the rule; what changes is that each task has its own store.
- **Overlap is a deploy window, not a topology.** `desiredCount` stays 1, and
  nothing may scale the service to 2. A second steady-state task is still the
  unsupported configuration.

### 5. `stopTimeout: 120` on the Bifrost container, in the same change

Currently unset, so ECS's default of 30 seconds applies and the container is
`SIGKILL`ed at 30s (AWS's task-definition reference: default 30, maximum 120).
The sequence inside the container after `SIGTERM` is: `fasthttp`'s `Shutdown`
first, which waits for open connections with no deadline of its own, and then a
cleanup goroutine that the server waits up to 30 seconds for
(`transports/bifrost-http/server/server.go`, the `shutdownCtx`), whose last act
is the governance plugin's final budget dump. So the shutdown's own budget is
"however long the drain takes, plus up to 30 seconds", against a hard kill at
30: the two overlap, and a `stopTimeout` equal to the cleanup budget is a final
dump that races its own deadline. The dump is the write the design cannot lose
— it carries everything the old colour earned after its last periodic pass —
so 120, Fargate's maximum, is the value with margin to spare.

Rejected: leaving it at 30 and shortening the cleanup, which would be a change
to Bifrost rather than to this deployment and would still leave the drain and
the cleanup sharing one budget; and a `postStop` hook, which ECS does not
have.

### 6. `deploymentCircuitBreaker { enable: true, rollback: true }`

Absent today, so a revision that cannot become healthy sits the way the
2026-10-26 outage sat — running 0, desired 1 — until a human notices, which
`deploy-workbench/scripts/verify-service.ts` now turns into a red run but does
not fix. The circuit breaker is what makes a failed *colour* survivable: a seed
that produced an unusable copy, or an image whose migrations fail, rolls back to
the previous task definition, which still points at a database that is still
there.

This is why the two knobs are one step and why it lands before the colour
plumbing: without the breaker, the first colour-seed failure is an outage that
needs a human, which is the failure mode this whole design is trying to leave
behind.

Rejected: `deploy-workbench/scripts/verify-service.ts` as the recovery, which is
a detector and cannot roll a service back.

### 7. The colour is a committed, preview-known value

The colour in the task definition must be known at `pulumi preview`, because the
pre-apply secret check fails closed on a preview-unknown `containerDefinitions`
(`deploy-workbench/scripts/preflight-secrets.ts`, and the 2026-10-28 failure,
run 40725087936, the merge of #393, where `BIFROST_CONFIG_VERSION` was fed from
`aws.ssm.Parameter.version`). A colour derived from stack state or an
AWS-assigned output has the same shape of risk: the whole
`containerDefinitions` string becomes Pulumi's unknown sentinel, the preflight
refuses to deploy, and the failure reads as a preflight defect.

So the colour is a value in the program — a `pulumi.Config` entry with a
committed default, or a constant in `deploy-workbench/ecs.ts` — flipped in the
PR that seeds, plus a preflight/unit assertion that the value is one of the two
colours and that the resulting database name is the *inactive* one. Pulumi
cannot know which colour is inactive; the step's own check is that the database
name differs from the one the running task definition names, which is
`deploy-workbench/scripts/verify-service.ts`'s neighbourhood rather than
Pulumi's.

Rejected: deriving the colour from the current service's task definition at
apply time, which is a read of live state during a deploy (the thing
`docs/deploy-role-trust.md` and `docs/pr-previews.md` refuse for secrets, and
the same class of hazard), and deriving it from a stack output, which is
preview-unknown in the case that matters.

### 8. Colours alternate, and the old database survives one cycle

Deploy N seeds the inactive colour from the active one; deploy N+1 does it the
other way. The old database is dropped at the *next* deploy, not at this one,
because it is the rollback. Rejected: dropping it immediately, which makes the
circuit breaker's rollback land on a task definition pointing at a database
that no longer exists — a task that cannot start, which is worse than the
failure it is rolling back from; and keeping every colour forever, which leaves
unbounded copies of key material.

### 9. Rollback by repointing, not by restoring

See "Rollback". Rejected: the snapshot restore the gateway plan currently
describes as the schema rollback. It is still the rollback of last resort —
after the old colour is dropped, or for a change that corrupted both — so the
plan keeps the restore rehearsal (gateway item 23) rather than replacing it.

### 10. A stateless gateway is rejected, and the reason is new

`config_store: false`, with the file as the single source of truth, is the
configuration upstream recommends for OSS multi-node
(`docs/deployment-guides/how-to/multinode.mdx`), and it was considered here.
**It is rejected, and the reason has changed since it was first proposed:** the
database is no longer reconstructible from git plus a secret. Virtual keys are
minted at runtime by the vk-mint Lambda into the config store and are not
declared in `deploy-workbench/bifrost/config.json` — that file's `governance`
block holds only `auth_config`, and the vk-mint template
(`deploy-workbench/bifrost/vk-mint-template.json`) is applied through the admin
API, not the file. A stateless gateway would therefore lose every engineer's key
on every deploy, and every container would have to re-mint on its first turn.

A future reader will otherwise re-propose statelessness, because it is the right
answer for a deployment whose configuration is all in git. It is not the right
answer for one whose configuration is largely written at runtime, and it is
recorded here in that direction on purpose: the earlier reasoning was the
opposite, and it was right about the file and wrong about the database.

### 11. Client-side recovery lives in `gp-pi`, and only heals `gp-pi`

The one write that can be lost in the window is a minted key, so the recovery is
a client that notices its key stopped working and mints again. It is described
in "Client-side recovery from the overlap window". Rejected: making the gateway
or the seed reconcile the two stores, which is the store-side janitor in
decision 13; and treating the window as acceptable with no recovery, which makes
a deploy a thing that breaks a working session for no reason the session can
see.

### 12. One recovery attempt per turn, and nothing in the gateway changes

The extension attempts a re-mint at most once per turn and surfaces the error if
the retry also fails. This is what makes a wrong trigger — a `403` for a reason
that is not a key — cost one failed call instead of a loop, and it is what lets
the trigger set be settled empirically (open item 6) without the design being
unsafe while it is uncertain.

A re-mint is safe to attempt blindly because the mint is the authorisation
decision: the Lambda re-checks `Engineers` membership live on every call and
refuses a non-member with `403`
(`deploy-workbench/bifrost/vk-mint-core.ts`, and decision 1 of
[`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md)). A mis-triggered re-mint
therefore cannot escalate — at worst it is refused, which is the same error the
caller already had.

### 13. The store-side janitor is deliberately not built

"Member without a key → mint", run on a schedule against the config store, was
considered as the store-side half of this and is **not** being built. Three
reasons: it is a second writer during the window, and which colour it writes
to is whichever task the ALB or Cloud Map happens to answer, so it can mint
into the colour that is about to be dropped; a key that is missing from the new
colour is indistinguishable from a key that was never minted, so it would mint
into a store that is about to be replaced; and the client already knows it
failed, which is strictly better information than a periodic sweep has.

It is recorded so it is not re-proposed as an oversight. If it ever is built, it
is a different design, with its own decision about which colour it writes to.

### 14. A deploy-time assertion is optional, not a step

Comparing the virtual-key count before and after cutover was considered and is
**not** part of the steps below. It detects the loss this design accepts, which
is a mint between the seed and the drain — so a count that moved is ambiguous
between "a key was minted and lost" and "a key was minted into the new colour".
It is cheap to add to the next step's verification and it is not worth a step.

### 15. `--refresh` documentation is replaced by the extension

Decision 7 of [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md) records the
current workaround, in its step 6: "A `401` from the gateway cannot be seen by
the command — Pi calls the command before the request — so the gateway's
rejection is answered by documentation: the `401` handling note says to run
`gp-pi bifrost-key --refresh`." The extension in "Client-side
recovery from the overlap window" makes that unnecessary, because the session
notices the rejection itself.

That document is a frozen plan and is not edited here; the edit lands with the
step that implements the extension (step 5), in that step's PR, as an amendment
to a human-owned file.

## Client-side recovery from the overlap window

A key minted into the old colour inside the window does not exist in the new
one. The cure is a small extension in `thegoodparty/gp-pi`. The mechanism below
is pi's own, verified against its source and documentation rather than assumed;
the pi version read was 1.4.0.

### What pi guarantees, and the trap in it

- **`models.json`'s `apiKey: "!command"` runs at request time and is not cached
  by pi.** pi's `docs/models.md`, "Configure a compatible endpoint": "Commands in
  `models.json` run at request time and are not cached by Pi." This is the half
  the recovery depends on: the next request re-runs the helper.
- **`auth.json`'s `key: "!command"` is cached for the process lifetime.** pi's
  `docs/providers.md`, "Load an API key from a command": "Pi runs the command
  when the key is first needed and caches its standard output for the process
  lifetime." **This is a trap worth recording**: moving the gateway key into
  `auth.json` would look tidier and would silently destroy the recovery path,
  because the helper would run once per process and never again. The gateway's
  key lives in `models.json` for this reason and must stay there.
- **`after_provider_response` fires with `{ status, headers }`**, after the
  response arrives and before its body is consumed
  (`AfterProviderResponseEvent` in pi's extension types; `docs/extensions.md`
  places it fifth in the model-request hook order). It is a status the
  extension can act on before the turn is over.
- **`agent_before_settle` can request one final continuation.** It fires before
  final settlement, "may append entries and ensure one next provider request",
  and its result carries `{ entries?, continue? }`
  (`docs/extensions.md`, and `BoundaryResult` in the extension types). One
  `continue: true` is one more provider request in the same turn.
- **pi's auto-retry does not cover `401`.** The agent-level retry is a regex over
  the provider's error text — pi's bundle lists `429|500|502|503|504|520|524`
  and transport phrases such as "connection refused" and "fetch failed", and
  neither `401` nor `403` appears — and it is the one governed by
  `retry.enabled` (`docs/settings.md`, "Network and retries"). The
  provider-level retry, which is off by default (`retry.provider.maxRetries:
  0`), covers `408`, `409`, `429` and `5xx` and still not `401`. So 401
  recovery has to be built rather than inherited, and a design that assumes a
  retry is a design that does nothing.

### The mechanism

1. The extension watches `after_provider_response`. On a status in the trigger
   set, it drops the helper's cached key and records that this turn has spent
   its one attempt.
2. The helper's cache is `~/.pi/agent/bifrost-key.json`, held for 12 hours by
   `gp-bifrost-key`, so "invalidate the cache" is a local operation: delete the
   entry, or run the helper with `--refresh`, which does exactly that. pi does
   not cache the value, so there is nothing else to invalidate.
3. At `agent_before_settle`, if this turn spent an attempt and the failure was
   the key, the extension returns `continue: true`. pi makes one more provider
   request, which re-runs the `apiKey` command, which mints, and the same turn
   completes.
4. If the continuation fails the same way, the error is surfaced and there is no
   second attempt.

Fully automatic, in both interactive and worker sessions, with no user action.
A worker is the case that matters most: it is the one that runs unattended
across a deploy.

The helper's name is not this document's to fix. `models.json`'s `apiKey` names
whichever command the image actually ships — `gp-bifrost-key` today, because
the image has no `gp-pi` dispatcher (open item 5 of
[`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md), settled in that plan's
`gp-pi` step). The extension runs the same command, not a string of its own, and
that is the one detail the implementing step must not spell twice.

### What the trigger set is, and why it is not "401"

The brief's assumption that the trigger is `401` is **incomplete**, and the code
at the pinned tag says exactly what each status means. From
`plugins/governance/main.go` (`decide`, and `refusal`):

| Situation | Status | Error type |
|---|---|---|
| The credential resolves to no key in this store | `401` | `policy_access_denied` |
| The key exists but is inactive or expired | `403` | `policy_access_denied` |
| The model is outside the key's allowlist | `403` | `policy_model_blocked` |
| The provider is outside the key's allowlist | `403` | `policy_provider_blocked` |
| A budget is exhausted | `402` | `policy_budget_exceeded` |
| A rate limit is hit | `429` | `policy_rate_limited` |

A lost key in the window presents as the first row — the key does not exist in
the new store, so it resolves to nothing — and that is the case the recovery
must catch. The second row is also a case a re-mint repairs (the mint
reactivates an inactive key rather than creating a second one, decision 4 of
`bifrost-virtual-keys.md`), and it is safe for the reason in decision 12: a
deactivated key belongs to someone the janitor thinks has left, and the mint
re-checks membership, so the retry is either admitted for a member or refused.

The two model/provider rows are **not** repairable by a re-mint: the mint returns
the same key with the same allowlist, so the retry fails identically. With one
attempt per turn that costs one wasted request and no loop, which is the whole
reason the cap is part of the design rather than a nicety.

What makes this an open item rather than a decision is that
`after_provider_response` carries only `{ status, headers }` — the body, and so
the error type that distinguishes the four `403` cases from each other, is not
available at that hook. Two shapes are viable and the plan does not pick one:
trigger on `401` alone (complete for the failure this design creates, silent for
the rest), or trigger on `{401, 403}` and classify at `message_end`, which sees
the parsed error, with the continuation still requested at `agent_before_settle`.
Open item 6.

### Scope, stated plainly

**This heals `gp-pi` only.** Each key is scoped to the models a harness may
reach and presented by that harness, so Claude Code, Codex and any non-human
caller have no equivalent path. The engineer decided that the other harnesses
find their own solutions, and it is recorded here as a boundary rather than an
oversight: for those harnesses, a key lost in the window is a `401` until the
person runs whatever their tool offers, and the documented answer remains
"re-issue the key".

One more honest bound: **during the overlap the retry can land on the wrong
colour.** Both tasks register into the same Cloud Map service, so
`bifrost.workbench.local` — the name the mint Lambda calls — has two answers
while the old task is still up, and inference through the ALB is balanced
across both. A re-mint issued in that moment may write into the old colour,
succeed, and then fail again on a request that reaches the new one. The
recovery therefore converges once the old colour drains — seconds to a minute
and a half after the seed — and until then a
request may still surface the error. That is the same bound as the window
itself, and it is the reason the overlap should be as short as the constants
allow rather than padded.

## The deployment knobs

Read from the code, not from memory. Two of these are the change; the rest are
already in place and are listed so a later step does not "fix" them again.

| Knob | Where | Now | In this design |
|---|---|---|---|
| `deploymentMinimumHealthyPercent` | `ecs.ts`, `DEPLOYMENT_MINIMUM_HEALTHY_PERCENT` | `0` | `100` |
| `deploymentMaximumPercent` | `ecs.ts`, `DEPLOYMENT_MAXIMUM_PERCENT` | `100` | `200` |
| `stopTimeout` (Bifrost container) | `ecs.ts`, in the container definition | unset → ECS default 30s, `SIGKILL` | `120` (Fargate's maximum) |
| `deploymentCircuitBreaker` | `ecs.ts`, on `aws.ecs.Service` | absent | `{ enable: true, rollback: true }` |
| `healthCheckGracePeriodSeconds` | `ecs.ts`, derived | `160` | unchanged |
| Target-group health check | `ingress.ts` | interval 10s, timeout 5s, healthy 2, unhealthy 3 | unchanged |
| `deregistrationDelay` | `ingress.ts` | `30` | unchanged |
| Config-store `db_name` | `bifrost/config.json` | `env.PG_DATABASE` for both stores | `env.PG_CONFIG_DATABASE`, one per colour |
| Log-store `db_name` | `bifrost/config.json` | `env.PG_DATABASE` | unchanged |

Notes that belong with the table rather than in it:

- **`healthCheckGracePeriodSeconds` is derived, not chosen.**
  `BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS` sums the container check's own
  tolerance (`startPeriod: 90` plus `retries * interval` = 45) with the ALB's
  promotion window (one in-flight timeout of 5 plus `2 * 10`), and
  `deploy-workbench/ecs.test.ts` pins both the value (160) and the sum. Changing
  any target-group timing invalidates that derivation and the test with it, on
  purpose. This design changes none of them.
- **`/health` does not flip on shutdown.** It answers `200` while the process is
  up and pings the config and log stores
  (`transports/bifrost-http/handlers/health.go`); `server.go`'s shutdown path
  does not turn it into a failure signal first. So
  removal from the ALB is **ECS deregistration and nothing else**, and no part of
  this design may rely on a readiness flip to drain a task. That is also why
  `deregistrationDelay` is the drain and why `stopTimeout` has to outlast it.
- **`stopTimeout` sits in a JSON document, not in a typed field.**
  `containerDefinitions` is a single JSON string
  (`pulumi.jsonStringify`) typed by ECS rather than by the Pulumi provider, so
  the TypeScript compiler will not notice a misspelt key. The test that keeps it
  honest is a textual assertion on the container block, the idiom
  `ecs.test.ts` already uses
  (`containerDefinitionBlock("BIFROST_CONTAINER_NAME")`).
- **`deploymentCircuitBreaker` is typed.** `@pulumi/aws` 7.23.0 (the version in
  `package-lock.json`) exposes `deploymentCircuitBreaker` on `aws.ecs.Service`
  as `{ enable, rollback }`, both required, so a missing or misspelt field is a
  compile error rather than a silent omission.

## What this is not

- **Not high availability.** The service is one task at steady state. A deploy
  briefly runs two; anything longer-lived than a deployment is still the
  unsupported multi-node configuration.
- **Not Enterprise clustering.** No gossip, no Raft, no shared in-memory state.
  The state is shared by being copied, once per deploy.
- **Not a general multi-node answer.** Two colours exist to make one handover;
  they are not two replicas and must not be run as one.
- **Not a fix for a schema-breaking upgrade.** Repointing at the previous colour
  undoes a deploy, not a migration that changed the old colour's data. Both
  colours being migrated by the same bad image is the snapshot restore, and the
  restore rehearsal stays.
- **Not a change to how keys are issued.** The mint, the janitor and the key
  template are [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md). This
  document changes where the store they write to lives, and adds a client-side
  recovery for the one write it can lose.
- **Not a solution for harnesses other than `gp-pi`.** See the scope note above.

## Open items

These are recorded, not answered. Each names the check that would settle it.

1. **Where the seed step runs.** The deploy role cannot reach the database: the
   RDS instance is private, its security group admits `5432` from the task's
   group only (`deploy-workbench/network.ts`), and the private route table's
   only route out is the NAT (`network.ts`), which carries no inbound path. So
   the seed is a one-off ECS task in the same cluster, or a VPC-attached Lambda,
   and **neither exists today**. The vk-mint Lambda is the nearest precedent
   (`deploy-workbench/bifrost-vk-mint.ts`: private subnets, its own group, an
   ingress rule on the task group) and a one-off task reusing the task security
   group is the smaller of the two. What settles it is a decision, not a test,
   and it is the step that decides it.
2. **Which image carries the seed's client.** `pg_dump`/`psql` are not in the
   pinned Bifrost image, which is Alpine with a Go binary. The precedent for a
   derived image is `bootstrap-image.ts` plus
   `deploy-workbench/bifrost/bootstrap.Dockerfile`, with a content-addressed tag
   (the same shape as `oauth2-proxy-image.ts`). A Node/pg implementation inside a
   Lambda is the alternative, and it means writing the copy rather than invoking
   a tool that has one. Not decided.
3. **What the seed copies.** A whole-database dump includes the log tables,
   which are the shared store's data and the largest thing on a 20 GiB volume;
   the alternative is to dump the config store's own tables plus the `migrations`
   table (the config store has 66 `TableName()` methods in
   `framework/configstore/tables/`). The two stores' migration IDs are disjoint
   but share one `migrations` table — `framework/migrator/migrator.go`'s
   `DefaultOptions.TableName` — so copying it is what records the copied schema
   as already migrated, which is why the new task's startup run applies only
   what its own image adds. Both shapes are workable; the choice depends on the
   measured size, which nobody has. The seed must also be idempotent, including
   over a database left behind by a failed deploy.
4. **Who creates the inactive database.** `aws.rds.Instance` takes one `dbName`
   at creation time and manages no sub-resources — the Pulumi AWS provider has
   no "database inside an instance" resource — so the second one is created
   by the seed task itself, under the RDS-managed master user. That is a deploy
   step Pulumi does not own, which is worth stating because `pulumi up` will
   look idempotent while the schema and the databases drift. `CREATE DATABASE`
   cannot run inside a transaction and needs `CREATEDB`, which the master user
   has on RDS; the seed's own check is that the database exists and is empty
   before it restores.
5. **Whether the colour can be a preview-known value at all.** See decision 7.
   The design says it must be, and the preflight already fails closed on an
   unknown `containerDefinitions` (`scripts/preflight-secrets.ts`, and the
   2026-10-28 failure). What is not yet shown is that a `pulumi.Config` value
   reaches the container definitions as a known string in every mode, including
   the `DEPLOY_TARGET`-targeted first apply in `deploy-workbench/deploy.sh`. A
   preview with the colour set and the container block printed settles it.
6. **The exact trigger set for client-side recovery.** See "What the trigger set
   is". Confirming it against the gateway means provoking each row of that
   table — a request with a key that does not exist, one with a deactivated
   key, one for a model outside the allowlist — and recording the status and
   error type each returns. That is a step's first task, before the extension is
   written, and it decides whether the extension needs the `message_end` path.
7. **Connection headroom during the overlap.** Each task opens two pools:
   `config_store` with `max_open_conns: 50` and `logs_store` with
   `max_open_conns: 100` (`bifrost/config.json`). During the overlap two tasks
   hold those ceilings at once, and RDS's default `max_connections` for a
   `db.t4g.micro` is on the order of a hundred by AWS's
   `LEAST({DBInstanceClassMemory/9531392},5000)` formula — a formula from
   AWS's documentation, not from this repo, whose divisor is
   `DBInstanceClassMemory` rather than the instance's full memory. The pools
   are ceilings and are unlikely to be reached, but the headroom is small enough
   that the overlap should be measured rather than assumed. Lowering
   `max_open_conns` for the config store, which serves a single active task, is
   the likely answer.
8. **The seed's cost in time.** The dump is of a database whose size nobody has
   measured, into a 20 GiB volume that already holds the log tables. A seed that
   takes longer than the deploy's patience turns the first flip into a long
   window rather than a short one, and it is the one number that could make the
   window an order of magnitude bigger than the estimate above.

## Implementation plan

One step per pull request. A PR names this plan and its step in its body, each
on its own line:

```
Plan: docs/bifrost-zero-downtime-deploys.md
Step: 2
```

The order is the point of the order. The two knobs land first because they are
what makes a later failure survivable; the seed lands before anything can point
at a second database; the colour plumbing lands before the flip; the flip is the
step that changes behaviour; and the client-side recovery lands once there is a
window to recover from.

1. **The two missing knobs.** `stopTimeout: 120` on the Bifrost container and
   `deploymentCircuitBreaker { enable: true, rollback: true }` on the service,
   both in `deploy-workbench/ecs.ts`, with the tests in `ecs.test.ts` that pin
   them (a textual assertion on the container block for `stopTimeout`, since the
   JSON document is untyped; a resource assertion for the breaker). **No change
   to the deployment percentages here** — the 0/100 comment block is rewritten
   by step 4, together with the values it argues for, so the file never
   describes a shape it is not in. Touches `deploy-workbench/ecs.ts` and
   `deploy-workbench/ecs.test.ts` only, and changes no behaviour on a healthy
   deploy: it makes a broken one roll back and a draining one finish its dump.
   Proves: the service returns to the previous revision on an image that cannot
   become healthy, and the Bifrost container is given 120 seconds to shut down.
2. **The seed.** A one-off task that creates the inactive database and copies
   the active config store into it, including `governance_budgets.current_usage`,
   `governance_virtual_keys` and the `migrations` table. Resolves open items
   1–4 and 8 (they are the step's design work: where it runs, what image, what
   it copies, and the measured size). Touches `deploy-workbench/` (a new module,
   a derived image and its repository, a task definition and the IAM its role
   needs) and adds no database client to the gateway image. Nothing calls it in
   this step; it runs by hand, twice, against a scratch database name, and the
   evidence is a diff of row counts and of `governance_budgets.current_usage`
   between source and copy. Proves: the copy is faithful, the server-side
   alternative does not work while the source serves (`TEMPLATE` needs zero
   connections), and the seed is fast enough for the window.
3. **The colour plumbing.** A second environment name for the config store's
   `db_name` (`PG_CONFIG_DATABASE`), the colour in the task definition
   (`BIFROST_COLOUR`), `config.json`'s `config_store.config.db_name` moved to the
   new reference, and the assertions that already guard this seam updated —
   `GATEWAY_PLAIN_ENV_NAMES` and the `PG_DATABASE` assertions in `ecs.ts` and
   `ecs.test.ts`, and the two-store `db_name` test in `bifrost/config.test.ts`
   which currently requires `env.PG_DATABASE` for both. Plus the preflight that
   refuses a colour that is not one of the two, and refuses a colour whose
   database is the one the running task definition names. Touches
   `deploy-workbench/ecs.ts`, `deploy-workbench/ecs.test.ts`,
   `deploy-workbench/bifrost/config.json`,
   `deploy-workbench/bifrost/config.test.ts` and
   `deploy-workbench/scripts/preflight-secrets.ts` (or a sibling check).
   Behaviour is unchanged while the colour is still the existing database.
   Proves: `config.json` resolves its two stores to two different names, the
   logs store does not follow the colour, and a preview-unknown or wrong colour
   fails the run rather than deploying.
4. **The flip.** `DEPLOYMENT_MINIMUM_HEALTHY_PERCENT = 100`,
   `DEPLOYMENT_MAXIMUM_PERCENT = 200`, the comment block rewritten to the
   argument in this document (with the single-writer invariant restated as one
   writer per config store, and the overlap described as a deploy window), and
   the colour moved to the seeded database in the same PR that runs step 2's seed
   as its first action. Also the rollback procedure, written down where an
   operator finds it: repoint the colour at the previous database, and keep it
   for exactly one cycle. Touches `deploy-workbench/ecs.ts`, its test, and the
   operator-facing runbook beside the other runbooks. Proves: a continuous probe
   across a deploy sees no `503` and no reset, the new task's migrations appear
   only in the copy, and a deliberately broken image rolls back on its own.
5. **The `gp-pi` extension.** In `thegoodparty/gp-pi`: the trigger set settled
   against the gateway (open item 6), the `after_provider_response`
   watcher, the one-attempt-per-turn cap, the continuation at
   `agent_before_settle`, the helper's cache invalidation, and the removal of the
   `--refresh` instruction from
   [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md)'s decision 7 — an
   amendment to a frozen, human-owned plan, in this PR because it is this PR's
   change that makes the sentence false. Proves: with a key deleted from the
   active store out of band, a session's next turn recovers with no user action;
   with a model outside the allowlist, the turn fails once and surfaces the error
   with no second attempt.
6. **Housekeeping.** The doc corrections this design makes stale: the gateway
   plan's "Persistence, backup and upgrade" upgrade procedure and its rollback
   rule (it currently says the snapshot is the schema rollback, and that a
   task replacement is a short outage), its "Migration from direct provider
   access, and rollback" section, item 8's entry in its phased task list where
   it explains the stop-before-start value, and any other step entry that
   describes a deploy as an outage. `docs/` is human-owned, so this is a review
   round of its own rather than a rider on an implementation PR. Proves: no
   document in `docs/` still describes a deploy as an outage that the design
   removed.

## Cited so the next session can check

In this repository:

| Fact | Where |
|---|---|
| The service is stop-before-start, and why | `deploy-workbench/ecs.ts`, `DEPLOYMENT_MINIMUM_HEALTHY_PERCENT` / `DEPLOYMENT_MAXIMUM_PERCENT` and the comment above them |
| The grace period is derived and pinned at 160 | `deploy-workbench/ecs.ts`, `BIFROST_HEALTH_CHECK_GRACE_PERIOD_SECONDS`; `deploy-workbench/ecs.test.ts` |
| Target-group timing and the 30s deregistration delay | `deploy-workbench/ingress.ts`, `TARGET_GROUP_*` constants |
| The instance, its class, storage and one `dbName` | `deploy-workbench/rds.ts`, `DATABASE_NAME`, `DATABASE_INSTANCE_CLASS` |
| Both stores resolve the same `db_name`, and the test pins it | `deploy-workbench/bifrost/config.json`; `deploy-workbench/bifrost/config.test.ts` |
| `PG_DATABASE`'s injection and the plain-env allowlist | `deploy-workbench/ecs.ts`, `PG_DATABASE_ENV_NAME`, `GATEWAY_PLAIN_ENV_NAMES`; `deploy-workbench/ecs.test.ts` |
| The preflight fails closed on a preview-unknown container definition | `deploy-workbench/scripts/preflight-secrets.ts`; the 2026-10-28 failure, run 40725087936 |
| The database is reachable only from the task group | `deploy-workbench/network.ts`, the `bifrostDatabaseIngressPostgres` rule and the private route table's NAT-only route |
| A VPC-attached function reaching the task is the existing precedent | `deploy-workbench/bifrost-vk-mint.ts` |
| The mint re-checks membership and refuses a non-member with 403 | `deploy-workbench/bifrost/vk-mint-core.ts` |
| `--refresh` is the current 401 workaround | `docs/bifrost-virtual-keys.md`, decision 7; `thegoodparty/gp-pi`, `etc/gp-bifrost-key` |
| Budgets are deferred; the account budget is the only cap | `docs/bifrost-gateway.md`, "Budgets and alerts" |
| The snapshot is the current rollback rule | `docs/bifrost-gateway.md`, "Persistence, backup and upgrade" |

In Bifrost, at the pinned tag `transports/v2.3.2`:

| Fact | Source |
|---|---|
| `config_store` accepts `sqlite \| postgres`; `logs_store` accepts `sqlite \| postgres \| clickhouse`; nothing cross-validates them | `transports/config.schema.json`, the two `type` enums |
| `db_name` is per store and accepts an `env.` reference | same file, `config_store.config.…properties.db_name`; `framework/postgresconn/postgresconn.go`, `DBName *schemas.SecretVar` |
| Usage is written as an absolute snapshot every 10 seconds | `plugins/governance/tracker.go`, `workerInterval = 10 * time.Second` and `DumpBudgets(ctx, nil)`; `plugins/governance/store.go`, `snapshotBudgetRows` and `writeBudgetBatch` (`current_usage = v.cu`) |
| Enforcement reads the node's own in-memory usage, and every in-tree call passes a `nil` baseline | `plugins/governance/store.go`, `CheckBudget`; `framework/kvstore/kvstore.go`, `SyncDelegate` / `SetDelegate` with no caller outside tests; `plugins/governance/resolver.go` and `tracker.go`, the `nil` arguments |
| The dump is guarded on `last_reset` and retried on deadlock; neither combines two nodes | `plugins/governance/store.go`, `writeBudgetBatch` and `isDumpDeadlock` |
| Log-store migrations are advisory-locked on a different key from the config store's, and background writers pause for them | `framework/logstore/migrations.go` (`1000011`), `framework/configstore/migrations.go` (`1000001`), `framework/logstore/maintenancegate.go` |
| The two stores share one `migrations` table and their step IDs are disjoint | `framework/migrator/migrator.go`, `DefaultOptions.TableName`; the two `migrationStepIDs` lists |
| `/health` pings the stores and does not flip on shutdown | `transports/bifrost-http/handlers/health.go`; `transports/bifrost-http/server/server.go`, `Start` |
| Shutdown drains HTTP first, then waits up to 30 seconds for cleanup, whose last act is the final budget dump | `transports/bifrost-http/server/server.go`, `Start` (`s.Server.Shutdown()`, then the `shutdownCtx`); `core/bifrost.go` → `plugins/governance/main.go` → `tracker.go`, `Cleanup` |
| A missing key is `401`; inactive, model-blocked and provider-blocked are `403`; budget is `402`; rate limit is `429` | `plugins/governance/main.go`, `decide` |
| Migrations run at startup under an advisory lock | `framework/configstore/migrations.go`, `triggerMigrationsWithOptions` |
| `CREATE DATABASE … TEMPLATE` requires no connections to the template | PostgreSQL's `CREATE DATABASE` documentation (AWS-side knowledge, not read from this repo) |
| `stopTimeout` default 30, maximum 120, then `SIGKILL` | AWS ECS task-definition parameters for Fargate |

In pi, version 1.4.0:

| Fact | Source |
|---|---|
| `models.json` commands run at request time and are not cached | pi's `docs/models.md`, "Configure a compatible endpoint" |
| `auth.json` command output is cached for the process lifetime | pi's `docs/providers.md`, "Load an API key from a command" |
| `after_provider_response` fires after the response and before the body is consumed, with `{ status, headers }` | pi's extension types, `AfterProviderResponseEvent`; `docs/extensions.md`, the model-request hook order |
| `agent_before_settle` can request one continuation | pi's extension types, `AgentBeforeSettleEvent` and `BoundaryResult`; `docs/extensions.md` |
| Auto-retry does not cover `401`: the agent-level set is a regex over the error text (`429`, `5xx`, transport phrases) and the provider-level set (`408`, `409`, `429`, `5xx`) is off by default | pi's bundled `RETRYABLE_PROVIDER_ERROR_PATTERN` and `isRetryableProviderError`; `docs/settings.md`, "Network and retries" |
