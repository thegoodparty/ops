# triage

Decides what a signal is: attach to an open incident, open a new one, or
suppress it.

## The model is advisory; the rules hold the invariants

`applyRules` is the point of this module. The model proposes; the rules
decide what is allowed. It cannot:

- **Attach across `RESOLVED`.** That is a recurrence, and it gets a new
  incident with `recurrenceOf` pointing at the one whose ground it reopened.
- **Attach to an incident that is not open.** `CLOSED` and `MERGED` take
  nothing.
- **Suppress a cause the alert did not declare.** The alert's own
  `known_causes` annotation must carry a matching id whose action is
  `suppress`. A human report or a `bug_report` is never suppressible at all.

Both of those read the status back **from the database**, not from the digest.
The model has `query_incidents` and can name any id it turns up, so filtering
the candidate list alone would leave the invariant resting on what the model
happened to be offered — and the digest is a snapshot from the start of the
decision, which an incident can resolve, close or be merged away inside. The
`RESOLVED` branch is checked first, so an incident that already claimed the
problem was over produces a recurrence pointer rather than a bare refusal.

## Recurrence is the closed-incident half of the same question

`correlate.ts` compares one incident against the **open** ones. Recurrence
compares one signal against incidents that already claimed the problem was
over. Same shape, opposite end of the lifecycle. It is two mechanisms, split
on whether the answer is a fact or a judgement.

**The fact.** `recurrence.ts` reads `(source, sourceId)` — the dedup key
every adapter must produce, and the key `signal_open_source_idx` is scoped
around, because the delivery proving a resolution was premature is the one
most certain to collide with the signal that resolution closed. A match
inside `RECURRENCE_WINDOW_MS` of that resolution is **conclusive** and is
stamped in code, whether or not the model mentions it and whether or not the
model answered at all. A fingerprint is stable for the life of the rule, so
the window is what keeps January and June apart.

**The judgement.** `search_incidents` (`db/search.ts`, exposed by `sql.ts`)
is FTS5 over the post-mortems, root causes and resolution evidence of
everything RESOLVED or CLOSED. It is a **tool, not a lookup done for the
model**: a search needs a query, only something that has read the signal can
write one, and the same reach has to be available to the incident agent,
which is looking for a third incident nobody pointed it at.

It answers three different ways and they must stay three. Hits are hits, an
empty array is "the corpus has nothing like this", and `UnsearchableQuery` is
"no query was put to FTS5 at all" — which is what a sentence made entirely of
stopwords reduces to. Collapsing the third into the second is the worst of
the three, because the caller is deciding whether a problem is new and an
empty array reads as a confident no.

There is deliberately **no `alert_slug` key**. It looks like a cheap
widening and is not one — it is an optional label, one rule covers many
instances, and it is structurally blind to the case worth catching: the same
cause returning through a *different* alert. Nothing keyed on the alert can
see that. The search can.

What the search misses that a person would not: different vocabulary for the
same mechanism. "Connection pool exhausted" and "too many clients already"
share no stem, and porter stemming does not bridge synonyms. That is the gap
embeddings would close and the reason not to reach for them yet — a wrong
answer here can be explained by reading the query, which is worth more than
recall at this corpus size.

`toMatchQuery` is not decoration. FTS5 reads `:` as a column filter, `*` as a
prefix and an unbalanced quote as a syntax error, so raw model text **throws**
rather than searching. Every surviving term is quoted, which leaves no
operator reachable from the input. A quoted term is a phrase rather than a
literal — it is tokenized like the corpus, so an identifier such as
`connection_pool` matches that spelling and `connection pool` both. See
`db/CLAUDE.md`.

The result is a **new incident carrying `recurrenceOf`**, never a reopen.
`resolvedAt` and `closedAt` are the numbers a recurrence falsifies, and two
`CHECK` constraints mean a reopen can only clear them.

## One guard, and it is the stronger one

`prepareQuery` used to have a twin in `slack/agent.ts`, against the same
database, with different answers. That one allowed `EXPLAIN`, blanked string
literals and comments before checking anything, and scanned nineteen write
keywords. This one allowed neither `EXPLAIN` nor any keyword scan, and
checked the raw text.

