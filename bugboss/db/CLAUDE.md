# db

SQLite on local disk, mirrored to S3 on every committed write.

## `withWrite` is the only way to write

It does three things that all matter:

1. **Serializes writes** through a promise chain. One process, so a chain is
   the whole lock.
2. **Runs `fn` in a transaction.**
3. **Does not resolve until S3 has the snapshot.** When an agent's
   `report_root_cause` returns, the transition is durable.

Never pass an async function to it. better-sqlite3's transactions are
synchronous only, and an async callback would commit early.

## A failed PUT halts writes

Permanently, and on purpose. A process that keeps committing locally while
S3 falls behind is worse than one that stops, because the divergence stays
invisible until a restart loses it.

The consequence is worth knowing: after one halt, every ingest, every
transition and every escalation throws. That is the correct behaviour and
also a total outage, so the halt is an `alarm`, not a log.

## Two connections

`query` and `get` use a **separate, read-only** connection. That is why the
30-second directive poll never queues behind the write chain and its
synchronous PUT. Reads that must see a write in progress belong inside the
`withWrite` callback, using the handle it passes.

## Schema changes

`schema.sql` is executed as `CREATE TABLE IF NOT EXISTS` over the restored
snapshot. **There is no migration runner.** The consequence is easy to read
the wrong way round: editing the body of a `CREATE TABLE` affects only a
database that does not exist yet, so a change that looks applied everywhere
is applied nowhere that matters.

- **Columns** need declaring twice. Once in `schema.sql`, which is what a
  fresh database gets and where the column is documented, and once in
  `LATE_COLUMNS` in `index.ts`, which `Db.open` applies as an `ALTER TABLE
  ADD COLUMN` when the column is missing. SQLite has no `ADD COLUMN IF NOT
  EXISTS`, which is why that check is in TypeScript rather than in the DDL.
  The failure mode when the second edit is missed is the whole reason this is
  written down: every test opens a new file and passes, and prod restores a
  snapshot where the column never arrives, so the first statement naming it
  rolls its transaction back.

  Two boot-time checks make that miss visible instead. An entry naming a
  table that does not exist **throws**, because `PRAGMA table_info` answers a
  missing table with an empty list, so the entry is indistinguishable from a
  column waiting to be added and the `ALTER` only fails today because
  `schema.sql` happens to run first. That is a defect in the list rather than
  a state the world reaches, so the suite catches it and refusing the boot
  costs nothing. Every column `schema.sql` declares that the live database
  lacks, or has under a different declared type, **alarms** as
  `schema_drift` and boots anyway: that one is reachable only in prod, and a
  Boss that will not start cannot investigate why. The comparison is against
  a throwaway in-memory database built from the same DDL, so SQLite parses
  the schema and no comment, table-level `CHECK` or virtual-table directive
  can be mistaken for a column.
- **Removing a column is one edit, not two**, and the asymmetry from adding
  one is real rather than an oversight. Delete it from `schema.sql` and stop
  naming it in SQL. A database that already exists keeps the column and
  nothing catches it up: a column nothing reads and nothing writes costs a few
  bytes a row, and an `ALTER TABLE DROP COLUMN` that never runs can never
  fail.

  What makes that safe is the **default**. `costUsd` is `REAL NOT NULL DEFAULT
  0`, so a restored snapshot still accepts an `INSERT` that has stopped naming
  it. That is the whole discriminator, and the next bullet is the case where
  it does not hold.
- **A `NOT NULL` column with no default cannot be retired that way.** The same
  treatment makes every `INSERT` fail against the restored snapshot, which is
  every write in production and none in the suite, because a test opens a
  fresh file and a fresh file is built from the current `schema.sql`. SQLite
  has no `ALTER COLUMN`, so the default cannot be added to the existing column
  afterwards; that is verified, not assumed. Dropping the column for real
  works mechanically and is a door that only opens one way: the previous image
  reads it, so a rollback meets a database it cannot boot against.

  So the column is **kept, declared and written, and read by nothing**.
  `incident.owner` is the one. `schema.sql` declares it `NOT NULL DEFAULT
  'agent'`, and the single `INSERT INTO incident` in `toolapi/assign.ts`
  writes the literal `'agent'`. One word in one statement keeps a fresh
  database and a restored snapshot identical.

  `settleOwnerToAgent` runs at boot and sets the column to `'agent'` on every
  row that is not already. It changes nothing in this image, because nothing
  reads the column here. It is there for the one reader that still exists:
  the **previous** image, if a deploy is rolled back. That build filters the
  dispatcher on `owner = 'agent'`, so a row left saying `'human'` would come
  back stranded exactly as it is now. Between the settle and the constant,
  a rollback is not merely survivable but correct. It is idempotent and
  matches nothing after the first boot, which is why it is cheap to run on
  every one.

  `describe("the write-only owner column")` in `index.test.ts` is what holds
  all of that, because none of it is visible from a fresh file. It builds a
  fixture snapshot whose copy of the column has *no* default, which is
  production's shape, and asserts that a write goes through, that booting over
  it reports no `schema_drift` (only the declared type is compared, which is
  what makes the differing default survivable), that a seeded `'human'` row
  comes back `'agent'`, that the `INSERT` still names the column and still
  writes `'agent'`, and that no query in the package reads it back.
