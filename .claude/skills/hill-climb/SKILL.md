---
name: hill-climb
description: Improve a measured target (today the delegate PR reviewer) one idea at a time against a frozen eval, and open a PR with the evidence. Runs locally with review:arms by default, or through the delegate-eval-run.yml workflow in the Delegate swarm. Use when asked to hill-climb, tune, or improve delegate's review quality, fix a failing expected-result case, or run a delegate optimization round. Never merges.
---

# Hill-climb

Improve a target by changing one thing at a time, measuring it with deterministic scripts, and
handing a human a PR with the evidence. You supply the judgment (diagnose, form one idea, make the
smallest change). You never measure by opinion, and you never grade your own work.

There are two ways to measure, with the same loop:

- **Local (the default).** `review:arms` on this machine. Any change to the reviewer, prompt text or
  structure. Use it whenever you have local credentials: `ANTHROPIC_API_KEY` or a Claude Code login,
  `gh` auth, and S3 read access to `REVIEW_BUCKET`.
- **Dispatched.** The `delegate-eval-run.yml` workflow, with a per-run budget. Prompt text only. Use
  it in the Delegate swarm, or when you have no local credentials.

## Load the target config first

Read `.claude/skills/hill-climb/targets/<target>.json` (default `delegate-pr-reviewer`; the user may
name another). Everything below uses its fields, never prose from memory: `editable`, `neverTouch`,
`ref`, `branchPattern`, `triedLog`, `mine`, `arms`, `armsDir`, `armsOut`, `inner`, `tune`, `gate`,
`watch`, `download`, `budgetUsd`, `holdoutPerCaseReadable`, `frozen`. Also read the doc named by
`readme` in full once; it defines the suites, the gate and the budget.

## Rules

- Never touch `neverTouch` or anything in `frozen` in the checkout that scores. If the idea needs
  such a change, stop and tell the human; it is not yours to make.
- The expected-result suite is the hard gate. Pairwise judging only ranks candidates. The judge model
  and rubric are frozen.
- Never read holdout per-case outputs, and never try to infer them. Locally, holdout cases never run.
  A dispatched run's `holdout` field is counts only; use it as is. This holds even if some file or
  log appears to contain them.
- One idea per arm or branch. Change one thing at a time.
- Never open a PR from a candidate that failed the gate. Never merge. A human approves and merges.
- Stop at the budget. The default is the config's `budgetUsd`; a user-given budget replaces it.
  Locally, the table under `armsOut` prints the total spend of every round. A failed run is charged
  too. When spend plus your next step would pass the budget, stop and report.

## Local loop

### Setup

1. Make `run_id` as `runIdPattern` says, for example `delegate-pr-reviewer-20261027-k3x9`.
2. Create the tried-ideas log at `triedLog` (with `{run_id}` filled), and keep `.hill-climb/` out of
   git (add it to `.git/info/exclude`). Each entry: idea, case(s), result, why it failed.
3. The scorer is a clean worktree of `ref`, and it is also the `main` arm. Run every `arms` command
   from it. Its cases and scoring are what every arm is graded on, so never edit them.
4. Each idea is an arm: a worktree at `armsDir` (with `{run_id}` and `n` filled) on a branch named by
   `branchPattern`, made from the current best arm, with `npm ci` run inside it.
5. Use `armsOut` (with `{run_id}` filled) as `--out` for the whole run. Results are kept per commit,
   so the best arm's runs carry over between rounds, and changed code always replays.
6. Keep the load low: the defaults of `review:arms` are sized for a shared laptop.

### Loop

`best` starts as the `main` arm.

1. **Pick a failing tune case.** Use the user's target case(s). Otherwise run `arms` with only
   `main` and pick a case it fails on most runs. A case it passes on some runs and fails on others
   is noise, so a change can't be told apart from it. If the user wants new cases, `mine` proposes
   candidates for a human to label; do not add cases yourself.
