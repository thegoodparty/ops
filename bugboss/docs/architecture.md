# BugBoss architecture

Why it is built this way, and where each piece lives. For what it is *for*,
read [`purpose.md`](./purpose.md) first.

## One container

BugBoss is a single ECS Fargate task. Incident agents are **child processes
of that task**, not separate tasks.

That one decision removes a lot: no `RunTask`, no client tokens, no
`ListTasks` eventual-consistency window, no leases, no SQS, no Service
Connect. The cost is that a deploy takes everything down together, which is
why `deploymentMinimumHealthyPercent` is `0` — two tasks would put two
processes on the same SQLite file and the same agent sessions, and that is a
correctness bug rather than a tuning choice.

```
Grafana ─┐
         ├─► ALB ─► container ──┬─► triage ─► assign ─► dispatcher
Slack  ──┘                      │                          │
                                │                          ├─► agent (child)
                                └─► SQLite ──► S3          ├─► agent (child)
                                    (every write)          └─► … up to 15
```

## The data model

Two tables carry everything.

**`signal`** — an immutable fact. Something told us something is wrong.
Identified by `(source, sourceId)`, unique **among open signals only**. That
scoping matters: a Grafana fingerprint is stable for the life of the alert
rule, so an all-time unique key would mean the second time an alert ever
fires it is discarded as a duplicate, and recurrence becomes unreachable.

**`incident`** — a mutable unit of work. Signals attach to it; it moves
through a lifecycle; it ends with a post-mortem.

```
INVESTIGATING ──► FIXING ──► RESOLVED ──► CLOSED
       │             │
       └──► MERGED ◄─┘        (absorbed into another incident)
```

`status` is **where the work is**. `owner` (`agent` | `human`) is **who has
it**, and the two are orthogonal. A PR is not a phase: resolving may take
zero pull requests or four.

`RESOLVED` means no users are affected any more and no further alerts should
occur, confirmed by evidence rather than asserted. That bar is what makes a
post-resolution signal unambiguous evidence of a premature close.

Cross-field `CHECK` constraints make the illegal states unrepresentable — a
`MERGED` row must have `mergedInto`, a `CLOSED` one must have a post-mortem.
They are in the schema rather than a migration because SQLite cannot add a
`CHECK` to an existing table and there is no migration runner here.

## One primitive: `assign`

Create, attach, merge and split are all the same operation — re-partition
signals across incidents.

| Operation | Call |
| --- | --- |
| Create | one signal → `NEW` |
| Attach | one signal → existing incident |
| Merge | all of B's signals → A |
| Split | a subset of A's signals → `NEW` |

`toolapi/assign.ts` is the single writer that holds the invariants: never
attach across `RESOLVED`, never to a `CLOSED` or `MERGED` target, never to
one a human owns.

## The path an alert takes

**1. Ingress** (`ingress/`) verifies and parses. Grafana's HMAC is over
`timestamp:body` with a replay window; Slack's is its own `v0=` scheme. Both
fail closed — a missing secret rejects every delivery rather than accepting
any.

The webhook **acknowledges before it works**: it verifies and inserts the
signal rows synchronously, returns 200, then runs prefetch and triage off
the request. A burst of fifteen alerts at ~55s of triage each would
otherwise outlast Grafana's timeout and the ALB's, and the retry would
arrive while the first delivery was still working.

Resolve notifications are **discarded**. An alert that stopped firing on its
own has not stopped mattering — the symptom went away, which is not the same
as the cause being handled.

**2. Evidence prefetch** runs the alert's own `known_causes` LogQL before any
model sees it. This is deterministic, costs no agent turns, and is where
triage quality comes from. A query that fails returns `EVIDENCE UNAVAILABLE`
rather than an empty result, so "we did not check" never reads as "we
checked and found nothing".

**3. Triage** (`triage/`) decides: attach, new incident, or suppress. The
model is advisory about the match; `applyRules` holds the invariants. It
cannot suppress a cause the alert did not declare as suppressible, and it
cannot attach across `RESOLVED`.

It also asks the other half of the question: has an incident that already
claimed this problem was over come back? Split on whether the answer is a fact
or a judgement.

One indexed read before the call matches `(source, sourceId)`. Inside a
two-week window of that resolution it is stamped as `recurrenceOf` in code —
the same alert returning is a fact about the delivery, not an opinion about
the problem. A failed lookup reaches the model as `RECURRENCE CANDIDATES
UNAVAILABLE`, under the same rule as prefetched evidence: "we did not check"
must never read as "we checked and found nothing".

`search_incidents` covers what no key can. FTS5 over the post-mortems, root
causes and resolution evidence of every RESOLVED or CLOSED incident, offered
as a tool because a search needs a query and only something that has read the
signal can write one. It is how the same cause returning through a *different*
alert is found, which is the premature close most worth catching and the one
a structural key is blind to. The agent has the same tool.

