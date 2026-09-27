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

## The :eyes: goes on before the work, not after it

`ack.ts`. Slack's three-second ack is answered by the HTTP layer and seen by
nobody. What a person watching the channel sees is the post that follows, and
that is seconds away for a bug report and up to two minutes away for a
mention. For that whole window a Boss that is working looks exactly like one
that never got the message, and the second is the likelier guess.

So `http/public.ts` reacts the moment `classifySlackEvent` returns, before the
relay, the ingest or the model. Three kinds earn it — `bug_report`, `mention`
and `incident_reply` — and it is written as "anything but `ignored`", so a
classification added later is acknowledged by default. `ignored` is excluded
on purpose: an :eyes: on chatter nobody addressed to BugBoss claims it is
working on something it will never answer.

`createSlackAck` returns **`void`, not a promise**, and that is the contract.
Slack retries any delivery it has not seen answered in three seconds and a
retry is a second run of the same work, so a caller that cannot await the
reaction cannot put it in front of the 200.

A refused reaction never fails the message — the answer still posts — but it
is not swallowed either. `already_reacted` is ordinary (a retry, and the two
copies Slack sends of a threaded mention) and **logs**; everything else
**alarms**. `missing_scope` in particular: `reactions:write` is in
`slack-app-manifest.yaml` and does nothing until someone reinstalls the app,
and swallowed it would look identical to a BugBoss that is working fine. The
delegate reviewer bot swallows exactly this, which is why its broken dispatches
are invisible.

**Nothing removes the reaction.** There is no one completion event to swap it
for: a mention is done when the answer posts, a report is done somewhere
between triage and resolution, and a thread reply is done when an agent reads
the directive — which is not something the HTTP edge can see at all. A ✅ would
have to pick one and be wrong for the others, and a swap that half-fails leaves
a reaction that lies. The :eyes: means "received", and that stays true.

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

## Block Kit for one message: a question with its answers

Every message here is plain `text` mrkdwn — except an agent's `contact_human`
question when it passes `options`, which posts as `blocks` with a button per
option (`blocks.ts`). Nothing else earns them. Block Kit's other offering is
visual structure, which is mostly `header` blocks: `plain_text` only and
capped at 150 characters, so they cannot carry an incident title anyway.

**Buttons are an affordance, never a command language.** The rule this system
runs on is that every human interface takes natural language; a button is a
shortcut past typing, not a thing you have to press. So the same question is
always answerable as prose: the options are numbered in the message body, the
`text` fallback carries the whole question, and a typed reply reaches the
agent by the path it always did. An agent that writes a question only a
button can answer has written the wrong question, and the tool says so.

Three constraints hold whatever the message:

- `blocks` **needs** a `text` too, or every notification for it reads "This
  content can't be displayed" — which on a phone is the entire question.
- `section` text is mrkdwn, so the escaping in `format.ts` applies unchanged.
  A button *label* is `plain_text` and capped at 75 characters; it escapes for
  display, but the `value` that comes back stays raw, because that value is
  the answer the agent reads.
- A section block and a Slack message share a 3,000 character ceiling, so a
  question longer than one message posts its front half as plain text and the
  buttons hang off the last part — the one that ends in the question.

An ask is two posts: the question, then `details` underneath it. The buttons
go on the **question**, which is also the message `pending_question.messageTs`
records — `/thread` fills that column only while it is blank, so the later
`details` post cannot repoint it and a press keeps matching the message it was
made on. A press that changed nothing is still silence: the wait floor and the
automatic hand-off in `agent/tools.ts` run exactly as they do without buttons.

## A press is a reply, and is recorded as one

`SlackRelay.handleChoice` writes the same `thread_reply` row and pushes the
same `human_message` directive a typed answer does, carrying the label the
agent wrote. So `contact_human` cannot tell the two apart, and everything
downstream of it — including whatever classifies an answer — only ever sees
prose.

Anyone in the channel may press. The two guards that keeps honest are in the
`INSERT` statement rather than around it:

- `WHERE EXISTS (… pending_question … messageTs = ?)` — that table holds the
  one question an agent is actually waiting on. A press quoting any other
  message is a press on a question already answered or timed out, and filing
  it would answer whatever is being asked *now* with a label from before.
- the derived id `<channel>:<question ts>:choice` — one question takes one
  answer, however many people press and however often Slack redelivers.

A press that changes nothing still gets a line in the thread. A button that
silently does nothing is indistinguishable from a broken one, and the person
who pressed it would go on waiting for an agent that never heard them.

## Interactivity arrives down `/slack`, as a form

Slack posts a press to the Interactivity Request URL as
`application/x-www-form-urlencoded` with the JSON in a `payload` field —
different parsing from the Events API, the same `v0=` signature over the same
raw body, the same three-second budget. The content type is the whole
discriminator (`isInteractionDelivery`).

It shares `/slack` rather than taking a path of its own because the ALB
listener rules in `deploy/components/bugboss.ts` are an allowlist: a new path
is a Pulumi change and a deploy before a click can reach the process at all.

The route answers an **empty** 200. A JSON body there is read by Slack as a
replacement for the message that was clicked, which would delete the question
and its buttons out from under everyone else in the thread.

`settings.interactivity` in `slack-app-manifest.yaml` is what makes any of
this reachable, and that file is applied by a person at api.slack.com, not by
CI. Until somebody applies it, the buttons post and render but a press shows
the presser a Slack error; the numbered options and free text still answer.

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