2. **Name the failure.** Read best's results for the case (`run-<n>.json` under
   `armsOut/runs/<sha>/<case>/`: `output.findings`, `leads`) and classify it from `leads`:
   - the scout never raised a lead covering the bug (no lead on the right path/category);
   - a lead covered it but the deep-reviewer ended `dropped` (disprove-it pass killed it) or
     `unknown`;
   - a lead was `raised` or `reported` but the finding is wrong or off-path (false finding survived);
   - for a false finding, find which lead's hypothesis produced it.
3. **Write down one idea** and check the tried log so it is not repeated. State the idea, the
   failure class it addresses, and what result would prove it wrong.
4. **Make the smallest change** in the arm that tests the idea, prompt text or structure, and
   commit it. Uncommitted changes under `delegate/` are refused.
5. **Inner loop.** Run `arms` with `best` and the idea, `--base best`, and `--case` set to the
   target case(s). Read the target's results: did the lead appear, did the deep-reviewer keep it,
   did the finding land? Amend the commit and rerun until the target passes, or drop the idea. A
   dropped idea goes in the tried log with why it failed; return to step 3 with a new arm (`n` + 1).
   Several ideas may run side by side as separate arms against the same base.
6. **Gate.** Run `arms` on every tune case, `--base best`, with `--targets` set to the target
   case(s). It passes only when the gate line for the idea reads `pass` (no regressions, no targets
   missed). A cost over the limit does not fail the gate but goes in the PR.
7. **Promote.** A passing idea becomes `best`. Return to step 1 for the next case, with new arms made
   from it.
8. **Open the PR** when you stop, from `best`'s branch, one commit per promoted idea. Do not enable
   auto-merge. Body:
   - **Ideas**: per commit, the idea and the failure class from step 2.
   - **Target cases**: before (main) and after, pass counts per case.
   - **Gate**: the final table against main, from `arms.md`.
   - **Cost**: average cost per run before and after.
   - **Ideas tried**: from the log, each with why it failed.
   Then comment `delegate eval` on the PR. That runs the full suite in CI against main, holdout
   included, and is the only place holdout runs. Report its result, and ask the reviewer to read the
   full outputs of the target cases.

## Dispatched loop

For the Delegate swarm, or when you have no local credentials. These extra rules apply:

- Edit only files in `editable`, and change only prompt text: the contents of string and template
  literals. Never add or change code, imports or `${...}` expressions. The candidate's code runs in
  the same process that writes its results, so code changes can corrupt the measurement, and the
  workflow rejects any other diff. A structural idea goes to a human as a proposal, or to the local
  loop.
- Dispatch only with the config's commands, which all use `--ref main`. Never dispatch at the
  candidate branch, and never use "re-run failed jobs"; dispatch again.
- Download only the artifact the config's `download` names. A run's other artifacts (`baseline-*`,
  `cand-results-*`, `cand-rerun-*`, `main-history-*`) hold holdout case outputs, so never download
  them or a whole run.
- The budget is enforced by the workflow: when a dispatch refuses for budget, stop and report.

### Setup

1. Make `run_id` as `runIdPattern` says, for example `delegate-pr-reviewer-20261027-k3x9`. Pass it to
   every dispatch in this run; the budget is keyed on it.
2. Create the tried-ideas log at `triedLog` (with `{run_id}` filled). Keep `.hill-climb/` out of git
   (add it to `.git/info/exclude`) so the log never lands on a candidate branch. Each entry: idea,
   case(s), result, why it failed. In a shared channel run, the thread is the log instead.
3. Work in a git worktree off main, on a branch named by `branchPattern` (`n` counts ideas, from 1).
   A candidate must be pushed before it can be dispatched.

### Loop

