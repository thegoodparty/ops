# slack

Outbound transitions into an incident thread, and the Boss's incident
commander, which every person in a thread and every agent talks to.

## The thread is the record

Everything for an incident happens in one thread. There is no dashboard and
no slash command, because a second surface is a second place to look and the
thread is already the whole story.

`slackThreadTs` is written when `opened` posts. If that write is lost, every
later `emit` takes the no-thread path and posts a **new top-level message**
— so merged, resolved and closed become scattered orphans that do not
even group, and Slack returns success each time. The fallback therefore
alarms and adopts its own post as the thread, rather than logging quietly
and fragmenting forever. That post is a one-line notice and the transition
goes under it in the thread, because the header sweep rewrites the
top-level message whole on its next tick.

The thread sweep opens a thread for every open incident with no
`slackThreadTs`, every tick, so `opened` makes an empty write before it posts.
With the database refusing writes, the link after the post can never land and
each tick would open another top-level thread and ping the rotation. The empty
write throws first and nothing is posted.

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
Boss answers, stays silent, or tells the agent something with
`message_agent`. Nothing on the way reads what the message meant, and no
human text reaches an agent except through the Boss.

Nothing classifies a reply or asks who it was for, and a thread needs no
`@bugboss` to be heard. The Boss reads every message, and two people talking
to each other is a message it lets pass.

The `thread_reply` insert stays inside the Slack ack because its id derives
from `(channel, ts)`: it is what collapses a Slack retry, so the Boss does not
run twice on one message. A reply does **not** lift an `incident_wait`. The
Boss telling the agent something does (`message_agent` deletes a wait with
`liftsOnReply = 1`), because an agent relaunched for chatter has nothing new
to read.

A reply here has to stay visible at ingress: `classifySlackEvent` keeps an
`incident_reply` kind, and the HTTP layer keys its :eyes: off not being
`ignored`. See `ingress/CLAUDE.md`.

