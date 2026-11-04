# Bifrost: converge the running node instead of replacing it

> This is the plan that replaces
> [`archived/bifrost-zero-downtime-deploys.md`](./archived/bifrost-zero-downtime-deploys.md),
> which proposed a config store per colour, a blue/green task overlap and a seed
> of the inactive database. That approach is rejected here; the archived
> document is kept because it is the evidence for what was considered. This plan
> extends [`bifrost-gateway.md`](./bifrost-gateway.md) and
> [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md), and assumes the task
> definition, service, database, mint Lambda and janitor Lambda those documents
> describe. It changes no code and no infrastructure. A PR that implements a
> step names this document and the step in its body; progress is derived from
> those PRs and is not written here (decision 11 of
> [`plan-gated-merges.md`](./plan-gated-merges.md)):
>
> ```
> Plan: docs/bifrost-reconciler.md
> Step: 3
> ```

The archived plan tried to take the restart window out of a deploy. It could
not do that cheaply. Its design needed a second database per colour, a seed that
copied a committed list of 66 config-store tables
(`framework/configstore/tables/`, 66 `TableName()` methods at the pinned tag)
into it on every deploy, a 100/200 rolling update to run two tasks briefly, and
a client-side key recovery for the writes the overlap could lose. Two of those
are permanent costs and one was never measured: the table list is an obligation
against a dependency Bifrost bumps weekly, and the 503 gap the overlap removed
was arithmetic from constants rather than a measurement. The two-task window it
bought would have moved the invariant from "one task" to "one writer per store",
for a window of about a minute and a half.

The premise of this plan is different. Most restarts are not for an image. They
are for a change to configuration or governance, and those changes can be made
to the process that is already running. At the pinned tag Bifrost exposes enough
of its state through its admin API that a declarative reconciler can converge a
live single node to a committed desired state: providers, keys, the model
catalog, client config and virtual-key governance all apply without a restart,
and each handler reloads the in-memory state before it answers. So the plan
removes the reasons for a restart rather than the restart window. What is left
is image upgrades and a small, named set of boot-only settings, and a restart
for an image upgrade is still an outage. This document does not claim
otherwise.

## Objective and success criteria

Converge one running gateway to the committed desired state, so that a
configuration or governance change needs no service rollover, and state honestly
what still does.

Success, in the order it should be proven:

1. **A provider edit needs no restart.** A change to a provider's metadata, to a
   provider key's models, aliases or weight, or to the model catalog, committed
   to the repo and applied, reaches the running task with the same
   task-definition revision and the same task ARN. `BIFROST_CONFIG_VERSION` does
   not move for it, because the digest covers only the boot-only subset
   (decision 2). The proof is `describe-services` before and after (same
   revision, same started task) plus the changed value read back from
   `GET /api/providers/fireworks`.
2. **A governance change converges within one tick.** A budget, rate limit,
   model policy or `is_active` change in the governance documents reaches every
   existing managed key within one reconciler interval (5 minutes, decision 4)
   and no restart. The proof is the key's own budgets read back from
   `GET /api/governance/virtual-keys` until they match, with the task ARN
   unchanged.
3. **Retuning a limit does not wipe a month.** Changing an existing budget's
   `max_limit` leaves `current_usage` where it was. The proof is that number
   read before and after the change, unchanged, because budget reconciliation
   matches on id or `reset_duration` and copies usage back deliberately
   (`governance.go:904`, and the comment at `governance.go:838-848`).
4. **A boot-only edit still rolls the task.** A change to a `config_store` or
   `logs_store` connection block, `encryption_key`, `setup_token`, a provider
   key's value, or the image registers a new task-definition revision. The
   digest is the seam that makes that happen, so it must still happen.
5. **The digest's allowlist cannot rot silently.** A path in
   `config.json` that is boot-only and not on the allowlist fails a test, and so
   does an allowlist entry that matches no leaf in the file or that claims a leaf
   the reconciler converges live. The failure this prevents is a config change
   that never applies, which is the exact bug commit `75d30ae` was written to
   close.
6. **Rollback is a revert plus one tick.** Reverting the committed file
   converges the running task back: within one reconciler interval for
   governance, and within one deploy run for config. The bound is stated, not
   implied to be instant.
7. **A stuck reconciler pages.** Three consecutive convergence failures raise an
   alarm and are answered by an entry in [`runbooks.md`](./runbooks.md). Nothing
   disables the reconciler automatically (decision 15).
8. **The reconciler can never grant access.** It applies desired state to keys
   that exist and creates none. A directory member with no key is still a
   `gp-pi bifrost-key` mint, and a reconciler run over a roster of people with
   no keys logs that it changed nothing (decision 7).

Explicitly not a success criterion: an image upgrade without an outage. That
restart remains, and "What this is not" says so.

## The split: what converges live, and what needs a restart

Established from the source at the pinned tag `transports/v2.3.2` (git tag
`transports/v2.3.2`, commit `a05ea20`), not from the docs.

| Setting | Live | Where the proof is |
|---|---|---|
| Client config (logging, content logging, retention, auth-on-inference, CORS origins) | yes | `PUT /api/config` decodes only `client_config`, `framework_config` and `auth_config` (`transports/bifrost-http/handlers/config.go:312-339`), updates each field only when the raw body carried it (`:867`), and reloads the client config from the store before answering (`:940`) |
| Provider metadata (base URL, headers, concurrency, proxy, prompt cache) | yes | `PUT /api/providers/{provider}`; `providerUpdatePayload` at `providers.go:188`, the rule at `:202-219` ("Omission means leave this alone"), route at `:251` |
| Provider key models, blacklisted models, aliases, weight | yes | `PUT /api/providers/{provider}/keys/{key_id}` (`providers.go:252`); absent fields are preserved from the stored key by `decodeKeyUpdate` (`provider_keys.go:499-533`), which carries `aliases` at `:509`; aliases persist in the key row (`framework/configstore/tables/key.go:33`, reconstructed at `:1111-1119`) and the field is declared at `:134` |
| Model catalog pricing and attributes | yes | `PUT /api/models/catalog` (`providers.go:265`), handler at `:1774-1794`, which reloads the pricing cache through `framework/modelcatalog/datasheet/cost.go:2467` |
| Virtual-key governance (budgets, rate limits, model policy, active, expiry) | yes | `PUT /api/governance/virtual-keys/{vk_id}` (`governance.go:1816`), handler at `:2546`, which calls `ReloadVirtualKey` before answering (`:3031`) |
| `config_store` and `logs_store` connection blocks | no | read once at boot; the pools are built from them (`transports/bifrost-http/lib/config.go`, the load sequence at `:1153-1200`) |
| `encryption_key` | no | its own schema entry says the key cannot be changed without cleaning up the database (`transports/config.schema.json:70-73`) |
| `setup_token` | no | resolved at boot by `resolveSetupToken` (`lib/config.go:6739-6747`) |
| Provider key **values** | no, and not by choice | `config.json` holds `env.NAME` (`deploy-workbench/bifrost/config.json`, `env.FIREWORKS_API_KEY`), which the task resolves from its own injected environment at boot (`core/schemas/secretvar.go:117-135`, `SecretVar` resolution through `os.LookupEnv`) |
| The image, the entry point, anything task-shaped | no | by construction |

Two consequences are load-bearing, so they are stated here rather than left to
a reader:

- **A provider key's value is boot-only because of who can resolve it.** The
  value in `config.json` is a reference, `env.FIREWORKS_API_KEY`, and only the
  task can resolve it, from the environment the task definition injects from
  Secrets Manager. A reconciler that wanted to write the value would have to
  replicate that secret mapping, which makes it a second holder of every
  provider credential. That is a bigger security decision than this plan is
  willing to make for a field that changes about never, so the value stays
  boot-only (decision 2).
