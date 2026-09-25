# http

Two apps on two listeners: `public.ts` faces the internet through the ALB,
`toolapi.ts` binds loopback for the agent.

## Acknowledge before you work

`POST /grafana` and `POST /slack` do the **synchronous** half inside the
request — verify, and insert the signal rows — then return 200 and run
prefetch, triage and assign afterwards through `settle()`.

The numbers force this. The contact point runs uncapped, triage has a 55s
budget, and placement is sequential, so fifteen alerts is minutes inside one
request. Grafana's webhook timeout and the ALB's 60s idle timeout both fire
long before that, and the retry arrives while the first delivery is still
working. Slack is worse: a three-second ack against a two-minute model run.

`settle()` alarms on rejection, so the deferred half cannot become a new
silent drop.

The synchronous boundary is **verified and recorded**. A failure before it
throws and the route 500s so Grafana retries; a failure after it is
recovered by the orphan sweep, which is unbounded, source-agnostic and
survives a restart — unlike a source's willingness to retry.

## `/health` is deliberately flat

It returns 200 whenever the process is up, and does not check the database.
The container is the only thing serving ingest, so a degraded Boss beats no
Boss: failing this would have ECS replace a task that is losing alerts with
one that cannot take them at all.

The cost is real and worth knowing — a Boss whose writes are halted still
answers 200.

## The loopback API is the agent's only route to state

Bound to `127.0.0.1`, never through the ALB. Bearer token minted per launch.

**The incident comes from the token, then is checked against the path.** A
valid token for incident A aimed at B gets a 403, not a wrong answer. That
containment is the whole story for a process that reads attacker-writable
log lines for a living.

- No token → 401 with a `WWW-Authenticate` challenge
- Wrong incident → 403

## Rejected transitions are 200, not 4xx

A transition the tool API refuses returns HTTP 200 with `ok: false` and a
readable reason. The model reads that as a tool result it can correct;
a 4xx reads as a broken harness. Same for `invalid arguments` from the Zod
schemas.

Those schemas are the trust boundary. The child validates too, but that is
the untrusted side, so validation here is the one that counts.

## Two routes that are not tools

`GET /incidents/:id/directives` is a **non-draining** read on the read-only
connection, because the `contact_human` poll would otherwise destroy
directives it has not read. `GET /incidents/:id/aws-credentials` mints fresh
AWS credentials, because a role session is capped at twelve hours and an
incident can run for a day.
