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

## Slack renders mrkdwn, and Markdown renders wrong

`format.ts` is the only place text is prepared for Slack, and everything that
posts goes through it. Markdown does not degrade in Slack, it renders broken:
`**bold**` shows its asterisks, `## Root cause` shows its hashes, `[a](b)` is
not a link, and a pipe table is a wall of pipes.

Two kinds of text, escaped differently:

- **Values** — signal titles, slugs, ids, counts. Data, never formatting, so
  the `` mrkdwn`` `` tag escapes every interpolation. `raw()` is the only way
  past it, which makes each exception greppable.
- **Model prose** — root causes, evidence, briefs, post-mortems, the Slack
  agent's answers. `toMrkdwn` keeps the mrkdwn the model meant, converts the
  Markdown it wrote anyway, and escapes the rest.

Escaping is the part that bites. Slack reads `<…>` as an entity, so one `<` in
a quoted log line swallows everything after it and `chat.postMessage` still
returns `ok: true`. The agent reads attacker-writable log lines for a living,
so this is an input, not a hypothetical. `escape` is deliberately **not**
idempotent: a log line containing the literal text `&amp;` has to survive, and
nothing upstream pre-escapes — `agent/prompt.ts` tells the model to write the
raw characters and let the boundary handle them.

`toMrkdwn` will not pass `<!here>`, `<!channel>` or `<!subteam^…>` through. Who
gets paged is the Boss's decision (`MENTION_EVENTS`), and an agent that can
page the rotation for itself is how a rotation at twenty incidents a week gets
muted. They escape, so they render as literal text rather than vanishing.

Conversion happens **at the Slack boundary only**. What the incident stores is
what the agent wrote, so the Slack agent reading `postmortem` back out of the
database gets prose and not `&lt;`-riddled markup.

## Length is a split, never a truncation

`chat.postMessage` accepts 40,000 characters and truncates past it with a 200
back, which is the one failure a reader cannot recover from by reading on. So
`splitForSlack` cuts on line boundaries at 3,000 characters, marks each part
`_(2/3)_`, and closes and reopens a code fence that a split falls inside —
otherwise the rest of a post-mortem renders as code.

## No Block Kit, deliberately

Every message here is plain `text` mrkdwn, which is also what the delegate
reviewer posts in this channel.

Block Kit buys visual structure and interactive elements. BugBoss has no use
for the second — ownership changes by replying in the thread, on purpose, and
a button would be a second surface next to the thread that is supposed to be
the whole record. The first is mostly `header` blocks, which are `plain_text`
only and capped at 150 characters, so the heading Block Kit adds cannot carry
an incident title anyway.

Against that: `blocks` still needs a `text` fallback or the notification reads
"This content can't be displayed"; `section` text is mrkdwn regardless, so the
escaping work is identical; and `SlackPoster.post` is text-only across the
relay, the tool API, the loopback route and every fake in the tests. It is
more moving parts and more failure surface for a thread reply.

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
