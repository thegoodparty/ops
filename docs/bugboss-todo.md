# BugBoss — outstanding work

Working state for the BugBoss build-out, kept here so it survives a context
reset. Updated as things land. Not product documentation.

## Blocked on a human

- **Confirm BugBoss picks up the rewritten observability doc.** An omni PR is
  rewriting `docs/observability.md`, which BugBoss injects verbatim into every
  incident agent via `OBSERVABILITY_DOC_PATHS`. The text that taught the
  behaviour behind the 2026-09-28 query overage is still what ships until that
  lands. Establish how `OBSERVABILITY_DOC_PATHS` resolves at runtime -- baked
  into the image, fetched, or checked out -- and verify BugBoss reads the new
  text rather than a stale copy.

  The rest of that item is built. The agent's Grafana MCP surface is now an
  allowlist enforced twice (`--enabled-tools` plus our own filter of
  `tools/list`), the time range is clamped in our wrapper at 6h default and 24h
  maximum with the model told when it was widened, and the prompt's "add a
  limit to every query" line is gone. Two things the build established that
  the plan had wrong: `--enabled-tools` takes *categories*, not tool names,
  which is why the real allowlist lives in our filter; and the `alerting`
  category was dropped whole rather than restricted to reads, because in
  mcp-grafana 1.6.1 reading and mutating a rule are one tool and
  `--disable-write` does not remove it. The firing alert already arrives in
  full through `ingress/grafana.ts`.


- **Purge the 2026-09-28 alert-storm incidents from the database.** Between
  **13:17:09 and 13:22:30 EDT** BugBoss opened **incidents 13-79** — 67 in
  five and a half minutes — one per Grafana rule, each spawning an
  investigating agent. Almost none was a real fault. Grafana Cloud had begun
  returning **429** on Loki queries; with `exec_err_state: Alerting` (which is
  intended), every failed rule evaluation became a firing alert. Production
  was healthy throughout: ~7 error lines in five minutes across gp-api prod.

  These rows and their session transcripts are cruft and should be removed
  from the SQLite database and the S3 mirror, along with the agent work
  directories and notes.

  Identify them by **title and timestamp, not by id range** — the range has
  real incidents inside it. Storm incidents are titled
  `[PROD] [<route>] Route errors detected`, and most carry `[no value]` as the
  endpoint because the query returned nothing, so there was no
  `request_endpoint` label to interpolate. That `[no value]` is the cleanest
  single marker.

  **Inside the range but NOT cruft — read each before deleting anything:**
  - **#27 `[PROD] [People] Person id repoint blocked, left for manual
    resolution`** — not a route-errors alert at all. Almost certainly a real
    signal that happened to land mid-storm, and it says it needs manual
    resolution.
  - **#63 `[PROD] Alert notifications are failing to deliver`** — BugBoss
    correctly detecting the real fault. The one true signal the storm
    produced, and worth reading before anything is dropped.
  - **#79 `[PROD] High memory utilization`** — may be genuine, or may be
    BugBoss's own memory under 60+ concurrent agents. Read it first.

  **Outside the range, leave alone:** #12 `[PROD] Health check probe failures`
  at 13:07:32, ten minutes before the first storm incident and unrelated.

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
- **Signature replay is still exercised for the first time in production.**
  `bugboss/bedrock/` has now executed against live Bedrock: the routing fix is
  asserted at boot and refuses to launch on Converse, and the request body is
  verified field by field against a real `InvokeModel` call. What that first
  real request found was that the body itself was invalid — `block_binding`
  needs the `thinking-binding-controls-2026-08-01` beta, and every incident
  agent died on turn one until it was sent. Replay across a restart is the part
  still unproven, and it is worth watching on the first long incident.

  This bullet used to reason that a subtly wrong `prefixMismatchBehavior` was
  "bounded by the status quo". It was not: a bad thinking config fails the whole
  turn rather than degrading to no-thinking-on-resume. Do not assume a body
  field fails soft.

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
  said *"monitor costs one turn whether it returns in ten seconds or two
  days"* — true for turn accounting, false for cost. That line is gone. The
  prompt now says what the far side of a long block actually costs, and the
  waiting section says what is worth doing before settling into one: refresh
  impact, confirm nothing is escalating, post state, start the post-mortem.
  It also names the two things that are worse than one long block -- splitting
  it into re-issued short waits, and re-asking somebody who has already
  answered twice.

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

- **`LATE_COLUMNS` was loud by accident, not by design.** Measured rather than
  reasoned: `ALTER TABLE` on a missing table throws, `Db.open` rejects and the
  Boss exits 1 -- but only because `schema.sql` happens to run first, and the
  message named neither `LATE_COLUMNS` nor the entry. It now throws with the
  entry named. The real silence was elsewhere and had no detection at all: a
  column declared in `schema.sql` that nobody added to `LATE_COLUMNS` is absent
  in prod while the suite stays green. `Db.open` now builds a throwaway
  `:memory:` database from the same DDL and diffs it against the live one,
  alarming on every column the live database lacks. That one alarms rather
  than refusing to boot, because it is reachable only in prod and a Boss that
  will not start cannot investigate why.

- **`truncateOutput` now honours its maximum.** It used to append head, tail
  and a marker naming how much it dropped, and that marker grew with the size
  of what it elided. Head and tail now shrink around the marker instead, with
  room reserved against `text.length` -- the largest number the marker could
  ever print -- so the fixed point resolves in one pass. A budget smaller than
  the marker alarms and still honours the cap.

  Correcting the premise: this was a *small-budget* bug, not a large-input one.
  The old slices summed to 0.9x the budget, so the overshoot only bit below
  roughly 390 characters, which is exactly why it surfaced at the heartbeat
  clamps. None of the three defensive clamps was relaxed: measuring the
  composed worst case showed `HEARTBEAT_ECHO_CHARS` at 200 was never forced by
  the overshoot, and the other two were sized against the thread budget for
  reasons the fix does not touch.

- **A killed agent session used to be indistinguishable from one that
  finished.** Every launch now writes a `bugboss_exit` entry naming how it
  ended, `SIGTERM`/`SIGINT` write one on the way out, and `readSessionOutcome`
  reads it back -- deliberately not last-record-wins, because a resumed file
  carries the previous launch's record under the turns that followed it.
  `read_agent_session` says which it was, so a human asking what happened no
  longer has to infer it from the last turn. `SIGKILL` still writes nothing,
  which is the point: the absence of a record is now evidence.

- **Three of seven runs were killed at the same lifecycle position**: checks
  green, PR approved, about to involve a human on the merge. Two state the
  intent in the turn immediately before dying. Durations were 0.62h, 0.65h and
  9.52h, so a 15x spread rules out a single wall-clock deadline and points at
  the transition into the merge wait. Going further needs ECS task exit codes
  or Boss-side logs; the session files do not carry a cause.

- **Resume was never the missing piece; noticing was.** The dispatcher
  already relaunches an agent-owned incident on its next tick whatever killed
  the last one, so incident 5 was not un-resumable -- it was un-noticed. A gap
  longer than `RESUME_ALARM_SECONDS` now alarms, and a killed run alarms when
  its child exits. The thread is not told: the relaunch is automatic and the
  agent learns of the gap through `resumed_after`.

  Still open: nothing outside the container watches the container. If the Boss
  itself is down, no in-process detection fires. That needs infrastructure,
  which is a `deploy/` change and deliberately out of this round.
