# Bifrost model aliases: `coordinator-default` and `worker-default`

> **Status: proposal, decisions settled in review. Nothing has been
> implemented.** This is the plan for the gateway to own which model a
> `gp-pi` coordinator and its workers run on by default, as two named aliases
> instead of model ids hard-coded in the container. It is a sibling of
> [`bifrost-gateway.md`](./bifrost-gateway.md), which is the gateway's plan, and
> [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md), whose mint this plan
> changes. It changes no code and no infrastructure. Implementation PRs follow,
> and a PR names this document and the step it implements in its body; progress
> is derived from those PRs and is not written here (decision 11 of
> [`plan-gated-merges.md`](./plan-gated-merges.md)).

`gp-pi` currently names a model by its provider id in three places: the worker
default in `gp-delegate` (`WORKER_MODEL`,
`bifrost/accounts/fireworks/routers/deepseek-v4p1-flash-1017-us`), the root
pane's saved default in `settings.json`, and the launcher's environment. Two of
those carry a **residency-bearing id** (`-us`, a US-only Fireworks router) that
the container cannot verify and the gateway enforces. When a model is renamed,
retired or repointed, the change is a `gp-pi` release plus an `ops` change, in
that order, and the gap between them is a worker that dies on its first prompt
or, worse, one that quietly runs on something else.

That second failure has already happened. `gp-delegate` checks its default with
`pi auth check` and falls back to the engineer's saved model when the check does
not pass. The check cannot pass for a gateway model: `pi auth check` builds its
runtime without loading `gp-bifrost.ts`, so the `bifrost` provider is
`provider_not_found` every time. The fallback is then the saved model, and the
saved model in a fresh volume is whichever gateway model sorts first. A worker
was observed running a whole research brief on `bedrock/us.anthropic.claude-haiku-5-5`
for exactly that reason.

The gateway already has the right primitive. Bifrost's **key aliases** map a
short name to a provider model id on the provider key, and the gateway lists
them in `/v1/models`. `gp-pi` can then pin two names and nothing else.

## Objective and success criteria

Make "which model is the default" a gateway decision that is changed in one
reviewed edit in this repository, and reaches every container without a
`gp-pi` release.

Success, in the order it should be proven:

1. **Two names, no ids.** `gp-pi` pins `bifrost/coordinator-default` and
   `bifrost/worker-default`, and no residency-bearing model id remains in it.
2. **Repointing is one ops PR.** Changing what a name resolves to edits
   `deploy-workbench/bifrost/config.json` and reaches an *existing* engineer's
   key and container without a re-issue, a script or a `gp-pi` change.
3. **Residency stays a property of the deployment.** A test in this repository
   fails if either alias target is not a US-only model the gateway allows.
4. **A missing alias is a loud refusal.** `dispatch` stops with a message that
   names the alias. It never starts workers on a different model.
5. **Cost and context are right.** A request through an alias is priced and
   logged as the model it resolves to, and `/v1/models` describes it with that
   model's context window rather than pi's default (gate 1).

## What exists, verified

Everything below was read from code, not recalled. The gateway facts are from
`maximhq/bifrost` at the pinned tag `transports/v2.3.0`
([`bifrost-gateway.md`](./bifrost-gateway.md), "Upstream basis and version");
the `gp-pi` facts are from the installed copies of its helpers
(`/usr/local/bin/gp-delegate`, `/usr/local/bin/gp-bifrost-key`,
`/etc/gp-pi/pi/extensions/gp-bifrost.ts`), because the repository was not
checked out where this was written.

**Aliases at the pinned tag.**

- An alias lives on a provider **key**, `providers.<p>.keys[].aliases`, not on a
  virtual key. `core/schemas/account.go` has `Key.Aliases KeyAliases`, whose
  values are `AliasConfig{ model_id, model_name, model_family, description,
  region, ... }`. The legacy string form (`"name": "wire-id"`) also parses.
  Virtual keys (`CreateVirtualKeyRequest`) have no `aliases` field.
