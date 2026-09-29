# agent

The incident agent: a Pi session running in a child process, against
Bedrock, with a fresh checkout of omni.

## What it is allowed to do

It opens pull requests. **It never merges one.** The prompt says so to save
it turns, but the actual controls are branch protection on `main` and the
GitHub App's permissions — it runs with a real shell, so a prompt is not a
control.

In AWS it runs on the Boss's own identity, resolved through the container
credential provider, which refreshes itself for as long as the run lasts.
Nothing inside the container separates the two, so what limits an agent is
what the task can reach at all — no database, no release path.

GitHub is different. It gets the App's **credentials**, not a token minted for
it, and re-mints every twenty minutes. Installation tokens last an hour and an incident can
run for a day, so a token handed down at launch would expire
mid-investigation and surface as `gh` refusing to push a branch the agent
had already built.

What that token may do is [`../github-app.md`](../github-app.md), which is the
GitHub counterpart to the checked-in Slack manifest. Read it before assuming
a capability: the App is installed org-wide with `contents: write`, so the
token reaches every repository in the organisation and not only omni. The
prompt used to say otherwise and was wrong.

## The Grafana MCP surface is bounded twice, in code

`mcp.ts` exposes mcp-grafana, which ships ~80 tools, and fifteen agents can
hold it at once. On 2026-09-28 a third of all Loki read volume was ad-hoc MCP
queries — 2.06 TB/day from 130 of them, single 30-day reads at 54-149 GB. So:

- **`GRAFANA_READ_TOOLS` is the surface.** Reads only: Loki, Prometheus,
  Tempo, datasources, dashboards. Alert-*rule* reads are absent because
  mcp-grafana v1.6.1 puts reading and creating a rule in one tool
  (`alerting_manage_rules`); the firing alert already arrives through
  `ingress/grafana.ts` and the rules are checked into omni.
- **`GRAFANA_MCP_ARGS` tells the server the same thing**, and is the weaker
  half: `--enabled-tools` is category-granular, so tool names in it disable
  everything. `--disable-write` and `--disable-api` do the real work there,
  and `--loki-guardrail-*` catches what our clamp cannot — a range-vector
  duration inside the query, `count_over_time(…[30d])` in a 6h window.
- **A dropped tool is `log`, a missing one is `alarm`.** The flag over-delivers
  by design, so the filter dropping something is normal. An allowlisted tool
  the server no longer lists is a capability that vanished — a rename, a
  version bump — and nothing else in the run would mention it.
- **The time range is clamped in `execute`, not asked for in the prompt.**
  `DEFAULT_LOOKBACK_HOURS` 6, `MAX_LOOKBACK_HOURS` 24, and a widened request is
  rewritten *and* announced in the tool result, because an agent that thinks it
  read a month and read a day reports a negative on evidence it never had. The
  argument names come from each tool's own `inputSchema`
  (`startRfc3339`/`endRfc3339`, `startTime`/`endTime`, `start`/`end`); a shape
  not in `TIME_RANGE_SHAPES` is not clamped, so adding a tool to the allowlist
  means adding its shape in the same change.

There is no output cap to help with any of this, and there never was one that
did: a cap bounds bytes returned, and Loki bills bytes scanned. Results now
arrive whole and Pi compacts the conversation to make room — see "Nothing
truncates a tool result" below.

## Two bounds, and the turn budget is the one that measures work

The wall clock bounds how long a launch may run. It does not bound what the
run does: `monitor` and `contact_human` each cost **one turn** however long
they block, so the first nine-hour incident spent about eight of those hours
inside a single turn waiting on a person. 92 turns, $18.51, against a
24-hour deadline that fifteen agents could each have spent in full.

So there is a second bound in turns — `INCIDENT_AGENT_MAX_TURNS`, 200,
overridable by `BUGBOSS_MAX_TURNS` — and three things about it matter:

