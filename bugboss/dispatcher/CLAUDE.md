# dispatcher

Decides which incidents get an agent, launches them, and kills the ones that
overrun.

## Eligibility is one list

`AGENT_STATUSES` is `INVESTIGATING`, `FIXING`, `RESOLVED`, and both
`ELIGIBLE_SQL` and `escalate` derive from it. Status is where the work is and
it is almost the whole predicate: every incident in one of those statuses must
have a live agent, so any of them without one gets a launch on the next tick.

They used to be two lists and they drifted: `RESOLVED` was missing from both,
so an agent killed while writing a post-mortem was never relaunched *and*
never escalated, and nothing was coming back for it.

`RESOLVED` is dispatchable because `report_analysis` is the only exit from
it and that is the agent's job.

The only thing `ELIGIBLE_SQL` adds to that is a `LEFT JOIN` on
`incident_wait`: a row there means the incident is blocked on a person and is
not runnable until its `wakeAt` passes. It is still the agent's incident. See
"Parking".

## Ticks are serialized against themselves

`tick()` chains on the previous one. A tick awaits an S3 PUT *before* it
records a launch in `running`, so an overlapping tick reads the same row as
unclaimed and starts a second child. Two children then hold
valid tokens for one incident and both whole-file write the same session
transcript, overwriting each other's turns.

That map is the single-writer guarantee the whole resume design rests on,
and it is only authoritative if ticks cannot interleave.

## Two deadline layers

- The child gets `BUGBOSS_DEADLINE_AT` as its **soft** deadline. It steers
  itself to write an escalation brief and sets its own hard stop at
  `+ DEADLINE_GRACE_SECONDS`.
- The parent's SIGKILL is at `deadlineAt + grace + one tick`, strictly
  later, so the grace window actually happens.

They were once simultaneous, which meant the agent got at most one tick of
its grace and every timeout escalation reached the thread with an empty brief.

`DEADLINE_GRACE_SECONDS` is imported from `agent/run.ts` rather than
duplicated, with a runtime assertion at import: under `tsx` a renamed export
arrives as `undefined`, `killAt` becomes `NaN`, and `now < NaN` is false —
so the backstop would collapse to *zero* and kill every agent on its first
tick. The grace test pins its clocks to literals for the same reason.

## Relaunch bounds

Two counters, both **in memory on purpose**:

- `fastFailures` — consecutive deaths inside `fastFailureMs`, a crash loop.
- `launches` — total launches this container has made for an incident,
  ceiling `maxAttempts * 3`.

Neither is persisted, because every merge to ops `main` restarts this
container and a restart is not evidence that an agent is crashing. So a fresh
container gives a crash-looping incident another set of attempts, which is
deliberate: a quarantine on disk that no deploy could clear would strand
exactly the incidents it was added to rescue. The row's `attempts` column stays
informational for the same reason.

Hitting either ceiling escalates and then **parks**, and the park is what
stops the relaunching *and* the re-deciding. Without it the same escalation
goes to the thread every thirty seconds for as long as the incident stays
open. Unlike the counters it is in the database, so the stop outlives a
restart, and it is lifted by the cooldown, a reply or the stale sweep rather
than by a deploy.

An escalation that *failed* to post clears the counter instead, and the
incident is relaunched. Holding the counter at the ceiling retried the same
failing escalation every tick, which never resolved and never said so.

## Parking

`incident_wait` is how an incident stops being relaunched. `Dispatcher.park`
writes it at the two ceilings above with a `PARK_COOLDOWN_SECONDS` wake;
`ToolApi.park` writes it for an agent that has nothing it can do yet;
`relay.recordReply` deletes it on **any** reply in the thread.

It exists because `owner = 'human'` was doing two jobs at once: saying who had
the work, and stopping the relaunch. Only the second was load-bearing.
Deleting it without replacing that half turns an agent that stops driving into
a hot loop, since the dispatcher relaunches on the next tick, the agent lands
straight back in whatever stopped it and exits again, pinging the rotation
every thirty seconds. A budget-exhausted agent is the case that makes this
unavoidable.

**It stops the relaunch. It does not free the slot.** Those are easy to
conflate and they are not the same thing. An agent parked inside `monitor` is
alive and still counts against `maxConcurrentAgents`, deliberately:
suspend-and-resume was considered and ruled out, so a run that is merely
waiting stays running. Parked agents eating the concurrency cap is an accepted
outcome to observe, not a bug to pre-empt.

The wake is a cooldown rather than never, because nothing the dispatcher parks
for is permanent: a crash loop and a launch ceiling both say "not now" rather
than "not ever", and a container that has come back healthy should pick the
work up without needing a person. `wakeAt` of `NULL`, which is what
`ToolApi.park` writes when the agent gives no `wakeAfterSeconds`, means only a
reply or the stale sweep lifts it, and that is the right shape for a wait on a
person with no deadline of its own.

