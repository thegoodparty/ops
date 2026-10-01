# bedrock

A Pi API provider over Bedrock's `InvokeModel`. Every model call BugBoss
makes arrives here: the incident agent streams through it, and the Boss's own
bounded calls do one request at a time through `client.ts`.

## Why not `Converse`

Converse drops thinking blocks that have **empty text but a live
signature** — which is exactly the shape Opus 5 produces under adaptive
thinking.

Resume depends on those surviving. A thinking block's signature is
cryptographically bound to the prefix: the system prompt, the tools array
and every earlier message. Drop one and the replay is rejected, so a
restarted agent cannot continue its own session. Since every merge to ops
`main` restarts this container, resume is the normal path.

So this module exists to keep the raw Anthropic message shape intact end to
end.

## The catalog is the only source of model facts, and a miss throws

`resolveBedrockModel` reads context window, token limits and rates from Pi's
Bedrock catalog (`getBuiltinModels("amazon-bedrock")`, shipped hydrated at
`dist/providers/data/amazon-bedrock.json`), and throws when the id is not in
it. `cost` is an override on a hit, never a licence to invent the rest.

It used to substitute `contextWindow: 200000` and `maxTokens: 64000` for any
id it did not know, which is five times too small for the model this agent
runs: `us.anthropic.claude-opus-5` carries 1,000,000 and 128,000. That was
the same class of error the function already threw on for a missing price,
and worse in one way — a wrong rate at least shows up as a number somebody
can disbelieve, where a wrong window is invisible. Too small and every
session compacts away four fifths of a context it was entitled to; too large
and the provider rejects a request nothing in the run predicted.

`catalogIdFor` strips a *system-defined* inference profile ARN to its suffix,
which is a catalog id. It deliberately does not match
`:application-inference-profile/`: that suffix is an opaque generated id, so
stripping it would turn one kind of catalog miss into another while looking
like a fix. The throw is what protects that case, which is why the
application profile ARN goes on the request field and never on `model.id`.

## Claiming an api id does not route anything

`registerApiProvider()` puts this provider in pi-ai's registry, and
`resolveBedrockModel()` stamps `bedrock-invoke-model` onto the model. Neither
selects an implementation. Pi's `ModelRuntime` resolves a provider by
`model.provider`, and `recomposeProvider()` installs the builtin *untouched*
when that id has no `models.json` entry and no registered extension -- which
is our configuration, so `composeModelProvider()`, the only code that reads
the registry, is never built. The builtin is a single-api provider, and
`createProvider()` serves its one api to every model without reading
`model.api`.

That combination cannot report itself: `createProvider()`'s only "no API
implementation" error belongs to the multi-api branch a single-api provider
never takes. Production ran on Converse for days.

`runtime.ts` is the fix. It wraps the builtin in a provider that dispatches on
`model.api` and registers that natively, so Converse keeps Nova, Llama,
Mistral and DeepSeek while our models reach `InvokeModel`.
`assertBedrockInvokeModelRouting()` proves it before the session starts, and
`runtime.test.ts` proves it against a real `ModelRuntime` -- which the tests
next to it do not, since they drive the provider directly.

## One request path, not two

`client.ts` is a `ModelClient` (`../model.ts`) over `ModelRuntime.complete()`,
and it is what triage, root-cause correlation, the inbound-language read and
the Slack agent make their bounded calls through.

They do not build their own Anthropic body, and nothing here should grow one.
Two request paths to a single model means a fix landed on one is a fix missing
from the other, which is how an absent beta header killed every incident agent
while triage carried on working, and opened two incidents no agent could
investigate.

Going through the runtime inherits rather than reimplements: the routing the
section above exists to assert, the 1h retention and its downgrade check, the
lone-surrogate sanitizer, the coalescing Anthropic requires of tool results
answering one turn, and `calculateCost` -- which is what finally puts a number
on a triage decision.

What it deliberately does not inherit is Pi's agent session.
`runStructuredCall` (`../triage/model.ts`) still owns the loop, because the
bound that matters there is an answer a Zod schema accepts inside a wall-clock
budget, and `createAgentSession` owns a JSONL file, resume and compaction
instead. `complete()` is one request.

### A failed request resolves rather than rejecting

