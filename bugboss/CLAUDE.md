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

**The incident agent** (`agent/`) is the only thing in this system that
writes state. It runs Pi in a child process, investigates, opens a pull
request, waits, and writes a post-mortem.

**The Boss** is everything else that talks to a model: triage, root-cause
correlation, the inbound-language read (`slack/intent.ts`) and the Slack
question box (`slack/agent.ts`). All four are read-only against the incident
corpus, all four share one request path (`bedrock/client.ts`) and one
read-only toolset (`triage/sql.ts`), and none of them can change an incident.

The intent read is not a third agent. It has no tools and answers one label,
so it is a capability of the Boss rather than a peer, and it is written
against the same seam for the same reason.

**Every Boss capability is an answer-tool schema plus read-only lookup tools,
and code decides what happens to the answer.** That is the shape, and it is
not a style preference. `decide` goes to `applyRules`. `read_intent` goes to
the guarded `UPDATE` in the composition root. A merge proposal goes to
`toolapi`. Nothing the Boss can call writes anything, so "the model proposes;
the rules decide" is structural here rather than a discipline somebody
remembers -- see [`triage/CLAUDE.md`](./triage/CLAUDE.md). A free-form tool on
a Boss path would end that, quietly, and is the one change to this area worth
refusing.

The Slack question box is the deliberate exception, and only about its
*output*: its answer is prose, not a schema, because there is nothing to
validate in "here is what I found". Code still decides what happens to it --
it is capped at about 200 words and posted. It reads; it does not act.

**Two loops, on purpose.** `runStructuredCall` bounds a whole call with one
wall-clock budget and a round count, and throws so every caller takes its
conservative default. The Slack box bounds each turn separately, because what
limits it is how long a person will sit in a thread, and it ends an exhausted
run with a tool-less wrap-up rather than a throw -- somebody is waiting, and
the reading is already paid for. Those are different bound shapes, not one
shape with options, and folding them would cost triage its readability to
serve the question box. They share the request path, the toolset and the
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
the Boss reads every message itself, with the incident as context; out in the
channel a mention is read by a model call (`slack/intent.ts`), advisory the
way triage is: the model reads the sentence, the code keeps the invariants,
and an ambiguous read asks rather than guessing.

An entity check — "does this text contain `<@U…>`", "is this thread an
incident's" — is not a language interface. Those decide where a message is
routed, never what it meant.

**Anything a reader sees the same way twice is rendered once, in code.** An
incident reference, a status-board row and a thread's header are all
formatting, and formatting asked for in a prompt is followed
probabilistically -- which is how the same answer came to link some incidents
and not others, and to spell the same word two ways in one message. The
renderers are `slack/incidents.ts` and `slack/board.ts`; the model writes
"incident 4" in prose and code decides what that looks like. This is the
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
Boss telling the agent something deletes the row; a reply in the thread goes
to the Boss and does not. `dispatcher/CLAUDE.md` has the mechanism.

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
