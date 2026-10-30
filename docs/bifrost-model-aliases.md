# Bifrost model aliases: `coordinator-default` and `worker-default`

> This is the plan for the gateway to own which model a `gp-pi` coordinator
> and its workers run on by default, as two named aliases instead of model ids
> hard-coded in the container. It is a sibling of
> [`bifrost-gateway.md`](./bifrost-gateway.md), which is the gateway's plan, and
> [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md), whose mint this plan
> changes. A PR that implements part of it names this document and the step it
> implements in its body; progress is derived from those PRs and is not written
> here (decision 11 of [`plan-gated-merges.md`](./plan-gated-merges.md)).

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
   `deploy-workbench/bifrost/config.json`. The alias resolves at the gateway on
   every request, so no key, cache or container changes with it.
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
  pi shows and compacts against is the part at risk. See gate 1. The lookup is
  an exact match on the listed name (`datasheet/store.go`,
  `GetPricingEntryForModel`), and the live datasheet has no row for
  `worker-default`, `coordinator-default` or the router id, so those listings
  are bare; only a name that is itself a catalog row, such as
  `accounts/fireworks/models/deepseek-v4p1-flash-1017-us`, enriches.
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
key's shape went stale". Today waiting never helps; once the mint converges, the
next mint after the TTL picks the change up.

**`gp-pi` discovers models from `/v1/models`**, which is scoped to the key's
allowlist, and caches the key for 12 hours in `~/.pi/agent/bifrost-key.json`.
`gp-bifrost.ts` registers whatever the gateway lists and gives any field the
gateway omits pi's conservative default (context 128 000, cost 0). A cached
key whose allowlist predates an alias does not list it, so it cannot discover
the alias until it is re-minted. That happens once, when the aliases are
introduced; afterwards the names are stable and only their targets change.

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
   `--model` and `GP_PI_WORKER_MODEL`. `gp-pi` does not write the
   engineer's `settings.json`, which is theirs; the coordinator default reaches
   the root pane some other way (item H). A model that is not a served name,
   including the raw router id, is not selectable (decision 8).
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
5. **Propagation waits for the TTL.** Because the names are stable and the
   target changes on the gateway, the only event that needs a container to hold
   a different key is the one-time introduction of the aliases. Once the mint
   converges (decision 4), a container picks them up at its next mint, within
   the 12-hour TTL, and there is no version stamp or forced invalidation. The
   other trigger is a rejection: when a model id or alias the container needs is
   missing from its listing or refused by the gateway, it re-mints once and
   retries (item G). `--refresh` stays as the documented manual repair.
6. **No rollback story beyond repointing.** Moving an alias target back is one
   reviewed edit and the converging mint carries it out. A named
   `*-default-prev` alias is out of scope.
7. **Static 1:1 aliases.** Each alias maps to one wire id. The upgrade path to
   dynamic or tiered aliases (discussion #945) is a gateway upgrade and a
   `config.json` change, and needs nothing from `gp-pi`.
8. **The raw router id is not served under its own name.** The wire id is only
   ever an alias's `model_id`. A name whose `/v1/models` entry lacks a context
   window and a price is a trap in the picker even though requests on it work:
   a developer can choose it and get a poor `pi` experience because its metadata
   is off. The key therefore serves three names, all aliases of the one wire id:
   the catalog name `accounts/fireworks/models/deepseek-v4p1-flash-1017-us`
   (the datasheet has a row for it, so it enriches) and the two role names.
   This reverses an earlier version of this plan, which kept the raw target in
   `models` so `--model bifrost/<id>` kept working. It no longer resolves, and
   a developer who wants another model picks one of the served names.
9. **`gp-pi` fills in the role names' metadata from their sibling.** The role
   names list bare (decision 8 does not change that, and Bifrost v2.3.0 gives
   config no way to attach metadata to a name). Every entry the gateway lists
   carries `alias`, the wire id it resolves to, so `gp-bifrost.ts` groups
   entries on it and gives an entry without a context window or price those of
   a sibling that has them (item I). This is lighter than hosting a datasheet
   with extra rows (rejected below), and it is why the catalog-named alias has
   to stay served: it is the enriched sibling the role names copy from.

## Design

### Where the aliases are declared

In `deploy-workbench/bifrost/config.json`, on the key of the provider that
serves each default, in the rich form so `model_name` can be set:

```jsonc
"fireworks": { "keys": [ {
  "name": "fireworks-primary",
  "models": [
    "accounts/fireworks/models/deepseek-v4p1-flash-1017-us",
    "worker-default",
    "coordinator-default"
  ],
  "aliases": {
    "accounts/fireworks/models/deepseek-v4p1-flash-1017-us": {
      "model_id": "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
      "model_name": "accounts/fireworks/models/deepseek-v4p1-flash-1017-us",
      "description": "Catalog name for the US-only router ..."
    },
    "worker-default": {
      "model_id": "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
      "model_name": "accounts/fireworks/models/deepseek-v4p1-flash-1017-us",
      "description": "gp-pi worker default ..."
    },
    "coordinator-default": {
      "model_id": "accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
      "model_name": "accounts/fireworks/models/deepseek-v4p1-flash-1017-us",
      "description": "gp-pi coordinator default ..."
    }
  }
} ] }
```

All three names start on the same wire id,
`accounts/fireworks/routers/deepseek-v4p1-flash-1017-us`, which appears only as
`model_id`. The two role aliases are separate names so the two roles can be
repointed independently later, and the coordinator is expected to move; that is
one edit here and nothing in `gp-pi`. Aliases may share a `model_id` (the list
pipeline emits one entry per alias).

Every served name is in `models` because key selection checks the requested
name against it, and every served name is an alias, so none is sent to the
provider as itself and none lists without a reason. The router id is deliberately
absent from `models` (decision 8).

### The key template and the converging mint

`vk-mint-template.json` adds the alias names to the matching provider's
`allowed_models`. The mint then changes in `vk-mint-core.ts`, which already
holds every decision the mint makes:

- `settleExisting` fetches the key's `provider_configs`, compares the
  allowlists with the template's per provider (order-insensitive, as the
  existing equality test treats them), and `PUT`s the template's
  `provider_configs` when they differ. Reactivation and convergence are one
  `PUT` when both apply. `MintAction` gains `"converged"`, which the handler
  already logs as the outcome.

