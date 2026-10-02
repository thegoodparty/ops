# agent

The incident agent: one Pi Durable conversation per incident, run by the
Boss's own harness in the Boss's own process, against Bedrock, with its own
checkout of omni that outlives a restart.

`extension.ts` is the agent: three extensions (`bugboss.incident`,
`bugboss.coding`, `bugboss.grafana`), the IncidentDoc that binds a
conversation to its incident, and what a launch says. `port.ts` is
everything it reaches that is not the tool API. `wait.ts` is how a tool
blocks. `budget.ts` is the turn budget and the deadline's words. `stages.ts`
is stage compaction. `shell-env.ts` is what its shell may see.

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

GitHub is different. The composition root holds the App and keeps its
installation token fresh; `bash` builds its environment on every call
(`createBashTool({ prepare })`) with the allowlist from `shell-env.ts` and the
token as it is at that moment, under both `GITHUB_TOKEN` and `GH_TOKEN`.
Installation tokens last an hour and an incident can run for a day, so a token
handed down at launch would expire mid-investigation and surface as `gh`
refusing to push a branch the agent had already built. The App's private key
never reaches the shell. `configureGitCredentials` installs a git credential
helper that reads `$GITHUB_TOKEN` when git asks, once, at boot.

**The shell never inherits the Boss's environment.** The agent runs inside
the process that holds `BUGBOSS_SECRETS`, so `bash` sets `inheritEnv = false`,
and so does every exec the harness's environment makes. A `monitor` command,
`npm ci` and the Grafana MCP server get the same allowlist.