- **It is counted over the incident, not the process.** Every merge to ops
  `main` restarts this container, so a budget that started from zero on each
  launch would bound nothing. `createTurnBudget` is seeded from
  `sumSessionUsage` over the restored transcript, which counts assistant
  messages — the same unit `turn_end` fires on.
- **It announces and parks; it does not just stop.** Same two layers as the
  deadline: at `maxTurns - TURN_BUDGET_GRACE_TURNS` the blocking-tool abort
  fires and the model is steered to write a brief, and at `maxTurns` the
  harness does it on the agent's behalf. Two calls, and only one of them is
  optional. `escalate` is the announcement and is skipped when the agent
  already escalated inside its grace. **`park` is not skippable.** Nothing
  else stops the dispatcher relaunching, and a relaunched agent is instantly
  over budget again, so without it the run escalates, stops, relaunches and
  escalates every tick — the hot loop `park` exists for, named in its own
  doc comment in `types.ts`. Announcing is what a person sees; parking is
  what makes it stop.
- **The agent escalating itself wins the announcement.** The steer asks for
  exactly that and the model can answer on its very last grace turn, which
  ends the same `turn_end` the cap fires on. The budget watches
  `toolResults` for a successful `escalate`, because both posting puts "it
  never wrote a brief" directly under the brief it just wrote. A *refused*
  escalation does not count — nobody was told, which is the case the
  harness exists for.
- **The grace is clamped to half the budget.** `TURN_BUDGET_GRACE_TURNS` is
  a constant and `maxTurns` is settable, so the two configure into nonsense
  at small budgets: unclamped, `BUGBOSS_MAX_TURNS=10` puts the soft edge at
  turn 0 and the agent is told to wrap up before it has done anything, with
  nine turns left unused. The clamp is on the grace rather than a floor
  under `maxTurns`, because a small budget is a legitimate ask and the
  honest reading of it is "wrap up sooner". `TurnBudgetState.graceTurns`
  carries what was actually given, so the brief cannot quote a window nobody
  had.
- **The park is the stop, and it opts out of lifting on a reply.**
  `ToolApi.park` defaults `liftsOnReply` to true, which is right for a wait
  on a person and wrong for this one: a reply is not news about having run
  out of turns. Without `liftsOnReply: false` every comment on the thread
  woke an agent that was over budget before it started, stopped again, and
  paged the rotation. The argument is in `turnBudgetPark` rather than at the
  call site so a test fails if it is dropped.
- **The announcement is suppressed only when the agent already made it.**
  `shouldAnnounceExhaustion` is `!state.escalated` and nothing more. There
  was a second arm for a launch that began over budget, and it was treating
  the wake rather than preventing it; once a budget wait survives a reply
  the wake does not happen. Nothing lifts a budget wait now: the stale sweep
  reads `liftsOnReply` too, so it announces one and leaves it standing
  rather than relaunching an agent that would exhaust before its first turn.
  Suppressing here as well would only take away the saying-so, and an
  incident a day quiet and still out of turns is exactly what should be said
  out loud.
  The brief says plainly that replying will not restart it, because it will
  not — raising `BUGBOSS_MAX_TURNS` or taking the work over is what
  continues it.
- **The brief carries what the run spent.** Turns, tokens and a cost
  estimate, because shipping 200 before a dollar cap is only worth anything
  if somebody learns what 200 turns costs. It is called an estimate there
  too.

**This is not the Slack agent's budget.** `SLACK_AGENT_MAX_TURNS` is 24 and
ends by posting that the run is out of steps, which is right when a person is
waiting in a thread for an answer. Nobody is watching an investigator, so its
ending is an escalation and a park. Same mechanism, different number,
different last act — the names say which is which so the next change picks
the right one.

`turn_end` cannot stop the loop. Pi reads a boundary result's `continue` as
"force another turn" and never as "stop", so the stop is `session.abort()` —
which leaves an error message behind exactly as a failing turn does. That is
why `exitCodeFor` exempts `turnsExhausted`: without it a bound working as
designed reaches the dispatcher as `agent_failed` and alarms every time.

