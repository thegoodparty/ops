# testdb

The Postgres an incident agent runs omni's database-backed tests against, and
the guard on the URL that names it.

## Why there is anything here

omni starts a Postgres with testcontainers, which needs a Docker socket.
Fargate has none — no socket, no privileged mode, no Docker-in-Docker — so an
agent could not run 200 of gp-api's 576 test files, and shipped fixes whose
only check was a CI round trip.

A sidecar container in the same task fixes it because containers in one task
share a network namespace: the database is on `127.0.0.1:5432`, and it needs
no host, no daemon and no credential. `deploy/components/bugboss.ts` defines
it; this module is what reads the URL it writes.

## What is refused, and why that is not a fence

`resolveTestDatabase` refuses a URL that is not Postgres, not on loopback, or
whose maintenance database is not `postgres` (omni derives every per-suite
database from that path segment).

None of that constrains an agent. The value comes from the task definition and
nothing an agent can reach writes it. What it stops is a typo in a container
definition pointing fifteen agents' migration replay and
`DROP DATABASE ... WITH (FORCE)` at a real cluster. omni's election-api
harness has held the same guard since long before this existed.

A refused URL is **withheld** from the child environment rather than passed
on. With the variable unset omni goes back to starting its own container and
says so; with a bad one set it would try to use it.

## Isolation is omni's, not ours

Fifteen agents can share this one server, and nothing here arbitrates that.
omni's harness already does: the schema template is named for a digest of the
migrations it holds, each suite clones it into its own `test_db_<hex>` and
drops that in `afterAll`, and a sweep collects what a killed run left behind —
age-gated, so it cannot take a database a live run is using. All of it was
built for "one container serves every checkout on the machine". This task is
that machine.

So nothing here creates or drops a database, and nothing should start. If
isolation is wrong, it is wrong in omni.

## The probe is a TCP connect, and it waits

Postgres runs `initdb` against a unix socket and binds TCP only once it is
ready to serve, so an accepted connection is the readiness signal and a client
library would be a dependency in both images for no further answer.

**It retries to a deadline rather than probing once.** Both containers start
together and Postgres binds last, so at the moment the Boss finishes booting
the port is normally still closed. A single probe there alarms on every cold
deploy, and an alarm that fires during normal operation teaches people to
ignore alarms.

It is started at boot and **not awaited**. The wait is up to ninety seconds,
alert ingest is what this container is for, and nothing downstream reads the
result — it is a log line.

It cannot see a sidecar that dies later, which is why the loud signal an agent
actually meets is omni's, at the moment a suite runs, naming
`OMNI_TEST_POSTGRES_URL` in the failure.
