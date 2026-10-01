# agent

The incident agent: a Pi session running in a child process, against
Bedrock, with its own checkout of omni that outlives a restart.

## What it is allowed to do

It opens pull requests. **It never merges one.** The prompt says so to save
it turns, but the actual controls are branch protection on `main` and the
GitHub App's permissions — it runs with a real shell, so a prompt is not a
control.

In AWS it runs on the Boss's own identity, resolved through the container
credential provider, which refreshes itself for as long as the run lasts.
Nothing inside the container separates the two, so what limits an agent is
what the task can reach at all — no database, no release path. The one
database read it has goes through a person: `request_sql_query`, below.

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

- **`GRAFANA_READ_TOOLS` is the surface.** Reads only, and only the ones
  agents call: every tool definition rides in the prefix of every turn, so
  an unused tool is paid for on all of them. The list was cut to the eleven
  that production incident sessions actually called; add one back when an
  investigation shows it needed it. Alert-*rule* reads are absent because
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

## The prompt carries rules, not documents

The system prompt and the tools array are re-sent on every turn, so every
character in them is multiplied by the turn count. It used to paste whole
documents in -- both observability docs, the ship-pr skill and the whole
alerting source tree -- and that was most of what each turn re-read.

Now `prompt.ts` inlines only what an agent needs on every turn to act safely
(the rules, the lifecycle, the Slack contract) and what nearly every
investigation needs for its first queries (the Loki selector and the
`Request completed` fields). Everything else is an index entry: a path, what
it answers and when to read it. The agent has the checkout.

**The alert that fired is the one exception.** The dispatcher passes the
incident's `alert_slug`s to the child as `BUGBOSS_ALERT_SLUGS`, read in
SQL at launch rather than through `get_incident`, which would drain the
directives the agent has not seen yet. `findFiredAlert` locates each slug in
omni's alert source -- a literal `slug:`, then a template slug, then the
longest quoted dash-prefix, for a slug assembled from parts -- and inlines
the enclosing object literal, or a `file:line` pointer when there is no
literal to show.

`prompt.test.ts` pins an upper bound on the composed prefix. Raising it is a
decision to make every turn of every incident dearer; make it in the PR, not
by editing the number to pass.

## Two bounds, and the turn budget is the one that measures work

The wall clock bounds how long a launch may run. It does not bound what the
run does: `monitor` and `message_boss` each cost **one turn** however long
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
- **A launch that starts spent makes no model request.** `turn_end` fires
  only after a turn is paid for, and the first turn of a relaunch rewrites
  the whole restored context: incident 80 came back at 266 of 200 turns and
  spent $4.04 on one `get_incident`. So `promptWithinBudget` runs the same
  hand-off before the first prompt when the restored count is already at the
  cap. The dispatcher cannot make this call itself: it never reads the
  session file the count lives in.
- **The agent escalating itself wins the announcement.** The steer asks for
  exactly that and the model can answer on its very last grace turn, which
  ends the same `turn_end` the cap fires on. The budget watches
  `toolResults` for a successful `escalate`, because sending both puts "it
  never wrote a brief" directly under the brief it just wrote. A *failed*
  escalation does not count — the Boss was never told, which is the case the
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

## It talks to the Boss and nobody else

An incident agent never posts to Slack and never reads it. Everything it has
to say to a person goes into the Boss's inbox (`boss_inbox`, through
`POST /incidents/:id/boss-inbox`), which wakes the Boss, and the Boss decides
whether anybody hears it, who, and in what words. Everything a person says
reaches the agent as a `boss_message` directive the Boss chose to send.
`BossInboxPort` in `tools.ts` is the whole of that surface: `tellBoss(kind,
text)` and `escalationsSince(since)`. There is no thread-posting method on the
Boss client.

What does still reach Slack from an agent's words is deterministic and posted
by `toolapi` on a transition: the root cause, the resolution evidence and the
post-mortem. Those are records, not conversation.

## The two blocking tools