- **A handful of client settings still ask for a restart.** `PUT /api/config`
  collects `restartReasons` for Prometheus labels, allowed origins, allowed
  headers, initial pool size, a logging change, and max request body size
  (`config.go:714-739`, `:780`), and stores a "a restart is required for changes
  to take full effect" note (`:1225-1230`). The values are still written and the
  reload still publishes them (`transports/bifrost-http/server/server.go:1580-1614`, which refreshes the
  CORS snapshot and the auth middleware), so this is a caveat on "fully live",
  not an exception: `allowed_origins` and `enable_logging` are the two this
  deployment sets that appear on that list. The plan treats them as live and
  records that the server's own note asks for a restart. Anything that genuinely
  needs one belongs on the boot-only list, and the drift test in decision 2 is
  where it would show up.

### The digest must narrow, or the split does not exist

`BIFROST_CONFIG_VERSION` is currently a SHA-256 prefix over the whole of
`config.json` (`deploy-workbench/ecs.ts:645-657`), carried into the task
definition as an environment entry (`ecs.ts:1291-1294`) so that a config change
registers a new revision and the stop-before-start rollout picks it up
(`ecs.ts:605-636`). That seam is correct and stays. What has to change is what
it hashes: today a model alias edit moves the digest and rolls the task, which
is the restart this plan exists to remove.

So the digest becomes a digest over **only the boot-only subset**, computed from
parsed JSON against a committed allowlist of **paths**, not of top-level keys.
That distinction is load-bearing rather than pedantic: `providers` is a mixed
section. A provider's metadata, its key's models, aliases and weight, and the
model catalog all converge live, while `providers.*.keys[].value` is boot-only
because it holds the `env.` reference only the task can resolve. A top-level key
list cannot express that split. With `providers` on the list, an alias edit
rolls the task and the plan does nothing; with `providers` off it, a key-value
change never moves the digest and never applies, which is the silent `75d30ae`
failure. So the allowlist names leaf paths (a prefix over `providers.*.keys[].value`
and the whole of `config_store`, `logs_store`, `encryption_key`, `setup_token`),
and the drift test walks the parsed file's leaves against it: every leaf whose
path matches an entry must roll the task, every leaf whose path does not must be
converged live, and an entry that matches no leaf fails.

The failure mode of getting this wrong is asymmetric and worth naming. A
boot-only leaf that the allowlist misses is a change that never rolls the task
and never applies: silent, and the exact class of bug commit `75d30ae` was
written to prevent. A live leaf wrongly included is a needless restart: visible,
and cheap. The test therefore fails in both directions, and the direction that
matters is the first.

## The design

Four pieces: a committed governance desired state, two parameters, one
reconciler, and two triggers.

### The governance desired state

One **default template** plus **per-person overrides**. No tiers: a tier is a
second template and a mapping from group membership to template, and the
engineer's decision is that the fleet is not big enough to need one yet.

The template is the committed `deploy-workbench/bifrost/vk-mint-template.json`
(704 bytes) and it is already the source of truth for a minted key's shape,
stored as `/bifrost/vk-mint-template` by `deploy-workbench/bifrost-vk-mint.ts:383-392`
and read by the mint through `ssm:GetParameter`
(`deploy-workbench/bifrost/vk-mint-handler.ts:394-399`).
This plan leaves that mechanism alone and adds one thing beside it: an
overrides document.

```json
{
  "jeff@goodparty.org": {
    "calendar_aligned": true,
    "budgets": [{ "max_limit": 250, "reset_duration": "1M" }]
  },
  "someone@goodparty.org": {
    "rate_limit": { "request_max_limit": 600, "request_reset_duration": "5m" }
  }
}
```

Overrides support **field-level merge with an explicit `inherit` sentinel**. An
override that names only a budget inherits the template's model policy
untouched; `"provider_configs": "inherit"` says so out loud rather than leaving
it to the absence of a key, because `provider_configs` is a replacement set on
the wire (below) and "absent" and "inherit" have to mean different things.

The overrides document is a **new SSM parameter, `/bifrost/governance-overrides`**,
written by Pulumi from the reviewed file on every apply, exactly as the template
already is. Git is the source; a console edit to the parameter is overwritten by
the next apply, which is the property the template already has and the reason
`deploy-workbench/bifrost-vk-mint.ts:379-392` reads the file at deploy time
rather than trusting what is there.

**Why two parameters and not one.** The SSM `String` standard tier holds 4 KiB
(AWS's `PutParameter` documentation: standard parameters have a content size
limit of 4 KB and no charge; advanced parameters hold 8 KB and incur a charge).
`deploy-workbench/bifrost/config.json` is already 3,794 bytes on its own, and
`ecs.ts:590-593` records that going past 4 KiB means `tier: "Advanced"`. So the
two governance documents cannot share a ceiling with anything else. Split, the
704-byte template has room to grow and the overrides document has the other
~3 KiB:

- a budget-only override is about 105 bytes as written above, so roughly 25 with
  realistic key lengths and the surrounding JSON syntax;
- an override that restates a full model policy is about 565 bytes, so roughly
  5 fit.

Those two figures are measured on the committed files rather than estimated:
`JSON.stringify` of one entry of each shape, against 3,072 bytes of the 4 KiB
ceiling.

Past that the parameter moves to `tier: "Advanced"` (8 KiB, and AWS charges for
advanced parameters, on the order of $0.05 a parameter a month on AWS's
published pricing, which this document did not read from the pricing page). That
is a one-line change in the Pulumi program and a deliberate one. The failure
mode of not doing it is a loud one rather than a silent one, because
`PutParameter` rejects a value over the tier's limit instead of truncating it.

