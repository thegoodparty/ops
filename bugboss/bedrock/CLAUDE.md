# bedrock

A Pi API provider over Bedrock's `InvokeModel`, used by the incident agent.

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

## Usage is the cost record

Per-turn usage is what the Boss sums out of the session file after a child
exits. Nothing else records what a run cost, and it is read from the file
rather than reported by the agent because a killed agent never gets to
report — and the file is on disk either way.

`emptyUsage()` exists so a turn that fails still has a shape to record
rather than a hole.

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
retry loop, and a second layer underneath it would multiply attempts
invisibly.

## The cache is written with a 1h ttl

`monitor` and `contact_human` each cost one turn however long they block.
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
otherwise repeat on all ~90 turns of an incident. An *absent* split is
reported too: `calculateCost` reads a missing 1h share as zero and would bill
a 1h write at the 5m rate.

Deliberately a loud log and not a throw. This is a billing fault, and
crashing an agent that is working a production incident over one would be the
wrong trade.

### What it does not fix

A gap longer than an hour is beyond any ttl. Incident 1's last miss followed
a 28,809s `contact_human` timeout that expired with no reply. That case wants
a keep-alive or a shorter default timeout, not a longer cache.
