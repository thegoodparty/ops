# BugBoss architecture

Why it is built this way, and where each piece lives. For what it is *for*,
read [`purpose.md`](./purpose.md) first.

## One container, one process

BugBoss is a single ECS Fargate task, and every agent runs **inside the Boss's
own process**: each incident agent and each Slack thread the Boss talks in is
a conversation on one Pi Durable harness (`agent/harness.ts`), not a task or
a process of its own.

That removes a lot: no `RunTask`, no leases, no SQS, no Service Connect, and
nothing between an agent and the Boss but a function call into the same code
the Boss runs. The cost is that a deploy takes everything down together,
which is why
`deploymentMinimumHealthyPercent` is `0` — two tasks would put two processes
on the same SQLite files and the same conversations, and that is a
correctness bug rather than a tuning choice.

```
Grafana ─┐
         ├─► ALB ─► container ──┬─► triage ─► assign ─► dispatcher
Slack  ──┘                      │                          │
                                │                          ▼
                                │                 harness, in process:
                                │                 an agent conversation per
                                │                 incident (up to 15) and a
                                │                 Boss conversation per thread
                                │                          │
                                ├─► bugboss.db ─► S3       │
                                │   (every write)          │
                                └─► harness.sqlite ─► S3 ◄─┘
                                    (once per tick)
```

### One process, no isolation

This is the cost of one process, accepted on purpose and stated here so
nobody has to rediscover it. Every agent shares the event loop with every
other agent and with the Boss. A wedged `bash` is stopped by the run's abort,
which `exec` honours by killing the child pids it started. A tool that wedges
*inside JavaScript* rather than in a subprocess has nothing that can stop it:
an abort is cooperative, and nothing in this process can preempt a
synchronous loop or a promise that never settles. Such a tool stalls its own conversation for good,
and a hot synchronous one stalls every agent and the webhooks with it.

What keeps that rare is that an agent's own work is subprocesses (`bash`,
`git`, `npm`, `gh`) and its in-process tools are thin calls into the tool API
and Grafana's MCP server. A new in-process tool that does real work of its
own is the change that makes it likely, and is worth refusing in favour of a
subprocess.

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

`status` is **where the work is**, and it is the only axis. An open incident
is always driven by an agent: a person is something it can be waiting on,
never something it can be given to. A PR is not a phase either — resolving may
take zero pull requests or four.

Waiting on a person is a row in **`incident_wait`**, not a field on the
incident. It says one thing: do not relaunch this incident yet. The agent
still has the work and still holds its dispatcher slot. The Boss telling the
agent something deletes the row: a person's word reaches an agent only
through the Boss, so a `boss_message` is the news a wait on a person is
waiting for.

`incident.summary` is the one field that says what the incident **is**,
rather than what was concluded about it. The row carried `rootCause`,
`postmortem` and `usersImpacted` and nothing else, so a thread's top-level
message stayed whatever the first alert happened to say, forever: incident 79
opened on a memory alert and became the Loki 429 explosion, and there was
nowhere to write that down. The agent keeps it current as a goal, not on a
trigger list, and it is refused past a few words rather than truncated.

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
attach across `RESOLVED`, and never to a `CLOSED` or `MERGED` target.

Merge is the one of the four with a direction, and it is not the caller's to
pick. The more established of the two incidents stays as the record — the
lower id, which is the only monotonic record of when an incident was opened
and the one thing a re-partition cannot move — and a merge the other way
round is refused with an error naming the direction that would have worked.
Left to callers the survivor was an accident of which agent happened to be
acting, and a thread with days of conversation could be absorbed into one
opened minutes earlier.

Who may call it:

| Actor | May |
| --- | --- |
| `agent` | re-partition its own incident only: create, split, and nothing that reaches a second record |
| `human` | combine two incidents, at a verified Slack identity |
| `boss` | triage placement, root-cause correlation, and a merge an agent asked for |

An agent that concludes its partition is wrong cannot consolidate — that is
what keeps a compromised one to a single record. It asks instead, through
`propose_merge`: the Boss compares the two on the judgement it already uses
after a root cause, and `assign` decides which record survives. A person asks
the Boss, in an incident thread or at the bot anywhere else, and it merges
with `merge_incidents`.