A recurrence opens a **new incident pointing at the old one**, never a reopen.
`RESOLVED` and `CLOSED` are claims with timestamps attached, and two of the
`CHECK` constraints above mean a reopen can only be done by clearing
`resolvedAt` and `closedAt` — deleting the numbers the recurrence disproves,
along with the only shape that can answer "how often does a resolution hold".

**4. Dispatch** (`dispatcher/`) launches one agent per incident, up to 15.
That cap is a circuit breaker, not a scheduler — hitting it means something
is wrong. Ticks are serialized against each other: a tick awaits an S3 put
and an STS call before recording a launch, so overlapping ticks would start
two children on one incident, and both would write the same session file.

When an incident carries `recurrenceOf`, `get_incident` returns the earlier
incident with it: root cause, resolution evidence, PR urls and post-mortem.
Somebody already investigated this and wrote down what they concluded, and the
new incident is the proof they were wrong — so the agent starts from that
rather than rediscovering it.

**A recurrence carries a second question**, and closing it answers both.
`report_analysis` takes a `recurrence` argument that is required whenever
`recurrenceOf` is set and refused without one: which of six kinds of failure
let the earlier resolution stand, why, and what changed so it does not happen
again. One of the six is `bugboss_defect` — the fix belongs in this
repository rather than the product — and that answer is posted to the channel
rather than left in a column, because "BugBoss let a premature close happen"
reaching nobody is the same failure one level up. Agents do not open pull
requests against `ops`, so a defect leaves here as a proposal for a person.

That constraint is the one `CLOSED` would carry if the schema could still
take a `CHECK`. It cannot, so it is refused at the tool instead — and an
agent that cannot answer has `hand_off`, which is the right end for a
recurrence nobody can explain.

**5. The agent** (`agent/`) runs Pi against Bedrock in the same container.
It gets a fresh `git clone --filter=blob:none` of omni, the Grafana MCP
toolset, and a scoped token for the Boss's loopback API. It investigates,
fixes, opens a PR, waits for a merge and a deploy, and writes a post-mortem.

## The human boundary

Everything a person says to BugBoss is a sentence, not a command. There is no
slash command, no button and no phrase to learn: inbound Slack text is read
by a bounded model call (`slack/intent.ts`) which answers one label, and
that is the only thing in this system that reads what a person wrote.

Two interfaces use it. In an incident thread it answers two things about one
message: whether it hands the incident between a person and an agent, and
whether it was for the agent at all. On a mention anywhere else it answers
whether somebody is reporting something broken or asking a question — the two
things a mention can be, and previously the difference between a first word of
`report` and any other first word.

The second question exists because `contact_human` ends its wait on the first
reply after its question, so two people talking to each other while an agent
was blocked ended it on whichever of them spoke first. A message somebody sent
to the thread rather than to the agent is still recorded and still delivered;
it just cannot end a wait. An explicit `@bugboss` overrides the read and
always means "this is for you", decided in code so it survives the model being
down.

It is advisory, on the same split as triage. The model reads the sentence;
the code holds the invariants. A wrong read is bounded structurally rather
than by the model behaving: the incident comes from the thread the message
arrived in and never from the message, the answer is a bare enum with no
field that could name one, and the ownership move is still the guarded
`UPDATE` in the composition root. An ambiguous read asks in the thread, and a
failed call says the read failed. Nothing goes quiet, which is what the old
string matchers did whenever somebody phrased it their own way.

The read runs off the Slack ack, beside the Slack agent, for the reason the
webhook acknowledges before it works.

Ownership is the one place the read is deliberately lopsided. `owner =
'human'` takes an incident out of the query the dispatcher launches from, so
a takeover nobody meant strands it; a hand-back nobody meant starts an agent
somebody then tells to stop. Reading an ordinary message for the agent on a
human-owned incident as a hand-back therefore costs little and is what keeps
a reply from being filed where no agent can see it. Under all of it,
`sweepStale` in the dispatcher posts and hands back anything open that has
gone `BUGBOSS_STALE_HOURS` (default 24) with no agent run, no reply and no
status change, so no incident can sit silent for a day whoever owns it.

## The agent boundary

An agent is a child process of the Boss, running as the same user. It
resolves the task role through the container credential provider, exactly as
its parent does, so whatever the Boss can reach in AWS an agent can reach
too. There is no privilege boundary inside the container — a child can read
the parent's own environment — so anything claimed at that line would be a
claim rather than a control.

The boundary that is real is the task. This container holds no database
credentials, no deploy role and no merge rights. Its AWS identity reads logs,
metrics and ECS state, calls Bedrock, and writes its own bucket; it cannot
reach RDS, the release path, or any secret but its own. The GitHub App opens
pull requests and cannot merge one, enforced by branch protection on `main`
rather than by the prompt. So every effect an agent can have on the platform
arrives as a pull request a human approves.

