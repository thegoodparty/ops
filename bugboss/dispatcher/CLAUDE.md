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

## The turn budget is the child's, and this is only the courier

`BUGBOSS_MAX_TURNS` goes down in `buildChildEnv` beside the deadline and
nothing here enforces it. That is deliberate: the count lives in the restored
session file, which the dispatcher reads only to resume a raised budget (below), and the escalation has to
carry what the run spent — which the incident row only has as of the last
tick's `rollUpUsage`, not as of the turn that spent the budget. So the child owns both halves. It counts, it escalates with live
numbers, and it calls `park` so this does not relaunch it into the same
exhausted budget. See `agent/CLAUDE.md`.

`BUGBOSS_ALERT_SLUGS` is the same kind of courier: the incident's
`alert_slug`s, read in SQL at launch, so the child can put the rule that fired
in its prompt without a `get_incident` that would drain its directives.

The one thing to know here: the child hands off and then aborts, which
leaves an error message behind. `exitCodeFor` exempts that case, so a budget
doing its job arrives as a clean exit rather than as `agent_failed`.

Unlike the deadline, the budget is **not** per launch. The deadline is
`now + agentTimeoutSeconds` on every launch and a restart gives a full clock
back; the budget does not, because turns are work done and a restart did not
undo any of it.

## Relaunch bounds

Two counters, both **in memory on purpose**:

- `fastFailures` — consecutive deaths inside `fastFailureMs`, a crash loop.
- `launches` — total launches for an incident since the last time the
  dispatcher gave up on it, ceiling `maxAttempts * 3`.

Neither is persisted, because every merge to ops `main` restarts this
container and a restart is not evidence that an agent is crashing. So a fresh
container gives a crash-looping incident another set of attempts, which is
deliberate: a quarantine on disk that no deploy could clear would strand
exactly the incidents it was added to rescue. The row's `attempts` column stays
informational for the same reason.

Hitting either ceiling **parks** and then escalates, and the park is what
stops the relaunching *and* the re-deciding. The park commits first: a park
that cannot be written posts nothing (`*_escalation_unrecorded`) and keeps
its count, so the ceiling is met again on the next tick, and a post
that fails takes the park back so the incident relaunches. Posting first is
what turned the 2026-10-01 write halt into an escalation and a rotation page
every two minutes for incident 93: every launch write failed, every third tick
met the crash-loop ceiling, and the park after the post failed too. The
deadline escalation has nothing to record, since `entry.killed` already makes
it once per run, so it is gated on an empty write instead. A deadline held
back by that gate is owed, in memory, and posted on the first tick a write
lands. Without the park the same escalation goes to the thread every thirty
seconds for as long as the incident stays open. Unlike the counters it is in
the database, so the stop outlives a restart, and it is lifted by the
cooldown, a Boss message or the stale sweep rather than by a deploy.

A launch the database refused (`writesHalted`) is not counted as a fast
failure. Counted, a halt of three ticks met the crash-loop ceiling on every
open incident and paged the rotation for each once writes returned.

**The counter is cleared at the ceiling either way**, and which thing replaces
it is the only difference between the two arms. A told escalation keeps
its park; an untold one has its park taken back, so the clear lets the
incident relaunch rather than retrying a failing escalation every tick, which
never resolved and never said so.

Clearing it on the *told* arm matters just as much, because the park expires.
A count left at the ceiling is met again by the cooldown: the wait lifts, the
incident re-enters the eligible set, the same ceiling fires on a stale count,
and the rotation is paged a second time for launches it was already paged for
— then parked, expired, and paged again, once an hour for as long as the
container lives. It also makes the cooldown a lie, since `park` promises
another go and the counter silently withholds it. A loop that is still a loop
refills the counter from real launches and escalates again, which is a page
that has earned itself.

## Parking

`incident_wait` is how an incident stops being relaunched. `Dispatcher.park`
writes it at the two ceilings above with a `PARK_COOLDOWN_SECONDS` wake;
`ToolApi.park` writes it for an agent that has nothing it can do yet;
`pushDirective` deletes it when the Boss sends the agent a `boss_message`,
**if the wait says it lifts on one**, which a spent turn budget does not — see
the stale sweep below.

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
Boss message or the stale sweep lifts it, and that is the right shape for a wait on a
person with no deadline of its own.

A Boss message lifting the wait reads no words and asks no model: any
`boss_message` is news for the agent, because the Boss is the only way
anything a person says reaches it. A reply in the thread does not lift it. It
goes to the Boss, and relaunching an agent for chatter the Boss let pass costs
a launch with nothing new to read.

## The stale sweep

`sweepStale` is the only thing here that asks whether anything is still
happening. Every other guard watches a *run*: a deadline, a crash loop, a
launch ceiling. An incident with no run at all is invisible to all of them,
and `park` makes that state reachable on purpose, since a wait with a `NULL`
`wakeAt` is lifted by a Boss message that may never come.

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

When it fires it writes a `stale_swept` `incident_action`, alarms, posts to
the thread, and **deletes the `incident_wait` row only if that wait says
`liftsOnReply`**. So a wait on a person is not a permanent stop even when
nobody ever answers: the sweep is the third way out of one, after a Boss
message and the cooldown.

