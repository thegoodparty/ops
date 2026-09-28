# BugBoss — outstanding work

Working state for the BugBoss build-out, kept here so it survives a context
reset. Updated as things land. Not product documentation.

## Blocked on a human

- **Purge the 2026-09-28 alert-storm incidents from the database.** Between
  **13:19:01 and 13:22:30 EDT** BugBoss opened **incidents 41-79** — 39 in
  three and a half minutes — one per Grafana rule, each spawning an
  investigating agent. None was a real fault. Grafana Cloud had begun
  returning **429** on Loki queries; with `exec_err_state: Alerting` (which is
  intended), every failed rule evaluation became a firing alert. Production
  was healthy throughout: ~7 error lines in five minutes across gp-api prod.

  These rows and their session transcripts are cruft and should be removed
  from the SQLite database and the S3 mirror, along with the agent work
  directories and notes.

  Identifying them: title `[PROD] [<route>] Route errors detected`, and most
  carry `[no value]` as the endpoint because the query returned nothing, so
  there was no `request_endpoint` label to interpolate. That `[no value]` is
  the cleanest marker of a storm incident.

  **Two in the range are not cruft, so do not delete by range alone:**
  - **#63 `[PROD] Alert notifications are failing to deliver`** — BugBoss
    correctly detecting the real fault. The one true signal in the storm, and
    worth reading before anything is dropped.
  - **#79 `[PROD] High memory utilization`** — may be genuine, or may be
    BugBoss's own memory under 30+ concurrent agents. Read it first.

  The lower boundary needs checking: 41 is the earliest seen in `#dev-alerts`,
  but incidents below it may also belong to the storm. Bound by timestamp
  rather than by number.

  Do this only after the load investigation lands and the underlying issue is
  fixed, so the purge is not repeated.


- **Merge #118** (`integration/bugboss-v1`). Needs a human codeowner. It is
  **not safely divisible** — cherry-picking pieces reintroduces the ordering
  hazard that broke deploys repeatedly, because the single-role change is
  load-bearing for agent launches and later branches assume it.
- **Merge omni #2161.** It lets the test harness accept a Postgres it did not
  start. Until it lands, the Postgres sidecar in #118 is an idle container and
  agent behaviour is unchanged. The two are useless apart.
- **Merge the omni PRs the incident agents opened.** #2149, #2151, #2152,
  #2153, #2154, #2156, #2157, #2158, #2159 — approved and green. Agents are
  blocked waiting on them.
- **Incident 8 needs a CallHub billing top-up.** Vendor account out of prepaid
  credits. No code defect. The agent cannot check or fix the balance.
- **`@product-bugs` contains only one person.** Rotation is not populated, so
  every escalation reaches the same human.

## Done, do not redo

- Slack scopes: `chat:write`, `app_mentions:read`, `channels:history`,
  `usergroups:read`, `reactions:read`, `reactions:write`, `files:read`,
  `files:write`.
- Slack Event Subscriptions enabled; **Socket Mode off** (it was swallowing
  every event — that was the whole reason inbound Slack never worked).
- Slack Interactivity enabled, request URL `https://bugboss.goodparty.org/slack`.
- GitHub App `bugboss-gp`: `actions: write` granted (CI re-runs). Installed on
  **all** org repos, which is wider than the agent's prompt claims.
- `BUGBOSS` secret: `GITHUB_APP_PRIVATE_KEY` un-double-encoded,
  `SLACK_ROTATION_GROUP_ID` set to `@product-bugs` (`S0C43CP2XKR`), dead
  `BUGBOSS_MCP_JWT_SECRET` removed, `BUGBOSS_MAX_AGENTS` cap removed.
- Grafana `dev-alerts` webhook contact point: timestamp header, basic auth,
  `maxAlerts: 0`, resolve messages off.
- The secret is clickops and is **not** declared in Pulumi. IaC looks it up.
- `npm test` now also globs `bugboss/*.test.ts`. The old glob expanded as
  `bugboss/*/*.test.ts` under `sh`, so a top-level test file was silently
  skipped; `bugboss/github.test.ts` is the first one and would have been.