## The two blocking tools

`monitor` and `contact_human` each cost **one turn** no matter how long they
wait. That is what keeps a multi-day incident from saturating context on
polling, and it is why the prompt forbids polling with bash in a loop.

**One turn is not one bill, and the prompt used to say it was.** A block that
outlives the prompt cache pays a full cache write on the turn after it, which
on a nine-hour incident was 41% of what that incident cost. So the prompt
prices the wait honestly and says what to do with it — refresh impact, post
state, draft the post-mortem — because the cost lands whether or not the agent
came out of the wait with anything.

- `monitor(command, …)` — **the command must be read-only.** On a container
  restart the session holds a tool call with no result, so the tool runs
  again; an action would be performed twice.
- `monitor(…, awaitingHuman)` — the heartbeat. Set, it means a *person* is
  what the wait is on, and the harness nudges the thread when they do not
  turn up. Unset, the wait is silent, which is right for a deploy, a
  migration or an alert going quiet: nobody is being asked for anything. The
  argument decides it rather than the command string, because a harness that
  pattern-matched `gh pr` would stop nudging the day somebody wrote the same
  check differently.

  The `command` has to **observe the thing itself** — `gh pr view --json
  state,mergedAt`, a flag read, a health check — not park until somebody says
  in Slack that they did it. Being told is the fallback. That is instruction
  (`prompt.ts`, the tool description) rather than a validator: what a command
  observes is not readable from its text, and this codebase does not
  pattern-match human-facing behaviour.
- `contact_human(message, …)` — re-entrant. The marker is written *before*
  the post, so a resumed agent resumes waiting rather than asking twice. It
  re-posts when the stored message differs from the new one, and when
  `messageTs` is empty because the post itself failed — otherwise one Slack
  hiccup becomes a silent 24-hour wait that escalates for the wrong reason.
  Optional `options` render as buttons on the ask (`slack/blocks.ts`); they
  change what the question looks like and nothing else. A press comes back as
  the same `human_message` directive a typed reply does, so the wait, the
  marker and the timeout are untouched and an answer nobody offered still
  lands. The options are checked before anything is posted, so a refusal
  costs no marker and no message.

## Re-running CI: the capability and its bound are one object

`rerun_ci` (`rerun.ts`) re-runs one workflow run's failed jobs, once. It
exists because incident 5 could not: the App holds `actions: read`, the
endpoint needs `actions: write`, and the agent correctly stopped and asked a
human rather than pretending otherwise. What the App may do is
[`../github-app.md`](../github-app.md), including the cases `actions: write`
does *not* cover — a run parked on an approval is the one to know, and since
mid-2026 that gate applies to pull requests a bot opened on a same-repo branch,
which is every pull request this agent opens.

The permission on its own would have been the worse outcome. `gh run rerun
--failed` is all the capability needs, and an agent holding that reaches for
a re-run the moment anything is red — retry as a fix, automated. So the
affordance is the tool, and the tool carries the discipline:

- **One attempt per run, read from GitHub's `run_attempt`.** Not from
  anything we store, which is what makes it survive a restart *and* makes the
  tool safe to replay: a restarted agent's recorded call runs again, finds
  attempt 2 and refuses instead of re-running twice. It also refuses a run a
  human already re-ran, which is right.
- **A budget across the incident**, so "push something small, re-run, repeat"
  runs out. Process-scoped, and a restart hands it back — but every run
  already re-run is still at attempt 2, so what a restart buys is only runs it
  has not touched.
- **The thread is told by the tool, not by the model.** The `suspicion`
  argument is required and is posted verbatim, so a human reading the thread
  can say "that is not a flake, that is your change". Posted *after* the
  re-run rather than before it, which is the opposite of `contact_human`'s
  marker: until the permission is granted every call ends in a 403, and a
  notice posted first would announce a re-run that never happened, over and
  over. A post that fails afterwards is recoverable and loud — the result
  hands the agent the text and tells it to post it.
