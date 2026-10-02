# bugboss-evals

Tells whether a change to the incident system, a model change included, made
it better or worse. Comment on an open ops PR and main's system and the PR's
run every scenario, and one advisory table comes back on the PR. Nothing
gates on it.

The system under test is a black box. The harness reaches it only through
the alert webhook, Slack, GitHub, the telemetry stack and the model provider,
and it scores only what came back out through those same surfaces. So two
systems built nothing alike, one agent or a swarm or a state machine, are
measured on the same terms.

| Comment | Runs | Each run stops at | Spend cap |
| --- | --- | --- | --- |
| `bugboss eval` | 1 rep per scenario, 6 pairs | the PR opening | $40 |
| `bugboss eval full` | 3 reps per scenario | the close | $200 |

The model is the Anthropic API, paid for with `ANTHROPIC_API_KEY` from the
repository's secrets. Nothing in the eval touches AWS or `deploy/`.

One rep of six scenarios is six pairs, the fewest the sign test can call.
Each matrix job holds an even share of the cap, and every run in it stops,
ending `spend_cap`, once their live sessions price at 90% of that share.

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
- **GitHub is a fake** (`sim/github/`), started by `compare.ts` on the
  runner. It serves HTTPS as github.com and api.github.com on 127.0.0.1:443
  with its own CA: git smart HTTP over a bare repository, and the REST and
  GraphQL subset BugBoss, gh 2.96.0 and the harness use. The workflow maps
  both names to 127.0.0.1 in `/etc/hosts` once every real fetch is done, so
  BugBoss, the agents and gh run unchanged; the harness puts the CA in the
  system store and hands BugBoss `NODE_EXTRA_CA_CERTS`. Any token works.
  The sandbox, `thegoodparty/bugboss-eval-sandbox`, is seeded at the start
  of every job from an omni clone (`sim/sandbox.ts` `seed()`): `main` is
  one empty commit, and `scenario/<id>` a snapshot of the scenario's base on
  it. Each run gets `eval/<run>/main`, the scenario's branch plus one empty
  commit. omni's
  ship-pr opens every PR with `--base main`, so a git hook in the run's HOME
  makes the agent's clone see its run's branch as main, and the harness moves
  each new PR onto it. It then plays the reviewer (an `Approved.` /
  `Recommendation: approve` review on every new head and every
  `delegate review`) and the human who merges once CI is green, or, when the
  scenario's `human.merge.after` is `asked`, only once the thread shows the
  agent waiting on a merge and `delaySeconds` have passed, saying nothing.
- **CI** is the scenario's `ci` commands, which the fake asks the harness to
  run on every new PR head: a checkout of the head with the prebuilt
  `node_modules` hardlinked in, as the run-as user. Keep them targeted.
- **Merge means deploy.** The hidden check (`scenarios/<id>/check/`) runs on
  what merged. If it passes, the telemetry flips healthy. It never runs in the
  sandbox's visible CI.
- **Slack** is `sim/slack.ts`. The on-call human is scripted: any bot message
  with a question mark gets the scenario's matching facts, once each, or
  "I don't know more, proceed."
  It also volunteers `human.volunteer` lines unprompted, each once, when the
  run first reaches a milestone (`sim/human.ts`).
- **The world moves.** `world.baseMovesAfter: "approved"` pushes one
  unrelated commit onto the run's base right after the first approval and
  makes the fake refuse (405) to merge a PR behind it; that refusal is the
  `merge_refused` milestone.
- **AWS is fake.** BugBoss resolves credentials from a local
  container-credential endpoint serving made-up keys; the only AWS it can
  reach is `sim/s3.ts` (its snapshot and session files, on disk) and the model
  proxy, and neither checks a signature.
- **The model** is the Anthropic API, reached through a counting proxy
  (`sim/model-proxy/`) that holds `ANTHROPIC_API_KEY`. The proxy presents the
  face the runtime speaks (`modelProtocol` in `sim/runtimes/`): BugBoss sends
  Bedrock InvokeModel calls to `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` and the proxy
  translates them, so BugBoss is unchanged and never sees the key. It logs
  every request's model, usage and assembled response and keeps the running
  spend that the cap reads. It is the only place turns and cost come from:
  nothing reads a transcript, a session file or the system's own accounting.
- **Postgres** for omni's tests is one container per run, as
  `OMNI_TEST_POSTGRES_URL`.
- **npm and omni's dependencies.** Once per base, before the runs start, an
  omni tree is installed and built as the run-as user through
  `scenarios/_lib/setup-omni.sh`. That warms one npm cache, which every run's
  HOME links `.npm` to, and CI and the hidden check hardlink the tree's
  `node_modules` when the lockfile is unchanged. The workflow caches both by
  base sha.

## What a run leaves behind

Everything the world saw of the run, in order, as `activity.json` in the
run's output directory (`core/activity.ts`): each alert delivery, every Slack
message in both directions with its edits, every file uploaded to the thread,
each pull request opened and updated, CI results, reviews, a refused merge, the
merge, whether the hidden check passed on what deployed, and the close. Every
message is kept whole; nothing is cut by length. Alongside it, `diff.patch`
from the scenario's base to the merge commit (or the first pull request's
head when nothing merged) and the proxy's request log.

