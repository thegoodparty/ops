# BugBoss — outstanding work

Working state for the BugBoss build-out, kept here so it survives a context
reset. Updated as things land. Not product documentation.

## Blocked on a human

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

## Known gaps

- **A top-level `bugboss/*.test.ts` never runs.** `npm test`'s glob is
  `bugboss/**/*.test.ts`, which `sh` expands as `bugboss/*/*.test.ts`. A test
  file at the top of `bugboss/` is silently skipped. Verified with a canary.
  Every test today is in a subdirectory, so nothing is being missed — but the
  next person to add one at the top level loses it with no error.
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
