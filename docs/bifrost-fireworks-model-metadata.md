# Why the gateway serves no model metadata for Fireworks, and what this repo can fix

> Findings for one observed bug, with the evidence for each hop. It is a sibling
> of [`bifrost-gateway.md`](./bifrost-gateway.md) and changes only
> `deploy-workbench/bifrost/config.json`, the virtual-key template and their tests.
>
> Verified against: transports/v2.3.0

## The bug

`GET https://bifrost.workbench.goodparty.org/v1/models`, with a minted virtual
key, returned eight models on 2026-10-30. The seven Bedrock entries carried
`normalized_name`, `context_length`, `max_input_tokens`, `max_output_tokens` and
`pricing`. The one Fireworks entry was bare:

```json
{"id":"fireworks/accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
 "name":"Accounts/Fireworks/Routers/Deepseek V4p1 Flash 1017 Us"}
```

`gp-pi` maps a missing `context_length` to 128 000, a missing `max_output_tokens`
to 16 384 and a missing price to 0, so `pi --list-models` shows the fleet's only
Fireworks model as 128K context and cost 0. Hop 4 (that mapping) is known good:
the Bedrock entries prove it on live data. `gp-pi` carries no model ids and no
metadata, and nothing here changes it.

## Per-hop verdict

| Hop | Verdict | Evidence |
|---|---|---|
| 1. Fireworks' own `/v1/models` | **Partly present, and not the cause.** | below |
| 2. Bifrost's Fireworks adapter parses it | **Never asked.** The adapter does not call Fireworks. | below |
| 3. The model catalog has a row to enrich from | **This is where it drops.** No row for the router id. | below |

