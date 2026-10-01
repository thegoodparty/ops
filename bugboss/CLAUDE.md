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
| The Bedrock request path every model call takes | [`bedrock/CLAUDE.md`](./bedrock/CLAUDE.md) |
| Threads, relay, the Slack agent | [`slack/CLAUDE.md`](./slack/CLAUDE.md) |
| The status board, the morning post, the all-clear | [`board/CLAUDE.md`](./board/CLAUDE.md) |
| The closing report an incident ends with | [`report/CLAUDE.md`](./report/CLAUDE.md) |
| Noticing an incident's PR merge, close or review verdict | "PRs are watched in code" below, and `prwatch/index.ts` |
| Routes, the loopback API | [`http/CLAUDE.md`](./http/CLAUDE.md) |
| The database or its S3 mirror | [`db/CLAUDE.md`](./db/CLAUDE.md) |
| What the GitHub App may do, and why | [`github-app.md`](./github-app.md) |
| The Postgres agents run omni's tests against | [`testdb/CLAUDE.md`](./testdb/CLAUDE.md) |

`index.ts` is the composition root — the only place real services are
named. `types.ts` is the contract everything else is built against.
`model.ts` is the seam the Boss's own bounded calls are written against, and
`bedrock/client.ts` is its only implementation that reaches a model.
`logging.ts` is the one home for `alarm` and `log`.

## There are two agents here, not four

**The incident agent** (`agent/`) investigates, opens a pull request, waits,
and writes a post-mortem. It runs Pi in a child process and moves its own
incident through the loopback tool API. It never reads Slack and never posts
free text to it: everything it needs from a person goes up to the Boss.

**The Boss** is everything else that talks to a model: triage, root-cause
correlation and the incident commander (`slack/agent.ts`). They share one
request path (`bedrock/client.ts`) and one read-only query guard
(`triage/sql.ts`).

**The commander is the only interface between people and agents.** Every
message a person writes in an incident thread runs it, with that incident as
context, and so does every `@bugboss` mention anywhere else and every row an
agent writes to `boss_inbox`. It answers,
stays silent, or talks to the agent with `message_agent`, which is the only
way anything a person says reaches an agent. It can also close, merge and
stop, page the rotation, and open an incident for something a person reports
broken. `slack/CLAUDE.md` has the mechanics.

**Every Boss write is a request the model makes and code decides.** That is
the shape, and it is not a style preference. `decide` goes to `applyRules`.
A merge
proposal goes to `toolapi`. The commander's write tools (`boss/commands.ts`)
take an incident and a reason and nothing else: the guard, the transition and
the notification are code, and they are the same code an agent's transition
runs -- a close goes through the tool API's close, a merge through `assign`
and `announceMerge` -- so a thread reads the same whoever caused it. What the
model contributes is the ask and the evidence, and the prompt forbids a state
change it cannot cite evidence for. A free-form write tool on a Boss path, one
that lets the model decide *what* is written rather than *whether* to ask,
would end that, quietly, and is the one change to this area worth refusing.

Its answer is prose rather than a schema, because there is nothing to
validate in "here is what I found". Code still decides what happens to it:
anything it writes is posted whole, and it posts nothing only by calling
`stay_silent`. An empty answer without that call is a failed run, and alarms.

**Two loops, on purpose.** `runStructuredCall` bounds a whole call with one
wall-clock budget and a round count, and throws so every caller takes its
conservative default. The commander bounds each turn separately, because what
limits it is how long a person will sit in a thread, and it ends an exhausted
run with a tool-less wrap-up rather than a throw -- somebody is waiting, and
the reading is already paid for. Those are different bound shapes, not one
shape with options, and folding them would cost triage its readability to
serve the commander. They share the request path, the query guard and the
usage accounting, which is where the duplication actually was.

## The rules that are not negotiable

**Nothing fails silently.** This system's success state is quiet and its
dead state is also quiet, so a swallowed error is indistinguishable from a
working week. Use `alarm` for a failure nobody asked for and `log` for a
thing that happened, including a transition a module refused on purpose. An
alarm that fires during normal operation teaches people to ignore alarms.

**Every interface a person talks to is natural language.** Nothing here
decides what somebody wants by matching their words against a list. One thing
did — the bug-report verb — and it was a magic phrase nobody could discover
and everybody mistyped, failing silently when they did. In an incident thread
the Boss reads every message itself, with the incident as context, and a
mention anywhere else goes to the Boss too. Nothing reads a message before the
Boss does, so nothing can decide a request to act is "a report or a question"
and ask which.

An entity check — "does this text contain `<@U…>`", "is this thread an
incident's" — is not a language interface. Those decide where a message is
routed, never what it meant.

**Anything a reader sees the same way twice is rendered once, in code.** An
incident reference, a status-board row, a thread's header and an incident's
status card are all formatting, and formatting asked for in a prompt is followed
probabilistically -- which is how the same answer came to link some incidents
and not others, and to spell the same word two ways in one message. The
renderers are `slack/incidents.ts`, `slack/status.ts` and `slack/board.ts`;
the model writes "incident 4" in prose and code decides what that looks like. This is the
opposite of the language rule above, not an exception to it: that one is
about reading what a person meant, this one is about our own output.

**There is no scheduler, and adding one is the wrong fix.** Every merge to
ops `main` restarts this container, so an in-memory "next fire at 07:00"
either fires twice or is skipped depending on when a deploy lands. Recurring
work rides the dispatcher tick or the composition root's sweep interval, and
remembers what it has done in SQLite -- as a **date** where a day is the
unit, never a timestamp, or the clocks going back produce a double post.

