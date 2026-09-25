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