## Reads are not contained

Containment is a rule about writes. Any agent can read any incident —
`get_incident` takes an id — because the argument for confining it is entirely
about what it can move, and confining the read only made the system
incoherent: `search_incidents` reaches `RESOLVED` and `CLOSED` incidents in
full, so an agent knew the past and could not see the open incident beside it,
while the Boss served that incident to anyone in the channel.

Writes are still scoped: an agent's tools read the incident from the
conversation's `IncidentDoc`, never from an argument, so every write goes to
that one record.

## Two agents

The incident agent (`agent/`) is a conversation on the harness that works one
incident. Everything else that reaches a model is the Boss -- triage,
root-cause correlation, the inbound-language read and the incident commander
in `slack/agent.ts`, whose every Slack thread is a conversation on the same
harness. They share one request path (one pi-ai `Models`, built by
`createBugbossModels`), one read-only query guard (`triage/sql.ts`) and one
usage accumulator.

The commander sits between people and agents (see "The human boundary"),
and besides relaying it can close, merge, stop and page. Every Boss write is
an ask from the model and a decision made by code -- an answer-tool schema,
or a write tool that takes an incident and a reason and runs the same guarded
transition an agent's call does -- which is what makes "the model proposes;
the rules decide" structural rather than remembered. The numbered steps below
are stages of one pipeline, not separate agents.

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
is wrong. A launch is a submit into the incident's conversation, created on
the first one; preparing the checkout runs off the tick, because it is
minutes of git. Ticks are serialized against each other and a launch in
progress is remembered, so two ticks cannot submit the same kickoff twice.

The dispatcher is also the only thing that notices an incident nobody is
working. Every other guard watches a run, so an incident with no run at all
is invisible to all of them, and `park` makes that state reachable: a wait
with no wake is lifted by a Boss message that may never come. `sweepStale` reads one
clock over the incident's own timestamps, its thread replies and its recorded
actions, and an incident quiet for `BUGBOSS_STALE_HOURS` is un-parked, said
out loud in the thread and alarmed. The marker it writes is itself activity,
which is what makes it fire once, survive a restart and not ping-pong,
without a second flag to keep in step.

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
take a `CHECK`. It cannot, so it is refused at the tool instead — and an agent
that cannot answer escalates, which leaves a recurrence nobody can explain
open with somebody told it needs them.

**5. The agent** (`agent/`) runs on the harness against Bedrock, in the
Boss's process. It gets its own `git clone --filter=blob:none` of omni on an
EFS volume that survives a restart, the Grafana MCP toolset, and the incident
tools, which call the tool API in-process. It investigates, fixes, opens a
PR, waits for a merge and a deploy, and writes a post-mortem.

## The human boundary

Everything a person says to BugBoss is a sentence, not a command. There is no
slash command, no button and no phrase to learn. The one thing a person does
that is not a sentence is approve an agent's SQL query with a reaction, and
that is deliberate; see "Querying gp-api prod".

**The Boss is the only interface between people and incident agents.** Every
message in an incident thread, tagged or not, goes to the Boss with the
incident as context. The Boss answers, stays silent, or tells the agent
something with a `boss_message` directive. An agent never posts free text to
Slack and never reads it: when it needs something from a person it writes to
the Boss's inbox (`boss/inbox.ts`), and the Boss decides whether and how to
ask. An agent can still block on a question, and any `boss_message` ends the
wait.

State-change notices are not conversation. Opened, root cause, resolved,
closed and merged posts are emitted by code on the transition, whether the
agent or the Boss caused it.

A mention outside any incident thread goes to the Boss too, bare or not. It
reads whether somebody is reporting something broken (it files that with
`open_incident`), asking a question, or asking it to act, and nothing reads
the message before it does. It runs off the Slack ack, for the reason the
webhook acknowledges before it works.

## The agent boundary

An agent runs inside the Boss's process, and its shell commands run as the
same user. `bash` starts each command with an allowlisted environment
(`agent/shell-env.ts`) and a freshly minted GitHub token, so the Boss's secret
blob is not in what a command inherits. That is hygiene, not a fence: a
command can still reach the task role through the container credential
provider exactly as the Boss does, and a process running as the Boss's user
can read the Boss's own environment. There is no privilege boundary inside
the container, so anything claimed at that line would be a claim rather than
a control.

