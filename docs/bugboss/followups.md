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
| 5   | Add `bugbossImageUri` config + an image build step   | `deploy/deploy.sh`, `.github/workflows/deploy.yml` | todo     |

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
