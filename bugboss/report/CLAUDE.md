# report

The document an incident ends with: every metric the system already holds,
the post-mortem, and what the agent spent, in one PDF attached to the notice
that says the incident closed.

## It fires at CLOSED, not at RESOLVED

The obvious reading of "post the report when the incident resolves" does not
work, because at `RESOLVED` there is no post-mortem to post. The lifecycle is
`INVESTIGATING → FIXING → RESOLVED → CLOSED`; `report_resolved` records that
impact stopped, with evidence, and `report_analysis` is what writes the
write-up — the schema carries a `CHECK` saying a `CLOSED` row has one.

So resolution keeps the short post it already had ("resolved, here is the
evidence, here is what shipped") and the document goes out at close. One
incident, two moments, two different things worth saying.

## A close is one message

The close notice is the file's `initial_comment` on
`files.completeUploadExternal`, so notice and report arrive together.

Both close paths send it from the transition itself: `reportAnalysis` and
`closeIncidentByBoss` call `announceClose` once their write has committed. It
does not wait on the agent exiting or on any later model turn. The notice is
derived from the row (`closeNoticeFor`), so a sweep that publishes for a
container that died mid-close says exactly what the close would have.

Publishing never undoes the close. Every failure is recorded, alarmed and
retried; none propagates.

## Tokens are as of the close

The tokens the report quotes reach the incident row from `rollUpUsage`, which
reads the session file. Every publish rolls up first (`ReportDeps.rollUpUsage`),
the sweep included, because a container that died mid-close may never have
rolled up and a zero reads as a free run. The session syncs to S3 at the end
of each turn, so at close that is everything but the turn that called
`report_analysis` and any after it. The row catches up when the run exits;
the report does not. That gap is the price of the close being one message
sent at the moment it happens.

## Claimed before it uploads, retried when it fails

The claim is an `incident_action` row (`report_published`), written **before**
the upload in one guarded `INSERT`, because two publishers race (the close and
the sweep) and a container that dies mid-upload must stay quiet rather than
attach the file twice.

A failed attempt writes a `report_upload_failed` row and, in the same
transaction, hands the claim back:

- **The first failure** posts the close notice alone, with one line saying the
  report is attaching shortly, and records `report_notice_posted` once Slack
  takes it. Until that row exists every attempt carries the notice as the
  file's comment, so a notice Slack refused is re-sent rather than lost. The
  row is written after the post: a crash in between repeats the notice, which
  beats a close nobody was told about.
- **The sweep** (`publishPendingReports`, on the dispatcher tick) retries
  `REPORT_UPLOAD_RETRY_MS` after the last failure. A retry that succeeds posts
  the file on its own, with no comment, because the notice already went out.
- **After `REPORT_UPLOAD_ATTEMPTS`** the claim is kept, `upload_abandoned`
  alarms, and the thread gets one line saying the report is saved with the
  incident. The attempt limit is also what bounds a row that cannot be
  rendered: reading and rendering failures count as attempts.

The one failure that keeps its claim at once is `UploadOutcomeUnknownError`:
`files.completeUploadExternal` failed without an answer, so the file may
already be in the thread. Retrying it is how one report is attached twice, so
it alarms `upload_outcome_unknown` and stops. A container that dies mid-attempt
leaves the same state, a claim with no outcome, and gets the same answer.

It is a row rather than a column because `db/schema.sql` runs as
`CREATE TABLE IF NOT EXISTS` over a restored snapshot with no migration
runner: a column added to a live table would exist in the file and never in
production. `incident_action` already is the ledger of what happened to an
incident.

## Tokens are the record; the dollar line is an estimate and says so

Bedrock returns tokens. A price is arithmetic we do locally against a table
that goes stale silently when a rate moves, so there is no cost column and
nothing here holds a price list (`docs/architecture.md`). The report prints
both and names which is which: the token table is the record, and the dollar
line is what **Pi** priced the run at as it ran, read back out of the same
session file and labelled `Estimated cost`.

The label is load-bearing, not manners. The figure reaches a document a
person reads months later, and an unhedged number is quoted
back as though somebody had seen a bill. `estimatedCostUsd` is named that on
`ReportRun` for the same reason.

`Cache write (1h)` is its own row because it does not price like the rest of
the write: 2x base input against 1.25x for 5m, and every run here asks for
the long cache (`bedrock/CLAUDE.md`). A re-pricing that only had the total
would understate a run by most of that gap.

`turns` and the estimate come from the session file, so both are simply
missing once it ages out under the S3 lifecycle rule while the row's tokens
survive. Missing renders as "not recorded" — never as zero, which reads as a
free run.

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

## The document is Markdown, then a PDF

`render.ts` writes Markdown and escapes nothing. No Markdown construct swallows
the rest of a document the way Slack's `<…>` swallows the rest of a message,
so a quoted log line renders as itself. The single exception is a table cell,
where a raw `|` silently opens a column and a newline silently ends the row —
`cell()` is the only escaping in the file.

`pdf.ts` lays that Markdown out as the PDF: headings, lists, code blocks and
real tables with a header row, wrapped and paginated, never cut. It is
pdfkit with the PDF standard fonts, parsed by marked's lexer: pure JS, no
headless browser, no font file to ship into the Alpine image. The standard
fonts only encode WinAnsi, and pdfkit draws the wrong glyph for anything
outside it without an error, so `encodable` spells arrows and symbols in ASCII,
strips accents it cannot draw, and prints a visible `?` for anything else.
Both PDF dates are pinned, so the same Markdown gives the same bytes and the
tests compare against a pinned hash.

The notice beside it is mrkdwn, built by `toolapi/announce.ts` under the rules
in `slack/CLAUDE.md`. It skips the Slack client every other post goes through,
so the composition root runs it through the incident-reference pass itself.

## The thread is short; the document is complete

Every path into an incident thread is capped at `THREAD_PROSE_CHARS` and
refuses a longer post (`slack/CLAUDE.md`). This document is exempt by never
being thread text: it is a file, so the thread stays short by the long
version being somewhere else. `report_analysis`'s `postmortem` is therefore
the one model field with no cap on it.

## Why a PDF

Slack previews it inline on a phone, keeps it downloadable, and it renders
the tables and headings mrkdwn has no way to express. It costs one scope.

**`files:write` is the scope**, it is in `slack-app-manifest.yaml`, and like
every scope there it does nothing until somebody reinstalls the app. Until
then the completion answers `missing_scope`: the notice goes out alone, the
retries fail, and `upload_abandoned` alarms.

## The recorded timeline is the agent's, printed as it recorded it

`incident_timeline_event` rows go under the post-mortem as "Recorded
timeline", oldest first by when each thing happened. The post-mortem is the
closer's account and this is the evidence it was written from, so the two
stay side by side rather than merged. Both close paths get it: the rows are
read at publish time, not carried by `report_analysis`.