- Routing resolves the alias per attempt (`k.Aliases.ResolveConfig` in
  `core/bifrost.go`) **after** key selection, and key selection checks the
  *requested name* against the key's `models` (`keySupportsModel`; the comment at its call site in `core/bifrost.go` says
  "`key.Models` and `key.BlacklistedModels` must therefore be expressed in
  alias keys"). So an alias name must appear in the key's `models`
  allowlist, and in the virtual key's `allowed_models`.
- `/v1/models` surfaces the alias. For Fireworks the list is built from config,
  not from the provider (`core/providers/fireworks/fireworks.go`,
  `listModelsByKey`), and `BackfillModels` appends each allowlist entry that
  has an alias with `Alias` set to the wire id. The governance plugin then
  filters the listing against the virtual key (`filterModelsForAccess`), again
  by the listed name. `gp-bifrost.ts` reads `/v1/models` and so needs no
  change to see an alias.
- The response carries both names. `BuildRoutingInfo` fills
  `RoutingInfo.ResolvedKeyAlias` (`ModelID`, `ModelName`), so `dispatched` can
  print `worker-default -> accounts/fireworks/routers/deepseek-v4p1-flash-1017-us`.
- **Request cost** resolves in the order server-side fallback model,
  **`AliasModelName`**, `AliasModelID`, requested name
  (`framework/modelcatalog/datasheet/cost.go`, `resolvePricing`). Without
  `model_name` an alias whose wire id is unknown to the catalog is priced by
  neither.
- **`/v1/models` enrichment does not read `model_name`.**
  `enrichListModelsResponse` (`transports/bifrost-http/handlers/inference.go`)
  looks up the listed name (`worker-default`) and then the `Alias` value, which is
  the *wire id*. So whether the listing carries a price and a context window
  depends on the wire id having a catalog row, and the router id the gateway
  runs today does not (next bullet). `gp-bifrost.ts` then gives the model pi's
  defaults: cost 0 and a 128 000 context window, for a model whose catalog row
  says 1 048 576. Cost *attribution* in the gateway is right either way; what
  pi shows and compacts against is the part at risk. See gate 1.
- **The pricing catalog has no row for the router id the gateway runs today.**
  The upstream datasheet carries
  `fireworks_ai/accounts/fireworks/models/deepseek-v4p1-flash-1017-us`
  (US-only price, $0.45 in / $1.80 out per 1M) and
  `.../routers/deepseek-v4p1-flash-us`, but not
  `.../routers/deepseek-v4p1-flash-1017-us`. That is the row
  [`bifrost-gateway.md`](./bifrost-gateway.md) item 16 already expects to need an
  override for; for request cost, `model_name` pointing at the
  `models/...-1017-us` row is the cheaper answer and uses the catalog's own
  US-only price.
- Static aliases only. Dynamic and tiered aliases are upstream discussion #945
  and post-date the pinned tag.

**The mint does not converge.** `deploy-workbench/bifrost/vk-mint-core.ts`
applies `vk-mint-template.json` when it *creates* a key. For an existing key,
`mintVirtualKey` calls `settleExisting`, which returns the key unchanged unless
it is inactive or carries an expiry (`needsReactivation`). So editing the
template, today, changes nobody who already has a key, and the 12-hour cache TTL
in `gp-bifrost-key` is unrelated: it bounds "the key value went stale", not "the
key's shape went stale". Waiting never helps.

**`gp-pi` discovers models from `/v1/models`**, which is scoped to the key's
allowlist, and caches the key for 12 hours in `~/.pi/agent/bifrost-key.json`.
`gp-bifrost.ts` registers whatever the gateway lists and gives any field the
gateway omits pi's conservative default (context 128 000, cost 0). The cached
key still *authorizes* a newly added alias, because the alias resolves at the
gateway per request; what it cannot do is *discover* it, since a key whose
allowlist predates the alias does not list it.

## Decisions

Settled in review; the section after this one is the work they produce.

