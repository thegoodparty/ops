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

A merge or a split leaves two threads that have to point at each other, and a
thread is only findable by its permalink. `chat.getPermalink` builds one from
the workspace domain, which is why it is an API call rather than string
concatenation; it needs no scope of its own.

The same applies to anything that names an incident it is not standing in,
which in practice means the Slack agent: it reads the whole database, so it
routinely talks about incidents whose thread it is not in, and "incident 4"
with no link is something the reader has to go and hunt for in the channel.
So `get_incident` and `query_incidents` return `threadPermalink` on an
incident row, and the prompt tells the model to link what the tools handed
it. The link is withheld -- `threadPermalink` is null -- for the incident
whose thread the answer is being written into, because a link to where the
reader already is is noise, and withholding it is what makes that reliable
rather than an instruction the model may forget.

The alert that says a question went unanswered has the same problem from a
harsher angle: it is read in another channel by somebody who was not in the
thread and has the least context of anyone to reconstruct it, so it links the
thread rather than naming a timestamp. That is the one permalink taking a
channel of its own -- incidents all live in the incident channel, but the
Slack agent answers wherever it is mentioned.

`createCachingLinker` is why an answer naming five incidents is not five
round trips. A permalink is a workspace, a channel and a timestamp, and only
the workspace is unknowable from here, so the first real answer teaches it
and every later link is string work. A permalink that fails alarms and leaves
the bare reference; nothing waits on a second attempt, and a failure is never
cached as an answer.

## A plain reply answers; a mention also interrupts

Every message in an incident thread becomes a `human_message`
directive. `contact_human` waits on directives alone and nothing else reads
`thread_reply` on an agent's behalf, so without this the documented way to
answer an agent — reply in thread, no tag — did nothing at all, and the
agent waited out its full timeout.

`mentioned` still drives `interrupt`. So a mention answers *and* interrupts;
a plain reply answers.

A reply here also has to stay visible at ingress: `classifySlackEvent` keeps
an `incident_reply` kind, and the HTTP layer keys its :eyes: off not being
`ignored`. An untagged reply is the documented way to answer an agent, so it
is the last delivery that should arrive unacknowledged. See
`ingress/CLAUDE.md`.

## The :eyes: goes on before the work, not after it

`ack.ts`. Slack's three-second ack is answered by the HTTP layer and seen by
nobody. What a person watching the channel sees is the post that follows, and
that is seconds away for a bug report and up to two minutes away for a
mention. For that whole window a Boss that is working looks exactly like one
that never got the message, and the second is the likelier guess.

So `http/public.ts` reacts the moment `classifySlackEvent` returns, before the
relay, the ingest or the model. It is written as "anything but `ignored`", so
a classification added later is acknowledged by default, and `ignored` is
excluded on purpose: an :eyes: on chatter nobody addressed to BugBoss claims
it is working on something it will never answer.

Since ingress stopped reading words (see "The human boundary" in
`docs/architecture.md`), the kinds left are what a signature, an event
envelope and a thread id can answer. `mention` earns one — covering a report
and a question alike, because telling those apart is a model call further in
— and so does `incident_reply`, an untagged reply in a thread BugBoss owns,
which is the likeliest message in the system to be the answer a blocked agent
is waiting for. The invariant that keeps the two layers honest, tested in
`test/e2e.test.ts`: **nothing the relay acts on may be `ignored` at ingress.**

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
- **`unclear` asks**, in the thread, and says the message went through as
  context anyway. Asking costs a sentence; ending a wait wrongly costs an
  investigation. Both ambiguities go in **one post**: they were two branches
  with a return each, so a message nothing could read was told about the
  handover and never told its answer had not been delivered as one, which
  leaves the person believing the agent has it. The addressee half is said
  only while a question is outstanding — with nothing blocked there is no wait
  to end and narrating it is noise. Asking is also **not** an else: somebody
  who tagged `@bugboss` in a thread with no agent on it asked a question, and
  an ambiguous handover is a footnote to that rather than a reason to answer
  them with a clarification and nothing else.

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

A `plain_text` field is **not** escaped, and that is not an oversight. Slack
does not parse it for entities, so there is nothing to prevent — escaping only
renders a literal `&amp;` on a button face and grows a string whose length
limit was measured before the escape ran.

## Two length rules, and they answer to different people

`MAX_MESSAGE_CHARS` is Slack's problem. `chat.postMessage` accepts 40,000
characters and truncates past it with a 200 back, which is the one failure a
reader cannot recover from by reading on. So `splitForSlack` cuts on line
boundaries at 3,000 characters, marks each part `_(2/3)_`, and closes and
reopens a code fence that a split falls inside — otherwise the rest of a
post-mortem renders as code. **Never a truncation.**

`THREAD_PROSE_CHARS` is the reader's problem, and it is a **refusal**. A real
thread measured 7 to 98 words for every message this codebase composes and 370
to 426 for the agent's own free text, in the place least able to carry it, so a
thread post is capped at about 200 words and a longer one is handed back. The
two numbers are not alternatives and should not be merged: splitting a 400-word
post into two 200-word posts does not make it shorter.

The budget binds **every** path into a thread, which is the only way it is a
budget rather than a habit one of four callers keeps:

| Path | Bound |
| --- | --- |
| `contact_human`'s ask | 700, tighter still, refused (`tools.ts`) |
| the loopback `/thread` route | `THREAD_PROSE_CHARS`, refused with a 400 |
| `report_resolved`'s evidence, `hand_off`'s brief | `THREAD_PROSE_CHARS`, rejected ahead of the transition |
| `report_analysis`'s post-mortem | **none** |

**The thread is short; the document is complete.** The post-mortem is the
exemption because it does not go to the thread as text — it leaves as the
closing report, a Markdown file (`report/CLAUDE.md`). The one place the
document does reach the thread is the degraded path when the upload fails, and
that call is `postDocument` rather than `postProse` so the exemption is a name
somebody can grep for instead of a check somebody forgot.

A harness-written brief is the exception to the exception: `unansweredBrief`
and `stalledWaitBrief` are composed when the model is no longer in the loop, so
there is nobody to refuse them to. They clamp the text they echo — which is
already in the thread directly above — small enough that the composed brief
provably fits, and `tools.test.ts` composes the worst case of each to keep that
true.

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
