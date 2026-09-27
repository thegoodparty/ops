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
snapshot. **There is no migration runner.**

- **Columns** can be added freely.
- **`CHECK` constraints cannot.** SQLite has no `ALTER TABLE ADD CHECK`, so
  adding one needs a table rebuild that does not exist here. The cross-field
  constraints landed while the database was empty; that window closed the
  moment real data existed.

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
which makes each a literal token and leaves no operator reachable from the
input.

## `schema.sql` at runtime

It is read from `__dirname` at boot, and `tsc` copies no non-TypeScript
files. The Dockerfile copies it next to the compiled `db/index.js`. Without
that the container starts and dies on its first query.