Convergence touches only `provider_configs`. It never edits `name`,
`description`, budgets, a team or any field a human may have set on a key, for
the same reason decision 4 of the virtual-keys document never deletes one.

### How a container learns

It waits for its cache. A cached key is re-minted at the 12-hour TTL, and the
converging mint gives the new key the aliases. Nothing in the key helper changes
for that.

Two rejections shorten the wait, both in `gp-pi` because the key helper runs
before the request and cannot see a refusal (its own header says so):

- the catalog refresh in `gp-bifrost.ts`, or `dispatch`'s alias assertion,
  finds a required alias missing from `pi --list-models`;
- the gateway refuses a model id or alias with a "not allowed" or "not found".

Each triggers one `gp-bifrost-key --refresh` and one retry, bounded by the
helper's existing five-second failure cache so a gateway that is down is not
turned into a mint per prompt. If the retry still fails, `dispatch` refuses
(decision 3). The exact hook for each is item G's to choose.

### Residency becomes an ops test

`config.test.ts` and `vk-mint-template.test.ts` assert today that every model
id in the key and the template is a `-us` router or a `us.` profile. The alias
names are not model ids and must not be asserted that way, so the tests grow a
second path instead of a looser first one:

- for every alias in `config.json`, `model_id` satisfies the same US-only
  rule as a model id (`-us` router on Fireworks, `us.` profile on Bedrock), and
  is not itself a served name (decision 8);
- `model_name` is non-empty on every alias, because without it cost attribution
  is wrong;
- the two role names `coordinator-default` and `worker-default` exist, so a
  rename cannot silently strand `gp-pi`; other aliases (the catalog name) are
  allowed, so this asserts presence, not equality;
- every served Fireworks name is an alias with a non-empty `model_name`, and
  every name that is not itself a catalog row shares its `model_id` with an
  enriched, catalog-named sibling, so a name with degraded metadata and nothing
  to copy from cannot be served (decisions 8 and 9);
- `vk-mint-template.json` and `config.json` agree on which provider declares
  each alias, so moving a target to another provider is one reviewed change in
  both places;
- `vk-mint-template.json` allows each alias name for the provider whose key
  declares it, and the existing "allows exactly the models `config.json`
  allows" equality is amended to be over `models`, not over `models` minus
  aliases.

This is the test the whole exercise exists to add: today `gp-pi` carries a
residency id nothing in this repository can check.

## Work breakdown

Ordered. Items A to D are this repository; E to I are `gp-pi`. **C is a
prerequisite of rollout**, not an optimisation: nothing in E to I may ship
before it is deployed.

**ops**

- **A. Declare the aliases.** Add the role aliases and their names in `models`
  to `config.json`, beside the catalog-named alias that is the only other
  served name; add the alias-aware assertions to `config.test.ts`. No
  behaviour changes for anyone until the template follows.
- **B. Template the aliases.** Add the alias names to `vk-mint-template.json`
  and the second assertion path to `vk-mint-template.test.ts`. Safe to merge
  with A: a key that allows a name the gateway does not know is a `404` on that
  name only, so A and B land in the same PR or A first.
- **C. Converge on mint.** `settleExisting` diffs and `PUT`s; tests in `vk-mint-core.test.ts`
  for drift, no drift, drift plus reactivation, and a `PUT` that fails (the key
  the caller already holds must still be returned unchanged, as reactivation
  already guarantees).
