# Reference root cause: eCanvasser sync times out at the gateway

Source: incident 2, fixed by omni PR #2153 (merged by a human). The judge sees
this file. The agent never does.

## What users saw

A candidate opens the door-knocking page, which syncs their eCanvasser
integration with `force: true`. For campaigns with a large door-knocking
backlog the spinner runs for about two minutes and then shows "Couldn't sync
interactions". Retrying pays the whole cost again, so it fails the same way.

## Mechanism

`POST /v1/ecanvasser/:id/sync` does three things in one request:

1. Fetches contacts, houses and interactions from the eCanvasser API.
2. Writes them in one transaction and stamps `lastSync`. This commits.
3. Runs door-knock attribution **inline**: for every interaction not already
   attributed, one People-API (Databricks) voter lookup by phone, serially, at
   about 800 ms each.

Step 3 is unbounded. A campaign with a few hundred to a few thousand
unattributed interactions needs minutes to tens of minutes. The load
balancer's idle timeout severs the connection at about 120 s. gp-api then logs
the request with no status code (`statusCode: null`, `responseTimeMs` near
120000), which is exactly what the `ecanvasser-route-errors` rule counts. The
handler keeps running after the caller is gone.

The sync's data was never at risk: the transaction commits before attribution
starts. The failure is that the caller never gets an answer for work that
succeeded.

Only matched interactions are recorded, and in practice nearly every lookup
matched nobody (`matched=0`), so the unattributed set never shrinks and every
sync walks the same backlog again. The behaviour is chronic, not a regression.
The alert is new only because the controller recently gained an owner, which
enabled its rule.

## What counts as a fix

Anything that makes the sync request answer inside the gateway window for a
large backlog, without losing the sync's data. The merged fix bounds
attribution with a deadline (stop starting lookups 45 s into the request,
which leaves room for one slow 60 s Databricks statement) and resolves pro
access once per call rather than per interaction. Equally valid: batching the
lookups, moving attribution to a background job, or recording negative
outcomes so the backlog drains.

## What a good investigation shows

- The failing lines are null-status completions clustered at about 120 s, on
  a few large campaigns, not every sync.
- Traces or logs show hundreds of serial voter lookups inside one sync.
- The fix is verified after deploy by the absence of null-status sync
  completions over a window long enough to include large-campaign syncs, not
  by the alert going quiet.

Not the cause: eCanvasser API latency, the database, or the transaction
timeout.