`monitor` and `message_boss` (with `wait: true`) each cost **one turn** no
matter how long they wait. That is what keeps a multi-day incident from
saturating context on polling, and it is why the prompt forbids polling with
bash in a loop.

**One call blocks for at most `MAX_BLOCK_SECONDS` (3300s).** That is under
the one-hour prompt cache TTL, so a wake is a warm read rather than a rewrite
of the whole context. Incident 80 asked `monitor` for 2h and 4h and paid
$5.25 in cold rewrites for the two wakes. A longer request is clamped, not
refused: the result says the call was capped and nothing timed out, and the
agent calls again. A capped `monitor` keeps its wait marker, so the re-armed
call resumes the original clock and heartbeat ladder (without that, the first
reminder at one hour would never land). A capped wait with no marker has
nothing to resume, so its result names the `timeoutSeconds` left and the
agent passes that; passing the original again would restart the clock every
call and the wait would never end. A capped `message_boss` keeps its
question marker, so calling again with the same message does not re-ask.

**Waits are typed, and code decides when they end.** `monitor` takes a
`condition` (`conditions.ts`): `pr_checks` (the `statusCheckRollup` that `gh
pr checks` reads, so non-Actions checks count), `pr_review` (reviews and the
`<!-- delegate-reviewer-state -->` comment after `since`), `pr_closed`,
`workflow_run` (a commit's runs, or one named workflow), and `command` for
the rest. Before them, every agent wrote its own check script: bash turns
probing `gh` output to get the jq right, a script that exited 0 with nothing
in it, and another bash turn to fetch what the wait had seen. Across the
fleet that was 479 poll turns, 16% of turns and 36% of cost. Three rules the
conditions hold to:

- **A failure ends the wait.** A check that exits 0 only on success cannot
  tell a failed run from a running one: incident 80 watched prod for 1h51m
  after its release run had failed. `pr_checks` and `workflow_run` stop at
  the first failure. `workflow_run` ignores `schedule` and `workflow_run`
  events unless a workflow is named, because the default branch's head
  carries dozens of cancelled gpbot-ci-drive runs that are not its pipeline.
- **A review wait settles for `REVIEW_SETTLE_SECONDS` after the first one.**
  delegate-reviewer can post APPROVED and then COMMENTED on the same commit,
  so the result carries every review in the window, oldest first, whole, with
  inline comments. A capped review wait with no marker returns the `since` to
  resume from.
- **Arguments GitHub rejects end the wait at once** (401, 404, GraphQL
  errors); a 5xx or a network failure is waited through.

A `command` runs in the checkout: incident 94 lost a 900s wait to a script
that called `gh` outside a git repository.

**A wait on a person closes its ask.** When a wait with `awaitingHuman` fires,
the harness tells the Boss it is done (`waitDoneMessage`) before dropping the
marker. Dropping the marker told nobody: incident 90's thread said it needed
a person for 1h40m after the merge the wait had seen within a minute.

**bash refuses to wait** (`pollingGuardExtension`, a pi `tool_call` hook): a
`sleep` over `BASH_SLEEP_LIMIT_SECONDS`, `gh run watch`, and `gh pr checks
--watch`. Those shapes are nothing but waiting, so the guard never blocks
real work; everything subtler (a one-off `gh pr checks`) is left to the
prompt and the tool description.

**A Boss message is a user message, and it ends a wait.** The Boss writes it
to `pending_directive` from another process, so `createDirectiveWatcher`
(`run.ts`) polls every ten seconds and delivers each `boss_message` with
`session.steer`, then consumes it; the steered message is in the session, so a
restart keeps it. Only the Boss tools drain the queue, and an agent writing a
fix or watching CI calls none of them for minutes: incident 94's agent ran ten
bash and monitor calls past a redirection and read it only when a deploy
restarted it.

A steer lands between tool batches, so a wait has to be cancellable or it
holds the message for as long as it lasts. `createWaitInterrupt` (`tools.ts`)
is a per-wait `AbortController`, replaced after every interrupt, and the
blocking tools combine it with `wrapUpAbort` at call start. An interrupted
`monitor` says `(interrupted)` and clears its wait marker, so the board stops
saying what it was waiting on. `stop` and `merged` interrupt too but stay
queued: the next Boss tool drains them, and only its result can end the run.

**One turn is not one bill, and the prompt used to say it was.** A block that
outlives the prompt cache pays a full cache write on the turn after it, which
on a nine-hour incident was 41% of what that incident cost. So the prompt
prices the wait honestly and says what to do with it — refresh impact, record
timeline events, draft the post-mortem — because the cost lands whether or not the agent
came out of the wait with anything.

- `monitor(condition?, command?, pr?, …)` — `condition` defaults to
  `command`, so a call recorded before conditions existed replays unchanged.
  A typed wait's marker is keyed on `conditionKey`, the condition and what it
  watches, the way a command wait is keyed on its command.
- `monitor(command, …)` — **the command must be read-only.** On a container
  restart the session holds a tool call with no result, so the tool runs
  again; an action would be performed twice.
- `monitor(…, waitingFor)` — required: one plain sentence for the incident
  board and status card ("someone to merge omni#2189"). They show it in place
  of the command, which is shell and never shown. Required by the schema
  only: a restart replays calls recorded before it existed, so a missing one
  runs anyway and the board says "a check the agent is running".
- `monitor(…, awaitingHuman)` — the heartbeat. Set, it means a *person* is
  what the wait is on, and the harness tells the Boss when they do not turn
  up. Unset, the wait is silent, which is right for a deploy, a migration or
  an alert going quiet: nobody is being asked for anything. The argument
  decides it rather than the command string, because a harness that
  pattern-matched `gh pr` would stop reporting the day somebody wrote the same
  check differently.

  The condition has to **observe the thing itself** — `pr_closed`, a flag
  read, a health check — not park until somebody says
  they did it. Being told is the fallback. That is instruction (`prompt.ts`,
  the tool description) rather than a validator: what a command observes is
  not readable from its text, and this codebase does not pattern-match
  human-facing behaviour.
- `message_boss(message, wait?, seconds?)` — without `wait` it records a
  `message` row and returns. With it, it records a `question` row, writes the
  `pending_question` marker, and blocks until **any** `boss_message` arrives.

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
- **The Boss is told by the tool, not by the model.** The `suspicion`
  argument is required and goes to the Boss's inbox verbatim, so somebody it
  shows it to can say "that is not a flake, that is your change". Sent
  *after* the re-run rather than before it, which is the opposite of
  `message_boss`'s order: until the permission is granted every call ends in
  a 403, and a notice sent first would announce a re-run that never
  happened, over and over. A send that fails afterwards is recoverable and
  loud — the result hands the agent the text and tells it to send it.
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

## Production SQL goes through a person and a sidecar

`request_sql_query` (`sql.ts`) runs one SELECT against gp-api's production
reader, and the agent never holds the password. The tool calls the loopback
API (`POST /incidents/:id/sql-requests`), the Boss adds the incident's own
thread and forwards to the `sqlrunner` sidecar, and the sidecar checks the
thread with Slack, asks for approval in it and runs the query once a person
on the rotation approves. The agent has a shell and the Boss's secrets, so none of that can
live on this side.

- **It is a blocking tool**, like `monitor`: one turn, capped at
  `MAX_BLOCK_SECONDS`, polled every `SQL_POLL_SECONDS`, and ended by a Boss
  message through `createWaitInterrupt`. A wait that ends unsettled returns
  the `requestId`, and calling again with it resumes rather than asking twice.
- **The sidecar's refusals arrive verbatim**, status and body, so the client
  method returns `{status, text}` instead of throwing like `call`.
- **A 404 means the sidecar restarted.** It holds requests in memory, so the
  agent is told to ask again. Any other unreadable answer ends the wait too;
  retrying a sidecar that is down would alarm on every poll.
- **Rows come back whole.** The 200-row cap is in the sidecar's SQL, not here.

## An unanswered question gets loud, and the wait continues

Both tools that reach a person leave the incident exactly where it was.
`message_boss` asks for one fact or one action; `escalate` says the incident
needs a person, urgently, and records an `escalation` row. Neither moves the
work and neither is an exit — the agent keeps the incident and keeps driving
it, because it is the only thing that can finish it.

So an unanswered question escalates rather than ending. `runMessageBoss`
records an `escalation` row saying what it asked and how long it has waited,
and carries on waiting; only an answer, a `stop`, a `merged` or the harness
deadline ends it. The details it rests on:

- **Any `boss_message` is the answer.** The Boss does not chat, so every
  message it sends is deliberate. Several pending at once are one answer, all
  consumed, rather than one answer and a leftover that `get_incident` would
  deliver again.
- **A legacy `human_message` reads as the Boss.** Rows written before the
  directive was renamed can still be pending; `bossMessageText` is the one
  place that knows the old shape.
- **The question goes up before the marker.** A crash between the two asks the
  Boss twice; the other order leaves a marker for a question the Boss never
  received, and a wait on an answer to nothing.
- **The floor.** A requested wait below `MESSAGE_BOSS_MIN_WAIT_SECONDS` is
  raised to it, not answered early. Without that, the escalation is opt-out.
- **Not on the deadline abort.** The soft deadline has its own path — the run
  steers the model to write a real brief inside the grace window — and
  escalating here would spend the turn that brief needs.
- **The clock runs from `askedAt`, not from process start.** A restart is not
  an answer. A deadline of `now() + wait` hands a crash-looping agent a fresh
  wait every time and defers the escalation for as long as the crashes last.
- **The ladder is read off the inbox.** After the first escalation the next
  one is due on the heartbeat's doubling gap, capped at a day, measured from
  the last escalation row for the incident since `askedAt`. The rows are the
  record of what the Boss has been told, so a restart neither repeats a rung
  nor skips one, and `pending_question` needs no counter.
- **No length limit.** The Boss reads the question, not a phone, so nothing
  about it is refused for length or cut.

## The heartbeat on a wait that needs a person

An agent that asks for a merge and then blocks is indistinguishable from one
that has died, and a merge nobody notices is the stall that matters most — the
human's only job in this system is the merge. So a wait with `awaitingHuman`
set tells the Boss on its own: an hour in, then two, then four, each rung an
`escalation` row carrying what is being waited for, what a person has to do,
how long it has been and what the check says now, whole. The Boss decides
who to reach and how loudly.

**The ladder does not terminate**, because the agent is the only thing that
can finish the work. `HEARTBEAT_MAX_GAP_SECONDS` clamps the doubling at a day,
so it runs 1h, 2h, 4h, 8h, 16h and then daily for as long as the wait lasts.
Nothing open goes quiet for more than a day.

It lives in the wait loop rather than in the prompt for the same two reasons
the question's escalation does. It must cost **no turns** — a model asked to
remind itself has to come back for a turn to do it, which is the polling loop
the tool exists to replace. And an agent that has gone quiet cannot notice its
own silence.

**Rungs are gated on working hours, and the backoff counts from the last
rung.** The window is `BUGBOSS_WORKING_HOURS`
(`America/New_York:10-19:1,2,3,4,5` by default — 07:00–16:00 Pacific). The
elapsed clock is wall clock and the window only gates the *send*, so a wait
that spans a night stays silent and speaks on the first poll after the window
opens. Counting the gap from the last rung rather than from the start is what
stops that morning from arriving as the whole ladder at once.

**Re-entrancy is the `pending_wait` marker**: idempotent for the same command,
replaced by a different one. It holds `startedAt`, the rung count and the
`waitingFor` label (which a replay may reword without restarting anything), so a
resumed agent resumes the wait it was in and the timeout is measured from
`startedAt`. The rung is counted *before* it is sent, deliberately: a crash
between the two costs one rung, where the other order repeats it on every
resume, and every merge to ops `main` resumes every agent.

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

A *prior* incident's post-mortem comes through `toolapi` whole. It used to be
clipped at `MAX_PRIOR_POSTMORTEM_CHARS`, on the reasoning that the agent's own
tool-output truncation kept a head and a tail so an unbounded post-mortem
would eat the middle of the incident rather than itself — and that truncation
is gone, so the cap outlived the thing it was protecting against.
`get_incident` renders as JSON followed by the pending directives, uncut.

## Nothing is cut by character count, anywhere

**Tool results are never cut.** `DEFAULT_MAX_TOOL_CHARS` (20,000, about 5,000
tokens) used to bound every one of them, and `truncateOutput` cut the middle
out to do it. The outputs it actually fired on were stack traces, log dumps
and test output, where the answer is usually in the middle — so it protected
the session by destroying the evidence the run had just paid a tool call to
fetch. Pi compacts just in time instead (`docs/architecture.md`), so a result
lands whole and summarised history is what gives way. Do not add a cap back.

**What the agent sends the Boss is never cut or refused for length.** The Boss
reads it, and what reaches a person is the Boss's own words, so there is no
Slack budget to enforce on this side. The limits that used to sit on the ask,
on `monitor`'s prose fields and on the re-run suspicion all answered to a
phone screen, and each one caused retry loops in the runs that hit it.

What the agent writes that does reach Slack is posted by `toolapi` on a
transition, and that is where the thread budget lives: resolution evidence
is refused past `THREAD_PROSE_CHARS`, and the post-mortem has no character
cap; only its `practiceChanges` section has a word range, and it refuses
rather than cuts.

The Slack agent has compaction too — `compactTranscript` in `slack/agent.ts`,
wired into the loop in the composition root — so what is left on that surface
bounds *rows and entries*, never widths.

## What reaches Slack is mrkdwn

The root cause and the resolution evidence are posted as the agent wrote
them, so the prompt carries the mrkdwn contract ("What reaches Slack" in
`prompt.ts`) for those two and nothing else. The post-mortem only reaches the
PDF, which reads Markdown, so the prompt asks for Markdown there. The model is told
**not** to escape `&`, `<` or `>` itself — `slack/format.ts` does that at the
boundary, and a model that pre-escapes would post `&amp;amp;`.

The conversion is a backstop, not the mechanism. It only fires on the Markdown
that slips through anyway, and it runs on the Slack copy alone: the stored
root cause and post-mortem stay as the agent wrote them.

The prompt also tells the agent not to narrate in plain text between tool
calls. Nothing reads it: one run wrote 56,000 characters of it.

## Directives

The poll in `message_boss` uses a **non-draining** read
(`GET /incidents/:id/directives`). Draining there destroyed `stop`,
`merged`, `new_signals` and `resumed_after` — including the
`resumed_after` the dispatcher inserts at launch, which the agent's first
replayed call would eat before it ever ran `get_incident`.

The answer it acts on is consumed by id. Everything else stays pending
for `get_incident` to deliver. A `boss_message` left pending would
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

## Compaction at each stage

The agent's context is summarised at every stage transition, by Pi, with a
prompt that keeps only what the next stage needs. `compaction.ts`; the
threshold backstop at ~85% of the window is still there underneath it.

Why: the backstop never fired. No incident got past 431k of a 1M window, so
every turn re-read everything the agent had ever seen, and cache reads of
history were half of what the fleet spent. Incidents 80, 86 and 94 hit the
turn cap carrying an investigation they had finished hours earlier.

- **Three transitions, all tool calls.** `report_root_cause` succeeding,
  which now means its stage goal was judged met first (see "Stage goals"),
  (`root_cause`), and `track_incident_timeline_event` recording `fix_pr_opened`
  (`fix_opened`) or `fix_merged` (`fix_merged`). The tools report them through
  `onRootCause` / `onTimelineEvent`; nothing reads what the agent wrote.
- **Pi does the compaction.** The turn that made the transition arms it by
  raising `reserveTokens` to the whole window, so Pi's own between-turn check
  compacts before the next request. `session_before_compact` puts the reserve
  back, then calls Pi's exported `compact()` on Pi's preparation with the
  stage's instructions and the timeline. A `turn_start` with the stage still
  armed means Pi found nothing to compact, and disarms too: a reserve left at
  the window would compact every turn after.
- **The split turn is folded in.** An incident is one user-message span, so
  Pi's cut nearly always lands inside it, and Pi summarises that prefix with
  a fixed prompt that takes no instructions. `createPiSummarizer` moves the
  prefix into the history so one call, with the stage's focus, covers it all.
- **Skipped below `STAGE_COMPACTION_MIN_TOKENS` (50k).** A summary is a model
  call over the history plus a cache rewrite after it, and on a small context
  that costs more than it saves.
- **The timeline goes into every stage prompt, verbatim**, read through the
  non-draining `GET /incidents/:id/timeline`. A failed read or a failed
  summary logs and falls back to Pi's default summary; the context still
  shrinks, it just loses the stage's focus.
- **An armed stage survives a restart.** Arming is process memory, and every
  ops deploy restarts every agent, so the turn that arms also appends a
  `bugboss_stage_compaction` custom entry (`{ stage }`) to the session file.
  `stages.extension` runs ahead of the session sync so that entry is in the
  same turn_end upload. On launch, `startWithinBudget` checks the turn budget,
  then `stages.resume` compacts for the stage if the last stage entry on the
  branch has no `compaction` entry after it, then sends the first prompt. A
  spent budget does neither. Compacting first makes the relaunch's cold cache
  write a summary rather than the history. The compaction entry clears the
  marker; `{ stage: null }` clears it when Pi found nothing to compact or the
  resume compaction failed.

The replay of incidents 94 and 86 at these three transitions came to about
43% less spend on the two ($31 of $73.50), nearly all of it cache reads.

## Stage goals

The agent never decides a gate is passed. A separate model, Haiku 4.5 on
Bedrock (`DEFAULT_GOAL_MODEL_ID`, overridden by `BUGBOSS_GOAL_MODEL_ID`),
reads the goal for the gate and the transcript and returns met, not met or
impossible with a reason. It is Claude Code's `/goal` pattern; `goals.ts`
holds the goal text and the evaluator.

Why: incident 94's root cause explained the 502 that paged and not the
candidates charged for sends that never went out, and incident 80 closed with
its prevention written up as follow-up work. Both gates checked arguments, not
outcomes.

- **The three gates.** `report_root_cause`, `report_resolved` and
  `report_analysis` run their transition only on a met verdict, so stage
  compaction rests on a verified gate. Not met returns the reason and the goal
  text as the tool result, and the agent keeps working.
- **The merge check-in.** Every `message_boss` is judged first. The evaluator
  decides whether the message asks for a merge: `not_applicable` lets it
  through, and no code reads the message's words. Not met blocks the message
  with the reason. A resumed `message_boss` wait is not judged again.
- **Impossible escalates.** The reason goes to the Boss as an `escalation`,
  the same path the `escalate` tool uses. Nothing changes and the agent keeps
  working; the overall turn budget bounds a stuck agent.
- **An evaluator that fails passes the gate**, with a `goal_unjudged` alarm.
  A gate held shut by an outage would stop every incident at once.
- **What it reads.** The goal, the attempt (a gate's arguments whole), the
  incident record and timeline through the non-draining
  `GET /incidents/:id/goal-context`, and the agent's projected context: the
  latest compaction summary and everything after. Nothing is cut by character
  count. A transcript that outgrows the evaluator's window leaves out its
  oldest messages whole and says how many.
- **Every verdict is recorded twice.** As a `goal_verdict` timeline row
  (`POST /incidents/:id/goal-verdict`, kept out of `TIMELINE_EVENT_KINDS` so
  the agent cannot record one, and filtered out of stage compaction prompts),
  and as a `bugboss_goal_verdict` session entry carrying its usage, which
  `sumSessionUsage` adds to the incident's tokens but not its turns or its
  `modelId`.

## The transcript keeps everything compaction summarised

Pi's compaction appends a `compaction` entry (`summary`, `firstKeptEntryId`,
`tokensBefore`, `details`) and deletes nothing, so the session file -- and the
whole-file copy of it at `s3://bugboss-prod/sessions/incident/<id>/session.jsonl`
-- still holds every entry the summary replaced. That was checked in Pi's
`session-manager.js`, not assumed: `appendCompaction` goes through
`_appendEntry`, and the only whole-file rewrites are a version migration
(which keeps every entry) and branching (a new file, which this agent never
does). `compaction.test.ts` pins it against a real session.

**The compaction entry is the anchor.** To read what a summary stands for,
take the entries between the previous compaction's `firstKeptEntryId` (or
the start of the file) and this one's `firstKeptEntryId`; those are verbatim.
To rebuild the context as it was before a compaction, stop reading the file
at that compaction entry: `SessionManager.open` over the truncated copy
projects the uncompacted conversation. A stage compaction also carries
`details.stage`.