That is the whole record. There is no transcript, tool call or incident row
in it, because the judge must not be able to tell how a side was built.

## What the table says

Per scenario and in total, per side:

- **Gates**, from the fake GitHub and the close: closed, the hidden check
  passed on what merged, CI green at every merge, nothing pushed to main. On
  the fast tier the merge gates read n/a.
- **Turns and estimated cost**, from the proxy log priced by `core/price.ts`.
- **Minutes from the alert** to the pull request, the merge and the close.

Then quality: the candidate's wins-losses-ties from `core/judge.ts`, blind
(`core/blind.ts`), order-swapped, judged twice, with a sign test. For each
pair the judge sees the alert, the scenario's `reference.md`, and for each
side the rendered timeline and the fix diff. It answers, per side: was every
transition communicated in Slack and promptly; was the root cause right; did
the mitigation and the systemic fix resolve it; how did it handle the human,
including the lines `reference.md` marks as wrong; then which side handled
the incident better (`core/rubrics/incident.md`). Blinding replaces refs,
shas, pull request numbers, branches and timestamps inside messages, and drops
any line that states the run's own cost, tokens, turns or duration. Tokens by
class, per scenario and side, are in the details.

## Runtimes

The system under test sits behind `sim/runtimes/types.ts`: `build(ref)` makes
it from a git ref, `launch({ build, env, ports, workRoot, world })` starts it
against this run's fakes and returns where it listens for its health check,
the Grafana webhook and Slack events, plus `closed()`. `world` carries the
values of the run's world (the Slack sim, the Grafana org and its token, the
sandbox and its token file and CA, the credential endpoint, S3, Postgres, a
state directory), and each runtime maps them onto its own configuration.
`env` carries only PATH, HOME, LANG and the model proxy's endpoint. run.ts
knows nothing else about what it launched; `--runtime` on `compare.ts` picks
one.

`bugboss` (`sim/runtimes/bugboss.ts`) is the only implementation. Its
`closed()` reads BugBoss's SQLite incident row, and that is the one read of
the system's insides left in the harness; the incident service, once it
exists, is what every runtime will have to tell about a close, and the read
goes with it. Everything else about a run comes from Slack, GitHub, the hidden
check and the proxy.

The BugBoss options the adapter sets are all unset in production:
`BUGBOSS_GITHUB_TOKEN_FILE`, `SLACK_API_URL`, `BUGBOSS_OMNI_REPO`,
`BUGBOSS_WORK_ROOT`, `AWS_ENDPOINT_URL_*` and `BUGBOSS_REVIEW_SETTLE_SECONDS`
(5 here, so an approval does not hold a review wait for five minutes).

The Slack sim speaks HTTP mode: it delivers events as signed Events API
callbacks to `slackEventsUrl`. A runtime that only takes Slack over Socket
Mode needs a Socket Mode face on `sim/slack.ts`, which is not built.

## Trust

The workflow runs from main, so a PR cannot change how it is measured, and
its own harness changes take effect only once merged. The PR's BugBoss, CI
and the hidden check over code its agent wrote run as `bugboss-eval`, a user
with no sudo, no workflow token and no real credential of any kind: the model
key stays in the harness's proxy, which runs as the workflow user. No GitHub
credential exists anywhere: the fake is the only GitHub the run can reach.

## Running it

In CI: the `bugboss eval` comment. A PR that changes a scenario also runs
`bugboss-evals-ci.yml`, which holds no secrets and proves the hidden check
against omni (public). The harness's unit tests run with `npm test` in
`deploy.yml`. Nothing exercises the rig end to end without spend: the first
`bugboss eval` on a change is its integration test.

`reference.md` is what the judge compares against. Beyond the vetted
mechanism it should say what the immediate mitigation and the systemic fix
should each have been, and name which of `human.volunteer` and `human.facts`
lines were wrong, so the judge can score how the side answered them.

`--until root_cause|pr_opened|closed` stops each run at a milestone; `closed`,
the default, is the whole lifecycle.

Never run any of this on a Mac: host git and docker there reach the macOS
keychain and prompt without end, and the fake needs `/etc/hosts` and port 443.
On Linux, with an omni clone holding every scenario's shas, the steps in
`bugboss-eval.yml` before `Run` set the machine up; then, with
`ANTHROPIC_API_KEY` in the environment:

    npx tsx bugboss-evals/sim/compare.ts run --omni /tmp/omni \
      --baseline origin/main --candidate HEAD --scenarios missed-merge --reps 1 --out /tmp/evals

Every run spends real money; `--spend-cap-usd` bounds it.

## Adding a scenario

A directory under `scenarios/` with `scenario.json` (`core/scenario.ts`), the
alert, a telemetry generator, a vetted `reference.md` and a hidden check that
exits 1 at `baseSha` and 0 at `provingFixSha` (`scenarios/prove.test.ts`
proves it when pointed at an omni clone). A variant of another scenario
points its files at that one's by relative path (`../<id>/...`). Add it to
`SCENARIO_IDS` and both workflows' matrices; every job seeds the sandbox
afresh.
