# BugBoss follow-ups

Everything that needs a human, accumulated during design and the build. Kept
current as chunks report. Design spec: `design.md`. Build status:
`build-plan.md`.

## Blocking a first real alert

Nothing downstream works until these are done.

|     | What                                                 | Where                                              | Status   |
| --- | ---------------------------------------------------- | -------------------------------------------------- | -------- |
| 1   | Create the `bugboss` ECR repository                  | AWS console                                        | **done** |
| 2   | Create a **new** `bugboss` Grafana contact point      | Grafana UI                                         | todo     |
| 3   | Repoint a notification-policy route at it            | Grafana UI                                         | todo     |
| 4   | Populate the `BUGBOSS` Secrets Manager secret        | AWS console                                        | todo     |
| 5   | Add `bugbossImageUri` config + an image build step   | `deploy/deploy.sh`, `.github/workflows/deploy.yml` | **done** |

### The contact point, and three settings that must be right

Pointed at `https://bugboss.goodparty.org/grafana`, with:

```
hmacConfig.timestampHeader: "X-Grafana-Alerting-Timestamp"
disableResolveMessage:      false
maxAlerts:                  0      (uncapped)
```

**The timestamp header is silent if missed.** Grafana only sends one if the
contact point explicitly names it; there is no default. Without it Grafana
signs the body alone, which is replayable, so ingress rejects every delivery.
The symptom is "the webhook does nothing", with no error anywhere.

**Do not edit `gpbot-alert-filter` to achieve this.** Its `maxAlerts: 20` and
`disableResolveMessage: true` are correct *for that consumer* and documented
as such: the filter Lambda runs a Loki query and a model call per alert, so a
delivery of hundreds would exceed the webhook timeout and be retried into
duplicate Slack posts, and its handler drops resolved notifications anyway.
It also points at a different URL with different auth. BugBoss needs its own
instance of the same resource, not a change to one that works.

**Where it should be defined is an open choice.** omni already provisions
contact points through `@pulumiverse/grafana` in
`packages/gp-api/deploy/components/grafana.ts`, and all three settings are
expressible there. `ops` has no Grafana provider, token or credential, so
doing it here means a new dependency plus a service account. Putting
BugBoss's contact point in gp-api's stack is also wrong. Recommendation: the
UI now, an ops-side provider later only if it earns one.

**The route is manual regardless of who provisions what.** omni's own comment
says the policy tree "was configured by hand in Grafana Cloud before this
repo provisioned any alerting" and is deliberately not managed in code, so a
contact point routes nothing until a human repoints a route. That is also the
kill switch the design relies on, and the same operation as the parallel raw
route below.

### What goes in the `BUGBOSS` secret

One JSON object. Two keys are checked at boot and the container exits
without them, so a half-populated secret is a crash loop, not a degraded
service. Everything else is checked where it is used.

| Key | Needed | What it is |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | **at boot** | `xoxb-…` for the app that posts incident threads |
| `BUGBOSS_SLACK_CHANNEL_ID` | **at boot** | The channel threads open in (`#dev-alerts`) |
| `SLACK_SIGNING_SECRET` | for replies | Verifies inbound Slack events; without it the relay rejects every one |
| `SLACK_BOT_USER_ID` | for replies | So the bot does not answer itself |
| `SLACK_ROTATION_GROUP_ID` | optional | User-group to `@`. Falls back to `<!here>` |
| `GRAFANA_WEBHOOK_SECRET` | for alerts | HMAC on the webhook body |
| `GRAFANA_BASIC_AUTH_PASSWORD` | for alerts | Only if the contact point uses basic auth |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | for evidence | Runs the alert's own LogQL before triage |
| `GITHUB_TOKEN` | for fixes | The agent opens PRs with it. Must not be able to merge |
| `BUGBOSS_MODEL_ID` | optional | Incident agent model. Defaults in code |
| `BUGBOSS_TRIAGE_MODEL_ID` | optional | Defaults to `us.anthropic.claude-sonnet-5` |

`BUGBOSS_BUCKET`, `BUGBOSS_AGENT_ROLE_ARN`, `BUGBOSS_PUBLIC_URL` and the
region come from the task definition. Do not duplicate them here.

## Ship regardless, and ideally first

**Add a parallel raw route in Grafana** so the alert firehose always reaches
Slack through Grafana's own integration, independent of BugBoss. Alertmanager's
`continue: true` keeps evaluating sibling routes, and `dev-alerts` already
exists as both a Slack and a webhook contact point, so this is a policy edit
rather than a build.

After that BugBoss is purely additive: it can crash, be redeployed, or be
switched off entirely, and the worst case is exactly today's behaviour. It is
also the kill switch — one UI action repoints the policy away from the
webhook.

## Before the MCP server is usable