The eval harness (`bugboss-evals/`) sets five more things, and production
sets none of them. The Boss reads `BUGBOSS_OMNI_REPO` (clone the sandbox, not
omni), `BUGBOSS_WORK_ROOT`, `BUGBOSS_GITHUB_TOKEN_FILE` (a sandbox-scoped
token the harness keeps fresh, read instead of the App's credentials) and
`BUGBOSS_REVIEW_SETTLE_SECONDS` itself; the allowlist also carries them, plus
`NODE_EXTRA_CA_CERTS` and any `AWS_ENDPOINT_URL_*`, so `bash` and `npm ci`
trust the harness's CA and send AWS calls where the Boss's own do.

What that token may do is [`../github-app.md`](../github-app.md), which is the
GitHub counterpart to the checked-in Slack manifest. Read it before assuming
a capability: the App is installed org-wide with `contents: write`, so the
token reaches every repository in the organisation and not only omni. The
prompt used to say otherwise and was wrong.

## The Grafana MCP surface is bounded twice, in code

`mcp.ts` exposes mcp-grafana, which ships ~80 tools, through one stdio process
the Boss shares between every agent (`bugboss.grafana`). A process that exits
alarms and is respawned on the next call. Fifteen agents can hold the tools at
once. On 2026-09-28 a third of all Loki read volume was ad-hoc MCP
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

**The alert that fired is the one exception.** The dispatcher reads the
incident's `alert_slug`s in SQL when it composes the prompt for a new
conversation. `findFiredAlert` locates each slug in
omni's alert source -- a literal `slug:`, then a template slug, then the
longest quoted dash-prefix, for a slug assembled from parts -- and inlines
the enclosing object literal, or a `file:line` pointer when there is no
literal to show.

The prompt is the conversation's `instructions`, pinned in `pi.agent` when the
conversation is created, and so is the model. A doc that changes in the
checkout, or a model id retuned in SSM, reaches the next incident and never
moves one already running, so no cached turn is invalidated by it. The
incident extension has no prompt sections for the same reason.

`prompt.test.ts` pins an upper bound on the composed prefix. Raising it is a
decision to make every turn of every incident dearer; make it in the PR, not
by editing the number to pass.

## Two bounds, and the turn budget is the one that measures work

The wall clock bounds how long a launch may run. It does not bound what the
run does: `monitor` and `message_boss` each cost **one turn** however long
they block, so the first nine-hour incident spent about eight of those hours
inside a single turn waiting on a person. 92 turns, $18.51, against a
24-hour deadline that fifteen agents could each have spent in full.

So there is a second bound in turns — `INCIDENT_AGENT_MAX_TURNS`, 300,
overridable by `BUGBOSS_MAX_TURNS`, plus whatever the Boss granted — and these
things about it matter (`budget.ts`):

- **It is counted over the incident, in the incident row.** An `afterResponse`
  hook increments `incident.turnsUsed` through `withWrite` after every model
  response, awaited, so the count is in the snapshot before the next request
  is made. At boot `reconcileTurns` rewrites every open incident's count from
  the `pi.assistant` entries in its conversation, absolute and idempotent,
  which repairs the one drift the increment has: a crash between its commit
  and the response's. An incident from before the harness has no count but
  its old session file, which nothing reads, so it starts again from 0 --
  except one parked on a spent budget, whose park names the budget it spent:
  `backfillSpentBudgets` writes that number once at boot, before the
  reconcile, so the dispatcher does not read 0 as a raised budget and
  relaunch it.
- **It announces and parks; it does not just stop.** Same two layers as the
  deadline. At the grace edge the hook steers `turnBudgetMessage`, once per
  budget (the steer's request id carries the budget), and a blocking tool
  sees the steer and returns, so an agent inside a day-long `monitor` does
  not spend its grace there. At the cap it escalates, parks and aborts the
  conversation. `escalate` is the announcement and is skipped when the agent
  already escalated inside its grace. **`park` is not skippable.** Nothing
  else stops the dispatcher relaunching, and a relaunched agent is instantly
  over budget again, so without it the run escalates, stops, relaunches and
  escalates every tick — the hot loop `park` exists for, named in its own
  doc comment in `types.ts`.
- **The cap waits for its round's tools.** A response that reaches the cap
  and calls tools is handled in `afterTools`, after they ran, so an
  `escalate` the model made on its very last turn is seen rather than cut off
  by the stop. A response with no tool calls is handled at once.
- **A launch that starts spent makes no model request.** The first turn of a
  relaunch rewrites the whole context: incident 80 came back at 266 of 200
  turns and spent $4.04 on one `get_incident`. The dispatcher checks
  `turnsUsed` before it submits.
- **The agent escalating itself wins the announcement.** `escalatedWithin`
  reads the conversation for a successful `escalate` result inside the last
  `graceTurns` responses. A *failed* escalation does not count — the Boss was
  never told, which is the case the harness exists for.
- **The grace is clamped to half the budget.** `TURN_BUDGET_GRACE_TURNS` is
  a constant and the budget is settable, so the two configure into nonsense
  at small budgets: unclamped, `BUGBOSS_MAX_TURNS=10` puts the soft edge at
  turn 0. The clamp is on the grace rather than a floor under the budget,
  because a small budget is a legitimate ask and the honest reading of it is
  "wrap up sooner". `TurnBudgetState.graceTurns` carries what was actually
  given, so the brief cannot quote a window nobody had.
- **The park opts out of lifting on a reply.** `ToolApi.park` defaults
  `liftsOnReply` to true, which is right for a wait on a person and wrong for
  this one: a reply is not news about having run out of turns. The argument
  is in `turnBudgetPark` rather than at the call site so a test fails if it is
  dropped. No reply or timer lifts a budget wait; raising the budget does, on
  the next boot (`liftRaisedBudgets`, `dispatcher/CLAUDE.md`). The brief says
  plainly that replying will not restart it.
- **The brief carries what the run spent.** Turns, tokens and a cost
  estimate, from the conversation's `pi.usage`, because shipping a turn cap
  before a dollar cap is only worth anything if somebody learns what those
  turns cost. It is called an estimate there too.

**This is not the Slack agent's budget.** `SLACK_AGENT_MAX_TURNS` is 24 and
ends by posting that the run is out of steps, which is right when a person is
waiting in a thread for an answer. Nobody is watching an investigator, so its
ending is an escalation and a park. Same mechanism, different number,
different last act — the names say which is which so the next change picks
the right one.

**The deadline is the dispatcher's.** It steers `deadlineMessage` at
`lastStartedAt + agentTimeoutSeconds` and aborts the conversation
`DEADLINE_GRACE_SECONDS` later. An abort kills the child processes a running
`bash` started. A tool wedged inside JavaScript rather than a subprocess
cannot be stopped from in-process; that is the cost of one process with no
isolation (`docs/architecture.md`).

## It talks to the Boss and nobody else

An incident agent never posts to Slack and never reads it. Everything it has
to say to a person goes into the Boss's inbox (`boss_inbox`, through
`AgentPort.tellBoss`), which commits the row and then wakes the Boss, and the
Boss decides whether anybody hears it, who, and in what words. Everything a
person says reaches the agent as a steer the Boss chose to send, opening
`The Boss says:` (`BOSS_SAYS`). `BossInboxPort` in `tools.ts` is the whole of
that surface: `tellBoss(kind, text)` and `escalationsSince(since)`. There is
no thread-posting method on the port.

An escalation marked `ownBrief` is the agent's own `escalate` and also tells
the dispatcher, so its deadline does not post a placeholder brief over the
agent's. The heartbeat's rungs are not marked.

What does still reach Slack from an agent's words is deterministic and posted
by `toolapi` on a transition: the root cause, the resolution evidence and the
post-mortem. Those are records, not conversation.

## Containment is the IncidentDoc

Every incident tool reads its incident id from the conversation's
`IncidentDoc`, written once in the commit that creates the conversation
(`incidentInit`), and calls `toolApiFor(incidentId)` or `port(incidentId)`
in-process. The id is never an argument, so a conversation cannot aim a write
at another incident's record. A conversation with no IncidentDoc gets an
error from every incident tool and reaches nothing.

The zod bodies in `extension.ts` run before every tool API call, on top of
Pi's own TypeBox validation: a URL is a URL (`<!channel>` inside `<…>` pages
everyone), an epoch is a positive integer, a string is not empty. A refused
argument or transition is a tool result the model can read and correct.

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
  `BUGBOSS_REVIEW_SETTLE_SECONDS` overrides the window; only the eval sets it.
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

