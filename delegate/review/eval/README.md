# PR-reviewer eval

Replay recorded production reviews against the agent code in any checkout and compare two variants pairwise.

## From a PR

Comment `delegate eval` on any ops PR to run the `core` suite, or `delegate eval <suite>` (for example `delegate eval re-review`) to run another suite from `scenarios.json`. The workflow:

1. Loads the suite's scenarios from `scenarios.json`: fixed production review records in S3, so every eval runs the same cases. If your PR changes `scenarios.json`, its copy is used.
2. Replays every scenario twice in parallel, once with main's agent code and once with your PR head's.
3. Judges the two sides pairwise and posts a single comment to the PR with two verdicts: **Quality** (Better / Worse / Can't tell, from the sign test over the judged pairs) and **Cost** (Better / Worse / Same, average cost per review before and after; under 10% change is Same). Per-case results sit in a drop-down; every raw result is on the workflow run as an artifact.
4. Uploads the full eval directory as a workflow artifact (`delegate-eval-<sha7>`).

**Cost and time:** each replay is a full `claude-opus-5-5` agent run at roughly $1.50 per case, and both sides are replayed. The 12-case `core` suite takes about 20 minutes and costs around $36 in replay plus a few dollars for judging.

**Scenarios:** each entry in `scenarios.json` names an `id`, a `suite`, the S3 `key` of the record, and what it `tests`. The report names cases by `id`. `core` is a mix of first reviews and re-reviews across repos, with real bugs production caught or missed and false findings authors refuted. `re-review` covers prior-finding handling.

**Repo settings the workflow needs:**

- Variable `DELEGATE_EVAL_APP_ID`: the app ID of a GitHub App with `contents:read` on the repos being reviewed (used to clone target repos during replay).
- Secret `DELEGATE_EVAL_APP_PRIVATE_KEY`: the private key for that GitHub App.
- Secret `ANTHROPIC_API_KEY`: standard Anthropic API key for agent replay and judging.

The workflow only runs for comments from users with `OWNER`, `MEMBER`, or `COLLABORATOR` association on the repository, and only on PRs whose branch is in this repo. It runs the PR's code with live credentials, so a fork PR is refused.

## Concepts

**Case** — one production `ReviewRecord` stored in S3. The record contains the full `bundle` (diff, changed files, prior findings, PR metadata) that was the agent's complete input. Because the bundle is self-contained, a case can be replayed without calling GitHub — except for checking out the repo at `bundle.headSha` so the agent can read files.

**Variant** — the ops git ref the eval was run from. When you run `replay` from a worktree, the variant is `git rev-parse HEAD` of that worktree, or whatever you pass via `--variant`.

**Result** — one replay output: `{ caseId, repo, prNumber, headSha, variant, output, error?, costUsd, wallTimeMs, gating? }`. Stored as `<caseId>.json` in the results directory as each replay completes. `gating` is the gate's outcome (`{ mode, verdict, gates, wouldApprove }`) and is present only for a repo that has adopted gating: the agent's `output` cannot tell a flag from an ordinary comment, because both are a complete review with no findings.

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
  --concurrency 3 \
  --work-dir /tmp/review-eval
```

For each case, clones the target repo at `bundle.headSha`, runs the agent exactly as production does, and writes a `Result` JSON. Skips cases that already have a result file (use `--force` to re-run).

Each replay is a full agent run — budget roughly $1–5 per case depending on diff size.

### Cache main's results

`delegate eval` replays main on every run, which is half its cost. Main's results are cached in `s3://delegate-reviews/eval-cache/main/<replayKey>/<suite>/<caseId>/run-<n>.json`, where `<replayKey>` is `cache key`: a hash of the git tree ids of `delegate/agents`, `delegate/framework`, `delegate/review` and `package-lock.json` on main, which is everything main's replay executes. Unrelated merges keep the cache warm; a change to any of those starts a fresh full replay (an eval-code edit under `delegate/review` costs a replay, never a stale baseline). A pairwise result is stored as `run-1`.

```sh
npm run review:eval -- cache pull --suite core --key "$(npm run -s review:eval -- cache key)" --out ./results-main
# replay as usual into the same directory: cases with a result file are skipped
npm run review:eval -- cache push --suite core --key "$(npm run -s review:eval -- cache key)" --out ./results-main
```

Use `--layout runs` for the expected suite's `<case>/run-<n>.json` directories. Push uploads only results that pull did not bring down, skips any that errored or reported `failed` (retried next eval, in both layouts), and never overwrites a key. A partly finished case caches the runs that completed and retries the rest. The eval role every job in `delegate-eval.yml` assumes is read-only. The cache is written by a second role, `github-actions-delegate-eval-cache-push`, which can only `PutObject` under `eval-cache/*` and only with `If-None-Match` (S3 refuses an overwrite). Its trust accepts only the reusable workflow `delegate-eval-cache-push.yml`; a job in a called workflow presents that file as its `job_workflow_ref`, so no job in `delegate-eval.yml` can assume it, PR-code jobs included. That workflow runs only main's code and uploads the artifact a main-only replay job produced, by the id that job reports: if PR code got to the artifact name first, the replay job's own upload fails, it reports no id and nothing is pushed. Scenario cases are keyed by the recorded run id, and a record under `reviews/` is written once, so a cached result cannot go stale against its case. The pairwise comment's cost columns come from each result's recorded cost, so a cached main side still shows what it originally cost; the saving is in the workflow log, where the replay step prints `Replaying 0 case(s); N already had results`.

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

Compares result pairs using a blind pairwise judge (`claude-sonnet-5-5` by default, not the agent's opus model, to blunt self-preference). Each case is judged `--passes` times with alternating order; a majority of mapped winners determines the per-case verdict. Prints the markdown report to stdout and writes it to `--out` if given.

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

Nine cases with a known right answer, listed in `expected/manifest.json`. Each is scored on its own expectation, with no judge. A block case passes when a finding lands in one of its `paths` (and, if set, one of its `categories`); an approve case passes when the gate's review event is an approval and there are no findings; a flag case passes when the review event is a comment and the named gate fired.

The two plan cases carry their outcome plus the model's answer as a diagnostic: `{ "verdict": "approve", "consistency": "consistent" }` for the consistent change and `{ "verdict": "flag", "reason": "inconsistent", "consistency": "inconsistent" }` for the inconsistent one. The outcome decides the case; the diagnostic says whether a wrong outcome came from the model or from the gate. Each of their bundles carries the approved plan's text and blob sha, so nothing is fetched from GitHub and they replay like any other simulated PR.

Replay runs the gate in `enforce` for a repo on `gating.ts`'s adoption list, which is what makes an approval reachable, and treats the bundle's changed paths as de-owned: a bundle carries no `CODEOWNERS`, so the deterministic authority cases are asserted in `delegate/review/gating.test.ts` rather than replayed. A repo that has not adopted gating records no verdict and keeps the findings-only outcome. The standalone `{ "verdict": "consistency", "consistency": ... }` expectation remains for cases that must be scored on the model's answer alone. Every case runs several times, and a case passes only when every run does.

An outcome case may also carry `consistency` as a diagnostic. When it does, the model's answer has to be right as well, and the result line reports both (`approved; planConsistency: consistent`), which is how a wrong outcome is attributed to the model rather than to the gate.

Every `delegate eval` comment also runs this suite as a parallel job and posts the result as its own PR comment. The PR head's agent replays main's cases (`--mode replay`), then main's code scores them (`--mode score`), so a PR can't change what it is graded on. It adds about $35 and no wall time. The job also replays main's agent on the same cases, from the cache when main's replay inputs are unchanged, and the report has a "Main runs passed" column per case. The same baseline is written to `report.json` as `cases[].main = { runs, completed, runsPassed, unfinished }` for the merge gate to read. `runs` is how many runs each case should have; a run that errored or never happened counts toward `unfinished`, not toward `runsPassed` or a failure, and the markdown reads `2/2 (1 of 3 runs unfinished)`. Its cache suite is `expected-<tree of expected/>`, so editing a case never reuses an answer to the old one.

```sh
npm run review:expect -- [--runs 3] [--concurrency 5] [--case <id>] [--split tune|holdout] [--out ./eval-expected] [--work-dir /tmp/review-expect] [--baseline <main-results-dir> --baseline-variant <label>]
```

Writes each run's result to `<out>/<case>/run-<n>.json` (a run that already has a non-errored file there is skipped) and the report to `<out>/report.md` and `<out>/report.json`. Needs `ANTHROPIC_API_KEY`, `gh` auth for the target repos, and read access to `REVIEW_BUCKET`. Nine cases at three runs costs a little over $35 (the gp-pi case is a 2,400-line diff, roughly $4 a run; the two plan cases are single-file diffs).

### Gate

`--mode gate --base <main-results-dir> [--targets id,id] [--final true] [--runs 3]` turns the baseline into a verdict and writes `<out>/gate.json` and the gate report to `<out>/report.md`. It refuses to run without `--base`, or when main has no completed runs at all.

- A case main passed on every run (`runsPassed == completed == runs`) must not regress. If the candidate passes fewer than `runs`, the case is returned in `rerun`; after `runs` more runs (`--mode replay --case a,b --from-run 4`) it needs `2*runs-1` of `2*runs` (5 of 6), or it is a `regression`. With `--final true` a case still short of `runs` passes counts as a regression, so a rerun that never happened cannot pass.
- A case main did not pass 3/3 (including one with unfinished main runs) cannot regress.
- Every id in `--targets` must pass all its runs, or it is in `targetsMissed`. An unknown id is a miss.
- `costRatio` is the candidate's average cost per run over main's (null when either is unknown). Above `1.10` sets `costOver`, which is reported but never fails the gate.
- `pass` is true only with no `regressions`, `rerun` or `targetsMissed`. The exit code is non-zero only with `--final true` and `pass` false.
- `gate.json`: `{ regressions, rerun, targetsMissed, costRatio, costOver, pass, cases: [{ id, split, mainPassed, mainCompleted, flaky, candPassed, candRuns, outcome }] }`. Main's flake rate for a case is `mainPassed/mainCompleted`; `flaky` is true when that is strictly between 0 and 1.

The report lists tune cases with the candidate's and main's pass counts and shows holdout only as `passed X of Y, regressions: N`. `gate.json` and `report.json` still name holdout ids, so they stay in the workflow artifact and are not posted. `delegate eval` on a PR passes no `--targets`; the hill-climb dispatch (ticket 07) supplies them, from main's side, never from PR files. In the workflow, `expected-gate` runs the first pass, `expected-rerun` (PR code, read-only eval role) replays only the flagged cases, and `expected-score` merges only `run-4` to `run-6` from the rerun, gates with `--final true`, posts the gate report (never the score report, which names holdout cases) and goes red on failure.

Every case, and every scenario in `scenarios.json`, carries three required labels: `split` (`tune` or `holdout`; holdout cases are never shown to whoever tunes the prompt), `source` (`simulated`, `production-caught`, `production-missed` or `refuted`) and `kind` (`bug`, `false-finding`, `scale` or `architecture`). No filter means every case. `--split` narrows `review:expect`, `cases scenarios` and, with `--manifest`, `replay`.

A case is either a recorded production run (`key`, an object in `REVIEW_BUCKET`) or a simulated PR (`bundle`, a file next to the manifest). A simulated PR's head commit does not exist on GitHub: the replay checks out `baseSha`, applies the bundle's diff and commits it with a fixed author and date, which reproduces the bundle's `headSha` exactly. To add one, make the change on a detached checkout of `baseSha`, commit it with the env in `SYNTHETIC_COMMIT_ENV` (`expect.ts`) and the bundle's title as the message, and record that sha and `git diff <base> HEAD` in the bundle.

## Mining candidate cases

```sh
npm run review:mine -- --repo thegoodparty/omni --kind missed --since 2026-10-05 --out candidates.jsonl
```

Read-only. Walks every page of `REVIEW_BUCKET`, keeps the latest non-`eval` record per head sha, and proposes cases for a human to confirm. Needs S3 read access and `gh` auth. Flags: `--repo`, `--since`, `--kind missed|refuted`, `--fix-words a,b,c` (replaces the default `fix,bug,revert,hotfix,race,timeout`), `--limit`, `--out` (stdout if omitted).

- **missed**: an approved PR that merged, then a non-merge commit within 14 days removed a line the approved diff added. Output: `{ kind, key, repo, pr, fixCommit, overlappingPaths, message, overlapLines, score }`, best first. Lines are matched by text per path, not blamed by number.
- **refuted**: a blocked PR that merged with every flagged line unchanged and a reply from another author on each finding thread. Output: `{ kind, key, repo, pr, findings, replies, mergedSha }`.

Most hits are noise (about 3.5 good missed-bug cases per 100 approvals), and many real misses need a running system to see, so a person labels each one.

## Cost expectations

- **Replay**: each case is a full `claude-opus-5-5` agent run. Budget $1–5 per case; a 20-case corpus costs roughly $20–100 depending on diff complexity.
- **Judge**: each pass is a short `claude-sonnet-5-5` call (one structured verdict). Budget a few cents per case per pass; 20 cases × 4 passes ≈ $0.50–2.

## Statistical interpretation

The report includes a two-sided binomial sign test (p=0.5, ties and unstable verdicts excluded). Rule of thumb:

- 12 cases → 10+ wins one way is p<0.05
- 20 cases → 15+ wins one way is p<0.05
- 50 cases → 31+ wins one way is p<0.05

A p-value below 0.05 gives reasonable confidence the variant difference is real rather than noise. Fewer than 10 non-tie cases is usually not enough to conclude anything.