**Why one document and not a parameter per person.** An email cannot be an SSM
parameter name. The allowed set is `a-zA-Z0-9_.-` plus `/` as the hierarchy
separator (AWS's naming constraints for `PutParameter`), and `@` is not in it.
So per-person state has to be a map, and the map is keyed by **lowercase email**,
which is what the key's name already is (`docs/bifrost-virtual-keys.md`, "The
key name is the lowercase email") and what the mint lowercases before it compares
(`deploy-workbench/bifrost/vk-mint-core.ts:190`).

**Validation fails at apply, not at convergence.** An override naming somebody
who is not in the `Engineers` group, or a budget `reset_duration` Bifrost will
reject, fails a test over the committed file at the apply that wrote it. It is
not allowed to surface as a reconciler that retries the same `400` forever behind
an alarm. The group membership the test checks is a directory read, which the
deploy job cannot make — the reader role admits only the two Lambdas — so the
deploy checks a member set supplied to it (`GOVERNANCE_OVERRIDES_MEMBERS`) and
`npm test` holds no credentials.

### One reconciler, two triggers

**One Lambda, extended from the existing janitor.** `deploy-workbench/bifrost-vk-janitor.ts`
already has everything a reconciler needs and has it for the same reasons:
a VPC attachment and an ENI (the group and its rules, `:232-320`), the Cloud Map
name `bifrost.workbench.local:8080` (`deploy-workbench/discovery.ts:56-66`, port
from `network.ts:89`), the setup-token read from `bifrost/gateway`
(`SETUP_TOKEN_SECRET_NAME`, and its own IAM statement at `:180-189`), the
`sts:AssumeRole` hop to the management-account reader role for
`identitystore:ListGroupMemberships` and `GetUserId`
(`deploy/components/bifrost-vk-reader.ts:40-133`), one run at a time
(`reservedConcurrentExecutions: 1` at `:120`, `:369`), and the admin API client
with the setup-token header already written (`bifrost/vk-janitor-handler.ts:197-283`).
A second function would duplicate all of that, its IAM and its tests, to do a
job that shares the same directory read, the same credential and the same
target.

The reconciler's work is then two functions over the same desired-state
computation:

- **governance convergence**: template plus overrides, resolved per person, diffed
  against the gateway's keys, applied by `PUT` to the keys that differ. Triggered
  by the EventBridge rule, every 5 minutes.
- **config convergence**: the live subset of `config.json`, diffed against the
  provider, key and client state the gateway reports, applied by `PUT` to the
  endpoints in the table above. Triggered by an `InvokeFunction` from the deploy
  workflow after the Pulumi apply. A provider or key the running gateway does
  not have is reported `not-present` and skipped rather than created (decision
  7), and a `404` means the same thing on both of that provider's reads — the
  provider itself and its key list — so a provider that is only in the file
  cannot fail the invoke it is supposed to be a note about.

Same desired-state computation, two callers, and the minter is a third
(decision 7).

**Two triggers, for two different bounds.** The governance loop is a schedule
because a person's override should land without a deploy, and 5 minutes is a
bound an alarm can be built on. Config convergence is an invoke from the deploy
because the moment that matters is the one where an apply has just reported
success: a config change that waits for the next tick to fail is
indistinguishable, to the person who merged it, from a config change that
applied.

The 5-minute rule does both of the janitor's jobs: revocation and convergence.
That is a behaviour change worth naming, because `bifrost-virtual-keys.md`
decision 6 argues for the hour ("a person who has left is not a five-minute
emergency and a job that runs often enough to page on is a job that pages for a
bad reason"). The argument is still right about paging and no longer decides the
interval, because the job now also carries a change whose whole point is to
land promptly. Running revocation at 5 minutes instead of 60 costs a group read
and a key list every 5 minutes and cannot take access away from anyone who is
still a member, so the faster cadence is harmless in the direction that
matters.

**Two EventBridge rules on one Lambda need two permissions, with distinct
statement ids.** This design has one rule, so the trap does not bite yet, and it
is recorded because the janitor is exactly where a second rule would be added:
splitting revocation's hourly cadence from convergence's 5-minute one is the
obvious next change, and it fails at apply the first time. Each
`aws.lambda.Permission` grants one `sourceArn`, so a second rule is a second
permission resource, and the two must not share a `statementId`: Lambda refuses
a duplicate id on a function's resource policy (`AddPermission`'s
`ResourceConflictException`, a `409`), and the apply fails with "The statement id
already exists". The shape that produces it is the tempting one, copying the
existing block and giving the copy the same literal id. Today there is one rule
and one permission (`bifrost-vk-janitor.ts:389-421`, the permission at `:414`).

The deploy's invoke is the other case and needs no resource-based policy at all:
it is a same-account IAM principal calling the function, authorised by the
caller's own policy. That distinction decides where the grant goes, and here it
lands on something worth saying plainly: the invoke makes the same
`pulumi-deploy` hop `scripts/verify-service.ts` makes, and that role is
`AdministratorAccess` (`deploy-workbench/deploy-role.ts:66-127`), so the invoke
needs **no new grant at all**. Adding one would be decoration. If the deploy
path is ever narrowed to a scoped role, `lambda:InvokeFunction` on this one
function ARN is the single statement it needs, and the workflow's hop is already
the shape that would carry it (`deploy-workbench/scripts/aws-role.ts`).

**The deploy must poll the invoke.** A fire-and-forget `InvokeFunction` returns
`202` and a request id whether the reconciler converged or threw, so a workflow
that invokes and moves on goes green over a config that never landed. That is
the `75d30ae` class of bug with a different mechanism: the apply looks
converged while the gateway runs the old file. So the workflow invokes with
`InvocationType: RequestResponse` (or invokes asynchronously and polls the
function's result), asserts the returned summary says `converged`, and fails the
run otherwise. It runs under the `pulumi-deploy` hop the other post-apply checks
already take (`deploy-workbench/scripts/aws-role.ts`, the pattern
`scripts/verify-service.ts` uses), because the first-hop
`github-actions-workbench-deploy` role carries the Pulumi backend grant and the
one SSM read, not `lambda:*` (`deploy/components/ci-roles/policies.ts:926-952`),
while `pulumi-deploy` is `AdministratorAccess` (`deploy-workbench/deploy-role.ts:66-127`).

The reply is a `JanitorRun`, not a bare summary. The handler returns
`{ revocation, governance, config, summary }` and the run's own verdict is
`summary.outcome`, because the `JanitorRun` shape is already the Lambda's public
reply from step 3 (`docs/bifrost-virtual-keys.md`, the janitor's run log and its
own tests) and narrowing it to suit the one new caller would drop the audit
shape an operator reads when they invoke the function by hand. So the poll
accepts both: `parseReconcilerSummary` reads `outcome` at the top level and one
level down at `summary.outcome`, and
`vk-janitor-handler.test.ts` drives the handler's real return value through the
JSON serialisation the CLI's outfile applies and then through the parser. That
integration test is the point: the two sides were each tested against their own
shape, which is how a reply nobody could read stayed green in the suite.

The payload is written to a file and passed as `fileb://path`, never as inline
`--payload` JSON. `--payload` is a blob argument, so AWS CLI v2 base64-decodes
it by default (`cli_binary_format=base64`) and rejects raw JSON with
`Invalid base64` before the request is signed — which is neither a throttle nor
a `FunctionError`, so the step would exit "could not complete" on every deploy.
`fileb://` is the one form the CLI reads as bytes whatever `cli_binary_format`
says, so the deploy's correctness does not depend on a flag or on a profile
setting; `verify-convergence.test.ts` pins the real argument list, since the
retry loop's injected invoke cannot see it.

**Step 4 lands in two PRs, and this is the split.** Everything in
`deploy-workbench/` — the poll, the contract module, the config half, the
handler's reply shape — is one PR, because that tree is de-owned and its
failures are all in one place. The workflow change that *calls* the poll is a
second PR, because `.github/workflows/` stays human code-owner owned: a workflow
added on `main` can assume the deploy roles (OIDC trust keys on the ref, not the
filename), so the file that decides what runs with a credential keeps a human
behind it. The order is A then B, not a preference: the step invokes
`scripts/verify-convergence.ts`, so a B that landed first would call a script
that is not on `main` yet. The script is inert until the workflow calls it,
which is what makes A safe to merge alone — and why the two ordering assertions
in `deploy-workflow-order.test.ts` are written as "where the step is present"
on A and become unconditional on B.

**`reservedConcurrentExecutions: 1` turns a collision into a failed deploy.**
The function is capped at one concurrent execution (`bifrost-vk-janitor.ts:120`)
so a reconcile cannot read its own partial state, and that cap stays. But a
capped function has no queue: an invoke that arrives while a scheduled tick is
running is **throttled**, not delayed, and a `RequestResponse` invoke returns
`TooManyRequestsException` (429) rather than a result. The module already knows
this shape and says so at load, in the guard that keeps the timeout below the
interval: "`reservedConcurrentExecutions: 1` would then start dropping
invocations" (`:110-117`). A deploy that then fails "convergence did not run"
would be red for a reason that has nothing to do with the change, which is the
wrong colour in the direction that erodes trust in the signal.

The fix is three parts and the plan commits to all three, because either half
alone is wrong:

- **The deliverable is idempotent and safe to overlap.** Convergence state is
  read-then-written per key, and two runs converging the same key converge to
  the same place. The cap is about not reading a half-written state within one
  run, not about mutual exclusion between runs.
- **The workflow treats a throttle as "retry", not "failed".** It retries the
  invoke with backoff for a bounded window, sized against the timeout
  (`VK_JANITOR_TIMEOUT_SECONDS`, 120s at `:107`), and only after that window
  fails the run. A 429 that clears is a scheduling collision, not a
  convergence failure, and the two must not read the same in the run log.
- **The alarm is on convergence failures, not on throttles.** The three-in-a-row
  alarm counts runs that ran and did not converge. A throttle is counted
  separately and loudly enough to be seen, because a pattern of them means the
  cadence and the deploy are fighting and the answer is a second rule, not a
  bigger cap.

A module-level constant pins the relationship the same way the timeout/interval
check does at load (`:110-117`), so the retry window cannot drift below the
timeout it has to outlast.

**Diff before write.** At 5 minutes an unconditional full desired-set `PUT` every
tick is 288 no-op writes per key per day, each one calling `ReloadVirtualKey`
(`governance.go:3031`) and rebuilding that key's in-memory governance, and each
one rewriting budget rows through `UpdateBudget` (`framework/configstore/rdb.go:5896`).
So the loop is: `GET` the gateway's keys, compute the desired state, `PUT` only
what differs, and count what it changed. That last number is what makes
**converged** a real signal: a run that changed nothing is a run that had nothing
to change, and a run that keeps changing the same thing is a fight worth an
alarm.

**A full copy of the composition, never a patch.** `provider_configs` on a
virtual-key update is a replacement set: a supplied entry updates or is created,
and an entry in the store that the request omits is **deleted**, with its budgets
and rate limit (`governance.go:2667-2872`, the delete loop at `:2860-2871`,
`collectProviderConfigDeleteIDs` at `:1717-1729`). Per-model budgets behave the
same way when supplied (`:1076-1127`). Omitting `key_ids` does leave the
associations alone (`:2797-2820`), which is a narrow exception, not the rule. The
reconciler therefore composes the **complete** desired set for every `PUT`, from
the template, the override and whatever the key must keep, and never sends a
partial one hoping for a merge.

### What the governance API accepts, and why that is enough

`UpdateVirtualKeyRequest` at `governance.go:429-471` accepts, and the handler
applies: `budgets` as `[]CreateBudgetRequest`, which "replaces all VK-level
budgets" (`:451`); `provider_configs[]` with `allowed_models`,
`blacklisted_models`, `model_budgets`, `rate_limit`, `weight` and `key_ids`
(`:432-442`); `rate_limit` (`:452`); `is_active` (`:453`);
`calendar_aligned` (`:454`); `allow_all_providers` (`:455`);
`reset_budget_usage` (`:456`); `expires_at` (`:457`);
`delete_after_expire` (`:461`); `metadata` (`:467`); `team_id` (`:448`).
`CreateBudgetRequest` is `{ id?, max_limit, reset_duration, reset_config? }`
(`:565-572`).

That covers the whole governance desired state in one call per key, which is why
one reconciler can own all of it.

Three properties make it safe to run on a schedule:

- **The change is live before the response.** The handler reloads the key in the
  running process (`governance.go:3031`) and only then answers, so a `200` means
  the enforcement path already has the new numbers.
- **Budget reconciliation preserves usage.** Matching is by `id`, or by
  `reset_duration` when no id is given (`buildBudgetLookup` at `:756`,
  `findExistingBudget` at `:777`), and `UpdateBudget` copies `CurrentUsage` and
  `LastReset` back from the stored row on every write, deliberately, so a config
  sync cannot replay stale numbers over live accounting
  (`framework/configstore/rdb.go:5934-5945`, and the handler's own comment at
  `governance.go:838-848`). Clearing usage needs `reset_budget_usage: true` and
  is opt-in. **So retuning a limit does not wipe a person's month**, which
  corrects the assumption in [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md)
  that the update path accepts only `is_active`, `expires_at` and
  `delete_after_expire`.
- **A budget window can be made to match the billing month.**
  `calendar_aligned: true` snaps budgets and rate limits to calendar boundaries
  (`governance.go:454`, `:2651-2654`, adopted in memory at `:3048-3058` and
  `plugins/governance/store.go:2542`), so a `1M` budget resets on the month
  rather than anchoring at key creation, which is what
  `framework/configstore/tables/budget.go:220-239` does otherwise.

### Budgets and rate limits

`rate_limit` is a **supported field with no default value**. The default template
gains the field shape and sets nothing, and no override is required to have one.
The asymmetry is worth recording because it is not symmetric: on a `PUT`, an
omitted `rate_limit` means "leave unchanged", so the reconciler will never
introduce one from an absent field. There is no "default rate limit" that
silently appears, and that is the intent.

The subtlety that follows, and that a reader will otherwise read as a
contradiction: the reconciler converges every existing key to template plus
override, so **a value that *is* in the template reaches every key on the next
tick, not just the keys minted after it.** "Applies only to new keys" is a
property of an absent field, not of a template change. So the rule is that
`rate_limit` stays absent from the template, and any limit is added as an
override naming the people it should apply to. Setting one in the template is
the same act as adding it to the whole fleet, and it should be done knowing
that. Anything else would be a second mechanism ("template but not this field;")
that the `PUT` semantics do not have.

**Per-key budgets are back, and this reverses the deferral.** `#404` and
"Deferred" in [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md) recorded
that per-key budgets and rate limits were dropped for the first pass, on the
argument that a number chosen before there is usage data can starve a person
mid-task as easily as it catches a runaway. That argument has expired: the log
store has been collecting per-request cost keyed by virtual key at 90-day
retention (`deploy-workbench/bifrost/config.json`, `client.log_retention_days:
90`), so the number can now be chosen from evidence rather than guessed. The
reversal is deliberate and this paragraph is the record of it.

One honest bound on what a budget enforces. `CheckBudget` compares the budget's
`CurrentUsage` plus a per-budget baseline against the limit
(`plugins/governance/store.go:2172-2200`), and the baseline is `nil` in every
in-tree call (`plugins/governance/resolver.go:226`,
`plugins/governance/store.go:1462`, `:5094-5110`). `CurrentUsage` is loaded at
boot and written back as an absolute snapshot every 10 seconds
(`plugins/governance/tracker.go:97`, `:258`, and `store.go:3016`,
`current_usage = v.cu`), with a final dump on shutdown (`tracker.go:441`). So a
task start resets the in-memory number to the last dump, which is at most 10
seconds of spend. That is true today on a single task and the reconciler does not
change it. It is the same mechanism the archived plan recorded, and the reason
that plan needed one writer per store; here there is still one writer, so the
bound is unchanged and small.

### Failure, rollback, observability

**Rollback is a revert.** Revert the committed file, and the reconciler converges
the running task back: within one tick for governance (5 minutes), and within one
deploy run for config (the apply, then the invoke, then the poll). That replaces
the archived plan's repoint-at-the-previous-colour rollback. It is better in one
way and worse in another, and both should be said: no writes are lost, because
there is nothing to lose and no second store to be out of date; and it is not
instant, because it waits for a tick or a deploy. A change that needs to be
undone in seconds is a change that needs the dashboard, or the next apply, and
that is a different decision (decision 16).

**If the reconciler breaks, nothing is dangerous.** The running task keeps the
configuration it has. A restart applies everything from the file, because the
boot path reads the same sources. That is worse than today in one respect (a
config change can sit unapplied while the cron is broken) and better in another
(the SSM parameters already record the intent, so recovery is a deploy, not a
reconstruction). Nothing the reconciler does is required for the gateway to
serve.

**Alarm on three consecutive convergence failures**, plus a runbook entry in
[`runbooks.md`](./runbooks.md). Three, not one, because a single `503` from a
restarting task is not a reconciler problem. **No auto-disable**: a reconciler
that turns itself off is a reconciler whose failures stop paging, which is the
opposite of what the alarm is for. `runbooks.md` is a stub today; the entry lands
with the alarm, not before it.

**Source of truth is unchanged, and the window widens.** `config.json` already
sets `source_of_truth: "config.json"` (`deploy-workbench/bifrost/config.json`,
schema at `transports/config.schema.json:61-69`), so a section the file declares
is authoritative and the boot path prunes governance rows the file does not
declare (`transports/bifrost-http/lib/config.go:4752-4789`). A dashboard edit is
therefore discarded either way. What changes is how long it survives: the window
goes from "until the next restart" to "until the next pass", which is up to 5
minutes for governance and one deploy for config. If UI edits should ever
survive, that is a different source-of-truth decision and not a tweak to this
one.

## Decisions

Each decision carries the alternative that was rejected, so a later reader sees
what was considered rather than re-deriving it.

### 1. Remove the reasons for a restart, not the restart window

The plan converges a live single node to a committed desired state. The rejected
alternative is the archived plan's: a config store per colour, a seed of the
inactive database, and a 100/200 rollout that runs two tasks briefly. It was
rejected for three reasons, in order of weight. The seed's table list is a
permanent obligation against a dependency that bumps weekly (66 `TableName()`
methods at this tag, and nothing guarantees the next release does not add one).
The gap it removes was never measured: the archived plan says so itself, in
"Consequences, stated rather than buried", where everything but the seed's own
duration is "arithmetic from the constants, and none of it is a measurement".
And it changes the invariant the deployment rests on, from one
task to one writer per store, for a window of about a minute and a half. This
plan keeps the invariant and spends its complexity on making most changes not
need a restart, which is where the restarts were actually coming from.

### 2. Split config into live and boot-only, and narrow the digest to match

Live: client config, provider metadata, provider key models/aliases/weight, the
model catalog, virtual-key governance. Boot-only: the two store connection
blocks, `encryption_key`, `setup_token`, provider key values, the image, and
anything task-shaped. The table above is the whole split, with a citation per row.

The digest becomes a digest over the boot-only paths, from parsed JSON against a
committed allowlist of paths, with a drift test in both directions. This is what
makes the split real: without it a model alias edit still rolls the task, and the
plan is decorative. `providers` is why the allowlist is a set of paths and not a
set of top-level keys: that section is mixed, and a key list cannot say "roll on
`keys[].value`, converge on `keys[].aliases`".

Rejected: **keep hashing the whole file.** It is one line and it is what is there
today, and it costs a restart for every live change, which is every change this
plan exists to stop rolling for.

Rejected: **converge provider key values too**, which would let a provider
credential rotate without a restart. `config.json` holds `env.FIREWORKS_API_KEY`
and the task resolves it from its own injected environment
(`core/schemas/secretvar.go:117-135`), so a reconciler holding the resolved value
would have to hold every provider credential, in its environment or in a secret
it reads. That turns a config converger into a credential holder and widens what
a bug in it can leak. A provider key changes about never, and the boot path
already applies it.

Rejected: **do nothing and accept the roll.** That is the current state, and the
roll is the outage this plan is trying to stop paying for on every alias edit.

### 3. One Lambda, the janitor, extended

The existing janitor already holds the VPC attachment, the Cloud Map name, the
setup-token read, the directory role and one-run-at-a-time concurrency, all for
reasons this job shares. Extending it reuses the credential, the security groups,
the log group and the tests.

Rejected: **a new function beside it.** Two functions means a second ENI in the
private subnets, a second security-group pair, a second `bifrost/gateway` read,
a second copy of the directory hop, and two Lambdas that must agree about the
marker and the desired state. The archived plan's own precedent, the mint and
the janitor sharing the reader role, is the argument for one function rather than
two.

### 4. Two triggers: a 5-minute schedule and the deploy's invoke

Governance converges on `rate(5 minutes)`, down from `rate(60 minutes)`
(`VK_JANITOR_INTERVAL_MINUTES` at `deploy-workbench/bifrost-vk-janitor.ts:99`).
Config converges from the deploy workflow, after the apply.

The two EventBridge gotchas that go with a second trigger are in "One
reconciler, two triggers": a second rule needs a second `aws.lambda.Permission`
with a distinct statement id, and a same-account IAM caller needs no
resource-based policy at all. The deploy's invoke is the second kind, on a role
that is already admin, so it changes no IAM.

Rejected: **one rate for both.** A config change would wait up to the interval
after an apply that reported success, which is indistinguishable from a config
change that failed, and it would put the config convergence behind the same
schedule as a job whose failures mean something else.

Rejected: **the workflow calling the gateway directly.** The runner is
`ubuntu-latest` (`deploy-workbench.yml:86`), it is not in the VPC, and the admin
API is reachable only from inside it (`network.ts`, the 8080 ingress from the two
Lambdas' groups). A runner that could reach it would be a runner inside the
network, which is a different and much larger change.

Rejected: **5 minutes replaced by "on demand only".** Then a person's override
lands when someone remembers to invoke the function, and revocation stops being
a schedule.

### 5. The deploy polls the invoke, and a fire-and-forget invoke is a bug

The deploy asserts the reconciler's result and fails the run if it did not
converge. See "The deploy must poll the invoke", including the
`reservedConcurrentExecutions: 1` collision: a throttled invoke is retried with
backoff for a window sized against the function's own timeout, and only a run that
ran and did not converge fails the deploy.

The result it reads is `summary.outcome` on the `JanitorRun` the function
returns, with the bare-summary shape accepted too, and the event reaches the
function as a `fileb://` file rather than inline `--payload` JSON. Both are in
"The deploy must poll the invoke" and both are pinned by tests that drive the
real reply and the real argument list, because a poll whose two halves each
match their own assumption is a poll that never ran.

Rejected: **`Event` invocation, or `Request` without reading the body.** Both
return before the work does, both are green on a failed convergence, and both put
the failure where nobody looks: in a CloudWatch log nobody opened, after a PR
that said it applied.

### 6. Diff before write, and "converged" is a counted number

`GET`, compute, `PUT` only the differences, and log what changed. At 5 minutes an
unconditional write is 288 no-op `PUT`s per key per day, each rebuilding that
key's in-memory governance.

Rejected: **write everything every tick**, on the argument that idempotent writes
are cheap. They are cheap in bytes and not in `ReloadVirtualKey` and budget-row
rewrites, and they destroy the one signal worth having: a run with nothing to do
versus a run that keeps finding the same difference.

### 7. The reconciler applies to existing keys and mints nothing

It converges keys that exist, matched by the marker and the name
(`deploy-workbench/bifrost/vk-marker.ts`, `isManagedKeyDescription`). The minter
applies the same overrides at create (`bifrost/vk-mint-core.ts`, the create path
at `:377`), from the same desired-state computation.

Rejected: **let the reconciler mint.** It would remove the manual
`gp-pi bifrost-key` step, and that is the whole argument for it. It was not
taken, deliberately: a reconciler that mints turns a convergence loop into a
grant path, and a bug in it hands out keys. The mint is a call the person makes
and the minter is where granting lives, which keeps one code path that grants and
one that converges, the same split `bifrost-virtual-keys.md` decision 6 already
makes for revocation.

### 8. Git is the source, through two SSM parameters, and the overrides are one document

The template stays at `/bifrost/vk-mint-template`; overrides go to a new
`/bifrost/governance-overrides`. Both are written by Pulumi from committed files
on every apply.

Rejected: **a parameter per person.** An email cannot be a parameter name: the
allowed set is `a-zA-Z0-9_.-` with `/` as the separator (AWS's `PutParameter`
naming constraints), and `@` is not in it. Per-person parameters would need an
encoded name and a lookup table, which is a map with extra steps and a worse
audit story.

Rejected: **one parameter for both documents.** `config.json` is already 3,794
bytes against a 4 KiB standard ceiling and `ecs.ts:590-593` already warns about
it; a combined governance document would grow into the same wall, and the two
documents have different lifetimes anyway (the template changes when the fleet's
shape does, the overrides when a person does).

Rejected: **the config store or the dashboard as the source.** That is the
source-of-truth decision this plan explicitly does not make (decision 16). Git is
where a reviewed change lives and where a revert is one command.

### 9. Field-level merge, with an explicit inherit sentinel

An override is merged field by field onto the template. `"provider_configs":
"inherit"` is the sentinel for "keep the template's".

Rejected: **whole-document replacement.** An override naming only a monthly
budget would silently drop the model policy, and the person would find out when
their key stopped reaching the models it used to. Requiring every override to
restate the whole shape would also make each one ~700 bytes and put the 3 KiB
ceiling within six people.

Rejected: **tiering** (a second template and a membership-to-template map). The
data model supports it (`bifrost-virtual-keys.md`, "Deferred": a tier is a key's
`provider_configs`), and the engineer's decision is that it is not needed today.
Recorded so a later reader does not build it as an obvious extension: it is a
decision, and the decision was no.

### 10. Validation fails at apply

A test over the committed overrides file runs where the deploy runs and checks
every email against the `Engineers` membership supplied to that run, and checks
every budget against Bifrost's own duration rules (`ParseDuration` and the
"duplicate reset_duration" rule, `governance.go:905-919`), so a bad override
fails the run that wrote it.

Rejected: **validate in the reconciler.** A malformed override would be a `400`
on every tick, retried forever, behind an alarm that fires for a reason a human
then has to read the logs to learn. A pull request is the right place to be told
that a budget is malformed.

### 11. Budget windows are calendar-aligned

`calendar_aligned: true` on the template's budgets and on every override's, so a
monthly limit resets on the month (`governance.go:454`, `:2651-2654`;
`framework/configstore/tables/budget.go:220-239` for the rolling alternative).

Rejected: **the default, a rolling window anchored at key creation.** A person
minted on the 20th would get a "monthly" budget that resets on the 20th, which
matches no billing period anyone can reason about, and the cap would land
mid-sprint for everybody at a different time.

### 12. `rate_limit` is supported, and defaults to nothing

The field is in the shape and no value is set, in the template or anywhere else.
See "Budgets and rate limits" for the asymmetry, which is the point, and for
the one consequence worth knowing: because the reconciler converges every
existing key to the template, a value put in the template applies to the whole
fleet on the next tick. That is why the template carries none.

Rejected: **a default rate limit.** Any number chosen without usage data is the
guess `#404` was right to refuse. And a template default is not a gentler
version of the same thing here: it is a fleet-wide limit introduced by one line,
which is exactly the silent default the design refused.

Rejected: **leaving `rate_limit` out of the shape entirely** until someone needs
one. Then adding it later is a change to three callers (template, reconciler,
minter) instead of one field, and the omission-means-unchanged behaviour would be
discovered by whoever needed it.

### 13. Per-key budgets come back, reversing `#404`

Recorded in full under "Budgets and rate limits". Rejected alternative: the
status quo, per-key budgets deferred, with the account budget as the only cap.
That was right when there was no usage data and is wrong now that the log store
has a quarter of it at 90-day retention.

### 14. Rollback is a revert plus a tick

See "Failure, rollback, observability". Rejected: **the archived plan's colour
repoint**, which is instant and loses the writes since the seed, and which needs
two databases to keep existing. Rejected: **the RDS snapshot as the rollback for
a config change**, which is the wrong tool: a snapshot restore is for a
schema-breaking image, and it takes minutes and loses writes for a change that a
revert undoes exactly.

### 15. Three consecutive failures alarm, and nothing disables itself

Alarm on three consecutive convergence failures, with a runbook entry. Rejected:
**auto-disable after N failures**, which trades a paging reconciler for a silent
one, and silence is the failure mode this whole plan is about. Rejected: **alarm
on the first failure**, which pages for a task that was restarting.

### 16. Source of truth stays `config.json`, and the dashboard window widens

Say it plainly: a dashboard edit is pruned at the next convergence, so the window
in which a UI change survives goes from "until the next restart" to "until the
next pass". Rejected: **making the store the source for the sections the
dashboard edits**, which would mean the file stops being authoritative and a
config PR stops being a description of production. If UI edits should ever
survive, it is that decision, taken deliberately, and not a side effect of this
plan.

### 17. Keep step 1 of the archived plan

`stopTimeout: 120` on the Bifrost container and
`deploymentCircuitBreaker { enable: true, rollback: true }` on the service
(`deploy-workbench/ecs.ts:270`, `:1265-1266`, `:1516-1522`), merged in #437 and
retained. They are still worth what they cost: a bad image rolls back by itself
instead of sitting at running 0, and a draining task finishes its final budget
dump instead of racing a 30-second kill.

Rejected: **dropping them because deploys are now rarer.** Rarer is not never,
and the restarts that remain are exactly the ones those two knobs make
survivable. The rest of the archived plan (steps 2 onward, including #438) is
abandoned with it.

## The knobs

Read from the code, not from memory.

| Knob | Where | Now | In this design |
|---|---|---|---|
| `VK_JANITOR_INTERVAL_MINUTES` | `deploy-workbench/bifrost-vk-janitor.ts:99` | `60` | `5` |
| EventBridge rules invoking the function | `bifrost-vk-janitor.ts:389-421` (the permission at `:414`) | one | one at 5 minutes; a second rule needs its own `Permission` and statement id |
| Deploy workflow invoke | `.github/workflows/deploy-workbench.yml` after the apply | none | `RequestResponse`, then a poll, then a failure if not converged |
| Digest input | `ecs.ts:645-657` | the whole file | the boot-only paths, from parsed JSON |
| Digest allowlist | new, in `ecs.ts` or beside it | none | committed paths, covering `providers.*.keys[].value` and the four whole keys, with a two-way drift test |
| Governance template parameter | `bifrost-vk-mint.ts:100`, `:383-392` | `/bifrost/vk-mint-template`, 704 bytes | unchanged name, gains budgets/rate-limit shape |
| Overrides parameter | new | none | `/bifrost/governance-overrides`, one String |
| Parameter tier | `ecs.ts:590-593` records the ceiling | standard | standard until 4 KiB, then `Advanced` |
| `stopTimeout` | `ecs.ts:270`, `:1265-1266` | `120` | unchanged (kept from #437) |
| `deploymentCircuitBreaker` | `ecs.ts:1516-1522` | `{ enable, rollback }` | unchanged (kept from #437) |
| `deploymentMinimumHealthyPercent` / `deploymentMaximumPercent` | `ecs.ts:153-154` | `0` / `100` | unchanged, and this plan does not touch them |
| `healthCheckGracePeriodSeconds` | `ecs.ts:504` | `160`, derived | unchanged |
| Target-group timing | `ingress.ts:284`, `:311-314` | 30s deregistration, 10s interval, 2 healthy, 3 unhealthy | unchanged |
| Reconciler timeout / concurrency | `bifrost-vk-janitor.ts:107`, `:110-117`, `:120` | 120s / 1 | unchanged; the deploy's retry window is pinned above the 120s timeout, because a throttle must not read as a convergence failure |

Notes that belong with the table:

- **The janitor's IAM changes and two of its tests reverse.** It gains
  `ssm:GetParameter` on `/bifrost/config` and on the two governance parameters,
  and `deploy-workbench/bifrost-vk-janitor.test.ts` asserts the opposite today:
  "grants no identitystore action, no SSM, no CreateLogGroup and no KMS"
  (`:233-245`) and "reads no SSM template and declares no SSM parameter"
  (`:258-263`). Both are deliberate assertions with a reason, and the reason
  changes: the function becomes a convergence loop rather than a revocation
  sweep, so it needs the desired state it is converging to. The edits belong to
  step 3, in the same PR as the grant.
- **`config.json` is 3,794 bytes and two comments undercount it.** `ecs.ts:573`
  says "~3 KB today" and `ecs.ts:590` says "about 2.5 KB today", while
  `deploy-workbench/bifrost/README.md:177` says the same. The file is 3,794
  bytes. Neither figure changes a decision, and both should be corrected in the
  same housekeeping step that touches the digest's comment block, because a
  stale size in a comment about a size ceiling is how the ceiling gets crossed
  without anyone noticing.

## What this is not

- **Not high availability.** One serving task, before and after. A restart for
  an image is an outage for the length of that restart, and this plan neither
  measures nor shortens it. The only measurements this document can point at are
  the ones already in the repo: the 2026-10-26 replacement took seven and a half
  minutes end to end, of which the target group's then-default 300-second
  deregistration delay was the largest term, and `ingress.ts:262-284` records
  that shortening it to 30 seconds removed four and a half of those minutes. That
  is the shape of the gap, not a settled number for this design.
- **Not zero downtime.** An image upgrade rolls the task, and the service is
  stop-before-start (`ecs.ts:153-154`). Nothing here changes that, and the
  archived plan's unmeasured arithmetic is not repeated as though it were.
- **Not a replacement for the RDS snapshot restore rehearsal** for a
  schema-breaking upgrade. A revert undoes a config change; it does not undo a
  migration that changed the data. `bifrost-gateway.md`'s restore rehearsal
  stands.
- **Not a change to how keys are issued.** The mint, the marker, the janitor's
  revocation and the key template are
  [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md). This plan adds a third
  consumer of the desired state and changes what the template may contain.
- **Not a multi-node answer.** Two tasks against one config store remain
  unsupported, and nothing here makes them safe.
- **Not a claim that a credential rotation is free.** The task still reads its
  database password at boot, and a rotation is still a task replacement unless a
  separate change makes it re-resolve per connection. That is a different plan.

## Open items

1. **Whether the boot-only allowlist is complete on day one.** The table in
   "The split" is derived from the schema and the load sequence, and the drift
   test can only enforce agreement between the file and the allowlist, not that
   the allowlist classifies every leaf correctly. The way to settle it is a
   config change per live class, applied, with the task ARN checked before and
   after: five changes, five checks, and the result is a test that pins each
   class rather than a reading. The `providers.*.keys[].value` leaf is the one
   that makes this a path list rather than a key list, so it is the first to
   pin: an edit to it must register a revision, and an edit to `aliases` in the
   same array must not.
2. **The exact tier at which the overrides document needs `Advanced`.** The
   arithmetic (roughly 25 budget-only or 5 full-model-policy overrides in 3 KiB)
   is from the byte sizes of the committed files, not from a written-and-read
   parameter. A single `put-parameter` against the account with a synthetic
   document settles the real ceiling, and it is cheaper than finding out at the
   first over-full apply.
3. **Whether `enable_logging` and `allowed_origins` should be boot-only.** Both
   apply live through the reload path and both are on the server's own
   "a restart is required for full effect" list, so the honest classification is
   "live with a caveat". If a change to either turns out not to take effect
   without a restart, they move to the boot-only subset and the digest with them.

## Implementation plan

One step per pull request. A PR names this plan and its step in its body, each on
its own line, as the block at the top shows.

The order is the point of the order, and it changed slightly from the archived
plan's. The digest split lands first because it is the piece that makes every
later failure survivable: with the digest still covering the whole file, an edit
to any of the new governance documents would roll the task anyway, and the
reconciler would be converging a process that had just been replaced. The
desired-state document comes next, because it is the thing the reconciler
converges to and it can be validated before anything reads it. The loop follows,
then the plumbing that triggers it, then the second caller, then the documents
that are now stale.

1. **Split the digest, with its drift test.** `bifrostConfigVersion` hashes only
   the boot-only paths, computed from parsed JSON against a committed path
   allowlist which covers `providers.*.keys[].value` and the whole of
   `config_store`, `logs_store`, `encryption_key` and `setup_token`. The drift
   test walks the file's leaves against that list in both directions. Touches
   `deploy-workbench/ecs.ts` and `deploy-workbench/ecs.test.ts`. Behaviour
   changes in one direction only: a live-subset edit stops registering a new
   revision, which is the first visible evidence that the design is real.
   Proves: a provider metadata, alias or catalog edit registers no new revision,
   a `config_store` edit and a `providers.*.keys[].value` edit both do, and a
   leaf neither list claims fails the test.
2. **The governance desired state: an overrides file, its parameter, and the
   validation test.** `deploy-workbench/bifrost/governance-overrides.json` with
   the merge and `inherit` semantics spelled out in its own comment, the
   `/bifrost/governance-overrides` parameter beside the template's
   (`bifrost-vk-mint.ts`, same shape, same "read the committed file at deploy
   time"), and a test that fails on an unknown email, a malformed budget, a
   duplicate `reset_duration`, an override that names a key the merge does not
   understand, and an `inherit` anywhere it cannot be honoured. Touches
   `deploy-workbench/` only. Nothing reads it yet. Proves: the documents are
   reviewable, the merge is testable without a gateway, and a bad override fails
   a run rather than a tick.
3. **The reconciler's diff-and-apply loop, extending the janitor.** The desired
   state, the `GET`-then-diff, the complete-set composition for every `PUT`
   (`provider_configs` is a replacement set), the applied/changed counts, and the
   `ssm:GetParameter` grant on the three parameters with the two janitor tests
   that assert its absence rewritten. `rate_limit` in the shape with no default,
   budgets with `calendar_aligned: true`. In the janitor's core module, tested
   against fake gateway and directory objects, which is how
   `bifrost/vk-janitor-core.ts` already works. Proves: a changed budget converges
   on a fake key, an unchanged one produces no `PUT`, and a roster member with no
   key produces no key.
4. **The two triggers and the deploy's poll.** `rate(5 minutes)` on the existing
   rule, and the `RequestResponse` invoke plus poll in `deploy-workbench.yml`
   under the `pulumi-deploy` hop the existing post-apply check already makes, so
   no new IAM is needed. A throttled invoke (429, `TooManyRequestsException`, from
   the `reservedConcurrentExecutions: 1` cap colliding with a scheduled tick) is
   retried with backoff for a window pinned above the function's timeout, and
   only a run that ran and did not converge fails the deploy. Also the
   config-convergence half of the loop, which is only reachable once the invoke
   exists. Proves: an edit to `config.json`'s live subset reaches the running
   task inside one deploy run with the same task ARN, a deliberately broken
   convergence fails the run, and a tick that is already running when the deploy
   invokes does not fail the run.

   **Two PRs, and the order is load-bearing.** The step lands as A then B rather
   than as one change:

   - **4a, `deploy-workbench/` and this document.** The poll
     (`scripts/verify-convergence.ts`), the timing contract
     (`bifrost/vk-janitor-contract.ts`), the scheduled rule at five minutes, the
     config-convergence half, and the handler's reply shape. This tree is
     de-owned, so it merges on the delegate reviewer's approval.
   - **4b, `.github/workflows/deploy-workbench.yml` only.** The converge step and
     the job's `timeout-minutes` going 20 → 30. `.github/workflows/` stays human
     code-owner owned on purpose: OIDC trust keys on the ref rather than the
     filename, so a workflow added on `main` can assume the deploy roles, and
     the file that decides what runs with a credential keeps a human behind it.
     De-owning it to make this step merge faster would be the security change
     the opt-out list's own rules say needs a human reviewer, and the list is
     deliberately as short as it is.

   The order is not a convenience. The step runs
   `scripts/verify-convergence.ts`, so a B that landed before A would call a
   script that is not on `main`. The script is inert until the workflow calls
   it, which is what makes A safe to merge on its own: nothing in
   `deploy-workbench/` invokes it in production until B lands. `Plan:`/`Step:` in
   both PR bodies name this step, so the status gate reads one step from two
   PRs; A's body says the workflow moved to B and why, so a reader who expected
   one PR is not left guessing.
5. **The minter applies overrides at create.** `bifrost/vk-mint-core.ts` and its
   handler compute the same desired state for the caller's email, so a new key
   starts converged and the first reconciler tick has nothing to do. Proves: a
   mint for an overridden email produces a key the reconciler then reports as
   unchanged.
6. **The alarm, the runbook and the document corrections.** Three-consecutive-
   failure alarm on the reconciler (a CloudWatch alarm on the function's errors,
   with the notification wiring the account already uses for spend alerts), the
   `runbooks.md` entry that answers it, the `bifrost-virtual-keys.md`
   "Deferred"/"Update accepts only" corrections this plan makes true, the
   gateway plan's "Persistence, backup and upgrade" amendments (this PR's, kept
   consistent), its phase item 10 sentence about the digest being what makes an
   edit roll the task (true when written, false once step 1 lands), the
   `config.json` size figures in `ecs.ts` and
   `deploy-workbench/bifrost/README.md`, including that README's paragraph on
   the digest, which still says a change to the file rolls the task. `docs/` is
   human-owned, so the doc half is a review of its own; the code halves ride in
   the PRs that made them necessary where possible. Proves: no document still
   describes the whole-file digest as the seam, and the alarm has an answer
   written down.

## Cited so the next session can check

In this repository:

| Fact | Where |
|---|---|
| The digest hashes the whole file today | `deploy-workbench/ecs.ts`, `bifrostConfigVersion` (`:645-657`); the env entry at `:1291-1294`; the comment block at `:605-636` |
| `providers` is a mixed section: `keys[].value` is a reference, `keys[].aliases` and the rest are plain config | `deploy-workbench/bifrost/config.json`; `deploy-workbench/bifrost/config.test.ts`, "references every credential by a name the deployment actually provides" |
| A config change rolls the task, and why that seam was added | commit `75d30ae`; `deploy-workbench/ecs.test.ts`, the `BIFROST_CONFIG_VERSION` assertions |
| The parameter is a `String`, standard tier, 4 KiB | `deploy-workbench/ecs.ts:590-593`; `:1074-1085` |
| `config.json` is 3,794 bytes and its `governance` block holds only `auth_config` | `deploy-workbench/bifrost/config.json` (`wc -c`) |
| The template is 704 bytes and stored as `/bifrost/vk-mint-template` | `deploy-workbench/bifrost/vk-mint-template.json`; `deploy-workbench/bifrost-vk-mint.ts:100`, `:383-392` |
| The mint reads the template with `ssm:GetParameter` | `deploy-workbench/bifrost/vk-mint-handler.ts:394-399`; the grant at `bifrost-vk-mint.ts:236-239` |
| The janitor's interval, timeout, concurrency and its schedule | `deploy-workbench/bifrost-vk-janitor.ts:99`, `:107`, `:120`, `:389-421` |
| The janitor's VPC attachment, Cloud Map name and setup-token read | `bifrost-vk-janitor.ts:232-320`, `:180-189`; `deploy-workbench/discovery.ts:56-66`; `network.ts:89` |
| The janitor's IAM deliberately excludes SSM, and two tests assert it | `bifrost-vk-janitor.ts:150-197`; `deploy-workbench/bifrost-vk-janitor.test.ts:233-245`, `:258-263` |
| The admin client is already written, with the setup-token header | `deploy-workbench/bifrost/vk-janitor-handler.ts:197-283` |
| The key name is the lowercase email, and the mint lowercases it | `docs/bifrost-virtual-keys.md`, "The key name is the lowercase email"; `bifrost/vk-mint-core.ts:190`, `:265` |
| The marker that makes a key Lambda-managed | `deploy-workbench/bifrost/vk-marker.ts`, `isManagedKeyDescription` |
| The workflow runs on `ubuntu-latest` and its post-apply checks hop roles | `.github/workflows/deploy-workbench.yml:86`, `:332-368`; `deploy-workbench/scripts/verify-service.ts`; `scripts/aws-role.ts` |
| The first-hop CI role has no `lambda:*`; the deploy role is admin | `deploy/components/ci-roles/policies.ts:926-952`; `deploy-workbench/deploy-role.ts:66-127` |
| The knobs kept from #437 | `deploy-workbench/ecs.ts:270`, `:1265-1266`, `:1516-1522` |
| Target-group timing and the 2026-10-26 measurement | `deploy-workbench/ingress.ts:262-284`, `:311-314` |
| Per-key budgets were deferred on #404 | `docs/bifrost-virtual-keys.md`, "Deferred"; `docs/bifrost-gateway.md`, "Budgets and alerts" |
| The old plan's assumption about the update path, which this plan corrects | `docs/bifrost-virtual-keys.md`, "Cited so the next session can check" (the `UpdateVirtualKeyRequest` row) |
| The archived plan, kept as evidence | `docs/archived/bifrost-zero-downtime-deploys.md` |
| The spend-alert wiring an alarm would join | `deploy-workbench/index.ts:290-352`; `deploy-infrastructure/group-sync-lambda.ts:355-400` (the topic and its CloudWatch policy) |

In Bifrost, at the pinned tag `transports/v2.3.2` (commit `a05ea20`):

| Fact | Source |
|---|---|
| `PUT /api/config` takes only `client_config`, `framework_config` and `auth_config`, field-wise | `transports/bifrost-http/handlers/config.go:312-339`, the "only when explicitly provided" rule at `:867`, the reload at `:940` |
| Some client fields still record a restart request | `config.go:714-739`, `:780`, `:1225-1230`; the live reload at `transports/bifrost-http/server/server.go:1580-1614` |
| `PUT /api/providers/{provider}` is a genuine partial update | `handlers/providers.go:188` (`providerUpdatePayload`), `:202-219` ("Omission means leave this alone"), `:220`; route at `:251` |
| Provider key update preserves fields the body omits, including aliases | `handlers/provider_keys.go:499-533`; route at `providers.go:252` |
| Aliases persist in the key row | `framework/configstore/tables/key.go:33`, `:134`, `:1111-1119` |
| The model catalog has an update route that reloads pricing | `providers.go:265`, `:1774-1794`; `framework/modelcatalog/datasheet/cost.go:2467-2487` |
| The virtual-key update route and its request shape | `handlers/governance.go:1816`, `:429-471`, `CreateBudgetRequest` at `:564-572` |
| The update is live before it answers | `governance.go:3031` (`ReloadVirtualKey`), and the calendar-alignment adoption at `:3048-3058` |
| Budget reconciliation matches on id or `reset_duration` and preserves usage | `governance.go:756`, `:777`, `:904`, `:838-848`; `framework/configstore/rdb.go:5934-5945` |
| `provider_configs` is a replacement set, and omitted entries are deleted | `governance.go:2667-2872`, `:2860-2871`, `:1717-1729`; per-model pruning at `:1076-1127`; the `key_ids` exception at `:2797-2820` |
| Budget enforcement reads in-memory usage with a nil baseline | `plugins/governance/store.go:2172-2200`, `:1462`, `:5094-5110`; `plugins/governance/resolver.go:226` |
| Usage is dumped as an absolute snapshot every 10s, and on shutdown | `plugins/governance/tracker.go:97`, `:258`, `:441`; `plugins/governance/store.go:3016` (`current_usage = v.cu`), `:3167` |
| `calendar_aligned` snaps a window to the calendar | `governance.go:454`; `framework/configstore/tables/budget.go:220-239`, `:260-273`; `plugins/governance/store.go:2542` |
| `source_of_truth: "config.json"` makes declared sections authoritative and prunes the rest | `transports/config.schema.json:61-69`; `transports/bifrost-http/lib/config.go:454-459`, `:4752-4789` |
| `encryption_key` and `setup_token` are boot-time | `transports/config.schema.json:70-73`; `lib/config.go:6739-6747` |
| An `env.` reference resolves through the process environment | `core/schemas/secretvar.go:117-135` (and the reference forms at `:22-32`) |
| A budget duration is validated, and duplicates are refused | `governance.go:905-919` |
| There are 66 config-store tables at this tag | `framework/configstore/tables/`, 66 `TableName()` methods |

Outside the two repositories:

| Fact | Where |
|---|---|
| Parameter names are `a-zA-Z0-9_.-` with `/` for hierarchy, and `@` is not allowed | AWS Systems Manager `PutParameter` API reference, "Naming Constraints" |
| Standard parameters hold 4 KB and are free; advanced hold 8 KB and incur a charge | same page, the `Tier` parameter description |
| Roughly $0.05 per advanced parameter per month | AWS's Parameter Store pricing page, by way of secondary summaries; **not read from the pricing page itself** |
| An oversize value is rejected rather than truncated | not provoked; the 4 KB figure is what the API reference documents, and the exact error is left to step 2 |
| A duplicate Lambda permission statement id is a `409` `ResourceConflictException` | Lambda `AddPermission` API reference, "ResourceConflictException: the resource already exists" |
| Pulumi generates a statement id when one is not given | `@pulumi/aws` 7.x, `lambda.Permission`'s `statementId` description |
