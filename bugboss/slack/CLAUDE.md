# slack

Outbound transitions into an incident thread, every inbound reply to the
Boss, and the Boss's own Slack agent.

## The thread is the record

Everything for an incident happens in one thread. There is no dashboard and
no slash command, because a second surface is a second place to look and the
thread is already the whole story.

`slackThreadTs` is written when `opened` posts. If that write is lost, every
later `emit` takes the no-thread path and posts a **new top-level message**
— so merged, resolved and closed become scattered orphans that do not
even group, and Slack returns success each time. The fallback therefore
alarms and adopts its own post as the thread, rather than logging quietly
and fragmenting forever.

A merge or a split leaves two threads that have to point at each other, and a
thread is only findable by its permalink. `chat.getPermalink` builds one from
the workspace domain, which is why it is an API call rather than string
concatenation; it needs no scope of its own.

The same applies to anything that names an incident it is not standing in,
and "Incident 4" with no link is something the reader has to go and hunt for
in the channel. Nothing that composes a message has to think about that:
every outbound message passes through the pass in `slack/incidents.ts`, which
links a named incident unless the reader is already in its thread. See
"Incident references are rendered by code" below.

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

It only teaches anything if it can read the answer, and **Slack's own links
carry a query string** — `?thread_ts=…&cid=…` on a link to a message inside a
thread, which is also what "Copy link" hands a person. `ARCHIVE` anchored past
the timestamp for a while and so matched none of them, which cost nothing a
reader could see and turned every answer into one Slack call per incident.
That is the reason it **alarms** rather than logs: correct links, a tenfold
rise in API calls, and no symptom at all. It alarms **once per linker**,
because one build that cannot read its answers cannot read any of them and
fifty identical alarms is how an alarm stops meaning anything.

Only two fields are read out of an answer, the workspace and the channel, and
the query parameters are deliberately not among them. `thread_ts` names the
**parent** of the message that was linked, which is a different timestamp from
its own `p<ts>`; every caller here asks about a thread's parent, and the links
derived afterwards are built from the timestamp the caller passed. Reading one
back out of the url would point later links at the wrong message.

## Every reply in an incident thread goes to the Boss

Tagged or not, a message in an incident thread is recorded in `thread_reply`
and handed to `SlackAgent.handleIncident` with the incident as context. The
Boss answers, stays silent, or tells the agent something with a
`boss_message` directive. Nothing on the way reads what the message meant, and
no human text reaches an agent except through the Boss.

That is why there is no reply classifier, no "who was that for" and no
`@bugboss` override in a thread. Those existed because a reply went straight
to the agent and could end its wait on an offhand remark. The Boss is the
reader now, and two people talking to each other is a message it lets pass.

The `thread_reply` insert stays inside the Slack ack because its id derives
from `(channel, ts)`: it is what collapses a Slack retry, so the Boss does not
run twice on one message. A reply does **not** lift an `incident_wait`. The
Boss telling the agent something does (`pushDirective` on a `boss_message`),
because an agent relaunched for chatter has nothing new to read.

A reply here has to stay visible at ingress: `classifySlackEvent` keeps an
`incident_reply` kind, and the HTTP layer keys its :eyes: off not being
`ignored`. See `ingress/CLAUDE.md`.

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
— and so does `incident_reply`, any reply in a thread BugBoss owns, which is
how a person talks to the Boss about an incident. The invariant that keeps the two layers honest, tested in
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
between triage and resolution, and a thread reply is done when the Boss has
answered or chosen not to — which is not something the HTTP edge can see. A ✅ would
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
| `report_resolved`'s evidence, `escalate`'s brief | `THREAD_PROSE_CHARS`, rejected ahead of the post |
| `report_analysis`'s post-mortem | **none** |

**The thread is short; the document is complete.** The post-mortem is the
exemption because it does not go to the thread as text — it leaves as the
closing report, a Markdown file (`report/CLAUDE.md`). The one place the
document does reach the thread is the degraded path when the upload fails, and
that call is `postDocument` rather than `postProse` so the exemption is a name
somebody can grep for instead of a check somebody forgot.

Harness-written posts are the exception to the exception: `unansweredBrief`,
`stalledWaitBrief` and `heartbeatMessage` are composed when the model is no
longer in the loop, so there is nobody to refuse them to — and the wait nudge
is *dropped* on a failed post by design, because losing a day-long wait to a
503 is the worse trade. An over-long one would therefore mean an incident that
waits all day, nudges nobody, and then escalates claiming it nudged three
times.

