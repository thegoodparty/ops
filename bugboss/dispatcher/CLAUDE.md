# dispatcher

Decides which incidents get an agent, launches them, and kills the ones that
overrun.

## Eligibility is one list

`AGENT_STATUSES` is `INVESTIGATING`, `FIXING`, `RESOLVED`, and both
`ELIGIBLE_SQL` and `escalate` derive from it. They used to be two lists and
they drifted: `RESOLVED` was missing from both, so an agent killed while
writing a post-mortem was never relaunched *and* never escalated. It sat
with `owner: agent` forever, invisible to any digest of unclaimed work.

`RESOLVED` is dispatchable because `report_analysis` is the only exit from
it and that is the agent's job.

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
  itself to write a handoff brief and sets its own hard stop at
  `+ DEADLINE_GRACE_SECONDS`.
- The parent's SIGKILL is at `deadlineAt + grace + one tick`, strictly
  later, so the grace window actually happens.

They were once simultaneous, which meant the agent got at most one tick of
its grace and every timeout escalation handed a human an empty brief.

`DEADLINE_GRACE_SECONDS` is imported from `agent/run.ts` rather than
duplicated, with a runtime assertion at import: under `tsx` a renamed export
arrives as `undefined`, `killAt` becomes `NaN`, and `now < NaN` is false —
so the backstop would collapse to *zero* and kill every agent on its first
tick. The grace test pins its clocks to literals for the same reason.

## Relaunch bounds

Two separate counters, both **in memory on purpose**:

- `fastFailures` — consecutive deaths inside `fastFailureMs`, a crash loop.
- `launches` — total launches this container has made for an incident,
  ceiling `maxAttempts * 3`.

Neither is persisted, because every merge to ops `main` restarts this
container and a restart is not evidence that an agent is crashing. The row's
`attempts` column stays informational for the same reason — and gating on it
would break hand-back, since nothing resets it.

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

Relaunch was always automatic: an agent-owned incident in an agent status
gets a new child on the next tick, whatever killed the last one. What was
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

## Nothing open stays silent for a day

Every watch above is reached through `owner = 'agent'`. `ELIGIBLE_SQL` asks
whether every incident that *should* have an agent has a live one and defines
"should" as that column, so an incident a person owns is not late — it is not
in the question. `agent_resumed_after_gap` fires on a relaunch, which needs
the same column. `pending_wait`'s nudge needs a live agent parked on
`monitor(awaitingHuman)`. An incident somebody took, or was escalated to and
never answered, falls outside all three, and seven open incidents reached 8
to 32 hours of complete silence there.

`sweepStale` asks the question none of those do: has anything happened here
lately. Over every incident that is not `CLOSED` or `MERGED`, whatever the
owner, `staleAfterSeconds` (`BUGBOSS_STALE_HOURS`, default 24) past the last
activity it posts in the thread — plainly, how long it has been quiet and
what happens next — and flips `owner` back to `'agent'` so the incident
actually moves.

**Activity is wider than `lastStartedAt`.** A reply and a hand-off each move
an incident without launching an agent, so the clock is the max of
`firstSignalAt`, `lastStartedAt`, the newest `thread_reply.receivedAt` and
the newest `incident_action.at`. Watching launches alone would read a running
conversation as silence and, the other way round, call an incident stale
while its agent was mid-run — a run may last a day. The live-agent case is
answered by the `running` map instead, because no row can show it. `handOff`
writes an `incident_action` row for this reason: without it, an incident
escalated at the 24-hour deadline would be handed straight back to an agent
by the sweep on the same tick, undoing the escalation.

**The marker is also activity, which is the whole trick.** A `stale_swept`
`incident_action` row goes in before the post, in one transaction with the
flip. Because the clock already reads `incident_action`, writing it resets
the clock — so the sweep cannot fire twice, and a swept incident an agent
parks straight back on a person cannot bounce back here an hour later. The
next sweep is a full threshold away by construction, with no separate
suppression to keep in step with it. It is persisted rather than counted from
process start for the reason `pending_wait` is: every merge to ops `main`
restarts this container, and a sweep that re-posted on resume would make each
deploy a notification storm.

It runs **after** the launch loop, so an incident this tick already
relaunched is in `running` and is not also reported quiet by the row it left
behind. A hand-back is therefore picked up by the next tick, which is what
the post says. `staleAfterSeconds` at zero or less turns it off rather than
sweeping everything — `Number()` on an unset variable is `NaN`, and the cost
of reading that wrong is a post in every open thread at once.

## Exit codes

A child that exits non-zero or dies to a signal **rejects**. The dispatcher
returns early when it did the killing itself, so its own deadline SIGKILL
does not also report `agent_failed` under a name pointing at the wrong
component.
