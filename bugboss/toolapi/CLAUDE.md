# toolapi

The single writer for incident state, and the agent-facing transitions.

## `assign` is one primitive

`assign.ts` does create, attach, merge and split — they are all the same
operation, re-partitioning signals across incidents. Anything that moves a
signal goes through it, which is what makes the invariants enforceable in
one place:

- Never attach across `RESOLVED`. A signal arriving after a resolution is
  evidence the resolution was wrong, so it belongs to a recurrence.
- Never to a `CLOSED` or `MERGED` target.
- **The more established incident survives a merge.** When a move would empty
  one incident into another, the lower id — the record opened first — has to
  be the target, and the other direction is refused with an error naming the
  one that would have worked. See `establishedOf`.

`logAssign` is emitted **after** the transaction, never inside it, so a
rolled-back assign leaves no record claiming it happened.

## Reads are not contained; writes are

The containment rule justifies itself on blast radius — "a compromised agent
re-partitions its own incident and nothing else" — and that is an argument
about **writes**. It was applied to reads as well, and the result was a system
that made no sense from the outside: `searchIncidents` returns other
incidents' root causes and post-mortems in full, but only for `RESOLVED` and
`CLOSED` ones, so an agent was fluent about the past and blind to the present.
It could not open the open incident beside it. `GET /incidents/:id` even took
an id and threw it away.

So `getIncident` takes an optional id and reads any incident, defaulting to
the caller's own. This is strictly less than the Boss has
served to anyone in the channel since it was written, and it is what makes
`proposeMerge` worth having: an agent claiming two incidents are the same
problem should have read the other one.

Every **write** is still scoped to one record, and the record is never an
argument. `ToolApiDeps.incidentId` is fixed when the API is built: the agent's
tools read it from their conversation's `IncidentDoc` and call
`toolApiFor(incidentId)` in-process, so nothing a model writes can aim a
write at another incident. That is the property the per-launch bearer token
used to provide.

## An agent asks; it does not decide

`proposeMerge` is the agent's whole reach across incidents. It writes nothing:
the proposal goes to `Correlator.judgeMerge`, the same judgement and the same
confident-or-nothing rule as root-cause correlation with one candidate instead
of every open incident, and `assign` picks which record survives. A captured
agent can put one pair in front of that judgement and still move nothing.

`MergeVerdict.compared` separates a considered no from nothing having weighed
them. They point at different next moves — stop asking, or read it again —
and an agent handed one sentence for both takes a dead model for a verdict.
It is not derived from whether the model threw: nothing is compared when the
model dies **and** when the named incident resolved or merged away between the
agent reading it and the judgement running.

**Nothing this returns names a kind of caller.** The agent repeats these
sentences into a Slack thread, and "an agent may only re-partition its own
incident" shows a person a boundary they cannot see, did not ask about and can
do nothing with. Every outcome is stated in incidents and signals. The same
rule is why `assign`'s containment error names `propose_merge` rather than
explaining actors — it is a guard now, off the path anything normally takes.

## Which incident survives

Left to the caller, the survivor was an accident of who was acting:
correlation absorbed whichever incident had not just reported a root cause,
which sent a thread with four days of conversation into one opened minutes
earlier. So the rule lives in `assign`, where no caller can route around it,
and `triage/correlate.ts` elects one survivor for the whole group rather than
flipping pairs — three incidents flipped pairwise send the reporting one into
the oldest and then the rest into an incident that is already `MERGED`.

The test is the **lower incident id**, not the earliest `firstSignalAt`.
`firstSignalAt` is a property of the signals, and the act being adjudicated is
moving signals, so the challenger inherits the incumbent's age by taking its
oldest one; it is also never recomputed on absorb. Ids come from `MAX(id)+1`,
so they are the only monotonic record of when the incident itself was opened,
and the one thing a merge cannot move.

An agent still cannot merge. It asks, through `proposeMerge`; a person asks
by saying so in Slack, which the composition root applies as the `human`
actor — see `slack/CLAUDE.md`.

`firstSignalAt` moves with the signals, because it is the input to time to
detect and it was never recomputed on absorb: incident 79 held a signal from
the 27th and reported the 28th. Only a move *in* runs the recompute, so the
value can only fall.

## `set_summary` writes, and announces nothing

The one transition-shaped call that is not a transition. It is callable at
any status an agent is still on, including `INVESTIGATING` before there is
any conclusion — an incident with no title is the state the field exists to
remove, so the first call must not have to wait for a root cause.

It says nothing in the thread. A title changing is not news: the thread's
header picks it up on the next board sweep, which is where somebody reads it,
and a message every time an agent sharpens four words is how a channel gets
muted. The transitions that *are* news already post.

Over `SUMMARY_CHARS` it is **refused**, with a sentence naming the field,
both numbers and where the long version belongs — the same shape as
`overThreadBudget`, and for the same reason. A title cut at eighty characters
reads as a complete thought that happens to be wrong, and the thing that
wrote it is a model that can be asked again.

## An absorbed incident is readable

`getIncident` carries `absorbed`: every incident with `mergedInto` pointing
here, projected the same way `priorIncident` is. Read off the column rather
than remembered from the merge, so it is the same answer after a restart and
after a merge this process never saw.

It exists because the surviving agent is asked to keep a title that is true
of both halves, and for the half it never investigated the only honest source
is what that agent concluded. The `new_signals` notice names the incidents
by id; this is where the detail arrives.

## Guard in the statement

