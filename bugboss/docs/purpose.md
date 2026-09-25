# What BugBoss is for

## The problem

Every Grafana alert lands in `#dev-alerts` and waits for a person. That
person has to notice it, decide whether it is real, work out what it means,
and go and find out. Most of that is repetitive. The part that genuinely
needs judgement is the smallest part, and it arrives last — after someone
has already spent twenty minutes establishing what a machine could have
established in two.

The cost is not mainly the twenty minutes. It is that the alert arrives
while you are doing something else, and the interruption costs more than the
work.

## The goal

**Humans spend zero time handling alerts.**

That is deliberately impossible, and it is the right target anyway, because
every part of the gap between here and there is worth closing. It does not
mean nobody looks at incidents. It means that by the time a person looks,
the investigation is already written down: what fired, what it means, what
was ruled out, what the fix was, and what is still unknown.

Three things follow from taking that seriously:

**An alert nobody sees is worse than an alert that wakes someone.** The
failure mode this system must not have is going quiet and looking healthy.
Its success state and its dead state both look like silence in a Slack
channel, which is why nothing here is allowed to fail invisibly.

**Being wrong confidently is worse than being slow.** An agent that reports
a root cause it cannot evidence has made the incident harder, not easier.
Every claim it makes carries the query that produced it, so a human can
check the answer rather than trust it.

**Nothing auto-closes.** Every incident ends in an outcome a person can see.
The system may decide an alert needs no incident, but it records that it
decided, and who to ask about it.

## What success looks like

The measurements, in the order they matter:

| | |
| --- | --- |
| **Alerts that reached nobody** | Signals that got no incident and no suppression. The number that has to be zero. Computed from `incidentId IS NULL AND closedAt IS NULL` |
| **Time to detect** | `firstSignalAt − impactStartedAt`. Measures the alert rules, not the agents — the one number BugBoss cannot improve by being better at its job |
| **Time to resolve** | `resolvedAt − firstSignalAt`. Heavily right-skewed and uncorrelated with severity, so report percentiles and never a mean |
| **Human minutes per incident** | The actual target. Not yet instrumented |
| **Outcome** | auto-resolved, human-assisted, human-owned, unresolved. Auto-resolved must mean no human input beyond the merge, or the metric flatters itself |

## What it deliberately is not

**Not an auto-remediator.** It opens pull requests and never merges them.
Branch protection enforces that server-side, because the agent runs with a
real shell and a prompt is not a control.

**Not a replacement for on-call.** It is the thing that makes on-call
cheaper. A person still decides what ships.

**Not a chatbot.** Everything happens in an incident thread. There is no
slash command and no dashboard, because a second surface is a second place
to look and the thread is already the record.

## The shape that follows

Two ideas carry most of the design:

**A signal is an immutable fact. An incident is a mutable unit of work.**
Alerts get triaged; incidents get worked. One incident can hold many
signals, and the same alert firing twice is two signals. Keeping them
separate is what makes merge and split expressible at all.

**Status is where the work is. Owner is who has it.** They are orthogonal.
An incident can be `FIXING` and owned by a human: the work is at the fixing
stage, and a person is doing it. Collapsing them would force every reader to
decode ownership out of a status field.

The detail is in [`architecture.md`](./architecture.md).