Neither caller ever saw the other, so what went unnoticed is that the weaker
guard was the one running on every signal, and that checking raw text makes a
semicolon inside a string literal a refusal of a correct query -- which a
model cannot distinguish from a syntax error, so it rewrites a query that was
right.

The checks now read a stripped copy: no string literals, no bracketed
identifiers, no comments. `WITH x AS (SELECT 1) DELETE FROM incident` opens
with `WITH` and an opener check alone passes it, which is what the keyword
scan is for.

It returns an error rather than throwing, and that is the half worth keeping
from this side. Both callers hand the answer straight back to the model as a
tool result; a throw would have to be caught at every call site to become the
same thing. Containment was never what either guard was for -- `Db`'s read
connection is opened read-only, so a write fails at the driver regardless.
This is about handing a model a sentence it can act on.

## A dead model must not look like a healthy one

Both fallbacks (`triage.ts`, `correlate.ts`) alarm and carry a **rate**, not
just the event. A wrong model id or sustained throttling makes every signal
fall back to `new_incident`: no dedup, no attach, no suppression. Fifteen
alerts then open fifteen incidents, start fifteen agents and trip the
circuit breaker — and the system looks busy and productive throughout.

Correlation's fallback returns `merges: []`, which is byte-identical to
"compared everything and found nothing", so its alarm carries the candidate
count.

`sustained` needs ≥10 calls and ≥50% fallbacks, so one transient failure
never reads as total failure.

## What a decision cost is part of the decision

`TriageOutcome` carries a `ModelUsage`, and it is filled on the fallback path
too. `applyRules` does not see it: it is a pure function of the model's answer
and has no business knowing the price of one, so `runTriage` owns the
accumulator and stamps it on the way out.

The fallback is the case worth costing. A wrong model id or sustained
throttling makes every signal its own incident, and the same failure that
produces no decision still pays for every request it made trying -- so a
storm reads as busy, productive and free unless the tokens are recorded where
they were spent. They land on the `signal` row; see `db/CLAUDE.md`.

## Reads throw

`sql.ts` helpers throw on a database error rather than returning `null` or
`[]`. A failed read that answers `null` is indistinguishable from "no such
incident" and silently downgrades an attach to a new incident. The caller
already has a fallback path that records *why* it fell back, so an exception
produces strictly better information than a plausible wrong answer.

The one exception is `attachedSignalIds` inside `runCorrelation`, which sits
outside the try block that two other modules rely on never throwing. It gets
its own guard and a distinct event name — a failed read and a failed
judgement are different faults.

## Triage is unbounded in count, and where the bound belongs when it comes

Not built, deliberately — recorded here so the reasoning outlives the
conversation it came from, because the wrong bound here is expensive to
undo.

Triage is one model call per signal. The incident agent has a wall clock and
a turn budget; this path has neither, because a turn cap does not apply to
something that is not a loop. On 2026-09-28 a storm opened 67 incidents in
five minutes, and that is the path it ran down.

Three places the bound could go. Two are wrong:

- **Not at admission.** Refusing a signal is an incident nobody opens, which
  is the one rule this system does not bend.
- **Not on dollars.** A price here is arithmetic over Pi's hardcoded table,
  not a figure anyone was billed — the same reason nothing persists
  `costUsd`. A dollar ceiling enforces a limit against our own drift.

- **At the rate, and it is safe *because the signal is already durable*.**
  `signal.incidentId IS NULL` is the untriaged marker, the orphan sweep
  already retries, and `orphan_backlog` already exists as the series this is
  judged on. So deferring triage loses nothing: a storm becomes a growing
  backlog on instrumentation that already reports it, instead of 67
  concurrent model calls. Nothing new has to be built to watch it. This is
  the same property the incident agent's turn budget rests on — turns are
  durable in the transcript, signals are durable in SQLite, and in both
  cases a restart neither loses the work nor refills the allowance.

**But a limit is the second-best answer.** A storm is correlated by
construction: 67 alerts is usually a handful of causes, and triaging them
one at a time pays 67 times to rediscover that. Batching the signals that
arrive together into one call is cheaper *and* better, because a model
looking at all of them at once sees the correlation that `correlate.ts`
currently has to reconstruct afterwards. It is real work rather than a
config change — the scope of a triage decision moves, so the prompt and the
output schema move with it.
