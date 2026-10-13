# PR-reviewer eval

Replay recorded production reviews against the agent code in any checkout and compare two variants pairwise.

## From a PR

Comment `delegate eval` on any ops PR to run the `core` suite, or `delegate eval <suite>` (for example `delegate eval re-review`) to run another suite from `scenarios.json`. The workflow:

1. Loads the suite's scenarios from `scenarios.json`: fixed production review records in S3, so every eval runs the same cases. If your PR changes `scenarios.json`, its copy is used.
2. Replays every scenario twice in parallel, once with main's agent code and once with your PR head's.
3. Judges the two sides pairwise and posts a single comment to the PR with two verdicts: **Quality** (Better / Worse / Can't tell, from the sign test over the judged pairs) and **Cost** (Better / Worse / Same, average cost per review before and after; under 10% change is Same). Per-case results sit in a drop-down; every raw result is on the workflow run as an artifact.
4. Uploads the full eval directory as a workflow artifact (`delegate-eval-<sha7>`).

**Cost and time:** each replay is a full `claude-opus-4-6` agent run at roughly $1.50 per case, and both sides are replayed. The 12-case `core` suite takes about 20 minutes and costs around $36 in replay plus a few dollars for judging.

**Scenarios:** each entry in `scenarios.json` names an `id`, a `suite`, the S3 `key` of the record, and what it `tests`. The report names cases by `id`. `core` is a mix of first reviews and re-reviews across repos, with real bugs production caught or missed and false findings authors refuted. `re-review` covers prior-finding handling.

**Repo settings the workflow needs:**

- Variable `DELEGATE_EVAL_APP_ID`: the app ID of a GitHub App with `contents:read` on the repos being reviewed (used to clone target repos during replay).
- Secret `DELEGATE_EVAL_APP_PRIVATE_KEY`: the private key for that GitHub App.
- Secret `ANTHROPIC_API_KEY`: standard Anthropic API key for agent replay and judging.

The workflow only runs for comments from users with `OWNER`, `MEMBER`, or `COLLABORATOR` association on the repository.

## Concepts

**Case** — one production `ReviewRecord` stored in S3. The record contains the full `bundle` (diff, changed files, prior findings, PR metadata) that was the agent's complete input. Because the bundle is self-contained, a case can be replayed without calling GitHub — except for checking out the repo at `bundle.headSha` so the agent can read files.

**Variant** — the ops git ref the eval was run from. When you run `replay` from a worktree, the variant is `git rev-parse HEAD` of that worktree, or whatever you pass via `--variant`.

**Result** — one replay output: `{ caseId, repo, prNumber, headSha, variant, output, error?, costUsd, wallTimeMs }`. Stored as `<caseId>.json` in the results directory as each replay completes.

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

Compares result pairs using a blind pairwise judge (`claude-sonnet-4-6` by default, not the agent's opus model, to blunt self-preference). Each case is judged `--passes` times with alternating order; a majority of mapped winners determines the per-case verdict. Prints the markdown report to stdout and writes it to `--out` if given.

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

Five cases with a known right answer, listed in `expected/manifest.json`. Each is scored on the outcome alone, with no judge: a block case passes when a finding lands in one of its `paths` (and, if set, one of its `categories`); an approve case passes with zero findings. Every case runs several times, and a case passes only when every run does.

Every `delegate eval` comment also runs this suite against the PR head, 3 runs per case, as a parallel job, and posts the result as its own PR comment. It adds about $15 and no wall time.

```sh
npm run review:expect -- [--runs 3] [--concurrency 5] [--case <id>] [--out ./eval-expected] [--work-dir /tmp/review-expect]
```

Writes each run's result to `<out>/<case>/run-<n>.json` and the report to `<out>/report.md`. Needs `ANTHROPIC_API_KEY`, `gh` auth for the target repos, and read access to `REVIEW_BUCKET`. Five cases at three runs costs about $18.

A case is either a recorded production run (`key`, an object in `REVIEW_BUCKET`) or a simulated PR (`bundle`, a file next to the manifest). A simulated PR's head commit does not exist on GitHub: the replay checks out `baseSha`, applies the bundle's diff and commits it with a fixed author and date, which reproduces the bundle's `headSha` exactly. To add one, make the change on a detached checkout of `baseSha`, commit it with the env in `SYNTHETIC_COMMIT_ENV` (`expect.ts`) and the bundle's title as the message, and record that sha and `git diff <base> HEAD` in the bundle.

## Cost expectations

- **Replay**: each case is a full `claude-opus-4-6` agent run. Budget $1–5 per case; a 20-case corpus costs roughly $20–100 depending on diff complexity.
- **Judge**: each pass is a short `claude-sonnet-4-6` call (one structured verdict). Budget a few cents per case per pass; 20 cases × 4 passes ≈ $0.50–2.

## Statistical interpretation

The report includes a two-sided binomial sign test (p=0.5, ties and unstable verdicts excluded). Rule of thumb:

- 12 cases → 10+ wins one way is p<0.05
- 20 cases → 15+ wins one way is p<0.05
- 50 cases → 31+ wins one way is p<0.05

A p-value below 0.05 gives reasonable confidence the variant difference is real rather than noise. Fewer than 10 non-tie cases is usually not enough to conclude anything.
