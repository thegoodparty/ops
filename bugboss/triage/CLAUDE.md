# triage

Decides what a signal is: attach to an open incident, open a new one, or
suppress it.

## The model is advisory; the rules hold the invariants

`applyRules` is the point of this module. The model proposes; the rules
decide what is allowed. It cannot:

- **Attach across `RESOLVED`.** That is a recurrence, and it gets a new
  incident with `recurrenceOf` pointing at the one whose ground it reopened.
- **Attach to a human-owned incident.** No agent is coming back to that, so
  signals would pile up unworked. Read from the database rather than the
  digest, because the model has `query_incidents` and can name any id it
  turns up — filtering the candidate list alone would leave the invariant
  resting on what the model happened to be offered.
- **Suppress a cause the alert did not declare.** The alert's own
  `known_causes` annotation must carry a matching id whose action is
  `suppress`. A human report or a `bug_report` is never suppressible at all.

The owner check sits **after** the `RESOLVED` branch deliberately: a
human-owned incident that fires again must still produce a recurrence
pointer. It refuses only on `owner = 'human'`, not on "anything but agent" —
a `null` owner means the row vanished mid-decision, which is a real race
worth alarming on rather than swallowing.

## Recurrence is the closed-incident half of the same question

`correlate.ts` compares one incident against the **open** ones. `recurrence.ts`
compares one signal against incidents that already claimed the problem was
over. Same shape, opposite end of the lifecycle: two indexed reads before the
model call, rendered into the prompt, and the model's pick validated in code.

Two keys, and the stronger one is not the slug:

- **`(source, sourceId)`** — the dedup key every adapter must produce, and the
  key `signal_open_source_idx` is scoped around. The delivery that proves a
  resolution was premature is the one most certain to collide with the signal
  that resolution closed, which is why that index is partial. Always present.
- **`alert_slug`, different `sourceId`** — the same rule on a different
  instance. Weaker: one rule covers many instances, and `alert_slug` is a
  label a rule may simply not carry.

An exact match inside `RECURRENCE_WINDOW_MS` is **conclusive** and is stamped
in code, whether or not the model mentions it and whether or not the model
answered at all. It is a fact about the delivery, not a judgement about the
problem. A fingerprint is stable for the life of the rule, so the window is
what keeps "the same alert in January and again in June" out of it; past the
window, and on every slug-only match, the candidate is offered to the model
and nothing more.

The result is a **new incident carrying `recurrenceOf`**, never a reopen of
the closed one. `resolvedAt` and `closedAt` are the numbers a recurrence
falsifies, and two `CHECK` constraints mean a reopen can only clear them.

## "We did not check" is not "we checked and found nothing"

`findRecurrenceCandidates` throws, like every other read here. `runTriage`
gives it its own guard, outside the one the model call sits in — the same
split `runCorrelation` makes, for the same reason. A failed lookup alarms
(`recurrence_lookup_failed`), renders to the model as
`RECURRENCE CANDIDATES UNAVAILABLE` rather than an empty list, and leaves
`recurrenceChecked: false` on the outcome so `log("placed")` carries it too.
Three channels, because the answer it would otherwise produce is exactly the
answer a working system produces most of the time.

Two outcomes drop a conclusive recurrence on the floor, and neither is quiet:
an `attach` logs (`assign` stamps `recurrenceOf` only on an incident it
creates, so there is no row to put it on), and a `suppress` alarms.

## A dead model must not look like a healthy one

Both fallbacks (`triage.ts`, `correlate.ts`) alarm and carry a **rate**, not
just the event. A wrong model id or sustained throttling makes every signal
fall back to `new_incident`: no dedup, no attach, no suppression. Fifteen
alerts then open fifteen incidents, spawn fifteen agents and trip the
circuit breaker — and the system looks busy and productive throughout.

Correlation's fallback returns `merges: []`, which is byte-identical to
"compared everything and found nothing", so its alarm carries the candidate
count.

`sustained` needs ≥10 calls and ≥50% fallbacks, so one transient failure
never reads as total failure.

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
