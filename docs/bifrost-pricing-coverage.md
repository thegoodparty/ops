# Bifrost pricing coverage: what bills at zero, and how we find out

The workbench gateway prices every request from one remote document, the pricing
datasheet, and it writes a cost of zero when it cannot find a rate. This document
records the two ways that happens, where each one is caught now, and what is
deliberately left to a person.

It exists because the failure is silent in both directions. A zero-cost request is
not an error, is not a null, and is not visible in a spend chart; and a
per-provider budget is charged only when the computed cost is above zero, so an
unpriced model is not merely unbilled, it is uncapped. Nothing about it looks
wrong until somebody reads the logs.

## How a price is found

At the pinned tag (`deploy-workbench/bifrost-image.ts`, `BIFROST_UPSTREAM_TAG`):

1. The datasheet is fetched at boot and re-read every 24 hours, stored in the
   config store and cached in memory keyed `model|provider|mode`. The timer is a
   fixed ticker, so the real cadence is the larger of five minutes and the
   configured interval.
2. A request is priced by exact lookups on that key. The candidates are tried in
   this order: the fallback model, the matched alias's `model_name`, the alias's
   `model_id`, then the model string the caller sent. Within each candidate, the
   request's own mode is tried first and the counterpart chat/responses mode
   after it, and the first row found decides: a chat request and a responses
   request run the same candidates from different starting modes and can find
   different rows.
3. A request type that finds nothing is logged at a cost of zero. Not null, not an
   error. The non-streaming path writes null, but the streaming path — which is
   what we use — writes the zero.

The source:line for each of those is in `bifrost/pricing-coverage.ts`, which
reimplements the lookup, and in `docs/bifrost-fireworks-model-metadata.md`, which
records the earlier investigation into the same mechanism.

## The two failure modes

**Catalog lag.** A model is added to a key's `models` list and is served
immediately. The datasheet gains its row hours or a day later. Everything served
in between bills at zero. This is the `global.openai.gpt-6.2-sol` case of
2026-11-18: added at 00:53Z, three requests logged at zero between 03:01Z and
03:26Z, and the row is in the feed today.

**A name that can never resolve.** Some ids the provider accepts have no row and
never will. The Fireworks US router id is one: the feed carries the catalog-name
sibling and not the router. That is fixed structurally, by serving the
catalog-named id with an alias whose `model_id` is the wire id, so requests reach
the router while the price comes from the catalog row. `config.test.ts` pins that
shape.

## Where each is caught

| Failure | Caught by | When |
|---|---|---|
| A served name the datasheet cannot price | `.github/workflows/bifrost-pricing-coverage.yml`, via `deploy-workbench/scripts/check-pricing-coverage.ts` | daily, on dispatch, and on a push that changes the serve list |
| A name whose shape can never resolve | `config.test.ts`'s alias rules | at review, on every change to the file |

The check runs on a push that changes `config.json`, not only nightly, because
nightly alone has a gap: a model added at 00:53 and priced by the datasheet at
01:30 sits between two nightly runs that are both green, since nothing is unpriced
at either moment of checking. Running on the serve list's own change puts a check
at the one moment a new name is known to exist.

Catalog lag is therefore **reported**, not prevented. Nothing in this repo can
make the gateway price a model the datasheet has no row for: the only price source
is that document. The check's job is that the window is known rather than silent.

The check reads the committed `config.json` and the public datasheet, and nothing
else: no AWS role, no OIDC token, no repository secret, one permission
(`issues: write`). It cannot reach the gateway, which is why it reimplements the
lookup rather than asking. When a served name does not resolve it files one issue
with a fixed title and names the models; when a later run is clean it comments the
run and closes that issue. A clean run closing the issue is the half that keeps
the issue worth reading.

A datasheet that cannot be fetched is a third outcome and files nothing. "We could
not check" has a different owner than "a model is unpriced", and a check that
confused them would teach people to close the issue unread.

## Why the deploy does not force a sync

The gateway exposes `POST /api/pricing/force-sync`, and a deploy is the one moment
a new model is known to exist, so forcing a sync there looks like the obvious way
to close the window. It is not done, and the reason is in the source:
`ForceReloadPricing` re-reads the datasheet **and resets the sync timer**
(`framework/modelcatalog/main.go:417`), while `SyncFromURL` never advances the
"last synced" mark the ticker gates on. So a forced sync that finds nothing
because the feed has not caught up yet defers the next natural sync by a full
interval.

That is exactly backwards in the case it would be added for. When the datasheet
already carries the row the two cases look the same from outside — we cannot tell
which one a deploy is in — and when it does not, the force turns a window of hours
into one of about a day. A version that forced only when the datasheet already
prices the new name would have to read the public datasheet from the deploy, which
is a new network path on a credentialed job, and the gain over the nightly check
does not pay for it. So it is left out, and recorded here so the next person does
not add it back without reading `main.go:417`.

## What we deliberately do not do

**We never write a price.** No `pricing_overrides`, no `custom_pricing`, no
vendored copy of the datasheet, no `framework.pricing.pricing_url`. The gateway
supports all of it, and ops used an override once for the Fireworks router before
the alias made it unnecessary. It is reserved for a case where the feed will never
carry a row, because an automation that prices is an automation that has to choose
between the base rate and the US-only or global rate, and picking wrong is
invisible in exactly the way this document is about.

**We do not charge or backfill.** Requests already logged at zero stay at zero
unless someone re-derives their cost, which is one call against the gateway
(`POST /api/logs/recalculate-cost` with `missing_cost_only`) and needs gateway
admin.

**We do not page anyone.** The issue is the visible channel. A page needs a
credential this repo does not hold for it, and the cadence this fires at (one or
two genuinely new models a month) does not justify one.

## The warehouse side

`bifrost_request_log` lands in the warehouse with the gateway's own `cost`, so a
zero-cost window is measurable after the fact even though nothing alerted at the
time. The cost model in gp-data-platform #1397 carries an `unpriced_request_count`
column per model per day, which is the durable record of a window like this one;
**#1397 has not merged**, so until it does the record is a query over the export's
own cost column. The check in this repo is the alert that sits in front of it; the
warehouse is the history.

## Adding a model

Serve the catalog-named id with an alias rather than the wire id, and add it to
`utils/bedrock-models.ts` if it is a Bedrock profile. If the datasheet does not
carry the model yet, the check names it as soon as it runs after the change, and
the issue closes itself on the first run after the feed catches up. Requests
served in that window bill at zero, and the warehouse is where to look afterwards.