1. **Two aliases, named `coordinator-default` and `worker-default`.** The
   codebase says "coordinator" throughout (`gp-coordinator.ts`,
   `~/.pi/agent/coordinator-off`, the `gp-pi:coordinator` AGENTS.md blocks, the
   system prompt's "You are the coordinator"); "conductor" would be a third word
   for the same role in every picker and every `dispatched` line.
2. **`gp-pi` pins alias names, not model ids.** The residency guarantee moves
   to this repository, which already owns the lists that enforce it. Local
   configuration may still override the default, as it does today with
   `--model` and `GP_PI_WORKER_MODEL`.
3. **No auth check and no fallback.** `pi auth check` is removed from
   `dispatch`: it cannot validate an extension-registered provider, so removing
   it removes no safeguard. One cheap assertion stays: the alias appears in
   `pi --list-models` (`worker_model_is_offered()` already does this), and its
   failure **refuses** the batch with a message that names the alias, rather
   than falling back. With a guaranteed alias there is no case for a fallback.
4. **The mint converges.** When a key exists, the mint reads its
   `provider_configs`, compares them to the template, and `PUT`s on drift. It
   ships **with** the alias work, not after it: without it the first rollout is
   a hand-written backfill script, and the next template change needs another.
5. **A template version stamp forces propagation past the 12-hour TTL.** The
   mint returns a `template_version` (a hash of the template as the mint
   applied it). `gp-bifrost-key` stores it with the cached key and, when the
   current version differs from the cached one, re-mints immediately and
   bypasses the TTL. The reason is *discovery*, not authorization: the cached
   key authorizes a new alias, but `/v1/models` is scoped to the key's
   allowlist, so a container never sees the alias until its key is re-minted.
   How a container learns the current version without a mint on every cache hit
   is the one open mechanism question; see "How a container learns" and
   work item G.
6. **No rollback story beyond repointing.** Moving an alias target back is one
   reviewed edit and the converging mint carries it out. A named
   `*-default-prev` alias is out of scope.
7. **Static 1:1 aliases.** Each alias maps to one wire id. The upgrade path to
   dynamic or tiered aliases (discussion #945) is a gateway upgrade and a
   `config.json` change, and needs nothing from `gp-pi`.

## Design

### Where the aliases are declared

In `deploy-workbench/bifrost/config.json`, on the key of the provider that
serves each default, in the rich form so `model_name` can be set:

```jsonc
"fireworks": { "keys": [ {
  "name": "fireworks-primary",
  "models": [
    "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
    "worker-default"
  ],
  "aliases": {
    "worker-default": {
      "model_id": "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
      "model_name": "accounts/fireworks/models/deepseek-v4p1-flash-1017-us",
      "description": "gp-pi worker default"
    }
  }
} ] }
```

and `coordinator-default` on the Bedrock key, with a `us.` inference profile as
`model_id`. The coordinator's target is **not decided here**: the implementation
PR names it and the engineer approves it in review (see "Decisions still needed").

The alias name is in `models` because key selection checks the requested name
against it. The raw target stays in `models` as well, so that explicit
`--model bifrost/<id>` choices, which `gp-delegate`'s help advertises, keep
working. The cost is that the picker lists both names; that is accepted, and the
alias carries a `description` so it is recognisable.

### The key template and the converging mint

`vk-mint-template.json` adds the alias names to the matching provider's
`allowed_models`. The mint then changes in two ways, both in
`vk-mint-core.ts`, which already holds every decision the mint makes:

- `settleExisting` fetches the key's `provider_configs`, compares the
  allowlists with the template's per provider (order-insensitive, as the
  existing equality test treats them), and `PUT`s the template's
  `provider_configs` when they differ. Reactivation and convergence are one
  `PUT` when both apply. `MintAction` gains `"converged"`, which the handler
  already logs as the outcome.
- `MintResult` carries `template_version`, and the handler returns it with the
  key. The handler already reads the template on every call, so the hash costs
  nothing extra.

Convergence touches only `provider_configs`. It never edits `name`,
`description`, budgets, a team or any field a human may have set on a key, for
the same reason decision 4 of the virtual-keys document never deletes one.

### How a container learns

`gp-bifrost-key` caches `template_version` beside `key` and `fetched_at`. The
version is only known to the mint, and a cache hit makes no mint call by design
(the hot path runs on every request). So the stamp is useful at the points where
the container *already* talks to something that can tell it, and there is no
such signal at v2.3.0 in the `/v1/models` response itself. What is settled:

- a cache entry with **no** `template_version` (every entry written before this
  change) is treated as stale and re-minted once, which bootstraps every existing
  container with no other mechanism;
- thereafter a mismatch re-mints immediately, whatever the TTL says.

What is **not** settled is the check that detects a mismatch between mints.
Candidate mechanisms, none chosen here: the catalog refresh in `gp-bifrost.ts`
(which already calls the gateway and already knows which two alias names it
requires) re-mints once when a required alias is missing from the listing; or
the key helper calls the mint at an interval shorter than the TTL, which is the
load the TTL exists to avoid. Item G's PR chooses and records why. The
first is a discovery check and needs no stamp; the stamp is what lets the second
be cheap.

### Residency becomes an ops test

`config.test.ts` and `vk-mint-template.test.ts` assert today that every model
id in the key and the template is a `-us` router or a `us.` profile. The alias
names are not model ids and must not be asserted that way, so the tests grow a
second path instead of a looser first one:

- for every alias in `config.json`, `model_id` is itself in the key's `models`
  and satisfies the same US-only rule as a model id (`-us` router on
  Fireworks, `us.` profile on Bedrock);
- `model_name` is non-empty on every alias, because without it cost attribution
  is wrong;
- the alias names are exactly `coordinator-default` and `worker-default`, so a
  rename cannot silently strand `gp-pi`;
- `vk-mint-template.json` allows each alias name for the provider whose key
  declares it, and the existing "allows exactly the models `config.json`
  allows" equality is amended to be over `models`, not over `models` minus
  aliases.

This is the test the whole exercise exists to add: today `gp-pi` carries a
residency id nothing in this repository can check.

## Work breakdown

Ordered. Items A to D are this repository; E to H are `gp-pi`. **C is a
prerequisite of rollout**, not an optimisation: nothing in E to H may ship
before it is deployed.

**ops**

- **A. Declare the aliases.** Add `aliases` and the alias names in `models` to
  `config.json`; add the alias-aware assertions to `config.test.ts`. Resolve
  the Bedrock coordinator target. No behaviour changes for anyone until the
  template follows.
- **B. Template the aliases.** Add the alias names to `vk-mint-template.json`
  and the second assertion path to `vk-mint-template.test.ts`. Safe to merge
  with A: a key that allows a name the gateway does not know is a `404` on that
  name only, so A and B land in the same PR or A first.
- **C. Converge on mint.** `settleExisting` diffs and `PUT`s; `template_version`
  in the result and in the Lambda response; tests in `vk-mint-core.test.ts`
  for drift, no drift, drift plus reactivation, and a `PUT` that fails (the key
  the caller already holds must still be returned unchanged, as reactivation
  already guarantees).
- **D. Confirm enrichment against the live gateway** (see "Gates" 1). Not code;
  recorded in the PR.

**gp-pi** (a separate repository; read-only for this plan)

- **E. Pin the names.** `gp-delegate`: `WORKER_MODEL='bifrost/worker-default'`;
  the root-pane default moves to `bifrost/coordinator-default`.
- **F. Drop the check and the fallback.** Remove `pi auth check` and the
  silent fallback from `dispatch`; keep `worker_model_is_offered()` and make
  its failure a refusal that names the alias and `pi --list-models`. Update the
  `design.md` entry that records the fallback as settled.
- **G. Honour the version stamp.** `gp-bifrost-key` stores
  `template_version`, treats an entry without one as stale, and re-mints on a
  mismatch. The between-mints detection mechanism is chosen in this PR (see "How
  a container learns"); until it is, only the bootstrap re-mint and `--refresh`
  propagate.
- **H. Print both names.** `dispatched` and the registration record show
  `worker-default -> <resolved id>` from `ResolvedKeyAlias.ModelID`, which keeps
  design.md's "which model ran" property without re-pinning an id. Migrate
  `settings.json`: the `bifrost-only` change retires the old providers but does
  not migrate a saved `defaultModel`, so an existing volume still pins a retired
  Fireworks id and a fresh volume starts on whichever gateway model sorts first.

## Gates

1. **Enrichment (gate for E, not an assumption).** By source, request cost is
   right (`model_name`) but the `/v1/models` entry for `worker-default` is
   enriched from the listed name and the wire id only, and the wire id has no
   catalog row, so the listing is expected to carry no price and no context
   window. This was read from source and **not confirmed against a live
   gateway**. Before E merges, list models with a minted key and record what
   `worker-default` returns. If the context window is missing, pi would compact a
   million-token model as if it had 128 000, and the fix is on the gateway side
   (give the wire id a catalog row, for example through a custom `pricing_url`
   datasheet, or pick a `model_id` that has one without losing the `-us`
   guarantee), not in `gp-pi`.
2. **Convergence before pins.** C is deployed, and an existing engineer's key
   has been observed to gain the aliases without a re-issue, before E ships.
3. **Residency test red/green.** The new assertions fail when an alias targets
   a non-US id and pass on the real file, shown in the A PR.
4. **Refusal, not fallback.** With the alias removed from a key in a throwaway
   gateway or a faked `pi --list-models`, `dispatch` exits non-zero and starts no
   worker. Shown in the F PR.
5. **Cost reconciliation.** Item 16 of the gateway plan (a week against the
   provider's bill) covers the alias number the same as the model's.

## Rejected alternatives

- **Pin ids in `gp-pi`, as today.** Keeps the residency id in a repository that
  cannot check it, and makes every model change two merges in two repositories.
- **A model-id allowlist in `gp-pi` that it validates against.** A second list
  that drifts from the gateway's, which `gp-bifrost.ts` already refuses to keep.
- **Keep `pi auth check` and fix it.** It builds its runtime without loading
  extensions, so it cannot see the `bifrost` provider; making it do so is a pi
  change, and the assertion that matters (the alias exists) is already one
  `--list-models` call.
- **Keep the fallback to the saved model.** It is the failure that started this:
  silent, and on a model nobody chose.
- **A migration script instead of converge-on-mint.** Fixes today's drift and
  leaves the next one; the template would keep being a create-time suggestion.
- **Shorten the 12-hour TTL.** A permanent Lambda and STS load on every engineer
  to solve a rare event, and it does nothing for config drift, which is not
  TTL-related.
- **A cache-namespace bump** (a versioned cache filename). The same idea as the
  version stamp, but cruder: it re-mints everyone on any `gp-pi` release rather
  than on a template change.
- **Gateway-side deactivation of every managed key** to force a re-mint. Works
  through the existing janitor and every request `401`s until it does; it is a
  hard cutover and it also depends on converge-on-mint, since reactivation sets
  only `is_active` and the expiry. Right for revocation, wrong for rollout.
- **`--refresh` as policy.** Per-container and manual. It stays as the
  documented repair for a `401`.
- **`coordinator-default-prev` for rollback.** Repointing is one cheap edit, and
  a second alias doubles the names every picker shows.
- **Dynamic or tiered aliases.** Not in the pinned tag; static ones do the job.

## Out of scope

- Implementation of any item above; this document only records the plan.
- Any edit to `gp-pi`. Items E to H are described so that repository's PRs can
  name this one; nothing here changes it.
- Per-person or per-tier aliases (who may use the higher-grade models), which is
  already deferred in [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md).
- Overlap-window key rotation. A leaked key wants immediate revocation, which the
  janitor and gateway-side deactivation already provide.
- Budgets and rate limits, dropped on #404.
- A change to the Bedrock IAM or to `utils/bedrock-models.ts`. The coordinator
  alias targets a model already in both lists.
- Upgrading the gateway to a release with dynamic aliases.

## Decisions still needed

1. **The coordinator's target model.** The discussion fixed the names and the
   mechanism but not the Bedrock model behind `coordinator-default`. Candidates
   are the models already in the allowlist; this plan does not choose one, and
   item A's PR must.
2. **The between-mints version check** (item G), per "How a container learns".
3. **Whether the root pane's default is written into `settings.json` by `gp-pi`
   or only offered.** `design.md` records "nothing here writes `settings.json`"
   as a decision; item H would amend it for this one key.
