# BugBoss

Incident agents that work Grafana alerts end to end. Read
[`docs/purpose.md`](./docs/purpose.md) for why this exists and
[`docs/architecture.md`](./docs/architecture.md) for how it fits together.
This file is what you need before editing anything here.

## Where to look

| Changing | Read |
| --- | --- |
| A new signal source, webhook verification | [`ingress/CLAUDE.md`](./ingress/CLAUDE.md) |
| The triage decision or its rules | [`triage/CLAUDE.md`](./triage/CLAUDE.md) |
| Transitions, merge, split, correlation | [`toolapi/CLAUDE.md`](./toolapi/CLAUDE.md) |
| Launch, deadlines, escalation | [`dispatcher/CLAUDE.md`](./dispatcher/CLAUDE.md) |
| The incident agent, its tools, resume | [`agent/CLAUDE.md`](./agent/CLAUDE.md) |
| The Bedrock provider | [`bedrock/CLAUDE.md`](./bedrock/CLAUDE.md) |
| Threads, relay, the Slack agent | [`slack/CLAUDE.md`](./slack/CLAUDE.md) |
| Routes, the loopback API | [`http/CLAUDE.md`](./http/CLAUDE.md) |
| The database or its S3 mirror | [`db/CLAUDE.md`](./db/CLAUDE.md) |

`index.ts` is the composition root — the only place real services are
named. `types.ts` is the contract everything else is built against.
`logging.ts` is the one home for `alarm` and `log`.

## The rules that are not negotiable

**Nothing fails silently.** This system's success state is quiet and its
dead state is also quiet, so a swallowed error is indistinguishable from a
working week. Use `alarm` for a failure nobody asked for and `log` for a
thing that happened, including a transition a module refused on purpose. An
alarm that fires during normal operation teaches people to ignore alarms.

**Nothing auto-closes.** The Boss may decide an alert needs no incident, but
every incident ends in an outcome a person can see. A quiet signal is
evidence an agent reads, never a transition the Boss makes.

**Status is where the work is. Owner is who has it.** Orthogonal, by design
(`types.ts`). An incident can be `FIXING` and owned by a human. Of the
places that ask "is this available", the dispatcher, `openIncidents()` and
triage's guard must all agree — they have disagreed before.

**Evidence, not assertion.** `RESOLVED` means no users are affected any more
and no further alerts should occur, confirmed. Every number the agent
reports carries the query that produced it, so it can be checked.

**Guard transitions in the statement, not before it.** Read-then-write
across `withWrite` is a TOCTOU: the write queue serializes behind a
synchronous S3 PUT, so the window is hundreds of milliseconds. Put the
predicate in the `UPDATE` and reject on `changes === 0`.

**The agent is untrusted.** It reads attacker-writable log lines for a
living. Its only route to state is the loopback API with a per-launch token
scoped to one incident, and its GitHub App cannot merge.

## Schema changes

`db/schema.sql` runs as `CREATE TABLE IF NOT EXISTS` over a restored S3
snapshot. There is no migration runner.

- Adding a **column** is fine.
- Adding a **`CHECK` constraint** is not. SQLite cannot add one to an
  existing table, so it needs a table rebuild that does not exist here. The
  cross-field constraints landed while the database was empty; that window
  closes the moment anything is routed at this.

## Testing

`npm test`, or one file with
`npx tsx --test --test-timeout=20000 <file>`.

**Do not weaken a test to make something pass.** If a test encodes
behaviour you are deliberately changing, rewrite it to the new contract and
say so in the commit. Three reviewers found ~45 defects here that the suite
was green against, because the tests were written by the same authors as
the code, against the same misunderstandings. A test that passes for the
wrong reason is worse than a missing one.

The end-to-end tests in `test/e2e.test.ts` drive real ingress, real triage,
real assign and real SQLite, faking only the model, Slack, S3 and the
spawned agent. That is where a cross-module bug shows up.

## Style

No semicolons is *not* the rule here — match the surrounding file. Arrow
functions over `function`. Comments explain a non-obvious **why**, never a
what. `any` and `unknown` are out in new code.
