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

`logAssign` is emitted **after** the transaction, never inside it, so a
rolled-back assign leaves no record claiming it happened.

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
is what that agent concluded. The `new_signals` directive names the incidents
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

## Correlation

Triggered by `report_root_cause`, because that is the first moment an
incident has a claim worth comparing. It compares against every open
incident and splits the signals the cause does not account for.

A correlation failure must never cost the agent its root cause: the
transition commits, the merge is skipped, and the decline is logged with the
target's actual status. A silently declined merge is the "one
agent chases two causes and the other has nobody on it" miss the design
names explicitly.

## Notify

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
