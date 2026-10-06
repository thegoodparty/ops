# PR-reviewer eval

Replay recorded production reviews against the agent code in any checkout and compare two variants pairwise.

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

Each replay is a full agent run — budget roughly $1–5 per case depending on diff size. Replays run the agent with the same environment production uses, including the switches that stop the Claude Code CLI from fetching its plugin marketplace over ssh at startup; without them a local replay can hang before the first turn.

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

## Cost expectations

- **Replay**: each case is a full `claude-opus-4-6` agent run. Budget $1–5 per case; a 20-case corpus costs roughly $20–100 depending on diff complexity.
- **Judge**: each pass is a short `claude-sonnet-4-6` call (one structured verdict). Budget a few cents per case per pass; 20 cases × 4 passes ≈ $0.50–2.

## Statistical interpretation

The report includes a two-sided binomial sign test (p=0.5, ties and unstable verdicts excluded). Rule of thumb:

- 12 cases → 10+ wins one way is p<0.05
- 20 cases → 15+ wins one way is p<0.05
- 50 cases → 31+ wins one way is p<0.05

A p-value below 0.05 gives reasonable confidence the variant difference is real rather than noise. Fewer than 10 non-tie cases is usually not enough to conclude anything.