- **Agent output policy is built** (#123). Every path into a thread is capped
  at `THREAD_PROSE_CHARS` (~200 words) and **refuses** rather than splits: the
  loopback `/thread` route 400s, `report_resolved`'s evidence and `hand_off`'s
  brief reject ahead of their transition, and `contact_human`'s ask keeps its
  tighter 700. The post-mortem is the one uncapped field, because it leaves as
  the closing report file rather than as thread text — `postDocument` is that
  exemption, named so it is greppable. Harness-composed posts clamp the text
  they echo instead, since a refusal has nobody to reach. The prompt carries
  the rule and a worked identifiers-vs-behaviour pair. What is **not** done:
  nothing measures live threads, so whether real output moved from the
  measured 370–426 words down toward 200 is still unobserved.

## Known gaps

- **The sidecar's `max_connections=400` covers one suite per agent, not two.**
  Measured rather than assumed. gp-api caps Prisma at `connection_limit=5`
  across 4 workers; election-api sets no `maxWorkers` but has only 5 DB-backed
  files, so at most ~5 workers open a pool — ~25 connections per run once omni
  #2161's cap is in place, the same order as gp-api.
  - 400 covers ~15 agents each running **one** package's DB-backed suite. That
    is the realistic case: an agent fixes a bug in one service.
  - It does **not** cover ~15 agents each running **both** suites at once
    (~50 each, ~750). That case fails with `too many clients already`, which
    is loud and survivable — which is why the sidecar was sized so the
    connection ceiling is reached before memory is.
  - Cheap to fix if it bites: memory is 3 GB against a ceiling that uses
    ~1.65 GB, so 400 can go to ~600 in a one-line change without resizing.
- **Single front door.** Every `@bugboss` message should route to the Boss,
  which can see all incidents, rather than to a focused incident agent, with
  pass-through for messages answering a blocked agent's question. Design
  agreed; not yet built.
- **Agents cannot propose a fix in `ops` when the cause is BugBoss itself.**
  Unconfirmed whether this works end to end.
- **`bugboss/bedrock/` has never executed against live Bedrock.** The routing
  fix is asserted at boot and refuses to launch on Converse, so a misroute is
  now loud. But signature replay itself is exercised for the first time in
  production. If it is subtly wrong, `prefixMismatchBehavior` defaults to
  `drop_block` and the result is the current behaviour — no thinking carried
  across a restart — plus an `anthropic_input_transformations` diagnostic.
  Bounded by the status quo, but worth watching on the first long incident.

## Cost

Measured, not estimated: **$4.23** for a 33-minute incident, **$7.69** for a
2.1-hour one, **$18.51** for a 9h18m one, all on Opus 5. Cache is ~90% of the
bill.

The 1h cache TTL fix addresses the largest single line item: on the 9h18m
incident, **41% of the bill was the same context written six times over**,
because every tool call blocking on a human or a deploy outlived the
300-second default. Across seven sessions the longest gap that still hit was
216s and the shortest that missed was 331s, and every miss followed `monitor`
or `contact_human`.

Levers not yet pulled: per-phase model routing, shorter loops. Cache *write*
grows with run length, so cost still rises faster than linearly with
investigation time.

## What reading a real run taught us

From a full read of incident 1's transcript (9h18m, 92 turns), with incidents
2, 5, 8, 9, 10 and 11 as comparison. These are behavioural findings. None of
them would be caught by a test.

- **The agent stated a wrong root cause with confidence, shipped it, and
  caught it by luck.** It blamed `execErrState: 'Alerting'` for converting a
  Loki failure into a false page — coherent, well-evidenced, wrong. It
  survived two rounds of human contact and a delegate approval. What broke it
  was happening to find a second firing on waking from an 8-hour wait, testing
  the story against it, and watching it fail four ways.

  The transferable trap: **an `Error` annotation persists, so it proves a rule
  failed at some point, not when it notified.** The agent had `activeAt` two
  days before the page in hand on turn two and reasoned past it for forty
  minutes.

  Nothing forced it to ask whether its mechanism explained the *delivery* or
  only the *state*. A candidate fix is requiring a stated, checkable
  prediction before `report_root_cause` is accepted. Unvalidated.

- **Turn efficiency is not a cost lever.** 47 bash calls, 47 distinct, zero
  exact repeats, zero overlapping file reads, roughly 4 wasted turns of 92.
  There is no hidden thrash behind the cost table. Shortening the loop will
  not pay; the cache work was the right target.

- **Blocked on a human, the agent does nothing, and the prompt tells it that
  is free.** The 8-hour `contact_human` block is exactly one turn: no further
  investigation, no pre-drafted post-mortem, no periodic PR check. The prompt
  says *"monitor costs one turn whether it returns in ten seconds or two
  days"* — true for turn accounting, false for cost, and the 1h TTL only
  moves the boundary rather than removing it. **That line should not survive
  as written.**

  Incident 5 shows the better behaviour is available rather than absent: same
  situation, same hour, it chose to wait rather than ask a third time, then
  refreshed impact, confirmed nothing was escalating, and posted state to the
  thread.

## Process notes

- **An approving delegate round is not the same as earlier findings being
  withdrawn.** Twice in one hour a first pass raised a fault, a later run
  approved without it being fixed, and the fault landed: #127's retention
  checks and #123's `WebClient` retry policy. Both were caught afterwards by
  the authoring agent reviewing its own merged diff. Read the earlier rounds.

- **Do not re-merge the base into a branch under review unless it conflicts.**
  The base moved six times during this effort against 6-13 minute reviews.
  Re-merging on each clean move supersedes the in-flight review and never
  converges. GitHub computes the PR diff against the current base anyway.

- **A watcher that can only report good news is indistinguishable from a
  broken one.** Two monitors failed silently here in opposite ways: a filter
  on `delegate-reviewer` that never matched `delegate-reviewer[bot]`, and a
  `// "none"` default that never fired on an empty string. Both looked like
  patience. Filters need a negative case, or silence has to be treated as
  unknown rather than as "not yet".

- **`LATE_COLUMNS` in `Db.open` is BugBoss's only migration path** and holds
  one entry. It silently does nothing for a column added to a table that does
  not exist yet. Fine today because `schema.sql` creates every table first; if
  that ordering ever changes, the failure is invisible.

- **`truncateOutput` returns more than the max it is handed.** It appends head,
  tail and a marker naming how much it dropped, and that marker grows with the
  size of what it elided. So every caller holding it to a budget has a margin
  that shrinks as inputs grow, rather than a constant one. Found while clamping
  the heartbeat nudge; the three callers there are now clamped with worst-case
  tests asserted at absurd inputs. The overshoot itself is unfixed and affects
  every other caller. A bound checked at a size somebody chose is a bound that
  holds until somebody waits longer.

- **A killed agent session is indistinguishable from one that finished.** The
  session writer appends per event and the file closes with the last one: no
  exit record, no error entry, no signal or deadline marker. S3 `LastModified`
  sits within a second of the last event for both a clean exit and a kill.
  A 9.5-hour, $42.71 run that died reads exactly like one that completed.

- **Three of seven runs were killed at the same lifecycle position**: checks
  green, PR approved, about to involve a human on the merge. Two state the
  intent in the turn immediately before dying. Durations were 0.62h, 0.65h and
  9.52h, so a 15x spread rules out a single wall-clock deadline and points at
  the transition into the merge wait. Going further needs ECS task exit codes
  or Boss-side logs; the session files do not carry a cause.

- **Nothing knows to resume a killed run.** Incident 5's deliverable survived
  intact — PR approved, 35/35 checks green, root cause recorded — and a fresh
  session could finish it for an estimated $2-3. But its thread's last message
  is *true*, so the silence reads as patience and nobody picks it up. The loss
  is not the 291k tokens of context, it is that the run is never noticed dead.
