# What to watch on Slack

You are about to sit in the incident channel and compare this system to BugBoss.
This is the reference for that watch. It lists every message a single incident
produces, in the order it produces them, with a worked example. It then lists the
three scheduled messages. Every entry says what the message must contain and what
counts as wrong.

The rules behind each message live in
[`../incident-commander.md`](../incident-commander.md). Read that for the shape;
read this for what you should see when it works and what you should write down
when it does not.

## The two systems share a workspace, not a channel

BugBoss narrates into its own channel (`#dev-alerts`). This build narrates into a
second channel, `#swarm-incidents` by default. They are different Slack apps with
different bot identities, because a second system needs its own token or the two
would answer each other's messages (see [`../slack/INSTALL.md`](../slack/INSTALL.md)).

Keep them apart while both run. Do not compare them in one channel. If you point
both bots at the same channel you will not be able to tell which system said what,
and the comparison is over.

| | BugBoss | This build |
| --- | --- | --- |
| Channel | its own alert channel, `#dev-alerts` | its own incident channel, `#swarm-incidents` |
| Bot identity | the BugBoss app | the `Agent Swarm` app |
| Incident numbers | start at 1 | also start at 1 |
| Numbering owner | the database | the Grafana bridge, a small JSON state file |
| Thread header | one line naming the incident, linked | three lines: reference, status and summary, what is needed |
| Status words | `INVESTIGATING`, `FIXING`, `RESOLVED`, `CLOSED`, `MERGED` | the same five words |
| Closing document | a Markdown file uploaded into the thread | a Markdown file uploaded into the thread |
| Board time | 07:00 America/New_York | 07:00 America/New_York |

Both systems number incidents from 1, so "Incident 12" is ambiguous across them.
The channel and the bot are the disambiguator. If you ever quote an incident
number to somebody, say which system.

## One incident, start to finish

The worked example. A real alert fires on `election-api`, the bridge creates
incident 12, and a person merges one pull request in the middle of it.

### The alert

Grafana sends a notification for `election-api 5xx rate above 2% for 10m`,
severity `high`, fingerprint `a1b2c3d4e5`, started 18:34 UTC. The bridge verifies
the signature, drops nothing (the alert is firing), assigns incident number 12,
and creates one agent-swarm task. The task text carries the whole alert plus
`Incident 12`.

Nothing appears in Slack yet. The first message comes from the lead agent.

### 1. The acknowledging reaction

Something on the incident's opening message acknowledges that the alert landed
and work has started.

- **Right:** a reaction appears within seconds to a minute of the alert, on the
  message the agent opens the thread with. It is a receipt, not a status.
- **Wrong:** no reaction at all. The manifest grants `reactions:write` for this
  ("the acknowledging reaction, as BugBoss does"), but the incident-commander
  prompt never asks for one. The reaction is therefore expected and not enforced.
  Record its absence as a gap in the prompt, not as a broken build.

### 2. The thread header, when the incident opens

The first post. Three lines, exactly:

```
*Incident 12* | https://<workspace>.slack.com/archives/C0123456789/p1759170930
*INVESTIGATING* | election-api 502s from pool exhaustion
*Needs:* nothing
```

- **Right:** the reference linked to its own thread, the status word, a summary of
  a few words saying what the incident *is*, and what a person has to do, which is
  the literal word `nothing` when nothing is needed.
- **Wrong:**
  - Missing. An incident with no header cannot be linked to or reported on later.
  - Truncated. A header that drops the `Needs:` line hides the one fact a reader
    scans for.
  - A status or summary that changes every message. The header is posted once and
    stands until the incident's *identity* changes, meaning its summary did.
  - Markdown instead of mrkdwn (`**bold**` instead of `*bold*`).

### 3. The investigation messages and status transitions

The lead investigates without narrating. The first thread message after the header
is a status transition, not a running commentary.

```
*FIXING* | the pool is exhausted because a leaked client holds 25 of 25 connections
Evidence: election-api P2024 count 0 in the 30m before the restart, 412 after. `loki: sum(count_over_time({service_name="election-api"} |= "P2024" [30m]))`
```