A reply lifting the wait is **upstream of anything that reads what the message
meant**. Talking to an incident wakes it, with no model in the path. That is
the property that makes the original failure unreachable, and it is why the
delete sits in `recordReply` rather than behind the intent read: every version
of this that asks a model to recognise the right words goes quiet the first
time somebody phrases it their own way. A reply that turns out to be two
people talking to each other costs one relaunch.

## The stale sweep

`sweepStale` is the only thing here that asks whether anything is still
happening. Every other guard watches a *run*: a deadline, a crash loop, a
launch ceiling. An incident with no run at all is invisible to all of them,
and `park` makes that state reachable on purpose, since a wait with a `NULL`
`wakeAt` is lifted by a reply that may never come.

The clock is one `MAX` over four columns: `firstSignalAt`, `lastStartedAt`,
the newest `thread_reply`, and the newest `incident_action`. Anything past
`staleAfterSeconds` with no live child is swept. The threshold comes from
`BUGBOSS_STALE_HOURS`, default 24, and **a value that is not a positive
number disables the sweep** rather than meaning "now": `Number()` over an
unset variable is `NaN`, every comparison against `NaN` is false, and reading
that as zero would post into every open thread at once.

Two exclusions, both load-bearing:

- An incident in `running` is skipped. A run may last a day, so a live
  agent's own `lastStartedAt` ages past the threshold underneath it and no
  row anywhere says the process is still alive. That map is the only thing
  that can, and it is why an agent parked inside `monitor` is not swept while
  it is still up.
- The sweep runs **after** the launch loop, so an incident this tick
  relaunched is already in `running` and is not reported quiet on the
  strength of the row it left behind.

Together those two bound what the sweep can ever reach: an incident the
dispatcher *cannot* run. Anything runnable was launched moments earlier in
the same tick. In practice that is parked incidents, and incidents the
concurrency ceiling keeps skipping.

When it fires it writes a `stale_swept` `incident_action`, **deletes the
`incident_wait` row**, alarms, and posts to the thread. So a park is not a
permanent stop even when nothing ever replies: the sweep is the third way out
of one, after a reply and the cooldown.

The marker is itself activity, and that is the whole trick. The clock reads
`incident_action`, so writing the marker resets the clock the sweep reads.
One mechanism buys three things that would otherwise be three: it fires once
instead of every tick, it survives a restart (a sweep counted from process
start would re-post on every deploy, and every merge to ops `main` is one),
and it cannot ping-pong if something parks the incident straight back. The
marker commits **before** the post, on the precedent `report/index.ts` sets:
a container that dies between the two stays quiet rather than saying it
twice, and the un-park is the half that actually recovers the incident.

## The circuit breaker

`maxConcurrentAgents` is a circuit breaker, not a scheduler. Hitting it
means something is wrong. Setting it to `0` holds it open, which is the
useful local mode: ingest and triage run, no agent is ever spawned.

## The child environment

Built up from nothing rather than filtered down from `process.env`, so a
child holds only what the composition root named: process essentials, the
outbound tokens it needs, and its own incident identity. That is hygiene, not
containment — a child can read the parent's environment — but a credential
nobody handed the agent cannot end up in a log line or a Slack post by
accident.

AWS is the deliberate exception. `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` is
passed through, so the child resolves the task role through the SDK's
container provider and that provider refreshes for as long as the run lasts.
A launch whose environment carries no credential path at all alarms:
without it the agent loses Bedrock, and that surfaces a turn later as a model
call failing with nothing pointing back at the environment.

## A resume is announced, not silent

Relaunch was always automatic: an incident in an agent status gets a new
child on the next tick, whatever killed the last one. What was
missing is that nobody was told. A thread whose last message is *"the PR is
waiting on a human merge"* stays true after the agent dies, so the silence
reads as patience.

A gap longer than `RESUME_NOTICE_SECONDS` alarms **and** posts to the thread.
Shorter than that is a deploy putting everything back within a tick or two,
and saying so each time would teach people to skip the message that matters.
The agent is still told either way -- that is the `resumed_after` directive,
and it is the one that has to re-check what moved.

`postNotice` is optional on the deps because the unit tests and the E2E run
without Slack, but a prod composition root that passes nothing makes the one
event this exists to surface silent again, so its absence alarms rather than
passing.

## Exit codes

A child that exits non-zero or dies to a signal **rejects**. The dispatcher
returns early when it did the killing itself, so its own deadline SIGKILL
does not also report `agent_failed` under a name pointing at the wrong
component.
