# PR-reviewer eval

Replay PRs with known right answers against the reviewer code in any checkout, and score how often each version gets them right.

## Start here: measure a change locally

`review:arms` is the one command for trying a change to the reviewer, prompt text or structure (a new subagent, injected context, a new tool). Each version you want to compare is an arm: a worktree on its own commit. Every arm replays the same tune cases from `expected/manifest.json` with its own code, and the checkout you run from scores them all, so an arm can't change what it is graded on. Holdout cases never run locally.

```sh
# from a checkout of main: it is the scorer, and the `main` arm
git worktree add ../ops-arms/idea -b arm/idea origin/main
(cd ../ops-arms/idea && npm ci)          # each arm runs its own install
# ...make the change in ../ops-arms/idea and commit it

npm run review:arms -- --arms main=.,idea=../ops-arms/idea --base main --out ~/delegate-lab
```

- **Results are kept per commit**, under `<out>/runs/<sha>`. An arm whose commit already has runs reuses them under any name, and changed code always replays. So keep one `--out` for a whole session. Uncommitted changes under `delegate/` are refused, because they would be filed under a commit that doesn't contain them.
- **An arm may not differ from the scorer's commit in the hill-climb `neverTouch` paths** (`delegate/review/`, `delegate/framework/`, `.github/`, `package.json`, `package-lock.json`; the list is in `.claude/skills/hill-climb/targets/delegate-pr-reviewer.json`). Each arm replays with its own eval code and writes the results the scorer reads, so a change there could grade itself. Structural changes under `delegate/agents/` are fine. An arm made from an older main has to be rebased onto the scorer's commit.
- **`--base <arm>` gates every other arm against that one.** A case the base passed on every run must not get worse. An arm that drops it gets `--runs` more runs and needs 5 of 6, so one unlucky run isn't a regression. `--targets a,b` names cases an arm must pass on every run. The verdict is printed under the table and written to `<out>/gate.json`.
- `--case a,b` narrows to some tune cases. `--runs` (default 3), `--concurrency` (replays per arm, default 2) and `--parallel-arms` (default 3) set the load. Keep them low on a shared laptop.
- `--mode score` re-renders the table and the gate from results already on disk, without replaying.
- Credentials: `ANTHROPIC_API_KEY` if set, otherwise your Claude Code login. `gh` auth clones the reviewed repos. About half the tune cases are recorded production reviews, which need read access to `REVIEW_BUCKET` (`aws sso login`). A local manifest of bundle cases needs no AWS access.

## Hill-climbing

Improve the reviewer one idea at a time, against whichever version is best so far, which is main only at the start.

1. **Pick a case to fix.** Run main alone (`--arms main=.`) and take a tune case it fails, or one the change is meant to cover. Read its runs: `leads` on each `run-<n>.json` says whether the scout never raised the problem or a deep-reviewer dropped it.
2. **Make one change** in a new arm worktree and commit it. One idea per arm, so a result can be traced to its cause.
3. **Inner loop.** `--arms best=<path>,idea=<path> --base best --case <id>` until the case passes. Amend and rerun; changed commits replay, and `best` comes from disk.
4. **Check for regressions.** The same command without `--case`, plus `--targets <id>`. The idea has to pass the gate against `best`.
5. **Promote it.** The winning arm becomes `best` for the next idea, and its runs carry over. Try several ideas side by side as separate arms against the same base.
6. **Open a PR** from the winning branch, with the final table in the body. Comment `delegate eval` on it to run the full suite in CI, holdout included. That is the only place holdout runs, and it gates against main. A human code owner approves and merges.

The `hill-climb` skill (`.claude/skills/hill-climb/`) is the agent version of this loop.

## Other ways to run it

- **`delegate eval` on a PR** (next section): CI runs the full expected-result suite against main, holdout included, plus a pairwise judge on `scenarios.json`. Use it once, on the PR, as the final check.
- **Dispatched run** (`delegate-eval-run.yml`, below): the same gate in CI on a branch without a PR, for prompt-text changes only, with a per-run budget. It is how the Delegate swarm hill-climbs, always, and how any agent without local credentials does.
- **`review:expect`**: the replay and scoring engine under all of the above, for one checkout at a time.
- **`review:eval replay` and `judge`**: pairwise comparison of two result sets by a model judge, on recorded production reviews.

## From a PR

Comment `delegate eval` on any ops PR to run the `core` suite, or `delegate eval <suite>` (for example `delegate eval re-review`) to run another suite from `scenarios.json`. The workflow:

1. Loads the suite's scenarios from `scenarios.json`: fixed production review records in S3, so every eval runs the same cases. If your PR changes `scenarios.json`, its copy is used.
2. Replays every scenario twice per side in parallel (`--replays 2`): two replays with main's agent code and two with your PR head's.
3. Judges the two sides pairwise and posts a single comment to the PR with three verdicts: **Quality (tune)** and **Quality (holdout)** (each Better / Worse / Can't tell, from the sign test over that split's judged cases) and **Cost** (Better / Worse / Same, average cost per review before and after; under 10% change is Same). The holdout line shows only the verdict and counts. The drop-down lists tune cases only; every raw result and the full report, holdout cases included, are on the workflow run as artifacts.
4. Uploads the full eval directory as a workflow artifact (`delegate-eval-<sha7>`).

**Cost and time:** each replay is a full `claude-opus-5-5` agent run at roughly $1.50, and each side runs every case twice, so the PR side costs about $3 per case. Main's side is cached, so it costs that only after a change to main's agents, framework or review code. The 23-case `core` suite takes about 30 minutes and costs around $69 for the PR side (and the same again for an uncached main) plus a few dollars for judging.

**Scenarios:** each entry in `scenarios.json` names an `id`, a `suite`, the S3 `key` of the record, and what it `tests`. The report names cases by `id`. `core` is a mix of first reviews and re-reviews across repos, with real bugs production caught or missed and false findings authors refuted. `re-review` covers prior-finding handling.

**Repo settings the workflow needs:**

- Variable `DELEGATE_EVAL_APP_ID`: the app ID of a GitHub App with `contents:read` on the repos being reviewed (used to clone target repos during replay).
- Secret `DELEGATE_EVAL_APP_PRIVATE_KEY`: the private key for that GitHub App.
- Secret `ANTHROPIC_API_KEY`: standard Anthropic API key for agent replay and judging.

The workflow only runs for comments from users with `OWNER`, `MEMBER`, or `COLLABORATOR` association on the repository, and only on PRs whose branch is in this repo. It runs the PR's code with live credentials, so a fork PR is refused.

## Concepts

**Case** — one production `ReviewRecord` stored in S3. The record contains the full `bundle` (diff, changed files, prior findings, PR metadata) that was the agent's complete input. Because the bundle is self-contained, a case can be replayed without calling GitHub — except for checking out the repo at `bundle.headSha` so the agent can read files.

**Variant** — the ops git ref the eval was run from. When you run `replay` from a worktree, the variant is `git rev-parse HEAD` of that worktree, or whatever you pass via `--variant`.

**Result** — one replay output: `{ caseId, repo, prNumber, headSha, variant, output, error?, costUsd, wallTimeMs, gating?, leads?, subagentCalls? }`. Stored as `<caseId>/run-<n>.json` in the results directory as each replay completes. `gating` is the gate's outcome (`{ mode, verdict, gates, wouldApprove }`) and is present only for a repo that has adopted gating: the agent's `output` cannot tell a flag from an ordinary comment, because both are a complete review with no findings. Replays of the pr-reviewer also carry `leads`: the scout's leads, each with an `outcome` (`not-investigated`, `dropped`, `raised`, `reported`, `unknown`) telling what the deep-reviewer did with it, so a miss can be told apart as "scout never raised it" or "deep-reviewer dropped it". Absent on production-record results and on files written before it existed. `subagentCalls` keeps each subagent's prompt and answer, so lead tracing can be checked and re-run offline without another paid replay.

## Commands

### Snapshot a corpus

```sh
npm run review:eval -- cases snapshot --out ./eval-cases [--repo thegoodparty/gp-api] [--limit 20]
```

Lists every `ReviewRecord` in S3 (`REVIEW_BUCKET`, default `delegate-reviews`) and writes them to a local directory. Freeze a corpus before running an experiment so both variants are judged on exactly the same cases.

### Replay from a variant

```sh
npm run review:eval -- replay \
  --cases ./eval-cases \
  --out ./results-main \
  --variant main \
  --replays 2 \
  --concurrency 3 \
  --work-dir /tmp/review-eval
```

For each case, clones the target repo at `bundle.headSha`, runs the agent exactly as production does, and writes a `Result` JSON per replay (`--replays`, default 1). Skips replays that already have a result file (use `--force` to re-run), so a case with one of two replays done replays only the second.

Each replay is a full agent run — budget roughly $1–5 per case depending on diff size.

### Cache main's results