- **Right:** one message per transition, two or three lines: the new status, one
  line of why, and the evidence with the query that produced it.
- **Wrong:**
  - A quiet half hour reported as a message. Progress narration is not a
    transition and should not appear.
  - A transition with no evidence. Every number must carry the query that produced
    it, or `EVIDENCE UNAVAILABLE` if the query failed. An empty result that reads
    as "we checked and found nothing" when the check never ran is the failure this
    rule exists to catch.
  - Duplicated transitions: the same status posted twice because a restart
    replayed the step.
  - A skipped state. `INVESTIGATING` to `FIXING` to `RESOLVED` to `CLOSED`, never
    backwards, never jumping.

### 4. The question, when it is waiting on a person

When the fix is a pull request a person has to merge, the lead asks and then waits.

```
*Needs:* a person to merge PR #2196
The fix is green and every non-skipped check passes at the merge commit. Nothing else is blocking.
```

- **Right:** a question posted in the thread, `waitingFor` set to one line, and the
  header or a fresh post carrying that same line. The incident stays open and
  stays the agent's.
- **Wrong:**
  - The ask with no `waitingFor`, so the board and the header show `nothing` while
    the agent is in fact blocked.
  - The incident handed to a person. There is no hand-off in this design. A person
    is something the incident waits on, never something it is given to.
  - Silence while blocked. Parked work must say so out loud, because silence is
    indistinguishable from a working week.

### 5. The resume, when the reply arrives

A person replies in the thread that they are merging. Any reply ends the wait.

- **Right:** the wait clears, the agent carries on, and what follows is reported
  as its own transition or note. The merge is confirmed before the incident moves
  on.
- **Wrong:**
  - The reply does not end the wait, so the incident stays parked while the person
    waits for the agent.
  - The wait ends on a message that was not for the agent (two people talking to
    each other in the thread). BugBoss reads who a message was for; check whether
    this build does the same or ends the wait on any reply.
  - No message at all after the reply, so the person cannot tell whether the merge
    was seen.

### 6. The pull request notice

The agent opens a pull request and says so in the thread, naming the PR.

- **Right:** a line in the thread naming the pull request and linking it, before or
  alongside the ask to merge it.
- **Wrong:** silence. The incident-commander prompt records every PR in the
  incident's `prUrls` but defines no dedicated message shape for opening one, so
  this is the message most likely to be missing. If you see a resolution that
  names a PR the thread never mentioned, write it down.

### 7. The resolution, with evidence

```
*RESOLVED* | the leaked client fix is deployed and the 5xx rate is back under 2%
Evidence: election-api 5xx rate held below 0.3% for 40m, longer than the 10m window that fired. 2 further signals, both quiet.
```

- **Right:** `RESOLVED` means no users are affected any more and no further alerts
  should occur, confirmed by what was observed, not by what the fix is believed to
  do. The quiet window is longer than the alert's own firing window and the window
  is stated.
- **Wrong:**
  - "The alert stopped" offered as evidence with no window, or a window shorter
    than the alert's own firing interval.
  - Resolved while a person is still needed, or resolved with no evidence line.
  - A green check on an older commit offered as proof. Check the commit.

### 8. The closing post-mortem, as an uploaded file

The document is a Markdown file uploaded into the thread. A short message sits
beside it.

```
*Incident 12 closing report* | <file link>
300 users affected over 41 minutes. Resolved in 1h 12m from the first signal.
1 PR merged, 4 agent launches.
Cause: a leaked database client held every connection in the pool.
```

The file has these sections, in this order: `What fired`, `What it meant`, `What
was ruled out`, `The fix`, `Still unknown`, `Timeline`.

- **Right:** a real uploaded file, not thread text. A short message beside it that
  a person can read without opening the file. `CLOSED` set only after the document
  exists.