Pi turns a setup failure, a transport error, a missing credential and an abort
alike into a terminal message with `stopReason: "error"` and zeroed usage.
Unchecked that is an empty reply with no tool calls, which is indistinguishable
from a model that answered in prose and is a shape every caller retries
against -- a dead model wearing a healthy one's clothes, the one thing
`triage/CLAUDE.md` says must not happen. So the stop reason is checked and
thrown as `ModelRequestFailed`, carrying the usage, because a call that died
still spent what it spent.

### An empty assistant turn still has to say something

Pi's body builder skips an assistant message whose content blocks all came out
empty, and the round after one is a user turn -- so the transcript hands
Anthropic two consecutive user messages and is rejected. That shape is
reachable: `runStructuredCall` records the assistant turn before nudging a
prose reply back towards the answer tool, and a reply can be empty. Hence the
`"(no reply)"` placeholder.

## Usage is the cost record, and it is tokens

Per-turn usage is what the Boss sums out of the session file after a child
exits. Nothing else records what a run cost, and it is read from the file
rather than reported by the agent because a killed agent never gets to
report — and the file is on disk either way.

**Tokens, never dollars.** Bedrock returns tokens; `pi.calculateCost` prices
them from a hardcoded per-model table in `node_modules/@earendil-works/pi-ai`.
The day AWS moves a rate that table is wrong and nothing in a stored dollar
figure could say so, where tokens re-price correctly forever. So the incident
row holds tokens and `modelId`, a cost is derived wherever it is shown and
called an estimate there, and `usage.cacheWrite1h` is carried alongside the
total because a 1h write bills at 2x base input against 1.25x for 5m.

`emptyUsage()` exists so a turn that fails still has a shape to record
rather than a hole.

## Application inference profiles are the only cost attribution there is

Bedrock puts no cost tag on an `InvokeModel` request. The one mechanism AWS
offers is an **application inference profile**: a profile created with tags,
invoked by passing its ARN as `modelId`, whose usage then appears under those
tags in Cost Explorer. `deploy/components/bugboss.ts` creates one wrapping
Opus and hands the map down as `BUGBOSS_INFERENCE_PROFILES`, keyed by logical
model id.

It enforces nothing -- Cost Explorer lags about a day. What it buys is the
one real number the local price table can be checked against, which matters
because every dollar figure this system reports is arithmetic over tokens
against Pi's hardcoded rates.

**The swap is the request field and nothing else.** `invokeModelIdFor` is
applied at the `modelId` on the wire; `model.id` keeps the logical id. That
is deliberate, and it is what the section below is about: the prefix records
`model.id`, so putting the ARN there would pin the ARN in the session. Two
things would then break. Everything about the model comes from Pi's catalog,
which has no entry for an opaque profile suffix, so `resolveBedrockModel`
would refuse to resolve a resumed session at all. And a session started before the profile existed
would disagree with one started after it, for no reason a reader could see.
Leaving `model.id` alone means a run started before the profile and resumed
after it gets attribution from the resume onward and nothing else changes.

**An unrecognised model loses attribution, not the agent.** The model is
runtime-configurable (`BUGBOSS_MODEL_ID`) and retunes from SSM without a
deploy, so the map is routinely out of step with what is configured.
`invokeModelIdFor` falls back to the bare id and never throws.
`parseInferenceProfiles` does throw, and only the composition root calls it
that way: a typo stops the container at boot where somebody is watching,
while the child logs `inference_profiles_unreadable` and carries on. Killing
an agent working a production incident over a billing tag is the same trade
`stream.ts` refuses to make over an unhonoured cache retention.

## No explicit credentials

The client is constructed with no `credentials` key, so the SDK's default
chain resolves them: the ECS task role, in the parent and in a child alike.

That matters now that agents run for a day. The container provider refreshes
on its own schedule, so a client built at startup keeps working for the whole
run. Setting credentials explicitly here would pin them at construction and
defeat that.

## The model id is pinned in the session

Bedrock does not restore it on resume, because deployment ids are
provider-specific. The mapping lives in SSM and retunes without a deploy, so
a restart after a retune would replay every running agent against a
different model — rejecting every thinking block, quietly, since
`drop_block` is deliberately silent.

`agent/run.ts` resolves from the stored prefix for that reason, and alarms
distinctly when the environment disagrees.

## No retries here

There is no backoff anywhere in this module, deliberately: Pi owns the
retry loop, including for a stalled call, and a second layer underneath it would multiply attempts
invisibly.