- **`CHECK` constraints cannot** be added at all. SQLite has no `ALTER TABLE
  ADD CHECK`, so adding one needs a table rebuild that does not exist here.
  The cross-field constraints landed while the database was empty; that
  window closed the moment real data existed. A constraint you want now is
  refused at the tool instead.

The constraints are there because every invariant in this system was
otherwise a comment plus a hand-written `if`, and three of them turned out
to be reachable.

## Triage's spend is on the signal row

Six columns on `signal` -- `tokensIn`, `tokensOut`, `cacheRead`, `cacheWrite`,
`modelCalls`, `modelId` -- and no `costUsd`, matching `incident`. Tokens plus a
model id multiply out correctly after a price change; a stored dollar figure is
a guess frozen at write time. Anything showing a person a dollar figure derives
it and says it is an estimate.

They are written accumulating, not replacing. `rollUpUsage` re-reads the whole
session file so its total is absolute and a `SET` is right there; a triage
decision knows only what it just spent, and a signal nothing ever placed is
triaged again on its next delivery.

`modelCalls` is the guard rather than a statistic. A request that reached the
model always spends something, so calls above zero beside zero tokens means a
reader has drifted from what the provider returns -- and that alarms instead of
recording a decision that cost nothing.

The columns are deliberately absent from `SignalView`, which is what the
investigating agent gets from `get_incident`. Six numbers per signal, on every
read, about a decision it is not working on.

## Uniqueness on signals

One **open** signal per `(source, sourceId)`, not one for all time. A
Grafana fingerprint is stable for the life of the alert rule, so an all-time
key meant the second time an alert ever fired it was dropped as a duplicate
— and recurrence, which depends on exactly that delivery, became
unreachable.

That index cannot serve the recurrence lookup itself, though: it is partial
on `closedAt IS NULL`, and every signal a resolution closed has a `closedAt`.
`signal_source_idx` is the same key without the partial clause, read once per
inbound delivery by `triage/recurrence.ts`.

## Two tables that are not incident state

**`incident_thread`** holds how a thread's top-level message is rendered: the
header last written, and where it links (`originLabel`, `originUrl`), kept so
a Slack report's permalink is asked for once. It is a table rather than
columns on `incident` because `getIncidentRow` is `SELECT *` and spreads the
row, so anything added there arrives in the agent's `get_incident` result.
`opening` is what the relay first posted; nothing reads it back.

**`board_state`** is one row, and it is the whole memory of everything
recurring the board does. See `board/CLAUDE.md` for why every field in it is
persisted and why `dailyOn` is a date rather than a timestamp.

## `incident_fts` is derived, not migrated

FTS5 over the post-mortems, root causes and resolution evidence of incidents
that already claimed a problem was over — the corpus `CLOSED` has always
required and nothing read back. It is written by `reportResolved` and
`reportAnalysis` **inside their own transactions**, so an incident that is
closed and an incident that is searchable are never two different facts.

It is also rebuilt rather than migrated. `reconcileSearchIndex` runs at boot
and indexes every RESOLVED or CLOSED incident the table does not have, which
does two jobs: it backfills a history older than the table, which matters
because `schema.sql` runs over a **restored snapshot** and the first boot
after this shipped found an empty index and a full corpus; and it repairs
anything a transition failed to write, which keeps the per-transition index a
fast path rather than the only one.

Not an external-content table. External content keys on `rowid` and
`incident.id` is `TEXT`, and a trigger-maintained index would have to survive
being created over a database that already has rows.

Raw text cannot reach `MATCH`. FTS5 reads `:` as a column filter, `*` as a
prefix and an unbalanced quote as a syntax error, so a model-written sentence
throws rather than searching. `toMatchQuery` quotes every surviving term,
which leaves no operator reachable from the input.

A quoted term is a **phrase, not a literal**: the query runs through the same
tokenizer as the corpus, so `"connection_pool"` becomes the two-token phrase
`connection pool` and matches either spelling in the indexed text. That is
why the term split keeps underscores — an identifier stays one phrase, which
asks for adjacency, where splitting on the underscore would widen it to every
incident that merely said "pool". Read as a literal instead, the expression
looks like it should match nothing, and it has been reported as a bug on that
reading more than once.

## `schema.sql` at runtime

It is read from `__dirname` at boot, and `tsc` copies no non-TypeScript
files. The Dockerfile copies it next to the compiled `db/index.js`. Without
that the container starts and dies on its first query.
