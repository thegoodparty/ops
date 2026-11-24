# Fireworks Rune Decisions through the gateway

> Adds one provider to `deploy-workbench/bifrost/config.json`, one entry to the
> virtual-key template, and the test and classification changes they need. A
> sibling of [`bifrost-fireworks-model-metadata.md`](./bifrost-fireworks-model-metadata.md)
> and [`bifrost-gateway.md`](./bifrost-gateway.md).
>
> Verified against: transports/v2.4.0

## What this is for

Fireworks publishes a System One **Decisions** model, Rune
(`accounts/fireworks/models/rune`), that answers a set of typed questions about a
state in one pass and returns calibrated probabilities. It is not a chat model:
Fireworks documents that chat completions and completions against it return
`400` (<https://docs.fireworks.ai/api-reference/post-systemone>). The fleet has no
way to reach it through the gateway, so the gateway cannot see, attribute or cap
that spend, which is the whole point of the gateway existing.

This document records what was measured, what the change is, and the one thing it
could not prove.

## Why a second provider, and not another model on the first

Bifrost's built-in Fireworks provider implements `Decision` as an
`unsupported_operation` stub (`core/providers/fireworks/fireworks.go` at
`transports/v2.4.0`, the `Decision` method). Adding `accounts/fireworks/models/rune`
to the existing `fireworks` key would therefore parse, list, and fail every call
with `unsupported_operation` — the silent half of a fix, which is the failure
mode `bifrost-fireworks-model-metadata.md` was written about.

What does serve it is Bifrost's `typesafe` provider, which speaks System One
natively: `POST {base_url}/v1/systemone`, `Authorization: Bearer <key>`, the
native `{state, questions, assets}` body and the native `{model, answers, usage}`
reply (`core/providers/typesafe/typesafe.go`, `decision.go`). A **custom
provider** on the `typesafe` base is the documented way to point that adapter at
an endpoint other than `api.typesafe.ai`
(`docs/providers/supported-providers/typesafe.mdx`, "Custom Typesafe Providers";
`docs/providers/self-hosted-decision-models.mdx`).

So the provider is `fireworks-rune`:

- `base_provider_type: "typesafe"` — the only base that serves a decision.
- `network_config.base_url: "https://us.api.fireworks.ai/inference"` — the same
  US-only host the existing `fireworks` provider uses, so the residency control
  is unchanged and shared. It is a separate provider entry, so it needs its own
  `base_url`; `network_config` is per provider in the schema at this tag.
- one key, `env.FIREWORKS_API_KEY` — the same credential, the same account. A
  second secret would be a second thing to rotate for no isolation gained.
- one model, `accounts/fireworks/models/rune`, named exactly as Fireworks
  documents it. No alias: a Decisions model has no second name, and an alias
  would create a `/v1/models` row with no catalog entry to enrich it from (the
  trap `bifrost-fireworks-model-metadata.md` records).

## Decisions only, and why that is a whitelist

`custom_provider_config.allowed_requests` is a whitelist once it is present:
every field it omits becomes `false` (`docs/providers/custom-providers.mdx`,
"Allowed Request Types"; `schemas.AllowedRequests.IsOperationAllowed`). The
provider names exactly one:

```json
"allowed_requests": { "decisions": true }
```

That is what keeps the provider from being a chat surface. It matters more than
it looks: a `typesafe` base returns `unsupported_operation` for chat anyway, but
the whitelist refuses it a layer earlier, before routing, and `list_models` is
off because Fireworks' `/v1/models` does not enumerate the Decisions model and a
failing listing marks the provider unhealthy on a dashboard nobody reads. The
cost is that the model does not appear in `/v1/models`; a Decisions caller names
it directly.

## Cost, which a custom provider does not get for free

Bifrost's pricing catalog has no row for a custom provider's name, so a decision
through `fireworks-rune` logged at **$0** with no error. Measured on the pinned
image: 1 request, 1 234 prompt tokens, `cost` null.

The catalog does have a row for the model itself —
`fireworks_ai/accounts/fireworks/models/rune`, mode `decisions`, input
$4.2e-8/token, cached input $8.4e-9, output 0 — but it is filed under the
catalog provider `fireworks`, and the lookup for a custom provider resolves
against the custom name. `normalizeProvider`
(`framework/modelcatalog/datasheet/types.go`) folds a name containing
`fireworks_ai` onto `fireworks`, which is why a provider *named* that way priced
correctly with no override (also measured), and why `fireworks-rune` does not.

The change therefore carries one `governance.pricing_overrides` entry, and it is
what makes the spend visible per key — success criterion 3 of
`bifrost-gateway.md`:

```json
{ "scope_kind": "global", "match_type": "exact",
  "pattern": "accounts/fireworks/models/rune", "request_types": ["decisions"],
  "pricing_patch": "{\"input_cost_per_token_decisions\":4.2e-8,\"cache_read_input_token_cost\":8.4e-9}" }
```

- **Global scope**, not `provider`. A provider-scoped override keys on
  `provider_id`, and the request path resolves scopes from the custom provider's
  name; both were tried against the pinned image and the global one was the form
  that priced the call. It is also smaller, which matters below.
- **`input_cost_per_token_decisions`**, the decision-mode rate
  (`computeDecisionCost`, `framework/modelcatalog/datasheet/cost.go`). The plain
  input rate would not apply to a `decisions` request.
- **No output rate.** Rune emits no output tokens; Fireworks bills input only,
  and an output rate would be a number nothing ever bills.
- The rate is Fireworks' published $0.042 per 1M input tokens, and $0.0084 per
  1M cached input (20% of input), from
  <https://docs.fireworks.ai/serverless/pricing>. Rune runs on US capacity with
  no US-only premium, so there is no 1.5x multiplier to apply — unlike DeepSeek
  on the other Fireworks provider.

Measured on the pinned image with this override: the same request priced at
**5.1828e-05** (1234 × 4.2e-8), and the log row carried it on the
`fireworks-rune` provider.

## The parameter moved to the Advanced tier

`config.json` is the value of the `/bifrost/config` SSM `String` parameter, and
the standard tier holds 4 KiB. The file was 3,604 bytes with 492 bytes of
headroom — the number `ecs.ts` and `bifrost-fireworks-model-metadata.md` both
recorded — and this change adds **870 bytes**: **471** for the provider block and
**399** for the override, measured as they sit in the file.

That does not fit, and it is not a formatting accident: each half is close to
the whole headroom, and the two together are most of it over. The two ways to
make it fit were to minify ~400 bytes of the file (reformatting entries this
change does not touch, which is churn a reviewer cannot check) or to move the
tier, which `ecs.ts` already named as the escape. The tier moved:
`BIFROST_CONFIG_PARAMETER_TIER` is `"Advanced"` (8 KiB, and AWS charges for it),
set explicitly on the parameter so a later smaller file is a deliberate
downgrade rather than a silent one.

The cost is real and worth naming: a charged parameter, and a ceiling far enough
away that the next addition will not feel it. `ecs.test.ts` now pins both — the
file is under 8 KiB, and it is still *over* 4 KiB, so the day it fits the
standard tier again the test says so instead of leaving a charged tier nobody can
explain.

## Classification: `custom_provider_config` is boot-only

`ecs.ts` splits `config.json` into boot-only leaves, which `BIFROST_CONFIG_VERSION`
digests so a change rolls the task, and live leaves, which the reconciler
converges into the running process. The two lists must partition every leaf, and
`ecs.test.ts` fails on an unclassified one. `providers.*.custom_provider_config`
is new with this change, so it had to be classified.

It is **boot-only**, for three reasons rather than a preference:

- `base_provider_type` is immutable once the provider exists. `PUT
  /api/providers/{provider}` refuses a change to it
  (`ValidateCustomProviderUpdate`, "base_provider_type cannot be changed ... after
  creation"), so no live convergence could apply one.
- `allowed_requests` round-trips as the full ~60-field `AllowedRequests` struct.
  A file that names only `decisions` would differ from what the gateway reports
  on every tick, and the loop would rewrite the provider forever — the failure
  `docs/bifrost-reconciler.md` decision 6 exists to prevent.
- A custom provider is the one thing the convergence loop never creates:
  `getProvider` answers `null` for a provider the file has and the gateway does
  not, and it is skipped as `not-present`. A file that gains a provider needs the
  boot path regardless.

Boot-only is the visible, cheap direction of the asymmetry the module documents.
`ecs.test.ts`'s drift test is clean with it.

## Convergence, and the one thing this could not prove

**A live US smoke test.** The gateway is an ECS deployment in the workbench
account. Nothing here could reach it, and an unauthenticated probe of
`https://us.api.fireworks.ai/inference/v1/systemone` returning `401` proves only
that the route exists, not that this account's key is entitled to Rune. That
needs an authorized call with a real key against the real endpoint, which is
**a pre-merge requirement**, not something this PR can assert:

1. After merge and the `deploy-workbench` deploy, mint a **new** virtual key
   (`gp-pi bifrost-key --refresh`), because the template change reaches existing
   keys only through the reconciler's next tick.
2. `POST /v1/decisions` with `model: "fireworks-rune/accounts/fireworks/models/rune"`
   and one `predicate` question. Expect `200` and an `answers` array.
3. Re-send the same body to `/v1/chat/completions`. Expect `400` with
   `unsupported_operation`, which is the no-chat-exposure claim made concrete.
4. Read the request's cost in the gateway's log for that key. Expect a non-zero
   cost at about $0.000042 per 1k input tokens.

**What was proved locally instead**, on the pinned `maximhq/bifrost:v2.4.0`
image with this exact provider block and override, against a stub that mimics
Fireworks' `systemone` reply:

- `/v1/decisions` answered `200` with the normalized answers, on the custom
  provider, with `Authorization: Bearer <key>` and a body at
  `/inference/v1/systemone` in Fireworks' native shape — the protocol is right.
- `/v1/chat/completions` answered `400` `unsupported_operation` — the no-chat
  claim holds.
- The global-scope override priced the request at 1234 × 4.2e-8, and without it
  the same request logged `cost: null` — the override is load-bearing and correct.

## Tests

`bifrost/config.test.ts`:

- `fireworks-rune` serves one model, has no alias, reuses `env.FIREWORKS_API_KEY`,
  and allows **only** `decisions` — every chat shape asserted absent.
- the pricing override is exact-match, `decisions`-only, global-scope, and its
  rates are the published ones with no output rate.
- the endpoint is the US-only host, on both Fireworks providers; every other
  provider still carries no `base_url`.
- the served-classes literal gains `fireworks-rune`, so the class set is a
  stated decision rather than a derived one.

`bifrost/vk-mint-template.test.ts`: the template names `fireworks-rune` with the
one model, and the residency rule for it is the endpoint, since its id has no
`-us` router suffix to check.

`ecs.test.ts`: the byte ceiling is the Advanced tier, and the file is still over
the standard one; the classification drift test is clean with
`custom_provider_config` boot-only.

## What this does not do

- **A per-provider budget.** Fireworks stays uncapped, as it is for DeepSeek
  (`vk-mint-template.json`, decision 18 of `docs/bifrost-reconciler.md`). A
  Decisions model is cheap per call, and a cap is a number nobody has data for
  yet; the same argument that left the first Fireworks entry uncapped applies.
- **The model in `/v1/models`.** A Decisions caller names the model; listing it
  would need a catalog row for the custom provider's name, which a custom
  provider does not have.
- **The Bedrock `global.` question.** Unchanged. Rune is US-only by endpoint and
  by Fireworks' own statement, and this adds no Bedrock surface.
- **The caller.** This is the gateway's side only: making the model reachable
  does not change any harness to ask for it.
