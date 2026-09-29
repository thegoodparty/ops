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

## Headers are swept, not hooked

A thread's header is rewritten when the text it renders to differs from
`incident_thread.header`. Driven off a comparison rather than a hook at each
transition, which makes it one place instead of six and makes it
self-healing: a header lost to a Slack error, a restart mid-transition, or a
status changed by a path nobody thought about is corrected on the next tick.
The cost is a header up to one tick stale, which for a line people re-read
rather than get notified about is the right trade.

A failed edit is **not** recorded as written, so the next tick retries it,
and one thread refusing an edit never stops the others — or the morning
board, or the all-clear.

## Order inside a sweep

Posts happen before the writes that record them. A post that lands and a
write that fails re-posts on the next tick, which is noise; a write that
lands and a post that fails is a morning with no board and nothing saying so.
The first case also only arises once `withWrite` has halted, at which point
nothing in this process is working anyway.