## The timeline

`track_incident_timeline_event` records a moment in the incident: `kind`
from `TIMELINE_EVENT_KINDS`, `occurredAt` when it happened (from the
evidence, not when the agent noticed), a one-sentence summary and an
evidence link. Rows go in `incident_timeline_event`, idempotent on the whole
event so a replayed call after a restart records nothing twice.

It exists because of compaction. The first error scrolls out of the context
long before the closer writes the post-mortem, so the closer reads the
timeline from `get_incident` instead of rebuilding it. Its post-mortem
timeline rows name events by `recordedEventId`, and the report merges the two
into one table with the recorded times (`report/CLAUDE.md`). The prompt asks
for events on the turn they are learned, not at the end.

**The model is pinned in the session.** On resume it resolves from the
stored prefix, not from env — Bedrock does not restore it, and the SSM
mapping retunes without a deploy. Replaying against a different model
rejects every thinking block, and `drop_block` is deliberately quiet.

## The workspace survives a restart

`/work/<id>` (the checkout, its node_modules, the npm ci markers and the
session directory) is on an EFS volume mounted at `/work`
(`deploy/components/bugboss.ts`), because every ops deploy replaces the task
and its ephemeral disk. Before that, every deploy re-cloned omni for every
open incident and lost uncommitted edits: incident 86 redid 29 turns.
`workspace.ts` is what uses it:

- **A relaunch keeps the checkout.** `prepareCheckout` only fetches when
  `.git` exists, and clears every stale `*.lock` a killed git command left. It clones into
  `omni.partial` and renames, so a task killed mid-clone never leaves a
  `.git` that looks whole.
- **node_modules is kept while the lockfile is.** The done marker holds the
  `package-lock.json` hash it installed. A relaunch into a workspace that ever
  started `npm ci` calls `startNpmCi`, which reinstalls only on a different
  hash or an install the restart interrupted. `npm-ci.pid` (boot id and pid)
  stops a second install over one still running from an earlier launch in
  the same task.
- **The resume message says which it was.** `resumeMessage` tells the agent
  its workspace was kept, or that it is a fresh clone, and names what the
  relaunch could not do: a fetch that failed, or an npm ci that had failed
  before and was not rerun.
- **The dispatcher deletes it** once the incident is CLOSED or MERGED and no
  agent is running. See `dispatcher/CLAUDE.md`.

One agent per incident is still what makes this safe: the dispatcher's
`running` map within a task, and the service's stop-then-start deploy
across tasks. Nothing on the volume locks against a second writer.

The volume is not backed up. The session transcript in S3 and the incident's
timeline are still the only record guaranteed to survive; a lost volume only
costs a re-clone.

## Exit

`exitCodeFor` returns non-zero when `session.state.errorMessage` is set. A
soft timeout the agent handed off inside still exits 0: the signal is an
aborted turn, not the deadline.