A wait that does *not* lift on a Boss message is announced and left standing. The
only thing that writes one is `turnBudgetPark`, for a run that is out of
turns, and elapsed time adds no turns: deleting that row makes the incident
eligible again, so the next tick launches an agent that exhausts before its
first turn, escalates and pages -- and since the marker above is activity, it
ages out and the whole thing repeats tomorrow. That is precisely the loop
`liftsOnReply` exists to end, rebuilt on a 24-hour timer instead of on every
Boss message, and it costs a full agent launch each time round.

Announcing is unconditional, though, because the failure on the other side is
a permanent park nobody is watching. **Being told is not the same as being
relaunched**: the thread notice for a held incident names the two things that
actually move it, raising the turn budget or taking the work over, and
deliberately does not invite a reply, which is what the agent's own closing
brief already promised.

**Raising the budget lifts the wait on the next boot.** `liftRaisedBudgets`
runs every tick before the eligibility read, and reads each wait at most once
per process unless the read fails or passes `SESSION_READ_TIMEOUT_MS`: for
each open incident with a budget wait, it reads the used turns off the synced
session (`sessionTurns`) and, when they are under `agentMaxTurns`, deletes the
wait, writes a `turn_budget_raised` action, then posts "The turn budget was
raised to N, so the agent is resuming with M turns left." A wait found still
spent is not read again until the next restart, because the budget is a
constant or an env var and only a restart changes it.
The used turns come from the session rather than the wait's text because a
launch can overrun its budget, and a wait the new number still does not cover
stays held. Lift and marker commit before the post, as with the sweep.

The marker is itself activity, and that is the whole trick. The clock reads
`incident_action`, so writing the marker resets the clock the sweep reads.
One mechanism buys three things that would otherwise be three: it fires once
instead of every tick, it survives a restart (a sweep counted from process
start would re-post on every deploy, and every merge to ops `main` is one),
and it cannot ping-pong if something parks the incident straight back. The
marker commits **before** the post, on the precedent `report/index.ts` sets:
a container that dies between the two stays quiet rather than saying it
twice, and the un-park is the half that actually recovers the incident.

`postNotice` is optional on the deps because the unit tests and the E2E run
without Slack, but a prod composition root that passes nothing makes this
notice silent, so its absence alarms (`stale_notice_undeliverable`) rather
than passing. So does an incident with no thread to post into, but that
check is the poster's, in `../index.ts`, not the dispatcher's.

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

## A resume tells the agent and alarms, and posts nothing

Relaunch is automatic: an incident in an agent status gets a new child on
the next tick, whatever killed the last one. Every resume after a gap of at
least a tick gives the agent a `resumed_after` directive, because the agent
is the one that has to re-check what moved. A gap longer than
`RESUME_ALARM_SECONDS` also raises `agent_resumed_after_gap`, which is how an
operator learns agents are dying. A shorter one only logs `agent_resumed`.

Nothing is posted to the thread. The post asked nothing of anyone: the
relaunch had already happened and the agent had already been told. It also
fired on ordinary deploys. ECS stops the old task before the new one starts,
so a deploy gap runs about eight minutes from the agent's last activity,
which is over the threshold, and the notice became noise on every merge.

**The gap runs from the agent's last activity, never from its launch.** When
this process watched the exit, the exit time is exact. After a container
restart it did not: a deploy kills every child with no exit record. The clock
is then the newest of the session's last entry timestamp (synced after every
turn, via `lastSessionEventAt`) and what the agent's blocking tools write
while a turn is still open: `boss_inbox`, agent `incident_action`,
`pending_question`, `pending_wait`. An open `pending_question` or
`pending_wait` row goes further: both are deleted when the wait ends, so one
still standing and newer than the session's last entry means the agent was
blocked inside it when it was killed, and it counts as alive up to this
process's start. One older than the session is an orphan from an earlier
interrupted wait and counts for nothing, and so does any marker when the
session could not be read, since nothing then tells the two apart. The session read is bounded by
`SESSION_READ_TIMEOUT_MS`, because ticks are serialized and a hung read
would stop every relaunch. Launch is only the floor. Measuring from
launch told every thread on every deploy that an agent working minutes
earlier had been gone for hours, and to disregard its last message.

## Exit codes

A child that exits non-zero or dies to a signal **rejects**. The dispatcher
returns early when it did the killing itself, so its own deadline SIGKILL
does not also report `agent_failed` under a name pointing at the wrong
component.

## Workspaces are deleted here

Each tick, before launching, `sweepWorkspaces` moves `/work/<id>` into
`/work/.trash` when the incident's row is CLOSED or MERGED and it has no live
child, then deletes the trash in the background (a 5 GB tree is slow to
delete on EFS, and one delete runs at a time). The first tick after boot is
therefore also the sweep of whatever the last task left.

A directory with **no row** is kept and logged once as
`workspace_without_incident`. The database is restored from an S3 snapshot at
boot, and a restore that came back short would otherwise delete every live
workspace at once.