**A follow-up under a Boss answer goes to the Boss too.** Outside incident
threads the route used to be "tagged or dropped", so a person replying to the
Boss the way people reply to anyone — without an `@` — was talking to nobody.
A thread where the Boss already has a conversation (a `boss_thread` row,
recorded by `answerMention` in the composition root and by the runtime when it
creates the thread's conversation) routes an untagged reply to `slack_agent`,
exactly as a tagged one in that thread. Ingress calls
it `boss_thread_reply` so it keeps its :eyes:. Both layers take the one
predicate built in `index.ts`, and it is handed the thread, never the text.

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
envelope and a thread id can answer. `mention` earns one, bare or not,
because what it asks for is the Boss's to read — and so does `incident_reply`, any reply in a thread BugBoss owns, which is
how a person talks to the Boss about an incident, and `boss_thread_reply`, an
untagged follow-up in a thread where the Boss already has a conversation. The invariant that keeps the two layers honest, tested in
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

The budget binds every path into a thread that carries free text and still
has an author to refuse it to:

| Path | Bound |
| --- | --- |
| `report_resolved`'s evidence | `THREAD_PROSE_CHARS`, rejected ahead of the transition (`toolapi/index.ts`) |
| the Boss's `close_incident` and `page_rotation` reasons | `THREAD_PROSE_CHARS`, rejected before anything changes (`boss/commands.ts`) |
| a dispatcher escalation brief (crash loop, launch cap, deadline) | `THREAD_PROSE_CHARS`, through the tool API's `escalate` |
| the Boss's own answer (`slack/agent.ts`) | its prompt's "about 200 words"; `postProse` splits it, nothing refuses it |
| code-composed notices: `report_root_cause`'s split and merge notices, impact changes, closed notices, the dispatcher's stale notices | none; code writes them |
| `report_analysis`'s post-mortem | **none** by characters; `practiceChanges` is refused outside about 100-300 words |

An agent's `escalate` and `message_boss` are not on the list. Both land in
`boss_inbox` (`boss/inbox.ts`), and the Boss decides what of them reaches the
thread.

**The thread is short; the document is complete.** The post-mortem is the
exemption because it never goes to the thread as text — it leaves as the
closing report, a PDF attached to the close notice (`report/CLAUDE.md`).

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
`toolapi/announce.ts` each run their own `splitForSlack` loop, `http/toolapi.ts`
does two of those, and the composition root posts directly in three more
places. A pass on some of them would be the same
inconsistency with a new cause, which is worse than the old one because it
looks fixed. So `withIncidentReferences` wraps the `SlackClient` itself,
outside the deadline wrapper, and a surface added later gets it by default.
The close notice is the one message that reaches Slack another way, as the
comment on the closing report's upload, so the composition root runs it
through the same pass before handing it to the uploader.

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
relay posts the rest of a split message into the thread before it
records that thread on the incident: "this thread belongs to no incident" is
true for a moment and false forever after.

## One set of status facts, rendered by code at two scales

Asked "what is the status of this incident?", the Boss used to compose an
answer from what it had read and wrote a different shape every time. Status
is facts, so it is rendered in `slack/status.ts` and the Boss pastes it.

| Field | Where it comes from |
| --- | --- |
| lifecycle | `incident.status`, every state in order with the current one in bold (`lifecycleSteps`, shared with the thread header); Merged names the survivor; PARKED when an `incident_wait` has `liftsOnReply = 0` |
| the few-word title | `incident.summary`, falling back to the first signal's title |
| waiting on | `incident_wait.waitingFor`, `pending_question`, `pending_wait.waitingFor` and unread inbox questions, or "nobody"; a parked incident is the one sentence "a person to decide what happens next; the turn budget is spent" and nothing else |
| now | the one model-written line; see below |
| impact, PR, spend | `usersImpacted`, `prUrls`, and `describeSpend` over the agent conversation's `UsageDoc` and `incident.turnsUsed`, with its estimate wording |

Two scales, and `waitingOn` and `lifecycleWord` are shared so they cannot
disagree:

- **The card**, `incident_status`: one incident, seven lines.
- **The status line**: one incident on one line. The board, on request and
  in the morning, is a list of them (`slack/board.ts` delegates to
  `slack/status.ts`). The thread header reads the same facts; see below.

**A monitor wait shows the agent's `waitingFor`, never its command.** The
command is a shell line, and the board once printed one verbatim as what an
incident was waiting on. `STATUS_FACTS_SQL` does not read `pending_wait.command`
at all. A wait recorded before `monitor` asked for a label shows "a check the
agent is running".

**The one-line forms carry no clock.** A header is rewritten whenever its
text changes, so "asked 12 min ago" in it would rewrite every thread's header
every minute against a Tier 3 budget. Only the card shows ages.

**Exactly one line is written by a model.** "Now" is a direct bounded call
(`createStatusSummariser`, on `intentModel` so `BUGBOSS_INTENT_MODEL_ID` can
move it somewhere cheaper) over the agent's
last `STATUS_SUMMARY_TURNS` rendered turns. It is cached per incident at a
**transcript position**, the number of entries in the agent's conversation, so
asking twice about an agent that has not moved costs one call. A failed call renders
"summary unavailable" and alarms; it never falls back to raw lines, and a
failure is not cached.

**The card is pasted, not posted by code**, like the board: what the Boss
writes goes through `toMrkdwn`, which escapes, and escaping is not
idempotent. So the tools hand the model `forModelToPaste(rendered)`, which
undoes exactly what `escape` did, and the one pass at the boundary gives back
the card code rendered. `status.test.ts` holds the round trip.

Nothing in the renderer resolves a link. Every line names its incident in
prose and the pass above links it — which is also what stops a thread's own
header linking to itself, with no special case anywhere.

The surfaces:

- **The thread header.** The whole top-level message of an incident thread,
  rewritten in place with `chat.update`:

  ```
  *Incident 92* · Domain search returns 502 on prod despite available domains
  *Status*: Investigating → *Fixing* → Resolved → Closed
  <generator url|original alert>
  *Needs a human to merge omni#2240*
  ```

  The title is `summary`, falling back to the first signal's title. The
  status is `lifecycleSteps`, the same steps the card shows; a merged
  incident reads `*Merged* into incident N`. The link is the signal's own,
  from `ingress/link.ts`, as a bare label: nothing about the alert goes in
  the header, because that is the signal's data, not the incident's, and
  the Grafana template pasted into Slack rendered broken. The agent reads the
  signal; people click through. No url, no line.

  The last line is there only while a person is needed (`neededFromHuman`):
  a spent budget, a `monitor` wait on a person, a park only a person lifts,
  or the agent's question once the Boss has read it. A `waitingFor` that
  starts "someone to" reads as "Needs a human to"; any other label follows
  a colon. Nothing is waiting on a person, no line.

  An edit is **silent** — Slack marks it "(edited)" and notifies nobody — so
  it is right for a header people re-read and wrong as a way to tell anyone
  anything. A change worth knowing about still posts in the thread as well.
- **The board on request** and **the card on request.** `incident_board` and
  `incident_status`, tools on the Slack agent that hand back rendered text
  for it to paste verbatim, plus at most one sentence of its own. A status
  the model composed from `query_incidents` would be another rendering of the
  same facts, disagreeing in whatever way that run happened to phrase it.
- **The morning board** and **the all-clear**, both driven by the sweep in
  `board/index.ts`.

## Nothing here reads the words a person chose

One reader of inbound human text, and it is the Boss. In an incident thread
it has the incident, the thread and its inbox in front of it; on a mention
anywhere else it has the mention and what was said in that thread since it
last answered. There is no classifier in front of it.

There used to be two. The mention path first ran a string matcher on the
first word, then a model call that knew three labels: report, question,
combine. A request to act fit none, so "Can you close incident 2?" was
answered "Which is it?". The Boss reads which a message is and does it: a
report goes through `open_incident`, a request to close, merge or stop goes
through its write tools, and a question gets an answer.

`buildInput` frames a mention as `<@user> says: …`, never `asks:`, so the
framing does not presuppose a question.

### `open_incident`

Files a report through `reportAccepted` in the composition root, the same
human-signal ingest every report takes. The model supplies only the text. The
reporter is the person whose message started the run, off the signed Slack
event: the mention's user, or in an incident thread the newest person in the
run. A run only an agent's inbox started has nobody to attribute a report to,
so the tool refuses. The mention's ts is the dedup key, so a retry of the
same call in the same run files nothing new.

The relay records and routes; it does not decide what a message meant.

## The commander is the only interface

`slack/agent.ts`. Every message in an incident thread, tagged or not, runs
`handleIncident({ incidentId, trigger })` with `trigger` either the person's
message or `{ kind: "inbox" }`, which is how an agent's `message_boss` or
escalation arrives. Agents never read the thread, so a person is never talking
to one: they talk to the Boss, and the Boss decides what the agent hears.
`handle(mention)` is the other entry point, for an `@bugboss` anywhere else.

**One conversation per thread.** Each Slack thread the Boss talks in, incident
threads included, is one Pi Durable conversation on the shared harness,
recorded in `boss_thread.conversationId` and created on first use by
`createBossRuntime`. It selects only the `bugboss.boss` extension
(`createBossExtension`): the system prompt as its one section, the tools, and
the turn-budget hook. The thread's watermark and the Boss's own reply
timestamps live in `ThreadDoc`, committed in the harness beside the transcript
they describe. A thread idle for `IDLE_EXPIRY_MS` (seven days, from
`boss_thread.lastActivityAt`) is reset on its next trigger: the model stops
seeing last week's reads, and the run is treated as fresh.

**A trigger is a follow-up submission.** The input is built, submitted with
`whenBusy: "followUp"` and `requestId: "slack:<channel>:<ts>"` (or
`inbox:<incident>:<row>`), then waited on, and the answer is posted. A message
that arrives while the thread's run is in flight is queued behind it by the
conversation's own inbox and starts the next run when this one answers; it is
never told the Boss is busy and never dropped. The one thing serialised in
process is admission: reading the watermark, fetching the thread, submitting
and advancing the watermark happen one trigger at a time per thread, so two
triggers never hand the Boss the same stretch of thread. The run itself is not
held by anything. The triggering message is merged into the input too, since
a message posted a moment ago is not guaranteed to be in the fetch yet. A
trigger with nothing new since the last one does not call the model.

What a run was started with -- whether it may stay silent, and who the
reporter is -- is recorded in `ThreadDoc.runs` under its request id before the
submit, because a follow-up queued behind a run is a different run with
different rules and a tool cannot be handed anything by the submit that
started it. Each tool call reads it back through `pi.live` and its run's
first input.

**The incident is always given.** A run is told which incident the thread is,
its status and its title, and what is in the thread -- **BugBoss posts
included**. The opening alert, the root cause, the resolution and the merge
notices are the incident's record, and a Boss that could see only the humans
answered "what is this about" without the one message that says. A fresh
conversation reads the whole thread; a later trigger reads everything since
the watermark except the Boss's own replies, which are already in its
conversation. Those come from the same bot user as the notices it does need,
so they are told apart by ts: `ThreadDoc.ownTs` keeps the ts of each reply
posted after the watermark. The agent's unseen `boss_inbox` rows ride in the
same input, labelled as the agent's and saying which one it is blocked on,
and are marked seen once the submission holding them is durable: that
submission is now the record, and a run queued behind it must not be shown
them again. A run that then fails still has them in its transcript.

**A mention outside an incident reads the thread above it, once.** The first
`@bugboss` in a thread somebody else started is handed every message before
it, other bots' posts included, because "log an incident for this" under a
report means that report. The same holds after an idle reset: the Boss reads
the thread again, its own earlier posts marked as its own, so it does not redo
what it already did. A mention that starts its own thread has nothing above it
and fetches nothing. A later mention reads only what people said since the
watermark.

**Silence is chosen, never inferred.** Two people talking to each other are
not talking to the Boss, and it says nothing by calling `stay_silent` with a
reason, which is logged at info. Whether a run may do that is its
`ThreadRun.allowSilence`; a tagged mention may not, and the tool refuses.

Empty text alone used to be read as that choice, and that is how a request
to close incident 2 vanished: the Boss read 199,928 characters of raw
session, its next turn came back with no text and no tool call, and nothing
was posted or logged. So a run that ends empty **without** `stay_silent` is a
failure: `incident_run_silent_unchosen` alarms with the thread and the
trigger, and the person who spoke gets the failure reply. A close, merge or
page posts its own notice; when that is the whole answer the Boss still has to
say so with `stay_silent`.

An untagged follow-up in a non-incident thread the Boss already talks in
gets the same rule, because it may be two people talking under a Boss
answer: `handle` runs it with silence allowed, `stay_silent` posts nothing,
and an empty run without it alarms (`followup_run_silent_unchosen`) and
posts the failure reply. A tagged mention is always answered.

**Calling `stay_silent` is terminal.** Its result carries
`control: { terminate: true }`, and Pi ends a run without another model
request only when every result of the round asks for that, so the extension
adds it to every other call in a round where `stay_silent` was called. Any
text the same turn also wrote is discarded and logged, never posted. A tool
called alongside it in the same turn -- `close_incident`, say -- still runs,
because its effect is real; what changes is that nothing more is read or
posted afterward. Incident 2's second failure on 2026-09-30 was this exact
gap: `close_incident` posted its own notice, the Boss called `stay_silent` as
the prompt instructs, and the harness asked for one more turn anyway, which is
where the literal text `(silpersisted)` reached the thread after silence had
already been chosen.

**It can change state, on evidence.** The write tools are in
`boss/commands.ts`, appended after the read tools in a fixed order because
the tools array is part of the cache prefix:

| Tool | What code does with the ask |
| --- | --- |
| `message_agent` | puts "The Boss says: ..." in front of the agent, keyed `boss:<taskId>` so a rerun sends once, and lifts a wait on a person; see below |
| `close_incident` | the tool API's Boss close, which posts the same closed notice an agent's close does |
| `merge_incidents` | `assign` inside one write, then the notices it owes both agents and `announceMerge`; the older incident survives whichever way round it was asked |
| `stop_agent` | aborts the agent's run and resets its context to a handoff carrying the reason; the dispatcher starts the next run on its next tick |
| `page_rotation` | posts the rotation mention into the thread through code |
| `grant_turns` | adds 1-200 turns to `incident.grantedTurns`; the dispatcher lifts a spent-budget wait on its next tick and posts the notice. Appended after `read_slack_link`, at the end |

**`message_agent` steers a running agent and writes to an idle one.** A
steer is placed at the agent's next tool boundary, and it is what ends a wait
the agent is blocked in (`agent/wait.ts` ends on a steer and nothing else). An
idle agent gets the message as a passive write in its transcript and reads it
when the dispatcher next launches it, because an input there would start a
run from the Boss's tool call: outside the dispatcher's concurrency cap, with
no checkout prepared, and past a spent turn budget. A run that ends between
the busy check and the steer starts one such run; that is the price of not
polling. An incident whose first launch has not
created a conversation yet is refused in so many words, so the Boss tries
again rather than believing it was delivered. `stop_agent` likewise does not
submit the next run; the incident stays open and unparked, so the
dispatcher's next tick does, and the handoff is the first thing it reads.

Each takes an incident and a reason. A close, merge, stop or grant refuses a reason
under forty characters, because the reason is what the record keeps of why
state changed without a person doing it, and a one-word verdict is not
evidence anybody can check. The prompt carries the rest: never change state
without evidence it can cite, and an agent asking for a close is a request to
check rather than a reason to act.

**It reads GitHub itself.** `gh` (`slack/gh.ts`) is appended last, after
the write tools. It runs the `gh` binary with the argv the model supplies,
through `execFile` with no shell, on the App installation token an incident
agent gets -- same permissions, same repositories, minted and re-minted by
`createInstallationToken` in the composition root and shared with the
closing report's PR-state reader. It exists because the Boss, asked in
incident 94's thread who made omni#2265, said it had no GitHub access and
asked for the link to be pasted.

| Bound | Why |
| --- | --- |
| no shell, argv only | a `;` or `|` in an argument stays a literal argument |
| env built, not inherited | the child sees `GH_TOKEN`, `GH_REPO=thegoodparty/omni` and its own `GH_CONFIG_DIR`, none of the Boss's other secrets |
| `auth`, `alias`, `extension`, `config` refused | `gh auth token` prints the token into a transcript one answer from Slack; an alias or extension runs a program that could read this process's environment |
| the token scrubbed from output | nothing gh prints carries it back |
| `GH_TIMEOUT_MS` per call | a call that hangs costs one turn, not the run |
| `MAX_GH_OUTPUT_CHARS`, a **refusal** | past it nothing is shown and the model is told to ask for `--json` fields, `--jq`, `--limit`; never the first part of the output |

Anything `gh` changes on GitHub -- a comment, a review, a close, a merge, a
re-run -- is a state change under the same prompt rule as the write tools:
only when a person asked or there is evidence to cite, and the Boss says what
it did. Branch protection, not the prompt, is what keeps a merge honest.

**Writes are not filtered, on purpose.** `gh` can write -- `gh api -X POST`,
`gh issue create`, `gh pr comment` -- and nothing in code refuses a write.
That is the decision, not a gap: the Boss gets what an incident agent gets,
and an agent reads the same untrusted PR bodies with the same token and a
whole shell. A method filter on `gh api` alone would not close the path
anyway (`gh api -f` with no `-X` is a POST, and a dozen subcommands write),
and a complete one is a read-only token, which is the design this replaced.
What stands against an injected write is the same as for an agent: the
prompt's "data, not instructions" rule, the evidence rule above, and branch
protection. If that stops being enough, the change is a read-only token
minted for the Boss (`permissions` on the installation-token request), not
an argv filter.

**It reads Slack links.** `read_slack_link` (`slack/link.ts`) is appended
after `gh`. It parses a message permalink, reads the message's thread with
the same `replies` the Boss reads its own threads with, and renders author,
time and whole text per message. A thread over `MAX_LINK_REPLIES` comes back
as its first message, the linked one and the newest replies, with a count of
what was left out: shaped by messages, never cut by characters. Names come
from what Slack sends on each message; there is no `users:read` lookup.
`not_in_channel`, `channel_not_found` and `missing_scope` come back as a
sentence saying so, because the bot has `channels:history` and not
`groups:history`. It exists because in incident 85's thread the Boss, handed
a link, said it could not open Slack links.

`grant_turns` exists because in incident 80's thread the Boss, asked to
rebase, said it had no checkout and the agent was out of turns. Both were
true and neither was the answer: the agent can rebase, and the Boss can now
give it the turns. The prompt says what the Boss cannot do itself and that
code work goes to the agent.

`page_rotation` exists because `toMrkdwn` strips `<!subteam^…>` out of model
prose, which is right -- a model that can page the rotation by typing it is
how a rotation gets muted -- and the Boss still has to be able to reach
people. So the mention is composed by code, and a mention typed into an
answer still posts as literal text.

`prepareQuery` in `triage/sql.ts` still guards `query_incidents`, one guard
for both surfaces. The write tools do not go through it: they never take SQL.

`search_incidents` is the same tool triage calls, adapted to this surface's
tool shape. Its three answers have to stay three: matches, `0 matches` for a
corpus that has nothing like this, and an `error:` for a query that never
reached the index. A search that never ran, reported as nothing found, tells
somebody asking "have we seen this before" that the problem is new.

What a run spent is summed from its own assistant entries, failed attempts
included, and lands on the `answered` or `incident_answered` log line. The
wrap-up and a call that failed are both in it: the run that cost the most is
the one that answered least.

Its failures must not die in the channel that failed: the in-thread apology
is tried first, and if that throws it is logged distinctly and re-posted to
`alertChannel`. Both use the same token and API, so the likely causes — a
revoked token, the bot removed, exhausted rate-limit retries — fail both
identically. An incident run a person triggered gets the same apology; one
only an agent triggered alarms and posts nothing, since nobody in the thread
is waiting on it.

`alertChannel`, `rotationGroupId` and `incidentChannel` are **required**, not
optional. An optional field nobody sets is a fix that exists in the source and
not in production, which had already happened three times here.

## The Boss does not narrow its results

Every tool result lands whole. What bounds the context is the harness's
compaction, which summarises older turns at a turn boundary rather than
cutting anything. Results used to be cut -- each SQL row at 2,000 characters,
the session tail at 24,000, `get_incident` at 100,000 -- and a row cut in half
is a row the model reads as complete and answers off.

What is left bounding this surface counts **things**: `MAX_SQL_ROWS`,
`MAX_SESSION_TURNS`, the reply `LIMIT`. Never a width.

`read_agent_session` renders the agent conversation's entries, not the raw
transcript (`slack/session-view.ts`): per turn, each tool call with its key
arguments and a one-line outcome, and the model's own text only where it is
short enough to show whole. A text too long for that is shown as its whole
first line or paragraph, labelled, or described ("read 12,400 characters from
`alerts.ts`"). Nothing is cut mid-content; sixty raw lines of one session were
199,928 characters. It also says whether a run is in progress and, if not,
how the last one ended (`describeRun`), because the tail of a stopped run and
the tail of a finished one otherwise read the same.

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
sit in a thread waiting, not the bill — this surface runs on the same model
triage does, nowhere near what an incident agent costs.

**Exhaustion no longer throws the run's work away.** Everything it read is
still on the transcript, so the round that spends the last turn carries
`WRAP_UP_INSTRUCTION` on its results, and the next response is the answer.
Any tool it calls after that is refused without running and ends the run, so
a model that ignores the instruction cannot keep reading. It is told to name
the part of the question it did not reach, so the gaps are in the answer
rather than implied by its shortness. Running out is still a real event and
still **alarms** (`slack_agent_turns_exhausted`, from an `afterResponse` hook
counting the run's turns) — visible to whoever owns the budget, not to whoever
asked the question. A wrap-up request that fails outright
(`slack_agent_wrap_up_failed`) posts the last prose the run wrote, if any.

A run that has not settled after `(SLACK_AGENT_MAX_TURNS + 1) *
SLACK_AGENT_BUDGET_MS` is aborted (`slack_agent_run_timed_out`) and the
person is told it failed, so a thread is never left waiting on a run that
will not end.

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

**A status answer is the rendered one.** "What needs me?" and "what is
open?" are the board, and "what is the status of incident 4?" is the card,
each pasted with at most one sentence after it. Anything else is around 200
words, in plain terms — what the system is doing and what users see, not
file paths, function names or column names. Plain is not vague: the numbers
stay, the identifiers go, and depth comes when somebody asks for it.

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