`delegate eval` replays main on every run, which is half its cost. Main's results are cached in `s3://delegate-reviews/eval-cache/main/<replayKey>/<suite>/<caseId>/run-<n>.json`, where `<replayKey>` is `cache key`: a hash of the git tree ids of `delegate/agents`, `delegate/framework`, `delegate/review` and `package-lock.json` on main, which is everything main's replay executes. Unrelated merges keep the cache warm; a change to any of those starts a fresh full replay (an eval-code edit under `delegate/review` costs a replay, never a stale baseline). Pairwise stores each replay as `run-<n>`, so a case has `run-1` and `run-2`.

```sh
npm run review:eval -- cache pull --suite core --layout runs --key "$(npm run -s review:eval -- cache key)" --out ./results-main
# replay as usual into the same directory: cases with a result file are skipped
npm run review:eval -- cache push --suite core --layout runs --key "$(npm run -s review:eval -- cache key)" --out ./results-main
```

`--layout runs` is for `<case>/run-<n>.json` directories, which is what both the pairwise and the expected suites use; the default `flat` is one `<case>.json` per case. Push uploads only results that pull did not bring down, skips any that errored or reported `failed` (retried next eval, in both layouts), and never overwrites a key. A partly finished case caches the runs that completed and retries the rest. The eval role every job in `delegate-eval.yml` assumes is read-only. The cache is written by a second role, `github-actions-delegate-eval-cache-push`, which can only `PutObject` under `eval-cache/*` and only with `If-None-Match` (S3 refuses an overwrite). Its trust accepts only the reusable workflow `delegate-eval-cache-push.yml`; a job in a called workflow presents that file as its `job_workflow_ref`, so no job in `delegate-eval.yml` can assume it, PR-code jobs included. That workflow runs only main's code and uploads the artifact a main-only replay job produced, by the id that job reports: if PR code got to the artifact name first, the replay job's own upload fails, it reports no id and nothing is pushed. Scenario cases are keyed by the recorded run id, and a record under `reviews/` is written once, so a cached result cannot go stale against its case. The pairwise comment's cost columns come from each result's recorded cost, so a cached main side still shows what it originally cost; the saving is in the workflow log, where the replay step prints `Replaying 0 run(s); N already had results`.

### Judge two sets of results

```sh
npm run review:eval -- judge \
  --cases ./eval-cases \
  --a ./results-main \
  --b ./results-branch \
  --label-a main \
  --label-b branch \
  --passes 4 \
  --out report.md
```