Every transition here had a TOCTOU: read the incident, check it, then write
in a *later* `withWrite`. The write queue serializes behind a synchronous S3
PUT, so the window is hundreds of milliseconds, and correlation can merge an
incident away inside it. The result was a `MERGED` row resurrected to
`FIXING` with no signals — eligible for dispatch forever, and a legal merge
target, which is the only route to a mutual `mergedInto` cycle.

So: **the predicate goes in the `UPDATE`**, and `changes === 0` rejects.

```sql
UPDATE incident SET status = 'FIXING', ...
 WHERE id = ? AND status = 'INVESTIGATING'
```

`blocked()` stays as the cheap early reject, so the model gets a readable
error, but it cannot hold a transition.

## The explained-signal gate

Invariant: every attached signal is explained by the incident's root cause.
Enforced at **both** edges of `FIXING`, not just the entrance — a
correlation merge moves signals in with `explained` reset, and triage
attaches across `FIXING`, so an incident can acquire unexplained signals
after the transition that checked them.

The split runs **after** the guarded `UPDATE`. If it ran first and the guard
then matched nothing, the transaction would still commit the splits, tearing
signals off an incident the call never touched.

## `park` moves no state

`park` writes one row in `incident_wait` and nothing else. The status does not
change, the agent keeps the incident, and the only difference afterwards is
that the dispatcher will not relaunch it until the wait is lifted. It is
refused on `CLOSED` and `MERGED`, where nothing is waiting on anything.

Anything that makes an agent stop driving needs this call, or the dispatcher
relaunches it on the next tick into whatever stopped it and it exits again,
pinging the rotation every thirty seconds. The part that catches people out is
that parking stops the *relaunch* and does **not** free the dispatcher slot:
an agent parked inside `monitor` is alive and still holds one, on purpose.
`dispatcher/CLAUDE.md` has the rest.

`escalate` stays separate and is not a substitute. It commits no transition
either, but it changes nothing about runnability: it posts the brief, reaches
the rotation, and leaves the incident with its agent still working. An agent
that is both blocked and needs somebody calls both.

## The Boss closes through here, not around it

`closeIncidentByBoss` is the Boss's close, from any open status, and it lives
beside `reportAnalysis` so the two cannot drift: one guarded `UPDATE`, the
same `closeOpenSignals` and `indexIncident` in the same write, a `stop` for
the agent, and the same `closedNotice` headline in the thread, sent through
`announceClose` as the comment on the closing report.

A CLOSED row must carry `resolvedAt` and `postmortem`, and that CHECK cannot
change on a live table. An incident closed from FIXING has neither, so both
are filled with `COALESCE`, and only where missing. The post-mortem it writes
says plainly that the Boss closed the incident and why, so the closing report
never passes the Boss's reason off as an agent's analysis. The `incident_action`
row names `boss` as the actor.

## Correlation

Triggered by `report_root_cause`, because that is the first moment an
incident has a claim worth comparing. It compares against every open
incident and splits the signals the cause does not account for.

Since the survivor is the more established incident rather than the reporting
one, the incident carrying the root cause is routinely the one that closes.
The cause travels with the signals as the merge's **reason** — which is what
the surviving agent reads in its `new_signals` notice and what both threads
are told — and never as a column on the survivor. Writing it there would forge
a transition no agent made, past the gate that makes every attached signal
explained. It arrives as a claim to check, which is the only honest form for a
cause nothing has run against the signals that just landed, and the surviving
agent is the thing that can call `report_root_cause` on it.

A correlation failure must never cost the agent its root cause: the
transition commits, the merge is skipped, and the decline is logged with the
target's actual status. A silently declined merge is the "one
agent chases two causes and the other has nobody on it" miss the design
names explicitly.

## Notify

Two audiences, two paths. People read the thread (`announce.ts`, below).
Agents are told through `AgentNotifier`, which `ToolApiDeps.agents` carries
and `applyAssign` takes: a `merged` for an emptied incident, `new_signals` for
the one that took its signals, `stop` for a Boss close. `assign` only
collects these as `AssignResult.notices`; the caller delivers them **after**
the `withWrite` resolves, so an agent is never told about a move that rolled
back. The composition root turns each into an act on the agent's
conversation (a steer, or an abort). A notify that throws alarms
(`agent_notify_failed`) and the transition stands.

The merge half lives in `announce.ts` rather than here, because there are two
ways a merge happens and only one of them runs inside an agent's call:
correlation merges on a root cause, and a person merges by saying so in a
thread, which the composition root applies with no agent in the path. A merge
that reads one way when the Boss did it and another way when a person did is
a thread nobody can follow back.

A merge and a split each leave two threads, and both are told. The absorbed
incident's thread is the half that cannot be skipped: nothing is ever posted
there again, and a thread that goes silent forever is indistinguishable from
the Boss having died. Each message links to the other thread by permalink —
`chat.getPermalink`, since Slack builds the URL out of a workspace domain
nothing here knows — and a permalink that fails alarms and leaves the sentence
naming the incident rather than losing it. Neither post can roll a merge back:
the re-partition is committed and durable before anybody is told.

The order is forced one way. A split's new incidents have no Slack thread
until the relay opens one, and a thread that does not exist can be neither
linked nor posted into, so the announcement opens threads first. That is why
`ThreadPoster` carries `openThreads` rather than the tool API reaching for the
relay.

`notify()` returns whether it posted, and one caller acts on it. `escalate`
is nothing *but* its post — it commits no transition, checks the brief against
the thread budget, posts, and leaves the incident with the agent — so a failed
post means the escalation did not happen. It returns `ok: false`, and the
agent is told to say it in the thread itself. Everywhere else the state is
already durable and the message is commentary, so a failed post alarms and the
transition stands.
