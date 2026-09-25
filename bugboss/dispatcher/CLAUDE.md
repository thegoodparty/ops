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

`tick()` chains on the previous one. A tick awaits an S3 PUT and an STS call
*before* it records a launch in `running`, so an overlapping tick reads the
same row as unclaimed and starts a second child. Two children then hold
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

## Exit codes

A child that exits non-zero or dies to a signal **rejects**. The dispatcher
returns early when it did the killing itself, so its own deadline SIGKILL
does not also report `agent_failed` under a name pointing at the wrong
component.
