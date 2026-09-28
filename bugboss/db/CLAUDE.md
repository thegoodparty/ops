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
- **`CHECK` constraints cannot** be added at all. SQLite has no `ALTER TABLE
  ADD CHECK`, so adding one needs a table rebuild that does not exist here.
  The cross-field constraints landed while the database was empty; that
  window closed the moment real data existed. A constraint you want now is
  refused at the tool instead.

The constraints are there because every invariant in this system was
otherwise a comment plus a hand-written `if`, and three of them turned out
to be reachable.

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