|     | What                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7   | Register a Google OAuth client (pre-registered, not DCR — Google does not support it)                                                                                                                                                |
| 8   | Set the Google consent screen to **Internal** if the GCP project is inside the Workspace org. Strongest control available and it costs nothing; if moving the project is annoying, the three claim checks in code are adequate alone |
| 9   | Slack app: scopes and event subscriptions for the relay                                                                                                                                                                              |

## Decisions only you can make

- **What is on the prod-critical allowlist.** These are the signals that ping
  the channel at open, in parallel with the agent. Everything else opens a
  thread silently.
- **The rotation.** Who is in it, shift length, and the response targets in
  the spec's _What the rotation owes_ table. The spec assumes a rotation
  exists and deliberately does not invent one.
- **Talk to Nikao about `alert_filter`.** `packages/gp-ai/alert_filter/` is
  theirs, landed 2026-09-16 in omni PR #1836, and has been running in
  `mode = "shadow"` in prod since. BugBoss substantially supersedes it: same
  Grafana webhook, same `KnownCause` evidence idea, same triage decision. Not
  a call to make in a doc.

## Checks to run, each of which invalidates real work if it comes back wrong

|     | Check                                                                            | Why it matters                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `curl -i` the 401 **through the ALB** and confirm `WWW-Authenticate` survives | Automated Node-side already (`bugboss/mcp/serve.ts` + a test asserting the challenge). The ALB hop is the part still unverified, and it is the one that silently kills OAuth discovery |
| B   | Kill an agent mid-turn, resume, confirm thinking signatures replay               | The whole resume design rests on this                                                                                                                                                                                                 |
| C   | Compact a session, restore from S3, confirm resume respects the compaction point | Separate failure from B                                                                                                                                                                                                               |
| D   | Reproduce the Converse empty-thinking drop on Opus 5                             | Justifies the InvokeModel provider we built. Confirmed in source, not against a live call                                                                                                                                             |
| E   | Five Bedrock body-shape questions, one live call settles all                     | `output_config: { effort }`, `block_binding: { prefix_mismatch_behavior }` (resume depends on it), `amazon-bedrock-invocationMetrics` field names, `anthropic_beta` as a body field, `context_management` / `clear_thinking_20251015` |
| F   | Measure a real `npm ci` in the container                                         | Sizes how many concurrent fixers are viable                                                                                                                                                                                           |

## Found while wiring Phase 2, still open

The composition root is the first thing that sees all nine chunks at once.
These are what did not line up. Each is either resolved in `bugboss/index.ts`
with a note on the cost, or still open.

|     | What                                                                                                                                                                                                                                                  | State                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| G   | `sessionKeyFor` in `bugboss/agent/session.ts` writes `sessions/<id>.jsonl`, but the Slack agent's `read_agent_session`, the MCP session reader and the S3 lifecycle rule all read `sessions/incident/<id>/`                                            | worked around: the launch overrides `BUGBOSS_SESSION_REF`. The default and its test still encode the old path |
| H   | `RelayEvent` has a `pr_needs_merge` case, one of the three things the design says earns an `@`, but nothing can emit it: the Boss does not learn a PR exists until `report_resolved`, which is after the merge already happened                        | open. Needs either a tool-API field or the agent posting it     |
| I   | Chunk 4's tool API posts its own transitions through `ThreadPoster` while chunk 7's relay renders the same transitions. Both are wired, split by who knows what: the relay does `opened` and `prod_critical_signal`, the tool API does the rest         | resolved, but the two renderers should be reconciled            |
| J   | `hand_off` reaches the rotation only because `toolApiFor` wraps it and posts the mention itself. Escalation is one of the three `@`-worthy events and no chunk owned it                                                                                 | resolved in the composition root                                |
| K   | The Boss's own `ModelClient` (triage, correlation, the Slack agent) had no production implementation: `bugboss/bedrock` is a Pi api provider for the incident agent, not a one-shot client                                                              | resolved: `createBedrockModelClient` in `bugboss/index.ts`      |
| L   | `SlackAgentModel` had no implementation either. The default built here loops over the same `ModelClient` and persists the transcript per thread, which does **not** carry thinking blocks across a resume the way the incident agent's Pi session does | resolved with a documented floor; replace with a Pi harness if the Slack agent starts reasoning hard |
| M   | With no `agentRoleArn` configured, a launch hands the child empty AWS credentials and alarms, rather than refusing to launch                                                                                                                           | deliberate, so a local Boss still runs. Revisit if it ever fires in prod |
| N   | `bugboss/db/schema.sql` is read at runtime from `__dirname` and `tsc` does not copy it into `dist/`                                                                                                                                                    | resolved: `bugboss/Dockerfile` copies it beside the compiled `db/index.js` |

## Found by review, deliberately not fixed before the first PR

Three reviewers went over the whole diff. Most of what they found is fixed.
These are the ones left, with the reason.

