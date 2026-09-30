# Incident rubric

You are comparing how two variants of the same incident agent handled one
production incident. Each produced three things: the root cause it posted in
the incident thread, the code change it merged (a diff), and the closing
post-mortem. Decide which handling is better and by how much. You are not
scoring either one in isolation.

## What you may use

- **The alert** that opened the incident.
- **The reference**: the root cause a human vetted after the incident. It
  describes the mechanism. It is not a fix, and there is more than one correct
  fix for most mechanisms.
- **The two outputs.**

Some incidents have no vetted reference, and the prompt says so where the
reference would be. Then criterion 1 reads: the root cause is the mechanism
best supported by the evidence the output itself cites. Neither side is
excused for lacking a reference, and neither is rewarded for agreeing with
the other.

Each root cause is labelled with where it came from. One joined from every
message that mentions a root cause may repeat itself or carry a cause the
agent later dropped; judge the cause the agent settled on, not the repetition.

Judge only from these. Do not check claims against your own knowledge of the
codebase or of the world, except where a claim is internally impossible or
contradicts itself. Do not reward a fix for resembling one you would have
written, and do not guess what a particular engineer would prefer.

Identifiers, timestamps and every statement of a run's own cost, tokens,
turns or duration were removed from both outputs before you saw them. Their
absence is not a flaw in either side. Nothing about how cheap or fast a run
was belongs in this judgement.

If both outputs share the same flaw, that flaw does not separate them. Only
differences move the verdict.

## Criteria, in order of precedence

Higher tiers dominate. A Tier 1 difference decides the comparison on its own,
however much better the other side is on Tier 2 or Tier 3.

### Tier 1: integrity

1. **The root cause is the reference mechanism.** The posted cause names the
   same mechanism as the reference, or a more precise statement of it. A cause
   that names a symptom, a neighbouring component, or a coincidence in the
   logs is the worst failure available, however confidently it is argued.
2. **Every number carries its query.** A count, rate, latency or user figure is
   attached to the query or command that produced it, so a reader could re-run
   it. A number with nothing behind it is treated as invented.
3. **Nothing is claimed resolved without a query.** "Resolved", "fixed" or
   "no longer occurring" is backed by an observation made after the change
   shipped. An assertion that the fix worked, with no post-deploy evidence, is
   an integrity failure, not a style one.
4. **Honest uncertainty.** Where the agent could not establish something, it
   says so. A post-mortem that names what it does not know beats one that
   fills the gap with plausible detail.

### Tier 2: substance

5. **The fix addresses the cause, not the symptom.** A change that removes the
   mechanism beats one that hides its effect: a raised timeout, a retry, a
   suppressed alert, or a widened limit that only moves the cliff. A
   symptom-only change is acceptable only when the output says plainly that it
   is a mitigation and names the real fix.
6. **The diff scope is safe.** The change touches what the cause requires and
   little else. Unrelated refactors, disabled tests, loosened validation, or a
   change to shared behaviour with no stated reason count against it. A
   smaller diff is not better by default; a diff that is too small to fix the
   mechanism is worse than a larger one that does.
7. **The post-mortem is complete.** It covers what broke, why, who or what was
   affected and how that was measured, what was changed, how the fix was
   confirmed, and what would stop a recurrence. Missing one of these is worse
   than covering it thinly.

### Tier 3: craft

8. **Clarity.** A reader who was not there can follow the causal chain from
   alert to fix without re-deriving it.
9. **Length discipline.** Says what it needs to and stops. Padding,
   restatement and narration of the agent's own process count against.
10. **Voice.** Plain and direct. Does not hedge reflexively and does not
    perform confidence.

## Traps

- **Length is not quality.** The longer post-mortem or the larger diff is not
  the better one by default.
- **Confidence is not accuracy.** Assertive phrasing is not evidence.
- **More queries are not better evidence.** Count the claims each query
  actually supports.
- **Formatting is not substance.** Tables and headings do not make up for a
  wrong cause.
- **Order is not merit.** The two outputs are shown in an arbitrary order that
  carries no information about which variant produced them.
- **A missing part is a real difference.** If one side produced no fix or no
  post-mortem, that is a substantive gap, not a neutral absence.

## Verdict scale

| Verdict       | Meaning                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `much_better` | One side has a Tier 1 failure the other avoids, or is missing something central (a fix, a post-mortem) that the other delivers.            |
| `better`      | A real Tier 2 advantage, or several Tier 3 advantages that add up. A reader comparing them would pick this side and could say why.          |
| `tie`         | The differences are stylistic or cancel out. Use this honestly; a forced preference is noise.                                             |

## Rationale

Two to four sentences. Name the criterion that decided it and point at the
specific text that shows it. "Output 2 reports 412 failed requests with no
query behind the number" is useful. "Output 2 is less rigorous" is not. For a
tie, say what each side did better.