- **Wrong:**
  - The document as thread text instead of a file. The prompt says the one
    uncapped document is the file; a wall of thread text is the wrong shape.
  - `Still unknown` missing. It may say nothing is unknown; it may not be absent.
  - `What was ruled out` with no evidence for each ruled-out cause.
  - The file not found. The upload reads the file from the API server, which
    shares only `/workspace/shared/`, so a `/tmp` path produces a closing message
    with no document behind it.
  - `CLOSED` with no post-mortem. The KV store has no constraint that stops this,
    which is one of the places this build is weaker than BugBoss.

## The scheduled messages

Three jobs run between alerts. Each arrives as a task the lead executes. All three
post into the incident channel. They are seeded by
[`../seed.sh`](../seed.sh) and described in `incident-commander.md` under "Between
incidents: the scheduled jobs".

### The 07:00 board

Runs at 07:00 America/New_York. One line per open incident:

```
*Open incidents* | 2026-09-29 07:00 ET

• <link|Incident 12> | *FIXING* | election-api 502s from pool exhaustion | needs a person to merge PR #2196
• <link|Incident 7> | *RESOLVED* | nightly sync stopped at the first failed page | nothing
```

- **Right:** one line per open incident, ordered by number ascending, each with a
  link, a status, a summary, and what is needed (`waitingFor` or `nothing`). A
  closed or merged incident never appears.
- **Wrong:**
  - Missing on a morning when something is open. The healthy state of this system
    is silence, so a board that fails to post looks like a clear board.
  - Posted when nothing is open. If nothing is open, the board posts nothing; the
    all-clear has its own job and the two must not both fire.
  - `board:index` and the incident keys disagreeing and the board rendering the
    smaller set silently. A board that hides a discrepancy is worse than no board.
  - Truncated to a count without the per-incident lines.

### The all-clear

Runs hourly. It says once that the last open incident closed and stayed closed,
then stays quiet.

```
*All clear* | no open incidents as of 2026-09-29 14:00 ET
The last one was incident 12, closed 2026-09-29 09:41 UTC.
```

- **Right:** posted only when the open count reached zero on a date earlier than
  today and that clear period has not already been announced. Two date keys, never
  timestamps, are what make running hourly safe.
- **Wrong:**
  - Posted twice for one quiet period, from a restart or a clock change. This is
    the exact failure the date-based rule exists to prevent.
  - Posted an hour after the last incident closed. One quiet hour is not "stayed
    closed".
  - Missing entirely when the system does go clear, so the channel never learns the
    incident ended.

### The stale nudge

Runs every four hours. For any open incident whose `updatedAt` is more than 24
hours old, a nudge in that incident's own thread, plus one summary line in the
channel.

```
*Nudge* | nothing has changed on this incident in 26h.
Last update: 2026-09-28 13:10 UTC. Status is FIXING, waiting on nothing.
```

- **Right:** the age, the last update time, the status, and what it was waiting on,
  in the incident's own thread, then a channel line naming how many are stale and
  which. No incident state changes.
- **Wrong:**
  - Missing on an incident that has sat untouched for most of a day. This is the
    failure mode that looks exactly like success, and it is the one this job
    exists for.
  - A nudge that changes state. A nudge is a report, not a transition.
  - The channel summary without the thread nudges, or the nudges without the
    channel summary. A reader must see it without opening a thread, and the thread
    owner must see it in place.
  - Posted when nothing is stale.

## What counts as wrong, in one list

For any message, the four failure shapes to record:

- **Missing.** The message never appears. Because the healthy state and the dead
  state of this system both look like silence, this is the failure that matters
  most and is easiest to miss.
- **Truncated.** The message appears with a required part cut: a header with no
  `Needs:` line, a transition with no evidence, an ask with no `waitingFor`, a
  post-mortem missing `Still unknown`.
- **Duplicated.** The same message appears twice for one event, usually after a
  restart replaying a step. The board and the all-clear are the usual sites.
- **Silent.** The work happened and was never announced: a PR opened with no
  notice, a wait cleared with no resume, a failed tool call never mentioned. The
  prompt calls this out as the rule most likely to be broken and the one the whole
  system depends on.