They used to buy the fit by clamping the one field with nobody behind it: the
check's own output, cut to 400 characters. **They do not clamp anything now.**

- The nudge and the re-run notice go out through `postNotice`, which marks
  them `harnessComposed` on the wire. The `/thread` route skips the budget
  for those and sends them through `postDocument`, so a long one splits.
  Splitting a post nobody can rewrite is the whole point: it costs a second
  message, where a refusal costs the message.
- The stalled-wait brief cannot take that route, because it goes through
  `escalate` and a brief is a brief. So it carries no output at all and says
  the output is in the message below it — `stalledWaitStatus` posts that,
  whole, on the harness path, right after the escalation lands.

What still has to fit `THREAD_PROSE_CHARS` is the part the harness *wrote*,
with the model's own fields at their refused maximum. `tools.test.ts`
composes the worst case of each to keep that true.

## Incident references are rendered by code, on the way out

Every incident BugBoss names reads "Incident 4", capitalised, and carries a
link to its thread unless the reader is already standing in it.

That used to be a line in the Slack agent's system prompt — *"every incident
you name that is not the one whose thread you are standing in gets a link to
its thread, written `<permalink|incident 4>`"* — so it was followed
probabilistically. Some answers linked and some did not, and the casing
wandered between "incident 4" and "Incident 4" inside one message. It is
`slack/incidents.ts` now: a pass over finished mrkdwn that normalises always
and links conditionally.

**This is not the deterministic matching this codebase refuses.** That rule
is about reading what a person meant, where a fixed phrase is a magic word
nobody can guess and everybody mistypes. This is our own output, on the way
out, put into one shape. Determinism is the point of it.

**The seam is the client, and it has to be.** There is no single place above
it where outbound text is composed: `relay.ts` splits and posts for itself,
`agent.ts` goes through `postProse`, `toolapi/index.ts` and
`toolapi/announce.ts` each run their own `splitForSlack` loop, `report/` uses
`postDocument`, `http/toolapi.ts` does two of those, and the composition root
posts directly in three more places. A pass on some of them would be the same
inconsistency with a new cause, which is worse than the old one because it
looks fixed. So `withIncidentReferences` wraps the `SlackClient` itself,
outside the deadline wrapper, and a surface added later gets it by default.

Three things bound it:

- **It skips what it must not touch.** Code spans, fenced blocks and Slack
  entities are protected by the same `PROTECTED` regex `toMrkdwn` splits on,
  exported rather than copied so the two cannot drift. A reference inside a
  link label is still capitalised — the label is text a reader sees — but
  never re-linked.
- **It matches one shape only:** the word, then one number. Not "incidents 4
  and 5", where the 5 would have to be recognised as an id purely from
  sitting after a conjunction. A bare number is a count, a duration and an
  hour of the day far more often than it is an incident, and a link to the
  wrong thread looks exactly as authoritative as a right one. A miss is
  readable prose; an invention is a lie with a link on it.
- **A link is never worth an answer.** A permalink that fails or an incident
  with no thread costs the link and nothing else.

The lookups are **sequential**, for the reason the query tool used to give
before it stopped handing out links: the linker learns the workspace from its
first real answer and derives the rest, so a board naming ten incidents is
one API call in order and ten fired together. One refusal stops the rest of
that message asking, because ten against a Slack that is refusing is ten
consecutive ten-second deadlines paid by whoever is waiting on the post.

`permalink_shape_unknown` is the alarm to keep in mind if you touch this.
`createCachingLinker` collapses every link to string work once it has parsed
the workspace domain out of one real permalink; when it cannot, every link
costs an API call. This pass asks for a link every time an answer names an
incident, so it memoises per incident for the life of the process — an
incident's thread is written once, under `WHERE slackThreadTs IS NULL`, so it
never moves. Only answers are held. A *missing* one is re-asked, because the
relay posts the rest of a split opening message into the thread before it
records that thread on the incident: "this thread belongs to no incident" is
true for a moment and false forever after.

## One renderer, three surfaces

A status-board row and an incident thread's top-level message are the same
three fields at different scales, so they are one renderer (`slack/board.ts`):