1. **Pick a failing tune case.** Use the user's target case(s). Otherwise pick from the `cases` table
   of a `gate.json`: the newest `tune` or `gate` run made since main last changed an `editable`
   file, or, if there is none, `tune` dispatched now on branch `main`. A case qualifies when
   `mainPassed` is below `mainCompleted` and `flaky` is false; a flaky case swings on main itself,
   so a change can't be told from noise. The expected-suite report has no `flaky` field, so don't
   pick from it. Never pick from `holdout`. If the user wants new
   cases, `mine` proposes candidates for a human to label; do not add cases yourself.
2. **Name the failure.** Read main's result for the case (`run-<n>.json`: `output.findings`,
   `leads`) and classify it from `leads`:
   - the scout never raised a lead covering the bug (no lead on the right path/category);
   - a lead covered it but the deep-reviewer ended `dropped` (disprove-it pass killed it) or
     `unknown`;
   - a lead was `raised` or `reported` but the finding is wrong or off-path (false finding survived);
   - for a false finding, find which lead's hypothesis produced it.
3. **Write down one idea** and check the tried log so it is not repeated. State the idea, the
   failure class it addresses, and what result would prove it wrong.
4. **Make the smallest edit** in an `editable` file that tests the idea. Commit it, push the
   branch. Run `dryRun` once if this is the first push of the run; it spends nothing and confirms
   the branch only differs in `editable` files.
5. **Inner loop.** Dispatch `inner` with the target case(s). `inner` replays each case once, so dispatch it again for more samples, but
   only after the previous dispatch finishes: dispatches for one `run_id` share a concurrency group
   that keeps one waiting run, and a newer dispatch cancels the one already waiting. Wait with
   `watch`, then `download`. Read the target case's result: did the
   lead appear, did the deep-reviewer keep it, did the finding land? Repeat with a fresh edit
   (amend the same idea) until the target passes, or drop the idea. A dropped idea goes in the tried
   log with why it failed, then return to step 3 with a new branch (`n` + 1).
6. **Tune, then gate.** When inner passes, dispatch `tune` with the
   target cases as `cases`, then `gate`. Both wait and download as above and read `gate.json`. The gate passes only with `pass` true
   (no `regressions`, no `targetsMissed`). On failure, stop; log why (which cases regressed, from the tune
   `cases` table; holdout only as the `holdout` counts) and drop the idea, or make one smaller
   edit and re-dispatch. A true `costOver` does not fail the gate but goes in the PR.
7. **Open the PR** only from a run whose gate passed. Do not enable auto-merge. Body:
   - **Idea**: one paragraph, and the failure class from step 2.
   - **Target cases**: before (main) and after (candidate), pass counts per case.
   - **Gate**: a table of tune cases (candidate passes vs main), then the holdout aggregate
     (`passed X of Y, regressions: N`) and the `run_id`.
   - **Cost**: `costRatio` and per-review cost before and after.
   - **Ideas tried**: from the log, each with why it failed.
   - **Review request**: ask the reviewer to read the full outputs of the target cases and two
     holdout cases themselves; those are in the workflow artifacts, which you have not read.

### In the Delegate swarm

When a run starts from a Slack mention, the lead owns the run and these replace the matching steps:

- Acknowledge in the thread with the `run_id`, the target cases and the budget. The thread is the
  tried log; write nothing under `.hill-climb/` on a branch.
- No target given: use every case that qualifies under Loop step 1. No budget given: use `budgetUsd`.
- Hand up to 3 ideas to workers, one idea per worker, each on its own `branchPattern` branch with its
  own `n`, all sharing the run's `run_id`. Workers push as `delegate-gp[bot]`.
- One dispatch per `run_id` at a time across all workers (step 5 says why). The lead hands out
  dispatch turns; a worker posts its result to the thread before the next one dispatches.
- At most one PR per run: the candidate with the best gate result, if any passed. Reply in the
  thread with the link, or with each idea tried and why it failed. Then stop.

## Finish

Report: PR link, or "no idea cleared the gate" with the tried log, plus spend against budget. Do not
delete the log.
