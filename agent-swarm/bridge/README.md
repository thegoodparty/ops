# agent-swarm bridge

Grafana's alert notifications become agent-swarm incidents. Grafana posts a
notification to `POST /grafana`; this service verifies it, drops resolved
alerts, dedups on the alert fingerprint, assigns an incident number to each new
alert, and creates one agent-swarm task carrying the whole alert.

## Environment

- `GRAFANA_WEBHOOK_SECRET` (required): HMAC-SHA256 key for the signature. Missing rejects every delivery.
- `GRAFANA_BASIC_AUTH_PASSWORD` (optional): expected Basic password, defaults to `GRAFANA_WEBHOOK_SECRET`. Username ignored.
- `AGENT_SWARM_API_KEY` (required): bearer token for the agent-swarm API. Falls back to `API_KEY`.
- `AGENT_SWARM_API_URL` (optional): base URL, default `http://api:3013`.
- `STATE_FILE` (optional): seen-set and incident counter, default `/state/seen.json`.
- `DEDUP_TTL_HOURS` (optional): how long a fingerprint stays deduped, default 12.
- `PORT` (optional): listen port on `0.0.0.0`, default 3014.

## Contract enforced

`POST /grafana` takes the raw Grafana body, an object with an `alerts` array or a bare array.
It requires `X-Grafana-Alerting-Signature` (hex HMAC-SHA256 over `"<timestamp>:<rawBody>"`),
`X-Grafana-Alerting-Timestamp` (Unix seconds, within 300 seconds of now), and HTTP Basic auth
checked against the password only. Bodies are capped at 1 MiB. `GET /health` returns
`200 {"ok":true}` with no auth; `GET /` is 404. Verification fails closed: no secret means no
delivery is accepted.

## Dedup and incident numbers

Each unique fingerprint (Grafana's `fingerprint`, or a hash of labels plus the summary) maps to
one incident number, starting at 1. The bridge owns that counter and stores it beside the
seen-set. A new fingerprint creates a task tagged `incident`, `incident:<n>`, and `alert`. A
repeat inside the TTL creates no task; it is recorded as a note and, best effort, steered into
the existing task. A resolved delivery is dropped. If task creation fails, the fingerprint is
not recorded and the endpoint returns non-2xx so Grafana retries.

## Limits

Numbering is per instance and resets if the state file is lost. Nothing reports completion back
to Grafana. Resolve messages are dropped, never forwarded. Dedup is per instance, so two
replicas would each open their own incidents.
