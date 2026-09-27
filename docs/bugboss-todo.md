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

| Branch | What | State |
| --- | --- | --- |
| `feat/bugboss-incident-links` (#121) | link incidents to their threads; + failure-alert follow-up | approved, follow-up in progress |
| `feat/bugboss-recurrence` (#119) | detect a returning incident | approved, retargeting onto integration |
| `feat/bugboss-wait-heartbeat` (#120) | nudge when a wait on a person stalls | retargeting onto integration |
| `feat/bugboss-ci-rerun` | let an agent re-run failed CI, with flake discipline | in progress |
| `feat/bugboss-incident-report` | full report as a Slack document; ~200-word thread budget; plain-terms default | in progress |
| review audit | verify every review finding survived the merge | 4 fixes pushed, awaiting verdict |

## Open questions and known gaps

- **Agents cannot run DB-backed tests — no container runtime.** ECS Fargate
  has no Docker socket, so testcontainers cannot start a database. Being
  worked; likely a sidecar database in the task definition or a remote
  Docker host.
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
- The GitHub App is installed on **all** org repos (`repository_selection:
  all`), which is wider than the agent's prompt claims.

## Deploy state

Production runs `refactor/bugboss-single-role` (`8cd2f79`), built and
deployed by hand because ops PRs could not merge. **`main` is behind it.**
Anything that merges to `main` before #118 reverts the single-role change and
breaks every agent launch.