**A message for the agent ends a wait.** Every blocking tool waits through
`waitUntil` (`wait.ts`), which ends on the condition, the timeout, the
conversation's abort, or a steer queued in the conversation's `pi.inbox`. A
Boss message, the deadline, the turn-budget warning, new signals and a resume
are all steers, so a wait returns within milliseconds of one, the steer is
placed after the round, and nothing polls. Follow-ups and writes do not end a
wait: they are placed only when the run answers, so a wait that ended on them
would return at once on every call until then. An interrupted `monitor` says
`(interrupted)` and clears its wait marker, so the board stops saying what it
was waiting on.

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
- `monitor(command, …)` — **the command must be read-only.** `monitor` is
  replay-safe, so a container restart in the middle of a wait runs it again;
  an action would be performed twice.
- `monitor(…, waitingFor)` — required: one plain sentence for the incident
  board and status card ("someone to merge omni#2189"). They show it in place
  of the command, which is shell and never shown. Required by the schema
  only: a call recorded before it existed can still run after a restart, so a
  missing one runs anyway and the board says "a check the agent is running".
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
  `pending_question` marker, and blocks until **any** Boss steer arrives. The
  result says the Boss answered and does not repeat the words: the steer is
  the next message the model reads, and saying it twice reads as two
  instructions.

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
  runs out. Held in process memory, one ledger per incident since one process
  runs them all, and a restart hands it back — but every run already re-run
  is still at attempt 2, so what a restart buys is only runs it has not
  touched.
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
reader, and the agent never holds the password. The tool calls
`createSidecarSqlPort` in-process, which adds the incident's own thread and
forwards to the `sqlrunner` sidecar, and the sidecar checks the
thread with Slack, asks for approval in it and runs the query once a person
on the rotation approves. The agent has a shell and the Boss's secrets, so none of that can
live on this side.

