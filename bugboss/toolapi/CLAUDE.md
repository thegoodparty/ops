# toolapi

The single writer for incident state, and the agent-facing transitions.

## `assign` is one primitive

`assign.ts` does create, attach, merge and split — they are all the same
operation, re-partitioning signals across incidents. Anything that moves a
signal goes through it, which is what makes the invariants enforceable in
one place:

- Never attach across `RESOLVED`. A signal arriving after a resolution is
  evidence the resolution was wrong, so it belongs to a recurrence.
- Never to a `CLOSED` or `MERGED` target.
- Never to one a human owns — that incident has no agent coming back to it.

`logAssign` is emitted **after** the transaction, never inside it, so a
rolled-back assign leaves no record claiming it happened.

## Guard in the statement

Every transition here had a TOCTOU: read the incident, check it, then write
in a *later* `withWrite`. The write queue serializes behind a synchronous S3
PUT, so the window is hundreds of milliseconds, and correlation can merge an
incident away inside it. The result was a `MERGED` row resurrected to
`FIXING` with no signals — eligible for dispatch forever, and a legal merge
target, which is the only route to a mutual `mergedInto` cycle.

So: **the predicate goes in the `UPDATE`**, and `changes === 0` rejects.

```sql
UPDATE incident SET status = 'FIXING', ...
 WHERE id = ? AND status = 'INVESTIGATING' AND owner = 'agent'
```

`blocked()` stays as the cheap early reject, so the model gets a readable
error, but it cannot hold a transition.

**One exception:** `reportAnalysis` has no owner predicate. A person who
takes an incident over still gets the agent's write-up, which is the whole
reason a takeover winds the agent down rather than killing it.

## The explained-signal gate

Invariant: every attached signal is explained by the incident's root cause.
Enforced at **both** edges of `FIXING`, not just the entrance — a
correlation merge moves signals in with `explained` reset, and triage
attaches across `FIXING`, so an incident can acquire unexplained signals
after the transition that checked them.

The split runs **after** the guarded `UPDATE`. If it ran first and the guard
then matched nothing, the transaction would still commit the splits, tearing
signals off an incident the call never touched.

## Correlation

Triggered by `report_root_cause`, because that is the first moment an
incident has a claim worth comparing. It compares against every open
incident and splits the signals the cause does not account for.

A correlation failure must never cost the agent its root cause: the
transition commits, the merge is skipped, and the decline is logged with the
target's actual status and owner. A silently declined merge is the "one
agent chases two causes and the other has nobody on it" miss the design
names explicitly.

## Notify

`notify()` returns whether it posted. `hand_off` posts **before** it commits
`owner = 'human'` and returns `ok: false` if the post failed, leaving the
incident owned by the agent. The failure modes are not symmetric: a write
that lands with no post means `ELIGIBLE_SQL` skips the incident forever and
nobody was told, which is invisible.