| Field | Where it comes from |
| --- | --- |
| status | the incident row |
| the few-word title | `incident.summary`, falling back to the first signal's title |
| what is needed | `incident_wait.waitingFor`, or "nothing needed from anyone" |

None of the three is new state. The third in particular is derived rather
than invented: `waitingFor` is already *"what is being waited on, in one line,
for the thread and the digest"*, and an incident with no wait needs nothing.
Saying that out loud is what makes the ones that do worth trusting.

Nothing in the renderer resolves a link. Every line names its incident in
prose and the pass above links it — which is also what stops a thread's own
header linking to itself, with no special case anywhere.

The surfaces:

- **The thread header.** Two lines above the message that opened the thread,
  rewritten in place with `chat.update`. Nothing is removed: the alert text
  that started the thread is what somebody scrolling back is looking for.
  This division is why the opening message carries the signal **whole** and
  the header carries the short form. Incident 83 opened on "*...I heard
  about 502s Can you op…*" because the opening message tried to be the short
  form too, on a title cut at 120 characters. The header has `summary`, the
  few-word title the agent keeps current and that `setSummary` refuses
  rather than truncates; the message under it has the report.
  An edit is **silent** — Slack marks it "(edited)" and notifies nobody — so
  it is right for a header people re-read and wrong as a way to tell anyone
  anything. A change worth knowing about still posts in the thread as well.
- **The board on request.** `incident_board`, a tool on the Slack agent that
  hands back the rendered text for it to paste verbatim. A board the model
  composed from `query_incidents` would be a fourth rendering of the same
  three fields, disagreeing in whatever way that run happened to phrase it.
- **The morning board** and **the all-clear**, both driven by the sweep in
  `board/index.ts`.

The opening message's trailer links the signal that opened the incident —
`<url|a Grafana alert>` or `<url|a Slack report>`, from `ingress/link.ts`.
It used to say "1 signal" and give no way to reach it.

`chat.update` replaces a message wholesale and the only way to read the
original back is `conversations.replies`, which is throttled to roughly one
request a minute. So the relay records the opening text in `incident_thread`
when it posts it. An incident opened before that table existed has no row and
gets **no header** — the one answer that cannot delete somebody's alert text.

## Nothing here reads the words a person chose

Two readers of inbound human text, and both are models:

- **In an incident thread**, the Boss itself, with the incident, the thread
  and its inbox in front of it. There is no separate classifier.
- **On a mention anywhere else**, `intent.ts`: whether somebody is reporting
  something broken, asking a question, or asking for two incidents to be
  combined.

The mention read used to be a string matcher on the first word — `report`,
`bug` or `broken` — so `@bugboss Pro upgrades are failing` was answered as a
question and opened nothing. A magic phrase nobody can discover is not an
interface. Every outcome of the read is said out loud: an ambiguous read asks
which it was, and a failed model call says the call failed. Silence is what
the old matcher did, and silence is indistinguishable from the bot not reading
you.

The relay records and routes; it does not decide what a message meant.

### The mention read is advisory

Same split as `triage/`: the model reads the sentence, the code keeps the
invariants. The only read that writes is a combine, and three code-side checks
bound it: every id must appear literally in what the person typed, both must
name incidents that can still take signals, and which of the two survives is
`assign`'s rule rather than anything said in the message. It writes under the
`human` actor, with the Slack user id off the verified event, never out of the
text.

The message is fenced in a `<MESSAGE untrusted="true">` block with the rule
stated in the system prompt, the same framing triage puts around an alert
body. That is worth having and is not what the containment rests on.

### Cost, latency and the failure path

One bounded call per mention: a few hundred tokens in, a label or two out, no
tools and no database access. It runs on the same `ModelClient` triage uses;
`BUGBOSS_INTENT_MODEL_ID` moves it to a smaller model without a deploy.

It runs **off the Slack ack**, in the `settled` promise, next to the Slack
agent. That costs a report its durability before the ack: what makes a mention
a report is the model call, and recording every mention as a signal first
would open an incident for every question. A report typed into the window
between the ack and the read is lost with a 200 already sent. This container
restarts on every merge to ops `main`, so that window is real, and closing it
properly means a durable inbox rather than a different place to put the call.

A failed call answers `unclear`, alarms with the module's fallback rate
(`triage/health.ts`), and posts a line saying the read failed rather than that
the message was ambiguous. Those are two different sentences on purpose.