- **It is a blocking tool**, like `monitor`: one turn, capped at
  `MAX_BLOCK_SECONDS`, polled every `SQL_POLL_SECONDS`, and ended by a steer.
  A wait that ends unsettled returns the `requestId`, and calling again with
  it resumes rather than asking twice. The request id is also memoized on the
  call (`api.memo("sent")`), so a rerun after a crash waits on the same
  request rather than posting a second approval ask.
- **The sidecar's refusals arrive verbatim**, status and body, so the port
  returns `{status, text}` instead of throwing.
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

- **Any Boss steer is the answer.** The Boss does not chat, so every
  message it sends is deliberate, and several at once are one answer. A steer
  that is not the Boss's -- the deadline, the turn budget, new signals -- ends
  the wait without answering it: the marker stays, and calling again with the
  same message resumes rather than asking twice.
- **The question goes up before the marker.** A crash between the two asks the
  Boss twice; the other order leaves a marker for a question the Boss never
  received, and a wait on an answer to nothing.
- **The floor.** A requested wait below `MESSAGE_BOSS_MIN_WAIT_SECONDS` is
  raised to it, not answered early. Without that, the escalation is opt-out.
- **Not on an abort.** A stop and the hard deadline have their own paths to
  the Boss, and escalating here would spend the turn a brief needs.
- **The clock runs from `askedAt`, not from the call.** A restart is not
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
`get_incident` renders as JSON, uncut.

## Nothing is cut by character count, anywhere

**Tool results are never cut.** `DEFAULT_MAX_TOOL_CHARS` (20,000, about 5,000
tokens) used to bound every one of them, and `truncateOutput` cut the middle
out to do it. The outputs it actually fired on were stack traces, log dumps
and test output, where the answer is usually in the middle — so it protected
the session by destroying the evidence the run had just paid a tool call to
fetch. Pi compacts just in time instead (`docs/architecture.md`), so a result
lands whole and summarised history is what gives way. Do not add a cap back.
Pi Durable bounds a tool's explicit result to 50KB unless the tool says
otherwise, so every BugBoss tool declares `outputLimits` of
`Number.MAX_SAFE_INTEGER` (`WHOLE_OUTPUT`). The built-in `bash` keeps its own
tail and spills the rest to a file it names in a diagnostic; that is the
library's, and nothing is lost.

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

## A restart resumes the run where it stopped

The conversation is in `/data/harness.sqlite`, mirrored to S3 once a tick
(`db/CLAUDE.md`), and `harness.resume()` at boot continues every run a
deploy interrupted, from its last checkpoint, with no relaunch. A run that is
still pending in storage cannot look finished.

What a crash in the middle of a tool round does is the **replay policy**,
declared per tool:

- **Safe, rerun as they are:** `get_incident`, `search_incidents`,
  `set_summary`, `report_impact`, `track_incident_timeline_event` (idempotent
  on the whole event), `park`, every Grafana read, `read`, and `monitor`,
  whose `pending_wait` marker makes a rerun resume its clock and heartbeat
  rung, so a deploy in the middle of a wait costs no turn.
- **Safe behind a memo:** `message_boss`, `escalate`, `rerun_ci` and
  `request_sql_query` record what they sent with `api.memo`, so a rerun
  resumes rather than sending again. `message_boss` memoizes its merge
  check-in too, which is a paid model call. `rerun_ci` keeps its `run_attempt`
  check as well.
- **Unsafe, come back interrupted:** `bash`, `edit`, `write`, `propose_merge`
  and the three gates `report_root_cause`, `report_resolved` and
  `report_analysis`. A gate's goal evaluation is a paid model call and its
  `UPDATE` guard already refuses a second transition, so the model reads
  "interrupted" and calls again.

`extension.test.ts` kills a real child process in the middle of a round and
resumes it in a fresh one.