- **D. Confirm enrichment against the live gateway** (see "Gates" 1): the
  catalog-named entry carries a context window and price, and every entry
  carries `alias`. Not code; recorded in the PR.

**gp-pi** (a separate repository; read-only for this plan)

- **E. Pin the names.** `gp-delegate`: `WORKER_MODEL='bifrost/worker-default'`;
  the root-pane default moves to `bifrost/coordinator-default`.
- **F. Drop the check and the fallback.** Remove `pi auth check` and the
  silent fallback from `dispatch`; keep `worker_model_is_offered()` and make
  its failure a refusal that names the alias and `pi --list-models`. Update the
  `design.md` entry that records the fallback as settled.
- **G. Re-mint on rejection.** On a missing required alias or a refused model
  id, run `gp-bifrost-key --refresh` once and retry, as in "How a container
  learns". No change to the cache format or the TTL.
- **H. Print both names, and leave `settings.json` alone.** `dispatched` and
  the registration record show `worker-default -> <resolved id>` from
  `ResolvedKeyAlias.ModelID`, which keeps design.md's "which model ran"
  property without re-pinning an id. The root pane's coordinator default is
  supplied without writing the engineer's `settings.json` (for instance through
  the per-session environment the launcher already sets for pi); the mechanism is
  `gp-pi`'s to choose. A saved `defaultModel` that pins a retired Fireworks id
  stays the engineer's to change.
- **I. Fill in metadata from the sibling.** `gp-bifrost.ts` groups the entries
  of `/v1/models` by their `alias` field and, for an entry with no context
  window, output cap or price, uses those of a sibling in the same group that
  has them. No model ids; the group is the gateway's own statement that two
  names are one wire id. Ships before E: without it the role names show 128K
  and $0.

## Gates

1. **Enrichment (gate for E, not an assumption).** By source and against the
   live datasheet, request cost is right for every name (`model_name`), the
   catalog-named entry is enriched, and the two role names are listed bare. The
   fix is in `gp-pi` (item I), not on the gateway (decision 9). The gate is the
   live check, before E merges: list models with a minted key and record that
   the catalog-named entry has its context window and price, that every entry
   carries `alias`, and that with item I `pi --list-models` shows the role names
   with the same context window and price. If `alias` is absent from the live
   response, item I has nothing to group on and this decision is reopened.
2. **Convergence before pins.** C is deployed, and an existing engineer's key
   has been observed to gain the aliases (a `gp-bifrost-key --refresh` forces
   the mint) before E ships.
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
- **A template version stamp, or a cache-namespace bump, to force re-mints.**
  The names are stable and targets change on the gateway, so the only event that
  needs a different key is the one-time introduction of the aliases, which the
  TTL and the rejection trigger cover. A stamp adds a protocol between the mint,
  the helper and the cache for a rare event.
- **Gateway-side deactivation of every managed key** to force a re-mint. Works
  through the existing janitor and every request `401`s until it does; it is a
  hard cutover and it also depends on converge-on-mint, since reactivation sets
  only `is_active` and the expiry. Right for revocation, wrong for rollout.
- **`--refresh` as policy.** Per-container and manual. It stays as the
  documented repair for a `401`.
- **`coordinator-default-prev` for rollback.** Repointing is one cheap edit, and
  a second alias doubles the names every picker shows.
- **Dynamic or tiered aliases.** Not in the pinned tag; static ones do the job.
- **Keep the raw router id served.** Its entry lists bare (no datasheet row), so
  it is a pickable name with a 128K window and a $0 price (decision 8).
- **Point the role aliases' `model_id` at the catalog name.** It would enrich
  them, and it would send `models/...-us` to Fireworks, which answers 404 for
  that name; the wire id has to stay the router.
- **A custom `pricing_url` datasheet with rows for the role names.** The URL
  replaces the catalog rather than adding to it, so it means hosting and
  refreshing a full copy of upstream's datasheet for the sake of two rows.
  Item I does the same job with no hosted artefact; revisit only if a client
  other than `gp-pi` needs the listing enriched.

## Out of scope

- Edits to `gp-pi` made from this repository. Items E to I describe the work
  so that repository's PRs can name this plan.
- Per-person or per-tier aliases (who may use the higher-grade models), which is
  already deferred in [`bifrost-virtual-keys.md`](./bifrost-virtual-keys.md).
- Overlap-window key rotation. A leaked key wants immediate revocation, which the
  janitor and gateway-side deactivation already provide.
- Budgets and rate limits, dropped on #404.
- A change to the Bedrock IAM or to `utils/bedrock-models.ts`. Both aliases
  target a model already in the gateway's lists.
- Writing or migrating the engineer's `settings.json`.
- Upgrading the gateway to a release with dynamic aliases.
