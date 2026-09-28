# report

The document an incident ends with: every metric the system already holds,
the post-mortem, and what the agent spent, in one file in the incident
thread.

## It fires at CLOSED, not at RESOLVED

The obvious reading of "post the report when the incident resolves" does not
work, because at `RESOLVED` there is no post-mortem to post. The lifecycle is
`INVESTIGATING → FIXING → RESOLVED → CLOSED`; `report_resolved` records that
impact stopped, with evidence, and `report_analysis` is what writes the
write-up — the schema carries a `CHECK` saying a `CLOSED` row has one.

So resolution keeps the short post it already had ("resolved, here is the
evidence, here is what shipped") and the document goes out at close. One
incident, two moments, two different things worth saying.

## Publishing is a notification, never part of the transition

By the time anything here runs, `reportAnalysis` has committed and the agent
has exited. There is no state to roll back and nothing useful to retry into,
so **every failure below degrades and alarms** rather than propagating. A
failed upload posts the whole report as thread text instead; a thread that
will not take the text alarms and stops. The incident is closed either way.

## Why it runs after the agent, not inside the tool call

The tokens the report quotes reach the incident row from `rollUpUsage`, which
reads the session file **after the child exits**. At the moment
`report_analysis` returns, the row still holds the previous launch's numbers —
or zero for a first launch. So the composition root publishes from the launch's
`finally`, after roll-up, and `publishPendingReports` sweeps up the incidents
whose container died in between. Nothing relaunches an agent on a `CLOSED`
incident, so without that sweep a badly-timed restart loses the report for
good.

The sweep waits out `REPORT_SWEEP_GRACE_MS` before touching anything, because
an incident that closed seconds ago still has roll-up in flight and a report
published ahead of it would quote zero tokens.

## Published once, marked before it posts

The marker is an `incident_action` row (`report_published`), written **before**
the upload, in one guarded `INSERT` — the same shape `contact_human` uses for
its question, and for the same reason: a container that dies mid-post must
stay quiet rather than post twice on the way back up. Two publishers do race
in normal operation (the launch's `finally` and the tick's sweep), and the
write queue plus the `NOT EXISTS` predicate inside the statement is what
orders them.

It is a row rather than a column because `db/schema.sql` runs as
`CREATE TABLE IF NOT EXISTS` over a restored snapshot with no migration
runner: a column added to a live table would exist in the file and never in
production. `incident_action` already is the ledger of what happened to an
incident.

## Tokens and the model are the record; dollars are derived

Pricing moves, so a stored dollar figure is a guess frozen at write time while
tokens plus `modelId` multiply out correctly whenever anyone asks
(`docs/architecture.md`). The report prints both and says which is which: the
token table is the record, and the dollar line is what **Pi** priced the run
at as it ran, read back out of the same session file. Nothing here holds a
price list, and `costUsd` on the incident row stays unwritten.

`turns` comes from that file too, so both are simply missing once it ages out
under the S3 lifecycle rule while the row's tokens survive. Missing renders as
"not recorded" — never as zero, which reads as a free run.

## It is the only reader of the recurrence answer

An incident that came back closes on a question its first report could not have
asked: which kind of failure the last resolution was, why it did not hold, and
what was done about *that* rather than about the symptom. `report_analysis`
refuses to close a recurrence without one, and until the report existed nothing
read it back. The category is stored as a slug because the set is closed on
purpose, and rendered as a sentence because a reader should not have to know the
set -- least of all for the one that says the defect is in BugBoss.

An answer whose JSON will not load leaves the section in place saying so. A
section that quietly vanished would read as an incident that never recurred.

## Two texts, two escaping rules

This is the trap, and it is why rendering is one file with the rule at the top
of it. The same root cause string goes down both paths:

- **The document is Markdown.** Nothing is escaped. No Markdown construct
  swallows the rest of a file the way Slack's `<…>` swallows the rest of a
  message, so a quoted log line renders as itself. The single exception is a
  table cell, where a raw `|` silently opens a column and a newline silently
  ends the row — `cell()` is the only escaping in the file.
- **The thread summary is mrkdwn**, and goes out under the rules in
  `slack/CLAUDE.md`: values through the `mrkdwn` tag, model prose through
  `toMrkdwn`.

On the degraded path the document is posted through `postProse`, which is the
Markdown-to-mrkdwn conversion plus the length split — so the headings and
tables that read correctly in the file still read correctly in the thread.

## The thread is short; the document is complete

Every other path into an incident thread is capped at `THREAD_PROSE_CHARS` and
refuses a longer post (`slack/CLAUDE.md`). This document is the one thing
exempt, and the exemption is structural rather than a bigger number: the report
does not go out as thread text at all, it goes out as a file, so the thread
stays short by the long version being somewhere else. `report_analysis`'s
`postmortem` is therefore the one model field with no cap on it.

The degraded path is the single case where the document does land in the thread
as text, and it posts through `postDocument` — which does nothing `postProse`
does not, and exists so that one exemption is a name at a call site rather than
the absence of a check.

The thread summary beside the file answers to the budget like any other post,
which is what `SUMMARY_CAUSE_CHARS` is for: one line of cause, the numbers a
person scanning the channel wants, and everything else in the file.

## Why a Markdown file

Slack previews it inline, indexes the text for search, and leaves it
downloadable, and it costs one scope. A canvas renders more richly but is a
larger API surface with nothing to download; a PDF means a rendering
dependency in a container that has none and is not searchable in Slack; a long
message is the thing this replaces — mrkdwn has no headings and no tables, and
thread posts are deliberately short because the reader is on a phone.

The summary rides along as the file's own message, so the thread still reads
without opening anything.

**`files:write` is the scope**, it is in `slack-app-manifest.yaml`, and like
every scope there it does nothing until somebody reinstalls the app. Until
then the upload throws `missing_scope`, which alarms and posts the report
inline.