The loopback API is the **interface** to incident state, not a fence around
it. Every transition is one HTTP call on `127.0.0.1` carrying a bearer token
minted per launch; the incident is derived from the token and then checked
against the path, so a valid token for incident A cannot be aimed at B. That
check is what keeps fifteen concurrent agents out of each other's incidents.

Five state-changing tools, each a transition, plus two reads:

| Tool | Transition |
| --- | --- |
| `search_incidents` | None. Text search over closed incidents' post-mortems |
| `report_root_cause` | `INVESTIGATING → FIXING`. Triggers correlation, splits the unexplained |
| `report_impact` | Repeatable; impact grows during an incident |
| `report_resolved` | `FIXING → RESOLVED`, with evidence |
| `report_analysis` | `RESOLVED → CLOSED`, terminal |
| `hand_off` | Sets `owner: human`, posts the brief |

Plus two blocking tools that live in the harness, each costing one turn no
matter how long it waits — which is what keeps a multi-day incident from
saturating context on polling. The same property makes them the only thing
that ever misses the prompt cache, which is why the prefix is written with a
1h ttl; see `bugboss/bedrock/CLAUDE.md`.

- `monitor(command, interval, timeout, awaitingHuman?)` — block until a
  read-only check passes. The general primitive: PR merged, deploy shipped,
  alert quiet. With `awaitingHuman` set it nudges the thread inside working
  hours when the person does not turn up, backing off 1h/2h/4h and then
  handing the incident over; without it the wait is silent, because nobody is
  being asked for anything
- `contact_human(message, details, timeout, options?)` — post to the thread
  and block for a reply that was **for the agent**; see "The human boundary".
  Re-entrant: the marker is written before the post, so a resumed agent
  resumes waiting rather than asking twice. `details` is a second, separate
  post underneath the ask, so evidence is available without being the first
  thing read. `options` render as buttons on the ask; pressing one is recorded
  and delivered as an ordinary reply, typing something else always works, and
  a button nobody presses is an unanswered question like any other. A wait
  nobody answers becomes a `hand_off`

### How an agent learns things changed

There is no push channel and an agent is never addressable. Directives ride
back on responses to calls the agent was already making — `stop`, `merged`,
`handoff`, `new_signals`, `human_message`, `resumed_after`.

## Running omni's tests

An agent that writes a fix it cannot run is proposing a change on reasoning
alone. Until it could run them, 200 of gp-api's 576 test files were out of
reach and the only check on a fix was a CI round trip.

omni starts its test Postgres with testcontainers, which needs a Docker
socket. **Fargate has none** — no socket, no privileged mode, no
Docker-in-Docker. That is the platform, not a missing package, so the answer
had to come from somewhere other than a container runtime.

**A Postgres sidecar in the task definition.** Containers in one task share a
network namespace, so it is reachable on `127.0.0.1:5432`, and omni's harness
takes it by URL instead of starting one. It needs no host, no daemon and no
credential, and it costs nothing: the task already bills for 4 vCPU and 16 GB
whether or not part of it runs a database.

It is **not essential** and nothing depends on it. An essential container that
exits stops the task, and a test database is not worth the incident system.
The cost of that is that its absence is quiet, so it is said twice: the Boss
probes it at boot and alarms, and the failure an agent actually reads is
omni's, which names `OMNI_TEST_POSTGRES_URL` at the moment a suite runs. An
agent must never read a connection error as a failing test and fix code that
is fine.

Isolating the fifteen agents that share it is **omni's job**, and its harness
already does it — a template named for a digest of the migrations it holds, a
per-suite clone the suite drops, an age-gated sweep for what a killed run left
behind. That was built for "one container serves every checkout on the
machine", and this task is that machine. Nothing here creates or drops a
database.

The data lives on the task's ephemeral storage and every merge to ops `main`
replaces the task, so nothing accumulates across deploys.

This does not replace CI, and the prompt says so. CI is still what has to be
green at the approval SHA; what it cannot give an agent is the short loop.

## Durability

**SQLite, mirrored to S3 synchronously.** Every write goes through
`withWrite`, which serializes writes, runs the transaction, `VACUUM INTO` a
snapshot, and does not resolve until S3 has it. When an agent's
`report_root_cause` returns, the transition is durable.

A failed PUT **halts writes** rather than continuing. A process that keeps
committing locally while S3 falls behind is worse than one that stops,
because the divergence stays invisible until a restart loses it.

**Agent sessions are JSONL on local disk, mirrored to S3 per turn.** A
restart restores the file and Pi resumes, replaying thinking blocks. This
works because a thinking block's signature is bound to the prefix — the
system prompt, the tools array and every earlier message — and does not
expire.

Every merge to ops `main` restarts this container, so resume is the normal
path, not the exceptional one.

