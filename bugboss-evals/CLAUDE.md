# bugboss-evals

Tells whether a BugBoss change, a model change included, made it better or
worse. Comment `bugboss eval` on an open ops PR: main's BugBoss and the PR's
run the same three scenarios three times each, and one advisory table comes
back on the PR. Nothing gates on it.

## What a run is

One BugBoss process, built from one ref, working one synthetic incident end
to end. The harness (`sim/run.ts`) is everything outside it:

- **Alert in.** The scenario's Grafana webhook, signed, refired until the fix
  deploys.
- **Telemetry.** Real Loki, Prometheus, Tempo and Grafana (`sim/stack/`), one
  stack for every run on the machine. Each run gets its own Grafana org, with
  production's datasource uids, whose datasources carry the run as a Loki and
  Tempo tenant and as an `eval_run` label that prom-label-proxy enforces. So a
  run sees only its own world.
- **GitHub is real**: `thegoodparty/bugboss-eval-sandbox`. Each run gets
  `eval/<run>/main`, the scenario's branch plus one empty commit. omni's
  ship-pr opens every PR with `--base main`, so a git hook in the run's HOME
  makes the agent's clone see its run's branch as main, and the harness moves
  each new PR onto it. It then plays the reviewer (an `Approved.` /
  `Recommendation: approve` review on every new head and every
  `delegate review`) and the human who merges once CI is green.
- **Merge means deploy.** The hidden check (`scenarios/<id>/check/`) runs on
  what merged. If it passes, the telemetry flips healthy. It never runs in the
  sandbox's visible CI.
- **Slack** is `sim/slack.ts`. The on-call human is scripted: any bot message
  with a question mark gets the scenario's matching facts, once each, or
  "I don't know more, proceed."
- **AWS.** BugBoss resolves credentials from a local container-credential
  endpoint serving the workflow's Bedrock-only role, so every other call is
  denied. S3 (its snapshot and session files) is `sim/s3.ts`, on disk.
- **Postgres** for omni's tests is one container per run, as
  `OMNI_TEST_POSTGRES_URL`.

The BugBoss options this needs are all unset in production:
`BUGBOSS_GITHUB_TOKEN_FILE`, `SLACK_API_URL`, `BUGBOSS_OMNI_REPO`,
`BUGBOSS_WORK_ROOT` and `AWS_ENDPOINT_URL_*`.

## What the table says

Per scenario and in total, per side: gates passed (closed, fix check passes
after merge, CI green at every merge, nothing pushed to main), mean cost and
mean time from alert to close. Quality is the candidate's wins-losses-ties
from `core/judge.ts`: blind (`core/blind.ts`), order-swapped, over each pair's
root cause, fix diff and post-mortem, with a sign test. Tokens by class are in
the details. Cost is priced from `core/price.ts` over the agents' session
transcripts; the Boss's own calls are not in a transcript and are not counted.

## Trust

The workflow runs from main, so a PR cannot change how it is measured, and
its own harness changes take effect only once merged. The PR's BugBoss, and
the hidden check over code its agent wrote, run as `bugboss-eval`, a user with
no sudo, no workflow token and no App key. The key is held only by
`sim/token.ts`, which mints tokens scoped to the sandbox repository and
rewrites the file BugBoss reads every fifteen minutes.

## Running it

In CI: the `bugboss eval` comment. It needs the `bugboss-eval` environment
(main only) with `BUGBOSS_GP_APP_ID`, `BUGBOSS_GP_INSTALLATION_ID` and
`BUGBOSS_GP_PRIVATE_KEY`.

Locally, at zero model spend, with a scripted model that applies each
scenario's proving fix (`sim/stub-model.ts`):

    npx tsx bugboss-evals/sim/token.ts /tmp/token &   # needs the App env vars
    npx tsx bugboss-evals/sim/compare.ts run --baseline HEAD --candidate HEAD \
      --scenarios ecanvasser-sync-timeout --reps 1 --token-file /tmp/token \
      --out /tmp/evals --stub ~/Repos/thegoodparty/omni

Without `--stub` it spends real Bedrock money.

## Adding a scenario

A directory under `scenarios/` with `scenario.json` (`core/scenario.ts`), the
alert, a telemetry generator, a vetted `reference.md` and a hidden check that
exits 1 at `baseSha` and 0 at `provingFixSha` (`scenarios/prove.test.ts`
proves it when pointed at an omni clone). Add it to `SCENARIO_IDS` and the
workflow matrix, then re-seed the sandbox:
`npx tsx bugboss-evals/sim/sandbox.ts seed ~/Repos/thegoodparty/omni`.