Compares result pairs using a blind pairwise judge (`claude-sonnet-5-5` by default, not the agent's opus model, to blunt self-preference). Replay k of one side is judged only against replay k of the other, `--passes` times each with alternating order, so two replays per side give eight judgments per case. A majority of those mapped winners across both pairs determines the per-case verdict; pairs that disagree cancel into no decision. With `--manifest`, the report splits tune from holdout. Writes the markdown report to `--out`; it is never printed, because it lists holdout cases and job logs are readable.

## Worked example — comparing main vs a branch

```sh
# 1. Freeze a corpus (run once from any checkout)
npm run review:eval -- cases snapshot --out ./eval-cases --limit 20

# 2. Replay from main
git worktree add ../review-eval-main main
cd ../review-eval-main
npm run review:eval -- replay --cases ./eval-cases --out ./results-main --variant main

# 3. Replay from your branch
cd ../review-eval-branch   # worktree at your branch
npm run review:eval -- replay --cases ./eval-cases --out ./results-branch --variant my-branch

# 4. Judge from either worktree
npm run review:eval -- judge \
  --cases ./eval-cases \
  --a ./results-main \
  --b ./results-branch \
  --label-a main \
  --label-b my-branch \
  --out report.md

cat report.md
```

## Expected-result suite

Thirty-six cases with a known right answer, listed in `expected/manifest.json`. `expected/parked.json` holds cases taken out of the suite, each with its reason (today one that needs vendor behavior the replayed checkout does not contain); nothing replays or scores them, and moving one back to the manifest restores it. Each is scored on its own expectation, with no judge. A block case passes when a finding lands in one of its `paths` (and, if set, one of its `categories`); an approve case passes when the gate's review event is an approval and there are no findings; a flag case passes when the review event is a comment and the named gate fired.

The two plan cases carry their outcome plus the model's answer as a diagnostic: `{ "verdict": "approve", "consistency": "consistent" }` for the consistent change and `{ "verdict": "flag", "reason": "inconsistent", "consistency": "inconsistent" }` for the inconsistent one. The outcome decides the case; the diagnostic says whether a wrong outcome came from the model or from the gate. Each of their bundles carries the approved plan's text and blob sha, so nothing is fetched from GitHub and they replay like any other simulated PR.

Replay runs the gate in `enforce` for a repo on `gating.ts`'s adoption list, which is what makes an approval reachable, and treats the bundle's changed paths as de-owned: a bundle carries no `CODEOWNERS`, so the deterministic authority cases are asserted in `delegate/review/gating.test.ts` rather than replayed. A repo that has not adopted gating records no verdict and keeps the findings-only outcome. The standalone `{ "verdict": "consistency", "consistency": ... }` expectation remains for cases that must be scored on the model's answer alone. Every case runs several times, and a case passes only when every run does.

An outcome case may also carry `consistency` as a diagnostic. When it does, the model's answer has to be right as well, and the result line reports both (`approved; planConsistency: consistent`), which is how a wrong outcome is attributed to the model rather than to the gate.

Every `delegate eval` comment also runs this suite as a parallel job and posts the result as its own PR comment. The PR head's agent replays main's cases (`--mode replay`), then main's code scores them (`--mode score`), so a PR can't change what it is graded on. It adds about $65 and no wall time. The job also replays main's agent on the same cases, from the cache when main's replay inputs are unchanged, and the report has a "Main runs passed" column per case. The same baseline is written to `report.json` as `cases[].main = { runs, completed, runsPassed, unfinished }` for the merge gate to read. `runs` is how many runs each case should have; a run that errored or never happened counts toward `unfinished`, not toward `runsPassed` or a failure, and the markdown reads `2/2 (1 of 3 runs unfinished)`. Its cache suite is `expected-<tree of expected/>`, so editing a case never reuses an answer to the old one.

```sh
npm run review:expect -- [--runs 3] [--concurrency 5] [--case <id>] [--split tune|holdout] [--out ./eval-expected] [--work-dir /tmp/review-expect] [--baseline <main-results-dir> --baseline-variant <label>]
```

Writes each run's result to `<out>/<case>/run-<n>.json` (a run that already has a non-errored file there is skipped) and the report to `<out>/report.md` and `<out>/report.json`. Needs `ANTHROPIC_API_KEY`, `gh` auth for the target repos, and read access to `REVIEW_BUCKET`. Thirty-six cases at three runs costs about $165 (the gp-pi case is a 2,400-line diff, roughly $4 a run; the plan cases and the prompt-text case are small diffs, the prompt-text case about $2.80 a run).

### Gate

`--mode gate --base <main-results-dir> [--history <dir>] [--targets id,id] [--final true] [--runs 3] [--min-main-runs 6]` turns the baseline into a verdict and writes `<out>/gate.json` and the gate report to `<out>/report.md`. It refuses to run without `--base`, or when main has no completed runs at all.

- A case main passed on every run (`runsPassed == completed == runs`) must not regress. If the candidate passes fewer than `runs`, the case is returned in `rerun`; after `runs` more runs (`--mode replay --case a,b --from-run 4`) it needs `2*runs-1` of `2*runs` (5 of 6), or it is a `regression`. With `--final true` a case still short of `runs` passes counts as a regression, so a rerun that never happened cannot pass.
- A case main did not pass 3/3 (including one with unfinished main runs) cannot regress.
- `--min-main-runs` (default `runs`) is how many completed main runs, this baseline's and `--history`'s together, a case needs before it can regress: a case main passes 9 times in 10 still passes three in a row about 73% of the time. `delegate-eval-run.yml` passes 6, and before gating replays main's runs 4 to 6 on every case main passed so far with fewer (`--mode main-short --base <dir> [--history <dir>] --min-main-runs 6 --ids-out <file>` writes those ids to a file and prints only a count). Those runs are cached like the first three, and like them are not charged to the run id.
- `--history` holds main's earlier runs of the same reviewer, pulled by `review:eval cache history` from other replay keys: a run counts when its `main-<sha>` variant has this checkout's `delegate/agents` tree and its case head matches the baseline's. A key changes with any edit under `delegate/review`, so without history the gate sees only this check's three main runs and treats a lucky streak as a bar. A case main failed on any earlier run cannot regress either, and `flaky` counts both. `delegate-eval-run.yml` passes it; `delegate eval` on a PR does not yet.
- Every id in `--targets` must pass all its runs, or it is in `targetsMissed`. An unknown id is a miss.
- `costRatio` is the candidate's average cost per run over main's (null when either is unknown). Above `1.10` sets `costOver`, which is reported but never fails the gate.
- `pass` is true only with no `regressions`, `rerun` or `targetsMissed`. The exit code is non-zero only with `--final true` and `pass` false.
- `gate.json`: `{ regressions, rerun, targetsMissed, costRatio, costOver, pass, minMainRuns, cases: [{ id, split, mainPassed, mainCompleted, earlierPassed, earlierCompleted, flaky, candPassed, candRuns, outcome }] }`. Main's flake rate for a case is its passes over its completed runs, this check's and earlier ones together; `flaky` is true when that is strictly between 0 and 1, or when the case is marked `flakyOnMain`.

The report lists tune cases with the candidate's and main's pass counts and shows holdout only as `passed X of Y, regressions: N`. `gate.json` and `report.json` still name holdout ids, so they stay in the workflow artifact and are not posted. `delegate eval` on a PR passes no `--targets`; the hill-climb dispatch (ticket 07) supplies them, from main's side, never from PR files. In the workflow, `expected-gate` runs the first pass, `expected-rerun` (PR code, read-only eval role) replays only the flagged cases, and `expected-score` merges only `run-4` to `run-6` from the rerun, gates with `--final true`, posts the gate report (never the score report, which names holdout cases) and goes red on failure.

Every case, and every scenario in `scenarios.json`, carries three required labels: `split` (`tune` or `holdout`; holdout cases are never shown to whoever tunes the prompt), `source` (`simulated`, `production-caught`, `production-missed` or `refuted`) and `kind` (`bug`, `false-finding`, `scale` or `architecture`). An optional `flakyOnMain` says why main's own result on a case is noise; the gate still scores that case but never counts it as a regression. No filter means every case. `--split` narrows `review:expect`, `cases scenarios` and, with `--manifest`, `replay`.

A case is either a recorded production run (`key`, an object in `REVIEW_BUCKET`) or a simulated PR (`bundle`, a file next to the manifest). A simulated PR's head commit does not exist on GitHub: the replay checks out `baseSha`, applies the bundle's diff and commits it with a fixed author and date, which reproduces the bundle's `headSha` exactly. To add one, make the change on a detached checkout of `baseSha`, commit it with the env in `SYNTHETIC_COMMIT_ENV` (`expect.ts`) and the bundle's title as the message, and record that sha and `git diff <base> HEAD` in the bundle.

### Dispatched run (`delegate-eval-run.yml`)

Measures a candidate branch without a PR, for the hill-climb loop. Always dispatch it from main; the first job refuses any other ref, and every role it uses pins the file on main:

```sh
gh workflow run delegate-eval-run.yml --ref main -f mode=dry-run -f branch=<branch> -f run_id=<id>
```

Inputs: `mode` (`dry-run` is the default and spends nothing; `inner` replays the given tune `cases` once each; `tune` gates the tune cases with 3 runs; `gate` gates every case with 3 runs and reruns), `branch`, `run_id` (`^[a-z0-9-]{1,64}$`, keys the budget), `cases` (inner only, tune case ids), `targets` (tune and gate, tune case ids that must pass every run; they come from the dispatch, never from the branch), `budget_usd` (default 150).

The candidate is main's tree with `delegate/agents/pr-reviewer.ts` and `delegate/agents/pr-reviewer-subagents.ts` taken from the branch. The run fails before any replay if the branch changes any other file, so the branch's eval code, manifests, scoring, workflows and dependencies are never used; replay is the only step that runs the branch's files, and scoring, the gate, the budget and the ledger run in jobs of main's code. Main's baseline comes from the eval cache, replayed and pushed through `delegate-eval-cache-push.yml` when missing; its cost is not charged to the run id. If any of main's runs is still missing or errored after the replay, the run fails rather than leave that case ungated; good runs are cached, so a re-dispatch replays only the gaps. A main review that comes back `failed` (the reviewer gave up) is not a gap: it counts as a run main did not pass, so that case is not held, and the run goes on.

The two files are TypeScript that replay runs in-process, so `prepare` also compares each with its merge-base copy and refuses the run unless they differ only in the text of string and template literals (`${...}` expressions, imports, identifiers, calls and statements must match exactly; comments and whitespace may change). Import specifiers, `require()` and `import()` arguments and `x["key"]` lookups count as code, written with quotes or backticks. Tool names are literals a candidate may change, so replay denies any tool outside its own read-only list (Read, Grep, Glob, Task/Agent, StructuredOutput and the git tools) whatever the reviewer config says. Structural changes go through a human-authored PR.

Nothing is posted to GitHub. Wait with `gh run watch <run-id> --exit-status` (red when the gate fails) and download the artifact `eval-run-<run_id>-<mode>-<attempt>`: `gate.json` (tune and gate; `pass`, `regressions`, `targetsMissed`, `costRatio`, `cases` for tune cases, and `holdout: { total, passed, regressions }` as counts only), `report.md`, `meta.json`, and the results of tune cases. Holdout results never leave the job, and in `gate` mode the replay logs are withheld.

**Budget.** The spend of a run id is `eval-cache/ledger/<run_id>/<ghRunId>-<attempt>-<mode>.json`, one object per measured dispatch, written once with `If-None-Match` by `delegate-eval-ledger.yml` (role `github-actions-delegate-eval-ledger`, trusted only by that file). Before replaying, the dispatch refuses if recorded spend plus the estimate would pass the budget: inner is $4 per case, tune is tune cases x 3 x $1.30, gate is all cases x 3 x $1.30 (reruns are not in the estimate). The lowest `budget_usd` ever given for a run id wins, so a later dispatch can lower but not raise it. After the run, the summed `costUsd` of every candidate result, failed and cancelled runs included, is recorded. Dispatches for one run id are serialized by a concurrency group; the budget is per run id, so a new id is a new budget.

## Cases outside the suite

To try a PR that isn't in `expected/manifest.json` yet, build a local manifest of the same shape and pass it with `--manifest`. Its bundles resolve next to it.

```sh
# a real PR as a case, from GitHub alone (no S3), as production would have seen it at that sha
npm run review:from-pr -- --pr 2977 --sha <reviewed sha> --out ~/delegate-lab/bundles/omni-2977.bundle.json

npm run review:arms -- --manifest ~/delegate-lab/manifest.json --arms main=.,idea=../ops-arms/idea --base main --out ~/delegate-lab
```

- A bundle case whose `source` is `simulated` gets its head commit rebuilt from the diff; any other source is a real PR, and its head is fetched from GitHub.
- `--mirror-dir` (default under `--work-dir`) keeps one bare clone per repo. Each replay is a `--shared` clone of it, and every sha the cases need is fetched once before the arms start.
- Runs are keyed by commit and case id, not by the case's contents. After editing a case, delete its directory under `<out>/runs/*/`.

## Mining candidate cases

```sh
npm run review:mine -- --repo thegoodparty/omni --kind missed --since 2026-10-05 --out candidates.jsonl
```

Read-only. Walks every page of `REVIEW_BUCKET`, keeps the latest non-`eval` record per head sha, and proposes cases for a human to confirm. Needs S3 read access and `gh` auth. Flags: `--repo`, `--since`, `--kind missed|refuted`, `--fix-words a,b,c` (replaces the default `fix,bug,revert,hotfix,race,timeout`), `--limit`, `--out` (stdout if omitted).

- **missed**: an approved PR that merged, then a non-merge commit within 14 days removed a line the approved diff added. Output: `{ kind, key, repo, pr, fixCommit, overlappingPaths, message, overlapLines, score }`, best first. Lines are matched by text per path, not blamed by number.
- **refuted**: a blocked PR that merged with every flagged line unchanged and a reply from another author on each finding thread. Output: `{ kind, key, repo, pr, findings, replies, mergedSha }`.

Most hits are noise (about 3.5 good missed-bug cases per 100 approvals), and many real misses need a running system to see, so a person labels each one.

## Cost expectations

- **Replay**: each replay is a full `claude-opus-5-5` agent run. Budget $1–5 per replay, two per side per case in `delegate eval`; a 20-case corpus costs roughly $40–200 for the PR side depending on diff complexity.
- **Judge**: each pass is a short `claude-sonnet-5-5` call (one structured verdict). Budget a few cents per pass; 20 cases × 2 pairs × 4 passes ≈ $1–4.

## Statistical interpretation

The report includes a two-sided binomial sign test (p=0.5, ties and unstable verdicts excluded), computed per split. Rule of thumb:

- 12 cases → 10+ wins one way is p<0.05
- 24 cases → 18+ wins one way is p<0.05
- 20 cases → 15+ wins one way is p<0.05
- 50 cases → 31+ wins one way is p<0.05

A p-value below 0.05 gives reasonable confidence the variant difference is real rather than noise. Fewer than 10 non-tie cases is usually not enough to conclude anything.