**Launch messages.** `kickoffMessage` opens a new conversation;
`resumedWithoutTranscript` says the agent worked this incident before under a
harness whose transcript did not carry over, and `cutoverHandoff` hands it the
durable story instead: the record, the timeline, the newest inbox rows and any
open wait or question. `resumeMessage` opens a relaunch of an idle
conversation and says whether the workspace survived.

## Compaction at each stage

The agent's context is summarised at every stage transition, with a prompt
that keeps only what the next stage needs (`stages.ts`). The threshold
backstop, `reserveTokensFor` the agent model, is still there underneath it.

Why: the backstop never fired. No incident got past 431k of a 1M window, so
every turn re-read everything the agent had ever seen, and cache reads of
history were half of what the fleet spent. Incidents 80, 86 and 94 hit the
turn cap carrying an investigation they had finished hours earlier.

- **Three transitions, all tool calls.** `report_root_cause` succeeding,
  which means its stage goal was judged met first (`root_cause`), and
  `track_incident_timeline_event` recording `fix_pr_opened` (`fix_opened`) or
  `fix_merged` (`fix_merged`). The tool records the stage; nothing reads what
  the agent wrote.
- **One compaction per round, for the later stage.** The incident
  extension's `afterTools` hook flushes what the round requested, so a root
  cause and a PR in the same batch cost one summary, for the stage the next
  turn is in. It calls `conversation.compact(instructions)`; Pi Durable
  summarises in the background and places the summary at the next turn
  boundary, and a deploy mid-summary resumes the task.
- **Skipped below `STAGE_COMPACTION_MIN_TOKENS` (50k)**, read off the newest
  response's usage. A summary is a model call over the history plus a cache
  rewrite after it, and on a small context that costs more than it saves.
- **The timeline goes into every stage prompt, verbatim**, read through
  `AgentPort.timelineEvents`, without goal verdicts. A failed read or a failed
  compaction logs; the threshold backstop still shrinks the context, it just
  loses the stage's focus.

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
- **An evaluator that fails passes the gate**, with a `goal_unjudged` alarm
  and no timeline row. A gate held shut by an outage would stop every
  incident at once.
- **What it reads.** The goal, the attempt (a gate's arguments whole), the
  incident and signals from `getIncident`, the timeline from
  `AgentPort.timelineEvents`, and the conversation's model context: the
  latest compaction summary and everything after. Nothing is cut
  by character count. A transcript that outgrows the evaluator's window
  leaves out its oldest messages whole and says how many.
- **Every verdict is a `goal_verdict` row**, written through the tool API's
  timeline call, and its spend is the judged tool's `usage`, so it lands in
  the conversation's `pi.usage.tools`: the incident's tokens, not its turns
  or its `modelId`. The agent's
  `track_incident_timeline_event` tool refuses `goal_verdict`; `getIncident`,
  stage compaction, the post-mortem and the closing report leave the rows
  out, and the evaluator reads them back as earlier verdicts.

## The transcript keeps everything compaction summarised

A compaction appends a `pi.compaction` entry holding the summary, which heads
the first entry it keeps, and deletes nothing: the conversation's older
entries stay in `harness.sqlite`, and so in its S3 snapshot. What the model
sees is the entries from the newest head marker onward. To read what a
summary stands for, read the conversation's entries before its head.

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

**The model is pinned in the conversation.** `pi.agent` stores it when the
conversation is created, so a resume never reads it from the environment —
the SSM mapping retunes without a deploy, and replaying against a different
model rejects every thinking block.

## The workspace survives a restart

`/work/<id>` (the checkout, its node_modules and the npm ci markers) is on an
EFS volume mounted at `/work`
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

One agent per incident is still what makes this safe: one conversation per
incident within a task, and the service's stop-then-start deploy across
tasks. Nothing on the volume locks against a second writer.

The volume is not backed up. The harness snapshot in S3 and the incident's
timeline are the only record guaranteed to survive; a lost volume only costs
a re-clone.
