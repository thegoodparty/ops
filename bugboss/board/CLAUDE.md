# board

When the status board says anything. What it *says* is
[`slack/board.ts`](../slack/board.ts) — one renderer, three surfaces, and
[`slack/CLAUDE.md`](../slack/CLAUDE.md) covers it.

## There is no scheduler, deliberately

Every merge to ops `main` restarts this container. An in-process cron holding
"next fire at 07:00" in memory therefore fires twice or not at all depending
on when a deploy lands, which is the class of bug this codebase keeps
producing. So nothing here schedules anything.

`sweepBoard` is a sweep, run from the interval in the composition root that
already runs every `tickSeconds` alongside the orphan, thread and report
sweeps. Its whole memory is one row in `board_state`.

Unlike its three neighbours it does **not** run at startup. Those exist to
catch work a restart interrupted; this one only looks at the world, and at
boot the world is still being reassembled — the orphan and thread sweeps are
running, so a board read now is a board about to change. It waits one tick.

## The daily marker is a date, not a timestamp

`board_state.dailyOn` is `YYYY-MM-DD` in the board's own timezone. "Has it
been 24 hours" double-posts on the day the clocks go back and skips a day
when they go forward; "is it still the same day there" does neither.

The zone is `DEFAULT_WORKING_HOURS.timeZone`, **imported** from
`agent/tools.ts` rather than restated. Two timezone constants that drift
apart is a bug nobody finds until somebody is paged at 3am.

The day's slot is used up at the first tick past the hour whether or not
anything was posted. A quiet morning says nothing at all — Swain's call, and
the reason is that a daily all-clear is a message people learn to skim, which
means skimming it on the morning it matters. Marking the day anyway is what
stops an incident opening at three in the afternoon producing a board nobody
asked for; it gets a thread, like every other incident.

## The all-clear is an event, so it has to be true

Fired on the close itself, it flaps: the board empties, an alert lands ninety
seconds later, it empties again, and the message stops meaning anything. So
it waits for the board to have been empty for `ALL_CLEAR_SETTLE_MS` **and**
not to have been empty before. `emptySince` is cleared by any open incident
and `clearAnnounced` keeps it to once per run of empties, both persisted —
because the process that watched the board empty is routinely not the one
still running when the settle period expires.

**"Clear" is zero open incidents, full stop.** An incident parked on a person
for a week keeps the board non-empty, which is the point of a board. Open is
`OPEN_STATUSES`, the same three the dispatcher keeps an agent on.

## The first sight of a board posts nothing

When there is no `board_state` row, the sweep writes one matching what is
there and says nothing. A container started at nine in the morning has not
missed the seven o'clock board, and a board that was already empty before we
looked never *became* clear. Both are schedules this process cannot honestly
claim to have watched come due, and firing them on the first tick after a
deploy is exactly the in-memory-cron behaviour the whole design avoids.

Started *before* the hour, the day is left open, so that morning's board
still goes out.

## An incident with no recorded opening gets no header

`chat.update` replaces a message whole, and the only way to read the original
back is `conversations.replies` at roughly one request a minute. So a thread
whose opening was never recorded is skipped: writing a header without knowing
what is underneath it would delete the alert text somebody is scrolling back
for, which is unrecoverable where a missing header merely looks unfinished.

Every incident opened from here on records its opening as it posts it, so
this empties itself. The ones that predate it are **counted once at boot**
(`threads_without_a_recorded_opening` in `index.ts`) rather than named every
thirty seconds by the sweep that skips them — a known gap rather than an
invisible one.

## Headers are swept, not hooked

A thread's header is rewritten when the text it renders to differs from
`incident_thread.header`. Driven off a comparison rather than a hook at each
transition, which makes it one place instead of six and makes it
self-healing: a header lost to a Slack error, a restart mid-transition, or a
status changed by a path nobody thought about is corrected on the next tick.
The cost is a header up to one tick stale, which for a line people re-read
rather than get notified about is the right trade.

**What it compares is the copy we last successfully wrote**, not Slack's.
Reading Slack's back would be a call per thread per tick to learn nothing.
The drift that choice risks — our record claiming something the message does
not say — is closed at the other end: only an update that returned is
recorded, so a failed one leaves the stored value alone and the next tick
sees the same difference and tries again.

**A closed incident is finalised, then left.** The sweep runs over every
incident that has a thread, not only the open ones, so an incident that
closes gets one last header saying so instead of freezing on "Fixing"
forever — which is a lie, and the kind a thread goes on telling for months.
After that write the rendered text stops changing, the comparison stops
matching, and the thread is never touched again. Nothing is removed at any
point: the header sits above the message the thread opened with.

**At most `MAX_HEADER_UPDATES_PER_TICK` edits per tick.** `chat.update` is
Tier 3, roughly fifty a minute, and it shares the workspace budget with every
post BugBoss makes. Steady state costs nothing, because only a header whose
text actually changed is written — but a mass status change, or the first
sweep after this ships, is a burst. The rest arrive on the next tick, which
costs nobody anything precisely because a header is a reference rather than a
notification. There is no starvation: a header that gets written stops
differing, so the queue drains.

One thread refusing an edit never stops the others, and the whole header
pass is wrapped so that a Slack which will not take edits at all cannot cost
the morning board or the all-clear — those are the two things here that
*are* notifications.

## Order inside a sweep

Posts happen before the writes that record them. A post that lands and a
write that fails re-posts on the next tick, which is noise; a write that
lands and a post that fails is a morning with no board and nothing saying so.
The first case also only arises once `withWrite` has halted, at which point
nothing in this process is working anyway.
