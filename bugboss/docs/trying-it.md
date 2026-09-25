# Trying BugBoss before it sees real traffic

There is no dev environment: BugBoss is prod-only by decision, because a
second instance means a second thing watching the same alerts. So "safe to
try" here comes from **nothing routing traffic at it**, not from an isolated
copy. A deployed BugBoss with no notification policy pointed at it receives
exactly nothing and costs the price of one idle Fargate task.

That makes the order below the point. Each step adds one thing.

## 0. First, make it additive

Add the parallel raw Grafana route (`followups.md`, "Ship regardless").
After that every alert reaches `#dev-alerts` through Grafana's own
integration, independent of BugBoss. Now BugBoss can crash, be redeployed,
or be switched off, and the worst case is exactly today's behaviour.

This is also the kill switch. One UI action repoints the policy away.

## 1. Run it locally, triage only

The cheapest loop. Ingest, triage, and a Slack thread, with no agents
spawned at all:

```
BUGBOSS_MAX_AGENTS=0 \
BUGBOSS_BUCKET=some-scratch-bucket \
BUGBOSS_SLACK_CHANNEL_ID=C_YOUR_TEST_CHANNEL \
SLACK_BOT_TOKEN=xoxb-... \
GRAFANA_WEBHOOK_SECRET=anything-you-like \
npm run bugboss
```

`BUGBOSS_MAX_AGENTS=0` holds the dispatcher's circuit open, so incidents
open, get triaged, and post threads, and nothing clones omni or calls
Bedrock. Point it at a channel that is not `#dev-alerts` and you can watch
the whole front half without touching anything real.

It needs a real S3 bucket even locally: the database mirrors there on every
write, which is the durability the whole resume design rests on.

## 2. Send it an alert by hand

```
GRAFANA_WEBHOOK_SECRET=anything-you-like \
npx tsx bugboss/scripts/send-alert.ts
```

Defaults to `http://127.0.0.1:3000/grafana` and a single firing alert.
Useful flags:

| Flag | Why |
| --- | --- |
| `--file ./body.json` | Replay a real payload copied out of Grafana's delivery log |
| `--url https://bugboss.goodparty.org/grafana` | Aim at the deployed one |
| `--resolved` | The resolved notification for the same alert |
| `--fingerprint X --starts-at ...` | A firing episode is (fingerprint, startsAt). Same pair is a duplicate; a new `startsAt` is a new episode, which is how you exercise recurrence |

A `401` means verification failed, not that BugBoss is down. Almost always
the secret differs, or your clock is more than 300 seconds off the server's.

## 3. Deploy it, still routing nothing

Merging deploys it. With no notification policy pointing at it, it sits
there serving `/health` and receiving nothing. Send it the same hand-made
alert with `--url` and you have exercised the real container, the real ALB,
the real secret and the real IAM role, on one alert you chose.

This is the step that catches the class of problem that actually bit during
the build: an unwritable database path, a setting the task definition never
passed. Both were silent and total, and both would have shown up here.

## 4. Route one rule at it

Pick a noisy, low-stakes alert and point a notification policy route at the
`bugboss` contact point. Leave the raw route in place, so the alert still
reaches `#dev-alerts` the old way as well.

Now an agent runs for real: a clone of omni, Bedrock calls, possibly a PR.
Watch the first few end to end. The failure you are looking for is not a
crash, it is a confident wrong answer.

## 5. Widen

More rules, then eventually turn the direct-to-Slack route off. That last
step is what makes the prod-critical allowlist matter: until then every
alert is visible in the channel anyway, so nothing needs to `@` anyone.

## What you cannot try this way

The checks in `followups.md` under "Checks to run" — signature replay across
a resume, compaction, the Bedrock body shape. Those need a real agent on a
real incident, so they come after step 4, and each one invalidates real work
if it comes back wrong.
