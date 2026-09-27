# ingress

Turns an inbound delivery into signals. One adapter per source, and adding a
source is one adapter rather than a change anywhere else.

## The adapter contract

Three functions (`types.ts`):

- `parse` — verify and parse. **Throws on a signature failure**, fails
  closed.
- `dedupKey` — identity for collapsing retries.
- `prefetchEvidence` — runs deterministically before triage sees the signal.

There is deliberately no `isResolved`. Nothing decides an alert is over
except an agent, on evidence.

## Ingress does not read what a message says

Slack is **not** an adapter. A person reports something by mentioning
`@bugboss`, and whether that mention is a report or a question is a model
call the composition root makes off the ack (`slack/intent.ts`), not
something a body can be parsed for.

This used to be a verb: the first word had to be `report`, `bug` or `broken`.
`@bugboss Pro upgrades are failing` was therefore answered as a question and
opened nothing, which is the whole problem with a magic phrase.

So the registry holds two adapters, not three. A report's signal is built
with `humanSignal` and placed through the `human` entry, which is what
`Signal.source` already points the orphan sweep at.

### `ignored` means nothing will come of this

`classifySlackEvent` still answers what a signature, an event envelope and a
thread id can answer — is this authentic, is it a message, is it in a thread
BugBoss owns, was the app tagged. The thread check looks like interpretation
and is not: it is a `slackThreadTs` lookup, injected because the Boss knows
and ingress does not.

It stays because `ignored` is load-bearing. The HTTP layer decides whether a
delivery earns its :eyes: by excluding `ignored`, so the kind is not just a
description — it is the difference between somebody seeing an
acknowledgement and seeing nothing. Collapsing an untagged reply in an
incident thread into `ignored` therefore takes the acknowledgement off the
one message most likely to be an answer a blocked agent is waiting for, which
is the failure the natural-language work exists to remove.

The invariant, tested in `test/e2e.test.ts`: **nothing the relay acts on may
be `ignored` here.** The reverse is allowed on purpose — an acknowledgement
on something that turns out to be nothing is cheap. Of the places that ask
"will anything happen with this", ingress and the relay have to agree in that
one direction.

## Verification fails closed, everywhere

Grafana: missing secret, missing signature, missing or non-numeric
timestamp, out-of-window timestamp, HMAC mismatch, missing or wrong basic
auth — each throws. Timing-safe compare with a length pre-check.

Slack: same shape, `v0=` scheme, replay window.

**The timestamp header is the silent one.** Grafana only sends one if the
contact point explicitly names it; there is no default. Without it Grafana
signs the body alone, which is replayable, so ingress rejects every
delivery. The symptom is "the webhook does nothing", with no error anywhere.

A missing secret is the same shape of problem: BugBoss boots healthy,
answers `/health` with 200, and rejects 100% of deliveries at info level.

## Resolve notifications are discarded

An alert that fired means something needed attention. An alert that stopped
firing on its own does not mean it no longer does — the symptom went away,
which is not the same as the cause being handled.

So a resolved delivery produces no signal and leaves no state. This used to
mark the fingerprint resolved in a process-local set, which did not survive
a restart and fed a resolution path that manufactured duplicate incidents.
Both are gone.

## Evidence fails loudly, and this is the pattern to copy

`grafana.ts` returns a per-query `EVIDENCE UNAVAILABLE … the cause is
neither confirmed nor ruled out` entry rather than an empty result, and
reports causes past the six-query cap as `NOT CHECKED`.

That distinction — "we did not check" versus "we checked and found nothing"
— is the difference between a triage decision that is wrong and one that is
wrong *and* looks informed. The rest of the system should copy this shape.

The cost of that graceful degradation is that a misconfigured Loki client
never surfaces: a wrong proxy path or a dead token reads exactly like an
alert with nothing to say. So the request shape is tested directly in
`loki.test.ts`, which is the only place that failure becomes visible.

## One Grafana credential, not two

`createLokiQuery` queries Loki through Grafana's datasource proxy
(`/api/datasources/proxy/uid/<uid>/loki/api/v1/query_range`) with the
service account token, not the Loki endpoint directly with a Grafana Cloud
access policy token.

Both work. The proxy is chosen because the agents already hold a service
account token for the Grafana MCP toolset, and the direct route needs a
second credential minted in a different portal with its own rotation. Two
Grafana credentials where one will do, with triage authenticating by a
different mechanism than the agents it hands off to, is a split that rots.
The path after the proxy prefix is the Loki API verbatim, so this costs a
base URL and nothing else.

## Two traps

**Renaming the `known_causes` annotation** on the omni side makes every
alert look like it has none. It fails safe, and silently removes every
pre-fetched piece of evidence triage was going to run on. The zero-cause
rate is logged per delivery so it is visible; no threshold alarm exists
because nobody knows the legitimate baseline yet.

**Grafana truncating a burst** is alarmed on. `maxAlerts: 0` at the contact
point is what prevents it, and that is a UI setting whose omission is
otherwise silent.