- **A permission refusal names the permission.** Not "the re-run failed". It
  says which endpoint, what GitHub itself says the call needed, that the App
  holds `read`, and that asking a human is fine *only* if the ask says why —
  because a missing permission nobody names is a missing permission nobody
  grants. The discriminator is the `X-Accepted-GitHub-Permissions` response
  header, **not** the message: GitHub documents no failure for this endpoint
  at all, every 403 body is folklore, and the two that are attested ("this
  workflow is already running", "created over a month ago") have nothing to do
  with permissions. A 403 without that header says so instead of sending the
  agent to ask for a grant that would change nothing. 404 gets the same
  treatment from the other side, because GitHub masks a repository an
  installation cannot see rather than forbidding it.

**There is no fence, and this is the honest part.** The agent has a real
shell. `gh run rerun` is reachable the way `gh pr merge` is, and GitHub offers
no server-side equivalent of branch protection for a re-run. The prompt
forbids it; that is advice, not a control. If a reviewer wants this closed,
the only real answer is a second, narrower token for the agent's shell, which
is a bigger change than this one.

## contact_human is a question, and an unanswered one gets loud

Both tools that reach a person leave the incident exactly where it was.
`contact_human` asks for one fact or one action; `escalate` says the incident
needs a person and reaches the rotation. Neither moves the work and neither is
an exit — the agent keeps the incident and keeps driving it, because it is the
only thing that can finish it.

So an unanswered wait escalates rather than ending. `runContactHuman` calls
`escalate` itself and carries on; only a `stop` or a `merged` directive
terminates the run. The details it rests on:

- **The floor.** A requested wait below `CONTACT_HUMAN_MIN_WAIT_SECONDS` is
  raised to it, not answered early. Without that, the escalation is opt-out:
  ask for two minutes and no timeout ever means anything.
- **Not on the deadline abort.** The soft deadline has its own path — the run
  steers the model to write a real brief inside the grace window — and
  escalating here would spend the turn that brief needs.
- **A failed escalation is loud.** Nobody was told, so the result says so and
  tells the model to say it in the thread itself. The prompt is where the model
  is asked to escalate first; this is the floor under it, and the brief the
  harness writes is deliberately thinner.
- **The clock runs from `askedAt`, not from process start.** A restart is not
  an answer. A deadline of `now() + wait` hands a crash-looping agent a fresh
  wait every time and defers the escalation for as long as the crashes last.
- **The marker is cleared after the escalation, and only if it landed.**
  Clearing first and dying in between replays as a brand-new question:
  re-posted, with a fresh `askedAt` that makes a reply already in the thread
  look too old to be one.
- **Buttons do not opt out of any of it.** A button nobody presses is
  silence, so a question with `options` hits the same floor, the same
  deadline and the same escalation. The labels go into the harness's brief,
  because they were part of the question and whoever reads it was not
  watching the thread.

`message` is capped at `CONTACT_HUMAN_MESSAGE_LIMIT` and a longer one is
refused rather than truncated — truncating would cut off the question, which
is the part at the bottom. The limit is also what lets `unansweredBrief` quote
the ask whole when nobody answers, which is the one thing the person picking
the incident up cannot reconstruct. The evidence goes in `details`, posted as its own
message under the ask — and posted *outside* the re-entrancy guard, because
`messageTs` only records that the ask landed. A crash between the two posts
leaves a marker that looks complete, so a resume re-posts the evidence rather
than dropping it with no error and nobody aware. The split is the structure: the reader sees a
conclusion and one request, and the proof is one scroll away rather than in
front of it. `prompt.ts` carries the budget, the shape and a worked example
("What a human reads"); this is what makes it more than advice.

## The heartbeat on a wait that needs a person

An agent that posts "please merge this" and then blocks is indistinguishable
from one that has died, and a merge nobody notices is the stall that matters
most — the human's only job in this system is the merge. So a wait with
`awaitingHuman` set nudges the thread on its own: due an hour in, then two,
then four. Past `HEARTBEAT_LOUD_AFTER_PINGS` the nudge becomes an `escalate` —
the same facts, posted where the rotation sees them — and the wait continues.

**The ladder does not terminate**, because the agent is the only thing that
can finish the work: volume is the only thing left that can change.
`HEARTBEAT_MAX_GAP_SECONDS` clamps the doubling at a day, so it runs 1h, 2h,
4h, 8h, 16h and then daily for as long as the wait lasts. Nothing open goes
quiet for more than a day. Left doubling, the eighth nudge would land a
fortnight after the seventh, which is indistinguishable from having given up.

It lives in the wait loop rather than in the prompt for the same two reasons
`runContactHuman`'s escalation does. It must cost **no turns** — a model asked
to nudge itself has to come back for a turn to do it, which is the polling
loop the tool exists to replace. And an agent that has gone quiet cannot
notice its own silence.

**Nudges are gated on working hours, and the backoff counts from the last
nudge.** The window is `BUGBOSS_WORKING_HOURS`
(`America/New_York:10-19:1,2,3,4,5` by default — 07:00–16:00 Pacific, so
nobody on a continental-US team is pinged before 07:00 or after 19:00 local).
The elapsed clock is wall clock and the window only gates the *post*, so a
wait that spans a night stays silent and speaks on the first poll after the
window opens. Counting the gap from the last nudge rather than from the start
is what stops that morning from arriving as the whole ladder at once.

**Re-entrancy is the `pending_wait` marker**, on the same contract as the
question marker: idempotent for the same command, replaced by a different one.
It holds `startedAt` and the nudge count, so a resumed agent resumes the wait
it was in — and the timeout is measured from `startedAt`, so a crash-looping
agent does not get a fresh day each time round. The nudge is counted *before*
it is posted, which is the opposite order from the question and deliberate: a
crash between the two costs one nudge, where the other order re-nudges on
every resume, and every merge to ops `main` resumes every agent.

Both blocking tools take the harness's deadline signal combined with Pi's own,
so the soft deadline can interrupt a blocking tool. Without that, `steer` only lands
after the current turn's tool calls finish — and the agent spends most of
its life inside a `monitor` with an hours-long timeout.

## A recurrence arrives with its own history, and a second job

When the incident carries `recurrenceOf`, `get_incident` returns
`priorIncident` beside the signals: the earlier incident's root cause,
resolution evidence, PR urls and post-mortem. An agent before this one
investigated the same problem, declared it resolved on evidence, and was
wrong — this incident is the proof.

So the agent is working two problems. The firing one, and why a resolution
that met the bar did not hold. Three constraints carry the second:

- **`report_resolved` refuses the evidence the previous incident was closed
  on**, byte-for-byte after whitespace. Narrow on purpose: it catches the
  literal repeat — watching the same window for the same interval and
  reporting the same quiet — not a paraphrase. The prompt carries the rest.
- **`report_analysis` requires a `recurrence` argument** and refuses without
  one: which of six kinds of failure, why, and what changed. An agent that
  cannot answer escalates instead and keeps the incident: a recurrence nobody
  can explain stays open with somebody told it needs them.
- **`bugboss_defect` is one of the six.** The fix is in `ops`, and agents do
  not open pull requests against it, so the answer leaves as a proposal
  posted to the channel. The prompt says so; see the note in the PR that
  added this about why a prompt is not the control here either.

`search_incidents` is the agent's, not only triage's — the earlier
post-mortem often points at something that happened a third time under a
different alert, and no key finds that.

A *prior* incident's post-mortem is clipped in `toolapi`, not here, at
`MAX_PRIOR_POSTMORTEM_CHARS` — head only, and it names the incident database
as where the rest is. That is background rather than evidence this run went
and fetched, and a reader is told where to find the whole of it, which is the
distinction the rule below turns on. `get_incident` itself renders as JSON
followed by the pending directives, uncut.

## Nothing truncates a tool result, and nothing truncates a message to a person

Two rules that used to be one cap.

**Tool results are never cut.** `DEFAULT_MAX_TOOL_CHARS` (20,000, about 5,000
tokens) used to bound every one of them, and `truncateOutput` cut the middle
out to do it. The outputs it actually fired on were stack traces, log dumps
and test output, where the answer is usually in the middle — so it protected
the session by destroying the evidence the run had just paid a tool call to
fetch. Pi compacts just in time instead (`docs/architecture.md`), so a result
lands whole and summarised history is what gives way. Do not add a cap back.

**A message to a person is never cut by character count.** The nudge used to
post `[... 549 characters elided ...]` in place of the middle of the sentence
saying what was being waited for, to somebody reading it on a phone. A count
of what they cannot see is not something anybody can act on. So:

- Every prose field that a harness-composed Slack message echoes is **refused
  at the tool boundary** — `MONITOR_FIELD_LIMIT` for `monitor`'s `description`
  and `awaitingHuman`, `CONTACT_HUMAN_MESSAGE_LIMIT` for the ask,
  `overThreadBudget` for everything the model posts itself. A refusal costs
  one turn and says what to move where; a clamp costs the reader the sentence.
- The composed worst case of each harness message has to fit
  `THREAD_PROSE_CHARS`, because `escalate` refuses a longer one and a nudge
  that fails to post is dropped by design. `tools.test.ts` composes those
  worst cases at the field limits, which is what keeps the refusals
  load-bearing rather than decorative.
- `CONTACT_HUMAN_MESSAGE_LIMIT` is 550 rather than something rounder because
  `unansweredBrief` quotes the ask **whole**, and that arithmetic is what buys
  it. Changing one means redoing the other.
- The one thing still excerpted is a probe's own output
  (`statusExcerpt`/`STATUS_EXCERPT_CHARS`): nobody authored it, it is
  unbounded at the source, and a reader who wants all of it runs the check.
  Head only, ending in an ellipsis, and it says nothing about its own size.

The Slack agent's `truncate` in `slack/agent.ts` is the exception, and
deliberately: that agent has no compaction configured at all, so its caps are
the only thing bounding its context. Its call sites are tool results it reads,
not messages it posts.

## What it writes goes straight to Slack

`contact_human`, the escalation brief, the root cause, the resolution evidence
and the post-mortem are all posted as the agent wrote them, so the prompt
carries the mrkdwn contract ("Writing to Slack" in `prompt.ts`). The model is
told **not** to escape `&`, `<` or `>` itself — `slack/format.ts` does that at
the boundary, and a model that pre-escapes would post `&amp;amp;`.

The conversion is a backstop, not the mechanism. It only fires on the Markdown
that slips through anyway, and it runs on the Slack copy alone: the stored
root cause and post-mortem stay as the agent wrote them.

## Directives

The poll in `contact_human` uses a **non-draining** read
(`GET /incidents/:id/directives`). Draining there destroyed `stop`,
`merged`, `new_signals` and `resumed_after` — including the
`resumed_after` the dispatcher inserts at launch, which the agent's first
replayed call would eat before it ever ran `get_incident`.

The one reply it acts on is consumed by id. Everything else stays pending
for `get_incident` to deliver. A `human_message` left pending would
otherwise come back a turn later and read as a *new* instruction, since
directives render as prose.

That read is on the **read-only** connection, so a 30-second poll never
queues behind the write queue's synchronous S3 PUT.

## Sessions and resume

One layout: `sessions/incident/<id>/session.jsonl`, which the Slack agent
and the S3 lifecycle rule both expect. `BUGBOSS_SESSION_REF`
is **required** — there is no fallback, because the old default wrote to a
key nothing read, producing a session that appeared to persist and restored
nothing.

Every flush checks `lastError()`. A silently failing S3 write means the next
restart starts from scratch with the whole investigation lost, and combined
with relaunch that is an unbounded loop of agents each beginning again. N
consecutive failures steers the agent to escalate.

The session file is also the run's **cost ledger** -- `sumSessionUsage`
reads it back after the child exits, so the key the agent writes and the key
the Boss reads are one function. A drift between them costs no session and no
error, only an incident that appears to have been free.

## The exit record

The last entry a launch writes is a `bugboss_exit` custom entry naming how
the run ended: `completed`, `timed_out`, `turn_error` or `signal`. Without it
a killed run and a finished one are the same shape on disk -- the writer
appends per event and the file closes with the last one, and S3
`LastModified` sits within a second of it either way. Three of seven real
runs died mid-turn and read exactly like the four that did not; the longest
was 9.5 hours and $42.71, with an approved PR and green checks waiting, and
nobody knew to finish it.

`readSessionOutcome` is the reader. **It is not last-record-wins**: every
launch writes its own record, so a restored file carries an older one under
the turns that followed it, and a record with session events after it means
the run carried on past it and then died. `empty` is kept separate from
`killed`, because a child killed before its first turn synced has lost
nothing and alarming on it would alarm on every crash at boot.

`SIGTERM` and `SIGINT` write one too. `SIGKILL` cannot, and the dispatcher's
backstop uses it, so the absence of a record is still the common signature of
a kill -- which is exactly what `killed` means.

## The notes directory

`/work/<id>/notes/` is where an agent keeps its own record of the work,
mirrored to `sessions/incident/<id>/notes/` and restored before the session
opens. Pi has no persisted-workspace concept — a cwd and a session file are
all it keeps — so `notes.ts` is ours, hung off the same `turn_end` and
`session_shutdown` hooks the session sync uses so there is one durability
cadence, not two.

**It is a record, not scratch space, and the mirror is append-only.**
`NotesStore` has no `delete` and neither does the S3 store any more, so
nothing in the agent's path can take a note out of the record — not a tidy-up
reflex, not a bad `rm`. Agents are told in the prompt to leave their dead ends
behind, because a dead end is what stops the next investigation walking down
it again. A delete would also reclaim nothing: the bucket is versioned and
nothing under `sessions/` expires.

A resumed agent therefore gets back notes it deleted locally. The prompt says
so, or the reappearance reads as a broken harness.

The same no-deletes rule is why restore has to tolerate a name used twice. An
agent that writes the note `findings` and later makes `findings/` a directory
leaves both keys standing, and no filesystem holds both. Restore skips the one
it cannot place, logs `notes_restore_conflict` and carries on: it runs before
the session opens, so a throw there killed every relaunch of that incident on
the same two keys, and nothing in the agent's reach could clear either.

It is a **sibling** of the checkout, not a folder in it: under the checkout a
note is one `git add -A` away from the pull request the agent asks a human to
merge.

The prefix is derived from the session key rather than rebuilt from the
incident id, for the same reason `BUGBOSS_SESSION_REF` is required: a second
independent derivation is how notes come to be written where nothing reads.

**The bound is measured over the record, not the directory**, because with no
deletes a rename is what grows S3. It refuses the whole directory rather than
part of it: a partial mirror restores a state the agent never had. Crossing it
logs and steers once on the edge, and the message does not tell the agent to
delete, because deleting cannot bring it back under.

**The model is pinned in the session.** On resume it resolves from the
stored prefix, not from env — Bedrock does not restore it, and the SSM
mapping retunes without a deploy. Replaying against a different model
rejects every thinking block, and `drop_block` is deliberately quiet.

## Exit

`exitCodeFor` returns non-zero when `session.state.errorMessage` is set. A
soft timeout the agent handed off inside still exits 0: the signal is an
aborted turn, not the deadline.