## A call that stops sending is abandoned after five idle minutes

Nothing else bounds a model call. The SDK client sets no request or socket
timeout, and the agent's own deadline is a day out, so a stream that stops
sending without closing held incident 100's agent silent for over an hour
with no turn, no error and no exit.

`MODEL_IDLE_TIMEOUT_MS` is reset on every response chunk, including the
response itself, and when it lapses the request is aborted and the read in
flight is raced, not awaited, because aborting is not proof the SDK unblocks
a read already waiting on a socket. The turn ends as `stopReason: "error"`
with "timed out" in its message, which is what Pi's
`isRetryableAssistantError` matches: Pi retries it, and a run that keeps
stalling exits into the dispatcher's relaunch. `model_call_stalled` is the
alarm, with `incidentId` on agent calls and null on the Boss's.

Idle, not total: a healthy call that thinks for minutes keeps sending. Across
3,788 production turns the slowest whole call took 316s and the next 126s,
and an idle gap is always shorter than the call it sits in. Both the agent
and the Boss's bounded calls come through this provider, so both are covered.

## The cache is written with a 1h ttl

`monitor` and `message_boss` each cost one turn however long they block.
That is what keeps a multi-day incident from saturating context, and it is
also what guarantees a cache miss on a 5-minute cache, because a tool that
blocks for ten minutes resumes into a dead prefix and rebuilds all ~190k
tokens of it.

Measured over seven production incidents: 32 misses, every one of them
straight after one of those two tools. No turn whose gap was under 216s ever
missed; no turn whose gap was over 331s ever hit. The rewrites were 27–41% of
each run, and $7.53 of incident 1's $18.51.

So `DEFAULT_CACHE_RETENTION` is `"long"`, and `resolveCacheRetention()` in
`options.ts` is the only place that default is applied. A 1h write costs 2×
base input against 1.25× for 5m, so avoiding one 190k rewrite pays that
premium on ~291k written tokens, which is more than a whole run writes. A run that
never blocks for more than five minutes pays about 0.5–1.2% more; every
measured run had at least two blocking waits.

Pi cannot carry this for us. `cacheRetention` has no path in through
`createAgentSession`, and Pi's `PI_CACHE_RETENTION` env fallback is read by
Pi's own providers, not by `resolveCacheControl()` here.

### A downgrade is never silent

A request that asks for 1h and is served 5m rebuilds its prefix on exactly
the same schedule at exactly the same price, and reports nothing. It looks
identical to the bug above. Pi's own Anthropic path can do this: it drops the
ttl when `compat.supportsLongCacheRetention` is false, and still reports the
retention it wanted.

So the response is held to the request. Bedrock returns both halves of the
`cache_creation` split on `us.anthropic.claude-opus-5`, so a downgrade is an
observed number, and `stream.ts` reports one as
`event: "cache_retention_not_honoured"`, once per provider, since it would
otherwise repeat on all ~90 turns of an incident. Any 5m share counts, not
only a wholly downgraded write: a partial split is still tokens billed at a
retention nobody asked for. An *absent* split is reported too, because
`calculateCost` reads a missing 1h share as zero and would bill a 1h write at
the 5m rate.

The check runs on `message_start`, because that is the event that carries the
split. `message_delta` carries only the write total -- never
`cache_creation` -- so holding it to the same check reads an absent split as
an unconfirmable downgrade on every turn, not just a real one.

Two paths are deliberately exempt for that reason. `message_delta` is one:
its usage still lands in `output.usage`, but with no retention arguments, so
no check runs against it. The `message_stop` backstop is the other -- it
synthesizes usage from `amazon-bedrock-invocationMetrics`, which carry no
split by construction, so checking it would report a fault on every stream
that fell back to it and never on a real downgrade.

Deliberately a loud log and not a throw. This is a billing fault, and
crashing an agent that is working a production incident over one would be the
wrong trade.

### What it does not fix

A gap longer than an hour is beyond any ttl. Incident 1's last miss followed
a 28,809s wait on a person that expired with no reply. That case wants
a keep-alive or a shorter default timeout, not a longer cache.

## Traps when changing this directory

**A body field can be beta-gated, and Bedrock names the field, not the beta.**
`thinking.block_binding` is accepted only with `thinking-binding-controls-2026-08-01`
in `anthropic_beta`. Without it the entire request is a `ValidationException`
reading `thinking.adaptive.block_binding: Extra inputs are not permitted`, which
reads like a field we invented rather than a header we failed to send.