### Combining two incidents from a mention

Somebody says "82 and 79 are the same bug, merge them" at the bot and it
happens. An agent may only re-partition its own incident, so before this the
one legal move left to an agent being asked was to open a *third* incident.
From inside an incident thread the same request is the Boss's to act on, with
`merge_incidents`, which calls the same `assign` and `announceMerge` pair.

`combineIncidents` in the composition root runs it. Out in the channel
nothing supplies a second side, so both have to be named, and every way a pair
fails to form asks which incidents rather than dropping the message. A
hallucinated id and a real request look the same from inside, and the cost of
asking on a misread is one line.

Everything it checks, it checks **inside the write**: both incidents still
exist, both can still take signals, and which signals move. The write queue
serializes behind a synchronous S3 PUT, so a list read beforehand could drag
signals out of a third incident a correlation merge moved them to in the gap.

It does not choose a direction: the more established incident survives, and a
person who asks for the other direction gets this one and is told so. What
follows is the same pair of messages correlation leaves — the absorbed thread
closed out with a permalink to the survivor, and the survivor told where the
signals came from.

## The Slack agent is read-only, deliberately

`prepareQuery` in `triage/sql.ts` enforces it — one guard for both surfaces,
rather than the two that used to disagree about what a read was. It answers
questions about incidents; it cannot merge, close, stop or restart anything.
Everything a person changes, they change by replying in the thread the agent
is reading.

`search_incidents` is the same tool triage calls, adapted to this surface's
tool shape. Its three answers have to stay three: matches, `0 matches` for a
corpus that has nothing like this, and an `error:` for a query that never
reached the index. A search that never ran, reported as nothing found, tells
somebody asking "have we seen this before" that the problem is new.

What a run spent comes back from the harness beside the answer and lands on
the `answered` log line. The wrap-up call and a call that failed are both in
it: the run that cost the most is the one that answered least.

Its failures must not die in the channel that failed: the in-thread apology
is tried first, and if that throws it is logged distinctly and re-posted to
`alertChannel`. Both use the same token and API, so the likely causes — a
revoked token, the bot removed, exhausted rate-limit retries — fail both
identically.

`alertChannel` and `rotationGroupId` are **required**, not optional. An
optional field nobody sets is a fix that exists in the source and not in
production, which had already happened three times here.

## The Slack agent compacts; it does not narrow its results

Its loop is hand-rolled (`createSlackAgentModel`, in the composition root)
and its transcript is persisted per thread, so it grows across a run *and*
across mentions. That used to be bounded the only way it could be with no
compaction: every tool result was cut — each SQL row at 2,000 characters,
the session tail at 24,000, `get_incident` at 100,000. A row cut in half is
a row the model reads as complete and answers off, which is the failure
those caps were buying protection from a different failure with.

`compactTranscript` replaced them, on the shape Pi uses for the incident
agent: measure after a result lands, before the next request, and drop the
oldest **whole round** rather than narrowing anything.

- Rounds, not turns. Anthropic rejects a tool result that is not immediately
  behind the assistant message that called for it, so a cut between the two
  is a 400 and not a smaller request. A round starts at a `user` *or* an
  `assistant` turn — assistant matters, because one mention is one user turn
  and then however many tool rounds it takes, so user turns alone give one
  boundary per mention and nothing to drop inside the run that is growing.
- The question survives. If the cut reaches past it, it goes back on the
  front: a transcript has to open on a user turn, and that is the turn worth
  spending.
- The model is **told** what is gone, on that turn. A round that vanishes
  silently is a round it will go and read again.
- The window is read off the model (`SizedModelClient.contextWindow`), never
  chosen. `resolveBedrockModel` throws rather than substitute one for the
  same reason: a wrong window is invisible in both directions.
- One round larger than the window is kept whole. It fails loudly at the
  provider and the reader is told the question was too big, which beats
  being answered off half a row.

What is left bounding this surface counts **things**: `MAX_SQL_ROWS`,
`MAX_SESSION_TAIL_LINES`, the reply `LIMIT`. Never a width.

## A budget spent reading is a question left unanswered

Every tool call costs the Slack agent a turn, and the run stops when the
budget does. Asked what the state of all the incidents was by somebody on
call, it read eleven incidents one at a time, ran out, and posted "I ran out
of turns before I had an answer for that" — worse than silence, because
silence does not claim the question was understood and then abandoned.