**Hop 1.** Called with the engineer's own Fireworks key on 2026-10-30 (never
printed or stored). `GET https://us.api.fireworks.ai/inference/v1/models` and
the global endpoint both returned HTTP 200 and 29 models, identical bodies.
Each entry has `context_length` (1 048 576 for
`accounts/fireworks/models/deepseek-v4p1-flash-1017`), and the keys are
`context_length, created, id, kind, object, owned_by, supports_chat,
supports_image_input, supports_tools`. There is **no `max_output_tokens` and no
pricing** on any entry. **No `-us` router id is listed at all**, including the
one the gateway serves. Fireworks documents the US routers
(<https://docs.fireworks.ai/serverless/us-only-serverless.md>) but its model
list does not enumerate them. So even a perfect passthrough could deliver a
context window and nothing else, and could deliver that for the base model only.

**Hop 2.** `core/providers/fireworks/fireworks.go` at `transports/v2.3.0`,
`ListModels`/`listModelsByKey` (lines 74-96): "Fireworks serverless has no
usable OpenAI-style /v1/models endpoint ... so models are sourced from config
rather than a live API call". It passes the key's `models`, `blacklisted_models`
and `aliases` to `OpenAIListModelsResponse{}.ToBifrostListModelsResponse` with
an empty response, so every entry comes from `BackfillModels`
(`core/providers/utils/models.go:350-383`), which sets only `ID`, `Name` and
`Alias`. I reproduced it by running `listModelsByKey` from the v2.3.0 checkout
with this repo's key config; it returns exactly the bare entry above.
`ToBifrostListModelsResponse` (`core/providers/openai/models.go:34-48`) would
copy `context_window` from a live response, but this provider never has one.
The upstream passthrough work (issue #8914, PR #9201, both open) is about that
live-response path and is not merged, so it would not reach this provider even
after a bump.

**Hop 3.** The only thing that fills a Fireworks entry is
`enrichListModelsResponse` (`transports/bifrost-http/handlers/inference.go:1119`),
a fill-only backfill: it looks the entry up with
`catalog.GetPricingEntryForModel(<listed name>, fireworks)`, then with the
alias value, and applies `ApplyModelInfo`
(`framework/modelcatalog/modelinfo.go:61`). The catalog is the public
datasheet <https://getbifrost.ai/datasheet> (`DefaultURL`,
`framework/modelcatalog/datasheet/store.go:19`), synced into the config store
every 24 hours. I downloaded it on 2026-10-30 (5 641 rows) and loaded it
through the v2.3.0 `datasheet.Store`:

| Fireworks id | pricing row | context |
|---|---|---|
| `accounts/fireworks/routers/deepseek-v4p1-flash-1017-us` (served) | **none** | |
| `accounts/fireworks/models/deepseek-v4p1-flash-1017-us` | yes, $0.45/$1.80 | 1 048 576 |
| `accounts/fireworks/models/deepseek-v4p1-flash-1017` | yes, $0.30/$1.20 | 1 048 576 |
| `accounts/fireworks/routers/deepseek-v4p1-flash-us` | yes, $0.45/$1.80 | 1 048 576 |

The catalog has the model under three neighbouring ids and not under the exact
router id the gateway serves and the residency test requires. Lookup is an exact
match on `model|provider|mode` (`datasheet/store.go:182`), so a near miss is a
miss. That is the whole bug. The seven Bedrock `us.*` profiles each have a row
(`bedrock/us.moonshotai.kimi-k3` and the other six), which is why they are rich.

Catalog sync URL: `framework.pricing.pricing_url` is a supported config.json key
(and accepts `file://`, `datasheet/sync.go:187`), so issue #3238's "hardcoded,
no override" is out of date for the pricing datasheet at this tag. It is the
heavy hook (replace the whole catalog), and I did not use it; see "Not chosen".

## What the same gap does to cost

Cost is the quieter half. With no row, `resolvePricing`
(`datasheet/cost.go:2229`) finds no base price, falls to "override-only
pricing", finds none and returns nil, so the request is logged with cost 0 and
no error. Reproduced on the v2.3.0 code: 1M input + 1M output tokens on the
served router id prices at **$0** with the catalog alone. The gateway's per-key
cost attribution has been recording zero for every Fireworks request.

## What changed

Two things in `deploy-workbench/bifrost/config.json`, one for each symptom.

**1. A catalog-named alias, for the listing (the DX fix).** `/v1/models` is
enriched by the *listed name*, then by the alias's wire id. The datasheet has a
row for `accounts/fireworks/models/deepseek-v4p1-flash-1017-us` and none for
the router id. So the key now also serves that name, as a key alias whose
`model_id` is the router:

```
models:  [ routers/deepseek-v4p1-flash-1017-us, models/deepseek-v4p1-flash-1017-us ]
aliases: models/deepseek-v4p1-flash-1017-us -> model_id routers/deepseek-v4p1-flash-1017-us
```

Run on the v2.3.0 code (`listModelsByKey`, then the same lookup and
`ApplyModelInfo` the handler uses, over the 2026-10-30 datasheet), the entry
for the alias is:

```json
{"id":"fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017-us",
 "normalized_name":"Deepseek V4.1 Flash 1017 Us",
 "alias":"accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
 "context_length":1048576,"max_input_tokens":1048576,"max_output_tokens":393216,
 "pricing":{"prompt":"0.0000004500","completion":"0.0000018000","input_cache_read":"0.0000000090"}}
```

That is every field `gp-bifrost.ts` reads, with the right numbers, and it needs
**no change to the `gp-pi` extension**: pi gets 1 048 576 / 393 216 and a real
price from the same fields the Bedrock entries use.

Residency is unchanged. The alias resolves *after* key selection
(`core/bifrost.go:8178`) and the provider is sent the router id; Fireworks
answers a request for the `models/...-us` name itself with 404 ("Model not
found"), so the global-looking name cannot be reached by accident. I made that
call with a real key on 2026-10-30: the router id returns 200 and is served by
`deepseek-v4p1-flash-1017`; the `models/...-us` name returns 404. The tests
now check residency against the *wire id*, so an alias pointing at a non-US id
fails them.

**2. A pricing override, for the cost.** The router id has no pricing row, so a
request sent *as the router id* (which is what `gp-delegate`'s worker default
does today) was priced at $0 without an error. One provider-scoped
`governance.pricing_overrides` entry fixes that:

```
provider fireworks, exact accounts/fireworks/routers/deepseek-v4p1-flash-1017-us,
chat_completion + responses + text_completion,
input 4.5e-7, output 1.8e-6, cached input 9e-9 per token
```

These are Fireworks' published base price for this model ($0.30 / $0.006 / $1.20
per 1M) times the 1.5x US-only premium
(<https://docs.fireworks.ai/serverless/pricing.md>, 2026-10-30), which the same
page lists as $0.45 / $0.009 / $1.80. On the v2.3.0 code the same JSON prices 1M
in + 1M out at **$2.25** on chat and on responses, from $0. A request sent as the
alias is priced $2.25 either way, because `model_name` points at the catalog's
own US-only row, which carries the same number. The v2.3.0 config loader parses
both blocks.

The virtual-key template (`vk-mint-template.json`) allows the alias name too,
because the listing and the request are both filtered by the key's
`allowed_models` against the requested name. A test requires the template's
Fireworks list to equal the config's.

`config.test.ts` and `vk-mint-template.test.ts` cover it: a served router with no
catalog-named alias (the silent bare-listing case, with a negative test of the
detector), a served router with no override (the silent $0 case, likewise), the
rate against the published 1.5x, residency checked on the wire id, the template
equal to the config, and a refusal of invented metadata keys.

## What you still have to do, and what stays wrong

- **`gp-pi` must name the new model, with no extension change.** The router id
  still lists bare. Both ids are in the key's `models`, because the container's
  worker default (`gp-delegate`'s `WORKER_MODEL`) and saved settings name the
  router, and removing it would turn them into 404s the moment this deploys. So
  `pi --list-models` shows two Fireworks rows for the same model: the bare
  router and the enriched `models/...-us`. The DX is fixed for whoever selects
  the enriched one. Once `gp-pi`'s default id (data, not extension code) is the
  `models/...-us` name, delete the router from `models` and the bare row is
  gone. That default is not set in this repository; `bifrost-model-aliases.md`
  moves it.
- **This collides with that plan.** Its `worker-default` alias targets the
  router id, and the listing enriches by the listed name (`worker-default`) and
  the alias *value* (the router): neither has a row, so that alias would list
  bare, which its own "enrichment" gate expects. It cannot use the catalog name
  as its target, because Fireworks 404s it. The way through is for the default
  to be this alias rather than a second layer on top of it, or for
  `worker-default` to point at `models/...-us` as the *listed* alias (one
  hop, not two). I did not decide that here: it is the aliases plan's call.
- **Existing virtual keys do not get the new model.** The mint applies the
  template on *create* and returns an existing key unchanged. A key minted
  before this deploys has `allowed_models` without the alias name, so the
  governance filter hides it from that key's `/v1/models` and refuses requests
  for it. New keys are right; for existing ones the allowlist has to be updated
  (or the key re-minted). This is the "mint does not converge" gap that
  `bifrost-model-aliases.md` already records, and it is not fixed here.
- **The duplicate row is the price of not breaking the router id.** Nothing in
  v2.3.0 hides one listed model behind another.

## What does not change

Overrides patch **cost only** (`patchPricing`, `datasheet/overrides.go:471`);
there is still no config.json key for `context_length`, `max_input_tokens` or
`max_output_tokens`, and a test refuses an invented one. The alias fixes the
listing by routing the lookup to a row that exists, not by setting those
fields. If the datasheet ever drops or renames the `models/...-us` row, the
alias lists bare again: that is the silent degradation the second test watches
for in config, but only a live `/v1/models` check can see a datasheet change.

A tag bump would not help either: `transports/v2.4.0` changes the Fireworks
provider only by a `disable_store` flag, and enrichment still uses
`GetPricingEntryForModel`. Upstream #8914 and #9201 (open, unmerged) are about
the live-response path of OpenAI-compatible providers, which Fireworks does not
use.

## Is the price correct?

Delivering: the **US-premium price**, as the number Fireworks publishes, entered
by hand. Not delivering: proof it matches billing. `bifrost-gateway.md` item 16
(reconcile against a week of provider billing) **is still owed**: the number is
the published 1.5x, the catalog's own US-only rows agree with it, but a published
price is not an invoice, and the cached-input rate and any spot or priority
tiers are untested. The reconciliation also has to cover the override going
stale if Fireworks changes the price.

Side effect to know about: `source_of_truth` is `config.json`, and a present
`pricing_overrides` array is authoritative for that section
(`pruneGovernanceConfigToFile`, `lib/config.go:4680`). An override added through
the Bifrost UI is deleted on the next task start. That is the intended model for
this repo.

## Options considered

- **a. Config override of model metadata.** Not available at v2.3.0, as above.
  Cost-only override: used (item 2 above).
- **b. Bump the tag.** Rejected: nothing in v2.4.0 changes this provider's
  listing, and the plan says upgrades are deliberate.
- **c. Alias to a catalog row.** *Used for the listing.* I first wrote this up as
  untried and left it as a decision for the engineer; that was wrong. It is
  supported at the pinned tag (`aliases` and `model_name` are in the key
  schema), it needed no new artifact, and I ran it.
- **c'. Seed the catalog** with `framework.pricing.pricing_url` pointing at a
  datasheet we host. Would fix the listing and cost for any id, but replaces the
  catalog Bedrock also uses with a file that is stale until rebuilt, and needs a
  new artifact and a merge step. Worth it only if more routers need rows than
  one alias can carry.
- **d. Upstream.** The clean fix is a datasheet row for
  `fireworks_ai/accounts/fireworks/routers/deepseek-v4p1-flash-1017-us`, a data
  change on their side. Then the alias, the second `models` entry and the
  template change can all be deleted.

## What the engineer must do to see it live

1. Merge, then let `deploy-workbench` deploy: `config.json` is an SSM parameter
   injected as `BIFROST_CONFIG`, and the task re-reads it on restart.
2. `GET /v1/models` with a **new** virtual key (or one whose allowlist was
   updated) and look for `fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017-us`
   with `context_length` 1048576 and a `pricing` block. Then make one request
   on each name and read the logged cost: both should be about $0.45 / $1.80 per
   1M. **I could not run this**: the gateway is an ECS deployment, the container
   has no cgo for a real `LoadConfig`, and verifiable-live status is a rollout
   gate, not something to assert from here.
3. Move `gp-pi`'s default to the `models/...-us` name, then drop the router
   from `models`.

## Reproducing

All of this used the v2.3.0 source at `transports/v2.3.0` (commit
`9237ec06672406e437b3cb33fc793ffd0403b3ae`), the 2026-10-30 public datasheet
and Go 1.27.3. The probes were throwaway tests in a scratch clone, since
removed; the three that matter are: `listModelsByKey` with this repo's key
config; `Store.GetPricingEntryForModel`/`GetCapabilityEntry` over the downloaded
datasheet for the four ids above; and `Store.CalculateCost` before and after
`SetOverrides` with the entry in `config.json`.
