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
| What the GitHub App may do, and why | [`github-app.md`](./github-app.md) |
| The Postgres agents run omni's tests against | [`testdb/CLAUDE.md`](./testdb/CLAUDE.md) |

`index.ts` is the composition root — the only place real services are
named. `types.ts` is the contract everything else is built against.
`logging.ts` is the one home for `alarm` and `log`.

## The rules that are not negotiable

**Nothing fails silently.** This system's success state is quiet and its
dead state is also quiet, so a swallowed error is indistinguishable from a
working week. Use `alarm` for a failure nobody asked for and `log` for a
thing that happened, including a transition a module refused on purpose. An
alarm that fires during normal operation teaches people to ignore alarms.

**Every interface a person talks to is natural language.** Nothing here
decides what somebody wants by matching their words against a list. Two
things did — the ownership claim and the bug-report verb — and both were a
magic phrase nobody could discover and everybody mistyped, failing silently
when they did. Intent is a model call (`slack/intent.ts`), advisory the way
triage is: the model reads the sentence, the code keeps the invariants, and
an ambiguous read asks in the thread rather than guessing. Who a message was
for is read the same way, because requiring a tag to answer a direct question
is the same mistake in the other direction.

An entity check — "does this text contain `<@U…>`", "is this string empty" —
is not a language interface. One of those is load-bearing: an explicit
`@bugboss` always means "this is for you", and because code decides that
rather than the model, it is the escape hatch that still works when the model
does not.

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

**The agent is untrusted, and the container is what bounds it.** An agent
reads attacker-writable log lines for a living, and it runs as a child of the
Boss with the Boss's own credentials — there is no fence inside the task.
What holds is outside it: this container reaches no database and no release
path, and its GitHub App cannot merge. The loopback API is how an agent moves
incident state, with a per-launch token scoped to one incident so concurrent
agents cannot reach each other's work.

Where GitHub offers no such fence, the bound goes in the tool and the gap is
written down rather than implied. Re-running a failed CI job is the case:
`gh run rerun` in bash is reachable the way `gh pr merge` is, so `rerun_ci`
(`agent/rerun.ts`) is an affordance with its discipline attached — one attempt
per run, read from GitHub's own `run_attempt`; a budget across the incident;
and a notice posted to the thread by the tool rather than by the model
remembering to mention it. What the App holds and what it deliberately does
not is [`github-app.md`](./github-app.md).

## Schema changes

`db/schema.sql` runs as `CREATE TABLE IF NOT EXISTS` over a restored S3
snapshot. There is no migration runner, so editing a `CREATE TABLE` body
changes only a database that does not exist yet.

- Adding a **column** takes two edits, not one. Declare it in `schema.sql`,
  which is what a fresh database gets, and add it to `LATE_COLUMNS` in
  `db/index.ts`, which is what every database that already exists gets. Miss
  the second and the column is absent in prod while the suite stays green,
  because a test opens a new file and prod restores a snapshot.
- Adding a **`CHECK` constraint** is not possible at all. SQLite cannot add
  one to an existing table, so it needs a table rebuild that does not exist
  here. The cross-field constraints landed while the database was empty; that
  window closes the moment anything is routed at this. Enforce it at the tool
  instead, and say so where the column is declared.

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