Three things were wrong and all three had to change; fixing any one alone
just makes the other two cheaper.

**A question about more than one incident is one `query_incidents` call.**
`get_incident` is depth on one. The prompt carries the open-incident query as
a worked example rather than an instruction to choose well, because an
example changes what the model does where an adjective does not — the same
reason the incident agent's prompt is written that way.

**`SLACK_AGENT_MAX_TURNS` covers the work a reasonable question implies.**
The widest reasonable one is "tell me about everything": a query across the
open incidents, then depth on the few that need it, then the answer. Twelve
did not cover eleven incidents. What bounds this is how long somebody will
sit in a thread waiting, not the bill — this surface is read-only and runs
on the same model triage does, nowhere near what an incident agent costs.

**The thread lock is derived from that budget, not chosen.** A lock that
expires mid-run is not a lock: the next mention takes the thread and two runs
write one transcript key. `SLACK_AGENT_LOCK_TTL_MS` is every turn plus the
wrap-up, each spending its whole call budget, so raising the turns raises the
lease with it. Long is the safe direction — `handle` releases in a `finally`,
so the lease only ever covers a run that never settles, and telling the next
person the thread is busy beats corrupting the session they are asking about.

**Exhaustion no longer throws the run's work away.** Everything it read is
still on the transcript, so the harness (`createSlackAgentModel`, in
`index.ts`) spends one more call with no tools attached, which the model
cannot answer any way but from what it already has. It is told to name the
part of the question it did not reach, so the gaps are in the answer rather
than implied by its shortness. Running out is still a real event and still
**alarms** — visible to whoever owns the budget, not to whoever asked the
question.

A wrap-up that produces nothing is **not** the same as one that fails, and
until recently only the second was visible: an empty completion raises no
exception, so `slack_agent_wrap_up_failed` never saw it. That is the shape
production hit — a run holding everything it had read, a model that answered
with nothing, and an apology posted with nobody told. It alarms on its own now
(`slack_agent_wrap_up_empty`). The alarm cannot make the model speak; what it
closes is the silence around it.

What is left when even the wrap-up produces nothing is **two** replies, not
one, because running out of turns and failing to compose anything need
different advice. Running out says so, and says how many turns over how long,
because the minutes of silence are the only thing the reader experienced and
they are owed the size of them. It does **not** say "ask me again": the budget
is spent the same way by the same question, so a retry buys another wait for
the same non-answer. It asks for a smaller question instead. The other case
really can be a bad minute, and there asking again is the right thing to try.
Neither sends anybody to the logs — the person reading this is on call in the
middle of something else, and whoever owns the budget has the alarm already.

**The transcript always ends on the assistant**, whatever happened. Whatever
the harness returns is what gets posted, so it is recorded as the turn it
was. Left ending in tool results — which a wrap-up that threw does — the next
mention pushes its question straight behind them, and tool results and a
question are both user messages to the model, so the resume is rejected
before it starts. That break surfaces hours later in another process with
nothing pointing back at the run that caused it, which is why it is closed by
construction rather than on the one branch somebody noticed.

**An on-call answer has a shape**, and it is the commonest question this
surface gets: what is blocked on a person and what that person has to do,
what is running and needs nothing, and the count first so the reader knows
the size of it. Around 200 words, in plain terms — what the system is doing
and what users see, not file paths, function names or column names. Plain is
not vague: the numbers stay, the identifiers go, and depth comes when
somebody asks for it.

## Rate limits

`chat.postMessage` is limited per channel at roughly one a second, and every
incident posts to the same channel. The SDK defaults to ten retries over
about thirty minutes and does **not** reject a rate-limited call, so a 429
parks the caller inside the SDK with nothing thrown and nothing logged.

The client pins a five-minute policy, and posts are off the ingest request.
Both matter: every transition notice waits on one.

`chat.update` is Tier 3, roughly fifty a minute, and shares that budget.
The board sweep edits only threads whose rendered header actually changed,
so a steady state costs nothing, and it caps what one tick may rewrite so a
mass status change cannot burst against the posts that are notifications.
Each edit goes through the same ten-second deadline, so a Slack refusing
edits costs the sweep a tick rather than the process. `board/CLAUDE.md` has
the rest.
