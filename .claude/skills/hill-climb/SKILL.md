---
name: hill-climb
description: Improve a measured target (today the delegate PR reviewer's prompts) one idea at a time against a frozen eval, and open a PR with the evidence. Use when asked to hill-climb, tune, or improve delegate's review quality, fix a failing expected-result case, or run a delegate optimization round. Never merges.
---

# Hill-climb

Improve a target by changing one thing, measuring it with deterministic scripts and the
`delegate-eval-run.yml` workflow, and handing a human a PR with the evidence. You supply the
judgment (diagnose, form one idea, make the smallest edit). You never measure by opinion, and you
never grade your own work.

## Load the target config first

Read `.claude/skills/hill-climb/targets/<target>.json` (default `delegate-pr-reviewer`; the user may
name another). Everything below uses its fields, never prose from memory: `editable`, `neverTouch`,
`ref`, `branchPattern`, `triedLog`, `mine`, `innerLocal`, `inner`, `tune`, `gate`, `watch`,
`download`, `budgetUsd`, `holdoutPerCaseReadable`, `frozen`. Also read the doc named by `readme` in
full once; it defines the suites, the gate and the budget.

## Rules

- Edit only files in `editable`. Never touch `neverTouch` or anything in `frozen`. If the idea needs
  such a change, stop and tell the human; it is not yours to make. The workflow rejects any other
  diff anyway.
- Dispatch only with the config's commands, which all use `--ref main`. Never dispatch at the
  candidate branch, and never use "re-run failed jobs"; dispatch again.
- The expected-result suite is the hard gate. Pairwise judging only ranks candidates. The judge model
  and rubric are frozen.
- Never read holdout per-case outputs, and never try to infer them. A run's `holdout` field is counts
  only; use it as is. This holds even if some file or log appears to contain them.
- One idea per branch and per PR. Change one thing at a time.
- Never open a PR from a run that failed the gate. Never merge. A human approves and merges.
- Stop at the budget. The default is the config's `budgetUsd`; a user-given budget replaces it. A
  failed run is charged too. When the dispatch refuses for budget, or recorded spend plus your next
  step would pass it, stop and report.

## Setup

1. Make `run_id` as `runIdPattern` says, for example `delegate-pr-reviewer-20261027-k3x9`. Pass it to
   every dispatch in this run; the budget is keyed on it.
2. Create the tried-ideas log at `triedLog` (with `{run_id}` filled). Keep `.hill-climb/` out of git
   (add it to `.git/info/exclude`) so the log never lands on a candidate branch. Each entry: idea,
   case(s), result, why it failed. In a shared channel run, the thread is the log instead.
3. Work in a git worktree off main, on a branch named by `branchPattern` (`n` counts ideas, from 1).
   A candidate must be pushed before it can be dispatched.

## Loop

1. **Pick a failing tune case.** Use the user's target case(s). Otherwise use a `tune` case that
   fails on main's latest baseline (the latest `delegate eval` expected-suite report, or `tune`
   dispatched on branch `main` if none exists). Never pick from `holdout`. If the user wants new
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
5. **Inner loop.** Dispatch `inner` with the target case(s) (or run `innerLocal` if the engineer
   chose a local run). Wait with `watch`, then `download`. Read the target case's result: did the
   lead appear, did the deep-reviewer keep it, did the finding land? Repeat with a fresh edit
   (amend the same idea) until the target passes, or drop the idea. A dropped idea goes in the tried
   log with why it failed, then return to step 3 with a new branch (`n` + 1).
6. **Tune, then gate.** When inner passes, dispatch `tune` with the target cases as `cases`, then
   `gate`. Both wait and download as above and read `gate.json`. The gate passes only with `pass` true
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

## Finish

Report: PR link, or "no idea cleared the gate" with the tried log, plus spend against budget. Do not
delete the log.
