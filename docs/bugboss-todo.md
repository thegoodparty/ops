# BugBoss — outstanding work

Working state for the BugBoss build-out, kept here so it survives a context
reset. Updated as things land. Not product documentation.

## Blocked on a human

- **Merge the omni PRs the incident agents opened.** #2149, #2151, #2152,
  #2153 approved and green; #2150 merged. Three agents are blocked waiting.
- **Merge #118** (`integration/bugboss-v1`). Needs a human codeowner. It is
  **not safely divisible** — cherry-picking pieces reintroduces the ordering
  hazard that broke deploys repeatedly, because #109's single-role change is
  load-bearing for agent launches and later branches assume it.
- **Incident 8 needs a CallHub billing top-up.** Vendor account out of
  prepaid credits. No code defect. The agent cannot check or fix the balance.

## Done, do not redo

- Slack scopes: `chat:write`, `app_mentions:read`, `channels:history`,
  `usergroups:read`, `reactions:read`, `reactions:write`, `files:read`,
  `files:write`.
- Slack Event Subscriptions enabled; **Socket Mode off** (it was swallowing
  every event — that was the whole reason inbound Slack never worked).
- Slack Interactivity enabled, request URL `https://bugboss.goodparty.org/slack`.
- GitHub App `bugboss-gp`: `actions: write` granted (CI re-runs).
- `BUGBOSS` secret: `GITHUB_APP_PRIVATE_KEY` un-double-encoded,
  `SLACK_ROTATION_GROUP_ID` set to `@product-bugs` (`S0C43CP2XKR`), dead
  `BUGBOSS_MCP_JWT_SECRET` removed, `BUGBOSS_MAX_AGENTS` cap removed.
- Grafana `dev-alerts` webhook contact point: timestamp header, basic auth,
  `maxAlerts: 0`, resolve messages off.

## In flight (branches targeting `integration/bugboss-v1`)

All agents paused 2026-09-27 evening. Nothing is lost that was pushed.

| PR | Branch | Base | State when paused |
| --- | --- | --- | --- |
| #121 | `feat/bugboss-incident-links` | integration ✔ | approved; failure-alert follow-up pushed, second verdict pending |
| #122 | `feat/bugboss-ci-rerun` | integration ✔ | opened, verdict pending |
| #120 | `feat/bugboss-wait-heartbeat` | **still `main`** | approved against `main`; **needs merge of integration + retarget + fresh verdict** |
| #119 | `feat/bugboss-recurrence` | **still `main`** | approved against `main`; **needs merge of integration + retarget + fresh verdict** |
| #123 | `feat/bugboss-incident-report` | integration | three review blockers closed, verdict pending |
| — | `feat/bugboss-test-runtime` | integration | investigation only, no PR yet |
| — | review audit | commits direct on integration | 4 fixes pushed; last verdict pending |

**Retargeting #119 and #120 is the fiddly part.** Both were cut before the
integration branch existed, and `agent/tools.ts` has now been independently
redesigned by four branches. Each should resolve its own merge rather than
one actor batching them — that is where a merge that compiles and is subtly
wrong would come from. #120's author deliberately duplicated #112's
`HandOffPort` and `Escalation` names so the conflict resolves by deleting one
copy.

## Open questions and known gaps

- **A top-level `bugboss/*.test.ts` never runs.** `npm test`'s glob is
  `bugboss/**/*.test.ts`, which `sh` expands as `bugboss/*/*.test.ts`. A test
  file at the top of `bugboss/` is silently skipped. Verified with a canary.
  Every test today is in a subdirectory, so nothing is being missed — but the
  next person to add one at the top level loses it with no error.
- **The custom Bedrock `InvokeModel` provider is not in the path.** Live
  sessions show `"api":"bedrock-converse-stream"` and **zero thinking-block
  signatures**. The provider exists specifically because Converse drops
  empty-text thinking blocks with live signatures, and **resume depends on
  those surviving**. Investigation was spawned and lost to a laptop suspend;
  needs re-running. Resume is *not* proven broken — it has only ever been
  exercised on crashed 12-second sessions with no reasoning in them.
- **Single front door.** Every `@bugboss` message should route to the Boss
  (which can see all incidents) rather than to a focused incident agent,
  with pass-through for messages that answer a blocked agent's question.
  Design agreed; not yet built.
- **Recurrence: two requirements unconfirmed.** Whether any text-search tool
  was built, and whether the recurrence analysis is *required* at the
  `report_analysis` boundary rather than prompt-only. Also whether an agent
  can propose a fix in `ops` when the cause is BugBoss itself.
- **Cost.** ~$4.23 for a 33-minute incident, ~$7.69 for a 2.1-hour one, on
  Opus 5. Cache is ~90% of the bill and cache *write* grows with run length,
  so cost rises faster than linearly with investigation time. Levers not yet
  pulled: per-phase model routing, shorter loops.
- **`@product-bugs` contains only one person.** Rotation is not populated.
- ~~**Agent output policy is agreed but only partly built.**~~ Built in #123.
  Every path into a thread is now capped at `THREAD_PROSE_CHARS` (~200 words)
  and refuses rather than splits: the `/thread` route 400s, `report_resolved`'s
  evidence and `hand_off`'s brief reject ahead of their transition, and
  `contact_human`'s ask keeps its tighter 700. The post-mortem is the one
  uncapped field, because it leaves as the closing report file rather than as
  thread text. The prompt carries the rule and a worked
  identifiers-vs-behaviour pair. What is **not** done: nothing measures the
  word counts of live threads, so whether the real output actually moved from
  370–426 words down toward 200 is still unobserved.
- The GitHub App is installed on **all** org repos (`repository_selection:
  all`), which is wider than the agent's prompt claims.

## Decided

- **Agents run omni's DB-backed tests against a Postgres sidecar** in the
  BugBoss task, reachable on loopback because containers in one task share a
  network namespace. Chosen over a remote Docker host (root-equivalent on a
  persistent host, for an agent that reads attacker-writable log lines —
  a genuinely new capability rather than one it already had), Testcontainers
  Cloud (a vendor, a credential, and the same capability moved elsewhere) and
  CI-only (still the authority, but a ~14 minute loop per iteration). It costs
  nothing: the task already bills for 4 vCPU and 16 GB. Isolation across the
  fifteen agents is omni's harness, unchanged — it was already built for
  concurrent checkouts on one machine. Needs the companion omni PR that lets
  the harness take a Postgres it did not start.

## Deploy state

Production runs `refactor/bugboss-single-role` (`8cd2f79`), built and
deployed by hand because ops PRs could not merge. **`main` is behind it.**
Anything that merges to `main` before #118 reverts the single-role change and
breaks every agent launch.
