# slack

Outbound transitions into an incident thread, inbound replies back to the
agent, and a read-only agent that answers questions about incidents.

## The thread is the record

Everything for an incident happens in one thread. There is no dashboard and
no slash command, because a second surface is a second place to look and the
thread is already the whole story.

`slackThreadTs` is written when `opened` posts. If that write is lost, every
later `emit` takes the no-thread path and posts a **new top-level message**
— so merged, escalated and resolved become scattered orphans that do not
even group, and Slack returns success each time. The fallback therefore
alarms and adopts its own post as the thread, rather than logging quietly
and fragmenting forever.

## A plain reply answers; a mention also interrupts

Every recorded reply in an incident thread pushes a `human_message`
directive. `contact_human` waits on directives alone and nothing else reads
`thread_reply` on an agent's behalf, so without this the documented way to
answer an agent — reply in thread, no tag — did nothing at all, and the
agent waited out its full timeout.

`mentioned` still drives `interrupt`. So a mention answers *and* interrupts;
a plain reply answers.

## Ownership claims

`ownershipClaim` matches `mine` and `back to you` on the **whole normalized
message**, never a substring. "not mine" and "that one is mine to fix" are
ordinary chatter, and a false positive is the expensive direction.

The relay parses and routes; it does not write `owner`. The write lives in
the composition root, guarded in the statement, and records the claimant in
`incident_action` — which `owner` alone cannot say, since it holds a role
and not a person.

## The Slack agent is read-only, deliberately

`assertReadOnlySql` enforces it. It answers questions about incidents; it
cannot merge, close, stop, restart or take ownership. Ownership changes by
replying in the thread.

Its failures must not die in the channel that failed: the in-thread apology
is tried first, and if that throws it is logged distinctly and re-posted to
`alertChannel`. Both use the same token and API, so the likely causes — a
revoked token, the bot removed, exhausted rate-limit retries — fail both
identically.

`alertChannel` and `rotationGroupId` are **required**, not optional. An
optional field nobody sets is a fix that exists in the source and not in
production, which had already happened three times here.

## Rate limits

`chat.postMessage` is limited per channel at roughly one a second, and every
incident posts to the same channel. The SDK defaults to ten retries over
about thirty minutes and does **not** reject a rate-limited call, so a 429
parks the caller inside the SDK with nothing thrown and nothing logged.

The client pins a five-minute policy, and posts are off the ingest request.
Both matter: an agent blocked in `contact_human` still waits on one.