**An agent also keeps a written record, in a directory that outlives the
restart.** The transcript records what an agent said; it does not give it a
cheap place to keep what it worked out. `/work/<id>/notes/` is mirrored to
`sessions/incident/<id>/notes/` on the same `turn_end` hook as the session and
restored before the next one starts, so a ruled-out ledger survives a redeploy
and costs nothing in context until the agent reads it back.

The mirror is **append-only, and has no delete in it**. Those notes are the
record of the work — for the next launch, for the thread, and for whoever
opens the incident again later — and a dead end is the most useful thing in
there. Agents are not asked to tidy up after themselves, and nothing in their
path can remove an object from this bucket. Deleting would not reclaim
anything anyway: the bucket is versioned and nothing under `sessions/`
expires, so a delete writes a marker over a version that stays.

That puts the bound on the record rather than on the directory, since a
rename leaves the old key behind. Crossing it stops the mirror loudly, and
deleting is not the way back.

## Layout

| Directory | What |
| --- | --- |
| `ingress/` | Verify and parse per source. Adding a source is one adapter |
| `triage/` | The decision, and the rules that bound it |
| `toolapi/` | `assign`, the transitions, correlation |
| `dispatcher/` | Launch, deadlines, escalation, the circuit breaker |
| `agent/` | The incident agent: Pi session, tools, prompt, resume |
| `bedrock/` | A Pi provider over Bedrock `InvokeModel` |
| `slack/` | Outbound relay, inbound intent, and the read-only Slack agent |
| `report/` | The closing report: assemble, render, publish once |
| `http/` | Public routes and the loopback tool API |
| `db/` | SQLite, and the S3 mirror |
| `testdb/` | The test Postgres URL, its guard and its boot probe |
| `index.ts` | The composition root. The only place real services are named |

`types.ts` is the contract every module is built against. `logging.ts` is
the one place `alarm` and `log` are defined.

## Choices worth knowing

**Bedrock via `InvokeModel`, not `Converse`.** Converse drops thinking
blocks that have empty text but live signatures, which is exactly the shape
Opus 5 produces. Resume depends on those surviving.

**The provider is reached by wrapping Pi's Bedrock provider, not by claiming
an api id.** Pi looks a provider up by `model.provider`, and installs its
builtin untouched when that id has no `models.json` entry and no registered
extension -- so the registry that `model.api` indexes is never consulted, and
the builtin serves Converse to every model it owns. `bedrock/runtime.ts`
registers a native provider that dispatches on `model.api` instead, and
`agent/run.ts` asserts the routing before the session starts.

**Wall-clock timeout, not budget caps.** A deadline is external, so it costs
nothing in harness capability. Two layers: the child steers itself to write
a brief at the soft deadline, and the parent SIGKILLs strictly later.

**Compaction at 95% of the context window**, made safe by bounded tool
results.

**Tokens, not dollars.** Pricing moves; a stored dollar figure would be a
guess frozen at write time, while tokens plus `modelId` multiply out
correctly whenever asked. The closing report prints both and says which is
which: the token table is the record, and the dollar line beside it is what
Pi priced that run at while it ran, read back out of the session file rather
than off a price list kept here. `costUsd` on the incident row stays
unwritten.

**An incident ends with a document, at `CLOSED`.** Not at `RESOLVED`: the
post-mortem does not exist until `report_analysis` writes it, and the schema
has a `CHECK` saying so. The report is a Markdown file uploaded into the
incident thread with a scannable summary as its message -- Slack has no
headings and no tables, and the thread is read on a phone. Publishing is a
notification on a transition that already committed, so a failed upload
degrades to thread text and alarms rather than touching the incident. It is
claimed with an `incident_action` row before it posts, because two publishers
race in normal operation and a container that dies mid-upload must stay quiet
rather than post twice.

**The thread is short; the document is complete.** Every path into a thread is
capped at about 200 words and refuses a longer post -- the ask, the evidence
under it, the resolution evidence, the hand-off brief. The post-mortem is the
one field with no cap, because it leaves as the file rather than as thread
text. `slack/CLAUDE.md` has the table of which bound applies where. `report/CLAUDE.md` has the rest, including why the
publish happens after usage roll-up and not inside the tool call.

**Usage is read back off the session file**, after the child exits, by
`sumSessionUsage`. Pi writes a turn's usage nested at `message.usage` and
writes the billed non-turn calls -- compaction's summarization, a cache warm
-- at the top level, so both are summed. The totals are absolute over the
whole file, which is what makes resume correct: a relaunched agent appends to
the restored file, so re-reading it counts every launch exactly once. Turns
are counted alongside the tokens because a turn that reached the model always
spends some, so turns above zero with tokens at zero means the reader has
drifted from what Pi writes, and the Boss alarms rather than storing a free
incident.
