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

## `schema.sql` at runtime

It is read from `__dirname` at boot, and `tsc` copies no non-TypeScript
files. The Dockerfile copies it next to the compiled `db/index.js`. Without
that the container starts and dies on its first query.