**Nothing auto-closes.** The Boss may decide an alert needs no incident, but
every incident ends in an outcome a person can see. A quiet signal is
evidence an agent reads, never a transition the Boss makes.

**An open incident is always driven by an agent.** A person is something an
incident can be *waiting on*, never something it can be *given to*
(`types.ts`). `status` is the only axis, and it says where the work is. Of the
places that ask "is this available", the dispatcher, `openIncidents()` and
triage's guard must all agree — they have disagreed before.

Waiting on a person is a row in `incident_wait`, not a field on the incident.
It says the dispatcher must not relaunch this incident yet, and nothing more:
the agent still has the work, and it still holds its dispatcher slot. The
Boss telling the agent something deletes the row, unless the wait is a spent
turn budget; a reply in the thread goes to the Boss and does not. `dispatcher/CLAUDE.md` has the mechanism.

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
and a notice sent to the Boss by the tool rather than by the model
remembering to mention it. What the App holds and what it deliberately does
not is [`github-app.md`](./github-app.md).

## PRs are watched in code

An agent watching its own PR is not enough: it can be parked, dead,
restarting, out of budget, or simply not say so. Incident 84's agent saw the
merge three minutes after it happened and nothing reached the thread; incident
90's thread said it needed a person for 1h40m after the merge.

So `prwatch/` watches every PR an open incident owns -- `prUrls`, the agent's
`fix_pr_opened` and `fix_merged` timeline events, and any PR a wait on a person
names -- once a minute on the composition root's sweep interval, in **one
GraphQL request for all of them** (one point of the App's 5,000 an hour).
`pr_watch` is its memory, so a restart does not announce anything twice.

On a merge or a close it commits first, then posts a code-composed notice
through the announcer, records an `incident_action`, deletes the `pending_wait`
that named the PR (the header's "Needs a human to merge" line), and pushes a
`boss_message`, which lifts a park and steers a live agent. A delegate verdict
on the head is announced once it has stood for `REVIEW_SETTLE_SECONDS`, because
delegate can approve and then request changes minutes later.

Two rules keep it to one notice per transition:

- The announcement is claimed in the statement: `UPDATE pr_watch ... WHERE
  announcedAt IS NULL`, and only the write that changed a row posts. The
  sweep and an agent's wait can both see one merge; only one of them wins.
- An agent's wait on a person ends with a "done" to the Boss carrying what it
  waited on (`waitDone`). The inbox route asks the watcher about the PRs it
  names, which reads them right then, so whoever saw it first, the thread
  hears it once and the Boss is not handed the same news. Only an
  announcement made after that wait began covers it: a later wait that names
  the same PR, its deploy say, is news of its own.

A PR first seen already merged is history unless a wait on a person still
names it. Without that rule, the deploy that shipped this would have announced
every PR every open incident had ever shipped.

## Schema changes

`db/schema.sql` runs as `CREATE TABLE IF NOT EXISTS` over a restored S3
snapshot. There is no migration runner, so editing a `CREATE TABLE` body
changes only a database that does not exist yet.

- Adding a **column** takes two edits, not one. Declare it in `schema.sql`,
  which is what a fresh database gets, and add it to `LATE_COLUMNS` in
  `db/index.ts`, which is what every database that already exists gets. Miss
  the second and the column is absent in prod while the suite stays green,
  because a test opens a new file and prod restores a snapshot. `Db.open`
  now names that gap at boot rather than leaving it to the first rolled-back
  transaction: a `schema_drift` alarm lists every column `schema.sql`
  declares that the live database does not have. It does not fix it, so the
  second edit is still yours.
- **The `LATE_COLUMNS` type must be the whole declaration**, constraints and
  default included -- `"INTEGER NOT NULL DEFAULT 0"`, never a bare
  `"INTEGER"`. `ALTER TABLE ADD COLUMN x INTEGER` produces a *nullable*
  column and leaves every row already in the snapshot at NULL, while
  `schema.sql` says `NOT NULL` and the TypeScript type says `number`. So
  prod reads null out of a field nothing declares nullable, and only for the
  rows that predate the column.

  `schema_drift` cannot catch this, which is why it is written down here
  instead: `PRAGMA table_info` reports the declared type as `INTEGER` for
  both spellings, so the check compares equal. It verifies presence, not
  nullability. The default is also what backfills the existing rows, and
  SQLite refuses `NOT NULL` with no default outright.
- A `LATE_COLUMNS` entry naming a table that does not exist **refuses the
  boot**. That is a defect in the list, identical on every boot, so it never
  reaches prod.
- Removing a **column** is normally one edit, not two: delete it from
  `schema.sql` and stop naming it in SQL. Nothing catches the existing
  database up, so it keeps the column forever, and that is fine *because the
  column has a `DEFAULT`* -- a restored snapshot still accepts an insert that
  no longer names it.
  
  Which is the same fact the addition trap above turns on, seen from the
  other side: a `NOT NULL` column with no default is the one thing SQLite
  gives you no way to retrofit. It cannot be added that way, and it cannot be
  retired that way either, because the first insert that stops naming it
  fails against every database that already exists and none that a test
  opens. There is no `ALTER COLUMN` to add the default afterwards. So such a
  column is **kept, declared and written, and read by nothing**.
  `incident.owner` is the one; `db/CLAUDE.md` says why that is a better trade
  than dropping it for real.
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
