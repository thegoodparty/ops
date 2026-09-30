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
nothing here acts on it. That is deliberate: the count lives in the restored
session file, which the dispatcher never reads, and the escalation has to
carry what the run spent — which the incident row does not have yet, because
`rollUpUsage` runs after the child exits and after this has already
escalated. So the child owns both halves. It counts, it escalates with live
numbers, and it calls `park` so this does not relaunch it into the same
exhausted budget. See `agent/CLAUDE.md`.

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

Hitting either ceiling escalates and then **parks**, and the park is what
stops the relaunching *and* the re-deciding. Without it the same escalation
goes to the thread every thirty seconds for as long as the incident stays
open. Unlike the counters it is in the database, so the stop outlives a
restart, and it is lifted by the cooldown, a Boss message or the stale sweep
rather than by a deploy.

**The counter is cleared at the ceiling either way**, and which thing replaces
it is the only difference between the two arms. A told escalation is replaced
by the park; an untold one has nothing to be replaced by, so the clear lets the
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
actually move it, raising `BUGBOSS_MAX_TURNS` or taking the work over, and
deliberately does not invite a reply, which is what the agent's own closing
brief already promised. Nothing lifts such a wait automatically, so clearing
one after the budget is raised is still a manual step.

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
call failing with nothing pointing back at the environment. Static keys
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) pass
through too and count as a path. Production never sets them; the eval harness
sets fake ones. A named profile never passes, because it would hand the child
whatever the parent's credentials file holds.

Endpoint overrides are the other pass-through (`pickEndpointEnv`): the omni
remote, `BUGBOSS_GITHUB_URL`, the CA bundles, the npm registry, the Prisma
engine mirror and every `AWS_ENDPOINT_URL_*`. Production sets none of them,
so a production child gets nothing from it. The eval harness sets all of
them, and without them the agent would be the one process in the container
still pointed at production. A GitHub that is not github.com also sets
`GH_HOST`, and the child writes each minted token to `GH_ENTERPRISE_TOKEN` as
well (`gitHubTokenEnv`), because that is the variable `gh` reads for any other
host. `bugboss/endpoints.test.ts` pins the unset case literally.

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
