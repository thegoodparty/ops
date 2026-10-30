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
heavy hook (replace the whole catalog, including Bedrock's rows with a file that
goes stale until rebuilt), and it was not used.

## What the same gap does to cost

Cost has the same gap. With no row, `resolvePricing`
(`datasheet/cost.go:2229`) finds no base price and returns nil, so a request on
the router id is logged at cost 0 with no error. Reproduced on the v2.3.0 code:
1M input + 1M output tokens on the router id prices at **$0** from the catalog
alone. The gateway's per-key cost attribution has been recording zero for every
Fireworks request.

## What changed

One edit to `deploy-workbench/bifrost/config.json`, and the matching one to the
virtual-key template. `/v1/models` is enriched by the *listed name*, and the
datasheet has a row for `accounts/fireworks/models/deepseek-v4p1-flash-1017-us`
and none for the router id. So the key now serves that name, as a key alias
whose `model_id` is the router:

```
models:  [ models/deepseek-v4p1-flash-1017-us ]
aliases: models/deepseek-v4p1-flash-1017-us ->
           model_id   routers/deepseek-v4p1-flash-1017-us
           model_name models/deepseek-v4p1-flash-1017-us
```

The router id is no longer served under its own name, so there is one Fireworks
row in `/v1/models`, and it is the enriched one. Run on the v2.3.0 code
(`listModelsByKey`, then the lookup and `ApplyModelInfo` the handler uses, over
the 2026-10-30 datasheet), the entry is:

```json
{"id":"fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017-us",
 "normalized_name":"Deepseek V4.1 Flash 1017 Us",
 "alias":"accounts/fireworks/routers/deepseek-v4p1-flash-1017-us",
 "context_length":1048576,"max_input_tokens":1048576,"max_output_tokens":393216,
 "pricing":{"prompt":"0.0000004500","completion":"0.0000018000","input_cache_read":"0.0000000090"}}
```

That is every field `gp-bifrost.ts` reads, with the right numbers, so it needs
**no change to the `gp-pi` extension**.

**Cost is fixed by the same edit.** Request cost resolves the alias's
`model_name` first (`resolvePricing`, `datasheet/cost.go:2229`), so a request
for the alias is priced from the catalog's own row for the `models/...-us` id.
Measured on the v2.3.0 code: 1M in + 1M out through the alias costs **$2.25**
($0.45 + $1.80), from $0, with no pricing override. That row is the US-only
1.5x rate (Fireworks lists the model at $0.30 / $1.20 and the US router at
$0.45 / $1.80, <https://docs.fireworks.ai/serverless/pricing.md>,
2026-10-30). The earlier revision of this change also added a
`governance.pricing_overrides` entry for the router id; it is gone, because
nothing now sends a request under the router's own name, so nothing needed it.

**Residency is unchanged.** The alias resolves *after* key selection
(`core/bifrost.go:8178`), and the provider is sent the router id. Fireworks
answers a request for the `models/...-us` name itself with 404 ("Model not
found"); I called it with a real key on 2026-10-30: the router id returns 200
(served by `deepseek-v4p1-flash-1017`), the `models/...-us` name returns 404.
So the global-looking name cannot be reached by accident. The tests check
residency against the **wire id**, so an alias to a non-US id fails them.

## Tests

`config.test.ts` and `vk-mint-template.test.ts`:

- every served Fireworks name is a catalog-named alias with `model_name` set to
  itself, with a negative test of that detector (a router served directly, a
  router beside a good alias, an alias with no `model_name`): the silent case
  is an entry that is present, succeeds, and lists as 128K / $0;
- residency on the wire id, for the config and for the template;
- the template's Fireworks list equals the config's;
- an invented `context_length` / `max_*_tokens` / `pricing` key is refused:
  v2.3.0 has no config key for them, so it would parse, do nothing and look
  fixed;
- this document names the pinned tag, so a bump has to re-check it.

## What this does not do

- **A request for the router id now fails.** `accounts/fireworks/routers/...-us`
  is no longer in the key's `models`, so anything still naming it gets a refusal
  from the gateway. That is deliberate and is the container's change to make
  (`gp-pi`'s default id), not this repository's.
- **Existing virtual keys do not get the new name.** The mint applies the
  template on create only, so a key minted before this deploys can neither list
  nor call it. Key refresh is being handled separately.
- **It depends on the datasheet.** If upstream drops or renames the
  `models/...-us` row, the entry lists bare again and costs $0. Only a live
  `/v1/models` check can see that. The clean fix is a datasheet row for the
  router id on their side; then the alias can go.
- **Overrides patch cost only** (`patchPricing`, `datasheet/overrides.go:471`).
  There is still no config key for context or output limits.
- **A tag bump would not help.** `transports/v2.4.0` changes the Fireworks
  provider only by a `disable_store` flag, and enrichment still uses
  `GetPricingEntryForModel`. Upstream #8914 and #9201 (open, unmerged) are about
  the live-response path of OpenAI-compatible providers, which Fireworks does not
  use.
- **Billing is not reconciled.** The price is Fireworks' published rate through
  Bifrost's catalog, not an invoice, so `bifrost-gateway.md` item 16 is still
  owed.

## What the engineer must do to see it live

1. Merge, then let `deploy-workbench` deploy: `config.json` is an SSM parameter
   injected as `BIFROST_CONFIG`, and the task re-reads it on restart.
2. `GET /v1/models` with a **new** virtual key and look for
   `fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017-us` with
   `context_length` 1048576 and a `pricing` block. Then make one request on
   that name and read the logged cost (about $0.45 / $1.80 per 1M). **I could not
   run this**: the gateway is an ECS deployment, the container has no cgo for a
   real `LoadConfig`, and verifiable-live status is a rollout gate, not
   something to assert from here.
3. Land the `gp-pi` default-id change in step with the deploy, since the router
   id stops being served.

## Reproducing

All of this used the v2.3.0 source at `transports/v2.3.0` (commit
`9237ec06672406e437b3cb33fc793ffd0403b3ae`), the 2026-10-30 public datasheet
and Go 1.27.3. The probes were throwaway tests in a scratch clone, since
removed; the ones that matter are: `listModelsByKey` with the old and the new key
config; `Store.GetPricingEntryForModel`/`GetCapabilityEntry` over the downloaded
datasheet for the four ids above; the handler's lookup and `ApplyModelInfo` for
the alias; `Store.CalculateCost` for a response routed through the alias (with
and without `ResolvedKeyAlias`); and the real `ConfigData` parser plus
`KeyAliases.Validate` over the new `config.json`.
