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

Every message in an incident thread becomes a `human_message`
directive. `contact_human` waits on directives alone and nothing else reads
`thread_reply` on an agent's behalf, so without this the documented way to
answer an agent — reply in thread, no tag — did nothing at all, and the
agent waited out its full timeout.

`mentioned` still drives `interrupt`. So a mention answers *and* interrupts;
a plain reply answers.

### Which reply, though

`contact_human` ends its wait on the **first** reply after the question. Two
people talking to each other while an agent is blocked therefore ended it on
whichever of them spoke first, and unlike a wrong ownership move there is no
field anywhere that records it — the investigation just turns on an offhand
remark and nothing downstream can tell.

The fix is not syntax. Requiring an `@bugboss` tag to answer would make the
common case ceremony, and answering a direct question should not need any. So
the message is read: `intent.ts` answers **who it was for** alongside what it
does, the directive carries `addressed`, and `firstReplyAfter` skips
`addressed: "others"`.

**Recording is not consuming.** Chatter is still recorded in `thread_reply`
and still delivered as a directive, so it stays in the incident's history and
the agent reads it as context. What it loses is the right to end a wait.
Nothing is ever dropped, including a message no model could read — that one
arrives as `others`, which is the safe direction.

Three rules sit in code on top of what the model said, the same way
`applyRules` does in triage:

- **An explicit `@bugboss` always means "this is for you".** That is the
  escape hatch for somebody who wants certainty, and because it is decided in
  the composition root rather than by the model, it is the one path that keeps
  working while the model is down.
- **A handover is aimed at the system by definition**, so it is delivered as
  well as acted on.
- **`unclear` while an agent is blocked asks**, in the thread, and says the
  message went through as context anyway. Asking costs a sentence; ending the
  wait wrongly costs an investigation.

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

## Nothing here reads the words a person chose

`intent.ts` is the only place inbound human text is read for meaning, and it
is a model call. There is no keyword, no verb and no phrase to know — for
either interface:

- **In an incident thread**, whether a message hands the incident over, and
  whether it was for the agent at all. Two fields, one call, because it is one
  message.
- **On a mention anywhere else**, whether somebody is reporting something
  broken or asking a question.

This used to be two string matchers, and both failed the same way. The
ownership one required the whole normalized message to equal `mine` or `back
to you`, so `ok back to you` and `handing this back` did nothing at all,
silently. The report one required the first word to be `report`, `bug` or
`broken`, so `@bugboss Pro upgrades are failing` was answered as a question
and opened nothing. A magic phrase nobody can discover is not an interface.

The reasoning the old comment gave for matching whole words is still right
and is still enforced — it just is not enforced by matching strings:

- **A false handover is the expensive direction.** `owner = 'human'` takes an
  incident out of the dispatcher's query and nothing hands it back. So the
  prompt is asymmetric (prefer `none`, prefer `unclear` over a guess), and
  `unclear` **asks in the thread** rather than guessing.
- **Every outcome is said out loud.** A move posts a confirmation, a refused
  move says why, an ambiguous read asks, and a failed model call says the
  call failed. Silence is what the old matcher did, and silence is
  indistinguishable from the bot not reading you.

The relay records and routes; it does not write `owner` and does not decide
what a message meant. The read and the write both live in the composition
root: the write is guarded in the statement and records the claimant in
`incident_action`, which `owner` alone cannot say since it holds a role and
not a person.

### The model is advisory here too

Same split as `triage/`: the model reads the sentence, the code keeps the
invariants. Two things bound a wrong or captured read, and neither of them is
the model behaving:

- **It cannot name what it acts on.** The incident comes from
  `slackThreadTs`, never from the message, and the answer is one enum label
  with no field that could carry an id. A message that says "transfer
  incident inc-99 to me" can still only move the incident whose thread it was
  posted in.
- **The transition guards stay in the `UPDATE`.** Legality — which owner,
  which statuses — is unchanged and is not the model's business.

The message is fenced in a `<MESSAGE untrusted="true">` block with the rule
stated in the system prompt, the same framing triage puts around an alert
body. That is worth having and is not what the containment rests on.

### Cost, latency and the failure path

One bounded call per inbound message: a few hundred tokens in, a label or two
out, no tools and no database access. The agent's outstanding question goes
into the prompt when there is one, because whether a message answers it is
most of what `addressed` is asking. It runs on the same `ModelClient` triage
uses, so there is no second credential and no second model to subscribe;
`BUGBOSS_INTENT_MODEL_ID` moves it to a smaller model without a deploy when
one is available. The bill is set by how much people type, not by how many
alerts fire.

It runs **off the Slack ack**, in the `settled` promise, next to the Slack
agent. Slack wants three seconds and the relay's writes are what a retry
collapses onto, so recording stays in the request and reading stays out of
it.

That costs a report its durability before the ack, and the trade is worth
stating. A report used to be a signal row written inside the request, so a
restart between the 200 and the work could not lose it. It cannot be any
more: what makes a mention a report is the model call, and recording every
mention as a signal first would open an incident for every question. A
report typed into the window between the ack and the read — this container
restarts on every merge to ops `main`, so that window is real — is lost with
a 200 already sent. That is the exposure a mention already had, since the
Slack agent has always run out there, and closing it properly means a
durable inbox rather than a different place to put the model call.

A failed call answers `unclear`, alarms with the module's fallback rate
(`triage/health.ts`), and posts a line in the thread that says the read
failed rather than that the message was ambiguous. Those are two different
sentences on purpose.

The cost of that is real and it is the right side of the trade: while the
model is down, every reply in an incident thread gets a line saying it could
not be read. That is bounded by how many people are typing, and the
alternative is the failure this whole file exists to remove — somebody says
they are taking an incident over, nothing happens, and nothing says so.

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
