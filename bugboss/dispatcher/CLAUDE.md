# dispatcher

Decides which incidents get an agent, launches them, and stops the ones that
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

## An agent is a conversation behind a seam

Every incident agent is one Pi Durable conversation, and the dispatcher
reaches it only through `AgentRuntime` (`createIncidentConversation`,
`submit`, `isBusy`, `abort`, `reset`). It imports nothing from Pi; the
composition root implements the seam over the harness, and the unit tests
implement it in memory, because the seam is the dispatcher's whole contract.

"Alive" is `isBusy`, read every tick, plus `runs`: the launches this process
made, from the attempts write until the run settles. `isBusy` alone cannot
see a launch still cloning, so `runs` is what stops the next tick launching
it twice. After a deploy `runs` is empty and `isBusy` is what sees every run
`harness.resume()` picked up. A busy read that fails counts as busy and
alarms `busy_check_failed`, because a second input into a running
conversation is the worse mistake. The read covers every open incident with a
conversation, plus a finished one launched within the deadline window, since
a CLOSED incident's run is still writing to its workspace for a moment.

A launch writes `attempts`/`lastStartedAt`, then runs the rest in the
background: `prepareCheckout` and `startNpmCi`, on a first launch the
prompt (`composePrompt`, with the incident's alert slugs) and
`createIncidentConversation` (its id lands in `incident.conversationId`),
then `submit` with `requestId: incident:<id>:launch:<attempts>` and
`whenBusy: "followUp"`. The checkout is minutes of git and the tick is
serialized, so awaiting it would hold up every other incident. The kickoff
is `messages.kickoff`; an incident with launches behind it and no
conversation predates the harness, and its kickoff says the transcript is
gone. Every later launch is `messages.resume` plus the `resumed_after` line.

The run's settlement (`wait()`) ends the launch. A conversation idle on an
open, unparked incident is relaunched by the next tick, into the same
conversation.

## Ticks are serialized against themselves

`tick()` chains on the previous one. A tick awaits writes and harness reads
before it records a launch in `runs`, so an overlapping tick would read the
same row as unclaimed and submit a second launch.
## Two deadline layers, both here

- At `lastStartedAt + agentTimeoutSeconds` the run is **steered**
  (`deadlineMessage`, `requestId: incident:<id>:deadline:<attempts>`) to
  write an escalation brief. A steer reaches it mid-turn, inside a wait too.
- `DEADLINE_GRACE_SECONDS` later it is **aborted**, which also kills the
  subprocesses its bash is running.

They were once simultaneous, which meant the agent got none of its grace and
every timeout escalation reached the thread with an empty brief.

Both read the row, not memory, so a run the harness resumed after a deploy
is bounded by the deadline its launch set. A resume is not a launch and does
not refill the clock. A JavaScript tool wedged in-process is the one thing an
abort cannot stop.
## The turn budget is the agent's, and this only guards the launch

The agent's budget hook counts `incident.turnsUsed`, steers at the grace edge,
and at the cap escalates and parks with `liftsOnReply = 0` (see
`agent/CLAUDE.md`). The dispatcher does two things around it:

- **A launch on a spent budget is not made.** When `turnsUsed` is already at
  `agentMaxTurns + grantedTurns`, the tick parks the incident on the same
  budget wait (`turnBudgetWaitingFor`) and escalates with
  `spentBudgetBrief`, park first. No request goes out: the first request of
  a launch rewrites the whole context into the cache, and incident 80 spent
  $4.04 on one `get_incident` that way. A failed post keeps the park, since
  relaunching a spent budget does nothing but stop again; the stale sweep
  announces it within a day.
- **A raised budget lifts the wait.** See "Raising the budget" below.

Unlike the deadline, the budget is **not** per launch. Turns are work done
and a restart did not undo any of it.
## Relaunch bounds

Two counters, both **in memory on purpose**:

- `fastFailures` — consecutive runs that ended without an answer inside
  `fastFailureMs`, a crash loop. A launch that failed before its input was
  placed counts too: it never started.
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
deadline escalation has nothing to record, since its abort already makes
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
`ToolApi.park` writes it for an agent that has nothing it can do yet; a Boss
`boss_message` (`boss/commands.ts`) deletes it **if the wait says it lifts on
one**, which a spent turn budget does not — see the stale sweep below.

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
`staleAfterSeconds` with no live agent is swept. The threshold comes from
`BUGBOSS_STALE_HOURS`, default 24, and **a value that is not a positive
number disables the sweep** rather than meaning "now": `Number()` over an
unset variable is `NaN`, every comparison against `NaN` is false, and reading
that as zero would post into every open thread at once.

Two exclusions, both load-bearing:

- An incident with a live agent is skipped. A run may last a day, so a live
  agent's own `lastStartedAt` ages past the threshold underneath it and no
  row says the run is still going. Only the harness can, and it is why an
  agent parked inside `monitor` is not swept while it is still up.
- The sweep runs **after** the launch loop, so an incident this tick
  relaunched is already live and is not reported quiet on the strength of
  the row it left behind.

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

**Raising the budget lifts the wait.** `liftRaisedBudgets` runs every tick
before the eligibility read: for each open incident with a budget wait whose
`incident.turnsUsed` is under `agentMaxTurns + grantedTurns`, it deletes the
wait, writes a `turn_budget_raised` action, then posts "The turn budget was
raised to N, so the agent is resuming with M turns left." Used turns come
from the column rather than the wait's text because a launch can overrun its
budget, and a wait the new number still does not cover stays held. Lift and
marker commit before the post, as with the sweep.

**A grant lifts it on the next tick.** The Boss's `grant_turns`
(`boss/commands.ts`) adds to `incident.grantedTurns` and writes a
`turns_granted` action; it posts nothing. The lift compares used turns with
`agentMaxTurns + grantedTurns`, so a wait held as spent lifts on the first
tick a grant covers it. When the incident has a grant the notice is "Granted more turns; the agent is
resuming with M left of N." instead. It names no grant size: grants sum,
and the wait does not record which of them it is being lifted by.

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
means something is wrong. It counts live agents, busy conversations included,
so an agent parked inside a wait holds its slot. Setting it to `0` holds it
open, which is the useful local mode: ingest and triage run, no agent is ever
launched.

## The checkout runs in this process

`workspace.env(incidentId)` is the whole environment of the clone, the fetch
and the `npm ci` a launch starts. They run in the Boss process now, whose own
environment holds every secret it has, and `npm ci` runs the checkout's
postinstall scripts. The composition root passes the agent's shell allowlist
plus a fresh `GITHUB_TOKEN`. Without `workspace` (the unit tests, the E2E) no
checkout is touched.

## A resume tells the agent and alarms, and posts nothing

A deploy does not relaunch anything: `harness.resume()` picks every run up
where it stopped. On the first tick after boot, every busy conversation whose
agent was last heard from at least a tick ago is steered with a
`resumed_after` line (`requestId: incident:<id>:resumed:<boot>`), because the
agent is the one that has to re-check what moved. A relaunch of an idle
conversation carries the same line after the resume text. A gap longer than
`RESUME_ALARM_SECONDS` also raises `agent_resumed_after_gap`, which is how an
operator learns agents are dying. A shorter one only logs `agent_resumed`.

Nothing is posted to the thread. The post asked nothing of anyone and fired
on every ordinary deploy, since ECS stops the old task before the new one
starts and a deploy gap runs about eight minutes.

**The gap runs from the agent's last activity, never from its launch.** When
this process saw the last run settle, that time is exact. Otherwise it is the
newest of what the agent writes while a turn is open: `boss_inbox`, agent
`incident_action`, `pending_question`, `pending_wait`. An open
`pending_question` or `pending_wait` row means the agent was blocked inside
it when the process stopped, so it counts as alive up to this process's
start. Launch is only the floor. Measuring from launch told every thread on
every deploy that an agent working minutes earlier had been gone for hours.

## How a run ends

`wait()` resolves `done` when the run answered and `unanswered` when it was
aborted or failed. An `unanswered` the dispatcher did not cause alarms
`agent_failed`; its own deadline abort does not, since it already alarmed as
`agent_deadline_exceeded`. A Boss `stop_agent` and a merge abort a run on
purpose too, and call `noteStopped` first so the abort is not read as a
failure. Only an unanswered run inside `fastFailureMs` counts toward the
crash loop: a short run that answered is a deploy or a quick finish, not a
crash.

## Workspaces are deleted here

Each tick, before launching, `sweepWorkspaces` moves `/work/<id>` into
`/work/.trash` when the incident's row is CLOSED or MERGED and it has no live
agent, then deletes the trash in the background (a 5 GB tree is slow to
delete on EFS, and one delete runs at a time). The first tick after boot is
therefore also the sweep of whatever the last task left.

A directory with **no row** is kept and logged once as
`workspace_without_incident`. The database is restored from an S3 snapshot at
boot, and a restore that came back short would otherwise delete every live
workspace at once.