The boundary that is real is the task. The agent's container holds no
database credentials, no deploy role and no merge rights. Its AWS identity
reads logs, metrics and ECS state, calls Bedrock, and writes its own bucket;
it cannot reach the release path or any secret but its own. The task can open
a connection to gp-api prod's database reader, but the only credential for it
is in the SQL runner sidecar, which the agent cannot read (see "Querying
gp-api prod"). The GitHub App opens
pull requests and cannot merge one, enforced by branch protection on `main`
rather than by the prompt. So every effect an agent can have on the platform
arrives as a pull request a human approves.

The tool API is the **interface** to incident state, not a fence around it.
Every transition is one in-process call from an incident tool, and the
incident it acts on is the one recorded in the conversation's `IncidentDoc`
when the dispatcher created it. No tool takes an incident id to write to, so
an agent working incident A has no argument it could aim at B. That is what
keeps fifteen concurrent agents out of each other's incidents.

Four tools that move the incident through its lifecycle, two that move it
through nothing, and two reads:

| Tool | Transition |
| --- | --- |
| `search_incidents` | None. Text search over closed incidents' post-mortems |
| `report_root_cause` | `INVESTIGATING → FIXING`. Triggers correlation, splits the unexplained |
| `report_impact` | Repeatable; impact grows during an incident |
| `report_resolved` | `FIXING → RESOLVED`, with evidence |
| `report_analysis` | `RESOLVED → CLOSED`, terminal. Takes the post-mortem as sections that code renders in a fixed order (`report/CLAUDE.md`) |
| `escalate` | None. Hands the Boss the brief as an `escalation`; the Boss decides who to reach. The agent keeps the incident and keeps working |
| `park` | None. Stops the relaunch until a Boss message, the cooldown or the stale sweep; the agent keeps the incident. A park with `liftsOnReply: false` is out of turns rather than waiting on news, so none of the three lift it and the sweep only announces it |

The three gates (`report_root_cause`, `report_resolved`, `report_analysis`)
and a merge ask do not take the agent's word for it. A separate model judges
each against its stage goal first, and only a met verdict runs the
transition. See "Stage goals" in `agent/CLAUDE.md`.

`escalate` and `park` answer different questions, and neither is a hand-off,
because there is nothing to hand to. Escalating says a person is needed;
parking says stop relaunching until something changes. Parking is the one
correctness rests on: without it an agent that stops driving is relaunched on
the next tick, lands back in whatever stopped it, exits again, and pings the
rotation every thirty seconds. It stops the relaunch and it does **not** free
the dispatcher slot, which is the easiest thing here to read the wrong way
round: an agent parked inside `monitor` is alive and still holds one,
deliberately.

Plus two blocking tools, each costing one turn no matter how long it waits —
which is what keeps a multi-day incident from saturating context on polling.
Both end the moment the Boss sends the agent anything, because they watch the
conversation's inbox as well as their own condition. The same property makes them the only thing
that ever misses the prompt cache, which is why the prefix is written with a
1h ttl; see `bugboss/bedrock/CLAUDE.md`.

- `monitor(command, interval, timeout, awaitingHuman?)` — block until a
  read-only check passes. The general primitive: PR merged, deploy shipped,
  alert quiet. With `awaitingHuman` set it sends the Boss an `escalation`
  inside working hours when the person does not turn up, backing off
  1h/2h/4h/8h/16h and then once a day and never stopping; the Boss decides
  whether and how loudly to reach anyone. Without it the wait is silent,
  because nobody is being asked for anything
- `message_boss(message, wait?, seconds?)` — tell the Boss something, and
  with `wait` block until it answers. The Boss decides whether a person needs
  asking; see "The human boundary". Re-entrant: the marker is written before
  the wait, so a resumed agent resumes waiting rather than asking twice. Any
  `boss_message` ends the wait. A wait nobody answers escalates to the Boss,
  and the agent goes on waiting

Both are replay-safe: a deploy mid-wait resumes the wait from its
`pending_wait` or `pending_question` marker and costs no turn.

### How an agent learns things changed

By a submission into its conversation. A `boss_message` and `new_signals`
are steers: they land at the agent's next turn boundary, and a blocking tool
returns as soon as one is queued, so a message reaches an agent in an
hour-long wait within milliseconds. `stop` aborts the run, resets the
conversation with a hand-off and submits a fresh input. `merged` aborts the
absorbed incident's run; its status is no longer eligible, so nothing
resubmits it. `resumed_after` is a steer the dispatcher sends at boot to a
run the restart interrupted.

`new_signals` names the incidents that were emptied into this one, when that
is how the signals arrived. Without it a merge reaches the surviving agent as
an unexplained pile of new signals, and that agent is then expected to keep an
honest title for an incident it was never told about. What the absorbed
incident had already found arrives on the next `get_incident`, as `absorbed`
— the same shape and the same reasoning as `priorIncident` for a recurrence.

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

## Querying gp-api prod

Some incidents can only be confirmed in the data: how many users a bug
reached, whether a backfill landed. The agent cannot hold a prod credential,
because it reads attacker-writable text, has a shell and unrestricted egress,
and can read everything the Boss's process holds. So a query runs in another
container, and only once a person has approved it.

**Layout.** `sqlrunner` is a third container in the task, from the same image
(`node dist/bugboss/sqlrunner/main.js`). It listens on `127.0.0.1:8790` with
no port mapping, so only the task's own loopback reaches it. It shares the
network namespace and nothing else: not the PID namespace, not the work
volume, not the environment.

**The flow.**

1. The agent calls `request_sql_query(sql, reason)`, an in-process tool.
2. The Boss adds the incident's thread and forwards it to the runner.
3. The runner checks with Slack that the thread is a top-level message the
   bot posted, headed with that incident's number, then posts the exact SQL
   in it and waits. The agent's shell can call the runner directly, so step
   2 is not what keeps a request in its own incident's thread; this check
   is.
4. A member of the rotation group reacts to approve or refuse. The runner
   polls `reactions.get`, ignores anyone not in the rotation, fails the
   request if the bot itself has reacted, and re-reads the message before
   running.
5. It runs the query in a `READ ONLY` transaction with a statement timeout,
   as `readonly_user` on the reader endpoint, with a row and size cap. It
   edits the outcome into its message, and the agent collects the rows by
   polling through the Boss.

**The trust boundary.**

- The password is the SSM parameter `/gp-api-prod/readonly-password`,
  injected into the `sqlrunner` container alone by the execution role at
  launch. The task role, which the agent runs as, has an explicit deny on it.
- Approval is a reaction rather than a button. The agent can read the
  signing secret, so it could forge an interactivity payload; it can only
  react as the bot, and the bot does not count. The runner asks Slack who
  reacted, so nothing the agent sends it can stand in for a person.
- The agent holds the bot token, so it could edit the runner's message to
  show a harmless query over the stored one. The runner refuses to run if the
  message was edited, deleted, or no longer shows what it stored. It also
  refuses SQL a person could read differently from what runs: anything but
  printable ASCII (bidi controls and zero-width characters can show one query
  and run another), more than 40 lines, a line over 200 characters, or two
  blank lines in a row (which push the end of a query below Slack's "Show
  more").
- The same token lets the agent react as the bot. A ▶️ already on the
  message makes approving a click on an existing pill, so any reaction from
  the bot fails the request.
- The runner logs to `/bugboss/sql-runner`, outside every log prefix the
  task role reads, and the task role is explicitly denied it too.
- A security group rule opens the database's port 5432 to this task's
  security group and nothing wider.

**What it does not protect against.** Once rows are returned to the agent
they are the agent's, and its egress is open, so an approval is an approval
to let those rows out. And a person can approve a bad query: the runner
enforces read-only and the caps, not judgement about what is being read.

## Durability

**SQLite, mirrored to S3 synchronously.** Every write goes through
`withWrite`, which serializes writes, runs the transaction, `VACUUM INTO` a
snapshot, and does not resolve until S3 has it. When an agent's
`report_root_cause` returns, the transition is durable.

A failed PUT **halts writes** rather than continuing. A process that keeps
committing locally while S3 falls behind is worse than one that stops,
because the divergence stays invisible until a restart loses it.

**Conversations are a second SQLite file, mirrored to S3 once per tick.**
Pi Durable keeps every conversation, task and document in
`/data/harness.sqlite`, beside `bugboss.db` rather than in it: its
adapter is `node:sqlite` with async transactions and ours is better-sqlite3
with synchronous ones, so they cannot share a transaction and one file would
buy nothing but lock contention. It commits partial output every 100 ms, so
a PUT per commit is impossible; `db/mirror.ts` snapshots it with `VACUUM
INTO` and PUTs `state/harness.sqlite` on the tick when anything committed,
and once more on SIGTERM. Boot restores it before the harness opens, then
`harness.resume()` carries on every run that was in flight. A failed PUT
alarms (`harness_snapshot_failed`, then `harness_snapshot_still_failing`
after five minutes) and never halts the incident database: halting incident
writes for a transcript upload would couple the wrong things.

The loss window is one tick of transcript. That is safe because the incident
tables stay the system of record and every tool effect is a guarded,
idempotent write there, so a transcript behind the incident table costs the
model one "already FIXING" result, and resume re-requests the last
generation at worst. A thinking block's signature is bound to the prefix and
does not expire, so a resumed run replays it.

Every merge to ops `main` restarts this container, so resume is the normal
path, not the exceptional one. That is why the agents' workspaces
(`/work/<id>`: the checkout, node_modules, uncommitted edits) are on EFS
rather than the task's disk, and deleted by the dispatcher only once the
incident is CLOSED or MERGED. See `agent/CLAUDE.md`.

**The story of the incident lives in its timeline, not in the context.**
The agent records key moments with `track_incident_timeline_event` as they
happen -- first error, impact confirmed, root cause, fix opened, merged,
deployed, verified -- into `incident_timeline_event`. Its context is
summarised at each stage, so the closer's timeline rows name those events
by id, and the report prints one timeline with the recorded times.

## Layout

| Directory | What |
| --- | --- |
| `ingress/` | Verify and parse per source. Adding a source is one adapter |
| `triage/` | The decision, and the rules that bound it |
| `toolapi/` | `assign`, the transitions, correlation |
| `dispatcher/` | Launch, deadlines, escalation, parking, the stale sweep, the circuit breaker |
| `agent/` | The harness, the incident agent's extension, its tools, prompt and in-process port |
| `bedrock/` | The pi-ai provider over Bedrock `InvokeModel`, and the Boss's client on it |
| `slack/` | Outbound relay, inbound routing to the Boss, the mention read, the incident commander, and how outbound text is rendered |
| `board/` | When the status board says anything: headers, the morning post, the all-clear |
| `report/` | The closing report: assemble, render, publish once |
| `http/` | Webhooks and health |
| `db/` | SQLite, its S3 mirror, and the harness file's mirror |
| `testdb/` | The test Postgres URL, its guard and its boot probe |
| `sqlrunner/` | The sidecar that runs a human-approved read-only query against gp-api prod |
| `index.ts` | The composition root. The only place real services are named |

`types.ts` is the contract every module is built against. `model.ts` is the
seam the Boss's own bounded calls are written against. `logging.ts` is the one
place `alarm` and `log` are defined.

## The status board

Three fields — where the work is, what the incident is, and what is needed
from a person — rendered once and shown at three scales: a header that is
each incident thread's whole top-level message, a board somebody can ask
for, and a board posted at 07:00 Eastern on a morning when something is
open. A fourth message, one-off, says
the board is clear when the last open incident closes and stays closed.

The fields are derived, not invented. "What is needed" is
`incident_wait.waitingFor`, which already existed as *"what is being waited
on, in one line, for the thread and the digest"*; an incident with no wait
needs nothing, and saying that out loud is what makes the ones that do worth
trusting. "Clear" is zero open incidents, full stop: an incident parked on a
person for a week keeps the board non-empty, which is the point of a board.

**None of it is scheduled.** There is no cron in this container and there
must not be one — every merge to ops `main` restarts it, so an in-memory
schedule fires twice or is skipped depending on deploy timing. The sweep
rides the interval that already runs and remembers what it has done in
`board_state`, as a date where a day is the unit. `board/CLAUDE.md` has the
whole of it.

Incident references in outbound text are rendered by the same principle:
"Incident 4", capitalised, linked to its thread unless the reader is already
in it. That was a prompt instruction and was therefore followed
probabilistically; it is a pass wrapped around the Slack client now, so it
reaches every surface rather than the ones somebody remembered.
`slack/CLAUDE.md` has the seam and why it is where it is.

## Choices worth knowing

**Bedrock via `InvokeModel`, not `Converse`.** Converse drops thinking
blocks that have empty text but live signatures, which is exactly the shape
Opus 5 produces. Resume depends on those surviving.

**The provider is reached by wrapping pi-ai's Bedrock provider, not by
claiming an api id.** pi-ai resolves a model from the provider's own catalog
by id, and the builtin Bedrock catalog stamps Converse on every entry, so the
builtin would serve Converse to every model it owns. `createBugbossModels`
wraps it with `routeBedrockProvider`, which dispatches on `model.api`, and
overrides the catalog so our resolved models replace the Converse entries.
`assertBedrockInvokeModelRouting` checks both halves before anything runs:
that the provider is ours, and that the catalog hands back the InvokeModel
api for the id. A missed override is exactly the silent misroute it exists
to catch.

Every caller reaches the model through that one `Models`: the incident agent
and the commander stream on the harness, and triage, correlation and the goal
evaluator make one bounded request each through `bedrock/client.ts`. One path
deliberately, so a fix to the request lands once -- two paths is how a beta
header present on one and absent from the other killed every incident agent
while triage carried on working.

**Two bounds on a run, and the wall clock is the weaker one.** A deadline is
external, so it costs nothing in harness capability, but it does not measure
work: `monitor` and `message_boss` each cost one turn however long they
block, and the first nine-hour incident spent about eight of those hours
inside a single turn waiting on a person. So the run is also bounded in
**turns**, counted across every launch of one incident -- 92 turns for that
nine-hour run against a ceiling of 200. Both bounds have the same two
layers: the agent is steered to write a brief at the soft edge, then its run
is aborted. The wall clock's steer and abort come from the dispatcher, the
abort `DEADLINE_GRACE_SECONDS` after the steer. The turn budget's come from a
hook after every model response, which increments `incident.turnsUsed`
(awaited, so the count is in S3 before the next request) and at the cap
escalates to the Boss (so a person can be told, with the spend), parks (so
the dispatcher does not relaunch it into the same exhausted budget) and
aborts. Boot rewrites every open incident's `turnsUsed` from its transcript,
so an increment lost to a restart costs nothing. An abort is cooperative; see
"One process, no isolation" for what that cannot stop.

Turns rather than dollars because dollars here are an estimate (below) and a
cap on an estimate is a cap on arithmetic. 200 is a bound before a price
cap, not instead of one: the escalation carries what the run spent so the
next number is measured rather than guessed.

**Compaction just in time, and no cap on tool output.** Pi Durable measures
the context after a tool result is appended and before the next provider
request, and compacts there if it is over `contextWindow - reserveTokens`. So
a result never has to be cut to fit: it lands whole, gets measured, and what
gives way is summarised history, which the conversation's entries still hold.
Cutting the result instead meant losing the middle of a stack trace or a log
dump the run had just paid a tool call to fetch.

That threshold is the backstop. The ordinary compaction happens at each stage
transition -- root cause reported, fix PR opened, fix merged -- where the tool
whose success is the transition asks for `conversation.compact` with a prompt
that keeps what the next stage needs and the timeline (`agent/CLAUDE.md`).
Pi Durable summarises in the background and places the summary at the next
turn boundary, and a compaction a restart interrupted is a checkpointed task
that resumes. Compaction appends; the conversation keeps every entry it
summarised.

`reserveTokensFor` is `maxTokens + keepRecentTokens` — the most the model can
emit in one response, plus the tail compaction will not summarise. It was 5%
of the window, which on Opus 5's 1,000,000 left 50,000 tokens of headroom in
front of a response that can be 128,000.

**Tokens are facts; dollars are arithmetic.** Bedrock returns token counts.
A price is something we compute locally against Pi's per-model table, and the
day AWS moves a rate that table goes stale with nothing in a stored dollar
figure that could ever say so. So the incident row records `tokensIn`,
`tokensOut`, `cacheRead`, `cacheWrite` and the 1h share of that write --
carried separately because it prices at 2x base input where the rest is
1.25x -- and there is no cost column. A dollar figure is derived where it is
shown, from those tokens and Pi's Bedrock catalog rates for `modelId`
(`priceTokens` in `bedrock/model.ts`), and called an **estimate** in the
closing report, in Slack and in `read_agent_session`.

`rollUpUsage` keeps the tokens current. It sums the conversation's
`UsageDoc` -- every model bucket, the goal evaluator's among them, plus the
tool buckets -- and writes absolute totals, never increments, so a re-read
cannot double count: on every tick for the agents that are busy, and over
every row at boot. A total below the stored one is never written: usage only
grows, so a smaller one is a stale read. That rule is also what carries an
incident across the cutover to the harness, whose fresh conversation starts
at zero beside the totals its old session file already put on the row. The
row's `modelId` is the bucket that produced the most output, so the goal
evaluator's cheaper model adds its tokens without taking the row. A merged
incident keeps its own tokens on its own row; the closing report prices the
merged-in rows and adds them to the incident that absorbed them.

The one way to check the estimate is an **application inference profile**: a
tagged wrapper the agent is invoked through, since Bedrock puts no
cost tag on an InvokeModel request. Its usage lands under `Project: bugboss`
in Cost Explorer, about a day late -- too late to enforce anything, and the
only mechanism that would ever reveal the local price table had drifted. The
profile ARN is the request field only; `model.id` stays the logical id, so
the signed prefix is untouched and a model nobody wrapped loses its
attribution rather than its agent.

The Boss's own bounded calls are costed the same way. `runStructuredCall`
adds each request's usage onto a `ModelUsage` in place, including the request
that throws, so a triage decision, a correlation, an inbound read and a
fallback all log what they spent. In place because every failure path out of a
bounded call is an exception, so a total returned beside the answer would
count only the requests that worked -- and a storm of fallbacks is exactly the
spend no other record shows.

**Spend is recorded where the work happened.** An agent's tokens land on
`incident`; what triage spent placing a signal lands on that `signal` row,
because placing it is the work that created the row. The suppressed signal is
the case that makes it worth a column rather than a log line: it never becomes
an incident, so an incident-shaped record cannot hold it, and it is the
decision that arrives in bulk.

The signal write accumulates rather than replaces, which is the opposite of
`rollUpUsage`. That one re-reads a whole conversation's usage, so its total is
already absolute. A triage decision only ever knows what it just spent, and a signal
can be triaged twice -- a re-delivery of a signal nothing ever placed falls
through to be placed again, and both attempts were paid for. There is no
`costUsd` column on either row.

**An incident ends with a document, at `CLOSED`.** Not at `RESOLVED`: the
post-mortem does not exist until `report_analysis` writes it, and the schema
has a `CHECK` saying so. The close is one message: the close notice, with
the report attached as a PDF -- Slack has no headings and no tables, and the
thread is read on a phone. The close transition sends it itself, after its
write commits, and a failure never touches the incident: the notice goes out
alone and the upload is retried by the sweep, a few times, then alarmed. It
is claimed with an `incident_action` row before it uploads, because two
publishers race in normal operation and a container that dies mid-upload
must stay quiet rather than attach it twice.

**The thread is short; the document is complete.** Every path code posts into
a thread is capped at about 200 words and refuses a longer post -- the
resolution evidence, the dispatcher's escalation brief, the reason on a Boss
close or page. The Boss's own replies are held to the same length by its
prompt. The post-mortem is the
one field with no cap, because it leaves as the file rather than as thread
text. `slack/CLAUDE.md` has the table of which bound applies where. `report/CLAUDE.md` has the rest, including why the
report's token figures are as of the close.