That is how the provider died on its first turn the night #124 finally routed a
request through it. The field had been in the body since this module was
written; Converse builds its own thinking config and never sent it, so months of
silent Converse fallback hid a field Bedrock would always have rejected.
`buildInvokeModelBody()` therefore adds the beta beside the one branch that
emits the field -- sending either half alone is a 400 the caller cannot see
coming, so they are one decision, not two.

Verified against live `InvokeModel` calls on `us.anthropic.claude-opus-5`
(us-west-2, 2026-09-28): accepted with the beta, rejected without it, and a
bogus beta name is itself rejected -- so a name that stops being real fails
loudly rather than quietly doing nothing. `display`, `output_config.effort`,
`anthropic_beta` as a body field and `metadata.user_id` are all accepted, and
the full production body still returns `cache_creation.ephemeral_1h_input_tokens`,
so the 1h write and `stream.ts`'s downgrade check are untouched.

**Do not "fix" a rejected `block_binding` by deleting it.** It looks like the
clean fix and every test would pass, because the prefix-binding check is not
currently enforced for this account on this model: a real signed thinking block
replayed under a deliberately changed system prompt was accepted even with
`prefix_mismatch_behavior: "error"`. So deleting the field costs nothing today
and wedges the relaunch loop on the day enforcement arrives -- a quiet failure
of exactly the kind this module exists to prevent. Keep the field, send the beta.

**The second argument to `registerApiProvider()` is not a registry key.**
`registerApiProvider(provider, "bugboss-bedrock-invoke-model")` passes a
*source label*, used only by `unregisterApiProviders(sourceId)` for bulk
removal. The registry keys on `provider.api`. That mismatched string sitting
next to the api id is the first thing anyone chases, and it means nothing.

**Do not "simplify" `runtime.ts` onto Pi's documented extension hook.** We use
`registerNativeProvider`, which installs our provider as the base. The
obvious-looking alternative, `registerProvider(id, { api, streamSimple })`,
registers an *extension* and routes through `composeModelProvider`. In
`streamWith`, the extension branch calls `extension.streamSimple(...)` for
both the simple and the full stream paths, so a full `stream()` call carrying
real `StreamOptions` is silently downgraded to `SimpleStreamOptions`. It works
today only because `createAgentSession` never calls `stream()`. It breaks
quietly the day something does.

**Adding any `models.json` entry for `amazon-bedrock` changes which path
routes us.** It moves `recomposeProvider` off the base-untouched short-circuit
and into `composeModelProvider`, where `supportsBaseApi` finds no builtin model
declaring our api and falls through to `getApiProvider("bedrock-invoke-model")`
-- which resolves only because `registerBedrockRouting` also does the
api-registry registration. Both halves are load-bearing under different
configs, and the file that switches between them is one nobody thinks of as
routing.

**`run.ts` builds `pi.ModelRuntime.create({})`.** That is identical to what
`createAgentSession` does internally *only because nothing passes `agentDir`*.
If someone adds `agentDir`, the session reads auth and models from one
directory while streaming through a runtime built from another. Cheap to
notice, silent if you do not.

## Reproducing a misroute without AWS

No credentials needed, about twenty lines. Register the api provider, resolve
the model, build `ModelRuntime.create({ modelsPath: null, refreshOnCreate:
false })`, call `runtime.streamSimple(model, ...)` with dummy
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, and print `message.api`.

Correct routing reaches `InvokeModel`. Wrong routing returns
`bedrock-converse-stream` and an `UnrecognizedClientException` from the real
Converse endpoint -- which is also the proof that Converse actually *ran*
rather than merely being selected. Fastest check for a regression here.

## Settling a body-shape question

Routing is provable without credentials; whether Bedrock *accepts* a field is
not. It validates server-side against its own copy of the Anthropic schema, so
the only answer that counts is a live call. `aws bedrock-runtime invoke-model`
with a two-message body answers one field per call in about a second, and a
deliberately bogus value is the control that proves the check is real rather
than ignored.

Reaching it through this provider instead of by hand is worth the extra step,
because `streamSimple()` sends `thinkingEnabled: false` unless
`options.reasoning` is set -- so a probe that omits it builds a body with no
thinking config at all and passes against every version of this file.