| | What | Why it waits |
| --- | --- | --- |
| O | **Cost is never written.** `costUsd`, `tokensIn`, `tokensOut`, `cacheRead`, `cacheWrite` and `modelId` are set to 0 on insert and no `UPDATE` anywhere touches them. None of the nine `UPDATE incident SET` sites mentions a cost column | The Slack agent answers "what did we spend this week" with a confident **0** rather than an error, and the mandated spend-per-hour alert has no source. Either roll session usage onto the row at each transition, or delete the columns — implying a metric that does not exist is worse than not having it. `firstBadEventAt` is never written either, so time-to-detect is equally uncomputable |
| P | **A dead triage model looks exactly like a healthy one.** Both fallbacks in `triage/triage.ts` and `triage/correlate.ts` are info-level logs in modules with no `alarm()` at all | A wrong model id or sustained throttling makes every signal fall back to `new_incident`: no dedup, no attach, no suppression. A 15-alert burst then opens 15 incidents, spawns 15 agents and trips the circuit breaker, looking busy and productive throughout. Needs an `alarm()` on `fellBack` plus a fallback-rate metric |
| Q | **Illegal incident states are unconstrained.** Three `CHECK`s exist, all single-column enums. No cross-field check, no trigger, no Zod at the persistence boundary; `rowToIncident` is an unchecked spread | **This one is time-sensitive.** SQLite cannot `ALTER TABLE ADD CHECK`, the DDL is `CREATE TABLE IF NOT EXISTS`, and `Db.open` execs it over the restored snapshot with no migration runner. While the database is empty the constraints are free to add; after the first real alert they need a table rebuild that does not exist. Add them immediately after the in-flight fixes land, before anything is routed here |
| R | **Ids are undefended strings, and three of nine chunks already guessed the format wrong.** Real incident ids are bare decimals; `mcp/fixtures.ts`, `dispatcher/env.test.ts` and `triage/triage.test.ts` all assume `inc-N` | `nextIncidentId` does `MAX(CAST(id AS INTEGER)) + 1`, so anyone who follows the apparent `inc-` convention silently resets the counter to 1 and hits a primary-key violation inside a transaction. A Slack thread ts is also a bare numeric string, so an incident id passed as one matches nothing rather than throwing. Branded types would have caught this at compile time |
| S | **No human takeover exists, though the design documents one.** `owner` is written by exactly one statement repo-wide, inside `hand_off`. Nothing parses the documented `mine` reply, and `AssignActor`'s human variant is never constructed | Not a bug so much as an unbuilt feature with a comment claiming it is built. Needs a decision first: whether a human claiming an incident should also stop the running agent. Until then the comment, the directive types and the actor variant should go, or the feature should |

## Separate tickets, out of scope here

- **Fix the preview-database migration problem.** Editing a migration after a
  PR push breaks the preview DB with a checksum mismatch, surfacing as broad
  unrelated E2E failures. An agent iterating on a migration will hit this. The
  fix is making preview databases tolerate it (wipe on deploy, or similar),
  not restricting what agents may write.
- **pmf-engine IAM.** Its policy grants `ecs:TagResource` without the
  `"Condition": {"StringEquals": {"ecs:CreateAction": ["RunTask"]}}` guard, so
  that role can retag arbitrary resources. Unrelated to BugBoss, found while
  surveying.

## Decided, recorded so they are not relitigated

- **No Bedrock model invocation logging.** Our session transcripts are richer
  for debugging and we derive cost from Pi's per-turn usage, so it would be
  redundant. It would also duplicate potentially sensitive log content into a
  second store with different retention.
- **Slack agent is read-only in V1.** Merge, split, close, stop, restart and
  take-ownership are deliberately out. Ownership still changes by replying in
  the incident thread.
- **No subagent query budget yet.** Fan-out multiplies Loki reads, which is
  the line that bit us in August. Watch the bill rather than pre-solving it.
- **No cost ceiling across concurrent incidents.** The 15-agent circuit
  breaker bounds the pathological case; the merely expensive case is
  unguarded by design.
- **Agents may write migrations.** The restriction was solving the wrong
  problem; see the preview-database ticket above.
- **Account-wide log read is closed.** The agent role is scoped to four
  prefixes (`/aws/ecs/*`, `/ecs/*`, `/sst/cluster/*`, `/aws/lambda/*`), which
  is application logs but not VPC flow logs, GuardDuty, RDS or the VPN. The
  line is application versus infrastructure, and that rule matters more than
  the list.

## Changed outside BugBoss

- **A root `.dockerignore` now exists** (`node_modules`, `.git`, `.worktrees`,
  `.claude`). The build context was 583 MB of `node_modules` that neither
  image copies, since both run `npm ci` inside. This speeds up the delegate
  worker build too; it does not change either image's contents.
