# Why the gateway serves no model metadata for Fireworks, and what this repo can fix

> Findings for one observed bug, with the evidence for each hop. It is a sibling
> of [`bifrost-gateway.md`](./bifrost-gateway.md) and changes only
> `deploy-workbench/bifrost/config.json` and its test.
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

`deploy-workbench/bifrost/config.json` gains one
`governance.pricing_overrides` entry, the only per-model hook v2.3.0 has:

```
provider fireworks, exact accounts/fireworks/routers/deepseek-v4p1-flash-1017-us,
chat_completion + responses + text_completion,
input 4.5e-7, output 1.8e-6, cached input 9e-9 per token
```

These are Fireworks' published base price for this model ($0.30 / $0.006 /
$1.20 per 1M) times the 1.5x US-only premium
(<https://docs.fireworks.ai/serverless/pricing.md>, 2026-10-30), which the same
page lists as $0.45 / $0.009 / $1.80. Verified on the v2.3.0 code path using the
same JSON: 1M in + 1M out prices at **$2.25** on chat and on responses, from $0.
The v2.3.0 loader also parses this exact block (`ConfigData` unmarshal, with
`governanceSectionPresent("pricing_overrides")` true and the patch intact).

`config.test.ts` gets six tests (below).

## What this does not fix

**The `/v1/models` listing is still bare, and pi will still show 128K and cost
0.** I checked that deliberately: loaded the override and called the same lookup
the listing uses, `GetPricingEntryForModel`. It still returns nothing, because
the listing reads the base catalog, not overrides, and overrides patch cost only
(`patchPricing`, `datasheet/overrides.go:471`, has no context or output-limit
field). So this change fixes **cost attribution in the gateway**, which was the
quietly broken number, and does **not** fix what `gp-bifrost.ts` sees. v2.3.0
has no config.json way to set `context_length`, `max_input_tokens` or
`max_output_tokens` for a provider model, so an invented key would look fixed
and do nothing; a test refuses those keys.

The bump does not fix it either. `transports/v2.4.0` (2026-10-29) changes the
Fireworks provider only by a `disable_store` flag and the openai models path not
at all; enrichment moved into `modelcatalog.EnrichListModelsResponse` but still
uses `GetPricingEntryForModel`. Neither #8914 nor #9201 is merged, and #9201
touches OpenAI-compatible, Anthropic and OpenRouter providers, not Fireworks'
config-sourced list. A bump is a real change (new schema, RDS migrations,
rollback by snapshot) that buys nothing for this bug, so I did not make one.

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
  Cost-only override: chosen (this change).
- **b. Bump the tag.** Rejected: nothing in v2.4.0 changes this provider's
  listing, and the plan says upgrades are deliberate.
- **c. Seed the catalog.** The one supported hook is `framework.pricing.pricing_url`
  pointing at a datasheet we host or bake in. It would fix the listing (a row
  for the router id) and cost together, but it replaces the catalog Bedrock also
  uses with a file that is stale until rebuilt, and needs a new artifact and
  a pipeline step to merge ours into upstream's 3 MB feed. Worth doing only if
  the listing matters more than that cost. Not done.
- **d. Upstream.** A one-line fix is a datasheet row for
  `fireworks_ai/accounts/fireworks/routers/deepseek-v4p1-flash-1017-us`, which
  is a data change on their side; the Fireworks adapter also could populate
  `context_length` from its own model list, but only for non-US ids.

**Untried, and the likeliest fix for the listing.** The listing is enriched by
the *listed name*, and the catalog has a row for
`accounts/fireworks/models/deepseek-v4p1-flash-1017-us`. A key alias of that name
whose `model_id` is the router id would list with a context window and the
US-only price, while requests still go to the router id (the wire id stays the
residency-bearing one). By reading, not by running: it needs `models` to contain
the alias name, so the US-only test (`US_FIREWORKS_ROUTER`) would need to learn
the alias, and it makes the name `gp-pi` sees `models/...-us`, which looks like a
global id. That is for the model-aliases plan
([`bifrost-model-aliases.md`](./bifrost-model-aliases.md), in review on another
branch), whose "enrichment" gate asks exactly this question. Its answer is: the
listing enriches by the listed name and the alias *value*, never `model_name`.

## What the engineer must do to see it live

1. Merge, then let `deploy-workbench` deploy: `config.json` is an SSM parameter
   injected as `BIFROST_CONFIG`, and the task re-reads it on restart; the config
   hash in the task definition forces the roll.
2. Make one request through the gateway on the Fireworks model and read the
   logged cost, or check the Bifrost log: it should be non-zero and match
   $0.45 / $1.80 per 1M. **I could not run this**: the gateway is an ECS
   deployment, the container has no cgo for a real `LoadConfig`, and
   verifiable-live status is a rollout gate, not something to assert from here.
3. `/v1/models` will look the same; do not read that as the change failing.

## Reproducing

All of this used the v2.3.0 source at `transports/v2.3.0` (commit
`9237ec06672406e437b3cb33fc793ffd0403b3ae`), the 2026-10-30 public datasheet
and Go 1.27.3. The probes were throwaway tests in a scratch clone, since
removed; the three that matter are: `listModelsByKey` with this repo's key
config; `Store.GetPricingEntryForModel`/`GetCapabilityEntry` over the downloaded
datasheet for the four ids above; and `Store.CalculateCost` before and after
`SetOverrides` with the entry in `config.json`.
